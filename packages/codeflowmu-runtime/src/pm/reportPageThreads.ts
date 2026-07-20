/**
 * Reports page thread grouping — physical bucket SoT (active vs archive).
 */

import {
  resolveTaskCurrentBucket,
  type TaskBucketInput,
} from "./taskCurrentBucket.ts";
import { taskIdFromFilename } from "./teamDynamics.ts";

export type ReportPageTask = TaskBucketInput & {
  filename?: string;
  task_id?: string;
  archive_mode?: string;
  task_type?: string;
};

export interface ReportThreadGroupInput {
  rootId: string;
  ledgerTaskIds: string[];
  visibleReports: unknown[];
  tasks: ReportPageTask[];
  rootTask?: ReportPageTask | null;
}

const OPEN_BUCKETS = new Set(["inbox", "active", "review"]);

export function isForceArchiveTask(task: ReportPageTask | null | undefined): boolean {
  if (!task) return false;
  const mode = String(task.archive_mode ?? "").toLowerCase();
  if (mode === "force") return true;
  return String(task.task_type ?? "").toLowerCase() === "force_archive";
}

export function isReportThreadRootSealed(
  rootTask: ReportPageTask | null | undefined,
  rootId: string,
  tasks: ReportPageTask[],
): boolean {
  const root =
    rootTask ??
    tasks.find((t) => taskIdFromFilename(String(t.filename ?? "")) === rootId) ??
    null;
  if (!root) return false;
  const bucket = resolveTaskCurrentBucket(root);
  return bucket === "archive" || isForceArchiveTask(root);
}

export function resolveReportThreadTasks(
  ledgerTaskIds: string[],
  tasks: ReportPageTask[],
  rootId: string,
): ReportPageTask[] {
  const byId = new Map<string, ReportPageTask>();
  for (const t of tasks) {
    const id = taskIdFromFilename(String(t.filename ?? ""));
    if (id) byId.set(id, t);
  }
  const out: ReportPageTask[] = [];
  const seen = new Set<string>();
  for (const tid of ledgerTaskIds) {
    const id = taskIdFromFilename(String(tid)) || String(tid).trim();
    const t = byId.get(id);
    if (t && !seen.has(id)) {
      seen.add(id);
      out.push(t);
    }
  }
  if (rootId && byId.has(rootId) && !seen.has(rootId)) {
    out.unshift(byId.get(rootId)!);
  }
  return out;
}

export function hasOpenReportThreadTask(members: ReportPageTask[]): boolean {
  return members.some((m) => {
    if (!String(m.filename ?? "").startsWith("TASK-")) return false;
    if (isForceArchiveTask(m)) return false;
    const bucket = resolveTaskCurrentBucket(m);
    if (bucket === "archive") return false;
    return OPEN_BUCKETS.has(bucket);
  });
}

/** Active tab: hide archive/force roots and empty shells. */
export function shouldShowReportThreadInActive(
  input: ReportThreadGroupInput,
): boolean {
  const { visibleReports, tasks, rootId, ledgerTaskIds, rootTask } = input;
  if (isReportThreadRootSealed(rootTask, rootId, tasks)) return false;

  const members = resolveReportThreadTasks(ledgerTaskIds, tasks, rootId).filter(
    (m) => {
      if (isForceArchiveTask(m)) return false;
      return resolveTaskCurrentBucket(m) !== "archive";
    },
  );

  const reportCount = visibleReports.length;
  const hasOpen = hasOpenReportThreadTask(members);

  if (reportCount <= 0 && !hasOpen) return false;
  return true;
}

/** Archive tab: sealed root or all members archive/done. */
export function shouldShowReportThreadInArchive(
  input: ReportThreadGroupInput,
): boolean {
  const { tasks, rootId, ledgerTaskIds, rootTask, visibleReports } = input;
  if (isReportThreadRootSealed(rootTask, rootId, tasks)) return true;
  const members = resolveReportThreadTasks(ledgerTaskIds, tasks, rootId);
  if (!members.length && visibleReports.length > 0) return true;
  if (!members.length) return false;
  return members.every((m) => {
    const b = resolveTaskCurrentBucket(m);
    return b === "archive" || b === "done" || isForceArchiveTask(m);
  });
}

export function countReportThreadTasksForDisplay(
  members: ReportPageTask[],
  tab: "active" | "archive" | "all",
): number {
  const list = members.filter((m) => String(m.filename ?? "").startsWith("TASK-"));
  if (tab === "active") {
    return list.filter((m) => {
      if (isForceArchiveTask(m)) return false;
      const b = resolveTaskCurrentBucket(m);
      return b !== "archive" && OPEN_BUCKETS.has(b);
    }).length;
  }
  return list.filter((m) => !isForceArchiveTask(m)).length;
}
