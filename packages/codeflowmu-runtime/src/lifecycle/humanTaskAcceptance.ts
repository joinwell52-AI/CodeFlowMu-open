import { promises as fs } from "node:fs";
import { join } from "node:path";

import { parseMarkdownFrontmatter } from "../ledger/frontmatter.ts";
import type { HumanTaskAcceptance, TaskFm } from "./types.ts";

export type PendingHumanReview = {
  reviewId: string;
  reportId: string;
};

export async function findPendingHumanReview(
  lifecycleRoot: string,
  taskId: string,
): Promise<PendingHumanReview | null> {
  const reviewsDir = join(lifecycleRoot, "..", "reviews");
  let names: string[] = [];
  try {
    names = await fs.readdir(reviewsDir);
  } catch {
    return null;
  }
  const canonical = /^TASK-\d{8}-\d{3,}/i.exec(taskId)?.[0].toUpperCase() ?? taskId.toUpperCase();
  for (const name of names) {
    if (!/^REVIEW-.*\.md$/i.test(name)) continue;
    let raw = "";
    try {
      raw = await fs.readFile(join(reviewsDir, name), "utf-8");
    } catch {
      continue;
    }
    const review = parseMarkdownFrontmatter(raw) as Record<string, unknown>;
    const reviewTask = String(review["task_id"] ?? review["subject_id"] ?? "").toUpperCase();
    if (!reviewTask.includes(canonical)) continue;
    const decision = String(review["decision"] ?? review["fact_check_verdict"] ?? "").toLowerCase();
    if (decision !== "needs_human" && decision !== "needs_admin") continue;
    const humanApproval = review["human_approval"];
    if (
      String(review["approved_at"] ?? "").trim() ||
      (humanApproval && typeof humanApproval === "object" &&
        String((humanApproval as Record<string, unknown>)["approved_at"] ?? "").trim())
    ) continue;
    return {
      reviewId: String(review["review_id"] ?? name.replace(/\.md$/i, "")).trim(),
      reportId: String(review["report_id"] ?? review["subject_id"] ?? "").trim(),
    };
  }
  return null;
}

export function assertTrustedHumanTaskAcceptance(input: {
  task: TaskFm;
  actor: string;
  pending: PendingHumanReview;
  acceptance?: HumanTaskAcceptance;
}): HumanTaskAcceptance {
  const actorRole = input.actor.trim().toUpperCase();
  const acceptance = input.acceptance;
  const decisionId = String(input.task.fact_check_decision_id ?? "").trim();
  const exceptionReviewId = String(input.task.fact_check_exception_review_id ?? "").trim();
  const exceptionReportId = String(input.task.fact_check_exception_report_id ?? "").trim();
  if (
    input.task.fact_check_exception !== true ||
    String(input.task.fact_check_exception_by ?? "").trim().toUpperCase() !== "ADMIN" ||
    !decisionId || !exceptionReviewId || !exceptionReportId
  ) {
    throw new Error("approve_review denied: human task acceptance requires an audited fact-check exception");
  }
  if (!acceptance) {
    throw new Error("approve_review denied: unresolved needs_human review requires a trusted human decision");
  }
  if (
    acceptance.source !== "panel_trusted_foreground_confirmation" ||
    acceptance.operatorRole.trim().toUpperCase() !== actorRole
  ) {
    throw new Error("approve_review denied: human decision source or operator role is not trusted");
  }
  if (
    acceptance.decisionId !== decisionId ||
    acceptance.reviewId !== exceptionReviewId ||
    acceptance.reportId !== exceptionReportId ||
    (input.pending.reviewId && acceptance.reviewId !== input.pending.reviewId) ||
    (input.pending.reportId && acceptance.reportId !== input.pending.reportId)
  ) {
    throw new Error("approve_review denied: human task acceptance evidence linkage is stale or mismatched");
  }
  return acceptance;
}

export function humanDecisionTaskPatch(
  acceptance: HumanTaskAcceptance,
  actor: string,
  approvedAt: string,
  note?: string,
): Partial<TaskFm> {
  const actorRole = actor.trim().toUpperCase();
  return {
    human_decision: true,
    human_decision_at: approvedAt,
    human_decision_by: actorRole,
    human_decision_role: actorRole,
    human_decision_source: acceptance.source,
    human_decision_session_id: acceptance.sessionId ?? "",
    human_decision_decision_id: acceptance.decisionId,
    human_decision_review_id: acceptance.reviewId,
    human_decision_report_id: acceptance.reportId,
    human_decision_note: acceptance.note ?? note ?? "",
    human_decision_scope: "task_review_only_no_wp_publish_deploy_archive",
  };
}
