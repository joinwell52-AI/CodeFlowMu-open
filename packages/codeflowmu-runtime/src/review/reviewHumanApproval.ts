import { taskIdMatchesPrefix } from "../ledger/reportParenting.ts";

function str(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

/** Read human_approval.approved_at (nested) or legacy flat approved_at. */
export function humanApprovalApprovedAt(
  fm: Record<string, unknown>,
): string | null {
  const ha = fm.human_approval;
  if (ha && typeof ha === "object" && !Array.isArray(ha)) {
    const at = str((ha as Record<string, unknown>).approved_at);
    if (at && at !== "null" && at !== "''") return at;
  }
  const flat = str(fm.approved_at);
  if (flat && flat !== "null" && flat !== "''") return flat;
  return null;
}

/** True when decision is needs_human and ADMIN has not acked yet. */
export function isReviewPendingHuman(fm: Record<string, unknown>): boolean {
  if (str(fm.decision) !== "needs_human") return false;
  return humanApprovalApprovedAt(fm) === null;
}

/** Optional thread/task filter for approval list APIs. */
export function reviewMatchesScope(
  fm: Record<string, unknown>,
  scope: { taskId?: string; threadKey?: string },
): boolean {
  const taskId = scope.taskId?.trim();
  const threadKey = scope.threadKey?.trim();
  if (!taskId && !threadKey) return true;

  const tid = (str(fm.task_id) || str(fm.subject_id)).replace(/\.md$/i, "");

  if (taskId) {
    if (tid && taskIdMatchesPrefix(tid, taskId)) return true;
    return false;
  }

  const fmThread = str(fm.thread_key);
  if (threadKey && fmThread === threadKey) return true;
  return false;
}
