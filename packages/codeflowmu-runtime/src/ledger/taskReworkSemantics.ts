/**
 * Distinguish ADMIN/PM reject (rework) from virtual-PM branch settlement notes.
 * Ledger must not treat `review_note` as `reopen_reason` — Panel uses reopen_reason for rework UI.
 */

import {
  VIRTUAL_PM_AUTO_ARCHIVE_REASON,
  VIRTUAL_PM_AUTO_REVIEW_NOTE,
} from "./virtualPmBranchSettle.ts";

export { VIRTUAL_PM_AUTO_REVIEW_NOTE, VIRTUAL_PM_AUTO_ARCHIVE_REASON };

export function isVirtualPmSettlementNote(text: string | undefined): boolean {
  const s = String(text ?? "").trim();
  if (!s) return false;
  return (
    s.includes("虚拟 PM 自动审核") ||
    s.includes("虚拟 PM 自动归档") ||
    s === VIRTUAL_PM_AUTO_REVIEW_NOTE ||
    s === VIRTUAL_PM_AUTO_ARCHIVE_REASON
  );
}

export type TaskReworkLedgerFields = {
  display_status?: string;
  reopen_reason?: string;
  review_note?: string;
  review_status?: string;
  reopened_count?: number;
  rework_completed_by_report?: string;
  bucket?: string;
  scope?: string;
  state?: string;
};

/** Rework gate cleared — resubmit_review allowed; audit reopen_* retained. */
export function isReworkResubmitUnblocked(
  fields: TaskReworkLedgerFields,
): boolean {
  const ds = String(fields.display_status ?? "").trim().toLowerCase();
  const rs = String(fields.review_status ?? "").trim().toLowerCase();
  if (ds === "ready_for_review" || rs === "rework_done") return true;
  if (String(fields.rework_completed_by_report ?? "").trim()) return true;
  return false;
}

/** True when task is closed after virtual PM approve+archive (branch hot_path). */
export function isTaskSettledClosed(fields: TaskReworkLedgerFields): boolean {
  const reviewApproved =
    String(fields.review_status ?? "").trim().toLowerCase() === "approved";
  if (!reviewApproved) return false;

  const scope = String(fields.scope ?? "")
    .trim()
    .toLowerCase();
  if (scope === "inbox" || scope === "active" || scope === "review") {
    return false;
  }
  if (scope === "done" || scope === "archive") {
    return true;
  }

  const ds = String(fields.display_status ?? "").trim().toLowerCase();
  if (ds === "done") return true;

  const bucket = String(fields.bucket ?? fields.state ?? "")
    .trim()
    .toLowerCase();
  return bucket === "archive" || bucket === "done";
}

/** ADMIN reject / PM reopen — not virtual PM auto review note on approved archive. */
export function isTaskReopenedForReworkFromLedger(
  fields: TaskReworkLedgerFields,
): boolean {
  if (isTaskSettledClosed(fields)) return false;
  if (isReworkResubmitUnblocked(fields)) return false;

  // Approved tasks are awaiting archive, not rework — historical reopen_* is audit-only.
  if (String(fields.review_status ?? "").trim().toLowerCase() === "approved") {
    return false;
  }

  const ds = String(fields.display_status ?? "").trim().toLowerCase();
  if (ds === "admin_rejected") return true;
  if (ds === "waiting_pm_rework" || ds === "pm_rework_required") return true;

  if (String(fields.review_status ?? "").trim().toLowerCase() === "rejected") {
    return true;
  }

  if (Number(fields.reopened_count ?? 0) > 0) return true;

  const reopen = String(fields.reopen_reason ?? "").trim();
  if (reopen && !isVirtualPmSettlementNote(reopen)) return true;

  const note = String(fields.review_note ?? "").trim();
  if (note && !isVirtualPmSettlementNote(note) && !reopen) {
    /* review_note alone without reopen_reason is not rework (post LedgerBuilder fix) */
  }

  return false;
}
