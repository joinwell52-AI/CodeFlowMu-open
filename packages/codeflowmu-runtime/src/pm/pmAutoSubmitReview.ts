/**
 * Plan A: auto submit_review for lifecycle active/inbox child tasks after review_check pass.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { isWorkerReportToPm } from "../fcop/governance.ts";
import { resolveDriver } from "../lifecycle/authorityDefaults.ts";
import { LifecycleKernel } from "../lifecycle/LifecycleKernel.ts";
import { TaskFrontmatterStore } from "../lifecycle/TaskFrontmatterStore.ts";
import { findTaskPathById } from "../lifecycle/taskPathUtils.ts";
import { LedgerBuilder } from "../ledger/LedgerBuilder.ts";
import { resolveLedgerLayout } from "../ledger/paths.ts";
import type { LedgerReportRecord, LedgerTaskRecord } from "../ledger/types.ts";

export interface AutoSubmitReviewResult {
  task_id: string;
  report_id: string | null;
  submitted: boolean;
  skipped_reason?: string;
  from_stage?: string;
  to_stage?: string;
}

function normalizeId(id: string): string {
  return id.replace(/\.md$/i, "").trim();
}

function taskIdMatchesPrefix(taskId: string, prefix: string): boolean {
  const norm = normalizeId(taskId).toUpperCase();
  const p = normalizeId(prefix).toUpperCase();
  return norm === p || norm.startsWith(`${p}-`) || p.startsWith(`${norm}-`);
}

function pickLatestWorkerReportForTask(
  reports: LedgerReportRecord[],
  taskPrefix: string,
): LedgerReportRecord | undefined {
  const related = reports.filter(
    (r) =>
      r.task_id &&
      taskIdMatchesPrefix(r.task_id, taskPrefix) &&
      isWorkerReportToPm(r.report_id ?? r.filename, r.sender, r.recipient),
  );
  if (!related.length) return undefined;
  return [...related].sort((a, b) =>
    (b.report_id ?? b.filename).localeCompare(a.report_id ?? a.filename),
  )[0];
}

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

/** Auto submit_review when review_check passed and child is still active/inbox. */
export async function tryAutoSubmitReviewForActiveChild(
  projectRoot: string,
  input: {
    task_id: string;
    report_id?: string | null;
    review_ok?: boolean;
  },
): Promise<AutoSubmitReviewResult | null> {
  const taskId = normalizeId(String(input.task_id ?? "").trim());
  if (!taskId) return null;
  if (input.review_ok === false) {
    return {
      task_id: taskId,
      report_id: input.report_id ?? null,
      submitted: false,
      skipped_reason: "review_check not ok",
    };
  }

  const tasks = await readTasksJsonl(projectRoot);
  const task = tasks.find((t) => taskIdMatchesPrefix(t.task_id, taskId));
  if (!task) {
    return {
      task_id: taskId,
      report_id: input.report_id ?? null,
      submitted: false,
      skipped_reason: "task not in ledger",
    };
  }

  const bucket = String(task.bucket ?? "").toLowerCase();
  if (bucket === "review" || bucket === "done" || bucket === "archive") {
    return {
      task_id: taskId,
      report_id: input.report_id ?? null,
      submitted: false,
      skipped_reason: `already in ${bucket}`,
    };
  }
  if (bucket !== "active" && bucket !== "inbox") {
    return {
      task_id: taskId,
      report_id: input.report_id ?? null,
      submitted: false,
      skipped_reason: `bucket=${bucket} not active/inbox`,
    };
  }

  const reports = await readReportsJsonl(projectRoot);
  const reportIdRaw = String(input.report_id ?? "").trim();
  const report =
    (reportIdRaw
      ? reports.find(
          (r) =>
            normalizeId(r.report_id ?? r.filename) === normalizeId(reportIdRaw),
        )
      : undefined) ?? pickLatestWorkerReportForTask(reports, taskId);

  if (!report) {
    return {
      task_id: taskId,
      report_id: null,
      submitted: false,
      skipped_reason: "no worker REPORT for task",
    };
  }

  const reportId = normalizeId(report.report_id ?? report.filename);
  const reportStatus = String(report.status ?? "").trim().toLowerCase();
  if (reportStatus && reportStatus !== "done" && reportStatus !== "completed") {
    return {
      task_id: taskId,
      report_id: reportId,
      submitted: false,
      skipped_reason: `report status=${reportStatus}`,
    };
  }

  const layout = resolveLedgerLayout(projectRoot);
  let located = await findTaskPathById(layout.lifecycleRoot, taskId);
  if (!located) {
    return {
      task_id: taskId,
      report_id: reportId,
      submitted: false,
      skipped_reason: "task not on lifecycle path",
    };
  }

  const kernel = new LifecycleKernel({ lifecycleRoot: layout.lifecycleRoot });
  const store = new TaskFrontmatterStore();

  if (located.stage === "inbox") {
    await kernel.runtimeDispatchInboxToActive(located.path);
    const again = await findTaskPathById(layout.lifecycleRoot, taskId);
    if (!again) {
      return {
        task_id: taskId,
        report_id: reportId,
        submitted: false,
        skipped_reason: "inbox dispatch failed",
      };
    }
    located = again;
  }

  if (located.stage === "review" || located.stage === "done" || located.stage === "archive") {
    return {
      task_id: taskId,
      report_id: reportId,
      submitted: false,
      skipped_reason: `already in ${located.stage}`,
    };
  }

  if (located.stage !== "active") {
    return {
      task_id: taskId,
      report_id: reportId,
      submitted: false,
      skipped_reason: `expected active, got ${located.stage}`,
    };
  }

  const { fm } = await store.read(located.path);
  const reportSender = String(report.sender ?? "").trim().toUpperCase();
  const actor = reportSender || resolveDriver(fm);
  if (!actor) {
    return {
      task_id: taskId,
      report_id: reportId,
      submitted: false,
      skipped_reason: "cannot resolve submit_review actor",
    };
  }

  if (
    !isWorkerReportToPm(report.filename, report.sender, report.recipient)
  ) {
    return {
      task_id: taskId,
      report_id: reportId,
      submitted: false,
      skipped_reason: "not worker-to-PM report",
    };
  }

  try {
    const result = await kernel.submitReview({
      taskId,
      actor,
      reportId,
    });
    await new LedgerBuilder({ projectRoot }).rebuild();
    return {
      task_id: result.task_id,
      report_id: reportId,
      submitted: true,
      from_stage: "active",
      to_stage: "review",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/expected state active, got review/i.test(msg)) {
      return {
        task_id: taskId,
        report_id: reportId,
        submitted: false,
        skipped_reason: "already in review",
      };
    }
    throw err;
  }
}
