import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type IssueCauseType =
  | "dependency_pending"
  | "premature_execution"
  | "evidence_gate_false_positive"
  | "product_algorithm_regression"
  | "product_data_edge_case"
  | "deployment_artifact_stale"
  | "environment_configuration_missing"
  | "business_validation_fail"
  | "panel_display_issue"
  | "lifecycle_integrity_issue"
  | "insufficient_evidence";

export type IssueOwnershipScope =
  | "codeflowmu_product"
  | "project_product"
  | "environment_or_deployment"
  | "insufficient_information";

export type IssuePublicEligibility =
  | "candidate"
  | "local_only"
  | "blocked_sensitive"
  | "needs_information";

export interface IssueAnalysis {
  trigger_type: string;
  cause_type: IssueCauseType;
  cause_summary: string;
  ownership_scope: IssueOwnershipScope;
  public_eligibility: IssuePublicEligibility;
  public_reason: string;
  privacy_risk: "none" | "possible" | "high";
  quality_score: number;
  quality_level: "good" | "needs_improvement" | "insufficient";
  quality_issues: string[];
  suggested_title: string;
  state_consistency: "consistent" | "body_status_conflict" | "parent_archived";
  impact_scope: string;
  severity_reason: string;
  current_status_judgment: string;
  recommended_action: string;
}

export interface EnrichedIssueMetadata {
  reporter: string;
  severity: "critical" | "high" | "medium" | "low";
  severity_level: "P0" | "P1" | "P2" | "P3";
  effective_status: "active" | "resolved" | "historical";
  parent_task_state?: "archive";
  inactive_reason?: "parent_archived" | "parent_force_archived";
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

function archivedParentProjection(
  projectRoot: string,
  frontmatter: Record<string, unknown>,
  body: string,
): { archived: boolean; force: boolean } {
  const reports = readJsonLines(join(projectRoot, "fcop", "ledger", "reports.jsonl"));
  const sourceId = issueSourceReport(frontmatter, body);
  const source = reports.find(
    (row) => normalizeReportId(row.report_id ?? row.filename) === sourceId,
  );
  const taskId = String(
    frontmatter.task_id ??
      frontmatter.source_task ??
      source?.parent_task_id ??
      source?.task_id ??
      "",
  )
    .replace(/\.md$/i, "")
    .trim();
  if (!taskId) return { archived: false, force: false };
  const tasks = readJsonLines(join(projectRoot, "fcop", "ledger", "tasks.jsonl"));
  const parent = tasks.find((row) => {
    const candidate = String(row.task_id ?? "").replace(/\.md$/i, "").trim();
    return (
      candidate === taskId ||
      candidate.startsWith(`${taskId}-`) ||
      taskId.startsWith(`${candidate}-`)
    );
  });
  if (String(parent?.bucket ?? "").toLowerCase() !== "archive") {
    return { archived: false, force: false };
  }
  const yaml =
    parent?.yaml && typeof parent.yaml === "object"
      ? (parent.yaml as Record<string, unknown>)
      : {};
  return {
    archived: true,
    force:
      String(yaml.archive_mode ?? "").toLowerCase() === "force" ||
      String(yaml.force_archived ?? "").toLowerCase() === "true",
  };
}

export function classifyIssueCause(reporter: string, frontmatter: Record<string, unknown>, body: string): IssueCauseType {
  const text = `${Object.values(frontmatter).join(" ")} ${body}`.toLowerCase();
  if (/review-gate|missing_data_evidence|data\.query|fact_check_deterministic_failure_not_overrulable/i.test(text)
    && /(?:本地\s*(?:json|文件)|文件读取|未声称.*(?:数据库|sql)|不应补造|误闸)/i.test(text)) return "evidence_gate_false_positive";
  if (/(错误归档|错误 approve|状态错乱|任务.*丢失|报告.*丢失|bucket mismatch|lifecycle.*(?:corrupt|mismatch|split)|wrong archive|session.*(?:ended|closed).*(?:task|任务).*(?:blocked|active|未完成))/i.test(text)) return "lifecycle_integrity_issue";
  if (/(reporter\s*=\s*\?|报告人.*\?|字段缺失|排序错误|列表显示不一致|display issue|sorting issue)/i.test(text)) return "panel_display_issue";
  if (/(公网\s*pwa|gateway\s*静态|静态前端|frontend\/dist|旧\s*ui|发布物.*(?:旧|滞后)|artifact.*stale)/i.test(text)) return "deployment_artifact_stale";
  if (/(?:^|\W)\.env|persist_|dataset_dir|配置未启用|环境变量|runtime setting/i.test(text)) return "environment_configuration_missing";
  if (/(exact.*(?:0\s*\/\s*8|回退|无增益)|baseline.*(?:回退|无增益)|ocr.*(?:回退|退化)|识别.*(?:回退|退化)|算法.*回归)/i.test(text)) return "product_algorithm_regression";
  if (/(生僻字|多行.*(?:ocr|粘连|合并)|字段串扰|姓名错位|地址.*串行|住址.*串接)/i.test(text)) return "product_data_edge_case";
  if (/(9\s*\/\s*10|qa\s*(?:最终\s*)?fail|试玩\s*fail|验收不通过|关卡缺失|磁铁|与.*验收期望不符|business validation)/i.test(text)) return "business_validation_fail";
  const dependencySignal = /(前置未满足|尚无.*write_report|未\s*done|depends_on|blocked_by|dependency pending|prerequisite)/i.test(text);
  if (dependencySignal && reporter === "QA" && /(?:dev[\s\S]*ops|ops[\s\S]*dev)/i.test(text)) return "premature_execution";
  if (dependencySignal) return "dependency_pending";
  return "insufficient_evidence";
}

function issueText(frontmatter: Record<string, unknown>, body: string): string {
  return `${Object.values(frontmatter).join(" ")}\n${body}`;
}

function firstConcreteSentence(body: string): string {
  const section = body.match(/^##\s+(?:问题摘要|现象(?:（[^\n]+）)?|背景|Problem(?: Summary)?)\s*\r?\n+([\s\S]*?)(?=^##\s+|(?![\s\S]))/im)?.[1] ?? body;
  const line = section
    .split(/\r?\n/)
    .map((value) => value.replace(/^[-*\d.\s]+/, "").replace(/[*`]/g, "").trim())
    .find((value) => value.length >= 12) ?? "";
  return line.split(/(?<=[。！？.!?])\s*/)[0]?.slice(0, 180) ?? "";
}

function issueQuality(frontmatter: Record<string, unknown>, body: string): { score: number; issues: string[] } {
  const text = issueText(frontmatter, body);
  const issues: string[] = [];
  let score = 0;
  const title = String(frontmatter.summary ?? frontmatter.title ?? body.match(/^#\s+(.+)$/m)?.[1] ?? "").trim();
  if (title && !/^(?:runtime|product|public)?\s*issue$/i.test(title)) score += 20;
  else issues.push("标题缺少可识别的具体故障");
  if (/^##\s+(?:问题摘要|现象|背景|Problem)/im.test(body) && firstConcreteSentence(body).length >= 12) score += 20;
  else issues.push("缺少具体问题现象");
  if (/复现|步骤|输入|样本|同批|触发|尝试|repro|when\b/i.test(body)) score += 15;
  else issues.push("缺少可执行复现条件");
  if (/证据|report-|pass|fail|json|日志|返回|exact|基线|evidence/i.test(body)) score += 15;
  else issues.push("缺少可核验事实或证据");
  if (/期望|实际|不应|回退|影响|阻塞|未通过|expected|actual/i.test(text)) score += 15;
  else issues.push("缺少期望、实际或影响说明");
  if (/建议|处置|仍需|修复|重跑|回退|force_archive|request_rework/i.test(body)) score += 15;
  else issues.push("缺少下一步处置建议");
  return { score, issues };
}

function privacyRisk(frontmatter: Record<string, unknown>, body: string): "none" | "possible" | "high" {
  const text = issueText(frontmatter, body);
  if (/(?:人审真值|真实姓名|客户姓名)\s*[:：]?\s*[\u3400-\u9fff]{2,10}|(?:身份证|证件号)\s*[:：]?\s*\d{15,18}|[\u3400-\u9fff]{2,}(?:省|市|县|区)[\u3400-\u9fff\d]{2,}(?:镇|乡|街道)[\u3400-\u9fff\d]{2,}(?:村|社区).{0,20}\d+号/.test(text)) return "high";
  if (/姓名|住址|地址|客户|样本原文|id-card/i.test(text)) return "possible";
  return "none";
}

function ownershipForCause(cause: IssueCauseType): IssueOwnershipScope {
  if (["evidence_gate_false_positive", "panel_display_issue", "lifecycle_integrity_issue"].includes(cause)) return "codeflowmu_product";
  if (["deployment_artifact_stale", "environment_configuration_missing"].includes(cause)) return "environment_or_deployment";
  if (["product_algorithm_regression", "product_data_edge_case", "business_validation_fail"].includes(cause)) return "project_product";
  return "insufficient_information";
}

function severityLevel(severity: EnrichedIssueMetadata["severity"]): EnrichedIssueMetadata["severity_level"] {
  return ({ critical: "P0", high: "P1", medium: "P2", low: "P3" } as const)[severity];
}

export function enrichIssueMetadata(projectRoot: string, frontmatter: Record<string, unknown>, body: string): EnrichedIssueMetadata {
  const reporter = inferIssueReporter(frontmatter, body);
  const cause = classifyIssueCause(reporter, frontmatter, body);
  const ownership = ownershipForCause(cause);
  const privacy = privacyRisk(frontmatter, body);
  const quality = issueQuality(frontmatter, body);
  const covered = hasLaterSuccessfulCoverage(projectRoot, frontmatter, body);
  const archivedParent = archivedParentProjection(projectRoot, frontmatter, body);
  const declaredStatus = String(frontmatter.status ?? "open").trim().toLowerCase();
  const structuredResolved = ["closed", "resolved", "mitigated"].includes(declaredStatus);
  const bodyClaimsClosed = /(?:status|状态)\s*(?:→|->|:|：)\s*(?:closed|resolved|已关闭|已解决)/i.test(body);
  const stateConsistency = archivedParent.archived
    ? "parent_archived" as const
    : bodyClaimsClosed && !structuredResolved
      ? "body_status_conflict" as const
      : "consistent" as const;
  const effectiveResolved = structuredResolved || covered;
  let severity: EnrichedIssueMetadata["severity"] = "medium";
  let impactScope = "局部任务或子线，通常可通过等待前置或返工恢复。";
  let severityReason = "P2：影响局部执行，但未发现系统完整性损坏，可通过重跑或返工恢复。";
  let causeSummary = "当前材料只说明 REPORT 被阻塞或失败，尚未说明可验证的技术根因。";
  let action = "补充具体输入、期望、实际结果、复现条件和证据后重新分析。";

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
  } else if (cause === "evidence_gate_false_positive") {
    severity = "high";
    causeSummary = "REVIEW-GATE 把文件/JSON 型 QA 证据误判为必须提供 data.query，生成了无意义返工且现有角色无法撤销确定性误判。";
    impactScope = "CodeFlowMu 的事实门禁、返工派发和任务生命周期；会阻断本可通过的报告。";
    severityReason = "P1：确定性误判会制造无效返工，并阻塞 approve/archive，需修复 Runtime 规则。";
    action = "让门禁按证据来源类型校验；文件型评测不得强制 data.query，并提供可审计的误判撤销路径及回归测试。";
  } else if (cause === "deployment_artifact_stale") {
    causeSummary = "项目公开静态发布物落后于已验证的本地前端，运行入口仍提供旧 UI。";
    impactScope = "当前项目的公开部署与用户可见版本，不属于 CodeFlowMu 产品自身。";
    severityReason = "P2：会让用户继续看到旧行为，但可通过重新构建和发布项目产物恢复。";
    action = "核对构建来源、产物摘要和发布目标，重新发布后做公网版本与功能复验。";
  } else if (cause === "environment_configuration_missing") {
    causeSummary = "项目运行环境缺少或未启用所需配置，导致预期能力未生效。";
    impactScope = "当前项目环境和运行配置，不属于 CodeFlowMu 公共产品缺陷。";
    severityReason = "P2：影响当前环境能力，可通过补齐配置、重启和验证恢复。";
    action = "补齐明确配置并重启；记录生效证据，避免把环境缺失误报为产品缺陷。";
  } else if (cause === "product_algorithm_regression") {
    severity = covered ? "medium" : "high";
    causeSummary = `${firstConcreteSentence(body) || "项目算法指标相对已知基线发生回退或未获得预期增益。"}`;
    impactScope = covered ? "项目算法缺陷已有后续回执覆盖，仍需核对指标证据。" : "当前项目的算法验收与发布门禁；不属于 CodeFlowMu 产品自身。";
    severityReason = covered ? "P2（已缓解）：已有后续 done 回执，但仍应保留指标回归证据。" : "P1：可重复的基线回退会直接阻塞项目验收。";
    action = covered ? "核对修复前后同口径指标后结案。" : "固定样本与基线，定位算法/配置差异，修复后按相同口径复验。";
  } else if (cause === "product_data_edge_case") {
    severity = covered ? "low" : "medium";
    causeSummary = `${firstConcreteSentence(body) || "项目数据中的生僻字、多行字段或版面边界触发识别异常。"}`;
    impactScope = "当前项目的数据质量、OCR 边界案例和业务输出；不属于 CodeFlowMu 产品自身。";
    severityReason = covered ? "P3（已缓解）：主缺陷已有覆盖，残差进入项目监控。" : "P2：影响部分边界样本，需要项目侧修复与回归。";
    action = "脱敏保留最小复现样本，分别验证识别、字段切分和后处理，不允许用后处理发明原始识别结果。";
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

  const publicEligibility: IssuePublicEligibility = privacy === "high"
    ? "blocked_sensitive"
    : ownership === "codeflowmu_product"
      ? quality.score >= 55 ? "candidate" : "needs_information"
      : ownership === "insufficient_information" ? "needs_information" : "local_only";
  const publicReason = publicEligibility === "candidate"
    ? "属于 CodeFlowMu Open 产品行为，且现有事实达到公共草稿预审最低质量。"
    : publicEligibility === "blocked_sensitive"
      ? "包含真实姓名、完整地址形态或证件信息，禁止进入公共草稿。"
      : publicEligibility === "local_only"
        ? "属于当前业务项目、部署或环境问题，应留在项目 ISSUE 中处理。"
        : "尚不能证明是 CodeFlowMu Open 产品缺陷，需补充事实。";
  const suggestedTitle = cause === "evidence_gate_false_positive"
    ? "REVIEW-GATE 误将文件型 QA 证据判为缺少 data.query"
    : String(frontmatter.summary ?? frontmatter.title ?? "").trim() || firstConcreteSentence(body);

  return {
    reporter,
    severity,
    severity_level: severityLevel(severity),
    effective_status: archivedParent.archived
      ? "historical"
      : effectiveResolved
        ? "resolved"
        : "active",
    ...(archivedParent.archived ? { parent_task_state: "archive" as const } : {}),
    ...(archivedParent.archived
      ? {
          inactive_reason: archivedParent.force
            ? ("parent_force_archived" as const)
            : ("parent_archived" as const),
        }
      : {}),
    source_severity: String(frontmatter.severity ?? "").trim() || undefined,
    analysis: {
      trigger_type: String(frontmatter.reason ?? "manual_issue") || "manual_issue",
      cause_type: cause,
      cause_summary: causeSummary,
      ownership_scope: ownership,
      public_eligibility: publicEligibility,
      public_reason: publicReason,
      privacy_risk: privacy,
      quality_score: quality.score,
      quality_level: quality.score >= 70 ? "good" : quality.score >= 45 ? "needs_improvement" : "insufficient",
      quality_issues: quality.issues,
      suggested_title: suggestedTitle,
      state_consistency: stateConsistency,
      impact_scope: impactScope,
      severity_reason: severityReason,
      current_status_judgment: archivedParent.archived
        ? "historical：关联父任务已归档；保留为历史证据，不代表缺陷已被业务修复。"
        : structuredResolved
          ? `resolved：ISSUE 结构化状态为 ${declaredStatus}；结案不自动代表关联 TASK 或 Session 完成。`
          : covered
            ? "resolved：来源 blocked/FAIL 已被同任务后续 done 回执覆盖，建议人工确认后结案。"
            : stateConsistency === "body_status_conflict"
              ? "active：正文声称已关闭，但结构化 status 仍为 open；需通过正式结案动作修正，不能只写正文状态。"
              : "active：尚未发现结构化结案或同任务更晚的 done 回执，仍需按建议动作处理。",
      recommended_action: action,
    },
  };
}
