import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";

export type TeamConfigRootType =
  | "open_install_root"
  | "codeflowmu_install_root"
  | "bootstrap_team_root"
  | "explicit_team_config_root"
  | "fallback_project_root";

export interface TeamConfigRootResolution {
  root: string;
  type: TeamConfigRootType;
}

export interface TeamMemberConfig {
  agent_id: string;
  role: string;
  display?: string;
  layer: "leader" | "worker" | "governance" | "admin";
  skills: string[];
  model?: {
    id: string;
    params?: { id: string; value: string | number | boolean }[];
  };
  [key: string]: unknown;
}

export interface TeamConfig {
  team_name?: string;
  panel_port?: number;
  runtime_instance?: {
    role?: string;
    isolation?: "project" | "user";
    gateway?: boolean;
  };
  members: TeamMemberConfig[];
  [key: string]: unknown;
}

export interface CursorModelCatalog {
  ok: boolean;
  source: "cursor" | "fallback-no-key" | "cursor-error";
  models: string[];
  error?: string;
}

export interface EffectiveModelResolution {
  configured_model_id: string;
  effective_model_id: string;
  source: "explicit" | "cursor_default_model" | "cursor_auto";
}

export function resolveTeamConfigRoot(input: {
  explicitRoot?: string | null;
  explicitType?: TeamConfigRootType;
  openEditionHostRoot?: string | null;
  codeflowmuHostRoot?: string | null;
  bootstrapRoot?: string | null;
  fallbackRoot?: string | null;
}): TeamConfigRootResolution {
  const candidates: Array<[string | null | undefined, TeamConfigRootType]> = [
    [input.explicitRoot, input.explicitType ?? "explicit_team_config_root"],
    [input.openEditionHostRoot, "open_install_root"],
    [input.codeflowmuHostRoot, "codeflowmu_install_root"],
    [input.bootstrapRoot, "bootstrap_team_root"],
    [input.fallbackRoot, "fallback_project_root"],
  ];
  for (const [candidate, type] of candidates) {
    const value = candidate?.trim();
    if (value) return { root: pathResolve(value), type };
  }
  return { root: pathResolve(process.cwd()), type: "fallback_project_root" };
}

export function teamConfigPath(root: string): string {
  return join(pathResolve(root), "codeflowmu.team.json");
}

export function readTeamConfig(root: string): TeamConfig {
  const path = teamConfigPath(root);
  if (!existsSync(path)) {
    throw Object.assign(new Error("codeflowmu.team.json not found"), {
      code: "TEAM_NOT_FOUND",
      path,
    });
  }
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as TeamConfig;
  if (!Array.isArray(parsed.members)) {
    throw Object.assign(new Error("codeflowmu.team.json members must be an array"), {
      code: "TEAM_INVALID",
      path,
    });
  }
  return parsed;
}

export function writeTeamConfigAtomic(root: string, team: TeamConfig): void {
  const path = teamConfigPath(root);
  const temp = join(
    dirname(path),
    `.${Date.now()}-${process.pid}-codeflowmu.team.json.tmp`,
  );
  try {
    writeFileSync(temp, `${JSON.stringify(team, null, 2)}\n`, "utf-8");
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function readDotEnvValue(root: string, key: string): string {
  const path = join(pathResolve(root), ".env");
  if (!existsSync(path)) return "";
  for (const rawLine of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1 || line.slice(0, eq).trim() !== key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return "";
}

export function readCursorDefaultModel(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env["CURSOR_DEFAULT_MODEL"]?.trim() ||
    readDotEnvValue(root, "CURSOR_DEFAULT_MODEL").trim()
  );
}

export function resolveEffectiveModel(
  configuredModelId: string,
  cursorDefaultModel = "",
): EffectiveModelResolution {
  const configured = configuredModelId.trim();
  if (!["auto", "default"].includes(configured.toLowerCase())) {
    return {
      configured_model_id: configured,
      effective_model_id: configured,
      source: "explicit",
    };
  }
  const fallback = cursorDefaultModel.trim();
  if (fallback && !["auto", "default"].includes(fallback.toLowerCase())) {
    return {
      configured_model_id: configured || "auto",
      effective_model_id: fallback,
      source: "cursor_default_model",
    };
  }
  return {
    configured_model_id: configured || "auto",
    effective_model_id: "auto",
    source: "cursor_auto",
  };
}

function redactSecret(message: string, secret: string): string {
  return secret ? message.split(secret).join("[REDACTED]") : message;
}

export async function listCursorModels(
  root: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    list?: (apiKey: string) => Promise<Array<{ id?: unknown; aliases?: unknown }>>;
  } = {},
): Promise<CursorModelCatalog> {
  const env = opts.env ?? process.env;
  const apiKey =
    env["CURSOR_API_KEY"]?.trim() ||
    readDotEnvValue(root, "CURSOR_API_KEY").trim();
  if (!apiKey) {
    return {
      ok: false,
      source: "fallback-no-key",
      models: ["auto"],
      error: "Cursor API Key is not configured; only auto can be validated.",
    };
  }
  try {
    const list =
      opts.list ??
      (async (key: string) => {
        const { Cursor } = await import("@cursor/sdk");
        return Cursor.models.list({ apiKey: key }) as Promise<
          Array<{ id?: unknown; aliases?: unknown }>
        >;
      });
    const items = await list(apiKey);
    const models = new Set<string>(["auto"]);
    for (const model of items) {
      const id = String(model?.id ?? "").trim();
      if (id) models.add(id);
      if (Array.isArray(model?.aliases)) {
        for (const alias of model.aliases) {
          const value = String(alias ?? "").trim();
          if (value) models.add(value);
        }
      }
    }
    return { ok: true, source: "cursor", models: [...models] };
  } catch (error) {
    const safe = redactSecret(
      error instanceof Error ? error.message : String(error),
      apiKey,
    );
    return {
      ok: false,
      source: "cursor-error",
      models: ["auto"],
      error: safe,
    };
  }
}

export function validateCursorModelId(
  modelId: string,
  catalog: CursorModelCatalog,
): { ok: true } | { ok: false; code: string; message: string } {
  const normalized = modelId.trim();
  if (!normalized) {
    return { ok: false, code: "MISSING_MODEL_ID", message: "model_id is required" };
  }
  if (normalized.toLowerCase() === "auto") return { ok: true };
  if (!catalog.ok) {
    return {
      ok: false,
      code: "MODEL_CATALOG_UNAVAILABLE",
      message: catalog.error ?? "Cursor model catalog is unavailable",
    };
  }
  if (!catalog.models.includes(normalized)) {
    return {
      ok: false,
      code: "MODEL_NOT_AVAILABLE",
      message: `Model ${normalized} is not available to the current Cursor account`,
    };
  }
  return { ok: true };
}
