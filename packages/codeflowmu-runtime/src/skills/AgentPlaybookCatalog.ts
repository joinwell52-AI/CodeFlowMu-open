/**
 * Read agent playbook manifest and build a panel-friendly catalog.
 */
import { readFile, access } from "node:fs/promises";

import {
  agentSkillsManifestProjectionPath,
  agentSkillsManifestSourcePath,
} from "./AgentPlaybookManifest.ts";
import { resolveSkillAssetPath } from "./SkillAssetResolver.ts";

export type AgentSkillsManifestReadFrom = "projection" | "source";

export interface AgentSkillCatalogEntry {
  id: string;
  display_name: string;
  description?: string;
  status: string;
  doc?: string;
  skill_package?: string;
  package_exists?: boolean;
  role?: string;
  maps_to_common?: string[];
  mapped_mcp_tools?: string[];
  mapped_pm_runtime_skills?: string[];
}

export interface AgentSkillCatalogGroup {
  id: string;
  label: string;
  skills: AgentSkillCatalogEntry[];
}

export interface AgentSkillsCatalog {
  version: number;
  kind: string;
  scope?: string;
  read_from: AgentSkillsManifestReadFrom;
  manifest_path: string;
  source_path: string;
  layers?: Record<string, unknown>;
  groups: AgentSkillCatalogGroup[];
  forbidden_v1: string[];
  counts: {
    total_entries: number;
    playbook_packages: number;
    common: number;
    role_runtime: number;
  };
}

export const PLAYBOOK_SKILL_GROUP_DEFS: ReadonlyArray<{
  key: string;
  label: string;
}> = [
  { key: "common_skills", label: "FCoP 通用技能" },
  { key: "pm_playbook_skills", label: "PM Playbook" },
  { key: "technical_manager_playbook_skills", label: "技术经理 Playbook" },
  { key: "architect_playbook_skills", label: "架构师 Playbook" },
  { key: "dev_playbook_skills", label: "DEV Playbook" },
  { key: "qa_playbook_skills", label: "QA Playbook" },
  { key: "ops_playbook_skills", label: "OPS Playbook" },
  { key: "eval_playbook_skills", label: "EVAL Playbook" },
  { key: "ui_playbook_skills", label: "UI Playbook" },
];

type ManifestRecord = Record<string, unknown>;

const PLANNED_SKILL_DISPLAY_NAMES: Record<string, string> = {
  admin_review_task: "ADMIN 审查任务",
  admin_approve_promotion: "ADMIN 批准晋升",
  admin_archive_task: "ADMIN 归档任务",
  admin_submit_issue: "ADMIN 提交 Issue",
  admin_reject_or_hold: "ADMIN 驳回或暂挂",
};

export interface ReadAgentSkillsManifestResult {
  read_from: AgentSkillsManifestReadFrom;
  path: string;
  source_path: string;
  data: ManifestRecord;
}

export class AgentSkillsManifestMissingError extends Error {
  readonly source_path: string;
  readonly projection_path: string;

  constructor(source_path: string, projection_path: string) {
    super(
      `agent skills manifest missing (projection=${projection_path}, source=${source_path})`,
    );
    this.name = "AgentSkillsManifestMissingError";
    this.source_path = source_path;
    this.projection_path = projection_path;
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AgentSkillsManifestReadError extends Error {
  readonly path: string;

  constructor(path: string, error: unknown) {
    super(`failed to read agent skills manifest at ${path}: ${errorDetail(error)}`);
    this.name = "AgentSkillsManifestReadError";
    this.path = path;
  }
}

export class AgentSkillsManifestInvalidError extends Error {
  readonly path: string;

  constructor(path: string, error: unknown) {
    super(`invalid agent skills manifest JSON at ${path}: ${errorDetail(error)}`);
    this.name = "AgentSkillsManifestInvalidError";
    this.path = path;
  }
}

/** Projection first, then docs/skills source (same order as plant-if-missing). */
export async function readAgentSkillsManifestResolved(
  projectRoot: string,
): Promise<ReadAgentSkillsManifestResult> {
  const projection = agentSkillsManifestProjectionPath(projectRoot);
  const source = agentSkillsManifestSourcePath(projectRoot);
  let invalidError: AgentSkillsManifestInvalidError | null = null;
  for (const [read_from, path] of [
    ["projection", projection],
    ["source", source],
  ] as const) {
    try {
      await access(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw new AgentSkillsManifestReadError(path, error);
    }
    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch (error) {
      throw new AgentSkillsManifestReadError(path, error);
    }
    try {
      const data = JSON.parse(raw) as ManifestRecord;
      return { read_from, path, source_path: source, data };
    } catch (error) {
      invalidError ??= new AgentSkillsManifestInvalidError(path, error);
    }
  }
  if (invalidError) throw invalidError;
  throw new AgentSkillsManifestMissingError(source, projection);
}

function asSkillArray(value: unknown): ManifestRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is ManifestRecord =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length ? out : undefined;
}

async function packageExists(
  projectRoot: string,
  rel?: string,
): Promise<boolean | undefined> {
  if (!rel) return undefined;
  return (await resolveSkillAssetPath(projectRoot, rel)) !== null;
}

function skillDescriptionFromMarkdown(raw: string): string | undefined {
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const desc = fm[1]?.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    if (desc) return desc.replace(/^["']|["']$/g, "").trim();
  }
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  const firstParagraph = body
    .split(/\r?\n\r?\n/)
    .map((part) => part.trim())
    .find((part) => part && !part.startsWith("#"));
  return firstParagraph?.replace(/\s+/g, " ").slice(0, 500) || undefined;
}

async function readSkillPackageDescription(
  projectRoot: string,
  rel?: string,
): Promise<string | undefined> {
  if (!rel) return undefined;
  try {
    const path = await resolveSkillAssetPath(projectRoot, rel);
    if (!path) return undefined;
    const raw = await readFile(path, "utf-8");
    return skillDescriptionFromMarkdown(raw);
  } catch {
    return undefined;
  }
}

function mapPlaybookEntry(
  raw: ManifestRecord,
  groupId: string,
  pkgExists?: boolean,
): AgentSkillCatalogEntry {
  return {
    id: str(raw.id),
    display_name: str(raw.display_name) || str(raw.id),
    description: str(raw.description) || undefined,
    status: str(raw.status) || "unknown",
    doc: str(raw.doc) || undefined,
    skill_package: str(raw.skill_package) || undefined,
    package_exists: pkgExists,
    role: groupId,
    maps_to_common: strArray(raw.maps_to_common),
    mapped_mcp_tools: strArray(raw.mapped_mcp_tools),
    mapped_pm_runtime_skills: strArray(raw.mapped_pm_runtime_skills),
  };
}

function buildPlaybookEntryIndex(
  data: ManifestRecord,
): Map<string, AgentSkillCatalogEntry> {
  const out = new Map<string, AgentSkillCatalogEntry>();
  for (const def of PLAYBOOK_SKILL_GROUP_DEFS) {
    for (const raw of asSkillArray(data[def.key])) {
      const entry = mapPlaybookEntry(raw, def.key, undefined);
      if (entry.id) out.set(entry.id, entry);
    }
  }
  return out;
}

function buildRoleSkillsGroup(
  roleSkills: unknown,
  playbookIndex?: Map<string, AgentSkillCatalogEntry>,
): AgentSkillCatalogGroup {
  const skills: AgentSkillCatalogEntry[] = [];
  if (typeof roleSkills !== "object" || roleSkills === null || Array.isArray(roleSkills)) {
    return { id: "role_skills", label: "角色 Runtime 技能", skills };
  }
  const rs = roleSkills as Record<string, ManifestRecord>;
  for (const [role, block] of Object.entries(rs)) {
    const status = str(block.status);
    const implemented = asSkillArray(block.implemented_skills);
    for (const item of implemented) {
      skills.push({
        id: str(item.id),
        display_name: str(item.display_name) || str(item.id),
        description: str(item.description) || undefined,
        status: status || "implemented",
        role,
        maps_to_common: strArray(item.maps_to_common),
      });
    }
    const playbookIds = strArray(block.playbook_skills) ?? [];
    for (const pid of playbookIds) {
      const ref = playbookIndex?.get(pid);
      skills.push({
        id: pid,
        display_name: ref?.display_name || pid,
        description: ref?.description,
        status: status || "playbook_stub_only",
        doc: ref?.doc,
        skill_package: ref?.skill_package,
        role,
        maps_to_common: ref?.maps_to_common,
        mapped_mcp_tools: ref?.mapped_mcp_tools,
        mapped_pm_runtime_skills: ref?.mapped_pm_runtime_skills,
      });
    }
    const planned = strArray(block.planned_skills) ?? [];
    for (const pid of planned) {
      skills.push({
        id: pid,
        display_name: PLANNED_SKILL_DISPLAY_NAMES[pid] || pid,
        description: "需要真人 ADMIN 执行或确认的治理动作，Agent 只能等待授权或记录请求，不能自动完成。",
        status: "human_control_only",
        role,
      });
    }
    if (
      !implemented.length &&
      !playbookIds.length &&
      !planned.length &&
      str(block.manifest)
    ) {
      skills.push({
        id: `${role}-manifest`,
        display_name: `${role} 技能清单`,
        description: "该角色的技能清单入口，用于查看角色能力边界和可用 Playbook。",
        status,
        doc: str(block.manifest) || undefined,
        role,
      });
    }
  }
  return { id: "role_skills", label: "角色 Runtime 技能", skills };
}

/** Build catalog from parsed manifest JSON (sync; optional package stat). */
export function buildAgentSkillsCatalog(
  data: ManifestRecord,
  meta: Pick<ReadAgentSkillsManifestResult, "read_from" | "path" | "source_path">,
  opts?: { projectRoot?: string; checkPackages?: boolean },
): AgentSkillsCatalog {
  const groups: AgentSkillCatalogGroup[] = [];
  let playbookPackages = 0;
  let commonCount = 0;
  let roleRuntimeCount = 0;
  const playbookIndex = buildPlaybookEntryIndex(data);

  for (const def of PLAYBOOK_SKILL_GROUP_DEFS) {
    const rawList = asSkillArray(data[def.key]);
    if (!rawList.length) continue;
    if (def.key === "common_skills") commonCount = rawList.length;
    const skills: AgentSkillCatalogEntry[] = [];
    for (const raw of rawList) {
      const pkg = str(raw.skill_package) || undefined;
      if (pkg) playbookPackages += 1;
      skills.push(
        mapPlaybookEntry(raw, def.key, undefined),
      );
    }
    groups.push({ id: def.key, label: def.label, skills });
  }

  const roleGroup = buildRoleSkillsGroup(data.role_skills, playbookIndex);
  if (roleGroup.skills.length) {
    roleRuntimeCount = roleGroup.skills.length;
    groups.push(roleGroup);
  }

  const forbidden = Array.isArray(data.forbidden_v1)
    ? data.forbidden_v1.filter((x): x is string => typeof x === "string")
    : [];

  const catalog: AgentSkillsCatalog = {
    version: typeof data.version === "number" ? data.version : 0,
    kind: str(data.kind) || "agent_skills_manifest",
    scope: str(data.scope) || undefined,
    read_from: meta.read_from,
    manifest_path: meta.path,
    source_path: meta.source_path,
    layers:
      typeof data.layers === "object" && data.layers !== null
        ? (data.layers as Record<string, unknown>)
        : undefined,
    groups,
    forbidden_v1: forbidden,
    counts: {
      total_entries: groups.reduce((n, g) => n + g.skills.length, 0),
      playbook_packages: playbookPackages,
      common: commonCount,
      role_runtime: roleRuntimeCount,
    },
  };

  if (opts?.checkPackages && opts.projectRoot) {
    return catalog; // filled below via async helper
  }
  return catalog;
}

/** Resolve package_exists on disk for playbook entries. */
export async function enrichAgentSkillsCatalogPackages(
  projectRoot: string,
  catalog: AgentSkillsCatalog,
): Promise<AgentSkillsCatalog> {
  const groups = await Promise.all(
    catalog.groups.map(async (group) => ({
      ...group,
      skills: await Promise.all(
        group.skills.map(async (skill) => {
          if (!skill.skill_package) return skill;
          const package_exists = await packageExists(
            projectRoot,
            skill.skill_package,
          );
          const description = skill.description
            ?? await readSkillPackageDescription(projectRoot, skill.skill_package);
          return { ...skill, package_exists, description };
        }),
      ),
    })),
  );
  return { ...catalog, groups };
}

export async function loadAgentSkillsCatalog(
  projectRoot: string,
  opts?: { checkPackages?: boolean },
): Promise<AgentSkillsCatalog> {
  const resolved = await readAgentSkillsManifestResolved(projectRoot);
  const base = buildAgentSkillsCatalog(resolved.data, resolved, {
    projectRoot,
    checkPackages: opts?.checkPackages,
  });
  if (opts?.checkPackages !== false) {
    return enrichAgentSkillsCatalogPackages(projectRoot, base);
  }
  return base;
}
