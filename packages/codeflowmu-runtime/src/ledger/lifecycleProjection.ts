/**
 * Ledger / lifecycle projection helpers — settlement without requiring
 * physical `_lifecycle/` moves (hot_path `fcop/tasks/` tasks).
 */

import type {
  LedgerReportRecord,
  LedgerTaskRecord,
  LedgerThreadRecord,
} from "./types.ts";

function normalizeId(id: string): string {
  return id.replace(/\.md$/i, "").trim();
}

function taskIdMatchesPrefix(taskId: string, prefix: string): boolean {
  const norm = normalizeId(taskId).toUpperCase();
  const p = normalizeId(prefix).toUpperCase();
  return norm === p || norm.startsWith(`${p}-`) || p.startsWith(`${norm}-`);
}

/** Canonical TASK-YYYYMMDD-NNN prefix (ledger task_id is often short). */
function taskIdPrefix(id: string): string {
  const m = /^TASK-\d{8}-\d{3,}/i.exec(normalizeId(id));
  return m ? m[0].toUpperCase() : normalizeId(id).toUpperCase();
}

/** Child `parent` may be short id or full routing id; root uses canonical task_id. */
export function taskParentMatchesRoot(
  parent: string | undefined,
  rootId: string,
): boolean {
  const p = (parent ?? "").trim();
  if (!p) return false;
  if (taskIdMatchesPrefix(rootId, p) || taskIdMatchesPrefix(p, rootId)) {
    return true;
  }
  return taskIdPrefix(p) === taskIdPrefix(rootId);
}

/** Report frontmatter task_id / references match a ledger task row. */
export function reportReferencesTask(
  report: LedgerReportRecord,
  taskId: string,
): boolean {
  const tid = report.task_id.replace(/\.md$/i, "").trim();
  if (tid) {
    const baseName = taskId.replace(/\.md$/i, "");
    if (tid === baseName || taskIdMatchesPrefix(taskId, tid)) return true;
  }
  for (const ref of report.references ?? []) {
    if (taskIdMatchesPrefix(taskId, ref)) return true;
  }
  return false;
}

function childHasReportToPmWithStatus(
  child: LedgerTaskRecord,
  reports: LedgerReportRecord[],
  statuses: ReadonlySet<string>,
): boolean {
  return reports.some(
    (r) =>
      statuses.has(String(r.status ?? "").trim().toLowerCase()) &&
      r.recipient.toUpperCase() === "PM" &&
      reportReferencesTask(r, child.task_id),
  );
}

function childHasDoneReportToPm(
  child: LedgerTaskRecord,
  reports: LedgerReportRecord[],
): boolean {
  return childHasReportToPmWithStatus(child, reports, new Set(["done", "completed"]));
}

function childHasTerminalFailureReportToPm(
  child: LedgerTaskRecord,
  reports: LedgerReportRecord[],
): boolean {
  return childHasReportToPmWithStatus(
    child,
    reports.filter((report) => report.dependency_pending !== true),
    new Set(["blocked", "aborted", "failed"]),
  );
}

/**
 * Child is settled for root-thread consolidation when it is in lifecycle
 * review/done/archive, or hot_path with PM-approved review (not pending).
 */
export function isChildSettledForRoot(
  child: LedgerTaskRecord,
  thread: LedgerThreadRecord,
  reports: LedgerReportRecord[],
  opts?: { reviewStatusApproved?: boolean },
): boolean {
  if (opts?.reviewStatusApproved === true) {
    return true;
  }
  if (
    child.bucket === "review" ||
    child.bucket === "done" ||
    child.bucket === "archive"
  ) {
    return true;
  }
  if (thread.pending_pm_review.includes(child.task_id)) {
    return false;
  }
  // A formal blocked/aborted/failed REPORT is a settled outcome for the
  // original child. PM may open a separate rework task, but the reported
  // task must not remain counted as "未收口" or as a missing receipt.
  if (childHasTerminalFailureReportToPm(child, reports)) {
    return true;
  }
  // Hot-path (`fcop/tasks/`) or lifecycle `active` with done REPORT→PM but no PM
  // approve yet: unsettled until `review_status: approved` (or lifecycle review/done).
  if (child.bucket === "tasks" || child.bucket === "active") {
    if (!childHasDoneReportToPm(child, reports)) {
      return false;
    }
    return false;
  }
  return false;
}

export function areAllChildrenSettledForRoot(
  rootId: string,
  tasks: LedgerTaskRecord[],
  thread: LedgerThreadRecord,
  reports: LedgerReportRecord[],
  reviewApprovedByTaskId?: Map<string, boolean>,
): boolean {
  const rootNorm = normalizeId(rootId);
  const children = tasks.filter((t) => {
    if (normalizeId(t.task_id) === rootNorm) return false;
    if (taskParentMatchesRoot(t.parent, rootId)) return true;
    return false;
  });
  if (!children.length) return false;
  return children.every((c) =>
    isChildSettledForRoot(c, thread, reports, {
      reviewStatusApproved: reviewApprovedByTaskId?.get(c.task_id) === true,
    }),
  );
}
