import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  parseMarkdownFrontmatter,
  renderFrontmatter,
  strField,
} from "../ledger/frontmatter.ts";
import { resolveLedgerLayout } from "../ledger/paths.ts";
import type { EvidenceSummary } from "./ReviewEvidenceResolver.ts";
import { formatFactCheckJudgmentSummary } from "./factCheckLabels.ts";
import type { FactCheckResult } from "./ReviewFactGate.ts";

export { buildPmAttentionReason, factCheckReasonLabel, formatFactCheckJudgmentSummary } from "./factCheckLabels.ts";

export type WriteFactCheckReviewInput = {
  projectRoot: string;
  taskId: string;
  reportId: string;
  evidence: EvidenceSummary;
  result: FactCheckResult;
  now?: () => Date;
};

function dateKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

async function nextReviewSeq(reviewsDir: string, date: string): Promise<number> {
  let names: string[] = [];
  try {
    names = await fs.readdir(reviewsDir);
  } catch {
    return 1;
  }
  let max = 0;
  const prefix = `REVIEW-${date}-`;
  for (const name of names) {
    const m = name.match(new RegExp(`^${prefix}(\\d{3})`, "i"));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function decisionFromVerdict(
  verdict: FactCheckResult["verdict"],
): "approved" | "changes_requested" | "needs_human" {
  switch (verdict) {
    case "pass":
      return "approved";
    case "fail":
      // Missing/contradictory evidence is a deterministic rework request,
      // not an orphan ADMIN approval. Only genuinely inconclusive evidence
      // enters the needs_human risk-acceptance queue.
      return "changes_requested";
    case "needs_admin":
      return "needs_human";
  }
}

function normalizeReportRef(id: string): string {
  return id.replace(/\.md$/i, "").trim();
}

async function findExistingFactCheckReview(
  reviewsDir: string,
  taskId: string,
  reportId: string,
): Promise<string | null> {
  const suffix = `-on-${taskId}.md`;
  const wantReport = normalizeReportRef(reportId);
  let names: string[] = [];
  try {
    names = await fs.readdir(reviewsDir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith(suffix) || !name.startsWith("REVIEW-")) continue;
    const path = join(reviewsDir, name);
    const raw = await fs.readFile(path, "utf-8").catch(() => "");
    const fm = parseMarkdownFrontmatter(raw) as Record<string, unknown>;
    const rid = normalizeReportRef(
      strField(fm, "report_id") || strField(fm, "subject_id"),
    );
    if (rid && rid === wantReport) return path;
  }
  return null;
}

/**
 * Write REVIEW-GATE fact-check artefact under fcop/reviews/.
 */
export async function writeFactCheckReview(
  input: WriteFactCheckReviewInput,
): Promise<string> {
  const now = input.now?.() ?? new Date();
  const layout = resolveLedgerLayout(input.projectRoot);
  await fs.mkdir(layout.reviewsDir, { recursive: true });

  const existing = await findExistingFactCheckReview(
    layout.reviewsDir,
    input.taskId,
    input.reportId,
  );
  if (existing) return existing;

  const dk = dateKey(now);
  const seq = await nextReviewSeq(layout.reviewsDir, dk);
  const seqStr = String(seq).padStart(3, "0");
  const reviewId = `REVIEW-${dk}-${seqStr}-REVIEW-GATE`;
  const filename = `${reviewId}-on-${input.taskId}.md`;
  const path = join(layout.reviewsDir, filename);

  const decision = decisionFromVerdict(input.result.verdict);
  const reviewedAt = now.toISOString();

  const bodyLines = [
    renderFrontmatter({
      protocol: "fcop",
      version: 1,
      kind: "review",
      review_id: reviewId,
      subject_id: input.reportId,
      task_id: input.taskId,
      report_id: input.reportId,
      reviewer: "REVIEW-GATE",
      decision,
      reviewed_at: reviewedAt,
      fact_check_verdict: input.result.verdict,
      reason_code: input.result.reason_code,
    }),
    "",
    "# Review Fact Check / 事实核查",
    "",
    `Task: ${input.taskId}`,
    `Report: ${input.reportId}`,
    `Verdict: **${input.result.verdict}**`,
    `Reason: \`${input.result.reason_code}\``,
    "",
    "## 判定说明 / Judgment",
    "",
    formatFactCheckJudgmentSummary(input.result),
    "",
    "## Evidence Summary",
    "",
    `- Session found: ${input.evidence.session.found}`,
    `- Files read: ${input.evidence.files.read.length}`,
    `- Files changed: ${input.evidence.files.changed.length}`,
    `- Commands: ${input.evidence.commands.length}`,
    `- Data queries: ${input.evidence.data_queries.length}`,
    "",
  ];

  if (input.result.unsupported_claims.length > 0) {
    bodyLines.push("## Unsupported Claims", "");
    for (const c of input.result.unsupported_claims) {
      bodyLines.push(`- ${c}`);
    }
    bodyLines.push("");
  }

  if (input.result.required_changes.length > 0) {
    bodyLines.push("## Required Changes", "");
    for (const c of input.result.required_changes) {
      bodyLines.push(`- ${c}`);
    }
    bodyLines.push("");
  }

  if (input.evidence.warnings.length > 0) {
    bodyLines.push("## Evidence Warnings", "");
    for (const w of input.evidence.warnings) {
      bodyLines.push(`- ${w}`);
    }
    bodyLines.push("");
  }

  await fs.writeFile(path, bodyLines.join("\n"), "utf-8");
  return path;
}
