/**
 * REVIEW-GATE approval card + auto-pass / red-flag rules for ADMIN panel.
 *
 * Default: auto-pass low-risk closed loops with complete evidence.
 * Any red flag → human approval queue (no nudge / no "return to PM").
 */

import { strField } from "../ledger/frontmatter.ts";
import type { LedgerTaskRecord } from "../ledger/types.ts";
import { isAdminToPmRootTask } from "../ledger/reportParenting.ts";
import type { EvalObservationAnalysis } from "../eval/EvalObservationGenerator.ts";
import { isAckOnlyReportBody } from "./ReviewFactGate.ts";

export type ReviewGateRedFlag =
  | "missing_report"
  | "missing_evidence"
  | "blocked"
  | "failed"
  | "rework"
  | "eval_failed"
  | "review_eval_conflict"
  | "medium_or_high_risk"
  | "admin_main_task_close"
  | "archive_request"
  | "ledger_mismatch"
  | "runtime_change"
  | "unknown_action";

export type ReviewGateRisk =
  | "low"
  | "medium"
  | "high"
  | "irreversible"
  | "unknown";

export type ReviewGateApprovalCard = {
  gate_status: "valid" | "invalid";
  can_approve: boolean;
  can_auto_pass: boolean;
  risk: ReviewGateRisk;
  reason: string;
  red_flags: ReviewGateRedFlag[];
  trigger_reason: string;
  requested_action: string;
  on_approve: string;
  on_reject: string;
  related_task_id: string;
  related_report_id: string;
  review_decision: string;
  fact_check_verdict: string;
  eval_pass: boolean | null;
  /** Distinguishes risk_approval (REVIEW agent matched a team rule) from
   * fallback_to_human (Runtime error path). Sourced from REVIEW file
   * frontmatter `human_approval.human_request_type`. */
  human_request_type?: "risk_approval" | "fallback_to_human";
  /** Team rule IDs the REVIEW agent matched. Sourced from frontmatter
   * `human_approval.matched_rules`. Empty for fallback_to_human. */
  matched_rules?: string[];
  /** Team type from the review decision policy (e.g. "software_dev"). */
  team_type?: string;
  /** Approval mode from the review decision policy (e.g. "semi_auto"). */
  approval_mode?: string;
  /** Path to the policy file used for this review decision. */
  policy_file?: string;
};

export type ReviewGateAutoPassResult = {
  can_auto_pass: boolean;
  red_flags: ReviewGateRedFlag[];
  reason: string;
};

export type ReviewGateBuildInput = {
  reviewFrontmatter: Record<string, unknown>;
  reviewFilename?: string;
  taskFrontmatter?: Record<string, unknown> | null;
  taskFilename?: string | null;
  reportFrontmatter?: Record<string, unknown> | null;
  reportBody?: string | null;
  reportId?: string | null;
  taskId?: string | null;
  evalAnalysis?: EvalObservationAnalysis | null;
  ledgerMismatch?: boolean;
  openChildCount?: number;
  reworkCount?: number;
};

const DONE_REPORT_STATUSES = new Set([
  "done",
  "completed",
  "complete",
  "success",
  "passed",
  "pass",
]);

const BLOCKED_STATUSES = new Set(["blocked", "block"]);
const FAILED_STATUSES = new Set(["failed", "fail", "error", "aborted"]);

const APPROVE_BLOCKERS: ReadonlySet<ReviewGateRedFlag> = new Set([
  "missing_report",
  "missing_evidence",
  "unknown_action",
  "ledger_mismatch",
]);

const RUNTIME_CHANGE_KEYWORDS =
  /protocol|lifecycle|权限|调度|账本|runtime|fcop\.json|_lifecycle|archive_task|migrate_to_v3|redeploy_rules/i;

const EVAL_FAIL_KEYWORDS =
  /hallucination|unverifiable|missing evidence|无法验证|臆断|幻觉|缺证据|证据不足/i;

function normalizeRisk(raw: string): ReviewGateRisk | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (v === "irreversible" || v === "critical") return "irreversible";
  if (v === "high") return "high";
  if (v === "medium") return "medium";
  if (v === "low") return "low";
  if (v === "unknown") return "unknown";
  return null;
}

function resolveTaskId(input: ReviewGateBuildInput): string {
  const fromInput = (input.taskId ?? "").replace(/\.md$/i, "").trim();
  if (fromInput) return fromInput;
  const fm = input.reviewFrontmatter;
  const fromFm =
    strField(fm, "task_id") ||
    strField(fm, "subject_id") ||
    strField(fm, "parent");
  if (fromFm && fromFm.toUpperCase().startsWith("TASK-")) {
    return fromFm.replace(/\.md$/i, "").trim();
  }
  const fn = input.reviewFilename ?? "";
  const m = fn.match(/-on-(TASK-[\d-]+(?:-[\w-]+)?)\.md$/i);
  return m?.[1]?.replace(/\.md$/i, "").trim() ?? "";
}

function resolveReportId(input: ReviewGateBuildInput, taskId: string): string {
  const explicit = (input.reportId ?? "").replace(/\.md$/i, "").trim();
  if (explicit) return explicit;
  const fromFm =
    strField(input.reviewFrontmatter, "report_id") ||
    strField(input.reviewFrontmatter, "subject_id");
  if (fromFm && fromFm.toUpperCase().startsWith("REPORT-")) {
    return fromFm.replace(/\.md$/i, "").trim();
  }
  const rfm = input.reportFrontmatter;
  if (rfm) {
    const rid = strField(rfm, "report_id") || strField(rfm, "task_id");
    if (rid.toUpperCase().startsWith("REPORT-")) {
      return rid.replace(/\.md$/i, "").trim();
    }
  }
  return "";
}

function reportStatus(
  reportFm: Record<string, unknown> | null | undefined,
): string {
  if (!reportFm) return "";
  return (
    strField(reportFm, "status") ||
    strField(reportFm, "result") ||
    strField(reportFm, "outcome")
  )
    .trim()
    .toLowerCase();
}

function hasEvidenceSummary(reportBody: string | null | undefined): boolean {
  if (!reportBody?.trim()) return false;
  if (isAckOnlyReportBody(reportBody)) return false;
  if (/##\s*(证据|evidence|checklist|交付|deliverable|output|执行摘要)/i.test(reportBody)) {
    return true;
  }
  if (/fcop_check|探针|probe|扫描|scan|exit_code|命令输出|test pass|测试通过/i.test(reportBody)) {
    return true;
  }
  return reportBody.trim().length >= 120;
}

function minimalTaskRecord(
  fm: Record<string, unknown> | null | undefined,
  filename: string | null | undefined,
  taskId: string,
): LedgerTaskRecord | null {
  if (!fm && !filename) return null;
  const name = filename ?? `${taskId}.md`;
  return {
    task_id: strField(fm ?? {}, "task_id") || taskId,
    filename: name,
    sender: strField(fm ?? {}, "sender") || "UNKNOWN",
    recipient: strField(fm ?? {}, "recipient") || "UNKNOWN",
    bucket: "review",
    path: "",
    created_at: "",
    updated_at: "",
    timezone: "UTC",
    created_at_utc: "",
    parent: strField(fm ?? {}, "parent") || undefined,
    thread_key: strField(fm ?? {}, "thread_key") || undefined,
  };
}

function isForcedHumanRisk(input: ReviewGateBuildInput): boolean {
  const taskFm = input.taskFrontmatter ?? {};
  const reviewMode = strField(taskFm, "review_mode").toLowerCase();
  if (reviewMode === "manual" || reviewMode === "human") return true;
  const risk =
    normalizeRisk(
      strField(taskFm, "risk_level") ||
        strField(taskFm, "risk") ||
        strField(input.reviewFrontmatter, "risk_level"),
    ) ?? null;
  return risk === "high" || risk === "irreversible";
}

function reviewPass(reviewFm: Record<string, unknown>): boolean {
  const verdict = strField(reviewFm, "fact_check_verdict").toLowerCase();
  if (verdict === "pass") return true;
  const decision = strField(reviewFm, "decision").toLowerCase();
  return decision === "approved";
}

function evalPass(analysis: EvalObservationAnalysis | null | undefined): boolean | null {
  if (!analysis) return null;
  if (analysis.evidence_gaps.length > 0) return false;
  if (analysis.recommended_admin_attention.length > 0) return false;
  if (analysis.findings.some((f) => EVAL_FAIL_KEYWORDS.test(f))) return false;
  if (analysis.risk_level === "high") return false;
  if (analysis.risk_level === "medium") return false;
  return true;
}

function deriveRisk(
  input: ReviewGateBuildInput,
  redFlags: ReviewGateRedFlag[],
): ReviewGateRisk {
  if (
    redFlags.includes("missing_report") ||
    redFlags.includes("unknown_action") ||
    (!input.taskId && !resolveTaskId(input))
  ) {
    return "unknown";
  }
  const candidates: ReviewGateRisk[] = [];
  const taskRisk = normalizeRisk(
    strField(input.taskFrontmatter ?? {}, "risk_level") ||
      strField(input.taskFrontmatter ?? {}, "risk") ||
      strField(input.reviewFrontmatter, "risk_level") ||
      strField(input.reviewFrontmatter, "risk"),
  );
  if (taskRisk) candidates.push(taskRisk);
  if (input.evalAnalysis?.risk_level) {
    candidates.push(input.evalAnalysis.risk_level);
  }
  if (redFlags.includes("medium_or_high_risk")) {
    candidates.push("high");
  }
  const order: ReviewGateRisk[] = [
    "irreversible",
    "high",
    "medium",
    "low",
    "unknown",
  ];
  for (const level of order) {
    if (candidates.includes(level)) return level;
  }
  return "low";
}

function mentionsArchive(input: ReviewGateBuildInput): boolean {
  const hay = [
    strField(input.taskFrontmatter ?? {}, "requested_action"),
    strField(input.reviewFrontmatter, "requested_action"),
    input.reportBody ?? "",
  ].join("\n");
  return /\barchive\b|archive_task|归档|深归档|archive_to_history/i.test(hay);
}

function mentionsRuntimeChange(input: ReviewGateBuildInput): boolean {
  const taskText = [
    strField(input.taskFrontmatter ?? {}, "subject"),
    input.taskFilename ?? "",
  ].join("\n");
  const reportText = input.reportBody ?? "";
  return RUNTIME_CHANGE_KEYWORDS.test(taskText + reportText);
}

function reworkCount(input: ReviewGateBuildInput): number {
  if (typeof input.reworkCount === "number") return input.reworkCount;
  const rc = input.taskFrontmatter?.reopened_count;
  if (typeof rc === "number") return rc;
  const fn = `${input.taskFilename ?? ""}${input.reportId ?? ""}`;
  const matches = fn.match(/rework/gi);
  return matches?.length ?? 0;
}

/** Collect red flags for REVIEW-GATE / human approval. */
export function collectReviewGateRedFlags(
  input: ReviewGateBuildInput,
): ReviewGateRedFlag[] {
  const flags: ReviewGateRedFlag[] = [];
  const taskId = resolveTaskId(input);
  const reportId = resolveReportId(input, taskId);
  const status = reportStatus(input.reportFrontmatter);
  const taskRec = minimalTaskRecord(
    input.taskFrontmatter,
    input.taskFilename,
    taskId,
  );

  if (!taskId) {
    flags.push("unknown_action");
  }
  if (!reportId && !input.reportFrontmatter) {
    flags.push("missing_report");
  }
  if (reportId || input.reportFrontmatter) {
    if (!hasEvidenceSummary(input.reportBody)) {
      flags.push("missing_evidence");
    }
    if (BLOCKED_STATUSES.has(status)) flags.push("blocked");
    if (FAILED_STATUSES.has(status)) flags.push("failed");
  } else if (taskId) {
    flags.push("missing_report");
  }

  const rw = reworkCount(input);
  if (rw >= 2) flags.push("rework");

  const evalOk = evalPass(input.evalAnalysis);
  const reviewOk = reviewPass(input.reviewFrontmatter);
  if (evalOk === false) flags.push("eval_failed");
  if (evalOk === false && reviewOk) flags.push("review_eval_conflict");
  if (strField(input.reviewFrontmatter, "fact_check_verdict").toLowerCase() === "fail") {
    if (!flags.includes("failed")) flags.push("failed");
  }

  const risk = deriveRisk(input, flags);
  if (risk === "medium" || risk === "high" || risk === "irreversible") {
    flags.push("medium_or_high_risk");
  }

  if (taskRec && isAdminToPmRootTask(taskRec)) {
    flags.push("admin_main_task_close");
  }
  if (mentionsArchive(input)) flags.push("archive_request");
  if (input.ledgerMismatch) flags.push("ledger_mismatch");
  if (mentionsRuntimeChange(input)) flags.push("runtime_change");

  const factVerdict = strField(input.reviewFrontmatter, "fact_check_verdict").toLowerCase();
  if (factVerdict === "needs_admin") {
    if (!flags.includes("medium_or_high_risk")) flags.push("medium_or_high_risk");
  }

  if ((input.openChildCount ?? 0) > 0) {
    if (!flags.includes("admin_main_task_close")) flags.push("admin_main_task_close");
  }

  return [...new Set(flags)];
}

/** True when the loop may skip the human queue and move review → done (never auto archive). */
export function evaluateReviewGateAutoPass(
  input: ReviewGateBuildInput,
): ReviewGateAutoPassResult {
  const redFlags = collectReviewGateRedFlags(input);
  if (redFlags.length > 0) {
    return {
      can_auto_pass: false,
      red_flags: redFlags,
      reason: `red_flag:${redFlags[0]}`,
    };
  }

  const taskId = resolveTaskId(input);
  const reportId = resolveReportId(input, taskId);
  const taskFm = input.taskFrontmatter ?? {};
  const reviewMode = strField(taskFm, "review_mode").toLowerCase();
  const risk = deriveRisk(input, redFlags);
  const status = reportStatus(input.reportFrontmatter);
  const taskRec = minimalTaskRecord(taskFm, input.taskFilename, taskId);

  if (isForcedHumanRisk(input)) {
    return { can_auto_pass: false, red_flags: ["medium_or_high_risk"], reason: "forced_human" };
  }
  if (taskRec && isAdminToPmRootTask(taskRec)) {
    return {
      can_auto_pass: false,
      red_flags: ["admin_main_task_close"],
      reason: "admin_mainline",
    };
  }
  if (!(reviewMode === "auto" || risk === "low")) {
    return { can_auto_pass: false, red_flags: [], reason: "review_mode_or_risk" };
  }
  if (!reportId || !input.reportFrontmatter) {
    return { can_auto_pass: false, red_flags: ["missing_report"], reason: "missing_report" };
  }
  if (!DONE_REPORT_STATUSES.has(status)) {
    return { can_auto_pass: false, red_flags: [], reason: `report_status:${status || "missing"}` };
  }
  if (!hasEvidenceSummary(input.reportBody)) {
    return { can_auto_pass: false, red_flags: ["missing_evidence"], reason: "missing_evidence" };
  }
  const evalOk = evalPass(input.evalAnalysis);
  if (evalOk === false) {
    return { can_auto_pass: false, red_flags: ["eval_failed"], reason: "eval_failed" };
  }
  if (!reviewPass(input.reviewFrontmatter) && strField(input.reviewFrontmatter, "decision")) {
    const d = strField(input.reviewFrontmatter, "decision").toLowerCase();
    if (d === "needs_human" || d === "changes_requested" || d === "rejected") {
      return { can_auto_pass: false, red_flags: [], reason: `review_decision:${d}` };
    }
  }

  return { can_auto_pass: true, red_flags: [], reason: "auto_pass_ok" };
}

function triggerReason(flags: ReviewGateRedFlag[], input: ReviewGateBuildInput): string {
  if (flags.includes("missing_report") || flags.includes("unknown_action")) {
    return "审批材料不完整，需 ADMIN 人工判定";
  }
  if (flags.includes("admin_main_task_close")) return "ADMIN 主线关单需人工审批";
  if (flags.includes("archive_request")) return "涉及归档/关单动作，需人工审批";
  if (flags.includes("medium_or_high_risk")) return "非低风险任务，需人工审批";
  if (flags.includes("eval_failed") || flags.includes("review_eval_conflict")) {
    return "EVAL/REVIEW 结论不一致或需复核";
  }
  if (flags.includes("blocked") || flags.includes("failed")) {
    return "执行结果 blocked/failed，需人工审批";
  }
  if (flags.includes("ledger_mismatch")) return "磁盘状态与账本不一致";
  if (flags.includes("runtime_change")) return "涉及协议/生命周期/运行时变更";
  const verdict = strField(input.reviewFrontmatter, "fact_check_verdict");
  if (verdict === "needs_admin") return "事实核查需 ADMIN 裁决";
  return "REVIEW-GATE 需 ADMIN 人工审批";
}

function requestedAction(flags: ReviewGateRedFlag[]): string {
  if (flags.includes("archive_request")) return "archive / close";
  if (flags.includes("admin_main_task_close")) return "close mainline";
  return "approve gate";
}

/** Build enriched approval card for panel + API. */
export function buildReviewGateApprovalCard(
  input: ReviewGateBuildInput,
): ReviewGateApprovalCard {
  const red_flags = collectReviewGateRedFlags(input);
  const auto = evaluateReviewGateAutoPass(input);
  const taskId = resolveTaskId(input);
  const reportId = resolveReportId(input, taskId);
  const risk = deriveRisk(input, red_flags);

  const gateInvalid =
    !taskId ||
    red_flags.includes("missing_report") ||
    red_flags.includes("unknown_action");

  const gate_status: "valid" | "invalid" = gateInvalid ? "invalid" : "valid";
  const can_approve =
    gate_status === "valid" &&
    !red_flags.some((f) => APPROVE_BLOCKERS.has(f));

  let reason = "ready_for_admin";
  if (!can_approve) {
    reason = gateInvalid ? "missing_approval_materials" : `blocked:${red_flags[0]}`;
  }

  // Extract human_request_type, matched_rules, team_type, approval_mode, policy_file
  // from the REVIEW file frontmatter (written by NeedsHumanGate.push via ReviewWriter).
  const ha = input.reviewFrontmatter["human_approval"];
  let human_request_type: "risk_approval" | "fallback_to_human" | undefined;
  let matched_rules: string[] | undefined;
  let team_type: string | undefined;
  let approval_mode: string | undefined;
  let policy_file: string | undefined;
  if (ha && typeof ha === "object") {
    const haObj = ha as Record<string, unknown>;
    const hrt = haObj["human_request_type"];
    if (hrt === "risk_approval" || hrt === "fallback_to_human") {
      human_request_type = hrt;
    }
    const mr = haObj["matched_rules"];
    if (Array.isArray(mr)) {
      matched_rules = mr.map(String).filter(Boolean);
    }
    const tt = haObj["team_type"];
    if (typeof tt === "string" && tt) team_type = tt;
    const am = haObj["approval_mode"];
    if (typeof am === "string" && am) approval_mode = am;
    const pf = haObj["policy_file"];
    if (typeof pf === "string" && pf) policy_file = pf;
  }

  return {
    gate_status,
    can_approve,
    can_auto_pass: auto.can_auto_pass,
    risk,
    reason,
    red_flags,
    trigger_reason: triggerReason(red_flags, input),
    requested_action: requestedAction(red_flags),
    on_approve: "review → done（不自动 archive）",
    on_reject: "保持 review / 标记 rejected",
    related_task_id: taskId,
    related_report_id: reportId,
    review_decision: strField(input.reviewFrontmatter, "decision"),
    fact_check_verdict: strField(input.reviewFrontmatter, "fact_check_verdict"),
    eval_pass: evalPass(input.evalAnalysis),
    ...(human_request_type !== undefined ? { human_request_type } : {}),
    ...(matched_rules !== undefined ? { matched_rules } : {}),
    ...(team_type !== undefined ? { team_type } : {}),
    ...(approval_mode !== undefined ? { approval_mode } : {}),
    ...(policy_file !== undefined ? { policy_file } : {}),
  };
}

export const REVIEW_GATE_RED_FLAG_LABELS: Record<ReviewGateRedFlag, string> = {
  missing_report: "缺少 REPORT",
  missing_evidence: "缺少执行证据",
  blocked: "REPORT blocked",
  failed: "REPORT/核查 failed",
  rework: "返工次数偏高",
  eval_failed: "EVAL 未通过",
  review_eval_conflict: "REVIEW 与 EVAL 冲突",
  medium_or_high_risk: "中/高风险",
  admin_main_task_close: "ADMIN 主线关单",
  archive_request: "归档请求",
  ledger_mismatch: "账本不一致",
  runtime_change: "运行时/协议变更",
  unknown_action: "无法识别审批对象",
};
