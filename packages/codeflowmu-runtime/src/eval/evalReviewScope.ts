import { taskIdMatchesPrefix, taskIdPrefix } from "../ledger/reportParenting.ts";
import type { LedgerReportRecord, LedgerTaskRecord } from "../ledger/types.ts";
import { isReviewPendingHuman } from "../review/reviewHumanApproval.ts";

export type EvalReviewRow = {
  id: string;
  decision: string;
  taskId: string;
  subjectId: string;
  reviewer: string;
  threadKey: string;
  humanApprovalApprovedAt: string | null;
};

export function isReviewGateReviewer(reviewer: string): boolean {
  return reviewer.toUpperCase() === "REVIEW-GATE";
}

function normalizeReportRef(id: string): string {
  return id.replace(/\.md$/i, "").trim();
}

function reportIdSet(reports: LedgerReportRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const r of reports) {
    const rid = r.report_id ?? r.filename.replace(/\.md$/i, "");
    ids.add(normalizeReportRef(rid));
    ids.add(normalizeReportRef(r.filename));
    ids.add(normalizeReportRef(r.report_id ?? ""));
  }
  return ids;
}

/** Keep REVIEW artefacts that belong to the same thread as the ADMIN root task. */
export function filterReviewsForThread(
  reviews: EvalReviewRow[],
  input: {
    rootId: string;
    children: LedgerTaskRecord[];
    threadKey: string;
    reports: LedgerReportRecord[];
  },
): EvalReviewRow[] {
  const rootPrefix = taskIdPrefix(input.rootId);
  const reportIds = reportIdSet(input.reports);
  const childIds = input.children.map((c) => c.task_id);

  return reviews.filter((rev) => {
    const tid = rev.taskId;
    if (tid) {
      if (taskIdMatchesPrefix(tid, input.rootId)) return true;
      if (taskIdMatchesPrefix(tid, rootPrefix)) return true;
      for (const cid of childIds) {
        if (taskIdMatchesPrefix(tid, cid)) return true;
      }
    }
    const sid = normalizeReportRef(rev.subjectId);
    if (sid && reportIds.has(sid)) return true;
    return false;
  });
}

/** REVIEW-GATE system reviews are not expected in PM summary prose. */
export function reviewsForPmSummaryCoverage(reviews: EvalReviewRow[]): EvalReviewRow[] {
  return reviews.filter((r) => !isReviewGateReviewer(r.reviewer));
}

/** needs_human only counts when not yet human-approved. */
export function isPendingHumanReviewRow(rev: EvalReviewRow): boolean {
  if (rev.decision !== "needs_human") return false;
  if (rev.humanApprovalApprovedAt) return false;
  return true;
}

export type PendingReviewGateKind =
  | "main_admin_approval_pending"
  | "child_review_pending";

export function reviewTargetsRootTask(
  rev: EvalReviewRow,
  rootId: string,
): boolean {
  const tid = rev.taskId || rev.subjectId;
  if (!tid) return false;
  return taskIdMatchesPrefix(tid, rootId);
}

export function reviewTargetsChildTask(
  rev: EvalReviewRow,
  children: LedgerTaskRecord[],
): boolean {
  const tid = rev.taskId || rev.subjectId;
  if (!tid) return false;
  return children.some((c) => taskIdMatchesPrefix(tid, c.task_id));
}

/** Classify pending human REVIEW rows for EVAL gate semantics. */
export function classifyPendingReviewGate(
  rev: EvalReviewRow,
  rootId: string,
  children: LedgerTaskRecord[],
): PendingReviewGateKind | null {
  if (!isPendingHumanReviewRow(rev)) return null;
  if (reviewTargetsRootTask(rev, rootId)) {
    if (isReviewGateReviewer(rev.reviewer)) {
      return "main_admin_approval_pending";
    }
    return null;
  }
  if (reviewTargetsChildTask(rev, children)) {
    return "child_review_pending";
  }
  if (!isReviewGateReviewer(rev.reviewer)) {
    return "child_review_pending";
  }
  return null;
}

/** Formal REVIEW artefacts vs REVIEW-GATE human approval rows. */
export function splitFormalAndHumanGateReviews(reviews: EvalReviewRow[]): {
  formal: EvalReviewRow[];
  humanGate: EvalReviewRow[];
} {
  const formal: EvalReviewRow[] = [];
  const humanGate: EvalReviewRow[] = [];
  for (const r of reviews) {
    if (isReviewGateReviewer(r.reviewer)) humanGate.push(r);
    else formal.push(r);
  }
  return { formal, humanGate };
}
