import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type IssueCauseType =
  | "dependency_pending"
  | "premature_execution"
  | "business_validation_fail"
  | "panel_display_issue"
  | "lifecycle_integrity_issue"
  | "unclassified";

export interface IssueAnalysis {
  cause_type: IssueCauseType;
  cause_summary: string;
  impact_scope: string;
  severity_reason: string;
  current_status_judgment: string;
  recommended_action: string;
}

export interface EnrichedIssueMetadata {
  reporter: string;
  severity: "critical" | "high" | "medium" | "low";
  severity_level: "P0" | "P1" | "P2" | "P3";
  effective_status: "active" | "resolved";
  source_severity?: string;
  analysis: IssueAnalysis;
}

type LedgerRow = Record<string, unknown>;

function reportSender(value: unknown): string | undefined {
  const match = String(value ?? "").match(/REPORT-\d{8}-\d{3,}-([A-Za-z0-9_]+)-to-[A-Za-z0-9_]+(?:\.md)?/i);
  return match?.[1]?.toUpperCase();
}

function sourceReportFromBody(body: string): string | undefined {
  const labelled = body.match(/(?:source[ _-]*report|来源报告|源报告)\s*[:：]\s*`?(REPORT-[A-Za-z0-9_.-]+)/i);
  if (labelled?.[1]) return labelled[1];
  return body.match(/REPORT-\d{8}-\d{3,}-[A-Za-z0-9_]+-to-[A-Za-z0-9_]+(?:\.md)?/i)?.[0];
}

export function inferIssueReporter(frontmatter: Record<string, unknown>, body: string): string {
  const explicit = String(frontmatter.reporter ?? "").trim();
  if (explicit) return explicit;
  const fromFrontmatter = reportSender(frontmatter.source_report);
  if (fromFrontmatter) return fromFrontmatter;
  return reportSender(sourceReportFromBody(body)) ?? "?";
}

function readJsonLines(path: string): LedgerRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as LedgerRow];
    } catch {
      return [];
    }
  });
}

function normalizeReportId(value: unknown): string {
  return String(value ?? "").replace(/\.md$/i, "").trim();
}

function issueSourceReport(frontmatter: Record<string, unknown>, body: string): string {
  return normalizeReportId(frontmatter.source_report ?? sourceReportFromBody(body));
}

function reportTime(row: LedgerRow): number {
  const parsed = Date.parse(String(row.created_at ?? row.updated_at ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasLaterSuccessfulCoverage(projectRoot: string, frontmatter: Record<string, unknown>, body: string): boolean {
  const reports = readJsonLines(join(projectRoot, "fcop", "ledger", "reports.jsonl"));
  const sourceId = issueSourceReport(frontmatter, body);
  const source = reports.find((row) => normalizeReportId(row.report_id ?? row.filename) === sourceId);
  const taskId = String(source?.task_id ?? frontmatter.task_id ?? frontmatter.source_task ?? "").trim();
  if (!taskId) return false;
  const sourceAt = source ? reportTime(source) : Date.parse(String(frontmatter.created_at ?? "")) || 0;
  return reports.some((row) =>
    String(row.task_id ?? "") === taskId
    && String(row.status ?? "").toLowerCase() === "done"
    && normalizeReportId(row.report_id ?? row.filename) !== sourceId
    && reportTime(row) >= sourceAt,
  );
}

export function classifyIssueCause(reporter: string, frontmatter: Record<string, unknown>, body: string): IssueCauseType {
  const text = `${Object.values(frontmatter).join(" ")} ${body}`.toLowerCase();
  if (/(错误归档|错误 approve|状态错乱|任务.*丢失|报告.*丢失|bucket mismatch|lifecycle.*(?:corrupt|mismatch)|wrong archive)/i.test(text)) return "lifecycle_integrity_issue";
  if (/(reporter\s*=\s*\?|报告人.*\?|字段缺失|排序错误|列表显示不一致|display issue|sorting issue)/i.test(text)) return "panel_display_issue";
  if (/(9\s*\/\s*10|qa\s*(?:最终\s*)?fail|试玩\s*fail|验收不通过|关卡缺失|磁铁|与.*验收期望不符|business validation)/i.test(text)) return "business_validation_fail";
  const dependencySignal = /(前置未满足|尚无.*write_report|未\s*done|depends_on|blocked_by|dependency pending|prerequisite)/i.test(text);
  if (dependencySignal && reporter === "QA" && /(?:dev[\s\S]*ops|ops[\s\S]*dev)/i.test(text)) return "premature_execution";
  if (dependencySignal) return "dependency_pending";
  return "unclassified";
}

function severityLevel(severity: EnrichedIssueMetadata["severity"]): EnrichedIssueMetadata["severity_level"] {
  return ({ critical: "P0", high: "P1", medium: "P2", low: "P3" } as const)[severity];
}

export function enrichIssueMetadata(projectRoot: string, frontmatter: Record<string, unknown>, body: string): EnrichedIssueMetadata {
  const reporter = inferIssueReporter(frontmatter, body);
  const cause = classifyIssueCause(reporter, frontmatter, body);
  const covered = hasLaterSuccessfulCoverage(projectRoot, frontmatter, body);
  let severity: EnrichedIssueMetadata["severity"] = "medium";
  let impactScope = "局部任务或子线，通常可通过等待前置或返工恢复。";
  let severityReason = "P2：影响局部执行，但未发现系统完整性损坏，可通过重跑或返工恢复。";
  let causeSummary = "现有信息不足以归入已知 ISSUE 原因类型。";
  let action = "补充来源报告和影响链证据后重新分析。";

  if (cause === "lifecycle_integrity_issue") {
    severity = "critical";
    causeSummary = "生命周期状态、归档或任务/报告完整性出现异常。";
    impactScope = "系统主流程与审计状态，可能影响自动推进和数据可信度。";
    severityReason = "P0：状态错乱或文件缺失可能让系统无法可靠继续运行。";
    action = "由 ADMIN 介入核查账本与磁盘状态，在确认一致性前停止自动推进。";
  } else if (cause === "panel_display_issue") {
    severity = "low";
    causeSummary = "Panel 展示字段缺失、排序或列表/详情不一致。";
    impactScope = "Panel 可观测性，不直接阻塞业务执行。";
    severityReason = "P3：属于展示和提示问题；若会误导关键决策，应重新评估并升级。";
    action = "修复 Panel enrichment 或展示逻辑，不阻塞业务主线。";
  } else if (cause === "premature_execution") {
    causeSummary = "下游 QA/OPS 在 DEV/OPS 前置完成前被派发，因缺少前置回执而 blocked。";
    action = covered ? "后续顺序执行与复验已通过，建议结案并保留为 dependency gate 历史证据。" : "检查 dependency gate，等待前置 done 后按 DEV→OPS→QA 顺序重跑。";
  } else if (cause === "dependency_pending") {
    causeSummary = "执行时前置任务尚无 done report，依赖条件未满足。";
    action = covered ? "前置完成且同任务已有后续 done 回执，建议结案。" : "等待前置 done 后重跑；不要把依赖等待当作业务失败。";
  } else if (cause === "business_validation_fail") {
    causeSummary = "业务验收或试玩发现与 TASK 验收期望不符的实际缺陷。";
    if (covered) {
      impactScope = "历史业务缺陷；后续修复和复验已覆盖，当前不再阻塞主线。";
      severityReason = "P2（已缓解）：原缺陷可阻塞验收，但同一验收任务已有后续 done 回执。";
      action = "核对后续修复、OPS 验收和 QA 复验链后结案。";
    } else {
      severity = "high";
      impactScope = "当前主线验收与 approve/archive。";
      severityReason = "P1：业务验收失败仍可能阻塞当前主线关单，需要 PM/ADMIN 推动修复与复验。";
      action = "创建或继续修复任务，并在 OPS/QA 复验通过后降级或结案。";
    }
  }

  return {
    reporter,
    severity,
    severity_level: severityLevel(severity),
    effective_status: covered ? "resolved" : "active",
    source_severity: String(frontmatter.severity ?? "").trim() || undefined,
    analysis: {
      cause_type: cause,
      cause_summary: causeSummary,
      impact_scope: impactScope,
      severity_reason: severityReason,
      current_status_judgment: covered
        ? "resolved：来源 blocked/FAIL 已被同任务后续 done 回执覆盖，建议人工确认后结案。"
        : "active：尚未发现同任务更晚的 done 回执，仍需按建议动作处理。",
      recommended_action: action,
    },
  };
}
