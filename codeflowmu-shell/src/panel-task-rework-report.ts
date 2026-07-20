/**
 * Panel TASK↔REPORT pairing for ADMIN rework / submit_review — testable mirror of inline JS.
 */

export type TaskTransitionLike = {
  at?: string;
  action?: string;
  report?: string;
};

export type TaskReworkLike = {
  filename?: string;
  display_status?: string;
  review_status?: string;
  reopen_reason?: string;
  reopened_count?: number;
  rework_completed_by_report?: string;
  transitions?: TaskTransitionLike[];
  yaml?: { transitions?: TaskTransitionLike[] };
};

export type ReportLike = {
  filename?: string;
  status?: string;
  created_at?: string;
  task_id?: string;
  references?: string;
};

export function taskTransitions(f: TaskReworkLike | null | undefined): TaskTransitionLike[] {
  if (!f) return [];
  if (Array.isArray(f.transitions)) return f.transitions;
  if (Array.isArray(f.yaml?.transitions)) return f.yaml.transitions;
  return [];
}

export function getLatestRejectReviewAtMs(f: TaskReworkLike | null | undefined): number | null {
  let max: number | null = null;
  for (const t of taskTransitions(f)) {
    if (String(t.action ?? "").trim().toLowerCase() !== "reject_review") continue;
    const ms = Date.parse(String(t.at ?? ""));
    if (!Number.isFinite(ms)) continue;
    if (max == null || ms > max) max = ms;
  }
  return max;
}

export function getLatestSubmitReviewReportId(
  f: TaskReworkLike | null | undefined,
): string {
  let last = "";
  for (const t of taskTransitions(f)) {
    if (String(t.action ?? "").trim().toLowerCase() !== "submit_review") continue;
    const rep = String(t.report ?? "").trim();
    if (rep) last = rep;
  }
  return last;
}

export function parseReportCreatedAtMs(rep: ReportLike | null | undefined): number | null {
  if (!rep) return null;
  const ms = Date.parse(String(rep.created_at ?? ""));
  return Number.isFinite(ms) ? ms : null;
}

export function isReworkResubmitUnblocked(f: TaskReworkLike | null | undefined): boolean {
  if (!f) return false;
  const ds = String(f.display_status ?? "").toLowerCase();
  const rs = String(f.review_status ?? "").toLowerCase();
  if (ds === "ready_for_review" || rs === "rework_done") return true;
  if (String(f.rework_completed_by_report ?? "").trim()) return true;
  return false;
}

export function isTaskReopenedForReworkPanel(f: TaskReworkLike | null | undefined): boolean {
  if (!f) return false;
  if (isReworkResubmitUnblocked(f)) return false;
  if (String(f.review_status ?? "").toLowerCase() === "approved") return false;
  const ds = String(f.display_status ?? "").toLowerCase();
  if (ds === "admin_rejected") return true;
  const rr = String(f.reopen_reason ?? "").trim();
  if (rr) return true;
  if (String(f.review_status ?? "").toLowerCase() === "rejected") return true;
  if (Number(f.reopened_count ?? 0) > 0) return true;
  return false;
}

export function normalizeReportFileKey(fn: string): string {
  return String(fn || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()!
    .replace(/\.md$/i, "")
    .trim();
}

export function resolvePreferredReworkReport<T extends ReportLike>(
  task: TaskReworkLike,
  reports: T[],
): T | null {
  const prefer = String(task.rework_completed_by_report ?? "").trim();
  if (prefer) {
    const key = normalizeReportFileKey(prefer);
    const hit = reports.find(
      (r) => normalizeReportFileKey(r.filename ?? "") === key || r.filename === prefer,
    );
    if (hit) return hit;
  }
  if (String(task.review_status ?? "").toLowerCase() === "pending") {
    const submitId = getLatestSubmitReviewReportId(task);
    if (submitId) {
      const key = normalizeReportFileKey(submitId);
      const hit = reports.find((r) => normalizeReportFileKey(r.filename ?? "") === key);
      if (hit) return hit;
    }
  }
  return null;
}

/** ADMIN 主线打回返工：仅当存在打回后 PM→ADMIN 报告时可展示「查看报告」。 */
export function hasReportForReworkAdminMainline(
  task: TaskReworkLike,
  report: ReportLike | null,
): boolean {
  if (!report) return false;
  if (isReworkResubmitUnblocked(task)) return true;
  const rejectAt = getLatestRejectReviewAtMs(task);
  const repCreated = parseReportCreatedAtMs(report);
  const repDone = String(report.status ?? "").toLowerCase() === "done";
  if (repDone && rejectAt != null && repCreated != null && repCreated > rejectAt) {
    return true;
  }
  return false;
}

export function hasReportForTaskPanel(
  task: TaskReworkLike,
  report: ReportLike | null,
  opts?: { isAdminMainline?: boolean; isPmMainlineReply?: boolean },
): boolean {
  if (!report) return false;
  const isAdmin = opts?.isAdminMainline ?? /-ADMIN-to-PM/i.test(task.filename ?? "");
  const isPmReply = opts?.isPmMainlineReply ?? /-PM-to-ADMIN/i.test(report.filename ?? "");
  if (
    isTaskReopenedForReworkPanel(task) &&
    isAdmin &&
    isPmReply
  ) {
    return hasReportForReworkAdminMainline(task, report);
  }
  return true;
}
