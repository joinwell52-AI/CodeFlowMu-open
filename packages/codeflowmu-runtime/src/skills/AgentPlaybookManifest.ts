/**
 * Agent Playbook Skill manifest: stable source vs local/runtime projection.
 *
 * - `docs/skills/agent-skills.manifest.json` — source-of-truth (in repo)
 * - `.codeflowmu/agent-skills.manifest.json` — runtime projection (may be deleted with `.codeflowmu/`)
 */
import { access, copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const AGENT_SKILLS_MANIFEST_SOURCE_REL = "docs/skills/agent-skills.manifest.json";
export const AGENT_SKILLS_MANIFEST_PROJECTION_REL =
  ".codeflowmu/agent-skills.manifest.json";

export function agentSkillsManifestSourcePath(projectRoot: string): string {
  return join(projectRoot, AGENT_SKILLS_MANIFEST_SOURCE_REL);
}

export function agentSkillsManifestProjectionPath(projectRoot: string): string {
  return join(projectRoot, AGENT_SKILLS_MANIFEST_PROJECTION_REL);
}

export interface PlantAgentSkillsManifestResult {
  planted: boolean;
  path: string;
  sourcePath: string;
  /** True when projection was missing but docs/skills source file does not exist. */
  sourceMissing: boolean;
}

export interface PlantAgentSkillsManifestOptions {
  /**
   * Optional CodeFlowMu host root used as the source of the stable
   * docs/skills manifest when planting into an external product project.
   */
  sourceRoot?: string;
}

export interface SyncAgentPlaybookAssetsResult {
  sourceManifestPath: string;
  docsManifestPath: string;
  projectionManifestPath: string;
  docsManifestChanged: boolean;
  projectionManifestChanged: boolean;
  copiedSkillPackages: string[];
  preservedSkillPackages: string[];
}

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function manifestEntryKey(value: unknown): string {
  if (!isJsonRecord(value)) return `value:${JSON.stringify(value)}`;
  for (const field of ["id", "skill_id", "skill_package", "doc"]) {
    const candidate = value[field];
    if (typeof candidate === "string" && candidate.trim()) {
      return `${field}:${candidate.trim()}`;
    }
  }
  return `value:${JSON.stringify(value)}`;
}

/**
 * Add host-public entries without replacing project-local entries.
 * Existing entries win on key collisions so project customisations survive upgrades.
 */
export function mergeAgentSkillsManifest(
  existing: JsonRecord,
  publicManifest: JsonRecord,
): JsonRecord {
  const merged: JsonRecord = { ...publicManifest, ...existing };
  const keys = new Set([...Object.keys(publicManifest), ...Object.keys(existing)]);
  for (const key of keys) {
    const current = existing[key];
    const published = publicManifest[key];
    if (!Array.isArray(current) && !Array.isArray(published)) continue;
    if (!Array.isArray(current)) {
      merged[key] = published;
      continue;
    }
    if (!Array.isArray(published)) {
      merged[key] = current;
      continue;
    }
    const seen = new Set(current.map(manifestEntryKey));
    merged[key] = [
      ...current,
      ...published.filter((entry) => {
        const entryKey = manifestEntryKey(entry);
        if (seen.has(entryKey)) return false;
        seen.add(entryKey);
        return true;
      }),
    ];
  }

  // These fields describe the host publication, not a user-authored skill entry.
  for (const key of [
    "version",
    "kind",
    "edition",
    "public_skill_package_policy",
    "filtered_missing_private_skill_packages",
  ]) {
    if (key in publicManifest) merged[key] = publicManifest[key];
  }
  return merged;
}

export function collectAgentSkillPackagePaths(manifest: JsonRecord): string[] {
  const found = new Set<string>();
  for (const value of Object.values(manifest)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (!isJsonRecord(entry) || typeof entry["skill_package"] !== "string") continue;
      const normalized = entry["skill_package"].trim().replace(/\\/g, "/").replace(/^\/+/, "");
      if (normalized) found.add(normalized);
    }
  }
  return [...found].sort();
}

function assertPublicSkillPackagePath(relativePath: string): void {
  if (
    !relativePath
    || isAbsolute(relativePath)
    || relativePath.split("/").includes("..")
    || !/^skills\/[^/]+\/SKILL\.md$/.test(relativePath)
  ) {
    throw new Error(`INVALID_AGENT_SKILL_PACKAGE_PATH: ${relativePath}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(path: string): Promise<JsonRecord> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isJsonRecord(parsed)) {
    throw new Error(`INVALID_AGENT_SKILLS_MANIFEST: ${path}`);
  }
  return parsed;
}

async function writeManifestIfChanged(path: string, manifest: JsonRecord): Promise<boolean> {
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch {
    // A missing target is created below.
  }
  if (current === serialized) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialized, "utf8");
  return true;
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * Reconcile the host's public Playbook manifest and packages into a project.
 *
 * - public manifest entries are appended when absent;
 * - project-local entries and same-name package files are never overwritten;
 * - every public skill_package must exist at the host and after reconciliation.
 */
export async function syncAgentPlaybookAssets(
  projectRoot: string,
  opts: PlantAgentSkillsManifestOptions = {},
): Promise<SyncAgentPlaybookAssetsResult> {
  const sourceRoot = resolve(opts.sourceRoot ?? projectRoot);
  const targetRoot = resolve(projectRoot);
  const sourceManifestPath = agentSkillsManifestSourcePath(sourceRoot);
  const docsManifestPath = agentSkillsManifestSourcePath(targetRoot);
  const projectionManifestPath = agentSkillsManifestProjectionPath(targetRoot);
  const publicManifest = await readManifest(sourceManifestPath);
  const packagePaths = collectAgentSkillPackagePaths(publicManifest);

  for (const relativePath of packagePaths) {
    assertPublicSkillPackagePath(relativePath);
    if (!(await pathExists(resolve(sourceRoot, relativePath)))) {
      throw new Error(`MISSING_PUBLIC_AGENT_SKILL_PACKAGE: ${relativePath}`);
    }
  }

  let mergedDocsManifest = publicManifest;
  let docsManifestChanged = false;
  if (!samePath(sourceManifestPath, docsManifestPath)) {
    if (await pathExists(docsManifestPath)) {
      mergedDocsManifest = mergeAgentSkillsManifest(
        await readManifest(docsManifestPath),
        publicManifest,
      );
    }
    docsManifestChanged = await writeManifestIfChanged(docsManifestPath, mergedDocsManifest);
  }

  let mergedProjectionManifest = mergedDocsManifest;
  if (await pathExists(projectionManifestPath)) {
    mergedProjectionManifest = mergeAgentSkillsManifest(
      await readManifest(projectionManifestPath),
      mergedDocsManifest,
    );
  }
  const projectionManifestChanged = await writeManifestIfChanged(
    projectionManifestPath,
    mergedProjectionManifest,
  );

  const copiedSkillPackages: string[] = [];
  const preservedSkillPackages: string[] = [];
  for (const relativePath of packagePaths) {
    const sourceSkillPath = resolve(sourceRoot, relativePath);
    const targetSkillPath = resolve(targetRoot, relativePath);
    if (samePath(sourceSkillPath, targetSkillPath)) {
      preservedSkillPackages.push(relativePath);
      continue;
    }
    const existed = await pathExists(targetSkillPath);
    await mkdir(dirname(dirname(targetSkillPath)), { recursive: true });
    await cp(dirname(sourceSkillPath), dirname(targetSkillPath), {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
    if (!(await pathExists(targetSkillPath))) {
      throw new Error(`FAILED_TO_SYNC_PUBLIC_AGENT_SKILL_PACKAGE: ${relativePath}`);
    }
    (existed ? preservedSkillPackages : copiedSkillPackages).push(relativePath);
  }

  return {
    sourceManifestPath,
    docsManifestPath,
    projectionManifestPath,
    docsManifestChanged,
    projectionManifestChanged,
    copiedSkillPackages,
    preservedSkillPackages,
  };
}

/**
 * If `.codeflowmu/agent-skills.manifest.json` is missing, copy from
 * `docs/skills/agent-skills.manifest.json` (copy-if-missing only; never overwrites).
 */
export async function plantAgentSkillsManifestIfMissing(
  projectRoot: string,
  opts: PlantAgentSkillsManifestOptions = {},
): Promise<PlantAgentSkillsManifestResult> {
  const path = agentSkillsManifestProjectionPath(projectRoot);
  const sourcePath = agentSkillsManifestSourcePath(opts.sourceRoot ?? projectRoot);
  try {
    await access(path);
    return { planted: false, path, sourcePath, sourceMissing: false };
  } catch {
    try {
      await access(sourcePath);
    } catch {
      return { planted: false, path, sourcePath, sourceMissing: true };
    }
    await mkdir(dirname(path), { recursive: true });
    await copyFile(sourcePath, path);
    return { planted: true, path, sourcePath, sourceMissing: false };
  }
}
