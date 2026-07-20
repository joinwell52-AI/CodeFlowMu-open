/**
 * EVAL 报告晋升 v1 — 三动作：本地 TASK / CodeFlowMu Issue 草稿 / FCoP Issue 草稿。
 * Issue 草稿经 ADMIN 勾选确认后，可正式 `gh issue create` 提交 GitHub。
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fcopInternalEvalDir } from "./fcop-governance.ts";
import { fcopV3Paths, fcopV3TaskSearchDirs } from "./fcop-v3-paths.ts";

export type EvalPromotionAction = "task" | "codeflowmu_issue" | "fcop_issue";

export type EvalPromotionResult = {
  ok: true;
  action: EvalPromotionAction;
  eval_rel_path: string;
  target_file: string;
  target_repo?: string;
  filename: string;
  sanitize_warnings: string[];
};

export type SubmitIssueDraftResult = {
  ok: true;
  eval_rel_path: string;
  target_file: string;
  target_repo: string;
  github_url: string;
  github_issue_number?: number;
};

export type SubmitLocalTaskDraftResult = {
  ok: true;
  eval_rel_path: string;
  draft_file: string;
  target_file: string;
  filename: string;
};

export type DeleteEvalDraftResult = {
  ok: true;
  eval_rel_path: string;
  deleted_file: string;
};

const SENSITIVE_PATTERNS: { re: RegExp; msg: string }[] = [
  { re: /sk-[a-zA-Z0-9]{20,}/, msg: "疑似 API Key（sk-…）" },
  { re: /ghp_[a-zA-Z0-9]{20,}/, msg: "疑似 GitHub Token" },
  { re: /Bearer\s+[a-zA-Z0-9._-]{20,}/i, msg: "疑似 Bearer Token" },
  { re: /[A-Za-z]:\\[^\s`]+/g, msg: "含 Windows 绝对路径（提交 GitHub 前请脱敏）" },
  { re: /\/home\/[^\s`]+/g, msg: "含 Unix 绝对路径（提交 GitHub 前请脱敏）" },
  { re: /\.env\b/i, msg: "提及 .env 文件" },
];

/** Issue 正文脱敏后仍不得出现的敏感片段（与 buildGithubReadyIssueBody 配套）。 */
const ISSUE_INTERNAL_ID_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bTASK-\d{8}-\d+/i, label: "TASK-*" },
  { re: /\bREPORT-\d{8}-\d+/i, label: "REPORT-*" },
  { re: /\bISSUE-\d{8}-\d+/i, label: "ISSUE-*" },
  { re: /\bThread\s*:/i, label: "Thread:" },
  { re: /Source\s+PM\s+report/i, label: "Source PM report" },
  { re: /Main\s+task\s*:/i, label: "Main task:" },
  { re: /eval-promotion-/i, label: "eval-promotion-" },
  { re: /\bsource_eval\b/i, label: "source_eval" },
];

const ISSUE_FORBIDDEN_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /INTERNAL\s+ONLY/i, label: "INTERNAL ONLY" },
  { re: /DO\s+NOT\s+EXTERNALIZE/i, label: "DO NOT EXTERNALIZE" },
  { re: /fcop\/internal\/eval/i, label: "fcop/internal/eval" },
  { re: /fcop\/logs\//i, label: "fcop/logs/" },
  { re: /fcop\/internal\//i, label: "fcop/internal/" },
  { re: /fcop\/_lifecycle\//i, label: "fcop/_lifecycle/" },
  { re: /MANUAL-EVAL-/i, label: "MANUAL-EVAL-" },
  { re: /九类资产矩阵/i, label: "九类资产矩阵" },
  { re: /内部档案/i, label: "内部档案" },
  { re: /私有日志/i, label: "私有日志" },
  { re: /私有任务正文/i, label: "私有任务正文" },
  { re: /[A-Za-z]:\\[^\s`]+/, label: "Windows 绝对路径" },
  { re: /\/(?:home|Users)\/[^\s`]+/, label: "Unix 绝对路径" },
  { re: /(?:扫描|分析)\s*\d+\s*类(?:资产)?/i, label: "具体内部扫描数量" },
  { re: /assets_analyzed:/i, label: "assets_analyzed" },
  { re: /internal\/eval/i, label: "internal/eval" },
  ...ISSUE_INTERNAL_ID_PATTERNS,
];

const ISSUE_REDACTION_REPLACEMENTS: { re: RegExp; repl: string; reason: string }[] = [
  { re: /^>\s*⚠️[\s\S]*?(?=\r?\n\r?\n)/gm, repl: "", reason: "removed internal-only banner" },
  { re: /INTERNAL\s+ONLY[^\n]*/gi, repl: "", reason: "removed INTERNAL ONLY" },
  { re: /DO\s+NOT\s+EXTERNALIZE[^\n]*/gi, repl: "", reason: "removed DO NOT EXTERNALIZE" },
  { re: /fcop\/internal\/eval[^\s`)\]]*/gi, repl: "", reason: "redacted fcop/internal/eval path" },
  { re: /fcop\/logs\/[^\s`)\]]*/gi, repl: "", reason: "redacted fcop/logs/ path" },
  { re: /fcop\/internal\/[^\s`)\]]*/gi, repl: "", reason: "redacted fcop/internal/ path" },
  { re: /fcop\/_lifecycle\/[^\s`)\]]*/gi, repl: "", reason: "redacted fcop/_lifecycle/ path" },
  { re: /MANUAL-EVAL-[A-Z0-9-]+/gi, repl: "", reason: "redacted MANUAL-EVAL reference" },
  { re: /九类资产(?:分析)?矩阵/gi, repl: "协议与产品资产", reason: "redacted 九类资产矩阵" },
  { re: /内部档案/g, repl: "内部材料", reason: "redacted 内部档案" },
  { re: /私有日志/g, repl: "敏感运行日志", reason: "redacted 私有日志" },
  { re: /私有任务正文/g, repl: "未公开任务细节", reason: "redacted 私有任务正文" },
  { re: /[A-Za-z]:\\[^\s`)\]]+/g, repl: "[redacted-local-path]", reason: "redacted Windows path" },
  { re: /\/(?:home|Users)\/[^\s`)\]]+/g, repl: "[redacted-local-path]", reason: "redacted Unix path" },
  { re: /(?:扫描|分析)\s*\d+\s*类(?:资产)?/gi, repl: "资产扫描", reason: "redacted internal scan counts" },
  { re: /assets_analyzed:\s*[^\n]+/gi, repl: "", reason: "redacted assets_analyzed" },
  { re: /`fcop\/[^`]+`/g, repl: "", reason: "redacted fcop path in backticks" },
  { re: /见\s*source_eval[^\n]*/gi, repl: "", reason: "redacted source_eval pointer" },
  { re: /source_eval:\s*`[^`]+`/gi, repl: "", reason: "redacted source_eval field" },
  { re: /旁路观察[^\n]*/g, repl: "", reason: "redacted 旁路观察" },
  { re: /不驱动\s*lifecycle[^\n]*/gi, repl: "", reason: "redacted lifecycle bypass note" },
  { re: /^Source\s+PM\s+report:.*$/gim, repl: "", reason: "redacted Source PM report line" },
  { re: /^Main\s+task:.*$/gim, repl: "", reason: "redacted Main task line" },
  { re: /^Thread:.*$/gim, repl: "", reason: "redacted Thread line" },
  { re: /\bTASK-\d{8}-\d+[^\s]*/gi, repl: "", reason: "redacted TASK id" },
  { re: /\bREPORT-\d{8}-\d+[^\s]*/gi, repl: "", reason: "redacted REPORT id" },
  { re: /\bISSUE-\d{8}-\d+[^\s]*/gi, repl: "", reason: "redacted ISSUE id" },
  { re: /eval-promotion-[a-z0-9-]+/gi, repl: "", reason: "redacted eval-promotion thread key" },
  { re: /covers_all_child_tasks:\s*(?:true|false)/gi, repl: "", reason: "redacted internal consistency flag" },
  { re: /covers_all_worker_reports:\s*(?:true|false)/gi, repl: "", reason: "redacted internal consistency flag" },
  { re: /covers_review_results:\s*(?:true|false)/gi, repl: "", reason: "redacted internal consistency flag" },
  { re: /covers_open_items:\s*(?:true|false)/gi, repl: "", reason: "redacted internal consistency flag" },
  { re: /^##\s+PM Summary Consistency[\s\S]*?(?=^##\s+|\Z)/gim, repl: "", reason: "redacted PM Summary Consistency block" },
  { re: /^##\s+(Findings|Evidence Gaps|Recommended Admin Attention)[\s\S]*?(?=^##\s+|\Z)/gim, repl: "", reason: "redacted internal findings block" },
];

export function scanIssueBodyForInternalIds(text: string): string[] {
  const hits = new Set<string>();
  for (const { re, label } of ISSUE_INTERNAL_ID_PATTERNS) {
    if (re.test(text)) hits.add(label);
    re.lastIndex = 0;
  }
  return [...hits];
}

export function scanIssueBodyForForbiddenTerms(text: string): string[] {
  const hits = new Set<string>();
  for (const { re, label } of ISSUE_FORBIDDEN_PATTERNS) {
    if (re.test(text)) hits.add(label);
    re.lastIndex = 0;
  }
  return [...hits];
}

function containsInternalCollaborationMarkers(text: string): boolean {
  return scanIssueBodyForInternalIds(text).length > 0;
}

/** PM 总报告未覆盖全部子任务 → 使用公开 Issue 专用模板。 */
export function isPmSummaryCoverageGap(raw: string): boolean {
  if (/covers_all_child_tasks\s*:\s*false/i.test(raw)) return true;
  if (/PM\s+总报告未覆盖子任务/.test(raw)) return true;
  if (/PM Summary Consistency/i.test(raw) && /未覆盖子任务|missing.*child/i.test(raw)) return true;
  return false;
}

const PM_SUMMARY_COVERAGE_PUBLIC_TITLE =
  "PM summary should explicitly cover all child tasks before review";

function buildPmSummaryCoverageIssueBody(): string {
  return [
    `# ${PM_SUMMARY_COVERAGE_PUBLIC_TITLE}`,
    "",
    "## Problem",
    "",
    "When a parent task is submitted for review, the PM final summary may omit one or more child tasks while still appearing review-ready.",
    "",
    "This creates a consistency gap between the child-task lifecycle, worker reports, and the parent PM summary.",
    "",
    "## Impact",
    "",
    "- ADMIN may review a parent task without seeing complete child-task coverage.",
    "- Review Gate may treat the PM summary as complete even when some child task is missing.",
    "- Panel users may see a task as ready for review while the summary is incomplete.",
    "",
    "## Proposal",
    "",
    "- Every child task in the thread must be mentioned or accounted for in the PM final report.",
    "- Worker reports must be mapped to the corresponding child tasks.",
    "- If any child task is missing from the PM summary, mark review as hold or needs_pm_attention.",
    "- Panel should display missing child-task count without exposing private report bodies.",
    "",
    "## Acceptance Criteria",
    "",
    "- [ ] PM final report coverage is checked against all child tasks in the thread.",
    "- [ ] Missing child-task coverage blocks or flags parent review.",
    "- [ ] Panel shows an ADMIN-facing warning when coverage is incomplete.",
    "- [ ] Public issue contains no internal task IDs, report IDs, thread keys, paths, or private logs.",
    "",
  ].join("\n");
}

function isPublicSafeProposalLine(line: string): boolean {
  const t = line.trim();
  if (!t || t.length < 12) return false;
  if (containsInternalCollaborationMarkers(t)) return false;
  if (/^##\s+/.test(t)) return false;
  if (/^(Findings|Evidence Gaps|PM Summary Consistency|Recommended Admin Attention)/i.test(t)) return false;
  return true;
}

function redactPublicIssueText(text: string): { text: string; reasons: string[] } {
  let out = text;
  const reasons: string[] = [];
  for (const { re, repl, reason } of ISSUE_REDACTION_REPLACEMENTS) {
    if (re.test(out)) {
      reasons.push(reason);
      out = out.replace(re, repl);
    }
    re.lastIndex = 0;
  }
  out = out
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: out, reasons };
}

function publicSafeProblemFallback(title: string): string {
  return (
    `During internal evaluation, a product or protocol gap was identified regarding "${title}". ` +
    "The public issue should describe the user-visible or governance impact without referencing private eval artifacts."
  );
}

function buildPublicImpactBullets(problem: string, targetLabel: string): string[] {
  const bullets = [
    "Users or operators may see inconsistent behavior between the panel, lifecycle state, and actual work status.",
    "Downstream roles may act on incomplete or misleading signals if the gap is not tracked publicly.",
    `The ${targetLabel} repository needs a clear, auditable fix rather than relying on internal-only notes.`,
  ];
  if (/\bP0\b/i.test(problem)) {
    bullets.unshift("High-severity risk: incorrect lifecycle or governance signals may block or misroute work.");
  } else if (/\bP1\b/i.test(problem)) {
    bullets.unshift("Medium-severity risk: workflow friction or audit gaps until the behavior is clarified.");
  }
  return bullets;
}

function proposalBulletsFromText(raw: string, targetLabel: string, whyRepo: string): string[] {
  const bullets: string[] = [];
  const lines = raw
    .split("\n")
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .filter(isPublicSafeProposalLine);
  for (const line of lines.slice(0, 4)) {
    bullets.push(line);
  }
  if (bullets.length === 0) {
    bullets.push("Define the expected public behavior and document the lifecycle or UI rule that should apply.");
    bullets.push("Ensure internal-only evidence is not treated as business acceptance.");
  }
  const whyClean = whyRepo.trim();
  if (whyClean && !containsInternalCollaborationMarkers(whyClean)) {
    bullets.push(`Track in ${targetLabel}: ${whyClean}`);
  }
  return bullets;
}

function buildGenericPublicProblem(title: string, sanitizedRaw: string): string {
  if (sanitizedRaw.length >= 40 && !containsInternalCollaborationMarkers(sanitizedRaw)) {
    return sanitizedRaw;
  }
  return publicSafeProblemFallback(title);
}

function buildGenericAcceptanceCriteria(): string[] {
  return [
    "- [ ] Public issue contains no internal task IDs, report IDs, thread keys, paths, or private logs.",
    "- [ ] Related lifecycle / panel behavior is clarified for operators and reviewers.",
    "- [ ] Probe/sandbox/internal evidence is not treated as business acceptance.",
  ];
}

/** EVAL 内部材料 → 脱敏改写 → GitHub 可提交 Issue 正文。 */
export function buildGithubReadyIssueBody(input: {
  title: string;
  rawProblem: string;
  whyRepo: string;
  targetLabel: string;
  rawProposal?: string;
}): {
  body: string;
  redacted: boolean;
  redactionReasons: string[];
} {
  const redactionReasons: string[] = [];
  const rawCombined = [input.rawProblem, input.rawProposal ?? "", input.whyRepo].join("\n");

  if (isPmSummaryCoverageGap(rawCombined)) {
    redactionReasons.push("used pm_summary_coverage public template");
    const body = buildPmSummaryCoverageIssueBody();
    const postScan = scanIssueBodyForForbiddenTerms(body);
    if (postScan.length) {
      redactionReasons.push(`unsafe_after_redaction: ${postScan.join(", ")}`);
    }
    return {
      body,
      redacted: true,
      redactionReasons: [...new Set(redactionReasons)],
    };
  }

  const problemRed = redactPublicIssueText(input.rawProblem);
  redactionReasons.push(...problemRed.reasons);
  const proposalRed = redactPublicIssueText(input.rawProposal ?? "");
  redactionReasons.push(...proposalRed.reasons);
  const whyRed = redactPublicIssueText(input.whyRepo);
  redactionReasons.push(...whyRed.reasons);

  const problemText = buildGenericPublicProblem(input.title, problemRed.text);
  if (problemText === publicSafeProblemFallback(input.title)) {
    redactionReasons.push("replaced internal problem with public-safe fallback");
  }

  const impactBullets = buildPublicImpactBullets(problemText, input.targetLabel);
  const proposalBullets = proposalBulletsFromText(
    proposalRed.text,
    input.targetLabel,
    whyRed.text,
  );

  let body = [
    `# ${input.title}`,
    "",
    "## Problem",
    "",
    problemText,
    "",
    "## Impact",
    "",
    ...impactBullets.map((b) => `- ${b}`),
    "",
    "## Proposal",
    "",
    ...proposalBullets.map((b) => `- ${b}`),
    "",
    "## Acceptance Criteria",
    "",
    ...buildGenericAcceptanceCriteria(),
    "",
  ].join("\n");

  const postScan = scanIssueBodyForForbiddenTerms(body);
  if (postScan.length) {
    body = [
      "> ⚠️ PUBLIC UNSAFE DRAFT",
      "> 自动脱敏失败，不可提交 GitHub。",
      "",
      body,
    ].join("\n");
    redactionReasons.push(`unsafe_after_redaction: ${postScan.join(", ")}`);
  }

  const uniqueReasons = [...new Set(redactionReasons)];
  return {
    body,
    redacted: uniqueReasons.length > 0,
    redactionReasons: uniqueReasons,
  };
}

export type EvalPromotionBranch = {
  status: string;
  target_type?: string;
  target_file: string;
  target_repo?: string;
  planned_inbox_path?: string;
  github_url?: string;
  github_status?: string;
  promoted_at?: string;
  promoted_by?: string;
  draft_created_at?: string;
  submitted_at?: string;
  admin_approved?: string;
  action?: string;
  reviewed_by?: string;
};

export type EvalPromotionButtonState = {
  promoted: boolean;
  target_file: string;
};

export type PromotionBranchName = "task" | "codeflowmu_issue" | "fcop_issue";

export type EvalPromotionState = {
  /** 兼容旧 UI 的扁平摘要字段 */
  status: string;
  action: string;
  target_type: string;
  target_file: string;
  target_repo: string;
  github_url?: string;
  github_status?: string;
  admin_approved?: string;
  task: EvalPromotionBranch;
  codeflowmu_issue: EvalPromotionBranch;
  fcop_issue: EvalPromotionBranch;
  /** 旧单 issue 分支镜像；读取时由 codeflowmu_issue / fcop_issue 或 legacy issue: 填充 */
  issue: EvalPromotionBranch;
  legacy_flat: boolean;
};

const EMPTY_BRANCH = (): EvalPromotionBranch => ({
  status: "",
  target_file: "",
});

function issueBranchFromRepo(repo: string): "codeflowmu_issue" | "fcop_issue" {
  const r = (repo || "").trim().toLowerCase();
  if (r.includes("fcop") || r.endsWith("/fcop")) return "fcop_issue";
  return "codeflowmu_issue";
}

function issueBranchFromDraftPath(draftRel: string): PromotionBranchName {
  if (draftRel.includes("/task-drafts/")) return "task";
  const base = draftRel.split("/").pop() || "";
  if (base.startsWith("FCOP-ISSUE-DRAFT")) return "fcop_issue";
  if (base.startsWith("CODEFLOWMU-ISSUE-DRAFT")) return "codeflowmu_issue";
  return "codeflowmu_issue";
}

function legacyIssueBranchFromFlat(flat: Record<string, string>): "codeflowmu_issue" | "fcop_issue" {
  const file = flat.target_file || "";
  if (file.includes("FCOP-ISSUE-DRAFT")) return "fcop_issue";
  const repo = flat.target_repo || "";
  if (repo) return issueBranchFromRepo(repo);
  if (file.includes("CODEFLOWMU-ISSUE-DRAFT")) return "codeflowmu_issue";
  return "codeflowmu_issue";
}

function legacyIssueMirror(
  codeflowmu: EvalPromotionBranch,
  fcop: EvalPromotionBranch,
  legacyIssue: EvalPromotionBranch,
): EvalPromotionBranch {
  if (issueBranchBlocksPromotion(fcop)) return fcop;
  if (issueBranchBlocksPromotion(codeflowmu)) return codeflowmu;
  if (legacyIssue.status || legacyIssue.target_file) return legacyIssue;
  return EMPTY_BRANCH();
}

function branchToTaskButton(branch: EvalPromotionBranch): EvalPromotionButtonState {
  return {
    promoted: taskBranchBlocksPromotion(branch),
    target_file: branch.target_file ?? "",
  };
}

function branchToIssueButton(branch: EvalPromotionBranch): EvalPromotionButtonState {
  return {
    promoted: issueBranchBlocksPromotion(branch),
    target_file: branch.target_file ?? "",
  };
}

export type EvalPromoteClassification = "observation_only" | "actionable_gap" | "unknown";

export type EvalTaskPromotionGate = {
  allowed: boolean;
  reasons: string[];
  classification: EvalPromoteClassification;
  existing_task_id?: string;
  existing_task_file?: string;
};

export const EVAL_TASK_PROMOTE_GATE_PREFIX = "EVAL 不满足本地任务晋升条件";

function normalizePromoVal(raw: string): string {
  const v = raw.replace(/^["']|["']$/g, "").trim();
  return v === "null" ? "" : v;
}

function parseFlatFrontmatter(fmText: string): Record<string, string> {
  const fm: Record<string, string> = {};
  let inPromotion = false;
  for (const line of fmText.split("\n")) {
    if (/^promotion:\s*$/.test(line)) {
      inPromotion = true;
      continue;
    }
    if (inPromotion) {
      if (/^\s{2}(task|issue|codeflowmu_issue|fcop_issue|targets):\s*$/.test(line)) continue;
      if (/^\s{4}\w[\w_-]*:/.test(line)) continue;
      if (/^\s{2}\w[\w_-]*:/.test(line)) continue;
      if (/^\S/.test(line)) inPromotion = false;
      else continue;
    }
    const kv = line.match(/^(\w[\w_-]*):\s*(.+)/);
    if (kv) fm[kv[1]!] = normalizePromoVal(kv[2]!);
  }
  return fm;
}

function branchFromRecord(rec: Record<string, string>): EvalPromotionBranch {
  return {
    status: rec.status ?? "",
    target_type: rec.target_type ?? "",
    target_file: rec.target_file ?? "",
    target_repo: rec.target_repo ?? "",
    planned_inbox_path: rec.planned_inbox_path ?? "",
    github_url: rec.github_url ?? "",
    github_status: rec.github_status ?? "",
    promoted_at: rec.promoted_at ?? "",
    promoted_by: rec.promoted_by ?? "",
    draft_created_at: rec.draft_created_at ?? "",
    submitted_at: rec.submitted_at ?? "",
    admin_approved: rec.admin_approved ?? "",
    action: rec.action ?? "",
    reviewed_by: rec.reviewed_by ?? "",
  };
}

function applyLegacyFlatToBranches(
  flat: Record<string, string>,
  task: Record<string, string>,
  codeflowmu_issue: Record<string, string>,
  fcop_issue: Record<string, string>,
): void {
  const st = (flat.status || "").toLowerCase();
  const tt = (flat.target_type || "").toLowerCase();
  if (
    Object.keys(task).length ||
    Object.keys(codeflowmu_issue).length ||
    Object.keys(fcop_issue).length
  ) {
    return;
  }
  if (!st && !tt && !flat.target_file) return;

  if (tt === "task") {
    Object.assign(task, flat);
    task.status = "promoted";
    return;
  }
  if (tt === "local_task_draft") {
    Object.assign(task, flat);
    if (st === "promoted" || st === "draft_created") {
      task.status = "draft_created";
    }
    return;
  }
  if (tt === "github_issue_draft") {
    const target = legacyIssueBranchFromFlat(flat);
    const issueRec = target === "fcop_issue" ? fcop_issue : codeflowmu_issue;
    Object.assign(issueRec, flat);
    issueRec.status = "promoted";
    return;
  }
  if (tt === "github_issue" && st === "submitted") {
    const target = legacyIssueBranchFromFlat(flat);
    const issueRec = target === "fcop_issue" ? fcop_issue : codeflowmu_issue;
    Object.assign(issueRec, flat);
    issueRec.status = "submitted";
  }
}

function promotionIsIssueDraftFromBranch(issue: EvalPromotionBranch): boolean {
  const st = (issue.status || "").toLowerCase();
  const tt = (issue.target_type || "").toLowerCase();
  if (st === "draft_created" && tt === "github_issue_draft") return true;
  return st === "promoted" && tt === "github_issue_draft";
}

function promotionIsIssueDraftFromBranches(
  _task: EvalPromotionBranch,
  issue: EvalPromotionBranch,
): boolean {
  return promotionIsIssueDraftFromBranch(issue);
}

function promotionIsLocalTaskDraftFromBranches(
  task: EvalPromotionBranch,
  _issue: EvalPromotionBranch,
): boolean {
  const st = (task.status || "").toLowerCase();
  const tt = (task.target_type || "").toLowerCase();
  if (st === "draft_created" && tt === "local_task_draft") return true;
  return st === "promoted" && tt === "local_task_draft";
}

function taskBranchBlocksPromotion(task: EvalPromotionBranch): boolean {
  const st = (task.status || "").toLowerCase();
  if (st === "promoted" || st === "draft_created") return true;
  return false;
}

function issueBranchBlocksPromotion(issue: EvalPromotionBranch): boolean {
  const st = (issue.status || "").toLowerCase();
  if (st === "promoted" || st === "draft_created" || st === "submitted") return true;
  return false;
}

export function assertTaskNotYetPromoted(promotion: EvalPromotionState, rel: string): void {
  const task = promotion.task ?? EMPTY_BRANCH();
  if (taskBranchBlocksPromotion(task)) {
    const target = task.target_file || task.planned_inbox_path || "—";
    throw new Error(`该 EVAL 已生成本地任务（${target}），不可重复操作: ${rel}`);
  }
}

export function assertActionNotYetPromoted(
  promotion: EvalPromotionState,
  action: EvalPromotionAction,
  rel: string,
): void {
  if (action === "task") {
    assertTaskNotYetPromoted(promotion, rel);
    return;
  }
  const branch =
    action === "fcop_issue"
      ? (promotion.fcop_issue ?? EMPTY_BRANCH())
      : (promotion.codeflowmu_issue ?? EMPTY_BRANCH());
  if (issueBranchBlocksPromotion(branch)) {
    const target = branch.target_file || branch.target_repo || "—";
    throw new Error(`该 EVAL 已生成 Issue 草稿（${target}），不可重复操作: ${rel}`);
  }
}

export function assertIssueNotYetPromoted(
  promotion: EvalPromotionState,
  rel: string,
  targetRepo?: string,
): void {
  const action: EvalPromotionAction =
    targetRepo && issueBranchFromRepo(targetRepo) === "fcop_issue"
      ? "fcop_issue"
      : "codeflowmu_issue";
  assertActionNotYetPromoted(promotion, action, rel);
}

function assertNotYetIssueDraft(
  promotion: EvalPromotionState,
  rel: string,
  action: EvalPromotionAction,
): void {
  assertActionNotYetPromoted(promotion, action, rel);
}

function assertNotYetTaskDraft(promotion: EvalPromotionState, rel: string): void {
  assertActionNotYetPromoted(promotion, "task", rel);
}

function evalPromotionActionToBranchName(action: EvalPromotionAction): PromotionBranchName {
  if (action === "task") return "task";
  if (action === "fcop_issue") return "fcop_issue";
  return "codeflowmu_issue";
}

function buildLegacyFlatSummary(
  task: EvalPromotionBranch,
  codeflowmu_issue: EvalPromotionBranch,
  fcop_issue: EvalPromotionBranch,
  flat: Record<string, string>,
): Pick<
  EvalPromotionState,
  "status" | "action" | "target_type" | "target_file" | "target_repo" | "github_url" | "github_status" | "admin_approved"
> {
  const issueMirror = legacyIssueMirror(codeflowmu_issue, fcop_issue, EMPTY_BRANCH());
  const activeDraft = promotionIsLocalTaskDraftFromBranches(task, issueMirror)
    ? task
    : promotionIsIssueDraftFromBranches(task, codeflowmu_issue)
      ? codeflowmu_issue
      : promotionIsIssueDraftFromBranches(task, fcop_issue)
        ? fcop_issue
        : null;
  if (activeDraft?.status) {
    return {
      status: activeDraft.status,
      action: activeDraft.action ?? "",
      target_type: activeDraft.target_type ?? "",
      target_file: activeDraft.target_file,
      target_repo: activeDraft.target_repo ?? "",
      github_url: activeDraft.github_url,
      github_status: activeDraft.github_status,
      admin_approved: activeDraft.admin_approved,
    };
  }
  if (task.status === "promoted" && task.target_file) {
    return {
      status: task.status,
      action: task.action ?? "",
      target_type: task.target_type || "task",
      target_file: task.target_file,
      target_repo: "",
      github_url: "",
      github_status: "",
      admin_approved: task.admin_approved,
    };
  }
  for (const issue of [codeflowmu_issue, fcop_issue]) {
    if (issue.status === "submitted" && issue.target_file) {
      return {
        status: issue.status,
        action: issue.action ?? "",
        target_type: issue.target_type || "github_issue",
        target_file: issue.target_file,
        target_repo: issue.target_repo ?? "",
        github_url: issue.github_url,
        github_status: issue.github_status,
        admin_approved: issue.admin_approved,
      };
    }
  }
  const taskSt = (task.status || "").toLowerCase();
  const cfmSt = (codeflowmu_issue.status || "").toLowerCase();
  const fcopSt = (fcop_issue.status || "").toLowerCase();
  const taskPending = !taskSt || taskSt === "pending";
  const cfmPending = !cfmSt || cfmSt === "pending";
  const fcopPending = !fcopSt || fcopSt === "pending";
  if (
    taskPending &&
    cfmPending &&
    fcopPending &&
    !task.target_file &&
    !codeflowmu_issue.target_file &&
    !fcop_issue.target_file
  ) {
    return {
      status: "pending",
      action: "",
      target_type: "",
      target_file: "",
      target_repo: "",
      github_url: "",
      github_status: "",
      admin_approved: "",
    };
  }
  return {
    status: flat.status ?? "",
    action: flat.action ?? "",
    target_type: flat.target_type ?? "",
    target_file: flat.target_file ?? "",
    target_repo: flat.target_repo ?? "",
    github_url: flat.github_url ?? "",
    github_status: flat.github_status ?? "",
    admin_approved: flat.admin_approved ?? "",
  };
}

type PromotionParseBranch = "flat" | PromotionBranchName | "issue" | "legacy_issue";

function parsePromotionRaw(fmText: string): {
  flat: Record<string, string>;
  task: Record<string, string>;
  codeflowmu_issue: Record<string, string>;
  fcop_issue: Record<string, string>;
  legacy_issue: Record<string, string>;
  hasBranchSyntax: boolean;
} {
  const flat: Record<string, string> = {};
  const task: Record<string, string> = {};
  const codeflowmu_issue: Record<string, string> = {};
  const fcop_issue: Record<string, string> = {};
  const legacy_issue: Record<string, string> = {};
  let inPromo = false;
  let branch: PromotionParseBranch = "flat";
  let hasBranchSyntax = false;

  for (const line of fmText.split("\n")) {
    if (/^promotion:\s*$/.test(line)) {
      inPromo = true;
      branch = "flat";
      continue;
    }
    if (!inPromo) continue;
    if (/^\S/.test(line) && !/^\s/.test(line)) break;

    const branchHead = line.match(/^\s{2}(task|issue|codeflowmu_issue|fcop_issue):\s*$/);
    if (branchHead) {
      const name = branchHead[1]!;
      branch = name === "issue" ? "legacy_issue" : (name as PromotionBranchName);
      hasBranchSyntax = true;
      continue;
    }

    const nested = line.match(/^\s{4}(\w[\w_-]*):\s*(.*)$/);
    if (nested && branch !== "flat") {
      const target =
        branch === "task"
          ? task
          : branch === "codeflowmu_issue"
            ? codeflowmu_issue
            : branch === "fcop_issue"
              ? fcop_issue
              : legacy_issue;
      target[nested[1]!] = normalizePromoVal(nested[2]!);
      continue;
    }

    const sub = line.match(/^\s{2}(\w[\w_-]*):\s*(.*)$/);
    if (sub && branch === "flat") {
      flat[sub[1]!] = normalizePromoVal(sub[2]!);
    }
  }

  if (Object.keys(legacy_issue).length && !Object.keys(codeflowmu_issue).length && !Object.keys(fcop_issue).length) {
    const target = legacyIssueBranchFromFlat(legacy_issue);
    Object.assign(target === "fcop_issue" ? fcop_issue : codeflowmu_issue, legacy_issue);
  }

  applyLegacyFlatToBranches(flat, task, codeflowmu_issue, fcop_issue);
  return { flat, task, codeflowmu_issue, fcop_issue, legacy_issue, hasBranchSyntax };
}

export function parsePromotionBlock(fmText: string): EvalPromotionState {
  const {
    flat,
    task: taskRec,
    codeflowmu_issue: cfmRec,
    fcop_issue: fcopRec,
    legacy_issue: legacyIssueRec,
    hasBranchSyntax,
  } = parsePromotionRaw(fmText);
  const task = branchFromRecord(taskRec);
  const codeflowmu_issue = branchFromRecord(cfmRec);
  const fcop_issue = branchFromRecord(fcopRec);
  const legacyIssueBranch = branchFromRecord(legacyIssueRec);
  const issue = legacyIssueMirror(codeflowmu_issue, fcop_issue, legacyIssueBranch);
  const summary = buildLegacyFlatSummary(task, codeflowmu_issue, fcop_issue, flat);
  const hasFlat = Boolean(flat.status || flat.target_file || flat.target_type);
  return {
    ...summary,
    task,
    codeflowmu_issue,
    fcop_issue,
    issue,
    legacy_flat: hasFlat && !hasBranchSyntax,
  };
}

/** 解析 EVAL 文件 frontmatter（扁平字段 + 嵌套 promotion:） */
export function parseEvalFileMetadata(raw: string): {
  flat: Record<string, string>;
  promotion: EvalPromotionState;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return { flat: {}, promotion: parsePromotionBlock("") };
  const fmText = match[1]!;
  return { flat: parseFlatFrontmatter(fmText), promotion: parsePromotionBlock(fmText) };
}

export function parseEvalFrontmatter(raw: string): Record<string, string> {
  return parseEvalFileMetadata(raw).flat;
}

function promotionIsIssueDraft(promotion: EvalPromotionState): boolean {
  if (promotionIsIssueDraftFromBranch(promotion.codeflowmu_issue ?? EMPTY_BRANCH())) return true;
  if (promotionIsIssueDraftFromBranch(promotion.fcop_issue ?? EMPTY_BRANCH())) return true;
  return promotionIsIssueDraftFromBranches(EMPTY_BRANCH(), promotion.issue ?? EMPTY_BRANCH());
}

function promotionIsLocalTaskDraft(promotion: EvalPromotionState): boolean {
  return promotionIsLocalTaskDraftFromBranches(promotion.task ?? EMPTY_BRANCH(), EMPTY_BRANCH());
}

function promotionIssueBranchRecords(promotion: EvalPromotionState): {
  task: Record<string, string>;
  codeflowmu_issue: Record<string, string>;
  fcop_issue: Record<string, string>;
} {
  return {
    task: branchToRecord(promotion.task ?? EMPTY_BRANCH()),
    codeflowmu_issue: branchToRecord(promotion.codeflowmu_issue ?? EMPTY_BRANCH()),
    fcop_issue: branchToRecord(promotion.fcop_issue ?? EMPTY_BRANCH()),
  };
}

const PROMOTION_BRANCH_KEYS = [
  "status",
  "target_type",
  "target_file",
  "target_repo",
  "planned_inbox_path",
  "github_url",
  "github_status",
  "promoted_at",
  "promoted_by",
  "draft_created_at",
  "submitted_at",
  "admin_approved",
  "action",
  "reviewed_by",
] as const;

function branchToRecord(branch: EvalPromotionBranch): Record<string, string> {
  const rec: Record<string, string> = {};
  for (const k of PROMOTION_BRANCH_KEYS) {
    const v = branch[k as keyof EvalPromotionBranch];
    if (v !== undefined && v !== "") rec[k] = v;
  }
  return rec;
}

function mergeEvalPromotionBranch(
  evalAbsPath: string,
  branchName: PromotionBranchName,
  patch: Record<string, string>,
): void {
  const raw = readFileSync(evalAbsPath, "utf-8");
  const { promotion } = parseEvalFileMetadata(raw);
  const recs = promotionIssueBranchRecords(promotion);
  Object.assign(recs[branchName], patch);
  writeEvalWithPromotion(evalAbsPath, serializePromotionBranches(recs));
}

function resetEvalPromotionBranch(evalAbsPath: string, branchName: PromotionBranchName): void {
  const raw = readFileSync(evalAbsPath, "utf-8");
  const { promotion } = parseEvalFileMetadata(raw);
  const recs = promotionIssueBranchRecords(promotion);
  recs[branchName] = { status: "pending" };
  writeEvalWithPromotion(evalAbsPath, serializePromotionBranches(recs));
}

function promotionBranchNameForDraftPath(draftRel: string): PromotionBranchName {
  return issueBranchFromDraftPath(draftRel);
}

function branchRecordToLines(name: PromotionBranchName, rec: Record<string, string>): string[] {
  const keys = PROMOTION_BRANCH_KEYS.filter((k) => {
    const v = rec[k];
    return v !== undefined && v !== "";
  });
  if (!keys.length) return [];
  const lines = [`  ${name}:`];
  for (const k of keys) lines.push(`    ${k}: ${rec[k]!}`);
  return lines;
}

function serializePromotionBranches(recs: {
  task: Record<string, string>;
  codeflowmu_issue: Record<string, string>;
  fcop_issue: Record<string, string>;
}): string[] {
  const taskRec = Object.keys(recs.task).length ? recs.task : { status: "pending" };
  const cfmRec = Object.keys(recs.codeflowmu_issue).length
    ? recs.codeflowmu_issue
    : { status: "pending" };
  const fcopRec = Object.keys(recs.fcop_issue).length ? recs.fcop_issue : { status: "pending" };
  return [
    "  status: pending",
    ...branchRecordToLines("task", taskRec),
    ...branchRecordToLines("codeflowmu_issue", cfmRec),
    ...branchRecordToLines("fcop_issue", fcopRec),
  ];
}

const PENDING_PROMOTION_LINES = [
  "  status: pending",
  "  task:",
  "    status: pending",
  "  codeflowmu_issue:",
  "    status: pending",
  "  fcop_issue:",
  "    status: pending",
];

function resolveIssueDraftBranch(
  promotion: EvalPromotionState,
  rel: string,
  draftRelPath?: string,
): { branch: "codeflowmu_issue" | "fcop_issue"; data: EvalPromotionBranch } {
  if (draftRelPath) {
    const branchName = issueBranchFromDraftPath(draftRelPath);
    if (branchName === "task") {
      throw new Error(`draftRelPath 不是 Issue 草稿: ${draftRelPath}`);
    }
    const data = promotion[branchName] ?? EMPTY_BRANCH();
    const file = data.target_file || "";
    if (file && file !== draftRelPath) {
      throw new Error(
        `draftRelPath 与 promotion.${branchName}.target_file 不一致: ${draftRelPath}`,
      );
    }
    return { branch: branchName, data };
  }

  const cfm = promotion.codeflowmu_issue ?? EMPTY_BRANCH();
  const fcop = promotion.fcop_issue ?? EMPTY_BRANCH();
  const cfmDraft = promotionIsIssueDraftFromBranch(cfm);
  const fcopDraft = promotionIsIssueDraftFromBranch(fcop);
  if (cfmDraft && fcopDraft) {
    throw new Error(
      `该 EVAL 同时存在 codeflowmu_issue 与 fcop_issue 草稿，提交时请指定 draftRelPath: ${rel}`,
    );
  }
  if (cfmDraft) return { branch: "codeflowmu_issue", data: cfm };
  if (fcopDraft) return { branch: "fcop_issue", data: fcop };
  if (promotionIsIssueDraftFromBranch(promotion.issue ?? EMPTY_BRANCH())) {
    const legacy = promotion.issue ?? EMPTY_BRANCH();
    return {
      branch: legacyIssueBranchFromFlat({
        target_file: legacy.target_file ?? "",
        target_repo: legacy.target_repo ?? "",
        target_type: legacy.target_type ?? "",
      }),
      data: legacy,
    };
  }
  throw new Error(`该 EVAL 无待提交的 Issue 草稿: ${rel}`);
}

export function defaultGhIssueCreate(repo: string, title: string, bodyFile: string): string {
  const out = execFileSync(
    "gh",
    ["issue", "create", "--repo", repo, "--title", title, "--body-file", bodyFile],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const urls = String(out)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^https:\/\/github\.com\/.+\/issues\/\d+/.test(l));
  if (!urls.length) {
    throw new Error(`gh issue create 未返回 Issue URL；输出: ${String(out).slice(0, 500)}`);
  }
  return urls[urls.length - 1]!;
}

function splitEvalFile(raw: string): { frontmatter: string; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: "", body: raw };
  return { frontmatter: match[1]!, body: match[2]! };
}

function upsertPromotionBlock(frontmatter: string, promotionLines: string[]): string {
  const lines = frontmatter.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^promotion:\s*$/.test(line) || /^promotion:\s+\S/.test(line)) {
      while (i < lines.length && (/^\s/.test(lines[i]!) || /^promotion:/.test(lines[i]!))) {
        i++;
      }
      continue;
    }
    out.push(line);
    i++;
  }
  out.push("promotion:");
  for (const pl of promotionLines) out.push(pl);
  return out.join("\n");
}

function upsertDraftFrontmatter(
  frontmatter: string,
  updates: Record<string, string>,
): string {
  const lines = frontmatter.split("\n");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m && Object.prototype.hasOwnProperty.call(updates, m[1]!)) {
      out.push(`${m[1]}: ${updates[m[1]!]}`);
      seen.add(m[1]!);
    } else {
      out.push(line);
    }
  }
  for (const [key, val] of Object.entries(updates)) {
    if (!seen.has(key)) out.push(`${key}: ${val}`);
  }
  return out.join("\n");
}

function writeEvalWithPromotion(
  evalAbsPath: string,
  promotionLines: string[],
): void {
  const raw = readFileSync(evalAbsPath, "utf-8");
  const { frontmatter, body } = splitEvalFile(raw);
  const newFm = upsertPromotionBlock(frontmatter, promotionLines);
  writeFileSync(evalAbsPath, `---\n${newFm}\n---\n\n${body.replace(/^\n+/, "")}`, "utf-8");
}

function sanitizeWarnings(text: string): string[] {
  const warnings = new Set<string>();
  for (const { re, msg } of SENSITIVE_PATTERNS) {
    if (re.test(text)) warnings.add(msg);
    re.lastIndex = 0;
  }
  return [...warnings];
}

function extractTitle(body: string, filename: string): string {
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1?.[1]) return h1[1].replace(/^CodeFlowMu\s*·\s*/i, "").trim();
  const base = filename.replace(/\.md$/i, "");
  return base.replace(/^(OBSERVATION|AUDIT|GAP|RISK|GOVERNANCE|EMERGENCE)-\d{8}-\d{3}-?/i, "").replace(/-/g, " ").trim() || base;
}

function extractSection(
  body: string,
  headings: string[],
  opts?: { allowBodyFallback?: boolean },
): string {
  const normalized = body.replace(/\r\n/g, "\n");
  for (const h of headings) {
    const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Require newline after heading — otherwise `(?=^##|$)` matches at EOL and captures empty.
    const re = new RegExp(
      `^##\\s+${escaped}\\s*\\n+([\\s\\S]*?)(?=\\n##\\s+|$)`,
      "m",
    );
    const m = normalized.match(re);
    if (m?.[1]?.trim()) return m[1].trim().slice(0, 4000);
  }
  if (opts?.allowBodyFallback === false) return "";
  const summary = body.match(/^##\s+执行摘要\s*$/m);
  if (summary) {
    const idx = body.indexOf(summary[0]!);
    const rest = body.slice(idx + summary[0]!.length, idx + summary[0]!.length + 2500);
    if (rest.trim()) return rest.trim();
  }
  return body.trim().slice(0, 1500);
}

function evalRelPath(projectRoot: string, evalRelPathInput: string): string {
  const norm = evalRelPathInput.replace(/\\/g, "/").replace(/^\/+/, "");
  if (norm.startsWith("fcop/internal/eval/")) return norm;
  return `fcop/internal/eval/${norm.replace(/^.*\//, "")}`;
}

function evalAbsPath(projectRoot: string, rel: string): string {
  return join(projectRoot, ...rel.split("/"));
}

function nextDraftSeq(draftsDir: string, prefix: string, date: string): string {
  mkdirSync(draftsDir, { recursive: true });
  let max = 0;
  if (existsSync(draftsDir)) {
    for (const f of readdirSync(draftsDir)) {
      const m = f.match(new RegExp(`^${prefix}-${date}-(\\d{3})\\.md$`, "i"));
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return String(max + 1).padStart(3, "0");
}

function inferPriority(fm: Record<string, string>, body: string): string {
  if (fm.severity && /^P[0-3]$/i.test(fm.severity)) return fm.severity.toUpperCase();
  if (/\bP0\b/.test(body)) return "P0";
  if (/\bP1\b/.test(body)) return "P1";
  return "P1";
}

/** 剥离 internal-only 声明与旁路观察语义，避免晋升时原样复制进 TASK。 */
export function stripInternalEvalMarkers(body: string): string {
  let out = body;
  out = out.replace(/^>\s*⚠️[\s\S]*?(?=\r?\n\r?\n)/m, "");
  out = out.replace(/^>\s*\*\*INTERNAL ONLY[\s\S]*?(?=\r?\n\r?\n)/im, "");
  const lines = out.split("\n").filter((line) => {
    if (/INTERNAL\s+ONLY/i.test(line)) return false;
    if (/DO\s+NOT\s+EXTERNALIZE/i.test(line)) return false;
    if (/旁路观察/.test(line)) return false;
    if (/不驱动\s*lifecycle/i.test(line)) return false;
    return true;
  });
  return lines.join("\n").trim();
}

function containsForbiddenPromoteMarkers(text: string): boolean {
  return (
    /INTERNAL\s+ONLY/i.test(text) ||
    /DO\s+NOT\s+EXTERNALIZE/i.test(text) ||
    /旁路观察/.test(text) ||
    /不驱动\s*lifecycle/i.test(text)
  );
}

function isSubstantiveSectionText(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 15) return false;
  if (/^（见\s*source_eval/i.test(t)) return false;
  if (/^待\s*ADMIN/i.test(t)) return false;
  if (/^[-*]\s+\S/m.test(t)) return true;
  return t.length >= 40;
}

function isPanelScanEval(filename: string, body: string, fm: Record<string, string>): boolean {
  if (/panel-scan/i.test(filename)) return true;
  if (/EVAL\s*观察（panel-scan）/i.test(body)) return true;
  if (fm.subject && /panel-scan|面板扫描/i.test(fm.subject)) return true;
  return false;
}

function isSandboxProbeOnlyEval(body: string): boolean {
  const probeHints = /_sandbox\/mcp-tool-probe|mcp-tool-probe|sandbox\s*\/\s*probe|probe-only/i.test(
    body,
  );
  if (!probeHints) return false;
  const fixScope = extractFixScope(body);
  if (!fixScope) return true;
  if (/probe|sandbox|工具探测|扫描矩阵/i.test(fixScope) && fixScope.length < 160) return true;
  return false;
}

function isControlledEmergenceOnlyEval(body: string): boolean {
  const hasEmergence = /受控涌现|controlled_emergence|CONTROLLED\s*EMERGENCE/i.test(body);
  if (!hasEmergence) return false;
  const fixScope = extractFixScope(body);
  const acceptance = extractAcceptanceCriteria(body);
  return !isSubstantiveSectionText(fixScope) || !isSubstantiveSectionText(acceptance);
}

function extractProblemSummary(body: string): string {
  return extractSection(body, [
    "问题",
    "4\\. 发现问题",
    "发现问题",
    "执行摘要",
    "1\\. 结论",
    "结论",
  ]);
}

function extractFixScope(body: string): string {
  return extractSection(
    body,
    [
      "修复范围",
      "9\\. 建议动作",
      "建议动作",
      "Fix scope",
      "Scope",
    ],
    { allowBodyFallback: false },
  );
}

function extractAcceptanceCriteria(body: string): string {
  return extractSection(
    body,
    [
      "验收标准",
      "10\\. 验证计划",
      "验证计划",
      "Acceptance",
      "验收",
    ],
    { allowBodyFallback: false },
  );
}

function lifecycleRelFromAbs(projectRoot: string, absPath: string): string {
  const v3 = fcopV3Paths(projectRoot);
  const normAbs = absPath.replace(/\\/g, "/");
  const stages: [string, string][] = [
    [v3.inbox.replace(/\\/g, "/"), "inbox"],
    [v3.active.replace(/\\/g, "/"), "active"],
    [v3.review.replace(/\\/g, "/"), "review"],
    [v3.done.replace(/\\/g, "/"), "done"],
    [v3.archive.replace(/\\/g, "/"), "archive"],
  ];
  const name = absPath.split(/[/\\]/).pop() || "";
  for (const [dir, stage] of stages) {
    if (normAbs.startsWith(dir + "/") || normAbs === dir + "/" + name) {
      return `fcop/_lifecycle/${stage}/${name}`;
    }
  }
  return normAbs.replace(projectRoot.replace(/\\/g, "/"), "").replace(/^[/\\]/, "");
}

/** 扫描 lifecycle TASK frontmatter 的 source_eval，用于去重。 */
export function findTaskBySourceEval(
  projectRoot: string,
  evalRel: string,
): { task_id: string; task_file: string } | null {
  const norm = evalRel.replace(/\\/g, "/").replace(/^\/+/, "");
  const v3 = fcopV3Paths(projectRoot);
  for (const dir of fcopV3TaskSearchDirs(v3)) {
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith("TASK-") || !name.endsWith(".md")) continue;
      const abs = join(dir, name);
      const raw = readFileSync(abs, "utf-8");
      const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!match?.[1]) continue;
      const fm = parseFlatFrontmatter(match[1]);
      const src = (fm.source_eval || "").replace(/\\/g, "/").replace(/^\/+/, "");
      if (src !== norm) continue;
      const taskId = fm.task_id || name.replace(/\.md$/i, "");
      return {
        task_id: taskId,
        task_file: lifecycleRelFromAbs(projectRoot, abs),
      };
    }
  }
  return null;
}

/** 晋升门禁：先判定、再改写、再生成。 */
export function canPromoteEvalToTask(
  projectRoot: string,
  evalRelPathInput: string,
): EvalTaskPromotionGate {
  const reasons: string[] = [];
  const rel = evalRelPath(projectRoot, evalRelPathInput);
  const abs = evalAbsPath(projectRoot, rel);
  if (!existsSync(abs)) {
    return {
      allowed: false,
      reasons: [`EVAL 文件不存在: ${rel}`],
      classification: "unknown",
    };
  }

  const existing = findTaskBySourceEval(projectRoot, rel);
  if (existing) {
    return {
      allowed: false,
      reasons: [`同 source_eval 已存在 lifecycle 任务: ${existing.task_id}`],
      classification: "actionable_gap",
      existing_task_id: existing.task_id,
      existing_task_file: existing.task_file,
    };
  }

  const raw = readFileSync(abs, "utf-8");
  const { flat: fm } = parseEvalFileMetadata(raw);
  const { body: rawBody } = splitEvalFile(raw);
  const body = stripInternalEvalMarkers(rawBody);
  const filename = rel.split("/").pop()!;

  let classification: EvalPromoteClassification = "unknown";

  if (isPanelScanEval(filename, body, fm)) {
    classification = "observation_only";
    reasons.push("panel-scan 类观察：仅扫描摘要，不可晋升 lifecycle 任务");
  }

  const evalType = (fm.eval_type || "").toLowerCase();
  if (evalType === "observation") {
    classification = "observation_only";
    reasons.push("eval_type 为 observation：仅观察，不可晋升 lifecycle 任务");
  }

  if (/九类资产分析矩阵|九类资产.*扫描/i.test(body) && isPanelScanEval(filename, body, fm)) {
    reasons.push("纯九类资产矩阵扫描摘要，非 actionable gap");
  }

  if (isSandboxProbeOnlyEval(body)) {
    classification = "observation_only";
    reasons.push("sandbox/probe 上下文为主，非可执行修复缺口");
  }

  if (isControlledEmergenceOnlyEval(body)) {
    classification = "observation_only";
    reasons.push("受控涌现观察为主，缺少可执行修复范围与验收标准");
  }

  if (containsForbiddenPromoteMarkers(rawBody)) {
    reasons.push("正文含 internal-only / 旁路观察等标记，须改写后再晋升");
  }

  const problem = extractProblemSummary(body);
  if (!isSubstantiveSectionText(problem)) {
    reasons.push("缺少明确的问题摘要（须可独立理解，不可回落为「见 source_eval」）");
  }

  const fixScope = extractFixScope(body);
  if (!isSubstantiveSectionText(fixScope)) {
    reasons.push("缺少明确的修复范围");
  }

  const acceptance = extractAcceptanceCriteria(body);
  if (!isSubstantiveSectionText(acceptance)) {
    reasons.push("缺少明确的验收标准");
  }

  if (reasons.length === 0) {
    return { allowed: true, reasons: [], classification: "actionable_gap" };
  }

  if (classification === "unknown") {
    const obsHint = /观察|observation|扫描|涌现|probe|sandbox/i;
    classification = reasons.some((r) => obsHint.test(r))
      ? "observation_only"
      : "actionable_gap";
  }

  return { allowed: false, reasons, classification };
}

function assertCanPromoteEvalToTask(projectRoot: string, evalRel: string): EvalTaskPromotionGate {
  const gate = canPromoteEvalToTask(projectRoot, evalRel);
  if (!gate.allowed) {
    throw new Error(`${EVAL_TASK_PROMOTE_GATE_PREFIX}: ${gate.reasons.join("；")}`);
  }
  return gate;
}

const TASK_HIGH_RISK_KEYWORD_RULES: ReadonlyArray<{ flag: string; pattern: RegExp }> = [
  { flag: "delete", pattern: /\bdelete\b/i },
  { flag: "remove", pattern: /\bremove\b/i },
  { flag: "archive", pattern: /\barchive\b/i },
  { flag: "bulk", pattern: /\bbulk\b/i },
  { flag: "history", pattern: /\bhistory\b/i },
  { flag: "redeploy", pattern: /\bredeploy\b/i },
  { flag: "init_project", pattern: /\binit_project\b/i },
  { flag: "mark_human_approved", pattern: /\bmark_human_approved\b/i },
  { flag: "approve_task", pattern: /\bapprove_task\b/i },
  { flag: "reject_task", pattern: /\breject_task\b/i },
  { flag: "archive_task", pattern: /\barchive_task\b/i },
  { flag: "token", pattern: /\btoken\b/i },
  { flag: "api_key", pattern: /api[\s_-]?key/i },
  { flag: "env_file", pattern: /\.env\b/i },
  { flag: "github", pattern: /\bgithub\b/i },
  { flag: "publish", pattern: /\bpublish\b/i },
  { flag: "protocol", pattern: /\bprotocol\b/i },
  { flag: "rules", pattern: /\brules\b/i },
  { flag: "role_template", pattern: /role[\s_-]?template/i },
  { flag: "ledger", pattern: /\bledger\b/i },
  { flag: "internal_eval", pattern: /internal\/eval/i },
];

export function scanEvalTaskRisk(text: string): {
  highRisk: boolean;
  riskFlags: string[];
  riskLevel: "review_required" | "high";
} {
  const riskFlags: string[] = [];
  for (const rule of TASK_HIGH_RISK_KEYWORD_RULES) {
    if (rule.pattern.test(text) && !riskFlags.includes(rule.flag)) {
      riskFlags.push(rule.flag);
    }
  }
  return {
    highRisk: riskFlags.length > 0,
    riskFlags,
    riskLevel: riskFlags.length > 0 ? "high" : "review_required",
  };
}

function buildEvalTaskRiskPreamble(highRisk: boolean): string[] {
  if (highRisk) {
    return [
      "> 🔴 高风险自动任务草稿",
      ">",
      "> 检测到高风险关键词，PM 不得直接执行。需 ADMIN 明确确认后再派发。",
      "",
    ];
  }
  return [
    "> ⚠️ 自动生成任务草稿",
    ">",
    "> 本任务由 EVAL 内部观察自动转写生成，尚未代表 ADMIN 已确认执行。",
    "> PM 执行前必须先确认：",
    ">",
    "> - 是否确实需要进入正式任务流；",
    "> - 是否包含内部观察材料、私有日志、路径或任务正文；",
    "> - 是否应改为 Issue 草稿而不是本地执行任务；",
    "> - 是否涉及高风险操作。",
    "",
    "## 高风险操作检查",
    "",
    "- [ ] 不涉及删除 / 归档 / 批量移动文件",
    "- [ ] 不涉及修改 FCoP 协议、规则、角色模板",
    "- [ ] 不涉及 GitHub 发布、提交、Issue/PR 自动创建",
    "- [ ] 不涉及凭据、环境变量、API Key、Token",
    "- [ ] 不涉及自动 approve / reject / archive / mark_human_approved",
    "- [ ] 不涉及清理 ledger / history / internal eval 资料",
    "",
  ];
}

function buildTaskBody(opts: {
  title: string;
  evalRel: string;
  problem: string;
  fixScope: string;
  acceptance: string;
  highRisk?: boolean;
}): string {
  const basename = opts.evalRel.split("/").pop() || opts.evalRel;
  return [
    ...buildEvalTaskRiskPreamble(Boolean(opts.highRisk)),
    `# ${opts.title}`,
    "",
    "## 来源",
    "",
    `EVAL 来源：${basename}`,
    "",
    `- source_eval: \`${opts.evalRel}\``,
    "",
    "## 问题",
    "",
    opts.problem,
    "",
    "## 修复范围",
    "",
    opts.fixScope,
    "",
    "## 验收标准",
    "",
    opts.acceptance,
    "",
    "## 禁止",
    "",
    "- 不修改 FCoP 正式协议",
    "- 不新增 adopted-pending 0003",
    "- 不改无关模块",
    "",
  ].join("\n");
}

function promoteEvalToIssueDraft(
  opts: PromoteEvalOptions,
  cfg: {
    prefix: string;
    targetRepo: string;
    action: EvalPromotionAction;
    whyRepo: string;
    targetLabel: string;
  },
): EvalPromotionResult {
  const rel = evalRelPath(opts.projectRoot, opts.evalRelPath);
  const abs = evalAbsPath(opts.projectRoot, rel);
  if (!existsSync(abs)) throw new Error(`EVAL 文件不存在: ${rel}`);

  const raw = readFileSync(abs, "utf-8");
  const { flat: fm, promotion } = parseEvalFileMetadata(raw);
  assertNotYetIssueDraft(promotion, rel, cfg.action);
  const { body } = splitEvalFile(raw);
  const filename = rel.split("/").pop()!;
  const title = extractTitle(body, filename);
  const problem = extractProblemSummary(body);
  const rawProposal = extractFixScope(stripInternalEvalMarkers(body));

  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const seq = nextDraftSeq(join(fcopInternalEvalDir(opts.projectRoot), "issue-drafts"), cfg.prefix, date);
  const draftFilename = `${cfg.prefix}-${date}-${seq}.md`;
  const draftRel = `fcop/internal/eval/issue-drafts/${draftFilename}`;
  const draftsDir = join(fcopInternalEvalDir(opts.projectRoot), "issue-drafts");
  const draftAbs = join(draftsDir, draftFilename);

  const githubReady = buildGithubReadyIssueBody({
    title,
    rawProblem: problem,
    whyRepo: cfg.whyRepo,
    targetLabel: cfg.targetLabel,
    rawProposal,
  });
  const forbiddenAfter = scanIssueBodyForForbiddenTerms(githubReady.body);
  const publicSafe = forbiddenAfter.length === 0;
  const redactionStatus = publicSafe ? "github_ready" : "unsafe_after_redaction";
  const warnings = sanitizeWarnings(githubReady.body);
  const created = new Date().toISOString().slice(0, 10);

  const content = [
    "---",
    "kind: github_issue_draft",
    "source: eval",
    `source_eval: ${rel}`,
    `target_repo: ${cfg.targetRepo}`,
    `public_candidate: ${publicSafe ? "true" : "false"}`,
    `public_safe: ${publicSafe ? "true" : "false"}`,
    "redacted: true",
    `redaction_status: ${redactionStatus}`,
    "status: draft",
    "admin_approved: false",
    `created_at: ${created}`,
    `task_id: ${fm.task_id ?? ""}`,
    `severity: ${inferPriority(fm, body)}`,
    "---",
    "",
    githubReady.body,
  ].join("\n");

  writeFileSync(draftAbs, content, "utf-8");

  const now = new Date().toISOString();
  const issueBranch = evalPromotionActionToBranchName(cfg.action);
  mergeEvalPromotionBranch(abs, issueBranch, {
    status: "promoted",
    target_type: "github_issue_draft",
    target_file: draftRel,
    target_repo: cfg.targetRepo,
    promoted_at: now,
    promoted_by: opts.promotedBy ?? "ADMIN",
    admin_approved: "false",
    reviewed_by: "",
    github_status: "draft",
  });

  return {
    ok: true,
    action: cfg.action,
    eval_rel_path: rel,
    target_file: draftRel,
    target_repo: cfg.targetRepo,
    filename: draftFilename,
    sanitize_warnings: [...warnings, ...githubReady.redactionReasons],
  };
}

export type PromoteEvalOptions = {
  projectRoot: string;
  adminInboxDir: string;
  evalRelPath: string;
  allocateTaskSeq: (dateYmd: string) => string;
  promotedBy?: string;
};

export function promoteEvalToLocalTask(opts: PromoteEvalOptions): EvalPromotionResult {
  const rel = evalRelPath(opts.projectRoot, opts.evalRelPath);
  const abs = evalAbsPath(opts.projectRoot, rel);
  if (!existsSync(abs)) throw new Error(`EVAL 文件不存在: ${rel}`);

  const raw = readFileSync(abs, "utf-8");
  const { flat: fm, promotion } = parseEvalFileMetadata(raw);
  assertNotYetTaskDraft(promotion, rel);
  assertCanPromoteEvalToTask(opts.projectRoot, rel);
  const { body } = splitEvalFile(raw);
  const sanitizedBody = stripInternalEvalMarkers(body);
  const filename = rel.split("/").pop()!;
  const title = extractTitle(sanitizedBody, filename);
  const problem = extractProblemSummary(sanitizedBody);
  const fixScope = extractFixScope(sanitizedBody);
  const acceptance = extractAcceptanceCriteria(sanitizedBody);
  const priority = inferPriority(fm, sanitizedBody);
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const seq = opts.allocateTaskSeq(date);
  const taskFilename = `TASK-${date}-${seq}-ADMIN-to-PM.md`;
  const taskRel = `fcop/_lifecycle/inbox/${taskFilename}`;
  const threadKey = `eval-promotion-${date}-${seq}`;

  const draftsDir = join(fcopInternalEvalDir(opts.projectRoot), "task-drafts");
  const draftSeq = nextDraftSeq(draftsDir, "TASK-DRAFT", date);
  const draftFilename = `TASK-DRAFT-${date}-${draftSeq}.md`;
  const draftRel = `fcop/internal/eval/task-drafts/${draftFilename}`;
  const draftAbs = join(draftsDir, draftFilename);

  const riskScan = scanEvalTaskRisk(`${problem}\n${fixScope}\n${acceptance}`);
  const taskBody = buildTaskBody({
    title,
    evalRel: rel,
    problem,
    fixScope,
    acceptance,
    highRisk: riskScan.highRisk,
  });
  if (containsForbiddenPromoteMarkers(taskBody)) {
    throw new Error(`${EVAL_TASK_PROMOTE_GATE_PREFIX}: 生成的任务正文含禁止标记`);
  }

  const riskFrontmatterLines = [
    "source_type: eval_promotion",
    "auto_generated: true",
    "risk_review_required: true",
    `risk_level: ${riskScan.riskLevel}`,
  ];
  if (riskScan.riskFlags.length > 0) {
    riskFrontmatterLines.push(`risk_flags: ${riskScan.riskFlags.join(",")}`);
  }

  const draftContent = [
    "---",
    "kind: local_task_draft",
    "status: draft",
    "admin_approved: false",
    "protocol: fcop",
    'version: "1"',
    `task_id: TASK-${date}-${seq}`,
    `planned_inbox_path: ${taskRel}`,
    "sender: ADMIN",
    "recipient: PM",
    `subject: ${title}`,
    `priority: ${priority}`,
    `thread_key: ${threadKey}`,
    `source_eval: ${rel}`,
    ...riskFrontmatterLines,
    `created_at: ${new Date().toISOString().slice(0, 10)}`,
    "---",
    "",
    taskBody,
  ].join("\n");

  writeFileSync(draftAbs, draftContent, "utf-8");

  const now = new Date().toISOString();
  mergeEvalPromotionBranch(abs, "task", {
    status: "draft_created",
    target_type: "local_task_draft",
    target_file: draftRel,
    planned_inbox_path: taskRel,
    draft_created_at: now,
    promoted_by: opts.promotedBy ?? "ADMIN",
    admin_approved: "false",
    reviewed_by: "",
  });

  return {
    ok: true,
    action: "task",
    eval_rel_path: rel,
    target_file: draftRel,
    filename: draftFilename,
    sanitize_warnings: [],
  };
}

export function promoteEvalToCodeflowMuIssueDraft(opts: PromoteEvalOptions): EvalPromotionResult {
  return promoteEvalToIssueDraft(opts, {
    prefix: "CODEFLOWMU-ISSUE-DRAFT",
    targetRepo: "joinwell52-AI/CodeFlowMu",
    action: "codeflowmu_issue",
    whyRepo:
      "该发现涉及 CodeFlowMu 产品实现（Panel、Runtime、ledger、初始化、宿主规则部署等），应由 CodeFlowMu 仓库跟踪。",
    targetLabel: "CodeFlowMu",
  });
}

export function promoteEvalToFcopIssueDraft(opts: PromoteEvalOptions): EvalPromotionResult {
  return promoteEvalToIssueDraft(opts, {
    prefix: "FCOP-ISSUE-DRAFT",
    targetRepo: "joinwell52-AI/FCoP",
    action: "fcop_issue",
    whyRepo:
      "该发现涉及 FCoP 通用协议、工具、规则或文档语义，应由 FCoP 公仓跟踪，而非 CodeFlowMu 宿主实现。",
    targetLabel: "FCoP",
  });
}

export type SubmitIssueDraftOptions = {
  projectRoot: string;
  evalRelPath: string;
  adminApproved: boolean;
  /** 指定要提交的 Issue 草稿路径；两个 issue 分支各有草稿时必须显式传入 */
  draftRelPath?: string;
  promotedBy?: string;
  createGithubIssue?: (repo: string, title: string, bodyFile: string) => string;
};

export function submitEvalIssueDraft(opts: SubmitIssueDraftOptions): SubmitIssueDraftResult {
  if (!opts.adminApproved) {
    throw new Error("提交 GitHub Issue 前须勾选 ADMIN 确认（admin_approved）");
  }

  const rel = evalRelPath(opts.projectRoot, opts.evalRelPath);
  const evalAbs = evalAbsPath(opts.projectRoot, rel);
  if (!existsSync(evalAbs)) throw new Error(`EVAL 文件不存在: ${rel}`);

  const evalRaw = readFileSync(evalAbs, "utf-8");
  const { promotion } = parseEvalFileMetadata(evalRaw);
  if (!promotionIsIssueDraft(promotion)) {
    const st =
      promotion.codeflowmu_issue?.status ||
      promotion.fcop_issue?.status ||
      promotion.issue?.status ||
      promotion.status ||
      "—";
    throw new Error(`该 EVAL 无待提交的 Issue 草稿（status=${st}）: ${rel}`);
  }
  const { branch: issueBranch, data: branchData } = resolveIssueDraftBranch(
    promotion,
    rel,
    opts.draftRelPath,
  );
  const draftRel = (opts.draftRelPath ?? "").trim() || branchData.target_file || promotion.target_file;
  const targetRepo = branchData.target_repo || promotion.target_repo;
  if (!draftRel || !targetRepo) {
    throw new Error(`EVAL promotion 缺少 target_file / target_repo: ${rel}`);
  }

  const draftAbs = join(opts.projectRoot, ...draftRel.split("/"));
  if (!existsSync(draftAbs)) throw new Error(`Issue 草稿不存在: ${draftRel}`);

  const draftRaw = readFileSync(draftAbs, "utf-8");
  const { frontmatter: draftFm, body: draftBody } = splitEvalFile(draftRaw);
  const draftMeta = parseFlatFrontmatter(draftFm);
  if ((draftMeta.status || "").toLowerCase() === "submitted") {
    throw new Error(`Issue 草稿已提交: ${draftRel}`);
  }

  const title = extractTitle(draftBody, draftRel.split("/").pop() || "issue.md");
  const create = opts.createGithubIssue ?? defaultGhIssueCreate;
  const tmpDir = mkdtempSync(join(tmpdir(), "eval-issue-submit-"));
  const bodyFile = join(tmpDir, "body.md");
  try {
    writeFileSync(bodyFile, draftBody.trim() + "\n", "utf-8");
    const githubUrl = create(targetRepo, title, bodyFile);
    const numMatch = githubUrl.match(/\/issues\/(\d+)\s*$/);
    const issueNumber = numMatch ? Number(numMatch[1]) : undefined;

    const now = new Date().toISOString();
    const newDraftFm = upsertDraftFrontmatter(draftFm, {
      status: "submitted",
      admin_approved: "true",
      github_url: githubUrl,
      submitted_at: now.slice(0, 10),
    });
    writeFileSync(draftAbs, `---\n${newDraftFm}\n---\n\n${draftBody.replace(/^\n+/, "")}`, "utf-8");

    mergeEvalPromotionBranch(evalAbs, issueBranch, {
      status: "submitted",
      target_type: "github_issue",
      target_file: draftRel,
      target_repo: targetRepo,
      github_url: githubUrl,
      submitted_at: now,
      promoted_by: opts.promotedBy ?? "ADMIN",
      admin_approved: "true",
      reviewed_by: "",
      github_status: "submitted",
    });

    return {
      ok: true,
      eval_rel_path: rel,
      target_file: draftRel,
      target_repo: targetRepo,
      github_url: githubUrl,
      github_issue_number: issueNumber,
    };
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function buildInboxTaskContentFromDraft(draftFm: string, draftBody: string): {
  inboxRel: string;
  content: string;
} {
  const meta = parseFlatFrontmatter(draftFm);
  const inboxRel =
    meta.planned_inbox_path ||
    meta.target_file ||
    "";
  if (!inboxRel) {
    throw new Error("本地任务草稿缺少 planned_inbox_path");
  }
  const taskId = meta.task_id || "";
  const inboxFmLines = [
    "---",
    "protocol: fcop",
    meta.version ? `version: ${meta.version}` : 'version: "1"',
    "kind: task",
    taskId ? `task_id: ${taskId}` : "",
    meta.sender ? `sender: ${meta.sender}` : "sender: ADMIN",
    meta.recipient ? `recipient: ${meta.recipient}` : "recipient: PM",
    meta.subject ? `subject: ${meta.subject}` : "",
    meta.priority ? `priority: ${meta.priority}` : "priority: P1",
    meta.thread_key ? `thread_key: ${meta.thread_key}` : "",
    meta.source_eval ? `source_eval: ${meta.source_eval}` : "",
    "source_type: eval_promotion",
    meta.auto_generated ? `auto_generated: ${meta.auto_generated}` : "auto_generated: true",
    meta.risk_review_required
      ? `risk_review_required: ${meta.risk_review_required}`
      : "risk_review_required: true",
    meta.risk_level ? `risk_level: ${meta.risk_level}` : "risk_level: review_required",
    meta.risk_flags ? `risk_flags: ${meta.risk_flags}` : "",
    "state: inbox",
    "---",
    "",
    draftBody.replace(/^\n+/, ""),
  ].filter((line) => line !== "");
  const content = inboxFmLines.join("\n");
  return { inboxRel, content };
}

export type SubmitLocalTaskDraftOptions = {
  projectRoot: string;
  adminInboxDir: string;
  evalRelPath: string;
  adminApproved: boolean;
  promotedBy?: string;
};

export function submitEvalLocalTaskDraft(opts: SubmitLocalTaskDraftOptions): SubmitLocalTaskDraftResult {
  if (!opts.adminApproved) {
    throw new Error("落地本地任务前须勾选 ADMIN 确认（admin_approved）");
  }

  const rel = evalRelPath(opts.projectRoot, opts.evalRelPath);
  const evalAbs = evalAbsPath(opts.projectRoot, rel);
  if (!existsSync(evalAbs)) throw new Error(`EVAL 文件不存在: ${rel}`);

  const evalRaw = readFileSync(evalAbs, "utf-8");
  const { promotion } = parseEvalFileMetadata(evalRaw);
  if (!promotionIsLocalTaskDraft(promotion)) {
    const st = promotion.task?.status || promotion.status || "—";
    throw new Error(`该 EVAL 无待落地的本地任务草稿（status=${st}）: ${rel}`);
  }
  const draftRel = promotion.task?.target_file || promotion.target_file;
  if (!draftRel) {
    throw new Error(`EVAL promotion 缺少 target_file: ${rel}`);
  }

  const draftAbs = join(opts.projectRoot, ...draftRel.split("/"));
  if (!existsSync(draftAbs)) throw new Error(`本地任务草稿不存在: ${draftRel}`);

  const draftRaw = readFileSync(draftAbs, "utf-8");
  const { frontmatter: draftFm, body: draftBody } = splitEvalFile(draftRaw);
  const draftMeta = parseFlatFrontmatter(draftFm);
  if ((draftMeta.status || "").toLowerCase() === "submitted") {
    throw new Error(`本地任务草稿已落地: ${draftRel}`);
  }

  const dup = findTaskBySourceEval(opts.projectRoot, rel);
  if (dup) {
    throw new Error(
      `${EVAL_TASK_PROMOTE_GATE_PREFIX}: 同 source_eval 已存在 lifecycle 任务: ${dup.task_id}`,
    );
  }
  if (containsForbiddenPromoteMarkers(draftBody)) {
    throw new Error(`${EVAL_TASK_PROMOTE_GATE_PREFIX}: 任务草稿正文含禁止标记`);
  }

  const { inboxRel, content } = buildInboxTaskContentFromDraft(draftFm, draftBody);
  const inboxFilename = inboxRel.split("/").pop() || "TASK-unknown.md";
  const inboxAbs = join(opts.adminInboxDir, inboxFilename);
  if (existsSync(inboxAbs)) {
    throw new Error(`inbox 已存在同名任务，拒绝覆盖: ${inboxRel}`);
  }

  mkdirSync(opts.adminInboxDir, { recursive: true });
  writeFileSync(inboxAbs, content, "utf-8");

  const now = new Date().toISOString();
  const newDraftFm = upsertDraftFrontmatter(draftFm, {
    status: "submitted",
    admin_approved: "true",
    submitted_at: now.slice(0, 10),
  });
  writeFileSync(draftAbs, `---\n${newDraftFm}\n---\n\n${draftBody.replace(/^\n+/, "")}`, "utf-8");

  mergeEvalPromotionBranch(evalAbs, "task", {
    status: "promoted",
    target_type: "task",
    target_file: inboxRel,
    planned_inbox_path: inboxRel,
    promoted_at: now,
    promoted_by: opts.promotedBy ?? "ADMIN",
    admin_approved: "true",
    reviewed_by: "",
  });

  return {
    ok: true,
    eval_rel_path: rel,
    draft_file: draftRel,
    target_file: inboxRel,
    filename: inboxFilename,
  };
}

export type DeleteEvalDraftOptions = {
  projectRoot: string;
  evalRelPath: string;
  /** 指定要删的草稿路径；task/issue 各有一份草稿时必须显式传入 */
  draftRelPath?: string;
};

export function deleteEvalPromotionDraft(opts: DeleteEvalDraftOptions): DeleteEvalDraftResult {
  const rel = evalRelPath(opts.projectRoot, opts.evalRelPath);
  const evalAbs = evalAbsPath(opts.projectRoot, rel);
  if (!existsSync(evalAbs)) throw new Error(`EVAL 文件不存在: ${rel}`);

  const evalRaw = readFileSync(evalAbs, "utf-8");
  const { promotion } = parseEvalFileMetadata(evalRaw);
  const hasTaskDraft = promotionIsLocalTaskDraft(promotion);
  const hasIssueDraft = promotionIsIssueDraft(promotion);
  if (!hasTaskDraft && !hasIssueDraft) {
    const st = promotion.status || "—";
    throw new Error(`该 EVAL 无待删除的草稿（status=${st}）: ${rel}`);
  }

  const taskDraftRel = promotion.task?.target_file ?? "";
  const cfmDraftRel = promotion.codeflowmu_issue?.target_file ?? "";
  const fcopDraftRel = promotion.fcop_issue?.target_file ?? "";
  const legacyIssueDraftRel = promotion.issue?.target_file ?? "";
  const draftCandidates = [taskDraftRel, cfmDraftRel, fcopDraftRel, legacyIssueDraftRel].filter(
    Boolean,
  );
  let draftRel = (opts.draftRelPath ?? "").trim();
  if (!draftRel) {
    const unique = [...new Set(draftCandidates)];
    if (unique.length > 1) {
      throw new Error(
        `该 EVAL 同时存在多份草稿，删除时请指定 draftRelPath: ${rel}`,
      );
    }
    draftRel = unique[0] ?? "";
  }
  if (!draftRel) {
    throw new Error(`EVAL promotion 缺少 target_file: ${rel}`);
  }

  const branch = promotionBranchNameForDraftPath(draftRel);
  const branchFile =
    branch === "task"
      ? taskDraftRel
      : branch === "codeflowmu_issue"
        ? cfmDraftRel || (legacyIssueDraftRel && issueBranchFromDraftPath(legacyIssueDraftRel) === "codeflowmu_issue" ? legacyIssueDraftRel : "")
        : branch === "fcop_issue"
          ? fcopDraftRel || (legacyIssueDraftRel && issueBranchFromDraftPath(legacyIssueDraftRel) === "fcop_issue" ? legacyIssueDraftRel : "")
          : "";
  if (branchFile && branchFile !== draftRel) {
    throw new Error(`draftRelPath 与 promotion.${branch}.target_file 不一致: ${draftRel}`);
  }

  const draftAbs = join(opts.projectRoot, ...draftRel.split("/"));
  if (existsSync(draftAbs)) {
    unlinkSync(draftAbs);
  }

  resetEvalPromotionBranch(evalAbs, branch);

  return {
    ok: true,
    eval_rel_path: rel,
    deleted_file: draftRel,
  };
}

export type EvalPromotionStateWithGate = Omit<
  EvalPromotionState,
  "task" | "codeflowmu_issue" | "fcop_issue"
> & {
  task: EvalPromotionButtonState;
  codeflowmu_issue: EvalPromotionButtonState;
  fcop_issue: EvalPromotionButtonState;
  issue: EvalPromotionBranch;
  task_status: string;
  task_target_file: string;
  issue_status: string;
  issue_target_file: string;
  issue_target_repo: string;
  can_promote_task: boolean;
  promote_block_reason: string;
  promote_block_reasons: string[];
  classification: EvalPromoteClassification;
  existing_task_id?: string;
  existing_task_file?: string;
};

/** UI/API：分支 status 为 pending 或空时视为尚未晋升 */
function branchStatusForRead(status: string | undefined): string {
  const st = (status ?? "").toLowerCase();
  if (!st || st === "pending") return "";
  return status ?? "";
}

function extendEvalPromotionState(
  promotion: EvalPromotionState,
  gateFields: Omit<
    EvalPromotionStateWithGate,
    | keyof Omit<EvalPromotionState, "task" | "codeflowmu_issue" | "fcop_issue">
    | "task"
    | "codeflowmu_issue"
    | "fcop_issue"
    | "issue"
    | "task_status"
    | "task_target_file"
    | "issue_status"
    | "issue_target_file"
    | "issue_target_repo"
  >,
): EvalPromotionStateWithGate {
  const taskBranch = promotion.task ?? EMPTY_BRANCH();
  const cfmBranch = promotion.codeflowmu_issue ?? EMPTY_BRANCH();
  const fcopBranch = promotion.fcop_issue ?? EMPTY_BRANCH();
  const issue = promotion.issue ?? EMPTY_BRANCH();
  const issueForLegacy = legacyIssueMirror(cfmBranch, fcopBranch, issue);
  return {
    ...promotion,
    task: branchToTaskButton(taskBranch),
    codeflowmu_issue: branchToIssueButton(cfmBranch),
    fcop_issue: branchToIssueButton(fcopBranch),
    issue,
    task_status: branchStatusForRead(taskBranch.status),
    task_target_file: taskBranch.target_file ?? "",
    issue_status: branchStatusForRead(issueForLegacy.status),
    issue_target_file: issueForLegacy.target_file ?? "",
    issue_target_repo: issueForLegacy.target_repo ?? "",
    ...gateFields,
  };
}

export function formatEvalTaskPromoteGateError(err: unknown): {
  status: number;
  body: { ok: false; error: string; reasons?: string[] };
} {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg.startsWith(EVAL_TASK_PROMOTE_GATE_PREFIX)) {
    return { status: 500, body: { ok: false, error: msg } };
  }
  const tail = msg.slice(EVAL_TASK_PROMOTE_GATE_PREFIX.length).replace(/^:\s*/, "");
  const reasons = tail
    .split("；")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    status: 400,
    body: {
      ok: false,
      error: msg,
      reasons: reasons.length ? reasons : [msg],
    },
  };
}

/** 测试与 legacy parse 辅助：与 readEvalPromotionState 相同的三分支 API 形状 */
export function extendEvalPromotionStateForTest(
  promotion: EvalPromotionState,
): EvalPromotionStateWithGate {
  return extendEvalPromotionState(promotion, {
    can_promote_task: true,
    promote_block_reason: "",
    promote_block_reasons: [],
    classification: "unknown",
  });
}

export function readEvalPromotionState(
  projectRoot: string,
  evalRelPathInput: string,
): EvalPromotionStateWithGate {
  const rel = evalRelPath(projectRoot, evalRelPathInput);
  const abs = evalAbsPath(projectRoot, rel);
  const gate = canPromoteEvalToTask(projectRoot, evalRelPathInput);
  const gateFields = {
    can_promote_task: gate.allowed,
    promote_block_reason: gate.reasons.join("；"),
    promote_block_reasons: gate.reasons,
    classification: gate.classification,
    existing_task_id: gate.existing_task_id,
    existing_task_file: gate.existing_task_file,
  };
  const emptyPromotion = parsePromotionBlock("");
  if (!existsSync(abs)) {
    return extendEvalPromotionState(emptyPromotion, gateFields);
  }
  const raw = readFileSync(abs, "utf-8");
  const { promotion } = parseEvalFileMetadata(raw);
  return extendEvalPromotionState(promotion, gateFields);
}
