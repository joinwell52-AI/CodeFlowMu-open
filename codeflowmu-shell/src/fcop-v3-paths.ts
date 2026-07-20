/**
 * FCoP v3 lifecycle path helpers — single source of truth for CodeFlowMu Shell.
 *
 * v3 layout (protocol_version >= 3):
 *   fcop/_lifecycle/{inbox,active,review,done,archive}/
 *
 * CodeFlowMu adopted 0002 fixed work folders (dual-track with v3 lifecycle):
 *   fcop/tasks/, fcop/reports/, fcop/issues/, fcop/ledger/, fcop/attachments/
 *
 * True v2-only legacy (risk when mixed without v3 lifecycle):
 *   fcop/log/ — old v2 archive bucket; not the 0002 work surface.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, resolve as pathResolve } from "node:path";

/** v2-only dirs that indicate old five-bucket topology — NOT 0002 work folders. */
export const FCOP_V2_ONLY_LEGACY_DIRS = ["log"] as const;

/** CodeFlowMu adopted 0002 fixed work folders. */
export const FCOP_0002_WORK_DIRS = [
  "tasks",
  "reports",
  "issues",
  "ledger",
  "attachments",
] as const;

export type Fcop0002WorkDir = (typeof FCOP_0002_WORK_DIRS)[number];

export interface Fcop0002WorkFolderStatus {
  dir: Fcop0002WorkDir;
  path: string;
  exists: boolean;
}

export type FcopLayoutRiskKind =
  | "v2_only_topology"
  | "orphan_lifecycle_task"
  | "task_missing_from_ledger"
  | "protocolless_fragment";

export interface FcopLayoutRisk {
  kind: FcopLayoutRiskKind;
  message: string;
}

export interface FcopV3Paths {
  lifecycleRoot: string;
  inbox: string;
  active: string;
  review: string;
  done: string;
  archive: string;
  /** System failure records (non-protocol). */
  failures: string;
  reports: string;
  reviews: string;
  /** Adopted hot-path task bucket (legacy-compatible search surface). */
  tasks: string;
}

/** Build all v3 lifecycle paths under `<projectRoot>/fcop/`. */
export function fcopV3Paths(projectRoot: string): FcopV3Paths {
  const fcop = join(projectRoot, "fcop");
  const lifecycle = join(fcop, "_lifecycle");
  return {
    lifecycleRoot: lifecycle,
    inbox: join(lifecycle, "inbox"),
    active: join(lifecycle, "active"),
    review: join(lifecycle, "review"),
    done: join(lifecycle, "done"),
    archive: join(lifecycle, "archive"),
    failures: join(fcop, "internal", "failures"),
    reports: join(fcop, "reports"),
    reviews: join(fcop, "reviews"),
    tasks: join(fcop, "tasks"),
  };
}

/** All lifecycle dirs that may contain TASK-*.md files. */
export function fcopV3TaskSearchDirs(paths: FcopV3Paths): string[] {
  return [paths.inbox, paths.active, paths.review, paths.done, paths.archive];
}

/** Find a TASK/PLAN file across v3 lifecycle dirs. Returns null if not found. */
export function findTaskFile(
  paths: FcopV3Paths,
  filename: string,
): { dir: string; path: string } | null {
  for (const dir of fcopV3TaskSearchDirs(paths)) {
    const p = join(dir, filename);
    if (existsSync(p)) return { dir, path: p };
  }
  return null;
}

/** Find TASK-*.md by task id prefix (e.g. TASK-20260531-239) across lifecycle + fcop/tasks/. */
export function findTaskFileByIdPrefix(
  projectRoot: string,
  taskIdPrefix: string,
): { dir: string; path: string; filename: string } | null {
  const prefix = taskIdPrefix.replace(/\.md$/i, "").toUpperCase();
  if (!prefix.startsWith("TASK-")) return null;
  const paths = fcopV3Paths(projectRoot);
  const dirs = [
    ...fcopV3TaskSearchDirs(paths),
    join(projectRoot, "fcop", "tasks"),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith("TASK-") || !name.endsWith(".md")) continue;
      const stem = name.replace(/\.md$/i, "").toUpperCase();
      if (stem.startsWith(prefix) || stem === prefix) {
        return { dir, path: join(dir, name), filename: name };
      }
    }
  }
  return null;
}

/**
 * Detect v2-only legacy dirs (e.g. fcop/log/) — excludes 0002 work folders.
 * @deprecated Prefer `detectLegacyV2OnlyDirs` — name kept for callers.
 */
export function detectLegacyV2Dirs(projectRoot: string): string[] {
  return detectLegacyV2OnlyDirs(projectRoot);
}

/** Detect v2-only legacy dirs that may signal MIXED / v2-only topology. */
export function detectLegacyV2OnlyDirs(projectRoot: string): string[] {
  const fcop = join(projectRoot, "fcop");
  return FCOP_V2_ONLY_LEGACY_DIRS.filter((d) => existsSync(join(fcop, d)));
}

/** Check adopted-0002 fixed work folder presence under `fcop/`. */
export function checkFcop0002WorkFolders(
  projectRoot: string,
): Fcop0002WorkFolderStatus[] {
  const fcop = join(projectRoot, "fcop");
  return FCOP_0002_WORK_DIRS.map((dir) => ({
    dir,
    path: join(fcop, dir),
    exists: existsSync(join(fcop, dir)),
  }));
}

const IPC_FILENAME_RE =
  /^(TASK|REPORT|ISSUE|REVIEW|PLAN)-\d{8}-\d{3}/i;

function listMdFilesFlat(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter(
      (f) => f.endsWith(".md") && IPC_FILENAME_RE.test(f),
    );
  } catch {
    return [];
  }
}

function readHead(path: string, maxBytes = 4096): string {
  try {
    const buf = readFileSync(path);
    return buf.subarray(0, Math.min(buf.length, maxBytes)).toString("utf-8");
  } catch {
    return "";
  }
}

function hasProtocolFrontmatter(head: string): boolean {
  if (!head.startsWith("---")) return false;
  const end = head.indexOf("\n---", 3);
  const fm = end > 0 ? head.slice(0, end) : head;
  return /^protocol:\s*fcop/m.test(fm) || /^protocol:\s*agent_bridge/m.test(fm);
}

function taskIdFromFilename(name: string): string {
  const m = /^TASK-\d{8}-\d{3,}/i.exec(name.replace(/\.md$/i, ""));
  return m ? m[0].toUpperCase() : name.replace(/\.md$/i, "");
}

function ledgerTaskIdsFromJsonl(projectRoot: string): Set<string> {
  const ids = new Set<string>();
  const jsonlPath = join(projectRoot, "fcop", "ledger", "tasks.jsonl");
  if (!existsSync(jsonlPath)) return ids;
  try {
    const raw = readFileSync(jsonlPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as { task_id?: string };
        if (row.task_id) {
          ids.add(row.task_id.replace(/\.md$/i, "").toUpperCase());
        }
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* unreadable ledger */
  }
  return ids;
}

function collectProtocollessFragments(projectRoot: string): string[] {
  const fcop = join(projectRoot, "fcop");
  const scanDirs: string[] = [
    join(fcop, "tasks"),
    join(fcop, "reports"),
    join(fcop, "issues"),
    join(fcop, "_lifecycle", "inbox"),
    join(fcop, "_lifecycle", "active"),
    join(fcop, "_lifecycle", "review"),
  ];
  const hits: string[] = [];
  for (const dir of scanDirs) {
    for (const name of listMdFilesFlat(dir)) {
      const rel = join(dir, name).slice(projectRoot.length + 1).replace(/\\/g, "/");
      const head = readHead(join(dir, name));
      if (!hasProtocolFrontmatter(head)) {
        hits.push(rel);
      }
    }
  }
  return hits;
}

function collectDiskTaskIds(projectRoot: string): string[] {
  const fcop = join(projectRoot, "fcop");
  const dirs = [
    join(fcop, "tasks"),
    ...fcopV3TaskSearchDirs(fcopV3Paths(projectRoot)),
  ];
  const ids = new Set<string>();
  for (const dir of dirs) {
    for (const name of listMdFilesFlat(dir)) {
      if (name.startsWith("TASK-")) {
        ids.add(taskIdFromFilename(name));
      }
    }
  }
  return [...ids].sort();
}

/**
 * Layout risks per adopted 0002 — only flags real drift, never 0002 work dirs.
 */
export function detectFcopLayoutRisks(projectRoot: string): FcopLayoutRisk[] {
  const risks: FcopLayoutRisk[] = [];
  const fcop = join(projectRoot, "fcop");
  const lifecycleRoot = join(fcop, "_lifecycle");
  const hasLifecycle = existsSync(lifecycleRoot);
  const legacyOnly = detectLegacyV2OnlyDirs(projectRoot);
  const docsAgents = join(projectRoot, "docs", "agents");

  if (legacyOnly.length > 0 && !hasLifecycle) {
    risks.push({
      kind: "v2_only_topology",
      message: `检测到 v2-only 拓扑（${legacyOnly.map((d) => `fcop/${d}`).join(", ")}）且缺少 fcop/_lifecycle/ — 建议迁移至 v3 + 0002 双轨布局`,
    });
  }

  if (existsSync(docsAgents) && !hasLifecycle) {
    risks.push({
      kind: "v2_only_topology",
      message:
        "检测到 docs/agents/ 旧路径且缺少 fcop/_lifecycle/ — 可能为 pre-v3 项目布局",
    });
  }

  if (hasLifecycle) {
    const tasksDir = join(fcop, "tasks");
    const lifecycleHasTasks = fcopV3TaskSearchDirs(fcopV3Paths(projectRoot)).some(
      (d) => listMdFilesFlat(d).some((f) => f.startsWith("TASK-")),
    );
    const workDirHasTasks = existsSync(tasksDir) && listMdFilesFlat(tasksDir).some(
      (f) => f.startsWith("TASK-"),
    );
    if (lifecycleHasTasks && !existsSync(tasksDir)) {
      risks.push({
        kind: "orphan_lifecycle_task",
        message:
          "_lifecycle/ 中存在 TASK 但缺少 fcop/tasks/ 工作目录 — 0002 双轨不完整",
      });
    }
    if (workDirHasTasks && !lifecycleHasTasks && !existsSync(join(lifecycleRoot, "inbox"))) {
      risks.push({
        kind: "orphan_lifecycle_task",
        message:
          "fcop/tasks/ 有 TASK 但 _lifecycle/ 未初始化 — Runtime 生命周期 MV 不可用",
      });
    }
  }

  const ledgerPath = join(fcop, "ledger", "tasks.jsonl");
  const ledgerExists = existsSync(ledgerPath);
  const diskTaskIds = collectDiskTaskIds(projectRoot);
  if (diskTaskIds.length > 0) {
    if (!ledgerExists) {
      risks.push({
        kind: "task_missing_from_ledger",
        message: `磁盘有 ${diskTaskIds.length} 条 TASK 但 fcop/ledger/tasks.jsonl 不存在 — 请运行 LedgerBuilder.rebuild()`,
      });
    } else {
      const ledgerIds = ledgerTaskIdsFromJsonl(projectRoot);
      const missing = diskTaskIds.filter((id) => !ledgerIds.has(id));
      if (missing.length > 0) {
        const sample = missing.slice(0, 5).join(", ");
        const suffix =
          missing.length > 5 ? ` 等 ${missing.length} 条` : "";
        risks.push({
          kind: "task_missing_from_ledger",
          message: `未入 ledger 的 TASK: ${sample}${suffix} — 建议 LedgerBuilder.rebuild()`,
        });
      }
    }
  }

  const protocolless = collectProtocollessFragments(projectRoot);
  if (protocolless.length > 0) {
    const sample = protocolless.slice(0, 3).join(", ");
    const suffix =
      protocolless.length > 3 ? ` 等 ${protocolless.length} 个文件` : "";
    risks.push({
      kind: "protocolless_fragment",
      message: `无 protocol frontmatter 的 IPC 残片: ${sample}${suffix}`,
    });
  }

  return risks;
}

/** Count TASK-*.md in inbox (primary task surface for panel stats). */
export function countInboxTasks(inboxDir: string): number {
  if (!existsSync(inboxDir)) return 0;
  try {
    return readdirSync(inboxDir).filter(
      (f) => f.startsWith("TASK-") && f.endsWith(".md"),
    ).length;
  } catch {
    return 0;
  }
}

/** Count TASK-*.md across all v3 lifecycle stages (flat dirs only). */
export function countLifecycleTasks(paths: FcopV3Paths): number {
  const seen = new Set<string>();
  for (const dir of fcopV3TaskSearchDirs(paths)) {
    if (!existsSync(dir)) continue;
    try {
      for (const f of readdirSync(dir)) {
        if (f.startsWith("TASK-") && f.endsWith(".md")) seen.add(f);
      }
    } catch {
      /* skip unreadable dir */
    }
  }
  return seen.size;
}

/** CodeFlowMu product default — must match panel init & fcop-mcp dev-team preset. */
export const CODEFLOWMU_DEFAULT_TEAM = "dev-team";

/** Rule 4.5 Layer 1–2 team constitution files (required when team mode). */
export const RULE_45_CORE_SHARED_DOCS = [
  "TEAM-ROLES.md",
  "TEAM-OPERATING-RULES.md",
] as const;

export const DEV_TEAM_DEFAULT_ROLE_CODES = ["PM", "DEV", "QA", "OPS"] as const;

export interface RoleTemplateCheckItem {
  rel: string;
  label: string;
  exists: boolean;
  required: boolean;
}

export interface RoleTemplateHealth {
  /** fcop/fcop.json 存在时才做 Rule 4.5 检查 */
  applicable: boolean;
  ok: boolean;
  team: string;
  leader: string | null;
  roles: string[];
  deployedVersionMarker: boolean;
  /** 仅有 .deployed_version 标记、三层团队文档缺失 — 典型「半初始化 / 传声筒」 */
  ghostInit: boolean;
  missing: string[];
  checks: RoleTemplateCheckItem[];
  summary: string;
}

export interface RoleTemplateHealthInput {
  team?: string | null;
  leader?: string | null;
  roles?: string[] | null;
  mode?: string | null;
}

/**
 * Rule 4.5 · 团队角色模板健康检查。
 * CodeFlowMu 是 FCoP 下游应用：目录全绿但缺 roles/*.md = 协议不合规，必须 fail 可见。
 */
export function checkRoleTemplateHealth(
  projectRoot: string,
  meta: RoleTemplateHealthInput = {},
): RoleTemplateHealth {
  const fcopJsonPath = join(projectRoot, "fcop", "fcop.json");
  const sharedDir = join(projectRoot, "fcop", "shared");
  const deployedVersionMarker = existsSync(join(sharedDir, ".deployed_version"));

  if (!existsSync(fcopJsonPath)) {
    return {
      applicable: false,
      ok: true,
      team: meta.team ?? CODEFLOWMU_DEFAULT_TEAM,
      leader: meta.leader ?? null,
      roles: meta.roles ?? [...DEV_TEAM_DEFAULT_ROLE_CODES],
      deployedVersionMarker,
      ghostInit: false,
      missing: [],
      checks: [],
      summary: "fcop/fcop.json 不存在 — 跳过 Rule 4.5 角色文档检查（请先初始化）",
    };
  }

  const mode = (meta.mode ?? "team").toLowerCase();
  const team = meta.team ?? CODEFLOWMU_DEFAULT_TEAM;
  const roleCodes =
    meta.roles?.length
      ? meta.roles
      : mode === "solo"
        ? ["ME"]
        : [...DEV_TEAM_DEFAULT_ROLE_CODES];

  const checks: RoleTemplateCheckItem[] = [];

  for (const name of RULE_45_CORE_SHARED_DOCS) {
    const rel = `fcop/shared/${name}`;
    checks.push({
      rel,
      label: name,
      exists: existsSync(join(projectRoot, ...rel.split("/"))),
      required: true,
    });
  }

  for (const code of roleCodes) {
    const rel = `fcop/shared/roles/${code}.md`;
    checks.push({
      rel,
      label: `roles/${code}.md`,
      exists: existsSync(join(projectRoot, ...rel.split("/"))),
      required: true,
    });
  }

  const missing = checks.filter((c) => c.required && !c.exists).map((c) => c.rel);
  const coreMissing = missing.some((m) =>
    RULE_45_CORE_SHARED_DOCS.some((d) => m.endsWith(d)),
  );
  const ghostInit = deployedVersionMarker && coreMissing;
  const ok = missing.length === 0;

  let summary: string;
  if (ok) {
    summary = `Rule 4.5 团队文档齐全（${team}，${roleCodes.length} 个岗位）`;
  } else if (ghostInit) {
    summary =
      `半初始化：存在 fcop/shared/.deployed_version 但缺 ${missing.length} 个必需文件 — ` +
      `Agent 会退化成传声筒；请 deploy_role_templates 或面板「补部署角色文档」`;
  } else {
    summary = `缺失 ${missing.length} 个 Rule 4.5 必需文件：${missing.slice(0, 4).join(", ")}` +
      (missing.length > 4 ? " …" : "");
  }

  return {
    applicable: true,
    ok,
    team,
    leader: meta.leader ?? null,
    roles: roleCodes,
    deployedVersionMarker,
    ghostInit,
    missing,
    checks,
    summary,
  };
}

/** 单条初始化验收项（供 init SSE / env/check 复用）。 */
export interface FcopInitVerifyItem {
  id: string;
  name: string;
  status: "ok" | "fail" | "warn";
  detail: string;
}

/** 一键 init 后的磁盘验收结果。 */
export interface FcopInitVerification {
  ok: boolean;
  projectRoot: string;
  items: FcopInitVerifyItem[];
  roleTemplateHealth: RoleTemplateHealth;
  skillsHealth: SkillsManifestHealth;
  failures: string[];
  warnings: string[];
  summary: string;
}

/** Agent / PM skills manifest 磁盘验收（只读，供 init SSE / env/check）。 */
export interface SkillsManifestHealth {
  applicable: boolean;
  ok: boolean;
  agentSourceExists: boolean;
  agentProjectionExists: boolean;
  pmManifestExists: boolean;
  pmSkillCount: number;
  agentCatalogEntries: number;
  missingSkillPackages: string[];
  summary: string;
}

export const AGENT_SKILLS_SOURCE_REL = "docs/skills/agent-skills.manifest.json";
export const AGENT_SKILLS_PROJECTION_REL = ".codeflowmu/agent-skills.manifest.json";
export const PM_SKILLS_PROJECTION_REL = ".codeflowmu/pm-skills.manifest.json";

const PM_BUILTIN_SKILL_IDS = [
  "pm.summarize_thread",
  "pm.detect_thread_stall",
  "pm.close_admin_task",
  "pm.wake_downstream",
  "pm.review_check",
] as const;

const AGENT_PLAYBOOK_GROUP_KEYS = [
  "common_skills",
  "pm_playbook_skills",
  "technical_manager_playbook_skills",
  "architect_playbook_skills",
  "dev_playbook_skills",
  "qa_playbook_skills",
  "ops_playbook_skills",
  "eval_playbook_skills",
  "ui_playbook_skills",
] as const;

function readJsonObject(projectRoot: string, relPath: string): Record<string, unknown> | null {
  const p = join(projectRoot, relPath);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf-8");
    const j = JSON.parse(raw) as unknown;
    if (typeof j === "object" && j !== null && !Array.isArray(j)) {
      return j as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function collectAgentPlaybookPackages(manifest: Record<string, unknown>): {
  entries: number;
  packages: string[];
} {
  let entries = 0;
  const packages: string[] = [];
  for (const key of AGENT_PLAYBOOK_GROUP_KEYS) {
    const arr = manifest[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      entries += 1;
      const rec = item as Record<string, unknown>;
      const pkg = rec.skill_package;
      if (typeof pkg === "string" && pkg.trim()) packages.push(pkg.trim());
    }
  }
  return { entries, packages };
}

function agentSkillPackageExists(projectRoot: string, relPath: string): boolean {
  const roots = [pathResolve(projectRoot)];
  const hostRoot = process.env["CODEFLOWMU_HOST_ROOT"]?.trim();
  if (hostRoot) {
    const resolvedHost = pathResolve(hostRoot);
    if (!roots.some((root) => root.toLowerCase() === resolvedHost.toLowerCase())) {
      roots.push(resolvedHost);
    }
  }
  const clean = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return roots.some((root) => existsSync(pathResolve(root, clean)));
}

/**
 * 验收 PM / Agent Playbook skills manifest（只读）。
 * - CodeFlowMu 自身仓库可以带 `docs/skills/agent-skills.manifest.json` 源表。
 * - 外部产品项目只要求 `.codeflowmu/agent-skills.manifest.json` 运行态投影存在；
 *   项目本身没有 `docs/skills` 不应阻断初始化。
 */
export function checkSkillsManifestHealth(projectRoot: string): SkillsManifestHealth {
  const fcopJsonExists = existsSync(join(projectRoot, "fcop", "fcop.json"));
  if (!fcopJsonExists) {
    return {
      applicable: false,
      ok: true,
      agentSourceExists: false,
      agentProjectionExists: false,
      pmManifestExists: false,
      pmSkillCount: 0,
      agentCatalogEntries: 0,
      missingSkillPackages: [],
      summary: "未初始化 FCoP，跳过 skills manifest 验收",
    };
  }

  const agentSourcePath = join(projectRoot, AGENT_SKILLS_SOURCE_REL);
  const agentProjectionPath = join(projectRoot, AGENT_SKILLS_PROJECTION_REL);
  const pmPath = join(projectRoot, PM_SKILLS_PROJECTION_REL);

  const agentSourceExists = existsSync(agentSourcePath);
  const agentProjectionExists = existsSync(agentProjectionPath);
  const pmManifestExists = existsSync(pmPath);

  const missingSkillPackages: string[] = [];
  let agentCatalogEntries = 0;

  const manifestForPackages =
    readJsonObject(projectRoot, AGENT_SKILLS_PROJECTION_REL) ??
    readJsonObject(projectRoot, AGENT_SKILLS_SOURCE_REL);
  if (manifestForPackages) {
    const collected = collectAgentPlaybookPackages(manifestForPackages);
    agentCatalogEntries = collected.entries;
    for (const rel of collected.packages) {
      if (!agentSkillPackageExists(projectRoot, rel)) missingSkillPackages.push(rel);
    }
  }

  let pmSkillCount = 0;
  const pmData = readJsonObject(projectRoot, PM_SKILLS_PROJECTION_REL);
  if (pmData?.kind === "pm-builtin-skills" && Array.isArray(pmData.skills)) {
    const ids = new Set(
      pmData.skills
        .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
        .map((s) => (typeof s.skill_id === "string" ? s.skill_id : ""))
        .filter(Boolean),
    );
    pmSkillCount = PM_BUILTIN_SKILL_IDS.filter((id) => ids.has(id)).length;
  }

  const failures: string[] = [];
  const warnings: string[] = [];

  // Adopted projects intentionally carry only the runtime projection. The
  // source manifest belongs to the mother app, so its absence is healthy.
  if (!agentProjectionExists && agentSourceExists) {
    warnings.push(
      `${AGENT_SKILLS_PROJECTION_REL} 缺失 — Shell/init 会从 ${AGENT_SKILLS_SOURCE_REL} copy-if-missing 恢复`,
    );
  }
  if (!agentProjectionExists && !agentSourceExists) {
    failures.push("Agent Playbook manifest 源与投影均缺失");
  }
  if (!pmManifestExists) {
    warnings.push(
      `${PM_SKILLS_PROJECTION_REL} 缺失 — Shell/init 会 plantPmSkillManifestIfMissing 补种`,
    );
  } else if (pmSkillCount < PM_BUILTIN_SKILL_IDS.length) {
    warnings.push(
      `PM 内置技能条目 ${pmSkillCount}/${PM_BUILTIN_SKILL_IDS.length} — manifest 不完整或 skill_id 漂移`,
    );
  }
  if (manifestForPackages && agentCatalogEntries === 0) {
    warnings.push("agent-skills manifest 未解析到任何 Playbook 条目");
  }
  if (missingSkillPackages.length > 0) {
    const sample = missingSkillPackages.slice(0, 3).join("、");
    warnings.push(
      `${missingSkillPackages.length} 个 skill_package 路径不存在` +
        (sample ? `（如 ${sample}）` : ""),
    );
  }

  const applicable = true;
  const ok = failures.length === 0;
  let summary: string;
  if (!applicable) {
    summary = "未初始化 FCoP，跳过 skills manifest 验收";
  } else if (!ok) {
    summary = failures[0] ?? "skills manifest 验收失败";
  } else if (warnings.length > 0) {
    summary =
      `skills 可恢复（PM ${pmManifestExists ? pmSkillCount : 0}/5，Playbook ${agentCatalogEntries} 条` +
      `${missingSkillPackages.length ? `，缺包 ${missingSkillPackages.length}` : ""}）`;
  } else {
    summary =
      `skills 就绪（PM ${pmSkillCount}/5，Agent Playbook ${agentCatalogEntries} 条，skill 包齐全）`;
  }

  return {
    applicable,
    ok,
    agentSourceExists,
    agentProjectionExists,
    pmManifestExists,
    pmSkillCount,
    agentCatalogEntries,
    missingSkillPackages,
    summary,
  };
}

function readProtocolVersionFromDisk(projectRoot: string): number | null {
  const p = join(projectRoot, "fcop", "fcop.json");
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf-8");
    const j = JSON.parse(raw) as Record<string, unknown>;
    const v = j.protocol_version ?? j.protocolVersion;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && /^\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
    return null;
  } catch {
    return null;
  }
}

/**
 * 验收 FCoP 一键初始化结果（只读磁盘，不调用 MCP）。
 * fail 项阻塞 ok；warn 项（如 adopted 空）不阻塞，但写入 warnings。
 */
export function verifyFcopProjectInit(projectRoot: string): FcopInitVerification {
  const items: FcopInitVerifyItem[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];
  const fcopJsonPath = join(projectRoot, "fcop", "fcop.json");
  const paths = fcopV3Paths(projectRoot);

  if (existsSync(fcopJsonPath)) {
    items.push({
      id: "fcop_json",
      name: "fcop/fcop.json",
      status: "ok",
      detail: "项目身份文件已落盘",
    });
  } else {
    const detail = "fcop/fcop.json 不存在 — init 未写入当前产品开发根";
    items.push({ id: "fcop_json", name: "fcop/fcop.json", status: "fail", detail });
    failures.push(detail);
  }

  const protocolVersion = readProtocolVersionFromDisk(projectRoot);
  if (protocolVersion !== null && protocolVersion >= 3) {
    items.push({
      id: "protocol_version",
      name: "protocol_version ≥ 3",
      status: "ok",
      detail: `protocol_version=${protocolVersion}`,
    });
  } else if (protocolVersion !== null) {
    const detail = `protocol_version=${protocolVersion}（需要 ≥ 3）`;
    items.push({ id: "protocol_version", name: "protocol_version", status: "fail", detail });
    failures.push(detail);
  } else if (existsSync(fcopJsonPath)) {
    const detail = "fcop.json 缺少 protocol_version（v3 项目必填）";
    items.push({ id: "protocol_version", name: "protocol_version", status: "fail", detail });
    failures.push(detail);
  }

  if (existsSync(paths.inbox)) {
    items.push({
      id: "lifecycle_inbox",
      name: "fcop/_lifecycle/inbox",
      status: "ok",
      detail: "v3 生命周期 inbox 已创建",
    });
  } else {
    const detail = "fcop/_lifecycle/inbox 不存在 — v3 布局不完整";
    items.push({ id: "lifecycle_inbox", name: "fcop/_lifecycle/inbox", status: "fail", detail });
    failures.push(detail);
  }

  const workFolders = checkFcop0002WorkFolders(projectRoot);
  const missingWork = workFolders.filter((f) => !f.exists).map((f) => f.path);
  if (missingWork.length === 0) {
    items.push({
      id: "work_folders_0002",
      name: "0002 工作目录五桶",
      status: "ok",
      detail: "tasks / reports / issues / ledger / attachments 齐全",
    });
  } else {
    const detail = `缺少 0002 目录：${missingWork.join("、")}`;
    items.push({ id: "work_folders_0002", name: "0002 工作目录", status: "fail", detail });
    failures.push(detail);
  }

  const roleTemplateHealth = checkRoleTemplateHealth(projectRoot);
  if (!roleTemplateHealth.applicable) {
    items.push({
      id: "role_templates",
      name: "Rule 4.5 角色文档",
      status: "fail",
      detail: "无法验收（fcop.json 不可用）",
    });
    failures.push("Rule 4.5 角色文档无法验收");
  } else if (roleTemplateHealth.ok) {
    items.push({
      id: "role_templates",
      name: "Rule 4.5 角色文档",
      status: "ok",
      detail: roleTemplateHealth.summary,
    });
  } else {
    items.push({
      id: "role_templates",
      name: "Rule 4.5 角色文档",
      status: "fail",
      detail: roleTemplateHealth.summary,
    });
    failures.push(roleTemplateHealth.summary);
  }

  const adoptedDir = join(projectRoot, "fcop", "adopted");
  const adoptedSourceDir = join(projectRoot, "adoptedSource");
  const adoptedHasFiles =
    existsSync(adoptedDir) &&
    (() => {
      try {
        return countFilesRecursive(adoptedDir) > 0;
      } catch {
        return false;
      }
    })();
  if (adoptedHasFiles) {
    items.push({
      id: "adopted_bootstrap",
      name: "fcop/adopted/",
      status: "ok",
      detail: "示范体 adopted 已就绪",
    });
  } else if (existsSync(adoptedSourceDir)) {
    const detail =
      "fcop/adopted/ 仍为空 — 需重启 Shell 或再次运行 init 以从 adoptedSource/ 复制";
    items.push({ id: "adopted_bootstrap", name: "fcop/adopted/", status: "warn", detail });
    warnings.push(detail);
  } else {
    const detail =
      "fcop/adopted/ 为空且 adoptedSource/ 不存在 — 游戏类项目可稍后补；协作账本仍可工作";
    items.push({ id: "adopted_bootstrap", name: "fcop/adopted/", status: "warn", detail });
    warnings.push(detail);
  }

  const skillsHealth = checkSkillsManifestHealth(projectRoot);
  if (!skillsHealth.applicable) {
    items.push({
      id: "skills_manifest",
      name: "Skills manifest",
      status: "warn",
      detail: skillsHealth.summary,
    });
  } else if (!skillsHealth.ok) {
    items.push({
      id: "skills_manifest",
      name: "Skills manifest",
      status: "fail",
      detail: skillsHealth.summary,
    });
    failures.push(skillsHealth.summary);
  } else if (skillsHealth.missingSkillPackages.length > 0 || !skillsHealth.pmManifestExists || !skillsHealth.agentProjectionExists) {
    items.push({
      id: "skills_manifest",
      name: "Skills manifest",
      status: "warn",
      detail: skillsHealth.summary,
    });
    warnings.push(skillsHealth.summary);
  } else {
    items.push({
      id: "skills_manifest",
      name: "Skills manifest",
      status: "ok",
      detail: skillsHealth.summary,
    });
  }

  const ok = failures.length === 0;
  const summary = ok
    ? warnings.length > 0
      ? `初始化通过（${warnings.length} 项警告）`
      : "初始化验收通过"
    : `初始化未通过：${failures[0] ?? "未知"}`;

  return {
    ok,
    projectRoot,
    items,
    roleTemplateHealth,
    skillsHealth,
    failures,
    warnings,
    summary,
  };
}

function countFilesRecursive(dir: string): number {
  let n = 0;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".")) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) n += countFilesRecursive(full);
    else if (ent.isFile()) n += 1;
  }
  return n;
}
