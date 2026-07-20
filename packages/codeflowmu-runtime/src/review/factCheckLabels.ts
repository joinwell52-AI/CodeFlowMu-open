import type { FactCheckReasonCode, FactCheckResult } from "./ReviewFactGate.ts";

const REASON_LABELS: Record<FactCheckReasonCode, string> = {
  qa_acceptance_evidence_missing:
    "QA 验收报告缺少测试数据、模拟用户操作、预期/实际结果或可追溯证据",
  browser_evidence_required:
    "报告声明了真实布局、响应式或下载验收，但缺少 Playwright 或真实浏览器证据",
  missing_test_evidence: "REPORT 声称测试/命令执行，但动作日志缺少可核对的 command.run 证据",
  missing_data_evidence: "REPORT 声称数据查询，但动作日志缺少 data.query 证据",
  missing_file_evidence: "REPORT 声称文件变更，但动作日志缺少 file.read / 变更证据",
  missing_row_count_evidence:
    "REPORT 明确声称库表/SQL 查询结果，但缺少带 row_count 的 data.query 证据",
  missing_stats_evidence:
    "REPORT 含表格或数字统计，但动作日志缺少 command.run、file.read 或 data.query 等执行证据",
  test_exit_code_mismatch: "测试命令退出码与 REPORT「通过」结论不一致",
  evidence_inconclusive: "动作证据不足以支撑 REPORT 结论",
  session_evidence_gap: "动作日志与 REPORT session_id 无法对齐",
  no_claims_detected: "REPORT 正文缺少可核查的交付/测试/数据声明",
  evidence_verified: "动作日志与 REPORT 声明一致，证据可核查",
  ack_only_done_report: "REPORT 仅进度确认，不足以支撑 status=done",
};

/** Human-readable title for a fact-check reason code. */
export function factCheckReasonLabel(code: FactCheckReasonCode | string): string {
  const key = String(code).trim() as FactCheckReasonCode;
  return REASON_LABELS[key] ?? `事实核查未通过（${code}）`;
}

/** One-paragraph judgment summary for REVIEW body and PM attention. */
export function formatFactCheckJudgmentSummary(result: FactCheckResult): string {
  const title = factCheckReasonLabel(result.reason_code);
  const lines: string[] = [];

  if (result.verdict === "pass") {
    lines.push("自动事实核查（REVIEW-GATE）结论：**通过**。");
    if (result.reason_code === "evidence_verified") {
      lines.push(`${title}，可进入正常验收流程。`);
    } else {
      lines.push("未检测到需强证据绑定的声明，可进入正常验收流程。");
    }
    return lines.join("\n");
  }

  if (result.verdict === "needs_admin") {
    lines.push("自动事实核查（REVIEW-GATE）结论：**需 ADMIN 人工裁定**（decision=needs_human）。");
    lines.push(`原因：${title}。`);
  } else {
    lines.push("自动事实核查（REVIEW-GATE）结论：**未通过，自动退回整改**（decision=changes_requested）。");
    lines.push(`原因：${title}。`);
  }

  if (result.unsupported_claims.length) {
    lines.push(
      `不支持的声明：${result.unsupported_claims.map((c) => `「${c}」`).join("；")}。`,
    );
  }
  if (result.required_changes.length) {
    lines.push(`建议整改：${result.required_changes.join("；")}。`);
  }

  return lines.join("\n");
}

/** Compact reason for task frontmatter `pm_attention_reason` (Panel tooltip). */
export function buildPmAttentionReason(result: FactCheckResult): string {
  const title = factCheckReasonLabel(result.reason_code);
  const prefix =
    result.verdict === "needs_admin"
      ? "事实核查需人工裁定"
      : "事实核查未通过";
  const parts = [`${prefix}：${title}`];
  for (const c of result.unsupported_claims) {
    parts.push(c);
  }
  for (const c of result.required_changes) {
    parts.push(`建议：${c}`);
  }
  return parts.filter(Boolean).join("；");
}
