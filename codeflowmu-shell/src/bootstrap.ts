/**
 * Bootstrap helpers — fixture planting + shell-aware default seeding.
 *
 * The shell is **not** an admin tool — it does not implicitly create
 * agents or skills. But for v0.1 internal RC ADMIN test runs, the
 * shell DOES auto-plant a single bootstrap kit (1 fcop skill + 1 PM
 * agent + 1 DEV agent + 1 OPS agent + 1 QA agent) on first launch IF and only
 * if `<persistDir>/agents.json` is absent. Subsequent launches re-use
 * what's on disk (the runtime's `RuntimeBootstrap` handles rehydration).
 *
 * This is consistent with the Phase E demo (`examples/hello-world.ts`
 * in `@codeflowmu/runtime`) and gives ADMIN a working stage from a
 * single-EXE double-click.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Runtime } from "@codeflowmu/runtime";

// ── Team config loader ────────────────────────────────────────────────────

interface TeamMemberConfig {
  agent_id: string;
  role: string;
  display?: string;
  layer: "leader" | "worker" | "governance" | "admin";
  skills: string[];
  model?: { id: string; params?: { id: string; value: string | number | boolean }[] };
}

interface TeamConfig {
  team_name?: string;
  /** Port for the web panel. Default 18766. Each project should use a unique port. */
  panel_port?: number;
  members: TeamMemberConfig[];
}

/** Read panel_port + team_name from codeflowmu.team.json without full bootstrap. */
export async function readTeamMeta(projectRoot: string): Promise<{ panelPort: number; teamName?: string } | null> {
  const cfg = await loadTeamConfig(projectRoot);
  if (!cfg) return null;
  return {
    panelPort: cfg.panel_port ?? 18766,
    teamName: cfg.team_name,
  };
}

/**
 * Load `codeflowmu.team.json` from the given project root.
 * Returns null if the file does not exist (fall back to DEFAULT_AGENT_KIT).
 */
async function loadTeamConfig(projectRoot: string): Promise<TeamConfig | null> {
  const configPath = join(projectRoot, "codeflowmu.team.json");
  try {
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw) as TeamConfig;
  } catch {
    return null;
  }
}

interface BootstrapKitOptions {
  /** Same `dataDir` the runtime is using; we plant `<dataDir>/skills/`. */
  dataDir: string;
  runtime: Runtime;
  /** Optional active project root used by agents as their working directory. */
  projectRoot?: string;
  /** Optional root that owns codeflowmu.team.json; open edition keeps it at install root. */
  teamConfigRoot?: string;
}

/**
 * Ensure all the directories the runtime expects exist BEFORE
 * `Runtime.create` runs. chokidar's watcher does not auto-create
 * its target dir — if `inbox/` is missing the dispatcher silently
 * watches a non-existent path and `Copy-Item` from PowerShell will
 * fail with "directory not found".
 *
 * Idempotent: every `mkdir` uses `recursive: true`.
 */
export async function ensureDataDirs(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(dataDir, "inbox"), { recursive: true });
  await mkdir(join(dataDir, "reviews"), { recursive: true });
  await mkdir(join(dataDir, "skills"), { recursive: true });
  await mkdir(join(dataDir, "sessions"), { recursive: true });
  await mkdir(join(dataDir, "transcripts"), { recursive: true });
}

/**
 * Plant 2 fixture skills (`fcop`, `git`) into  
 * `<dataDir>/skills/` IF the directory is empty. Idempotent —
 * second call is a no-op. Skills MUST be present BEFORE
 * `Runtime.create` runs, but for v0.1 we plant after creation
 * and ask the operator to re-launch (or — simpler — do this in
 * `main.ts` BEFORE `Runtime.create`). See `main.ts` for the
 * actual call ordering.
 */
export async function plantSkillFixturesIfMissing(
  skillsDir: string,
): Promise<{ planted: number }> {
  await mkdir(skillsDir, { recursive: true });
  const fcopPath = join(skillsDir, "fcop.json");
  // Treat existence of fcop.json as the canary — it's the only kernel
  // skill and v0.1 cannot start without it.
  try {
    await stat(fcopPath);
    return { planted: 0 };
  } catch {
    // Fall through to plant.
  }

  const skills = [
    {
      skill_id: "fcop",
      version: "1.0.0",
      provided_by: {
        type: "mcp_server",
        transport: "stdio",
        command: "node fcop-mcp-stub",
      },
      tools: [{ name: "drop_task" }],
      available_to_roles: ["DEV", "PM", "OPS", "QA"],
      required_kernel: ["fcop@1.0"],
    },
    {
      skill_id: "git",
      version: "0.5.0",
      provided_by: {
        type: "mcp_server",
        transport: "stdio",
        command: "node git-mcp-stub",
      },
      tools: [{ name: "git_status" }, { name: "git_diff" }],
      available_to_roles: ["DEV"],
      required_kernel: ["fcop@>=1.0"],
    },
  ];
  for (const skill of skills) {
    await writeFile(
      join(skillsDir, `${skill.skill_id}.json`),
      JSON.stringify(skill, null, 2),
      "utf-8",
    );
  }
  return { planted: skills.length };
}

/**
 * Built-in fallback kit — used when no codeflowmu.team.json is found.
 * Default team: PM (leader) + DEV + OPS + QA + EVAL.
 */
const DEFAULT_AGENT_KIT = [
  { agent_id: "PM-01",  role: "PM",  layer: "leader" as const, skills: ["fcop"] },
  { agent_id: "DEV-01", role: "DEV", layer: "worker" as const, skills: ["fcop", "git"] },
  { agent_id: "OPS-01", role: "OPS", layer: "worker" as const, skills: ["fcop"] },
  { agent_id: "QA-01",  role: "QA",  layer: "worker" as const, skills: ["fcop"] },
  { agent_id: "EVAL-01", role: "EVAL", layer: "observer" as const, skills: ["fcop"] },
];

/** Internal review gate — registered at runtime but not a dev-team roster seat. */
const GOVERNANCE_AGENT_KIT = [
  {
    agent_id: "REVIEW-01",
    role: "REVIEW",
    layer: "governance" as const,
    skills: ["fcop"],
  },
];

function isTeamConfigMember(role: string): boolean {
  return role.trim() !== "REVIEW";
}

/**
 * Register team agents from `codeflowmu.team.json` (if present) or fall back to
 * DEFAULT_AGENT_KIT.  Idempotent: only registers agents that are not yet in
 * agents.json — existing records are never overwritten.
 *
 * Returns the count of newly registered agents and the team name (if configured).
 */
export async function registerDefaultAgentKitIfEmpty(
  opts: BootstrapKitOptions,
): Promise<{ registered: number; teamName?: string; source: "config" | "default" }> {
  const { runtime, projectRoot, teamConfigRoot } = opts;

  const configRoot = teamConfigRoot ?? projectRoot;
  const teamConfig = configRoot ? await loadTeamConfig(configRoot) : null;

  const kit = teamConfig
    ? teamConfig.members
        .filter((m) => isTeamConfigMember(m.role))
        .map((m) => ({
          agent_id: m.agent_id,
          role: m.role,
          layer: m.layer,
          skills: m.skills,
          model: m.model,
        }))
    : DEFAULT_AGENT_KIT;

  const existing = await runtime.registry.list();
  const existingIds = new Set(existing.map((a) => a.protocol.agent_id));

  let registered = 0;
  const governanceKit = process.env["CODEFLOW_OPEN_EDITION"] === "1" ? [] : GOVERNANCE_AGENT_KIT;
  for (const spec of [...kit, ...governanceKit]) {
    if (existingIds.has(spec.agent_id)) {
      if (projectRoot) {
        await runtime.registry.updateWorkspace(spec.agent_id, projectRoot);
      }
      continue;
    }
    await runtime.registry.register({
      ...spec,
      node: "local" as const,
      runtime: "local" as const,
      status: "idle" as const,
      workspace: projectRoot ?? process.cwd(),
    });
    registered++;
  }

  return {
    registered,
    teamName: teamConfig?.team_name,
    source: teamConfig ? "config" : "default",
  };
}

function isOpaqueModelId(modelId: string | undefined): boolean {
  const t = modelId?.trim();
  return !t || t === "default" || t === "auto";
}

/**
 * When agents.json was created under Cursor routing, model ids may still be
 * `default`. Sync explicit `gemini-*` ids from codeflowmu.team.json without
 * overwriting agents that already have a concrete model.
 */
export async function syncTeamModelsFromConfig(
  opts: BootstrapKitOptions,
): Promise<{ updated: number }> {
  const { runtime, projectRoot, teamConfigRoot } = opts;
  const configRoot = teamConfigRoot ?? projectRoot;
  if (!configRoot) return { updated: 0 };

  const teamConfig = await loadTeamConfig(configRoot);
  if (!teamConfig) return { updated: 0 };

  let updated = 0;
  for (const member of teamConfig.members) {
    const teamModel = member.model?.id?.trim();
    if (!teamModel || !teamModel.startsWith("gemini-")) continue;

    try {
      const rec = await runtime.registry.get(member.agent_id);
      if (!rec) continue;
      const current = rec.protocol.model?.id?.trim();
      if (!isOpaqueModelId(current)) continue;
      await runtime.registry.updateModel(member.agent_id, teamModel);
      updated++;
    } catch {
      // skip missing or invalid agents
    }
  }

  return { updated };
}
