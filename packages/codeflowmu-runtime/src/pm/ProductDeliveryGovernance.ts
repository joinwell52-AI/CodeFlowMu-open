/**
 * Product-delivery governance shared by dispatch, report and panel paths.
 *
 * This module deliberately owns classification and Product Brief validation so
 * callers cannot drift into prompt-only, path-specific interpretations.
 */

import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  readRecentSkillInvocations,
  verifySkillInvocationIntegrity,
  type SkillInvocationRecord,
} from "./SkillInvocationJournal.ts";

export const PRODUCT_DELIVERY_TASK_CLASS = "product_delivery" as const;
export type PmPlanningLevel = 0 | 1 | 2 | 3;

export const PRODUCT_DESIGN_REQUIRED_SKILLS = [
  "pm-product-design-brief",
  "pm-product-requirements",
  "pm-scope-control",
  "pm-acceptance-criteria",
  "pm-delivery-plan",
  "ui-information-architecture",
  "ui-visual-consistency",
  "ui-usability-acceptance",
] as const;

export interface ProductTaskClassification {
  task_class: "product_delivery" | "non_product_change";
  planning_level: PmPlanningLevel;
  planning_label: "none" | "lightweight_analysis" | "standard_feature_plan" | "full_product_plan";
  classification_reason: string;
  product_design_required: boolean;
  qa_required: boolean;
  matched_signals: string[];
  override_by?: string;
  override_reason?: string;
}

export interface ProductDeliveryGateStatus {
  task_id: string;
  classification: ProductTaskClassification;
  product_brief_path: string;
  product_brief_exists: boolean;
  product_brief_ready: boolean;
  planning_level: PmPlanningLevel;
  planning_status: "not_required" | "legacy_compatible" | "missing" | "in_progress" | "completed";
  planning_artifact_path: string;
  planning_artifact_revision: number | null;
  missing_sections: string[];
  invalid_skill_evidence: string[];
  dispatch_open: boolean;
  next_action: string | null;
  required_skills: string[];
  invoked_skills: string[];
  missing_skills: string[];
  findings: string[];
  open_issues: string[];
  related_issues: string[];
  allowed: boolean;
}

const PRODUCT_SIGNALS: Array<[string, RegExp]> = [
  ["web_application", /\bweb\s*(?:app|application)\b|Web\s*应用|网页应用|网站|页面|前端应用/i],
  ["dashboard", /dashboard|看板|仪表盘/i],
  ["ui_ux", /\bUI\b|\bUX\b|UI\/UX|用户界面|用户体验|视觉设计/i],
  ["mobile_pwa", /移动端|手机端|响应式|\bPWA\b|service\s*worker|mobile/i],
  ["new_product", /新产品|完整功能模块|产品级交付|完整产品|product\s*delivery/i],
  ["interaction_flow", /交互流程|用户流程|用户旅程|核心流程|interaction/i],
  ["function_visual_experience", /功能[\s\S]{0,40}(?:界面|视觉)[\s\S]{0,40}(?:体验|交互)/i],
];

const LEVEL_0_SIGNALS =
  /查询|状态检查|巡检|报告汇总|读取已有|只读|无实现工作|协调(?:而不实现)?|紧急止损|止血|health\s*check|status\s*check|inspection|read[- ]?only/i;

const LEVEL_1_SIGNALS =
  /小型|小范围|单点|明确的?(?:小)?\s*Bug|已定位\s*Bug|文案|样式修改|兼容性问题|配置调整|hotfix|typo|copy\s*change|small\s*bug/i;

const LEVEL_3_SIGNALS =
  /新产品|新应用|完整产品|复杂功能|UI\s*\/\s*UX|UI\/UX|改版|移动端|手机端|\bPWA\b|架构调整|架构重构|大版本|跨模块|复杂改造|major\s*upgrade|new\s*(?:product|application)|architecture\s*(?:change|refactor)/i;

const LEVEL_2_SIGNALS =
  /新功能|新增.*功能|功能方案|模块修改|API|接口|数据结构|影响面|工程改造|feature|schema|migration/i;

const SMALL_CHANGE_SIGNALS =
  /(?:仅|只)(?:修改|调整|修复)(?:一个|单一|现有)?(?:文案|配置值|已定位\s*Bug)|单一已定位\s*Bug|只读分析|只读调查|无\s*UI|non[-_ ]?product/i;

function boolField(fm: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = fm?.[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(true|yes|1)$/i.test(value.trim())) return true;
    if (/^(false|no|0)$/i.test(value.trim())) return false;
  }
  return undefined;
}

function stringField(fm: Record<string, unknown> | undefined, key: string): string {
  const value = fm?.[key];
  return typeof value === "string" ? value.trim() : "";
}

export function classifyProductTask(
  body: string,
  frontmatter?: Record<string, unknown>,
): ProductTaskClassification {
  const explicitClass = stringField(frontmatter, "task_class").toLowerCase();
  const explicitLevelRaw = Number(frontmatter?.["planning_level"] ?? frontmatter?.["pm_planning_level"]);
  const explicitLevel = [0, 1, 2, 3].includes(explicitLevelRaw)
    ? (explicitLevelRaw as PmPlanningLevel)
    : undefined;
  const explicitRequired = boolField(frontmatter, "product_design_required");
  const explicitQaRequired = boolField(frontmatter, "qa_required");
  const overrideBy = stringField(frontmatter, "override_by").toUpperCase();
  const overrideReason = stringField(frontmatter, "override_reason");
  const validAdminOverride = overrideBy === "ADMIN" && overrideReason.length > 0;

  const matched = PRODUCT_SIGNALS.filter(([, pattern]) => pattern.test(body)).map(
    ([name]) => name,
  );
  const researchOnly =
    /调研|研究|搜索网页|提取正文|提取表格|只读分析|调查|web\s*research/i.test(body) &&
    !/创建|开发|构建|实现|交付|新产品|新应用|产品级|build|implement|develop|create/i.test(body);
  let level: PmPlanningLevel;
  let reason: string;
  if (explicitLevel != null && validAdminOverride) {
    level = explicitLevel;
    reason = `ADMIN override: ${overrideReason}`;
  } else if (LEVEL_0_SIGNALS.test(body) || researchOnly) {
    level = 0;
    reason = researchOnly ? "read_only_or_research" : "level_0_operational_task";
  } else if (LEVEL_1_SIGNALS.test(body) || SMALL_CHANGE_SIGNALS.test(body)) {
    level = 1;
    reason = "small_scoped_change";
  } else if (LEVEL_3_SIGNALS.test(body) || matched.length >= 2) {
    level = 3;
    reason = `complex_product_signals:${[...new Set(matched)].join(",") || "level_3_keyword"}`;
  } else if (LEVEL_2_SIGNALS.test(body) || matched.length > 0 || explicitClass === PRODUCT_DELIVERY_TASK_CLASS) {
    level = 2;
    reason = `standard_feature_signals:${matched.join(",") || "level_2_keyword"}`;
  } else {
    level = 0;
    reason = "no_implementation_signal";
  }
  const product = level >= 2;
  const labels = {
    0: "none",
    1: "lightweight_analysis",
    2: "standard_feature_plan",
    3: "full_product_plan",
  } as const;

  return {
    task_class: product ? PRODUCT_DELIVERY_TASK_CLASS : "non_product_change",
    planning_level: level,
    planning_label: labels[level],
    classification_reason: reason,
    product_design_required:
      explicitRequired === false && validAdminOverride ? false : level > 0,
    qa_required:
      explicitQaRequired === false && validAdminOverride
        ? false
        : explicitQaRequired ?? product,
    matched_signals: matched,
    ...(validAdminOverride ? { override_by: "ADMIN", override_reason: overrideReason } : {}),
  };
}

export function canonicalProductBriefTaskId(taskId: string): string {
  return String(taskId ?? "")
    .trim()
    .replace(/\.md$/i, "")
    .replace(/[^A-Za-z0-9._-]/g, "-");
}

export function productBriefPath(projectRoot: string, taskId: string): string {
  return join(
    projectRoot,
    "fcop",
    "internal",
    "product-briefs",
    `PRODUCT-BRIEF-${canonicalProductBriefTaskId(taskId)}.md`,
  );
}

export function planningArtifactPath(
  projectRoot: string,
  taskId: string,
  level: PmPlanningLevel,
): string {
  if (level === 3) return productBriefPath(projectRoot, taskId);
  return join(
    projectRoot,
    "fcop",
    "internal",
    "product-briefs",
    `PLAN-${canonicalProductBriefTaskId(taskId)}.md`,
  );
}

export async function writePlanningArtifact(input: {
  projectRoot: string;
  taskId: string;
  planningLevel: 1 | 2 | 3;
  bodyMarkdown: string;
  status?: "draft" | "ready";
  callerRole: string;
  sessionId: string;
}): Promise<{
  path: string;
  task_id: string;
  planning_level: 1 | 2 | 3;
  status: "draft" | "ready";
  revision: number;
}> {
  const taskId = canonicalProductBriefTaskId(input.taskId);
  const callerRole = String(input.callerRole ?? "").trim();
  const sessionId = String(input.sessionId ?? "").trim();
  const bodyMarkdown = String(input.bodyMarkdown ?? "").trim();
  const status = input.status === "draft" ? "draft" : "ready";
  if (!taskId) throw new Error("task_id is required");
  if (![1, 2, 3].includes(input.planningLevel)) {
    throw new Error("planning_level must be 1, 2, or 3");
  }
  if (!/^PM(?:[-.][A-Za-z0-9_-]+)?$/i.test(callerRole)) {
    throw new Error("planning artifacts are PM-only");
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(sessionId)) {
    throw new Error("a valid session_id is required");
  }
  if (!bodyMarkdown) throw new Error("body_markdown is required");
  if (Buffer.byteLength(bodyMarkdown, "utf8") > 256 * 1024) {
    throw new Error("body_markdown exceeds 256 KiB");
  }
  if (bodyMarkdown.includes("\0")) throw new Error("body_markdown contains NUL");
  if (/^---\s*$/m.test(bodyMarkdown.split(/\r?\n/, 1)[0] ?? "")) {
    throw new Error("body_markdown must not contain YAML frontmatter");
  }

  const path = planningArtifactPath(input.projectRoot, taskId, input.planningLevel);
  let revision = 1;
  let createdAt = new Date().toISOString();
  try {
    const existing = await readFile(path, "utf8");
    const fm = parseFrontmatter(existing);
    const previousRevision = Number(fm["revision"]);
    if (Number.isFinite(previousRevision) && previousRevision > 0) {
      revision = previousRevision + 1;
    }
    createdAt = stringField(fm, "created_at") || createdAt;
  } catch {
    // First revision.
  }
  const updatedAt = new Date().toISOString();
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    [
      "---",
      `task_id: ${taskId}`,
      `planning_level: ${input.planningLevel}`,
      `pm: ${callerRole}`,
      `status: ${status}`,
      `revision: ${revision}`,
      `created_at: ${createdAt}`,
      `updated_at: ${updatedAt}`,
      `session_id: ${sessionId}`,
      "source: pm.write_planning_artifact",
      "---",
      "",
      bodyMarkdown,
      "",
    ].join("\n"),
    "utf8",
  );
  return {
    path,
    task_id: taskId,
    planning_level: input.planningLevel,
    status,
    revision,
  };
}

export async function recordProductTaskClassification(input: {
  projectRoot: string;
  taskId: string;
  taskBody: string;
  taskFrontmatter?: Record<string, unknown>;
}): Promise<{ path: string; classification: ProductTaskClassification }> {
  const classification = classifyProductTask(input.taskBody, input.taskFrontmatter);
  const dir = join(input.projectRoot, ".codeflowmu", "product-governance");
  const path = join(dir, `${canonicalProductBriefTaskId(input.taskId)}.json`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        task_id: input.taskId,
        ...classification,
        recorded_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { path, classification };
}

function productGovernanceStatePath(projectRoot: string, taskId: string): string {
  return join(
    projectRoot,
    ".codeflowmu",
    "product-governance",
    `${canonicalProductBriefTaskId(taskId)}.json`,
  );
}

export async function recordPlanningLevelOverride(input: {
  projectRoot: string;
  taskId: string;
  planningLevel: PmPlanningLevel;
  reason: string;
}): Promise<{ path: string; planning_level: PmPlanningLevel }> {
  if (![0, 1, 2, 3].includes(input.planningLevel)) throw new Error("planning_level must be 0..3");
  if (!input.reason.trim()) throw new Error("override_reason is required");
  const path = productGovernanceStatePath(input.projectRoot, input.taskId);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({
      task_id: input.taskId,
      planning_level: input.planningLevel,
      override_by: "ADMIN",
      override_reason: input.reason.trim(),
      updated_at: new Date().toISOString(),
    }, null, 2)}\n`,
    "utf8",
  );
  return { path, planning_level: input.planningLevel };
}

async function readPlanningLevelOverride(
  projectRoot: string,
  taskId: string,
): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(productGovernanceStatePath(projectRoot, taskId), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const row = parsed as Record<string, unknown>;
      if (String(row["override_by"] ?? "").toUpperCase() === "ADMIN") return row;
    }
  } catch {
    // No ADMIN override.
  }
  return {};
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  try {
    const parsed = parseYaml(match[1] ?? "");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizeTaskId(value: string): string {
  return value.trim().replace(/\.md$/i, "").toUpperCase();
}

const PLANNING_GOVERNANCE_ROLLOUT_MS = Date.parse("2026-07-12T00:00:00+08:00");

function taskCreatedAtMs(taskId: string, frontmatter?: Record<string, unknown>): number | null {
  const explicit = String(frontmatter?.["created_at"] ?? frontmatter?.["created_at_utc"] ?? "").trim();
  if (explicit) {
    const parsed = Date.parse(explicit);
    if (Number.isFinite(parsed)) return parsed;
  }
  const date = /^TASK-(\d{4})(\d{2})(\d{2})-/i.exec(taskId);
  if (!date) return null;
  const parsed = Date.parse(`${date[1]}-${date[2]}-${date[3]}T00:00:00+08:00`);
  return Number.isFinite(parsed) ? parsed : null;
}

function planningGovernanceApplies(taskId: string, frontmatter?: Record<string, unknown>): boolean {
  if (boolField(frontmatter, "planning_enforced") === true) return true;
  if (boolField(frontmatter, "planning_reopened") === true) return true;
  const created = taskCreatedAtMs(taskId, frontmatter);
  return created != null && created >= PLANNING_GOVERNANCE_ROLLOUT_MS;
}

async function walkMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkMarkdown(path)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(path);
  }
  return out;
}

export async function findIssuesForTask(
  projectRoot: string,
  taskId: string,
): Promise<{ related: string[]; open: string[] }> {
  const target = normalizeTaskId(taskId);
  const files = await walkMarkdown(join(projectRoot, "fcop", "issues"));
  const related: string[] = [];
  const open: string[] = [];
  for (const path of files) {
    let raw = "";
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(raw);
    const status = stringField(fm, "status").toLowerCase();
    const refsRaw = fm["references"];
    const refs = (Array.isArray(refsRaw) ? refsRaw : [refsRaw])
      .filter((value): value is string => typeof value === "string")
      .map(normalizeTaskId);
    if (refs.includes(target) || raw.toUpperCase().includes(target)) {
      const name = basename(path);
      related.push(name);
      if (!["resolved", "closed", "done", "completed", "archived"].includes(status)) {
        open.push(name);
      }
    }
  }
  return { related, open };
}

const LEVEL_SECTION_REQUIREMENTS: Record<1 | 2 | 3, Array<[string, RegExp]>> = {
  1: [
    ["问题现象", /问题现象|symptom/i],
    ["根因或待验证假设", /根因|待验证假设|root cause|hypothesis/i],
    ["修改范围", /修改范围|change scope/i],
    ["风险", /风险|risk/i],
    ["回归测试", /回归测试|regression/i],
  ],
  2: [
    ["目标", /目标|goal/i],
    ["范围", /范围|scope/i],
    ["技术方案", /技术方案|technical (?:plan|approach)/i],
    ["影响面", /影响面|impact/i],
    ["验收标准", /验收标准|acceptance criteria/i],
    ["测试数据", /测试数据|test data/i],
    ["交付顺序", /交付顺序|delivery order|sequence/i],
  ],
  3: [
    ["产品目标", /产品目标|product goal/i],
    ["目标用户", /目标用户|target user/i],
    ["问题与价值", /问题与价值|problem and value|user value/i],
    ["功能范围", /功能范围|scope/i],
    ["明确不做什么", /不做什么|out of scope/i],
    ["用户流程", /用户流程|user flow/i],
    ["信息架构", /信息架构|information architecture/i],
    ["交互规则", /交互规则|interaction/i],
    ["视觉与响应式", /视觉.*响应式|视觉方向|响应式|visual.*responsive/i],
    ["技术候选方案比较", /技术候选方案|方案比较|technical options|trade-?off/i],
    ["数据方案", /数据方案|数据与持久化|persistence/i],
    ["测试数据", /测试数据|test data/i],
    ["QA验收方法", /QA.*验收|QA.*测试|QA acceptance/i],
    ["风险与依赖", /风险.*依赖|risk.*dependenc/i],
    ["DEV/QA/OPS交付计划", /DEV.*QA.*OPS|DEV\s*交付|交付计划|delivery plan/i],
    ["验收标准", /验收标准|acceptance criteria/i],
  ],
};

function missingRequiredSections(raw: string, level: 1 | 2 | 3): string[] {
  const headings = [...raw.matchAll(/^#{1,4}\s+(.+)$/gm)].map((m) =>
    String(m[1] ?? "").trim(),
  );
  return LEVEL_SECTION_REQUIREMENTS[level]
    .filter(([, pattern]) => !headings.some((heading) => pattern.test(heading)))
    .map(([name]) => name);
}

function requiredSkillsForLevel(level: PmPlanningLevel): string[] {
  return level === 3 ? [...PRODUCT_DESIGN_REQUIRED_SKILLS] : [];
}

function isCompletePlanningEvidenceShape(row: SkillInvocationRecord): boolean {
  return (
    row.evidence_version === 1 &&
    row.evidence_source === "pm_runtime_control" &&
    row.triggered_by === "pm.record_planning_skill_evidence" &&
    row.channel !== "auto_inject" &&
    String(row.session_id ?? "").trim().length > 0 &&
    String(row.input_context ?? "").trim().length > 0 &&
    String(row.output_summary ?? "").trim().length > 0 &&
    String(row.brief_section ?? "").trim().length > 0 &&
    Array.isArray(row.product_decisions) &&
    row.product_decisions.some((value) => String(value).trim().length > 0)
  );
}

async function firstDownstreamTaskCreatedAt(
  projectRoot: string,
  rootTaskId: string,
): Promise<number | null> {
  const files = [
    ...(await walkMarkdown(join(projectRoot, "fcop", "_lifecycle"))),
    ...(await walkMarkdown(join(projectRoot, "fcop", "tasks"))),
  ];
  const target = normalizeTaskId(rootTaskId);
  let earliest: number | null = null;
  for (const file of files) {
    let fm: Record<string, unknown>;
    try {
      fm = parseFrontmatter(await readFile(file, "utf8"));
    } catch {
      continue;
    }
    if (stringField(fm, "sender").toUpperCase() !== "PM") continue;
    if (!["DEV", "QA", "OPS"].includes(stringField(fm, "recipient").toUpperCase())) continue;
    const refsRaw = fm["references"] ?? fm["parent"] ?? fm["parent_task_id"];
    const refs = (Array.isArray(refsRaw) ? refsRaw : [refsRaw])
      .filter((value): value is string => typeof value === "string")
      .map(normalizeTaskId);
    if (!refs.includes(target)) continue;
    const created = Date.parse(String(fm["created_at"] ?? fm["created_at_utc"] ?? ""));
    if (Number.isFinite(created) && (earliest == null || created < earliest)) earliest = created;
  }
  return earliest;
}

export async function evaluateProductDeliveryGate(input: {
  projectRoot: string;
  taskId: string;
  taskBody: string;
  taskFrontmatter?: Record<string, unknown>;
}): Promise<ProductDeliveryGateStatus> {
  const persistedOverride = await readPlanningLevelOverride(input.projectRoot, input.taskId);
  const effectiveFrontmatter = { ...(input.taskFrontmatter ?? {}), ...persistedOverride };
  const classification = classifyProductTask(input.taskBody, effectiveFrontmatter);
  const level = classification.planning_level;
  const path = planningArtifactPath(input.projectRoot, input.taskId, level);
  const requiredSkills = requiredSkillsForLevel(level);
  if (level === 0 || !classification.product_design_required) {
    return {
      task_id: input.taskId,
      classification,
      product_brief_path: path,
      product_brief_exists: false,
      product_brief_ready: true,
      planning_level: level,
      planning_status: "not_required",
      planning_artifact_path: path,
      planning_artifact_revision: null,
      missing_sections: [],
      invalid_skill_evidence: [],
      dispatch_open: true,
      next_action: null,
      required_skills: requiredSkills,
      invoked_skills: [],
      missing_skills: [],
      findings: [],
      open_issues: [],
      related_issues: [],
      allowed: true,
    };
  }

  if (!planningGovernanceApplies(input.taskId, effectiveFrontmatter)) {
    let legacyRaw = "";
    try {
      legacyRaw = await readFile(path, "utf8");
    } catch {
      // Missing historical planning artifacts are grandfathered.
    }
    const legacyFm = legacyRaw ? parseFrontmatter(legacyRaw) : {};
    const legacyRevisionRaw = Number(legacyFm["revision"]);
    const legacyRevision = Number.isFinite(legacyRevisionRaw) && legacyRevisionRaw > 0
      ? legacyRevisionRaw
      : null;
    return {
      task_id: input.taskId,
      classification,
      product_brief_path: path,
      product_brief_exists: Boolean(legacyRaw),
      product_brief_ready: true,
      planning_level: level,
      planning_status: "legacy_compatible",
      planning_artifact_path: path,
      planning_artifact_revision: legacyRevision,
      missing_sections: [],
      invalid_skill_evidence: [],
      dispatch_open: true,
      next_action: null,
      required_skills: requiredSkills,
      invoked_skills: [],
      missing_skills: [],
      findings: ["legacy_task_planning_not_enforced"],
      open_issues: [],
      related_issues: [],
      allowed: true,
    };
  }

  const issues = await findIssuesForTask(input.projectRoot, input.taskId);
  const openIssues = issues.open;
  let raw = "";
  try {
    await access(path);
    raw = await readFile(path, "utf8");
  } catch {
    return {
      task_id: input.taskId,
      classification,
      product_brief_path: path,
      product_brief_exists: false,
      product_brief_ready: false,
      planning_level: level,
      planning_status: "missing",
      planning_artifact_path: path,
      planning_artifact_revision: null,
      missing_sections: LEVEL_SECTION_REQUIREMENTS[level as 1 | 2 | 3].map(([name]) => name),
      invalid_skill_evidence: [],
      dispatch_open: false,
      next_action: level === 3 ? "创建并完成 Product Brief" : `创建并完成 Level ${level} PLAN`,
      required_skills: requiredSkills,
      invoked_skills: [],
      missing_skills: requiredSkills,
      findings: [
        level === 3 ? "product_brief_missing" : "planning_artifact_missing",
        ...(openIssues.length ? [`open_issues:${openIssues.join(",")}`] : []),
      ],
      open_issues: openIssues,
      related_issues: issues.related,
      allowed: false,
    };
  }

  const fm = parseFrontmatter(raw);
  const briefTaskId = stringField(fm, "task_id");
  const ready = stringField(fm, "status").toLowerCase() === "ready";
  const revisionRaw = Number(fm["revision"]);
  const revision = Number.isFinite(revisionRaw) && revisionRaw > 0 ? revisionRaw : null;
  const invocations = await readRecentSkillInvocations(input.projectRoot, 5000);
  const firstDispatchAt = await firstDownstreamTaskCreatedAt(input.projectRoot, input.taskId);
  const candidates = invocations.filter(
    (row) =>
      /^PM(?:[-.]|$)/i.test(String(row.caller_role ?? "")) &&
      String(row.outcome ?? "").toLowerCase() === "ok" &&
      normalizeTaskId(String(row.task_id ?? "")) === normalizeTaskId(input.taskId) &&
      requiredSkills.includes(row.skill_id),
  );
  const validRows: SkillInvocationRecord[] = [];
  let invalidSkillEvidence: string[] = [];
  for (const row of candidates) {
    if (!isCompletePlanningEvidenceShape(row)) {
      invalidSkillEvidence.push(`${row.skill_id}:incomplete_or_untrusted`);
      continue;
    }
    if (!(await verifySkillInvocationIntegrity(input.projectRoot, row))) {
      invalidSkillEvidence.push(`${row.skill_id}:integrity_invalid`);
      continue;
    }
    const invokedAt = Date.parse(row.at);
    if (firstDispatchAt != null && (!Number.isFinite(invokedAt) || invokedAt > firstDispatchAt)) {
      invalidSkillEvidence.push(`${row.skill_id}:recorded_after_first_dispatch`);
      continue;
    }
    validRows.push(row);
  }
  const invokedSkills = [...new Set(validRows.map((row) => row.skill_id))];
  invalidSkillEvidence = invalidSkillEvidence.filter(
    (finding) => !invokedSkills.includes(finding.split(":", 1)[0] ?? ""),
  );
  const missingSkills = requiredSkills.filter(
    (skill) => !invokedSkills.includes(skill),
  );
  const findings: string[] = [];
  const missingSections = missingRequiredSections(raw, level as 1 | 2 | 3);
  if (!briefTaskId || normalizeTaskId(briefTaskId) !== normalizeTaskId(input.taskId)) {
    findings.push("product_brief_task_mismatch");
  }
  if (missingSections.length) findings.push(`planning_sections_missing:${missingSections.join(",")}`);
  if (!ready) findings.push("planning_artifact_not_ready");
  if (missingSkills.length) findings.push(`product_skills_missing:${missingSkills.join(",")}`);
  if (invalidSkillEvidence.length) findings.push(`skill_evidence_invalid:${invalidSkillEvidence.join(",")}`);
  // Open business issues remain visible to PM/Panel, but are not planning-evidence failures.

  return {
    task_id: input.taskId,
    classification,
    product_brief_path: path,
    product_brief_exists: true,
    product_brief_ready: findings.length === 0,
    planning_level: level,
    planning_status: findings.length === 0 ? "completed" : "in_progress",
    planning_artifact_path: path,
    planning_artifact_revision: revision,
    missing_sections: missingSections,
    invalid_skill_evidence: invalidSkillEvidence,
    dispatch_open: findings.length === 0,
    next_action:
      findings.length === 0
        ? null
        : missingSections.length
          ? `补全方案章节：${missingSections.join("、")}`
          : missingSkills.length
            ? `执行并提交技能证据：${missingSkills.join("、")}`
            : invalidSkillEvidence.length
              ? "重新通过 Runtime 提交无效的技能执行证据"
              : "将规划产物状态更新为 ready",
    required_skills: requiredSkills,
    invoked_skills: invokedSkills,
    missing_skills: missingSkills,
    findings,
    open_issues: openIssues,
    related_issues: issues.related,
    allowed: findings.length === 0,
  };
}
