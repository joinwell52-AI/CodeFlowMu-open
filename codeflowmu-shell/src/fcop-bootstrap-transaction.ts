import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  waitForProjectWriteLeasesToDrain,
} from "../../packages/codeflowmu-runtime/src/project/ProjectWriteBarrier.ts";
import { scheduleLedgerRebuild } from "../../packages/codeflowmu-runtime/src/ledger/scheduleLedgerRebuild.ts";
import { buildPmSkillManifestFile } from "../../packages/codeflowmu-runtime/src/pm/PmSkillManifest.ts";
import {
  collectAgentSkillPackagePaths,
  mergeAgentSkillsManifest,
} from "../../packages/codeflowmu-runtime/src/skills/AgentPlaybookManifest.ts";

export type FcopBootstrapFile = {
  source_rel: string;
  target_rel: string;
  sha256: string;
  category: "rules" | "protocol" | "commentary" | "role_template" | "adopted" | "host_contract";
  source_origin?: "working_tree" | "bundled_shell_resource" | "default_project_template" | "git_head";
  preserved_local?: true;
  source_sha256?: string;
};

export type FcopBootstrapManifest = {
  schema_version: "1.0";
  source_release_sha: string;
  source_version: string;
  shell_compatibility: string;
  runtime_compatibility: string;
  fcop_package_compatibility: string;
  rules_version: string;
  protocol_version: string;
  commentary_version: string;
  role_template_version: string;
  adopted_version: string;
  files: FcopBootstrapFile[];
  manifest_digest: string;
};

export type FcopInitPlanMode = "new" | "takeover" | "repair" | "upgrade";
export type FcopInitPlanEntry = {
  target_rel: string;
  source_rel?: string;
  expected_sha256?: string;
  actual_sha256?: string | null;
  reason: string;
};

export type FcopInitPlan = {
  schema_version: "1.0";
  mode: FcopInitPlanMode;
  source_root: string;
  target_root: string;
  initialization_profile: {
    mode: "project" | "solo";
    team: string | null;
    role_code: string | null;
    workspace_mode: "root" | "multi";
  };
  manifest: FcopBootstrapManifest;
  generated_files: Array<{
    target_rel: string;
    content: string;
    sha256: string;
  }>;
  required_directories: string[];
  create: FcopInitPlanEntry[];
  update: FcopInitPlanEntry[];
  preserve: FcopInitPlanEntry[];
  conflict: FcopInitPlanEntry[];
  source_versions: {
    mother_rules: string;
    mother_protocol: string;
    installed_fcop: string | null;
    installed_fcop_mcp: string | null;
    bundled_rules: string | null;
    bundled_protocol: string | null;
    target_rules: string | null;
    target_protocol: string | null;
  };
  package_requirements: string[];
  package_upgrade_actions: string[];
  preserve_snapshot: Array<{
    target_rel: string;
    sha256: string;
  }>;
  identity_contract: {
    preserve_runtime_instance: true;
    preserve_gateway_secret: true;
    preserve_writer_lock: true;
    preserve_registry_data_root: true;
  };
  rollback_plan: string[];
  plan_digest: string;
};

export type FcopInitTransactionResult = {
  transaction_id: string;
  plan_digest: string;
  manifest_digest: string;
  verification_digest: string;
  changed: string[];
  preserved: string[];
  rolled_back: string[];
  journal_path: string;
};

const IDENTITY_DENYLIST = [
  ".codeflowmu/instance.json",
  ".codeflowmu/mobile-gateway.json",
  ".codeflowmu/runtime.lock",
  ".codeflowmu/projects-registry.json",
  "mobile-gateway.json",
  "runtime.lock",
] as const;

// These prefixes remain explicit "initializer must not write" policy entries.
// Their live contents are deliberately not hashed: tasks, reports, logs and
// ledger projections are written by the running project and are coordinated by
// ProjectWriteBarrier instead of requiring the whole tree to stay motionless.
const LEDGER_PRESERVE_PREFIXES = [
  "fcop/_lifecycle/",
  "fcop/tasks/",
  "fcop/reports/",
  "fcop/issues/",
  "fcop/reviews/",
  "fcop/ledger/",
  "fcop/approvals/",
  "fcop/logs/",
  "workspace/",
  ".codeflowmu/operation-approvals/records/",
] as const;

const DEV_TEAM_ROLE_TEMPLATE_FILES = [
  "fcop/shared/roles/PM.md",
  "fcop/shared/roles/PM.en.md",
  "fcop/shared/roles/DEV.md",
  "fcop/shared/roles/DEV.en.md",
  "fcop/shared/roles/QA.md",
  "fcop/shared/roles/QA.en.md",
  "fcop/shared/roles/OPS.md",
  "fcop/shared/roles/OPS.en.md",
] as const;

function slash(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function sha256Buffer(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha(path: string): string | null {
  return existsSync(path) && statSync(path).isFile()
    ? sha256Buffer(readFileSync(path))
    : null;
}

function readGitHeadFile(root: string, rel: string): Buffer | null {
  try {
    return execFileSync("git", ["-C", root, "show", `HEAD:${slash(rel)}`], {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function readBootstrapSource(
  sourceRoot: string,
  sourceRel: string,
): { content: Buffer; origin: NonNullable<FcopBootstrapFile["source_origin"]> } | null {
  const rel = slash(sourceRel);
  const workingTreePath = join(sourceRoot, rel);
  if (existsSync(workingTreePath) && statSync(workingTreePath).isFile()) {
    return { content: readFileSync(workingTreePath), origin: "working_tree" };
  }

  // Mother runtime resources live outside the mutable project FCoP tree. This
  // remains available even when sourceRoot === targetRoot and a project cleanup
  // has removed every root-level fcop/shared template from both disk and HEAD.
  const bundledShellPath = join(sourceRoot, "codeflowmu-shell", "resources", "fcop-bootstrap", rel);
  if (existsSync(bundledShellPath) && statSync(bundledShellPath).isFile()) {
    return { content: readFileSync(bundledShellPath), origin: "bundled_shell_resource" };
  }

  // Open Edition ships an immutable initialized project template because its
  // application root is not itself an FCoP project.
  const defaultTemplatePath = join(sourceRoot, "templates", "default-project", rel);
  if (existsSync(defaultTemplatePath) && statSync(defaultTemplatePath).isFile()) {
    return { content: readFileSync(defaultTemplatePath), origin: "default_project_template" };
  }

  // The mother repository may also be the project being initialized. Runtime
  // cleanup can therefore remove fcop/shared/** from the working tree before
  // initialization. HEAD is the immutable release baseline in that same-repo
  // case; reading it prevents target deletion from erasing the source template.
  const gitHead = readGitHeadFile(sourceRoot, rel);
  return gitHead ? { content: gitHead, origin: "git_head" } : null;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return `sha256:${sha256Buffer(JSON.stringify(stable(value)))}`;
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readVersion(path: string, fallback: string): string {
  return String(readJson(path)?.["version"] ?? fallback);
}

function extractVersion(path: string, pattern: RegExp, fallback: string): string {
  if (!existsSync(path)) return fallback;
  return extractVersionText(readFileSync(path, "utf8"), pattern, fallback);
}

function extractVersionText(content: string, pattern: RegExp, fallback: string): string {
  return content.match(pattern)?.[1] ?? fallback;
}

function extractRulesVersion(path: string, fallback: string): string {
  return extractVersion(
    path,
    /(?:fcop_rules_version\s*:\s*|Rules version:\s*`?)([0-9]+\.[0-9]+\.[0-9]+)/i,
    fallback,
  );
}

function extractProtocolVersion(path: string, fallback: string): string {
  return extractVersion(
    path,
    /(?:fcop_protocol_version\s*:\s*|Protocol commentary version:\s*`?|Rules version:\s*`?)([0-9]+\.[0-9]+\.[0-9]+)/i,
    fallback,
  );
}

function extractRulesVersionFromBootstrapSource(sourceRoot: string, fallback: string): string {
  const source = readBootstrapSource(sourceRoot, ".cursor/rules/fcop-rules.mdc");
  return source
    ? extractVersionText(
        source.content.toString("utf8"),
        /(?:fcop_rules_version\s*:\s*|Rules version:\s*`?)([0-9]+\.[0-9]+\.[0-9]+)/i,
        fallback,
      )
    : fallback;
}

function extractProtocolVersionFromBootstrapSource(sourceRoot: string, fallback: string): string {
  const source = readBootstrapSource(sourceRoot, ".cursor/rules/fcop-protocol.mdc");
  return source
    ? extractVersionText(
        source.content.toString("utf8"),
        /(?:fcop_protocol_version\s*:\s*|Protocol commentary version:\s*`?|Rules version:\s*`?)([0-9]+\.[0-9]+\.[0-9]+)/i,
        fallback,
      )
    : fallback;
}

function listFiles(root: string, rel = ""): string[] {
  const dir = join(root, rel);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = slash(join(rel, entry.name));
    if (entry.isDirectory()) out.push(...listFiles(root, child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

function preservedFileSnapshot(
  targetRoot: string,
  preserveEntries: FcopInitPlanEntry[],
): Array<{ target_rel: string; sha256: string }> {
  const rows: Array<{ target_rel: string; sha256: string }> = [];
  const candidates = new Set<string>();
  for (const entry of preserveEntries) {
    const rel = slash(entry.target_rel);
    const target = join(targetRoot, rel);
    if (existsSync(target) && statSync(target).isFile()) candidates.add(rel);
  }
  for (const rel of IDENTITY_DENYLIST) {
    const target = join(targetRoot, rel);
    if (existsSync(target) && statSync(target).isFile()) candidates.add(rel);
  }
  for (const rel of [...candidates].sort()) {
    const sha = fileSha(join(targetRoot, rel));
    if (sha) rows.push({ target_rel: slash(rel), sha256: sha });
  }
  return rows;
}

function assertExecutionPlanStillFresh(plan: FcopInitPlan): void {
  for (const entry of [...plan.create, ...plan.update]) {
    const actual = fileSha(join(plan.target_root, entry.target_rel));
    if (actual !== (entry.actual_sha256 ?? null)) {
      throw new Error(
        `FCOP_INIT_PLAN_STALE: ${entry.target_rel} changed after approval`,
      );
    }
  }
}

function manifestFileCandidates(sourceRoot: string): Array<Omit<FcopBootstrapFile, "sha256">> {
  const candidates: Array<Omit<FcopBootstrapFile, "sha256">> = [
    { source_rel: ".cursor/rules/fcop-rules.mdc", target_rel: ".cursor/rules/fcop-rules.mdc", category: "rules" },
    { source_rel: ".cursor/rules/fcop-protocol.mdc", target_rel: ".cursor/rules/fcop-protocol.mdc", category: "protocol" },
    { source_rel: "AGENTS.md", target_rel: "AGENTS.md", category: "host_contract" },
    { source_rel: "CLAUDE.md", target_rel: "CLAUDE.md", category: "host_contract" },
    { source_rel: "fcop/LETTER-TO-ADMIN.md", target_rel: "fcop/LETTER-TO-ADMIN.md", category: "host_contract" },
    { source_rel: "fcop/shared/TEAM-README.md", target_rel: "fcop/shared/TEAM-README.md", category: "role_template" },
    { source_rel: "fcop/shared/TEAM-README.en.md", target_rel: "fcop/shared/TEAM-README.en.md", category: "role_template" },
    { source_rel: "fcop/shared/TEAM-ROLES.md", target_rel: "fcop/shared/TEAM-ROLES.md", category: "role_template" },
    { source_rel: "fcop/shared/TEAM-ROLES.en.md", target_rel: "fcop/shared/TEAM-ROLES.en.md", category: "role_template" },
    { source_rel: "fcop/shared/TEAM-OPERATING-RULES.md", target_rel: "fcop/shared/TEAM-OPERATING-RULES.md", category: "role_template" },
    { source_rel: "fcop/shared/TEAM-OPERATING-RULES.en.md", target_rel: "fcop/shared/TEAM-OPERATING-RULES.en.md", category: "role_template" },
    { source_rel: "workspace/README.md", target_rel: "workspace/README.md", category: "host_contract" },
  ];
  for (const rel of DEV_TEAM_ROLE_TEMPLATE_FILES) {
    candidates.push({ source_rel: rel, target_rel: rel, category: "role_template" });
  }
  for (const rel of listFiles(sourceRoot, "fcop/shared/roles")) {
    candidates.push({ source_rel: rel, target_rel: rel, category: "role_template" });
  }
  for (const rel of listFiles(sourceRoot, "adoptedSource")) {
    // Server examples are allowed; runtime secrets and local identity are not.
    const lower = rel.toLowerCase();
    if (/secret|instance\.json|runtime\.lock|mobile-gateway\.json/.test(lower)) continue;
    candidates.push({
      source_rel: rel,
      target_rel: slash(join("fcop", "adopted", relative("adoptedSource", rel))),
      category: "adopted",
    });
    candidates.push({
      source_rel: rel,
      target_rel: rel,
      category: "adopted",
    });
  }
  for (const prefix of ["docs/skills", "docs/open", "skills"]) {
    for (const rel of listFiles(sourceRoot, prefix)) {
      candidates.push({ source_rel: rel, target_rel: rel, category: "adopted" });
    }
  }
  for (const rel of [".codeflowmu/edition-ui.json"]) {
    if (existsSync(join(sourceRoot, rel))) {
      candidates.push({ source_rel: rel, target_rel: rel, category: "adopted" });
    }
  }
  return candidates;
}

function buildManagedSkillsGeneratedFiles(
  sourceRoot: string,
  targetRoot: string,
): FcopInitPlan["generated_files"] {
  const pmContent = `${JSON.stringify(buildPmSkillManifestFile(), null, 2)}\n`;
  const source = readBootstrapSource(sourceRoot, "docs/skills/agent-skills.manifest.json");
  if (!source) {
    throw new Error("FCOP_INIT_AGENT_SKILLS_SOURCE_MISSING: docs/skills/agent-skills.manifest.json");
  }
  let publicManifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(source.content.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("manifest must be an object");
    publicManifest = parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`FCOP_INIT_AGENT_SKILLS_SOURCE_INVALID: ${error instanceof Error ? error.message : String(error)}`);
  }
  const packages = collectAgentSkillPackagePaths(publicManifest);
  if (packages.length === 0) {
    throw new Error("FCOP_INIT_AGENT_SKILLS_SOURCE_INVALID: no skill_package entries");
  }
  for (const packageRel of packages) {
    const normalized = slash(packageRel);
    if (isAbsolute(packageRel) || normalized.includes("../") || !/^skills\/[^/]+\/SKILL\.md$/.test(normalized)) {
      throw new Error(`FCOP_INIT_AGENT_SKILL_PACKAGE_INVALID: ${packageRel}`);
    }
    const packageSource = readBootstrapSource(sourceRoot, normalized);
    if (!packageSource) throw new Error(`FCOP_INIT_AGENT_SKILL_PACKAGE_MISSING: ${normalized}`);
  }
  const existingProjection = readJson(join(targetRoot, ".codeflowmu", "agent-skills.manifest.json"));
  const projectedManifest = existingProjection
    ? mergeAgentSkillsManifest(existingProjection, publicManifest)
    : publicManifest;
  const agentContent = `${JSON.stringify(projectedManifest, null, 2)}\n`;
  return [
    {
      target_rel: ".codeflowmu/pm-skills.manifest.json",
      content: pmContent,
      sha256: sha256Buffer(pmContent),
    },
    {
      target_rel: ".codeflowmu/agent-skills.manifest.json",
      content: agentContent,
      sha256: sha256Buffer(agentContent),
    },
  ];
}

function assertSafeRelative(relPath: string): void {
  const rel = slash(relPath);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith("../")) {
    throw new Error(`unsafe bootstrap relative path: ${relPath}`);
  }
  const lower = rel.toLowerCase();
  if (IDENTITY_DENYLIST.includes(lower as (typeof IDENTITY_DENYLIST)[number]) || /(?:^|\/)secret(?:\.|\/|$)/.test(lower)) {
    throw new Error(`runtime identity material is forbidden in bootstrap manifest: ${rel}`);
  }
}

function gitHead(root: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
  } catch {
    return "UNKNOWN";
  }
}

export function createFcopBootstrapManifest(input: {
  sourceRoot: string;
  sourceReleaseSha?: string;
  fcopPackageCompatibility?: string;
}): FcopBootstrapManifest {
  const sourceRoot = resolve(input.sourceRoot);
  const seenTargets = new Set<string>();
  const files: FcopBootstrapFile[] = [];
  for (const entry of manifestFileCandidates(sourceRoot)) {
      if (seenTargets.has(entry.target_rel)) continue;
      seenTargets.add(entry.target_rel);
      assertSafeRelative(entry.source_rel);
      assertSafeRelative(entry.target_rel);
      const source = readBootstrapSource(sourceRoot, entry.source_rel);
      if (!source) continue;
      files.push({
        ...entry,
        sha256: sha256Buffer(source.content),
        source_origin: source.origin,
      });
  }
  files.sort((left, right) => left.target_rel.localeCompare(right.target_rel));
  const sourceVersion = readVersion(join(sourceRoot, "package.json"), "unknown");
  const shellVersion = readVersion(join(sourceRoot, "codeflowmu-shell", "package.json"), sourceVersion);
  const runtimeVersion = readVersion(join(sourceRoot, "packages", "codeflowmu-runtime", "package.json"), sourceVersion);
  const rulesVersion = extractRulesVersionFromBootstrapSource(sourceRoot, "unknown");
  const protocolVersion = extractProtocolVersionFromBootstrapSource(sourceRoot, "unknown");
  const base = {
    schema_version: "1.0" as const,
    source_release_sha: input.sourceReleaseSha ?? gitHead(sourceRoot),
    source_version: sourceVersion,
    shell_compatibility: shellVersion,
    runtime_compatibility: runtimeVersion,
    fcop_package_compatibility: input.fcopPackageCompatibility ?? ">=3.2.5 <4",
    rules_version: rulesVersion,
    protocol_version: protocolVersion,
    commentary_version: protocolVersion,
    role_template_version: sourceVersion,
    adopted_version: sourceVersion,
    files,
  };
  return { ...base, manifest_digest: digest(base) };
}

function parseSemver(value: string): number[] | null {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersion(left: string, right: string): number | null {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return 0;
}

function targetRulesVersion(target: string): string {
  return extractRulesVersion(target, "unknown");
}

export function buildFcopInitPlan(input: {
  sourceRoot: string;
  targetRoot: string;
  sourceReleaseSha?: string;
  fcopPackageCompatibility?: string;
  initializationProfile?: {
    mode: "project" | "solo";
    team?: string | null;
    roleCode?: string | null;
    workspaceMode?: "root" | "multi";
  };
  installedFcopVersion?: string | null;
  installedFcopMcpVersion?: string | null;
  bundledRulesVersion?: string | null;
  bundledProtocolVersion?: string | null;
}): FcopInitPlan {
  const sourceRoot = resolve(input.sourceRoot);
  const targetRoot = resolve(input.targetRoot);
  const manifest = createFcopBootstrapManifest(input);
  const existingManifest = readJson(join(targetRoot, "fcop", "bootstrap-manifest.json")) as FcopBootstrapManifest | null;
  const initialized = existsSync(join(targetRoot, "fcop", "fcop.json"));
  const mode: FcopInitPlanMode = !initialized
    ? "new"
    : !existingManifest
      ? "takeover"
      : existingManifest.source_release_sha !== manifest.source_release_sha
        ? "upgrade"
        : "repair";
  const create: FcopInitPlanEntry[] = [];
  const update: FcopInitPlanEntry[] = [];
  const preserve: FcopInitPlanEntry[] = [];
  const conflict: FcopInitPlanEntry[] = [];
  const packageUpgradeActions: string[] = [];
  const profile = {
    mode: input.initializationProfile?.mode ?? "project",
    team: input.initializationProfile?.mode === "solo"
      ? null
      : input.initializationProfile?.team ?? "dev-team",
    role_code: input.initializationProfile?.mode === "solo"
      ? input.initializationProfile.roleCode ?? "ME"
      : null,
    workspace_mode: input.initializationProfile?.workspaceMode ?? "root",
  } as const;

  for (const file of manifest.files) {
    const target = join(targetRoot, file.target_rel);
    const actual = fileSha(target);
    const entry = {
      target_rel: file.target_rel,
      source_rel: file.source_rel,
      expected_sha256: file.sha256,
      actual_sha256: actual,
      reason: "",
    };
    if (actual == null) {
      create.push({ ...entry, reason: "bootstrap file is missing" });
    } else if (actual === file.sha256) {
      preserve.push({ ...entry, reason: "already matches the signed bootstrap manifest" });
    } else if (existingManifest) {
      const old = existingManifest.files?.find((item) => item.target_rel === file.target_rel);
      if (old?.preserved_local === true && old.sha256 === actual) {
        preserve.push({ ...entry, reason: "locally owned bootstrap content remains preserved" });
      } else if (old && old.sha256 === actual) {
        update.push({ ...entry, reason: "known previous manifest file will be upgraded" });
      } else {
        preserve.push({ ...entry, reason: "local content differs from the managed baseline and will not be overwritten" });
      }
    } else if (file.category === "rules" || file.category === "protocol" || file.category === "commentary") {
      const currentVersion = targetRulesVersion(target);
      const requestedVersion = file.category === "rules" ? manifest.rules_version : manifest.protocol_version;
      const comparison = compareVersion(currentVersion, requestedVersion);
      if (comparison != null && comparison < 0) {
        update.push({ ...entry, reason: `known protocol upgrade ${currentVersion} -> ${requestedVersion}` });
      } else {
        preserve.push({ ...entry, reason: `existing protocol content is not older than the requested release (${currentVersion} -> ${requestedVersion})` });
      }
    } else {
      preserve.push({ ...entry, reason: "takeover preserves unmanifested local bootstrap content" });
    }
  }

  const targetRulesPath = join(targetRoot, ".cursor", "rules", "fcop-rules.mdc");
  const targetProtocolPath = join(targetRoot, ".cursor", "rules", "fcop-protocol.mdc");
  const targetRules = existsSync(targetRulesPath) ? targetRulesVersion(targetRulesPath) : null;
  const targetProtocol = existsSync(targetProtocolPath)
    ? extractProtocolVersion(targetProtocolPath, "unknown")
    : null;
  const checkedSources: Array<{ label: string; version: string | null | undefined; minimum: string }> = [
    { label: "installed fcop", version: input.installedFcopVersion, minimum: manifest.rules_version },
    { label: "installed fcop-mcp", version: input.installedFcopMcpVersion, minimum: manifest.rules_version },
    { label: "pip bundled rules", version: input.bundledRulesVersion, minimum: manifest.rules_version },
    { label: "pip bundled protocol", version: input.bundledProtocolVersion, minimum: manifest.protocol_version },
  ];
  for (const source of checkedSources) {
    if (source.version === undefined) continue;
    if (compareVersion(source.minimum, source.minimum) == null) continue;
    const comparison = source.version == null ? null : compareVersion(source.version, source.minimum);
    if (comparison == null || comparison < 0) {
      const actual = source.version ?? "missing";
      packageUpgradeActions.push(`${source.label}: ${actual} -> >=${source.minimum}`);
      conflict.push({
        target_rel: `@package/${source.label.replace(/\s+/g, "-")}`,
        reason: `${source.label} ${actual} is below or incompatible with release minimum ${source.minimum}`,
      });
    }
  }

  for (const prefix of LEDGER_PRESERVE_PREFIXES) {
    preserve.push({ target_rel: prefix, reason: "formal ledger, approval history, or workspace artifacts are immutable init preserves" });
  }
  for (const rel of IDENTITY_DENYLIST) {
    preserve.push({ target_rel: rel, reason: "Runtime/Gateway identity belongs to machine + canonical host_root, not project bootstrap" });
  }
  const configPath = join(targetRoot, "fcop", "fcop.json");
  const existingConfig = readJson(configPath);
  const requestedMode = profile.mode === "solo" ? "solo" : "preset";
  const requestedTeam = profile.mode === "solo" ? "solo" : profile.team!;
  const requestedLeader = profile.mode === "solo" ? profile.role_code! : "PM";
  const requestedRoles = profile.mode === "solo"
    ? [profile.role_code!]
    : requestedTeam === "dev-team"
      ? ["PM", "DEV", "QA", "OPS"]
      : [];
  if (profile.mode === "project" && requestedRoles.length === 0) {
    conflict.push({ target_rel: "fcop/fcop.json", reason: `unsupported team profile: ${requestedTeam}` });
  }
  const requiredRoleTemplates = [
    "fcop/shared/TEAM-ROLES.md",
    "fcop/shared/TEAM-OPERATING-RULES.md",
    ...requestedRoles.map((role) => `fcop/shared/roles/${role}.md`),
  ];
  const manifestTargets = new Set(manifest.files.map((file) => file.target_rel));
  for (const rel of requiredRoleTemplates) {
    if (!manifestTargets.has(rel)) {
      conflict.push({
        target_rel: rel,
        reason: "required Rule 4.5 bootstrap source is unavailable in the release baseline",
      });
    }
  }
  const configCompatible = !existingConfig || (
    String(existingConfig["mode"] ?? "") === requestedMode &&
    String(existingConfig["team"] ?? "") === requestedTeam &&
    String(existingConfig["leader"] ?? "") === requestedLeader
  );
  if (!configCompatible) {
    conflict.push({
      target_rel: "fcop/fcop.json",
      actual_sha256: fileSha(configPath),
      reason: "existing project identity does not match the requested initialization profile",
    });
  }
  const generatedConfig: Record<string, unknown> = existingConfig
    ? { ...existingConfig }
    : {
        mode: requestedMode,
        team: requestedTeam,
        leader: requestedLeader,
        roles: requestedRoles,
        lang: "zh",
        version: 1,
        created_at: new Date().toISOString().replace(/Z$/, ""),
      };
  generatedConfig["workspace_mode"] = profile.workspace_mode;
  generatedConfig["protocol_version"] = 3;
  const generatedConfigContent = `${JSON.stringify(generatedConfig, null, 2)}\n`;
  const generatedConfigSha = sha256Buffer(generatedConfigContent);
  const generated_files = [{
    target_rel: "fcop/fcop.json",
    content: generatedConfigContent,
    sha256: generatedConfigSha,
  }, ...buildManagedSkillsGeneratedFiles(sourceRoot, targetRoot)];
  const currentConfigSha = fileSha(configPath);
  if (configCompatible) {
    const configEntry = {
      target_rel: "fcop/fcop.json",
      expected_sha256: generatedConfigSha,
      actual_sha256: currentConfigSha,
      reason: currentConfigSha == null
        ? "create project governance configuration from the confirmed profile"
        : currentConfigSha === generatedConfigSha
          ? "project governance configuration already matches the confirmed profile"
          : "enrich compatible project governance configuration without replacing its identity",
    };
    if (currentConfigSha == null) create.push(configEntry);
    else if (currentConfigSha === generatedConfigSha) preserve.push(configEntry);
    else update.push(configEntry);
  }
  for (const generated of generated_files.filter((file) => file.target_rel !== "fcop/fcop.json")) {
    const actual = fileSha(join(targetRoot, generated.target_rel));
    const entry = {
      target_rel: generated.target_rel,
      expected_sha256: generated.sha256,
      actual_sha256: actual,
      reason: actual == null
        ? "create managed skills projection inside the approved init transaction"
        : actual === generated.sha256
          ? "managed skills projection already matches the Runtime source"
          : "repair or upgrade managed skills projection inside the approved init transaction",
    };
    if (actual == null) create.push(entry);
    else if (actual === generated.sha256) preserve.push(entry);
    else update.push(entry);
  }
  const required_directories = [
    "fcop/_lifecycle/inbox",
    "fcop/_lifecycle/active",
    "fcop/_lifecycle/review",
    "fcop/_lifecycle/done",
    "fcop/_lifecycle/archive",
    "fcop/tasks",
    "fcop/reports",
    "fcop/issues",
    "fcop/reviews",
    "fcop/ledger",
    "fcop/approvals",
    "fcop/attachments",
    "fcop/log",
    "fcop/logs",
    "fcop/logs/thinking/chat",
    "fcop/logs/thinking/task",
    "fcop/logs/usage",
    "fcop/logs/analytics",
    "fcop/logs/runtime",
    "fcop/logs/panel-api",
    "fcop/chat",
    "fcop/internal",
    "fcop/scripts",
    "workspace",
  ];
  const planBase = {
    schema_version: "1.0" as const,
    mode,
    source_root: sourceRoot,
    target_root: targetRoot,
    initialization_profile: profile,
    manifest,
    generated_files,
    required_directories,
    create,
    update,
    preserve,
    conflict,
    source_versions: {
      mother_rules: manifest.rules_version,
      mother_protocol: manifest.protocol_version,
      installed_fcop: input.installedFcopVersion ?? null,
      installed_fcop_mcp: input.installedFcopMcpVersion ?? null,
      bundled_rules: input.bundledRulesVersion ?? null,
      bundled_protocol: input.bundledProtocolVersion ?? null,
      target_rules: targetRules,
      target_protocol: targetProtocol,
    },
    package_requirements: [manifest.fcop_package_compatibility, `shell=${manifest.shell_compatibility}`, `runtime=${manifest.runtime_compatibility}`],
    package_upgrade_actions: packageUpgradeActions,
    // Execution snapshots are intentionally created only after the shared
    // project write barrier is held. A plan may wait for ADMIN approval while
    // the live runtime continues writing tasks, reports and ledger projections.
    preserve_snapshot: [] as Array<{ target_rel: string; sha256: string }>,
    identity_contract: {
      preserve_runtime_instance: true as const,
      preserve_gateway_secret: true as const,
      preserve_writer_lock: true as const,
      preserve_registry_data_root: true as const,
    },
    rollback_plan: [
      "acquire the shared project write barrier and drain active writers",
      "revalidate the approved plan and snapshot exact preserved bootstrap inputs",
      "write approved files through transaction staging",
      "postflight every manifest digest",
      "restore all snapshots and remove transaction-created files on failure",
      "release the barrier and rebuild derived ledger projections once",
    ],
  };
  return { ...planBase, plan_digest: digest(planBase) };
}

function assertWithin(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`transaction path escaped root: ${target}`);
  }
}

function writeAtomic(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export class FcopInitTransaction {
  private readonly targetRoot: string;
  private readonly sourceRoot: string;

  constructor(private readonly plan: FcopInitPlan) {
    this.targetRoot = resolve(plan.target_root);
    this.sourceRoot = resolve(plan.source_root);
  }

  async execute(
    approvedPlanDigest: string,
    postflight?: () => { ok: boolean; failures?: string[]; evidence?: unknown },
  ): Promise<FcopInitTransactionResult> {
    if (approvedPlanDigest !== this.plan.plan_digest) {
      throw new Error("FCOP_INIT_PLAN_STALE: confirmed plan digest does not match execution plan");
    }
    if (this.plan.conflict.length > 0) {
      throw new Error(`FCOP_INIT_PLAN_CONFLICT: ${this.plan.conflict.map((item) => item.target_rel).join(", ")}`);
    }
    const lockPath = join(this.targetRoot, ".codeflowmu", "fcop-init.lock");
    mkdirSync(dirname(lockPath), { recursive: true });
    let lockFd: number;
    try {
      lockFd = openSync(lockPath, "wx");
      writeFileSync(lockFd, `${process.pid}\n`, "utf8");
    } catch {
      throw new Error(`FCOP_INIT_BUSY: ${lockPath}`);
    }
    const transactionId = `fcop-init-${Date.now()}-${randomBytes(4).toString("hex")}`;
    const txRoot = join(this.targetRoot, ".codeflowmu", "fcop-init-transactions", transactionId);
    const snapshotRoot = join(txRoot, "snapshot");
    const journalPath = join(txRoot, "journal.json");
    const changed: string[] = [];
    const rolledBack: string[] = [];
    const createdDirectories = new Set<string>();
    const created = new Set(this.plan.create.map((item) => item.target_rel));
    const updates = new Set(this.plan.update.map((item) => item.target_rel));
    let executionPreserveSnapshot: Array<{ target_rel: string; sha256: string }> = [];
    mkdirSync(snapshotRoot, { recursive: true });
    const journal = (state: string, error?: string) => writeAtomic(journalPath, `${JSON.stringify({ transaction_id: transactionId, state, plan_digest: this.plan.plan_digest, changed, rolled_back: rolledBack, error, updated_at: new Date().toISOString() }, null, 2)}\n`);
    try {
      try {
        await waitForProjectWriteLeasesToDrain(this.targetRoot, { timeoutMs: 30_000 });
      } catch (error) {
        throw new Error(
          `PRESERVE_CONCURRENT_WRITE: runtime project writers did not yield to initialization; do not retry blindly (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      assertExecutionPlanStillFresh(this.plan);
      executionPreserveSnapshot = preservedFileSnapshot(this.targetRoot, this.plan.preserve);
      journal("preparing");
      for (const rel of this.plan.required_directories) {
        assertSafeRelative(rel);
        const directory = join(this.targetRoot, rel);
        assertWithin(this.targetRoot, directory);
        const parts = slash(rel).split("/");
        let cursor = this.targetRoot;
        for (const part of parts) {
          cursor = join(cursor, part);
          if (!existsSync(cursor)) createdDirectories.add(slash(relative(this.targetRoot, cursor)));
        }
        if (!existsSync(directory)) {
          mkdirSync(directory, { recursive: true });
        }
      }
      for (const file of this.plan.manifest.files) {
        if (!created.has(file.target_rel) && !updates.has(file.target_rel)) continue;
        assertSafeRelative(file.target_rel);
        const target = join(this.targetRoot, file.target_rel);
        assertWithin(this.targetRoot, target);
        if (existsSync(target)) {
          const snapshot = join(snapshotRoot, file.target_rel);
          mkdirSync(dirname(snapshot), { recursive: true });
          copyFileSync(target, snapshot);
        }
        const stage = join(txRoot, "staging", file.target_rel);
        mkdirSync(dirname(stage), { recursive: true });
        const source = readBootstrapSource(this.sourceRoot, file.source_rel);
        if (!source) throw new Error(`bootstrap source disappeared after approval: ${file.source_rel}`);
        writeFileSync(stage, source.content);
        if (fileSha(stage) !== file.sha256) throw new Error(`staging digest mismatch: ${file.target_rel}`);
        mkdirSync(dirname(target), { recursive: true });
        writeAtomic(target, readFileSync(stage));
        changed.push(file.target_rel);
        journal("applying");
      }
      for (const file of this.plan.generated_files) {
        if (!created.has(file.target_rel) && !updates.has(file.target_rel)) continue;
        assertSafeRelative(file.target_rel);
        if (sha256Buffer(file.content) !== file.sha256) {
          throw new Error(`generated staging digest mismatch: ${file.target_rel}`);
        }
        const target = join(this.targetRoot, file.target_rel);
        assertWithin(this.targetRoot, target);
        if (existsSync(target)) {
          const snapshot = join(snapshotRoot, file.target_rel);
          mkdirSync(dirname(snapshot), { recursive: true });
          copyFileSync(target, snapshot);
        }
        writeAtomic(target, file.content);
        changed.push(file.target_rel);
        journal("applying");
      }
      const preservedTargets = new Set(this.plan.preserve.map((item) => item.target_rel));
      const installedManifestBase = {
        ...this.plan.manifest,
        files: this.plan.manifest.files.map((file) => {
          const actual = fileSha(join(this.targetRoot, file.target_rel));
          if (!preservedTargets.has(file.target_rel) || !actual || actual === file.sha256) return file;
          return {
            ...file,
            sha256: actual,
            preserved_local: true as const,
            source_sha256: file.sha256,
          };
        }),
      };
      const unsignedInstalledManifest = { ...installedManifestBase } as Record<string, unknown>;
      delete unsignedInstalledManifest["manifest_digest"];
      const installedManifest: FcopBootstrapManifest = {
        ...installedManifestBase,
        manifest_digest: digest(unsignedInstalledManifest),
      };
      const manifestPath = join(this.targetRoot, "fcop", "bootstrap-manifest.json");
      const manifestSnapshot = join(snapshotRoot, "fcop", "bootstrap-manifest.json");
      if (existsSync(manifestPath)) {
        mkdirSync(dirname(manifestSnapshot), { recursive: true });
        copyFileSync(manifestPath, manifestSnapshot);
      }
      writeAtomic(manifestPath, `${JSON.stringify(installedManifest, null, 2)}\n`);
      if (!changed.includes("fcop/bootstrap-manifest.json")) changed.push("fcop/bootstrap-manifest.json");
      for (const file of installedManifest.files) {
        if (fileSha(join(this.targetRoot, file.target_rel)) !== file.sha256) {
          throw new Error(`postflight digest mismatch: ${file.target_rel}`);
        }
      }
      for (const file of this.plan.generated_files) {
        if (fileSha(join(this.targetRoot, file.target_rel)) !== file.sha256) {
          throw new Error(`generated postflight digest mismatch: ${file.target_rel}`);
        }
      }
      for (const preserved of executionPreserveSnapshot) {
        const actual = fileSha(join(this.targetRoot, preserved.target_rel));
        if (actual !== preserved.sha256) {
          throw new Error(`FCOP_INIT_PRESERVED_INPUT_CHANGED: ${preserved.target_rel}`);
        }
      }
      const approvedWriteSet = new Set([
        ...this.plan.create.map((item) => slash(item.target_rel)),
        ...this.plan.update.map((item) => slash(item.target_rel)),
        "fcop/bootstrap-manifest.json",
      ]);
      const unapprovedWrites = changed.filter((rel) => !approvedWriteSet.has(slash(rel)));
      if (unapprovedWrites.length > 0) {
        throw new Error(`FCOP_INIT_UNAPPROVED_WRITE: ${unapprovedWrites.join(", ")}`);
      }
      for (const rel of this.plan.required_directories) {
        const directory = join(this.targetRoot, rel);
        if (!existsSync(directory) || !statSync(directory).isDirectory()) {
          throw new Error(`required bootstrap directory is missing: ${rel}`);
        }
      }
      const config = readJson(join(this.targetRoot, "fcop", "fcop.json"));
      if (
        !config ||
        Number(config["protocol_version"] ?? 0) < 3 ||
        !String(config["mode"] ?? "").trim() ||
        !String(config["team"] ?? "").trim()
      ) {
        throw new Error("generated fcop/fcop.json failed schema postflight");
      }
      const extendedPostflight = postflight?.();
      if (extendedPostflight && !extendedPostflight.ok) {
        throw new Error(
          `extended bootstrap postflight failed: ${(extendedPostflight.failures ?? []).join("; ") || "unknown verification failure"}`,
        );
      }
      const verificationDigest = digest({
        manifest: installedManifest.manifest_digest,
        files: installedManifest.files.map((file) => [file.target_rel, fileSha(join(this.targetRoot, file.target_rel))]),
        generated: this.plan.generated_files.map((file) => [file.target_rel, fileSha(join(this.targetRoot, file.target_rel))]),
        preserved: executionPreserveSnapshot,
        extended_postflight: extendedPostflight?.evidence ?? null,
      });
      journal("committed");
      return {
        transaction_id: transactionId,
        plan_digest: this.plan.plan_digest,
        manifest_digest: installedManifest.manifest_digest,
        verification_digest: verificationDigest,
        changed: [...changed],
        preserved: this.plan.preserve.map((item) => item.target_rel),
        rolled_back: [],
        journal_path: journalPath,
      };
    } catch (error) {
      for (const rel of [...changed].reverse()) {
        if (rel === "fcop/bootstrap-manifest.json") continue;
        const target = join(this.targetRoot, rel);
        const snapshot = join(snapshotRoot, rel);
        if (existsSync(snapshot)) {
          mkdirSync(dirname(target), { recursive: true });
          copyFileSync(snapshot, target);
        } else if (existsSync(target)) {
          unlinkSync(target);
        }
        rolledBack.push(rel);
      }
      for (const rel of [...createdDirectories].sort((left, right) => right.split("/").length - left.split("/").length)) {
        const directory = join(this.targetRoot, rel);
        try {
          if (existsSync(directory) && readdirSync(directory).length === 0) rmSync(directory);
        } catch { /* a non-empty directory contains preserved material */ }
      }
      const manifestPath = join(this.targetRoot, "fcop", "bootstrap-manifest.json");
      const manifestSnapshot = join(snapshotRoot, "fcop", "bootstrap-manifest.json");
      if (existsSync(manifestSnapshot)) copyFileSync(manifestSnapshot, manifestPath);
      else if (existsSync(manifestPath)) unlinkSync(manifestPath);
      journal("rolled_back", error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      closeSync(lockFd!);
      try { unlinkSync(lockPath); } catch { /* visible stale lock is handled by diagnostics */ }
      scheduleLedgerRebuild(this.targetRoot);
      const staging = join(txRoot, "staging");
      if (existsSync(staging)) {
        assertWithin(txRoot, staging);
        rmSync(staging, { recursive: true, force: true });
      }
    }
  }
}

export function verifyFcopBootstrapManifest(targetRoot: string): {
  ok: boolean;
  manifest: FcopBootstrapManifest | null;
  failures: string[];
  verification_digest: string;
} {
  const root = resolve(targetRoot);
  const manifest = readJson(join(root, "fcop", "bootstrap-manifest.json")) as FcopBootstrapManifest | null;
  const failures: string[] = [];
  if (!manifest) failures.push("bootstrap manifest is missing or corrupt");
  if (manifest) {
    const unsigned = { ...manifest } as Record<string, unknown>;
    delete unsigned["manifest_digest"];
    if (digest(unsigned) !== manifest.manifest_digest) failures.push("manifest digest mismatch");
    for (const file of manifest.files ?? []) {
      try { assertSafeRelative(file.target_rel); } catch (error) { failures.push(String(error)); continue; }
      const actual = fileSha(join(root, file.target_rel));
      if (actual !== file.sha256) failures.push(`${file.target_rel}: expected ${file.sha256}, actual ${actual ?? "missing"}`);
    }
  }
  return {
    ok: failures.length === 0,
    manifest,
    failures,
    verification_digest: digest({ manifest_digest: manifest?.manifest_digest ?? null, failures }),
  };
}
