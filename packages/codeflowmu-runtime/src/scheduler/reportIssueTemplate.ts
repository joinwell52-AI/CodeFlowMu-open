import { basename } from "node:path";

import { strField } from "../ledger/frontmatter.ts";
import { bodyAfterFrontmatter } from "../ledger/leaderLedgerContextPack.ts";

const SUMMARY_MAX_LEN = 500;
const EVIDENCE_KEYWORDS = [
  "blocked",
  "failed",
  "缺少",
  "未通过",
  "不建议",
  "request_rework",
  "EVAL",
  "QA",
  "DEV",
  "OPS",
] as const;

const SUMMARY_SECTIONS = ["结论", "执行结果"] as const;

export type ReportIssueReason =
  | "blocked_report"
  | "failed_report"
  | "report_escalation";

export interface BuildReportIssueDocOpts {
  issueId: string;
  reportId: string;
  reportFilePath: string;
  reportRaw: string;
  reportFm: Record<string, unknown>;
  taskId: string;
  sender: string;
  alertCode?: string;
  /** Short runtime reason (legacy log / event). */
  runtimeReason?: string;
  createdAt: Date;
}

export interface ReportIssueDoc {
  frontmatter: Record<string, unknown>;
  bodyMarkdown: string;
}

function stripReportBody(raw: string): string {
  return bodyAfterFrontmatter(raw).trim();
}

function escapeSectionRe(title: string): string {
  return title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstParagraphAfterHeading(body: string, heading: string): string | null {
  const re = new RegExp(
    `^##\\s+${escapeSectionRe(heading)}\\s*$\\s*([\\s\\S]*?)(?=^##\\s+|\\Z)`,
    "im",
  );
  const match = body.match(re);
  if (!match) return null;
  const paragraph = (match[1] ?? "")
    .split(/\r?\n\r?\n/)
    .map((block) =>
      block
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .join(" "),
    )
    .find(Boolean);
  return paragraph?.trim() || null;
}

function firstNonEmptyParagraph(body: string): string | null {
  const blocks = body.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const text = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && !/^[-*]\s/.test(line))
      .join(" ");
    if (text) return text;
  }
  return null;
}

export function extractSummaryFromReportBody(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  for (const section of SUMMARY_SECTIONS) {
    const fromSection = firstParagraphAfterHeading(trimmed, section);
    if (fromSection) return fromSection.slice(0, SUMMARY_MAX_LEN);
  }
  const first = firstNonEmptyParagraph(trimmed);
  return first ? first.slice(0, SUMMARY_MAX_LEN) : null;
}

export function extractEvidenceLinesFromReportBody(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const lower = trimmed.toLowerCase();
    const matched = EVIDENCE_KEYWORDS.some((kw) => {
      if (/^[A-Z]+$/.test(kw)) return trimmed.includes(kw);
      return lower.includes(kw.toLowerCase());
    });
    if (!matched) continue;
    const bullet = trimmed.replace(/^[-*]\s*/, "");
    if (seen.has(bullet)) continue;
    seen.add(bullet);
    hits.push(bullet);
    if (hits.length >= 5) break;
  }
  return hits;
}

export function inferReportIssueReason(
  reportFm: Record<string, unknown>,
): ReportIssueReason {
  const status = strField(reportFm, "status").toLowerCase();
  if (status === "blocked" || status === "aborted") return "blocked_report";
  if (status === "failed") return "failed_report";
  return "report_escalation";
}

function buildSuggestedActionsSection(reason: ReportIssueReason): string {
  if (reason === "blocked_report") {
    return [
      "建议：",
      "",
      "1. 生成或查看 EVAL 观察报告；",
      "2. 若 blocked 属实，执行 request_rework；",
      "3. 补充验证后再允许 approve；",
      "4. 或由 ADMIN 明确 force_archive。",
    ].join("\n");
  }
  if (reason === "failed_report") {
    return [
      "建议：",
      "",
      "1. ADMIN 介入；",
      "2. 重新派发任务或 request_rework；",
      "3. 不建议直接 approve。",
    ].join("\n");
  }
  return [
    "建议：",
    "",
    "1. 查看源 REPORT；",
    "2. 决定 close_issue / request_rework / force_archive。",
  ].join("\n");
}

const SUMMARY_FALLBACK =
  "源 REPORT 请求升级为 ISSUE，但未提供明确摘要。请 ADMIN 查看源 REPORT。";

export function buildReportIssueDoc(opts: BuildReportIssueDocOpts): ReportIssueDoc {
  const reportBody = stripReportBody(opts.reportRaw);
  const reportBasename = basename(opts.reportFilePath);
  const threadKey =
    strField(opts.reportFm, "thread_key") ||
    strField(opts.reportFm, "thread") ||
    "";
  const reason = inferReportIssueReason(opts.reportFm);
  const summary = extractSummaryFromReportBody(reportBody) ?? SUMMARY_FALLBACK;
  const evidenceLines = extractEvidenceLinesFromReportBody(reportBody);
  const createdAt = opts.createdAt.toISOString();

  const frontmatter: Record<string, unknown> = {
    protocol: "fcop",
    version: 1,
    type: "ISSUE",
    kind: "issue",
    issue_id: opts.issueId,
    sender: opts.sender || "runtime",
    recipient: "PM",
    source_report: opts.reportId,
    source_task: opts.taskId,
    thread_key: threadKey || undefined,
    severity: "medium",
    status: "open",
    owner: "ADMIN",
    reason,
    created_at: createdAt,
    task_id: opts.taskId,
    references: [opts.taskId, opts.reportId].filter(Boolean),
  };
  if (opts.alertCode) frontmatter.alert_code = opts.alertCode;

  const evidenceBlock =
    evidenceLines.length > 0
      ? evidenceLines.map((line) => `- ${line}`).join("\n")
      : [`- Source report: ${reportBasename}`, `- Source task: ${opts.taskId}`].join(
          "\n",
        );

  const impactThread = threadKey || "（未指定）";

  const bodyMarkdown = [
    "# Runtime Issue",
    "",
    "## 问题摘要",
    "",
    summary,
    "",
    "## 影响范围",
    "",
    `- Source task: ${opts.taskId}`,
    `- Source report: ${reportBasename}`,
    `- Thread: ${impactThread}`,
    "- Impact: 当前主线不应直接 approve，需 ADMIN 处理。",
    "",
    "## 证据",
    "",
    evidenceBlock,
    "",
    "## 建议动作",
    "",
    buildSuggestedActionsSection(reason),
    "",
  ].join("\n");

  if (opts.runtimeReason && opts.runtimeReason !== "REPORT requested issue escalation") {
    return {
      frontmatter,
      bodyMarkdown: [
        bodyMarkdown.trimEnd(),
        "",
        "## 运行时附注",
        "",
        opts.runtimeReason,
        "",
      ].join("\n"),
    };
  }

  return { frontmatter, bodyMarkdown };
}
