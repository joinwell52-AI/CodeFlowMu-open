/**
 * ADMIN reject rework settlement — allow resubmit_review after DEV/QA rework + PM final report.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  getReportCreatedAtMs,
  parseIsoTimeMs,
  reportBlocksCurrentRoundWake,
} from "../_internal/report-reconcile.ts";
import { parseMarkdownFrontmatter, strField } from "./frontmatter.ts";
import { reportStatusDone } from "./reportSubmitEligibility.ts";
import {
  isReworkResubmitUnblocked,
  isTaskReopenedForReworkFromLedger,
  type TaskReworkLedgerFields,
} from "./taskReworkSemantics.ts";

export type LedgerTaskLike = {
  task_id?: string;
  thread_key?: string;
  recipient?: string;
  bucket?: string;
  scope?: string;
  display_status?: string;
  lifecycle_projection?: string;
  review_status?: string;
  parent?: string;
  references?: string | string[];
  created_at?: string;
};

export function getLatestRejectReviewAtMs(
  taskFm: Record<string, unknown>,
): number | null {
  return getLatestReworkGateAtMs(taskFm);
}

/** Latest ADMIN reject or reopen that (re)opens a rework round. */
export function getLatestReworkGateAtMs(
  taskFm: Record<string, unknown>,
): number | null {
  const transitions = Array.isArray(taskFm.transitions) ? taskFm.transitions : [];
  let max: number | null = null;
  for (const t of transitions) {
    if (!t || typeof t !== "object") continue;
    const action = String((t as { action?: unknown }).action ?? "")
      .trim()
      .toLowerCase();
    if (action !== "reject_review" && action !== "reopen_task") continue;
    const ms = parseIsoTimeMs(String((t as { at?: unknown }).at ?? ""));
    if (ms == null) continue;
    if (max == null || ms > max) max = ms;
  }
  return max;
}

function reportResolvesToTaskId(
  reportFm: Record<string, unknown>,
  taskId: string,
): boolean {
  const norm = normalizeTaskId(taskId);
  const fmTask = strField(reportFm, "task_id");
  if (fmTask && normalizeTaskId(fmTask) === norm) return true;
  const refs = reportFm.references;
  if (typeof refs === "string" && normalizeTaskId(refs) === norm) return true;
  if (Array.isArray(refs)) {
    for (const r of refs) {
      if (typeof r === "string" && normalizeTaskId(r) === norm) return true;
    }
  }
  return false;
}

function normalizeTaskId(taskId: string): string {
  return taskId.replace(/\.md$/i, "").trim();
}

function taskReferencesMain(task: LedgerTaskLike, mainTaskId: string): boolean {
  const norm = normalizeTaskId(mainTaskId);
  const parent = String(task.parent ?? "").trim();
  if (parent && (parent === norm || parent.startsWith(`${norm}-`))) return true;
  const refs = task.references;
  if (typeof refs === "string" && refs.includes(norm)) return true;
  if (Array.isArray(refs)) {
    for (const r of refs) {
      if (typeof r === "string" && (r === norm || r.includes(norm))) return true;
    }
  }
  return false;
}

function isTaskDoneBucket(task: LedgerTaskLike): boolean {
  const b = String(task.bucket ?? task.scope ?? "").toLowerCase();
  if (b === "done" || b === "archive") return true;
  const projection = String(task.lifecycle_projection ?? "")
    .trim()
    .toLowerCase();
  if (projection === "review" || projection === "done" || projection === "archive") {
    return true;
  }
  const reviewStatus = String(task.review_status ?? "")
    .trim()
    .toLowerCase();
  if (reviewStatus === "pending" || reviewStatus === "approved" || reviewStatus === "rework_done") {
    return true;
  }
  const displayStatus = String(task.display_status ?? "")
    .trim()
    .toLowerCase();
  return (
    displayStatus === "waiting_pm_review" ||
    displayStatus === "ready_for_review" ||
    displayStatus === "done"
  );
}

async function loadTasksFromLedger(fcopRoot: string): Promise<LedgerTaskLike[]> {
  const path = join(fcopRoot, "ledger", "tasks.jsonl");
  const raw = await fs.readFile(path, "utf8").catch(() => "");
  const tasks: LedgerTaskLike[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const yaml = (row.yaml ?? {}) as Record<string, unknown>;
      tasks.push({
        task_id: String(row.task_id ?? ""),
        thread_key: String(row.thread_key ?? yaml.thread_key ?? ""),
        recipient: String(row.recipient ?? yaml.recipient ?? ""),
        bucket: String(row.bucket ?? ""),
        display_status: String(row.display_status ?? yaml.display_status ?? ""),
        lifecycle_projection: String(
          row.lifecycle_projection ?? yaml.lifecycle_projection ?? "",
        ),
        review_status: String(row.review_status ?? yaml.review_status ?? ""),
        parent: String(row.parent ?? yaml.parent ?? ""),
        references: yaml.references as string | string[] | undefined,
        created_at: String(row.created_at ?? ""),
      });
    } catch {
      /* skip malformed line */
    }
  }
  return tasks;
}

export type ReworkSettlementInput = {
  taskFm: Record<string, unknown>;
  taskId: string;
  reportId: string;
  fcopRoot: string;
  allTasks?: LedgerTaskLike[];
};

export type ReworkSettlementResult =
  | { settled: true; reportId: string; patch: Record<string, unknown> }
  | { settled: false; reason: string };

export async function evaluateReworkSettlement(
  input: ReworkSettlementInput,
): Promise<ReworkSettlementResult> {
  const fields: TaskReworkLedgerFields = {
    display_status: strField(input.taskFm, "display_status"),
    reopen_reason: strField(input.taskFm, "reopen_reason"),
    review_status: strField(input.taskFm, "review_status"),
    reopened_count: Number(input.taskFm.reopened_count ?? 0),
    review_note: strField(input.taskFm, "review_note"),
  };

  if (isReworkResubmitUnblocked(input.taskFm)) {
    return {
      settled: true,
      reportId: normalizeTaskId(input.reportId),
      patch: {},
    };
  }

  if (!isTaskReopenedForReworkFromLedger(fields)) {
    return { settled: false, reason: "not_in_rework" };
  }

  const reportName = input.reportId.endsWith(".md")
    ? input.reportId
    : `${input.reportId}.md`;
  const reportPath = join(input.fcopRoot, "reports", reportName);
  const reportBody = await fs.readFile(reportPath, "utf8").catch(() => "");
  if (!reportBody) {
    return { settled: false, reason: "report_not_found" };
  }

  const reportFm = parseMarkdownFrontmatter(reportBody);
  if (!reportStatusDone(reportFm)) {
    return { settled: false, reason: "report_not_done" };
  }

  const recipient = strField(input.taskFm, "recipient").toUpperCase();
  const workerRoles = new Set(["DEV", "QA", "OPS"]);
  if (workerRoles.has(recipient)) {
    const sender = strField(reportFm, "sender").toUpperCase();
    if (
      sender === recipient &&
      reportResolvesToTaskId(reportFm, input.taskId)
    ) {
      const gateAt = getLatestReworkGateAtMs(input.taskFm);
      const stat = await fs.stat(reportPath).catch(() => null);
      const reportCreatedAt = getReportCreatedAtMs(reportFm, stat?.mtimeMs);
      if (
        gateAt == null ||
        reportCreatedAt == null ||
        reportBlocksCurrentRoundWake(reportCreatedAt, gateAt)
      ) {
        const reportId = normalizeTaskId(input.reportId);
        const now = new Date().toISOString();
        return {
          settled: true,
          reportId,
          patch: {
            display_status: "ready_for_review",
            review_status: "rework_done",
            rework_completed_by_report: reportId,
            rework_completed_at: now,
          },
        };
      }
      return { settled: false, reason: "worker_report_before_reopen" };
    }
    return { settled: false, reason: "worker_report_mismatch" };
  }

  const rejectAt = getLatestReworkGateAtMs(input.taskFm);
  if (rejectAt == null) {
    return { settled: false, reason: "no_reject_transition" };
  }

  if (
    strField(reportFm, "sender").toUpperCase() !== "PM" ||
    strField(reportFm, "recipient").toUpperCase() !== "ADMIN"
  ) {
    return { settled: false, reason: "not_pm_to_admin" };
  }

  const stat = await fs.stat(reportPath).catch(() => null);
  const reportCreatedAt = getReportCreatedAtMs(reportFm, stat?.mtimeMs);
  if (!reportBlocksCurrentRoundWake(reportCreatedAt, rejectAt)) {
    return { settled: false, reason: "report_before_reject" };
  }

  const threadKey = strField(input.taskFm, "thread_key");
  const allTasks = input.allTasks ?? (await loadTasksFromLedger(input.fcopRoot));
  const reworkChildren = allTasks.filter((t) => {
    if (normalizeTaskId(String(t.task_id ?? "")) === normalizeTaskId(input.taskId)) {
      return false;
    }
    if (threadKey && String(t.thread_key ?? "") !== threadKey) return false;
    if (!taskReferencesMain(t, input.taskId)) return false;
    const recip = String(t.recipient ?? "").toUpperCase();
    if (recip !== "DEV" && recip !== "QA") return false;
    const createdMs = parseIsoTimeMs(String(t.created_at ?? ""));
    if (createdMs != null && createdMs < rejectAt) return false;
    return true;
  });

  if (reworkChildren.length === 0) {
    return { settled: false, reason: "no_rework_children" };
  }

  const unsettled = reworkChildren.filter((t) => !isTaskDoneBucket(t));
  if (unsettled.length > 0) {
    return { settled: false, reason: "children_not_done" };
  }

  const reportId = normalizeTaskId(input.reportId);
  const now = new Date().toISOString();
  return {
    settled: true,
    reportId,
    patch: {
      display_status: "ready_for_review",
      review_status: "rework_done",
      rework_completed_by_report: reportId,
      rework_completed_at: now,
    },
  };
}
