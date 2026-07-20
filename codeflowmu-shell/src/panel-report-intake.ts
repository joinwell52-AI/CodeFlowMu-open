/**
 * Late / orphan report intake classification for Panel report board (display only).
 * Mirrors runtime lateReportIntake rules where possible; keep index.html in sync.
 */

import type { LedgerTaskRecord } from "@codeflowmu/runtime";

import {
  bareThreadKey,
  isPmBranchTask,
  taskIdFromFilename,
  type TaskLike,
  type ThreadRow,
} from "./panel-task-thread-visibility.ts";
import {
  ledgerThreadForReport,
  reportFileKey,
  reportIdFromFilename,
  reportLinkedTaskIdPrefixes,
  type ReportLike,
} from "./panel-report-aggregation.ts";

export type ReportIntakeKind = "active" | "late_report_intake" | "true_orphan";

export type ReportIntakeMeta = {
  kind: ReportIntakeKind;
  action?: "noted_only";
  related_task_id?: string;
  thread_key?: string;
  thread_status?: "archived" | "closed" | "history";
};

const LIFECYCLE_ARCHIVE_RE = /[/\\]_lifecycle[/\\]archive(?:[/\\]|$)/i;
const HISTORY_PATH_RE = /(?:^|\/)fcop\/history\//i;

export function isWorkerToPmReportFile(filename: string): boolean {
  return /REPORT-\d{8}-\d{3,}-(DEV|OPS|QA)-to-PM/i.test(filename || "");
}

export function isPmToAdminReportFile(filename: string): boolean {
  return /REPORT-\d{8}-\d{3,}-PM-to-ADMIN/i.test(filename || "");
}

export function isOrphanLedgerReportRow(row: ThreadRow | null | undefined): boolean {
  return Boolean(row?.thread_key?.startsWith("_orphan_REPORT"));
}

export function isTaskSealedForIntake(task: TaskLike | LedgerTaskRecord): boolean {
  const bucket = String((task as LedgerTaskRecord).bucket ?? "").toLowerCase();
  if (bucket === "archive") return true;
  const path = String(task.path ?? "").replace(/\\/g, "/");
  if (LIFECYCLE_ARCHIVE_RE.test(path) || HISTORY_PATH_RE.test(path.toLowerCase())) {
    return true;
  }
  const display = String((task as LedgerTaskRecord).display_status ?? "").toLowerCase();
  if (display === "archived") return true;
  const scope = String(task.physical_scope ?? "").toLowerCase();
  if (scope === "archive") return true;
  return false;
}

function findLedgerTask(
  tasks: LedgerTaskRecord[],
  taskId: string,
): LedgerTaskRecord | undefined {
  const key = taskIdFromFilename(taskId) || taskId;
  return tasks.find(
    (t) => taskIdFromFilename(t.filename ?? t.task_id ?? "") === key,
  );
}

function orphanRowForReport(
  report: ReportLike,
  ledgerRows: ThreadRow[],
): ThreadRow | null {
  const rf = reportFileKey(report.filename ?? "");
  const rid = reportIdFromFilename(report.filename ?? "");
  for (const row of ledgerRows) {
    if (!row?.thread_key?.startsWith("_orphan_REPORT")) continue;
    const keys = (row.report_ids ?? []).map((x) => {
      const k = reportFileKey(String(x));
      return k || String(x);
    });
    if (rf && keys.some((k) => k === rf || (rid && reportIdFromFilename(k) === rid))) {
      return row;
    }
  }
  return null;
}

function inferSealedThreadForLateOrphanWorker(
  report: ReportLike,
  tasks: LedgerTaskRecord[],
  ledgerRows: ThreadRow[],
): ThreadRow | null {
  const fn = String(report.filename ?? "");
  if (!isWorkerToPmReportFile(fn)) return null;
  if (!orphanRowForReport(report, ledgerRows)) return null;

  const linked = reportLinkedTaskIdPrefixes(report);
  if (!linked.length) return null;

  const activeIds = new Set(
    tasks
      .filter((t) => !isTaskSealedForIntake(t))
      .map((t) => taskIdFromFilename(t.filename ?? t.task_id ?? ""))
      .filter(Boolean),
  );

  for (const row of ledgerRows) {
    if (!row.thread_key || row.thread_key.startsWith("_orphan_")) continue;
    const rootId = taskIdFromFilename(row.root_task_id ?? "");
    if (!rootId) continue;
    const root = findLedgerTask(tasks, rootId);
    if (!root || !isTaskSealedForIntake(root)) continue;

    const threadKey = bareThreadKey(row.thread_key);
    const linkedOnThread = linked.some((tid) =>
      (row.task_ids ?? [])
        .map((x) => taskIdFromFilename(String(x)))
        .includes(tid),
    );
    if (linkedOnThread) return row;

    const allLinkedInactive = linked.every((tid) => !activeIds.has(tid));
    if (!allLinkedInactive) continue;

    const archivedBranchOnThread = tasks.some(
      (t) =>
        bareThreadKey(String(t.thread_key ?? "")) === threadKey &&
        isTaskSealedForIntake(t) &&
        isPmBranchTask(t.filename ?? ""),
    );
    if (archivedBranchOnThread) return row;
  }
  return null;
}

/** Classify report for active board vs late/orphan intake (display only). */
export function classifyReportIntake(
  report: ReportLike,
  tasks: TaskLike[],
  ledgerRows: ThreadRow[],
): ReportIntakeMeta {
  const ledgerTasks = tasks as LedgerTaskRecord[];
  const linked = reportLinkedTaskIdPrefixes(report);
  const ledgerRow = ledgerThreadForReport(report, ledgerRows);

  for (const tid of linked) {
    const task = findLedgerTask(ledgerTasks, tid);
    if (task && isTaskSealedForIntake(task)) {
      if (!isWorkerToPmReportFile(report.filename ?? "")) {
        continue;
      }
      return {
        kind: "late_report_intake",
        action: "noted_only",
        related_task_id: tid,
        thread_key: task.thread_key,
        thread_status: String(task.bucket ?? "").toLowerCase() === "archive"
          ? "archived"
          : "closed",
      };
    }
  }

  const sealedThread = inferSealedThreadForLateOrphanWorker(
    report,
    ledgerTasks,
    ledgerRows,
  );
  if (sealedThread) {
    return {
      kind: "late_report_intake",
      action: "noted_only",
      related_task_id: linked[0],
      thread_key: sealedThread.thread_key,
      thread_status: "archived",
    };
  }

  if (isOrphanLedgerReportRow(ledgerRow) && isWorkerToPmReportFile(report.filename ?? "")) {
    if (!linked.length) {
      return { kind: "true_orphan" };
    }
    return { kind: "true_orphan" };
  }

  if (isOrphanLedgerReportRow(ledgerRow) && !linked.length) {
    return { kind: "true_orphan" };
  }

  return { kind: "active" };
}

export function isLateWorkerIntakeReport(
  report: ReportLike,
  tasks: TaskLike[],
  ledgerRows: ThreadRow[],
): boolean {
  return classifyReportIntake(report, tasks, ledgerRows).kind === "late_report_intake";
}

export function isTrueOrphanIntakeReport(
  report: ReportLike,
  tasks: TaskLike[],
  ledgerRows: ThreadRow[],
): boolean {
  return classifyReportIntake(report, tasks, ledgerRows).kind === "true_orphan";
}

/** @deprecated use isLateWorkerIntakeReport */
export function isLateOrphanIntakeReport(
  report: ReportLike,
  tasks: TaskLike[],
  ledgerRows: ThreadRow[],
): boolean {
  return isLateWorkerIntakeReport(report, tasks, ledgerRows);
}

export function partitionReportsByIntake<T extends ReportLike>(
  reports: T[],
  tasks: TaskLike[],
  ledgerRows: ThreadRow[],
): {
  active: T[];
  late_orphan_intake: T[];
  true_orphan: T[];
  late_orphan_intake_count: number;
} {
  const active: T[] = [];
  const late_orphan_intake: T[] = [];
  const true_orphan: T[] = [];

  for (const rep of reports) {
    const kind = classifyReportIntake(rep, tasks, ledgerRows).kind;
    if (kind === "late_report_intake") late_orphan_intake.push(rep);
    else if (kind === "true_orphan") true_orphan.push(rep);
    else active.push(rep);
  }

  return {
    active,
    late_orphan_intake,
    true_orphan,
    late_orphan_intake_count: late_orphan_intake.length,
  };
}
