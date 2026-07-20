import { promises as fs } from "node:fs";
import { join } from "node:path";

import { isWorkerReportToPm } from "../fcop/governance.ts";
import { LedgerBuilder } from "../ledger/LedgerBuilder.ts";
import { strField } from "../ledger/frontmatter.ts";
import {
  resolveSettlementRootId,
  resolveThreadBucketKey,
} from "../ledger/reportParenting.ts";
import { isTaskWorkflowSealedForPmReview } from "../ledger/taskWorkflowSeal.ts";
import { taskSequenceKey } from "../ledger/taskIdMatch.ts";
import { resolveTaskCurrentBucket } from "./taskCurrentBucket.ts";
import type { LedgerTaskRecord } from "../ledger/types.ts";

export const LATE_REPORT_INTAKE_REASON = "closed_thread_supplemental_report";
export const LATE_REPORT_INTAKE_ACTION = "noted_only";

export type LateReportThreadStatus = "archived" | "closed";

export type LateReportIntakeRecord = {
  kind: "late_report_intake";
  at: string;
  report_id: string;
  related_task_id: string;
  settlement_root_id?: string;
  thread_key?: string;
  thread_status: LateReportThreadStatus;
  action: typeof LATE_REPORT_INTAKE_ACTION;
  reason: typeof LATE_REPORT_INTAKE_REASON;
  risk_assessment?: "none" | "issue_required" | "unverified";
};

export type LateReportIntakeEvaluation = Omit<
  LateReportIntakeRecord,
  "kind" | "at" | "report_id"
>;

function normalizeTaskId(taskId: string): string {
  return taskId.replace(/\.md$/i, "").trim();
}

function findLedgerTask(
  tasks: LedgerTaskRecord[],
  taskId: string,
): LedgerTaskRecord | undefined {
  const key = taskSequenceKey(normalizeTaskId(taskId));
  return tasks.find((t) => taskSequenceKey(t.task_id) === key);
}

function threadStatusForSealedTask(
  task: LedgerTaskRecord,
): LateReportThreadStatus {
  const bucket = resolveTaskCurrentBucket(task);
  if (bucket === "archive") return "archived";
  if (String(task.display_status ?? "").toLowerCase() === "archived") {
    return "archived";
  }
  return "closed";
}

/** Returns intake metadata when linked task or settlement root is sealed for PM review. */
export function evaluateLateReportIntake(
  tasks: LedgerTaskRecord[],
  taskId: string,
  reportFm?: Record<string, unknown>,
): LateReportIntakeEvaluation | null {
  const linked = findLedgerTask(tasks, taskId);
  const rootId = linked
    ? resolveSettlementRootId(linked, tasks)
    : normalizeTaskId(taskId);
  const root = rootId ? findLedgerTask(tasks, rootId) : undefined;

  const linkedSealed = linked ? isTaskWorkflowSealedForPmReview(linked) : false;
  const rootSealed = root ? isTaskWorkflowSealedForPmReview(root) : false;
  if (!linkedSealed && !rootSealed) return null;

  const anchor = rootSealed && root ? root : linked!;
  const threadKey =
    strField(reportFm ?? {}, "thread_key").trim() ||
    linked?.thread_key ||
    root?.thread_key ||
    resolveThreadBucketKey(anchor, tasks);

  return {
    related_task_id: normalizeTaskId(taskId),
    settlement_root_id: rootId ? normalizeTaskId(rootId) : undefined,
    thread_key: threadKey || undefined,
    thread_status: threadStatusForSealedTask(anchor),
    action: LATE_REPORT_INTAKE_ACTION,
    reason: LATE_REPORT_INTAKE_REASON,
    risk_assessment: "none",
  };
}

export function lateReportIntakePath(projectRoot: string): string {
  return join(
    projectRoot,
    ".codeflowmu",
    "pm-governance",
    "late-report-intake.jsonl",
  );
}

export async function hasLateReportIntake(
  projectRoot: string,
  reportId: string,
): Promise<boolean> {
  const path = lateReportIntakePath(projectRoot);
  let raw = "";
  try {
    raw = await fs.readFile(path, "utf-8");
  } catch {
    return false;
  }
  const id = normalizeTaskId(reportId);
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { report_id?: string };
      if (normalizeTaskId(String(row.report_id ?? "")) === id) return true;
    } catch {
      /* skip corrupt line */
    }
  }
  return false;
}

export async function appendLateReportIntake(
  projectRoot: string,
  record: LateReportIntakeRecord,
): Promise<{ appended: boolean; path: string }> {
  const path = lateReportIntakePath(projectRoot);
  if (await hasLateReportIntake(projectRoot, record.report_id)) {
    return { appended: false, path };
  }
  await fs.mkdir(join(projectRoot, ".codeflowmu", "pm-governance"), {
    recursive: true,
  });
  await fs.appendFile(path, `${JSON.stringify(record)}\n`, "utf-8");
  return { appended: true, path };
}

export type TryLateReportIntakeOpts = {
  projectRoot: string;
  reportId: string;
  reportFilePath: string;
  filename: string;
  taskId: string;
  reportFm: Record<string, unknown>;
  sender: string;
  recipient: string;
  logger?: { info?(msg: string): void };
  now?: () => Date;
};

/** Worker→PM report on a sealed thread: append intake JSONL and skip PM settlement. */
export async function tryApplyLateReportIntake(
  opts: TryLateReportIntakeOpts,
): Promise<LateReportIntakeRecord | null> {
  if (
    !isWorkerReportToPm(opts.filename, opts.sender, opts.recipient)
  ) {
    return null;
  }

  const ledger = new LedgerBuilder({ projectRoot: opts.projectRoot });
  await ledger.rebuild();
  const tasks = await ledger.listTasks(undefined, { pendingOnly: false });

  const evaluation = evaluateLateReportIntake(
    tasks,
    opts.taskId,
    opts.reportFm,
  );
  if (!evaluation) return null;

  const record: LateReportIntakeRecord = {
    kind: "late_report_intake",
    at: (opts.now ?? (() => new Date()))().toISOString(),
    report_id: normalizeTaskId(opts.reportId),
    ...evaluation,
  };

  const { appended, path } = await appendLateReportIntake(
    opts.projectRoot,
    record,
  );
  opts.logger?.info?.(
    `[LateReportIntake] ${record.report_id} → ${record.action} ` +
      `(thread=${record.thread_status}, related=${record.related_task_id}` +
      `${appended ? "" : ", duplicate skipped"}) path=${path}`,
  );
  return record;
}
