/**
 * ConfigLoader — 5-tier merge for the codeflowmu Shell.
 *
 * Layered precedence (later overrides earlier):
 *
 *   1. Built-in defaults
 *   2. `<homedir>/.codeflowmu/v2/config.json`     (per-user persistent)
 *   3. `./codeflowmu.config.json` in `process.cwd()` (per-project pinned)
 *   4. `<homedir>/.codeflowmu/v2/.env` + `./.env`  (parsed for CODEFLOW_*
 *      and CURSOR_API_KEY only — ALL other env vars ignored)
 *   5. `process.env` itself (overrides .env files of the same key)
 *   6. CLI args (`--api-key`, `--relay-url`, `--room-key`, `--data-dir`)
 *
 * Reference: TASK-20260510-002-PM-to-DEV §三 P1 §1 — "ConfigLoader" + main.ts wiring.
 *
 * Why no `dotenv` dependency: we only honor a tiny whitelist
 * (`CURSOR_API_KEY`, `CODEFLOW_*`), so a 30-line parser is cheaper
 * than dragging in another transitive at the v0.2 sprint-0 boundary.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  DEFAULT_AGENT_RECYCLE_CONFIG,
  mergeAgentRecycleConfig,
  parseEnvBool,
  type AgentRecycleConfig,
} from "./agent-recycle.ts";

/**
 * Public shape of the merged config — every consumer downstream
 * (`main.ts`, `sdk-factory.ts`, future `relay-bridge.ts`) reads
 * from here and never re-derives from `process.env` directly.
 */
export interface CodeflowConfig {
  /** Settings forwarded to `CursorSdkAdapter` constructor. */
  cursor: {
    apiKey?: string;
    /**
     * Per-call model hint. Currently `AgentSdkAdapter` does NOT thread this
     * through (model is set via `AgentCreateSpec.modelId` / `AgentSendSpec.modelId`),
     * so this field is recorded for forward compat (P3+) and surfaced in the
     * banner. Wiring is a follow-up — see REPORT-002 §决策.
     */
    defaultModel?: string;
    listScope: "local" | "cloud";
  };
  /** Settings forwarded to `RelayBridge` (created in P3 — preserved as-is for now). */
  relay: {
    url?: string;
    roomKey?: string;
    autoConnect: boolean;
  };
  /** Resolved `dataDir` (always absolute). */
  dataDir: string;
  /** Default agents to register on first launch (resolved into roles). */
  defaultAgentKit: string[];
  /**
   * Agent rotation (fresh SDK agent after N sessions). Auto mode only when idle.
   * `enabled` defaults false — set in config.json or CODEFLOW_AGENT_AUTO_RECYCLE=1.
   */
  agentRecycle: AgentRecycleConfig;
  /** Doorbell / SessionManager token guard (per inbox dispatch). */
  doorbell: {
    /** Max SDK tool rounds per session (unique call_id); `0` = no limit. Default 12. */
    maxToolRounds: number;
  };
  /** Selected backend agent provider. */
  provider: "cursor";
  /** Provenance: which sources fired (handy for the banner / REPORT). */
  sources: {
    userConfig: boolean;
    projectConfig: boolean;
    userEnvFile: boolean;
    projectEnvFile: boolean;
    processEnv: boolean;
    cliArgs: boolean;
  };
}

interface RawConfigFile {
  cursor?: {
    apiKey?: string;
    defaultModel?: string;
    listScope?: "local" | "cloud";
  };
  relay?: {
    url?: string;
    roomKey?: string;
    autoConnect?: boolean;
  };
  dataDir?: string;
  defaultAgentKit?: string[];
  agentRecycle?: Partial<AgentRecycleConfig>;
  doorbell?: { maxToolRounds?: number };
  provider?: "cursor";
}

const ENV_WHITELIST = new Set([
  "CURSOR_API_KEY",
  "CURSOR_DEFAULT_MODEL",
  "CURSOR_LIST_SCOPE",
  "CODEFLOW_PROVIDER",
  // When 0/false/off/no, web panel skips Cursor Admin usage sync (local JSONL only).
  "CODEFLOW_CURSOR_USAGE_SYNC",
  "CODEFLOW_DATA_DIR",
  "CODEFLOW_RELAY_URL",
  "CODEFLOW_ROOM_KEY",
  "CODEFLOW_RELAY_AUTOCONNECT",
  "CODEFLOW_AGENT_AUTO_RECYCLE",
  "CODEFLOW_AGENT_RECYCLE_THRESHOLD",
  "CODEFLOW_AGENT_RECYCLE_INTERVAL_MS",
  "CODEFLOW_DOORBELL_MAX_TOOL_ROUNDS",
  "PYTHON_BIN",
]);

/** Tiny `.env` parser — `KEY=value` per line, `#` comments OK. */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!ENV_WHITELIST.has(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readJsonIfExists(path: string): RawConfigFile | null {
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf-8");
    const parsed = JSON.parse(text) as RawConfigFile;
    return parsed;
  } catch (err) {
    throw new Error(
      `[ConfigLoader] failed to parse ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function readEnvFileIfExists(path: string): Record<string, string> | null {
  if (!existsSync(path)) return null;
  try {
    return parseEnvFile(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(
      `[ConfigLoader] failed to read ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function expandHomeTilde(p: string | undefined): string | undefined {
  if (!p) return p;
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return join(homedir(), p.slice(p.length === 1 ? 1 : 2));
  }
  return p;
}

function parseCliArgs(argv: string[]): {
  apiKey?: string;
  relayUrl?: string;
  roomKey?: string;
  dataDir?: string;
  hadAny: boolean;
} {
  let apiKey: string | undefined;
  let relayUrl: string | undefined;
  let roomKey: string | undefined;
  let dataDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    if (a === "--api-key" && next !== undefined) {
      apiKey = next;
      i++;
    } else if (a.startsWith("--api-key=")) {
      apiKey = a.slice("--api-key=".length);
    } else if (a === "--relay-url" && next !== undefined) {
      relayUrl = next;
      i++;
    } else if (a.startsWith("--relay-url=")) {
      relayUrl = a.slice("--relay-url=".length);
    } else if (a === "--room-key" && next !== undefined) {
      roomKey = next;
      i++;
    } else if (a.startsWith("--room-key=")) {
      roomKey = a.slice("--room-key=".length);
    } else if (a === "--data-dir" && next !== undefined) {
      dataDir = next;
      i++;
    } else if (a.startsWith("--data-dir=")) {
      dataDir = a.slice("--data-dir=".length);
    }
  }
  const hadAny =
    apiKey !== undefined ||
    relayUrl !== undefined ||
    roomKey !== undefined ||
    dataDir !== undefined;
  const out: ReturnType<typeof parseCliArgs> = { hadAny };
  if (apiKey !== undefined) out.apiKey = apiKey;
  if (relayUrl !== undefined) out.relayUrl = relayUrl;
  if (roomKey !== undefined) out.roomKey = roomKey;
  if (dataDir !== undefined) out.dataDir = dataDir;
  return out;
}

export interface LoadConfigOpts {
  /** Override `process.argv.slice(2)`. Defaults to that. */
  argv?: string[];
  /** Override `process.env`. Defaults to that. */
  env?: NodeJS.ProcessEnv;
  /** Override `process.cwd()`. Defaults to that. */
  cwd?: string;
  /** Override `homedir()`. Defaults to that. */
  home?: string;
}

/**
 * Load the effective config by merging all 6 layers. Synchronous because
 * every read is a small fs operation and `main.ts` is already async — the
 * ConfigLoader is the very first thing called, so blocking briefly is fine
 * and makes for a much simpler API (no Promise plumbing through main.ts).
 */
export function loadConfig(opts: LoadConfigOpts = {}): CodeflowConfig {
  const argv = opts.argv ?? process.argv.slice(2);
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();

  // ── tier 1: defaults ─────────────────────────────────────────────────
  const cfg: CodeflowConfig = {
    provider: "cursor",
    cursor: {
      listScope: "local",
    },
    relay: {
      autoConnect: false,
    },
    dataDir: join(home, ".codeflowmu", "v2"),
    defaultAgentKit: ["DEV-01"],
    agentRecycle: { ...DEFAULT_AGENT_RECYCLE_CONFIG },
    doorbell: { maxToolRounds: 100 },
    sources: {
      userConfig: false,
      projectConfig: false,
      userEnvFile: false,
      projectEnvFile: false,
      processEnv: false,
      cliArgs: false,
    },
  };

  // ── tier 2: ~/.codeflowmu/v2/config.json ──────────────────────────────
  const userCfgPath = join(home, ".codeflowmu", "v2", "config.json");
  const userCfg = readJsonIfExists(userCfgPath);
  if (userCfg) {
    cfg.sources.userConfig = true;
    applyRawConfig(cfg, userCfg, home);
  }

  // ── tier 3: ./codeflowmu.config.json ──────────────────────────────────
  const projectCfgPath = join(cwd, "codeflowmu.config.json");
  const projectCfg = readJsonIfExists(projectCfgPath);
  if (projectCfg) {
    cfg.sources.projectConfig = true;
    applyRawConfig(cfg, projectCfg, home);
  }

  // ── tier 4a: <homedir>/.codeflowmu/v2/.env ────────────────────────────
  const userEnvFilePath = join(home, ".codeflowmu", "v2", ".env");
  const userEnvFile = readEnvFileIfExists(userEnvFilePath);
  if (userEnvFile) {
    cfg.sources.userEnvFile = true;
    applyEnvLikeMap(cfg, userEnvFile, home);
  }

  // ── tier 4b: ./.env (project) ───────────────────────────────────────
  const projectEnvFilePath = join(cwd, ".env");
  const projectEnvFile = readEnvFileIfExists(projectEnvFilePath);
  if (projectEnvFile) {
    cfg.sources.projectEnvFile = true;
    applyEnvLikeMap(cfg, projectEnvFile, home);
  }

  // ── tier 4c: Monorepo Root .env (Upward Merging) ───────────────────
  let currentDir = cwd;
  let rootEnvFile = null;
  while (currentDir && currentDir !== home) {
    const parentDir = join(currentDir, "..");
    if (parentDir === currentDir) break;

    const hasPackageJson = existsSync(join(parentDir, "package.json"));
    const hasEnv = existsSync(join(parentDir, ".env"));
    if (hasPackageJson && hasEnv) {
      rootEnvFile = readEnvFileIfExists(join(parentDir, ".env"));
      break;
    }
    currentDir = parentDir;
  }
  if (rootEnvFile) {
    applyEnvLikeMap(cfg, rootEnvFile, home);
  }

  // ── tier 5: process.env (whitelisted) ───────────────────────────────
  const filteredEnv: Record<string, string> = {};
  for (const k of ENV_WHITELIST) {
    const v = env[k];
    if (typeof v === "string" && v.length > 0) filteredEnv[k] = v;
  }
  if (Object.keys(filteredEnv).length > 0) {
    cfg.sources.processEnv = true;
    applyEnvLikeMap(cfg, filteredEnv, home);
  }

  // ── tier 6: CLI args ────────────────────────────────────────────────
  const cli = parseCliArgs(argv);
  if (cli.hadAny) {
    cfg.sources.cliArgs = true;
    if (cli.apiKey !== undefined) cfg.cursor.apiKey = cli.apiKey;
    if (cli.relayUrl !== undefined) cfg.relay.url = cli.relayUrl;
    if (cli.roomKey !== undefined) cfg.relay.roomKey = cli.roomKey;
    if (cli.dataDir !== undefined) {
      const expanded = expandHomeTilde(cli.dataDir)!;
      cfg.dataDir = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    }
  }

  // Auto-flip relay.autoConnect to true if both URL + roomKey are set,
  // unless explicitly disabled via config.json `relay.autoConnect: false`.
  // This is an opt-out instead of opt-in because the typical flow once
  // a user has set up credentials is "yes, please connect".
  if (
    cfg.relay.url &&
    cfg.relay.roomKey &&
    !cfg.relay.autoConnect &&
    !userCfg?.relay?.hasOwnProperty("autoConnect") &&
    !projectCfg?.relay?.hasOwnProperty("autoConnect")
  ) {
    cfg.relay.autoConnect = true;
  }

  // Subsystems such as CursorUsageSyncer read CURSOR_API_KEY from process.env only.
  // After merge, mirror the resolved key into env so .env / config.json / --api-key
  // behave like PYTHON_BIN injection (see applyEnvLikeMap).
  if (cfg.cursor.apiKey && cfg.cursor.apiKey.length > 0) {
    process.env["CURSOR_API_KEY"] = cfg.cursor.apiKey;
  }

  process.env["CODEFLOW_PROVIDER"] = cfg.provider;

  return cfg;
}

function applyRawConfig(
  cfg: CodeflowConfig,
  raw: RawConfigFile,
  home: string,
): void {
  cfg.provider = "cursor";
  if (raw.cursor) {
    if (raw.cursor.apiKey !== undefined) cfg.cursor.apiKey = raw.cursor.apiKey;
    if (raw.cursor.defaultModel !== undefined) {
      cfg.cursor.defaultModel = raw.cursor.defaultModel;
    }
    if (raw.cursor.listScope !== undefined) {
      cfg.cursor.listScope = raw.cursor.listScope;
    }
  }
  if (raw.relay) {
    if (raw.relay.url !== undefined) cfg.relay.url = raw.relay.url;
    if (raw.relay.roomKey !== undefined) cfg.relay.roomKey = raw.relay.roomKey;
    if (raw.relay.autoConnect !== undefined) {
      cfg.relay.autoConnect = raw.relay.autoConnect;
    }
  }
  if (raw.dataDir !== undefined) {
    const expanded = expandHomeTilde(raw.dataDir)!;
    cfg.dataDir = isAbsolute(expanded) ? expanded : resolve(home, expanded);
  }
  if (raw.defaultAgentKit !== undefined) {
    cfg.defaultAgentKit = raw.defaultAgentKit;
  }
  if (raw.agentRecycle) {
    cfg.agentRecycle = mergeAgentRecycleConfig(cfg.agentRecycle, raw.agentRecycle);
  }
  if (raw.doorbell?.maxToolRounds != null) {
    const n = Number(raw.doorbell.maxToolRounds);
    if (Number.isFinite(n) && n >= 0) cfg.doorbell.maxToolRounds = Math.floor(n);
  }
}

function applyEnvLikeMap(
  cfg: CodeflowConfig,
  src: Record<string, string>,
  home: string,
): void {
  if (src["CODEFLOW_PROVIDER"] === "cursor") {
    cfg.provider = "cursor";
  }
  if (src["CURSOR_API_KEY"]) cfg.cursor.apiKey = src["CURSOR_API_KEY"];
  if (src["CURSOR_DEFAULT_MODEL"]) {
    cfg.cursor.defaultModel = src["CURSOR_DEFAULT_MODEL"];
  }
  if (src["CURSOR_LIST_SCOPE"] === "local" || src["CURSOR_LIST_SCOPE"] === "cloud") {
    cfg.cursor.listScope = src["CURSOR_LIST_SCOPE"];
  }
  if (src["CODEFLOW_RELAY_URL"]) cfg.relay.url = src["CODEFLOW_RELAY_URL"];
  if (src["CODEFLOW_ROOM_KEY"]) cfg.relay.roomKey = src["CODEFLOW_ROOM_KEY"];
  if (src["CODEFLOW_RELAY_AUTOCONNECT"]) {
    const v = src["CODEFLOW_RELAY_AUTOCONNECT"].toLowerCase();
    cfg.relay.autoConnect = v === "1" || v === "true" || v === "yes";
  }
  if (src["CODEFLOW_DATA_DIR"]) {
    const expanded = expandHomeTilde(src["CODEFLOW_DATA_DIR"])!;
    cfg.dataDir = isAbsolute(expanded) ? expanded : resolve(home, expanded);
  }
  const autoRecycle = parseEnvBool(src["CODEFLOW_AGENT_AUTO_RECYCLE"]);
  if (autoRecycle !== undefined) {
    cfg.agentRecycle.enabled = autoRecycle;
  }
  if (src["CODEFLOW_AGENT_RECYCLE_THRESHOLD"]) {
    const n = Number.parseInt(src["CODEFLOW_AGENT_RECYCLE_THRESHOLD"], 10);
    if (Number.isFinite(n) && n > 0) cfg.agentRecycle.sessionThreshold = n;
  }
  if (src["CODEFLOW_AGENT_RECYCLE_INTERVAL_MS"]) {
    const ms = Number.parseInt(src["CODEFLOW_AGENT_RECYCLE_INTERVAL_MS"], 10);
    if (Number.isFinite(ms) && ms >= 60_000) {
      cfg.agentRecycle.checkIntervalMs = ms;
    }
  }
  if (src["CODEFLOW_DOORBELL_MAX_TOOL_ROUNDS"]) {
    const n = Number.parseInt(src["CODEFLOW_DOORBELL_MAX_TOOL_ROUNDS"], 10);
    if (Number.isFinite(n) && n >= 0) cfg.doorbell.maxToolRounds = n;
  }
  // PYTHON_BIN is read directly from process.env by the fcop bridge probe;
  // inject it here so .env / user-env files work without a shell export.
  if (src["PYTHON_BIN"]) {
    process.env["PYTHON_BIN"] = src["PYTHON_BIN"];
  }
  // Same pattern: web-panel reads CODEFLOW_CURSOR_USAGE_SYNC from process.env.
  if (src["CODEFLOW_CURSOR_USAGE_SYNC"]) {
    process.env["CODEFLOW_CURSOR_USAGE_SYNC"] = src["CODEFLOW_CURSOR_USAGE_SYNC"];
  }
}

