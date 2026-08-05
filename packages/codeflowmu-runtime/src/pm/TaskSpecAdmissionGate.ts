/**
 * Runtime-owned task specification admission.
 *
 * This is deliberately evaluated before PM claim/session creation. It is an
 * application safety boundary, not an FCoP protocol rule.
 */

import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import { atomicWriteJson } from "../_internal/atomic-write.ts";
import {
  assertProjectExecutionContext,
  createProjectExecutionContext,
  type ProjectExecutionContext,
} from "../project/ProjectExecutionContext.ts";
import type { ParsedTask } from "../scheduler/TaskParser.ts";
import {
  classifyProductTask,
  type PmPlanningLevel,
} from "./ProductDeliveryGovernance.ts";

export const TASK_SPEC_INVALID = "TASK_SPEC_INVALID" as const;
export const TASK_SPEC_VALID = "TASK_SPEC_VALID" as const;

export type TaskSpecAdmissionFindingId =
  | "TOOL_CAPABILITY_MISMATCH"
  | "INTERNAL_INCONSISTENCY"
  | "PERMISSION_UNEXECUTABLE"
  | "LIFECYCLE_CONFLICT"
  | "ARTIFACT_UNIQUENESS_CONFLICT"
  | "CLASSIFICATION_CONFLICT"
  | "ENVIRONMENT_REFERENCE_MISSING"
  | "GATE_NOT_DECIDABLE"
  | "GIT_SAFETY_VIOLATION"
  | "PARENT_INVALID"
  | "ADMISSION_PROOF_MISSING"
  | "ADMISSION_DIGEST_MISMATCH";

export interface TaskSpecAdmissionFinding {
  id: TaskSpecAdmissionFindingId;
  finding_id: string;
  category: string;
  severity: "blocker" | "high" | "medium" | "info";
  section: string;
  line_start: number;
  line_end: number;
  original_excerpt: string;
  message: string;
  impact: string;
  required_capability: string;
  current_support: string;
  field?: string;
  requirement?: string;
  supported?: string;
  expected_level?: PmPlanningLevel;
  detected_level?: PmPlanningLevel;
  missing?: string[];
  evidence?: string[];
  expected?: string;
  actual?: string | string[];
  suggested_fix: string;
  suggested_replacement: string;
  can_auto_fix: boolean;
  decision_owner: string;
  recommended_decision: "needs_revision" | "needs_approval" | "rejected";
}

export interface TaskSpecCapabilityMatrixRow {
  task_step: string;
  execution_role: string;
  required_capability: string;
  available_tools: string[];
  current_policy: "allow" | "approval" | "deny" | "unsupported";
  risk: "low" | "medium" | "high" | "prohibited";
  conclusion: "executable" | "needs_approval" | "needs_revision" | "rejected";
  suggested_fix: string;
}

export interface TaskSpecAdmissionAccepted {
  decision: "accepted";
  code: typeof TASK_SPEC_VALID;
  task_id: string;
  content_digest: string;
  planning_level?: PmPlanningLevel;
  blocking_findings: [];
  capability_matrix: TaskSpecCapabilityMatrixRow[];
  authored_snapshot: TaskSpecAuthoredSnapshot;
  diagnostics?: TaskSpecAdmissionDiagnostics;
}

export interface TaskSpecAdmissionBlocked {
  decision: "needs_revision" | "needs_approval" | "rejected";
  code: typeof TASK_SPEC_INVALID;
  task_id: string;
  content_digest: string;
  planning_level?: PmPlanningLevel;
  blocking_findings: TaskSpecAdmissionFinding[];
  capability_matrix: TaskSpecCapabilityMatrixRow[];
  authored_snapshot: TaskSpecAuthoredSnapshot;
  diagnostics?: TaskSpecAdmissionDiagnostics;
}

export interface TaskSpecAuthoredSnapshot {
  schema_version: 1;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface TaskSpecAdmissionDiagnostics {
  validation_stage: "first_admission" | "continuation";
  project_context_id: string;
  project_context_digest: string;
  project_root: string;
  proof_path: string;
  submission_path: string | null;
  compared_fields: string[];
  differences: string[];
}

/** Backward-compatible name retained for existing callers. */
export type TaskSpecAdmissionRejected = TaskSpecAdmissionBlocked;

export type TaskSpecAdmissionResult =
  | TaskSpecAdmissionAccepted
  | TaskSpecAdmissionBlocked;

export interface TaskSpecAdmissionInput {
  projectRoot: string;
  task: ParsedTask;
}

const SUPPORTED_PM_FORMAL_TOOLS = new Set([
  "pm.write_planning_artifact",
  "pm.validate_long_horizon_plan",
  "pm.record_planning_skill_evidence",
  "pm.summarize_thread",
  "pm.detect_thread_stall",
  "pm.close_admin_task",
  "pm.wake_downstream",
  "pm.review_check",
  "pm.fact_check_decision",
  "pm.inspect_task_spec",
  "pm.inspect_capability_matrix",
  "pm.inspect_project_baseline",
  "pm.inspect_runtime_topology",
  "pm.create_child_task",
  "pm.request_operation_approval",
  "pm.capture_evidence",
  "write_task",
  "create_task",
]);

const LONG_RUNNING_LEVEL_3 =
  /长(?:期|周期|任务)|跨模块|架构(?:调整|重构)|系统(?:性|级)重构|大版本|多阶段|多里程碑|(?:^|\W)M0(?:\W|$)[\s\S]*(?:^|\W)M[1-9](?:\W|$)|long[- ]?running|long[- ]?term|cross[- ]?module|multi[- ]?milestone|architecture\s+refactor/i;
const IMPLEMENTATION_SIGNAL =
  /开发|实现|修改代码|重构|构建|交付|上线|部署|发布|修复|新增|改造|implement|develop|build|refactor|deploy|release|fix|feature/i;
const LEVEL_ZERO_SIGNAL =
  /巡检|检查|只读|查询|报告汇总|inspection|read[- ]?only|status\s*check/i;

function stringField(fm: Record<string, unknown>, key: string): string {
  const value = fm[key];
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value !== "string") return [];
  return value
    .split(/[,\n]/)
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function canonicalTaskId(value: unknown): string {
  const raw = String(value ?? "").trim().replace(/\.md$/i, "");
  return (
    raw.match(/^TASK-\d{8}-\d{3,}/i)?.[0].toUpperCase() ?? raw.toUpperCase()
  );
}

function taskIdOf(task: ParsedTask): string {
  return canonicalTaskId(task.task_id ?? task.frontmatter["task_id"] ?? task.filename);
}

const RUNTIME_OWNED_DIGEST_FIELDS = new Set([
  "task_id",
  "state",
  "dispatch_state",
  "submission_id",
  "admission_revision",
  "admission_digest",
  "created_at",
  "updated_at",
  "display_status",
  "lifecycle_projection",
  "physical_scope",
  "attempt_id",
  "lease_id",
  "session_id",
  "run_id",
  "dispatch_attempt",
  "dispatch_attempt_id",
  "dispatch_lease_id",
  "dispatch_last_error",
  "dispatch_next_retry_at",
  "dispatch_started_at",
  "dispatch_completed_at",
  "review_status",
  "pm_attention_reason",
  "pm_attention_report_id",
  "issue_blocking",
  "blocking_issue_id",
  "blocking_issue_reason",
  "superseded_by",
  "resolved_at",
  "finished_at",
  "approved_at",
  "archived_at",
]);

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJsonValue(item)]),
    );
  }
  return value;
}

function authoredBody(body: string): string {
  return (body.split(/\n---\n\n## state_history \(auto-appended by runtime\)/, 1)[0] ?? body)
    .replace(/\r\n/g, "\n")
    .trim();
}

export function taskSpecAuthoredSnapshot(task: ParsedTask): TaskSpecAuthoredSnapshot {
  return {
    schema_version: 1,
    frontmatter: Object.fromEntries(
      Object.entries(task.frontmatter)
        .filter(([key]) => !RUNTIME_OWNED_DIGEST_FIELDS.has(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, canonicalJsonValue(value)]),
    ),
    body: authoredBody(task.body),
  };
}

function digestSnapshot(snapshot: TaskSpecAuthoredSnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify(snapshot.frontmatter))
    .update("\n")
    .update(snapshot.body)
    .digest("hex");
}

/**
 * Digest only the authored task specification. Runtime-owned formal identity
 * fields are deliberately excluded so a checked submission and the TASK
 * created from it have the same digest.
 */
export function taskSpecContentDigest(task: ParsedTask): string {
  return digestSnapshot(taskSpecAuthoredSnapshot(task));
}

type TaskSpecAdmissionFindingInput = Pick<
  TaskSpecAdmissionFinding,
  "id" | "message"
> &
  Partial<Omit<TaskSpecAdmissionFinding, "id" | "message">>;

function findingCategory(id: TaskSpecAdmissionFindingId): string {
  if (id === "TOOL_CAPABILITY_MISMATCH") return "capability";
  if (id === "PERMISSION_UNEXECUTABLE") return "authorization";
  if (id === "LIFECYCLE_CONFLICT" || id === "PARENT_INVALID") return "lifecycle";
  if (id === "ARTIFACT_UNIQUENESS_CONFLICT" || id === "CLASSIFICATION_CONFLICT") {
    return "planning";
  }
  if (id === "ENVIRONMENT_REFERENCE_MISSING") return "environment";
  if (id === "GATE_NOT_DECIDABLE") return "acceptance_gate";
  if (id === "GIT_SAFETY_VIOLATION") return "operation_risk";
  if (id.startsWith("ADMISSION_")) return "admission_integrity";
  return "consistency";
}

function findingRecommendedDecision(
  id: TaskSpecAdmissionFindingId,
): TaskSpecAdmissionFinding["recommended_decision"] {
  if (id === "PERMISSION_UNEXECUTABLE") return "rejected";
  if (id === "GIT_SAFETY_VIOLATION") return "needs_approval";
  return "needs_revision";
}

function materializeFinding(
  finding: TaskSpecAdmissionFindingInput,
): TaskSpecAdmissionFinding {
  const recommended = finding.recommended_decision ?? findingRecommendedDecision(finding.id);
  const severity =
    finding.severity ??
    (recommended === "rejected"
      ? "blocker"
      : recommended === "needs_approval"
        ? "high"
        : "medium");
  const suggestedFix =
    finding.suggested_fix ??
    (recommended === "needs_approval"
      ? "remove the risky action or request explicit ADMIN pre-authorization"
      : recommended === "rejected"
        ? "remove the prohibited requirement; it cannot be authorized"
        : "revise the task specification so the requirement has one executable interpretation");
  const excerpt =
    finding.original_excerpt ??
    finding.evidence?.[0] ??
    (Array.isArray(finding.actual) ? finding.actual[0] : finding.actual) ??
    finding.field ??
    finding.message;
  return {
    ...finding,
    id: finding.id,
    finding_id: finding.finding_id ?? finding.id,
    category: finding.category ?? findingCategory(finding.id),
    severity,
    section: finding.section ?? (finding.field ? `frontmatter.${finding.field}` : "task_body"),
    line_start: Math.max(1, finding.line_start ?? 1),
    line_end: Math.max(1, finding.line_end ?? finding.line_start ?? 1),
    original_excerpt: String(excerpt).slice(0, 500),
    message: finding.message,
    impact:
      finding.impact ??
      (recommended === "rejected"
        ? "The request crosses a permanent governance boundary."
        : recommended === "needs_approval"
          ? "Formal execution must not start until the exact risky operation is approved."
          : "The task cannot be executed deterministically as written."),
    required_capability:
      finding.required_capability ?? finding.requirement ?? finding.field ?? findingCategory(finding.id),
    current_support:
      finding.current_support ?? finding.supported ?? "not executable from the current specification",
    suggested_fix: suggestedFix,
    suggested_replacement: finding.suggested_replacement ?? suggestedFix,
    can_auto_fix: finding.can_auto_fix ?? false,
    decision_owner:
      finding.decision_owner ?? (recommended === "needs_approval" ? "ADMIN" : "TASK_AUTHOR"),
    recommended_decision: recommended,
  };
}

function addFinding(
  findings: TaskSpecAdmissionFinding[],
  finding: TaskSpecAdmissionFindingInput,
): void {
  const complete = materializeFinding(finding);
  const key = `${complete.id}:${complete.field ?? ""}:${complete.message}`;
  if (
    !findings.some(
      (item) => `${item.id}:${item.field ?? ""}:${item.message}` === key,
    )
  ) {
    findings.push(complete);
  }
}

function locateFindingInTask(
  task: ParsedTask,
  finding: TaskSpecAdmissionFinding,
): TaskSpecAdmissionFinding {
  const frontmatterLines = Object.entries(task.frontmatter).map(
    ([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
  const bodyLines = task.body.replace(/\r\n/g, "\n").split("\n");
  const lines = [...frontmatterLines, "---", ...bodyLines];
  const candidates = [
    finding.original_excerpt,
    finding.field,
    ...(finding.evidence ?? []),
    ...(finding.missing ?? []),
  ]
    .map((value) => String(value ?? "").trim())
    .filter((value) => value.length >= 2);
  let index = lines.findIndex((line) =>
    candidates.some((candidate) => line.toLowerCase().includes(candidate.toLowerCase())),
  );
  if (index < 0) index = Math.min(frontmatterLines.length + 1, Math.max(0, lines.length - 1));
  const inFrontmatter = index < frontmatterLines.length;
  let section = inFrontmatter ? "frontmatter" : "task_body";
  if (!inFrontmatter) {
    for (let cursor = index; cursor >= frontmatterLines.length + 1; cursor -= 1) {
      const heading = lines[cursor]?.match(/^#{1,6}\s+(.+)$/);
      if (heading?.[1]) {
        section = heading[1].trim();
        break;
      }
    }
  }
  return {
    ...finding,
    section,
    line_start: index + 1,
    line_end: index + 1,
    original_excerpt: String(lines[index] ?? finding.original_excerpt).trim().slice(0, 500),
  };
}

function buildCapabilityMatrix(task: ParsedTask): TaskSpecCapabilityMatrixRow[] {
  const explicitTools = [
    ...stringList(task.frontmatter["required_tools"]),
    ...stringList(task.frontmatter["formal_tools"]),
  ];
  const steps = task.body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(?:\d+[.)]|[-*])\s+/.test(line))
    .slice(0, 80);
  if (steps.length === 0) steps.push(task.body.trim().split(/\r?\n/, 1)[0] || "execute task");
  return steps.map((step) => {
    const roleMatch = step.match(/\b(PM|DEV|QA|OPS|ADMIN|EVAL)(?:-\d+)?\b/i);
    const executionRole = roleMatch?.[1]?.toUpperCase() ?? "UNASSIGNED";
    const mentionedTool = explicitTools.find((tool) => step.includes(tool));
    const risky =
      /\bpush\b|\btag\b|\brelease\b|部署|删除|清理|安装|卸载|重启|权限|上传|发送|提交表单/i.test(
        step,
      );
    const prohibited = /绕过|冒充|force\s+push|push\s+--force|凭据.*(?:回显|外传)/i.test(step);
    const unsupported = Boolean(
      mentionedTool && !SUPPORTED_PM_FORMAL_TOOLS.has(mentionedTool),
    );
    return {
      task_step: step.replace(/^(?:\d+[.)]|[-*])\s+/, "").slice(0, 500),
      execution_role: executionRole,
      required_capability: mentionedTool ?? (risky ? "operation.approval" : "task.execution"),
      available_tools: mentionedTool && SUPPORTED_PM_FORMAL_TOOLS.has(mentionedTool)
        ? [mentionedTool]
        : [],
      current_policy: prohibited
        ? "deny"
        : unsupported
          ? "unsupported"
          : risky
            ? "approval"
            : "allow",
      risk: prohibited ? "prohibited" : risky ? "high" : "low",
      conclusion: prohibited
        ? "rejected"
        : unsupported
          ? "needs_revision"
          : risky
            ? "needs_approval"
            : "executable",
      suggested_fix: prohibited
        ? "remove the prohibited operation"
        : unsupported
          ? "replace the unavailable tool or add a supported capability"
          : risky
            ? "bind exact targets, preview, digest, expiry and rollback in an ADMIN approval"
            : "none",
    };
  });
}

function collectNamedValues(body: string, name: string): string[] {
  const values: string[] = [];
  const pattern = new RegExp(
    `(?:^|\\n)\\s*(?:[-*]\\s*)?(?:${name})\\s*[:=]\\s*[\\x60"']?([^\\n\\x60"']+)`,
    "gi",
  );
  for (const match of body.matchAll(pattern)) {
    const value = String(match[1] ?? "").trim().replace(/[，,。.;；]+$/, "");
    if (value) values.push(value);
  }
  return [...new Set(values.map((value) => value.toLowerCase()))];
}

function checkInternalConsistency(
  task: ParsedTask,
  findings: TaskSpecAdmissionFinding[],
): void {
  const fm = task.frontmatter;
  const checks: Array<[string, string[]]> = [
    ["thread_key", collectNamedValues(task.body, "thread_key")],
    ["parent", collectNamedValues(task.body, "parent(?:_task_id)?")],
    ["branch", collectNamedValues(task.body, "(?:git_)?branch|分支")],
    ["port", collectNamedValues(task.body, "(?:panel_)?port|端口")],
    ["project_dir", collectNamedValues(task.body, "project_dir|项目目录|工作目录")],
  ];
  for (const [field, bodyValues] of checks) {
    const fmValue = stringField(fm, field).toLowerCase();
    const values = [...new Set([...(fmValue ? [fmValue] : []), ...bodyValues])];
    if (values.length > 1) {
      addFinding(findings, {
        id: "INTERNAL_INCONSISTENCY",
        field,
        message: `${field} has conflicting values`,
        evidence: values,
      });
    }
  }

  const declaredSender = String(task.sender ?? fm["sender"] ?? "").toUpperCase();
  const declaredRecipient = String(
    task.recipient ?? fm["recipient"] ?? "",
  ).toUpperCase();
  const bodySenders = collectNamedValues(task.body, "sender|发送方").map(
    (value) => value.toUpperCase(),
  );
  const bodyRecipients = collectNamedValues(task.body, "recipient|接收方").map(
    (value) => value.toUpperCase(),
  );
  const conflictingRoutes = [
    ...bodySenders
      .filter((value) => value !== declaredSender)
      .map((value) => `sender=${value}`),
    ...bodyRecipients
      .filter((value) => value !== declaredRecipient)
      .map((value) => `recipient=${value}`),
  ];
  if (conflictingRoutes.length) {
    addFinding(findings, {
      id: "INTERNAL_INCONSISTENCY",
      field: "route",
      message: "task body routing fields conflict with frontmatter",
      evidence: [
        `sender=${declaredSender}`,
        `recipient=${declaredRecipient}`,
        ...conflictingRoutes,
      ],
    });
  }
}

function checkPermissionAndLifecycle(
  task: ParsedTask,
  body: string,
  findings: TaskSpecAdmissionFinding[],
): void {
  if (
    /绕过(?:权限|审批|门禁)|忽略(?:权限|审批|门禁)|直接写入(?:受控|保护|禁止)区域|bypass\s+(?:permission|approval|gate)|write\s+directly\s+to\s+(?:controlled|protected)/i.test(
      body,
    )
  ) {
    addFinding(findings, {
      id: "PERMISSION_UNEXECUTABLE",
      message: "task requires bypassing an authorization or controlled-write boundary",
    });
  }

  const waitsForApproval =
    /停止并等待\s*(?:ADMIN|人工|审批|批准)|等待\s*(?:ADMIN|人工)?\s*(?:审批|批准)后再继续|stop\s+and\s+wait\s+for\s+approval/i.test(
      body,
    );
  const continuesWork =
    /同时|随后|之后|并且|继续|while|then|simultaneously/i.test(body) &&
    /派发(?:子任务|下游)|继续(?:执行|开发|实施|派发)|生成子任务|dispatch\s+(?:children|downstream)|continue\s+(?:execution|dispatch)/i.test(
      body,
    );
  if (waitsForApproval && continuesWork) {
    addFinding(findings, {
      id: "LIFECYCLE_CONFLICT",
      message: "task requires both stopping for approval and continuing execution/dispatch",
    });
  }

  const localCandidate =
    /^(?:local[_ -]?candidate|local[_ -]?validation|local[_ -]?test)$/i.test(
      stringField(task.frontmatter, "environment"),
    ) ||
    /本地(?:候选|验证|测试|预发布)?环境|local\s+(?:candidate|validation|test|staging)\s+environment/i.test(
      body,
    );
  const remoteMutation =
    stringList(task.frontmatter["git_actions"]).some((action) =>
      /^(?:push|tag|release|deploy(?:_production)?)$/i.test(action),
    ) ||
    /\bgit\s+push\b|\bpush\b.*(?:GitHub|远端|remote)|\bgit\s+tag\b|创建(?:远端)?标签|发布(?:正式)?版本|release\s+(?:to|on)|deploy\s+production/i.test(
      body,
    );
  if (localCandidate && remoteMutation) {
    addFinding(findings, {
      id: "GIT_SAFETY_VIOLATION",
      message: "local candidate work must not require push, tag, release, or production deployment",
    });
  }
}

function countRequestedPlanningArtifacts(
  task: ParsedTask,
): { count: number; evidence: string[] } {
  const fmArtifacts = [
    ...stringList(task.frontmatter["planning_artifacts"]),
    ...stringList(task.frontmatter["formal_artifacts"]),
  ];
  const evidence = [...fmArtifacts];
  const numeric = task.body.match(
    /(?:生成|创建|交付|编制|输出)\s*(\d+|[一二三四五六七八九十]+)\s*份[^。\n]{0,40}(?:规划|计划|brief|plan)[^。\n]{0,20}(?:文件|文档|产物)?/i,
  );
  const chineseNumbers: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  const explicitCount = numeric
    ? Number(numeric[1]) || chineseNumbers[String(numeric[1])] || 0
    : 0;
  if (numeric?.[0]) evidence.push(numeric[0]);

  const contradictorySet = task.body.match(
    /(?:一份|1\s*份)?\s*(?:正式\s*)?(?:Product Brief|产品简报)[\s\S]{0,160}(?:以及|并且|同时|外加|\+)[\s\S]{0,80}(\d+|[二三四五六七八九十]+)\s*份[^。\n]{0,40}(?:规划|计划|PLAN)[^。\n]{0,20}(?:文件|文档|产物)/i,
  );
  const contradictoryCount = contradictorySet
    ? Number(contradictorySet[1]) ||
      chineseNumbers[String(contradictorySet[1])] ||
      0
    : 0;
  if (contradictorySet?.[0]) evidence.push(contradictorySet[0]);
  return {
    count: Math.max(
      explicitCount,
      fmArtifacts.length,
      contradictoryCount > 0 ? contradictoryCount + 1 : 0,
    ),
    evidence: [...new Set(evidence)],
  };
}

function checkToolAndArtifactCapability(
  task: ParsedTask,
  findings: TaskSpecAdmissionFinding[],
): void {
  const requiredTools = [
    ...stringList(task.frontmatter["required_tools"]),
    ...stringList(task.frontmatter["formal_tools"]),
  ];
  for (const match of task.body.matchAll(
    /(?:必须|仅可|要求)\s*(?:使用|调用)\s*[`"'](pm\.[A-Za-z0-9_.-]+)[`"']/gi,
  )) {
    requiredTools.push(match[1]!);
  }
  const unsupported = [...new Set(requiredTools)].filter(
    (tool) => !SUPPORTED_PM_FORMAL_TOOLS.has(tool),
  );
  if (unsupported.length > 0) {
    addFinding(findings, {
      id: "TOOL_CAPABILITY_MISMATCH",
      field: "required_tools",
      message: "task requires formal PM tools that Runtime does not expose",
      requirement: unsupported.join(", "),
      supported: [...SUPPORTED_PM_FORMAL_TOOLS].sort().join(", "),
    });
  }

  const artifacts = countRequestedPlanningArtifacts(task);
  if (artifacts.count > 1) {
    addFinding(findings, {
      id: "ARTIFACT_UNIQUENESS_CONFLICT",
      field: "planning_artifacts",
      message: `task requests ${artifacts.count} formal planning artifacts; Runtime supports one canonical PLAN/Product Brief per root task`,
      requirement: `${artifacts.count} formal planning artifacts`,
      supported: "one canonical planning artifact through pm.write_planning_artifact",
      evidence: artifacts.evidence,
    });
    addFinding(findings, {
      id: "TOOL_CAPABILITY_MISMATCH",
      field: "planning_artifacts",
      message: "pm.write_planning_artifact cannot generate multiple independently authoritative planning files",
      requirement: `${artifacts.count} formal planning artifacts`,
      supported: "one canonical PLAN/Product Brief",
    });
  }
}

function expectedPlanningFloor(task: ParsedTask): PmPlanningLevel {
  const text = `${task.body}\n${JSON.stringify(task.frontmatter)}`;
  if (LONG_RUNNING_LEVEL_3.test(text) && IMPLEMENTATION_SIGNAL.test(text)) return 3;
  if (IMPLEMENTATION_SIGNAL.test(text)) return 1;
  return 0;
}

function checkPlanningClassification(
  task: ParsedTask,
  findings: TaskSpecAdmissionFinding[],
): PmPlanningLevel {
  const classification = classifyProductTask(task.body, task.frontmatter);
  const expected = expectedPlanningFloor(task);
  const declaredRaw = Number(
    task.frontmatter["planning_level"] ?? task.frontmatter["pm_planning_level"],
  );
  const declared = [0, 1, 2, 3].includes(declaredRaw)
    ? (declaredRaw as PmPlanningLevel)
    : undefined;
  const detected = declared ?? classification.planning_level;
  if (detected < expected) {
    addFinding(findings, {
      id: "CLASSIFICATION_CONFLICT",
      field: "planning_level",
      message: "declared/detected planning level is below the task's minimum complexity",
      expected_level: expected,
      detected_level: detected,
      evidence:
        LEVEL_ZERO_SIGNAL.test(task.body) && expected === 3
          ? ["level-zero wording coexists with long-running cross-module implementation"]
          : undefined,
    });
  }
  return classification.planning_level;
}

function gateSections(body: string): Array<{ name: string; body: string }> {
  const heading = /^(#{1,6})\s*((?:Gate\s*)?M\d+|Gate\s+[^#\n]+)\s*$/gim;
  const matches = [...body.matchAll(heading)];
  return matches.map((match, index) => ({
    name: String(match[2] ?? "").trim(),
    body: body.slice(
      (match.index ?? 0) + match[0].length,
      matches[index + 1]?.index ?? body.length,
    ),
  }));
}

function checkGateDecidability(
  task: ParsedTask,
  body: string,
  findings: TaskSpecAdmissionFinding[],
): void {
  const structured = task.frontmatter["gates"];
  if (Array.isArray(structured)) {
    for (const [index, rawGate] of structured.entries()) {
      if (!rawGate || typeof rawGate !== "object" || Array.isArray(rawGate)) {
        addFinding(findings, {
          id: "GATE_NOT_DECIDABLE",
          field: `gates[${index}]`,
          message: `gates[${index}] must be an object`,
          missing: ["input", "evidence", "approver", "exit_condition"],
        });
        continue;
      }
      const gate = rawGate as Record<string, unknown>;
      const missing = ["input", "evidence", "approver", "exit_condition"].filter(
        (field) => {
          const value = gate[field];
          return value == null || String(value).trim().length === 0;
        },
      );
      if (missing.length > 0) {
        addFinding(findings, {
          id: "GATE_NOT_DECIDABLE",
          field: String(gate["id"] ?? gate["name"] ?? `gates[${index}]`),
          message: "structured gate lacks a decidable acceptance contract",
          missing,
        });
      }
    }
  }
  for (const gate of gateSections(body)) {
    const required = [
      ["input", /输入|前置条件|entry|input/i],
      ["evidence", /证据|evidence/i],
      ["approver", /批准者|审批人|approver|owner/i],
      ["exit_condition", /退出条件|完成条件|exit\s*condition/i],
    ] as const;
    const missing = required
      .filter(([, pattern]) => !pattern.test(gate.body))
      .map(([name]) => name);
    if (missing.length > 0) {
      addFinding(findings, {
        id: "GATE_NOT_DECIDABLE",
        field: gate.name,
        message: `${gate.name} lacks a decidable acceptance contract`,
        missing,
      });
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function resolveRequiredPath(projectRoot: string, raw: string): string | null {
  const cleaned = raw.trim().replace(/^['"`]|['"`]$/g, "");
  if (!cleaned || /[*?<>|]/.test(cleaned)) return null;
  const absolute = isAbsolute(cleaned) ? resolve(cleaned) : resolve(projectRoot, cleaned);
  const rel = relative(resolve(projectRoot), absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) return absolute;
  return absolute;
}

async function checkEnvironmentTruth(
  projectRoot: string,
  task: ParsedTask,
  findings: TaskSpecAdmissionFinding[],
): Promise<void> {
  const refs = [
    ...stringList(task.frontmatter["required_paths"]),
    ...stringList(task.frontmatter["existing_paths"]),
    ...stringList(task.frontmatter["required_documents"]),
  ];
  for (const match of task.body.matchAll(
    /(?:引用|读取|基于|检查|现有|必须存在的?)\s*(?:目录|路径|文档|文件)\s*[:：]?\s*[`"']([^`"'\n]+)[`"']/gi,
  )) {
    refs.push(match[1]!);
  }
  const missing: string[] = [];
  for (const ref of [...new Set(refs)]) {
    const target = resolveRequiredPath(projectRoot, ref);
    if (target && !(await exists(target))) missing.push(ref);
  }
  if (missing.length > 0) {
    addFinding(findings, {
      id: "ENVIRONMENT_REFERENCE_MISSING",
      field: "required_paths",
      message: "task references required paths/documents that do not exist",
      missing,
    });
  }
}

async function checkProjectConfigConsistency(
  projectRoot: string,
  task: ParsedTask,
  findings: TaskSpecAdmissionFinding[],
): Promise<void> {
  const configuredRoot =
    stringField(task.frontmatter, "project_root") ||
    stringField(task.frontmatter, "project_dir");
  const resolvedConfiguredRoot = configuredRoot
    ? isAbsolute(configuredRoot)
      ? resolve(configuredRoot)
      : resolve(projectRoot, configuredRoot)
    : "";
  if (configuredRoot && resolvedConfiguredRoot !== resolve(projectRoot)) {
    addFinding(findings, {
      id: "INTERNAL_INCONSISTENCY",
      field: "project_root",
      message: "task project root does not match the active Runtime project",
      evidence: [configuredRoot, projectRoot],
    });
  }

  let config: Record<string, unknown>;
  try {
    const parsed = JSON.parse(
      await readFile(join(projectRoot, "codeflowmu.team.json"), "utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    config = parsed as Record<string, unknown>;
  } catch {
    return;
  }

  const members = Array.isArray(config["members"])
    ? (config["members"] as unknown[])
    : [];
  const roles = new Set(
    members
      .filter(
        (member): member is Record<string, unknown> =>
          !!member && typeof member === "object" && !Array.isArray(member),
      )
      .map((member) => String(member["role"] ?? "").trim().toUpperCase())
      .filter(Boolean),
  );
  roles.add("ADMIN");
  roles.add("SYSTEM");
  for (const [field, value] of [
    ["sender", task.sender ?? task.frontmatter["sender"]],
    ["recipient", task.recipient ?? task.frontmatter["recipient"]],
  ] as const) {
    const role = String(value ?? "").trim().toUpperCase();
    if (role && !roles.has(role)) {
      addFinding(findings, {
        id: "INTERNAL_INCONSISTENCY",
        field,
        message: `${field} role is not present in the active team model`,
        evidence: [role],
      });
    }
  }

  const configuredPort = Number(config["panel_port"]);
  const declaredPort = Number(
    task.frontmatter["panel_port"] ?? task.frontmatter["port"],
  );
  if (
    Number.isInteger(configuredPort) &&
    Number.isInteger(declaredPort) &&
    configuredPort !== declaredPort
  ) {
    addFinding(findings, {
      id: "INTERNAL_INCONSISTENCY",
      field: "panel_port",
      message: "task panel port conflicts with codeflowmu.team.json",
      evidence: [String(declaredPort), String(configuredPort)],
    });
  }
}

async function walkTaskFiles(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walkTaskFiles(path, out);
    else if (/^TASK-.*\.md$/i.test(entry.name)) out.push(path);
  }
}

async function buildTaskPathIndex(
  projectRoot: string,
): Promise<Map<string, string>> {
  const files: string[] = [];
  for (const root of [
    join(projectRoot, "fcop", "_lifecycle"),
    join(projectRoot, "fcop", "tasks"),
    join(projectRoot, "fcop", "log"),
  ]) {
    await walkTaskFiles(root, files);
  }
  const index = new Map<string, string>();
  for (const path of files) {
    const filename = path.replace(/\\/g, "/").split("/").pop() ?? "";
    const filenameId = canonicalTaskId(filename);
    if (filenameId) index.set(filenameId, path);
    try {
      const parsed = parseFrontmatter(await readFile(path, "utf8"));
      const frontmatterId = canonicalTaskId(parsed["task_id"]);
      if (frontmatterId) index.set(frontmatterId, path);
    } catch {
      // Unreadable historical tasks are not eligible parents.
    }
  }
  return index;
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const parsed = parseYaml(match[1] ?? "");
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function lifecycleClosed(path: string, fm: Record<string, unknown>): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const state = String(
    fm["state"] ?? fm["status"] ?? fm["display_status"] ?? "",
  ).toLowerCase();
  return (
    /\/(?:done|archive)\//.test(normalized) ||
    ["done", "archive", "archived", "closed", "cancelled", "canceled"].includes(
      state,
    )
  );
}

async function checkParent(
  projectRoot: string,
  task: ParsedTask,
  findings: TaskSpecAdmissionFinding[],
): Promise<void> {
  const rawParent =
    stringField(task.frontmatter, "parent") ||
    stringField(task.frontmatter, "parent_task_id");
  if (!rawParent) return;

  const childId = taskIdOf(task);
  const parentId = canonicalTaskId(rawParent);
  if (!parentId || parentId === childId) {
    addFinding(findings, {
      id: "PARENT_INVALID",
      field: "parent",
      message: parentId === childId ? "task cannot be its own parent" : "parent task id is invalid",
      evidence: [rawParent],
    });
    return;
  }

  const visited = new Set([childId]);
  const taskIndex = await buildTaskPathIndex(projectRoot);
  let currentId = parentId;
  let firstParent: { path: string; fm: Record<string, unknown> } | null = null;
  while (currentId) {
    if (visited.has(currentId)) {
      addFinding(findings, {
        id: "PARENT_INVALID",
        field: "parent",
        message: "parent relationship would create a cycle",
        evidence: [...visited, currentId],
      });
      return;
    }
    visited.add(currentId);
    const path = taskIndex.get(currentId) ?? null;
    if (!path) {
      addFinding(findings, {
        id: "PARENT_INVALID",
        field: "parent",
        message: "parent task does not exist",
        evidence: [currentId],
      });
      return;
    }
    const fm = parseFrontmatter(await readFile(path, "utf8"));
    if (!firstParent) firstParent = { path, fm };
    const next =
      stringField(fm, "parent") || stringField(fm, "parent_task_id");
    currentId = next ? canonicalTaskId(next) : "";
  }

  if (!firstParent) return;
  if (lifecycleClosed(firstParent.path, firstParent.fm)) {
    addFinding(findings, {
      id: "PARENT_INVALID",
      field: "parent",
      message: "parent task is closed, done, or archived",
      evidence: [parentId],
    });
  }
  const childThread = String(task.thread_key ?? task.frontmatter["thread_key"] ?? "").trim();
  const parentThread = stringField(firstParent.fm, "thread_key");
  if (!childThread || (parentThread && childThread !== parentThread)) {
    addFinding(findings, {
      id: "INTERNAL_INCONSISTENCY",
      field: "thread_key",
      message: !childThread
        ? "child task must inherit its parent's thread_key"
        : "child task thread_key does not match its parent",
      evidence: [childThread || "(missing)", parentThread || "(missing on parent)"],
    });
  }
}

export async function evaluateTaskSpecAdmission(
  input: TaskSpecAdmissionInput,
): Promise<TaskSpecAdmissionResult> {
  const { projectRoot, task } = input;
  const findings: TaskSpecAdmissionFinding[] = [];
  const sender = String(task.sender ?? task.frontmatter["sender"] ?? "").toUpperCase();
  const recipient = String(
    task.recipient ?? task.frontmatter["recipient"] ?? "",
  ).toUpperCase();

  await checkParent(projectRoot, task, findings);

  let planningLevel: PmPlanningLevel | undefined;
  if (sender === "ADMIN" && recipient === "PM") {
    checkInternalConsistency(task, findings);
    checkPermissionAndLifecycle(task, task.body, findings);
    checkToolAndArtifactCapability(task, findings);
    planningLevel = checkPlanningClassification(task, findings);
    checkGateDecidability(task, task.body, findings);
    await checkEnvironmentTruth(projectRoot, task, findings);
    await checkProjectConfigConsistency(projectRoot, task, findings);
  }

  const base = {
    task_id: taskIdOf(task),
    content_digest: taskSpecContentDigest(task),
    authored_snapshot: taskSpecAuthoredSnapshot(task),
    ...(planningLevel != null ? { planning_level: planningLevel } : {}),
    capability_matrix: buildCapabilityMatrix(task),
  };
  if (findings.length === 0) {
    return {
      ...base,
      decision: "accepted",
      code: TASK_SPEC_VALID,
      blocking_findings: [],
    };
  }
  const located = findings.map((finding) => locateFindingInTask(task, finding));
  const decisions = new Set(located.map((finding) => finding.recommended_decision));
  const decision: TaskSpecAdmissionBlocked["decision"] = decisions.has("rejected")
    ? "rejected"
    : decisions.has("needs_revision")
      ? "needs_revision"
      : "needs_approval";
  return {
    ...base,
    decision,
    code: TASK_SPEC_INVALID,
    blocking_findings: located,
  };
}

export function taskSpecAdmissionRecordPath(
  projectRoot: string,
  taskId: string,
): string {
  const safe = canonicalTaskId(taskId).replace(/[^A-Z0-9._-]/g, "-");
  return join(projectRoot, ".codeflowmu", "task-spec-admission", `${safe}.json`);
}

export async function persistTaskSpecAdmissionResult(
  projectRoot: string,
  result: TaskSpecAdmissionResult,
  metadata: {
    submission_id?: string;
    formal_task_id?: string;
    admission_revision?: number;
  } = {},
): Promise<{ path: string; changed: boolean }> {
  const formalTaskId = metadata.formal_task_id ?? result.task_id;
  const path = taskSpecAdmissionRecordPath(projectRoot, formalTaskId);
  try {
    const existing = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    if (
      existing["content_digest"] === result.content_digest &&
      existing["decision"] === result.decision &&
      existing["code"] === result.code &&
      existing["submission_id"] === metadata.submission_id &&
      existing["formal_task_id"] === formalTaskId &&
      Number(existing["admission_revision"] ?? 0) ===
        Number(metadata.admission_revision ?? 0) &&
      JSON.stringify(existing["blocking_findings"] ?? []) ===
        JSON.stringify(result.blocking_findings) &&
      JSON.stringify(existing["authored_snapshot"] ?? null) ===
        JSON.stringify(result.authored_snapshot)
    ) {
      return { path, changed: false };
    }
  } catch {
    // Missing or invalid prior result is replaced by the current evaluation.
  }
  await atomicWriteJson(
    path,
    `${JSON.stringify(
      {
        ...result,
        authored_snapshot_schema: "task-authored-spec/v1",
        project_root: resolve(projectRoot),
        ...(metadata.submission_id
          ? { submission_id: metadata.submission_id }
          : {}),
        formal_task_id: formalTaskId,
        ...(metadata.admission_revision != null
          ? { admission_revision: metadata.admission_revision }
          : {}),
        checked_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return { path, changed: true };
}

function parseRecordedSnapshot(value: unknown): TaskSpecAuthoredSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row["schema_version"] !== 1 || !row["frontmatter"] || typeof row["frontmatter"] !== "object") {
    return null;
  }
  return {
    schema_version: 1,
    frontmatter: canonicalJsonValue(row["frontmatter"]) as Record<string, unknown>,
    body: String(row["body"] ?? "").replace(/\r\n/g, "\n").trim(),
  };
}

/** Reconstruct pre-v1 snapshot proofs from the immutable submission record. */
function snapshotFromSubmissionRecord(
  submission: Record<string, unknown> | null,
): TaskSpecAuthoredSnapshot | null {
  if (!submission) return null;
  const subject = String(submission["subject"] ?? "").trim();
  const draftBody = String(submission["draft_body"] ?? "").trim();
  const priority = String(submission["requested_priority"] ?? "").trim();
  const threadKey = String(submission["formal_thread_key"] ?? "").trim();
  if (!subject || !threadKey) return null;
  const references = Array.isArray(submission["requested_references"])
    ? submission["requested_references"]
    : [];
  const attachments = Array.isArray(submission["requested_attachments"])
    ? submission["requested_attachments"]
    : [];
  return {
    schema_version: 1,
    frontmatter: canonicalJsonValue({
      protocol: "fcop",
      version: "1.0",
      sender: "ADMIN",
      recipient: "PM",
      priority: priority || "P2",
      thread_key: threadKey,
      parent: submission["requested_parent"] ?? "",
      references,
      ...(attachments.length > 0 ? { attachments } : {}),
    }) as Record<string, unknown>,
    body: `# ${subject}\n\n${draftBody}`.trim(),
  };
}

function projectTaskOntoSnapshot(
  task: ParsedTask,
  expected: TaskSpecAuthoredSnapshot,
): TaskSpecAuthoredSnapshot {
  const frontmatter = Object.fromEntries(
    Object.keys(expected.frontmatter)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, canonicalJsonValue(task.frontmatter[key])]),
  );
  return { schema_version: 1, frontmatter, body: authoredBody(task.body) };
}

function diffAuthoredSnapshots(
  expected: TaskSpecAuthoredSnapshot,
  actual: TaskSpecAuthoredSnapshot,
): string[] {
  const differences: string[] = [];
  for (const key of new Set([
    ...Object.keys(expected.frontmatter),
    ...Object.keys(actual.frontmatter),
  ])) {
    if (JSON.stringify(expected.frontmatter[key]) !== JSON.stringify(actual.frontmatter[key])) {
      differences.push(`frontmatter.${key}`);
    }
  }
  if (expected.body !== actual.body) differences.push("task_body");
  return differences;
}

function resultFromAdmissionRecord(
  record: Record<string, unknown> | null,
  taskId: string,
  fallbackSnapshot: TaskSpecAuthoredSnapshot,
): TaskSpecAdmissionResult {
  const snapshot = parseRecordedSnapshot(record?.["authored_snapshot"]) ?? fallbackSnapshot;
  const matrix = Array.isArray(record?.["capability_matrix"])
    ? record!["capability_matrix"] as TaskSpecCapabilityMatrixRow[]
    : [];
  const planningLevel = Number(record?.["planning_level"]);
  return {
    decision: "accepted",
    code: TASK_SPEC_VALID,
    task_id: taskId,
    content_digest: String(record?.["content_digest"] ?? digestSnapshot(snapshot)),
    ...([0, 1, 2, 3].includes(planningLevel)
      ? { planning_level: planningLevel as PmPlanningLevel }
      : {}),
    blocking_findings: [],
    capability_matrix: matrix,
    authored_snapshot: snapshot,
  };
}

export async function verifyTaskSpecAdmissionForDispatch(input: {
  projectRoot: string;
  task: ParsedTask;
  stage?: "first_admission" | "continuation";
  projectContext?: ProjectExecutionContext;
}): Promise<TaskSpecAdmissionResult> {
  const stage = input.stage ?? "first_admission";
  const projectContext = input.projectContext ?? createProjectExecutionContext({
    projectRoot: input.projectRoot,
  });
  assertProjectExecutionContext(projectContext, input.projectRoot);
  const projectRoot = projectContext.project_root;
  const sender = String(
    input.task.sender ?? input.task.frontmatter["sender"] ?? "",
  ).toUpperCase();
  const recipient = String(
    input.task.recipient ?? input.task.frontmatter["recipient"] ?? "",
  ).toUpperCase();
  if (sender !== "ADMIN" || recipient !== "PM") {
    const evaluated = await evaluateTaskSpecAdmission({ projectRoot, task: input.task });
    return evaluated.decision === "accepted"
      ? evaluated
      : { ...evaluated, decision: "rejected", code: TASK_SPEC_INVALID };
  }

  const submissionId = String(
    input.task.frontmatter["submission_id"] ?? "",
  ).trim();
  if (!submissionId) {
    // Legacy valid tasks are admitted once on first dispatch. Legacy invalid
    // tasks are rejected by the evaluation above and can never reach Session.
    const evaluated = await evaluateTaskSpecAdmission({ projectRoot, task: input.task });
    await persistTaskSpecAdmissionResult(projectRoot, evaluated);
    return evaluated.decision === "accepted"
      ? evaluated
      : { ...evaluated, decision: "rejected", code: TASK_SPEC_INVALID };
  }

  const taskId = taskIdOf(input.task);
  const recordPath = taskSpecAdmissionRecordPath(projectRoot, taskId);
  const safeSubmissionId = submissionId.replace(/[^A-Za-z0-9._-]/g, "-");
  const submissionPath = join(
    projectContext.task_submission_root,
    `${safeSubmissionId}.json`,
  );
  let record: Record<string, unknown> | null = null;
  try {
    record = JSON.parse(await readFile(recordPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    record = null;
  }
  const recordSnapshot = parseRecordedSnapshot(record?.["authored_snapshot"]);
  const fallbackSnapshot = taskSpecAuthoredSnapshot(input.task);
  const baseResult = resultFromAdmissionRecord(record, taskId, fallbackSnapshot);
  const makeDiagnostics = (differences: string[] = []): TaskSpecAdmissionDiagnostics => ({
    validation_stage: stage,
    project_context_id: projectContext.context_id,
    project_context_digest: projectContext.context_digest,
    project_root: projectRoot,
    proof_path: recordPath,
    submission_path: submissionPath,
    compared_fields: Object.keys(recordSnapshot?.frontmatter ?? fallbackSnapshot.frontmatter).sort(),
    differences,
  });
  if (
    !record ||
    record["decision"] !== "accepted" ||
    record["formal_task_id"] !== taskId ||
    record["submission_id"] !== submissionId ||
    !Array.isArray(record["blocking_findings"]) ||
    record["blocking_findings"].length !== 0
  ) {
    return {
      ...baseResult,
      decision: "rejected",
      code: TASK_SPEC_INVALID,
      blocking_findings: [
        materializeFinding({
          id: "ADMISSION_PROOF_MISSING",
          field: "submission_id",
          message:
            "formal ADMIN task has no matching accepted submission proof",
          expected: `${submissionId} -> ${taskId}`,
          actual: record ? "invalid admission proof" : "missing admission proof",
          suggested_fix:
            stage === "continuation"
              ? `repair the proof binding at ${recordPath}; do not create a replacement TASK`
              : "review the submission transaction; do not copy proof files across project roots",
          can_auto_fix: false,
        }),
      ],
      diagnostics: makeDiagnostics([record ? "proof_record_invalid" : "proof_record_missing"]),
    };
  }

  let submission: Record<string, unknown> | null = null;
  try {
    submission = JSON.parse(
      await readFile(submissionPath, "utf8"),
    ) as Record<string, unknown>;
  } catch {
    submission = null;
  }
  if (
    !submission ||
    submission["status"] !== "created" ||
    submission["formal_task_id"] !== taskId ||
    Number(submission["admission_revision"] ?? 0) !==
      Number(input.task.frontmatter["admission_revision"] ?? 0)
  ) {
    return {
      ...baseResult,
      decision: "rejected",
      code: TASK_SPEC_INVALID,
      blocking_findings: [
        materializeFinding({
          id: "ADMISSION_PROOF_MISSING",
          field: "submission_id",
          message:
            "formal task is not backed by a completed atomic submission transaction",
          expected: `${submissionId} status=created formal_task_id=${taskId}`,
          actual: submission
            ? `status=${String(submission["status"] ?? "unknown")}`
            : "missing submission record",
          suggested_fix:
            stage === "continuation"
              ? `repair the incomplete submission transaction at ${submissionPath}; do not re-formalize the accepted TASK`
              : "complete the atomic Task Delivery Review transaction before first dispatch",
          can_auto_fix: false,
        }),
      ],
      diagnostics: makeDiagnostics([submission ? "submission_record_invalid" : "submission_record_missing"]),
    };
  }

  const expectedSnapshot =
    recordSnapshot ?? snapshotFromSubmissionRecord(submission) ?? fallbackSnapshot;
  const currentAuthored = projectTaskOntoSnapshot(input.task, expectedSnapshot);
  const currentDigest = digestSnapshot(currentAuthored);
  const expectedDigest = String(record["content_digest"] ?? submission["content_digest"] ?? "").trim();
  const differences = diffAuthoredSnapshots(expectedSnapshot, currentAuthored);
  const declaredDigest = String(
    input.task.frontmatter["admission_digest"] ?? "",
  ).trim();
  const recordedDigest = String(record["content_digest"] ?? "").trim();
  if (
    !declaredDigest ||
    declaredDigest !== expectedDigest ||
    recordedDigest !== expectedDigest ||
    String(submission["content_digest"] ?? "").trim() !== expectedDigest ||
    currentDigest !== expectedDigest
  ) {
    return {
      ...baseResult,
      decision: "rejected",
      code: TASK_SPEC_INVALID,
      blocking_findings: [
        materializeFinding({
          id: "ADMISSION_DIGEST_MISMATCH",
          field: "content_digest",
          message:
            "formal task content changed after admission or does not match its submission",
          expected: recordedDigest || declaredDigest || "(missing)",
          actual: currentDigest,
          suggested_fix:
            "create a new submission revision and run admission again",
          can_auto_fix: false,
        }),
      ],
      diagnostics: makeDiagnostics(differences.length > 0 ? differences : ["digest_binding_mismatch"]),
    };
  }
  return {
    ...baseResult,
    decision: "accepted",
    code: TASK_SPEC_VALID,
    content_digest: expectedDigest,
    blocking_findings: [],
    authored_snapshot: expectedSnapshot,
    diagnostics: makeDiagnostics(),
  };
}
