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
  | "PARENT_INVALID";

export interface TaskSpecAdmissionFinding {
  id: TaskSpecAdmissionFindingId;
  message: string;
  field?: string;
  requirement?: string;
  supported?: string;
  expected_level?: PmPlanningLevel;
  detected_level?: PmPlanningLevel;
  missing?: string[];
  evidence?: string[];
}

export interface TaskSpecAdmissionAccepted {
  decision: "accepted";
  code: typeof TASK_SPEC_VALID;
  task_id: string;
  content_digest: string;
  planning_level?: PmPlanningLevel;
  blocking_findings: [];
}

export interface TaskSpecAdmissionRejected {
  decision: "rejected";
  code: typeof TASK_SPEC_INVALID;
  task_id: string;
  content_digest: string;
  planning_level?: PmPlanningLevel;
  blocking_findings: TaskSpecAdmissionFinding[];
}

export type TaskSpecAdmissionResult =
  | TaskSpecAdmissionAccepted
  | TaskSpecAdmissionRejected;

export interface TaskSpecAdmissionInput {
  projectRoot: string;
  task: ParsedTask;
}

const SUPPORTED_PM_FORMAL_TOOLS = new Set([
  "pm.write_planning_artifact",
  "pm.record_planning_skill_evidence",
  "pm.summarize_thread",
  "pm.detect_thread_stall",
  "pm.close_admin_task",
  "pm.wake_downstream",
  "pm.review_check",
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

function digestTask(task: ParsedTask): string {
  const authoredBody = task.body.split(
    /\n---\n\n## state_history \(auto-appended by runtime\)/,
    1,
  )[0] ?? task.body;
  return createHash("sha256")
    .update(JSON.stringify(task.frontmatter))
    .update("\n")
    .update(authoredBody)
    .digest("hex");
}

function addFinding(
  findings: TaskSpecAdmissionFinding[],
  finding: TaskSpecAdmissionFinding,
): void {
  const key = `${finding.id}:${finding.field ?? ""}:${finding.message}`;
  if (
    !findings.some(
      (item) => `${item.id}:${item.field ?? ""}:${item.message}` === key,
    )
  ) {
    findings.push(finding);
  }
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
    content_digest: digestTask(task),
    ...(planningLevel != null ? { planning_level: planningLevel } : {}),
  };
  return findings.length > 0
    ? {
        ...base,
        decision: "rejected",
        code: TASK_SPEC_INVALID,
        blocking_findings: findings,
      }
    : {
        ...base,
        decision: "accepted",
        code: TASK_SPEC_VALID,
        blocking_findings: [],
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
): Promise<{ path: string; changed: boolean }> {
  const path = taskSpecAdmissionRecordPath(projectRoot, result.task_id);
  try {
    const existing = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    if (
      existing["content_digest"] === result.content_digest &&
      existing["decision"] === result.decision &&
      existing["code"] === result.code &&
      JSON.stringify(existing["blocking_findings"] ?? []) ===
        JSON.stringify(result.blocking_findings)
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
        checked_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return { path, changed: true };
}
