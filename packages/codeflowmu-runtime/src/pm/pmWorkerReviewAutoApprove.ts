/**
 * Auto approve_review for PM→DEV/QA/OPS sub-tasks in lifecycle review
 * when worker REPORT is done and pm.review_check passes.
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";

import { isWorkerReportToPm } from "../fcop/governance.ts";
import { reportReferencesTask } from "../ledger/lifecycleProjection.ts";
import { resolveLedgerLayout } from "../ledger/paths.ts";
import type { LedgerReportRecord, LedgerTaskRecord } from "../ledger/types.ts";
import { inferTaskLine, taskRouteRoles } from "../lifecycle/authorityDefaults.ts";
import {
  settleVirtualPmLifecycleReviewTask,
  type VirtualPmBranchSettleResult,
} from "../ledger/virtualPmBranchSettle.ts";
import { reviewCheck } from "./PmGovernanceActions.ts";
import { resolveTaskCurrentBucket } from "./taskCurrentBucket.ts";

const WORKER_ROLES = new Set(["DEV", "QA", "OPS"]);
const TERMINAL_REPORT_STATUSES = new Set([
  "failed",
  "blocked",
  "cancelled",
  "force_archived",
]);
const SKIP_DISPLAY_STATUSES = new Set([
  "waiting_admin_decision",
  "force_archived",
  "cancelled",
  "skipped",
  "admin_override",
]);

async function readTasksJsonl(projectRoot: string): Promise<LedgerTaskRecord[]> {
  const layout = resolveLedgerLayout(projectRoot);
  let raw = "";
  try {
    raw = await readFile(join(layout.ledgerDir, "tasks.jsonl"), "utf-8");
  } catch {
    return [];
  }
  const out: LedgerTaskRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LedgerTaskRecord);
    } catch {
      /* skip */
    }
  }
  return out;
}

async function readReportsJsonl(
  projectRoot: string,
): Promise<LedgerReportRecord[]> {
  const layout = resolveLedgerLayout(projectRoot);
  let raw = "";
  try {
    raw = await readFile(join(layout.ledgerDir, "reports.jsonl"), "utf-8");
  } catch {
    return [];
  }
  const out: LedgerReportRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LedgerReportRecord);
    } catch {
      /* skip */
    }
  }
  return out;
}

export function isPmWorkerReviewAutoApproveCandidate(
  task: LedgerTaskRecord,
): boolean {
  if (resolveTaskCurrentBucket(task) !== "review") return false;
  const { from, to } = taskRouteRoles(task as never);
  if (from !== "PM" || !WORKER_ROLES.has(to.split("-")[0] ?? to)) return false;
  if (inferTaskLine(task as never) !== "branch") return false;
  const rs = String(task.review_status ?? "").trim().toLowerCase();
  if (rs === "approved") return false;
  const display = String(task.display_status ?? "").toLowerCase();
  if (SKIP_DISPLAY_STATUSES.has(display)) return false;
  return true;
}

function pickDoneWorkerReport(
  reports: LedgerReportRecord[],
  taskId: string,
  role: string,
): LedgerReportRecord | undefined {
  const candidates = reports.filter(
    (r) =>
      isWorkerReportToPm(r.filename, r.sender, r.recipient) &&
      normalizeRole(r.sender) === normalizeRole(role) &&
      reportReferencesTask(r, taskId),
  );
  return candidates.find((r) => {
    const st = String(r.status ?? "").trim().toLowerCase();
    return st === "done" || st === "completed";
  });
}

function normalizeRole(role: string): string {
  return String(role ?? "")
    .trim()
    .toUpperCase()
    .split(".")[0]!;
}

function skipResult(
  taskId: string,
  reason: string,
): VirtualPmBranchSettleResult {
  return {
    task_id: taskId,
    review_check_ok: false,
    reviewed: false,
    archived: false,
    skipped_reason: reason,
  };
}

/** Try auto approve_review for one PM→worker task in review. */
export async function tryAutoApprovePmWorkerReviewTask(
  projectRoot: string,
  taskId: string,
  opts?: { report_id?: string; reports?: LedgerReportRecord[] },
): Promise<VirtualPmBranchSettleResult | null> {
  const norm = taskId.replace(/\.md$/i, "").trim();
  if (!norm) return null;
  const canonicalNorm = /^TASK-\d{8}-\d{3,}/i.exec(norm)?.[0].toUpperCase() ?? norm;

  const tasks = await readTasksJsonl(projectRoot);
  const task = tasks.find(
    (t) =>
      t.task_id.replace(/\.md$/i, "") === norm ||
      t.task_id.startsWith(`${norm}-`) ||
      t.task_id.toUpperCase() === canonicalNorm,
  );
  if (!task || !isPmWorkerReviewAutoApproveCandidate(task)) {
    return skipResult(norm, "not_pm_worker_review_candidate");
  }

  const role = normalizeRole(task.recipient);
  const reports = opts?.reports ?? (await readReportsJsonl(projectRoot));
  const report =
    (opts?.report_id
      ? reports.find(
          (r) =>
            (r.report_id ?? r.filename).replace(/\.md$/i, "") ===
            opts.report_id!.replace(/\.md$/i, ""),
        )
      : undefined) ?? pickDoneWorkerReport(reports, task.task_id, role);

  if (!report) {
    return skipResult(norm, "missing_done_worker_report");
  }

  const reportStatus = String(report.status ?? "").trim().toLowerCase();
  if (TERMINAL_REPORT_STATUSES.has(reportStatus)) {
    return skipResult(norm, `worker_report_terminal:${reportStatus}`);
  }
  if (reportStatus !== "done" && reportStatus !== "completed") {
    return skipResult(norm, `worker_report_not_done:${reportStatus || "unknown"}`);
  }

  const check = await reviewCheck(projectRoot, {
    task_id: task.task_id,
    report_id: report.report_id ?? report.filename,
  });
  if (!check?.ok) {
    return skipResult(norm, "review_check_failed");
  }

  return settleVirtualPmLifecycleReviewTask(projectRoot, task.task_id, {
    report_id: report.report_id ?? report.filename,
    skipReviewCheck: true,
  });
}

/** Scan review-bucket PM→worker tasks and auto approve when eligible. */
export async function reconcilePmWorkerReviewsPendingApprove(
  projectRoot: string,
  opts?: { thread_key?: string; limit?: number },
): Promise<VirtualPmBranchSettleResult[]> {
  const tasks = await readTasksJsonl(projectRoot);
  const reports = await readReportsJsonl(projectRoot);
  let candidates = tasks.filter(isPmWorkerReviewAutoApproveCandidate);
  if (opts?.thread_key) {
    candidates = candidates.filter((t) => t.thread_key === opts.thread_key);
  }
  const limit = opts?.limit ?? 24;
  const results: VirtualPmBranchSettleResult[] = [];
  for (const task of candidates.slice(0, limit)) {
    const r = await tryAutoApprovePmWorkerReviewTask(
      projectRoot,
      task.task_id,
      { reports },
    );
    if (r) results.push(r);
  }
  return results;
}
