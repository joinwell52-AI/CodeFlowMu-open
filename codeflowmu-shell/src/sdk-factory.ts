/**
 * SDK adapter factory — picks the right `AgentSdkAdapter` for the
 * environment the shell is starting in.
 *
 * v0.2.0-beta.1 (MT-1 hotfix; full wire-through of cfg.cursor.defaultModel):
 *
 *   - `makeRealCursorSdkAdapter(cfg)` returns a real `CursorSdkAdapter`
 *     IFF `cfg.apiKey` (or `process.env.CURSOR_API_KEY`) is set, else
 *     returns `null` so callers chain `??` to the in-memory fallback.
 *     Now also forwards `cfg.defaultModel` to `CursorSdkAdapterOptions`
 *     so `Agent.create({ model })` and `agent.send({ model })` get a
 *     value when callers don't specify per-task `spec.modelId` (closes
 *     BUG-SDK-001 / QA-009 §五).
 *
 *   - `makeFakeCursorSdkAdapter()` returns the in-memory adapter
 *     (`InMemorySdkAdapter`) — settles agents synthetically via
 *     `setImmediate`, without making any real SDK / network call. Used
 *     by automated tests AND by users who haven't configured a Cursor
 *     API key yet (so first launch still smoke-tests cleanly).
 *
 * v0.4 (token-management): adds `allowedTools` support.
 *   When `allowedTools` is specified, fcop-mcp is wired through
 *   fcop-mcp-filter.ts (a lightweight MCP proxy) that filters the
 *   tools/list response to only include the allowed subset. This
 *   prevents token explosion in multi-agent setups — a 4-agent team
 *   saves ≈73% tokens by giving worker agents only 7 tools instead
 *   of all 45.
 *
 * References:
 *   - TASK-20260510-002-PM-to-DEV §三 P1 §1 (factory introduced)
 *   - TASK-20260510-010-PM-to-DEV §3.3 (defaultModel wire-through)
 *   - REPORT-20260510-009-QA-to-PM §五 BUG-SDK-001 (root cause)
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AgentLayer } from "@codeflowmu/protocol";
import {
  CursorSdkAdapter,
  InMemorySdkAdapter,
  profileForAgent,
  profileForLayer,
  toolsForAgent,
  toolsForProfile,
  type AgentSdkAdapter,
  type CursorSdkAdapterOptions,
} from "@codeflowmu/runtime";
import { resolveWindowsUseHostPath } from "./windows-use-host-client.ts";
import { listWindowsUseTargets, normalizeWindowsAppId, resolveEffectiveWindowsUseSettings } from "./windows-use-settings.ts";
import { readBrowserUseSettings } from "./browser-use-settings.ts";

export { resolveWindowsUseHostPath } from "./windows-use-host-client.ts";

/** 解析本文件所在目录，用于定位 fcop-mcp-filter.ts。 */
const _thisDir = dirname(fileURLToPath(import.meta.url));

/**
 * Subset of `CodeflowConfig.cursor` consumed by this factory.
 * Decoupled from the full `CodeflowConfig` so unit tests can call the
 * factory with a tiny literal object.
 */
export interface CursorAdapterConfig {
  /**
   * Cursor API key. If absent and `process.env.CURSOR_API_KEY` is also
   * absent, this factory returns `null` and the caller falls back to
   * `makeFakeCursorSdkAdapter()`.
   */
  apiKey?: string;
  /**
   * Default model id forwarded to `Agent.create({ model })` and
   * `agent.send({ model })`. **Required for `local` runtime mode** —
   * the SDK rejects local agents at `send()` without an explicit
   * model (see BUG-SDK-001).
   *
   * MT-1 (v0.2.0-beta.1): now wired all the way to
   * `CursorSdkAdapterOptions.defaultModel`. Previously this field
   * was recorded for the banner only — that left `local`-mode users
   * with a 100% failure rate at first task drop.
   */
  defaultModel?: string;
  /**
   * `local` (the v0.1 default — scopes Agent.list to the current cwd) or
   * `cloud` (cross-machine listing). Optional; defaults to `local`.
   */
  listScope?: "local" | "cloud";
  /**
   * Absolute path to the Python interpreter that has `fcop-mcp`
   * installed (typically `PYTHON_BIN` from the project `.env`).
   * When combined with `projectRoot`, the factory wires fcop-mcp as a
   * stdio MCP server so agents can call `write_task`, `write_report`,
   * etc. without a separate Python process management step.
   */
  pythonBin?: string;
  /**
   * Absolute path to the codeflowmu workspace root (the directory that
   * contains `fcop/fcop.json`). Forwarded to fcop-mcp via the
   * `FCOP_PROJECT_DIR` environment variable so the MCP server resolves
   * tasks/reports against the correct workspace.
   */
  projectRoot?: string;
  /**
   * Allowlist of fcop-mcp tool names this agent is permitted to use.
   * When set, fcop-mcp is wrapped by the MCP filter proxy
   * (`fcop-mcp-filter.ts`) which strips non-allowed tools from
   * `tools/list` responses before they reach the Cursor SDK.
   *
   * Drives token savings in multi-agent setups:
   *   executor  ( 7 tools) ≈  3,000 tokens  (worker agents)
   *   leader    (28 tools) ≈ 12,000 tokens  (PM / PLANNER)
   *   governance(36 tools) ≈ 15,500 tokens  (audit roles)
   *   admin     (45 tools) ≈ 19,320 tokens  (project init)
   *
   * Use `FcopToolProfile.toolsForProfile(profile)` from
   * `@codeflowmu/runtime` to populate this field.
   *
   * Leave `undefined` to pass all 45 tools (backwards-compatible).
   */
  allowedTools?: readonly string[];
}

/**
 * Returns a real `@cursor/sdk`-backed adapter, OR `null` if the SDK
 * isn't reachable (no `apiKey` and no `process.env.CURSOR_API_KEY`).
 *
 * Callers chain `??` to fall back to the in-memory adapter:
 *
 * ```ts
 * const sdk = makeRealCursorSdkAdapter(cfg.cursor) ?? makeFakeCursorSdkAdapter();
 * ```
 */
export function makeRealCursorSdkAdapter(
  cfg: CursorAdapterConfig,
): AgentSdkAdapter | null {
  const apiKey = cfg.apiKey ?? process.env["CURSOR_API_KEY"];
  if (!apiKey) return null;

  const mcpServers: CursorSdkAdapterOptions["mcpServers"] | undefined =
    cfg.pythonBin && cfg.projectRoot
      ? mergeMcpServers(
          buildFcopMcpServer(cfg.pythonBin, cfg.projectRoot, cfg.allowedTools),
          buildWindowsUseMcpServer(cfg.pythonBin, cfg.projectRoot),
          buildBrowserUseMcpServer(cfg.projectRoot),
        )
      : undefined;

  return new CursorSdkAdapter({
    apiKey,
    listScope: cfg.listScope ?? "local",
    defaultCwd: cfg.projectRoot ?? process.cwd(),
    // Open keeps full project capability. Tool-code immutability is enforced
    // by the Open install-integrity shell instead of an SDK permission sandbox.
    sandboxEnabled: false,
    ...(cfg.defaultModel ? { defaultModel: cfg.defaultModel } : {}),
    ...(mcpServers ? { mcpServers } : {}),
  });
}

/**
 * Builds the `mcpServers` config object for fcop-mcp.
 *
 * When `allowedTools` is non-empty, wraps fcop-mcp in the lightweight
 * MCP filter proxy (`fcop-mcp-filter.ts`) which:
 *   1. Spawns `python -m fcop_mcp` as a child process.
 *   2. Transparently forwards all MCP messages.
 *   3. On `tools/list` responses, filters the tool list to only include
 *      names in `FCOP_ALLOWED_TOOLS`.
 *
 * This keeps the Cursor SDK's system-prompt context lean — the SDK only
 * "sees" (and bills tokens for) the tools that each agent is allowed to
 * call.
 */
/**
 * Build filtered fcop MCP config for a codeflowmu agent layer.
 * Used by Runtime `resolveMcpServers` so each send gets the right tool subset.
 */
export function mcpServersForAgentLayer(
  cfg: Pick<CursorAdapterConfig, "pythonBin" | "projectRoot">,
  layer: AgentLayer,
  agentId?: string,
  sessionId?: string,
): CursorSdkAdapterOptions["mcpServers"] | undefined {
  if (!cfg.pythonBin || !cfg.projectRoot) return undefined;
  const profile = agentId ? profileForAgent(agentId, layer) : profileForLayer(layer);
  return mergeMcpServers(
    buildFcopMcpServer(
      cfg.pythonBin,
      cfg.projectRoot,
      agentId ? toolsForAgent(agentId, layer) : toolsForProfile(profile),
      agentId,
      sessionId,
    ),
    buildWindowsUseMcpServer(cfg.pythonBin, cfg.projectRoot),
    buildBrowserUseMcpServer(cfg.projectRoot),
  );
}

function mergeMcpServers(
  ...sources: Array<CursorSdkAdapterOptions["mcpServers"] | undefined>
): CursorSdkAdapterOptions["mcpServers"] | undefined {
  const merged = Object.assign({}, ...sources.filter(Boolean));
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Cursor-only capability-bus mount for managed Chrome and Edge web applications. */
export function buildBrowserUseMcpServer(
  projectRoot: string,
): CursorSdkAdapterOptions["mcpServers"] | undefined {
  if (process.platform !== "win32") return undefined;
  const config = readBrowserUseSettings(projectRoot);
  if (!config.enabled || config.allowedTargetIds.length === 0) return undefined;
  return {
    "browser-use": {
      type: "stdio",
      command: "tsx",
      args: [join(_thisDir, "browser-use-mcp.ts")],
      env: {
        FCOP_PROJECT_DIR: projectRoot,
      },
      cwd: projectRoot,
    },
  };
}

/** Cursor-only capability-bus mount for the Windows Use MCP server. */
export function buildWindowsUseMcpServer(
  pythonBin: string,
  projectRoot: string,
): CursorSdkAdapterOptions["mcpServers"] | undefined {
  if (process.platform !== "win32") return undefined;
  const settings = resolveEffectiveWindowsUseSettings(projectRoot);
  if (!settings.enabled) return undefined;
  const hostPath = resolveWindowsUseHostPath(projectRoot);
  if (!hostPath) return undefined;
  const targetProfiles = listWindowsUseTargets(projectRoot)
    .filter((target) => (
      settings.allowedTargetIds.includes(target.id) ||
      (target.type === "native" && settings.alwaysAllowedAppIds.includes(normalizeWindowsAppId(target.target)))
    ))
    .map(({ credentialRef: _credentialRef, username, ...target }) => ({
      ...target,
      usernameSaved: Boolean(username),
    }));

  return {
    "windows-use": {
      type: "stdio",
      command: pythonBin,
      args: ["-u", hostPath, "--mcp"],
      env: {
        FCOP_PROJECT_DIR: projectRoot,
        PYTHONUNBUFFERED: "1",
        CODEFLOW_WINDOWS_USE_ALLOW_APPS: settings.alwaysAllowedAppIds.join(","),
        CODEFLOW_WINDOWS_USE_ALLOW_PATHS_JSON: JSON.stringify(
          settings.targets.filter((target) => target.type === "native").map((target) => target.target),
        ),
        CODEFLOW_WINDOWS_USE_TARGET_PROFILES_JSON: JSON.stringify(targetProfiles),
      },
      cwd: projectRoot,
    },
  };
}

export function buildFcopMcpServer(
  pythonBin: string,
  projectRoot: string,
  allowedTools?: readonly string[],
  agentId?: string,
  sessionId?: string,
): NonNullable<CursorSdkAdapterOptions["mcpServers"]> {
  const baseEnv: Record<string, string> = {
    FCOP_PROJECT_DIR: projectRoot,
    ...(agentId ? { CODEFLOWMU_AGENT_ID: agentId } : {}),
    ...(sessionId ? { CODEFLOWMU_SESSION_ID: sessionId } : {}),
    ...(process.env["CODEFLOWMU_PANEL_URL"]
      ? { CODEFLOWMU_PANEL_URL: process.env["CODEFLOWMU_PANEL_URL"] }
      : {}),
    // Preserve Python path so the subprocess finds the same packages.
    ...(process.env["PYTHONPATH"]
      ? { PYTHONPATH: process.env["PYTHONPATH"] }
      : {}),
    ...(process.platform === "win32"
      ? { CODEFLOW_FCOP_ONE_SHOT: "1", FCOP_PYTHON_BIN: pythonBin }
      : {}),
  };

  const hasFilter = Array.isArray(allowedTools) && allowedTools.length > 0;

  if (!hasFilter) {
    // Original behaviour: run fcop-mcp directly with no filtering.
    // 🚨 完美开启 Python 无缓冲运行：为了摧毁 Windows pipe 缓冲死锁，必须像代理层一样注入 -u 和 PYTHONUNBUFFERED=1！
    const spawnArgs = ["-m", "fcop_mcp"];
    const isPython = pythonBin.toLowerCase().includes("python");
    const mcpEnv = { ...baseEnv };
    if (isPython) {
      spawnArgs.unshift("-u");
      mcpEnv.PYTHONUNBUFFERED = "1";
    }

    return {
      fcop: {
        type: "stdio",
        command: pythonBin,
        args: spawnArgs,
        env: mcpEnv,
        cwd: projectRoot,
      },
    };
  }

  // With filter: route through the MCP proxy script.
  const filterScript = join(_thisDir, "fcop-mcp-filter.ts");

  // Forward the allowed-tools allowlist via env var so the proxy can
  // parse it without needing CLI args (keeps stdio protocol clean).
  const filterEnv: Record<string, string> = {
    ...baseEnv,
    FCOP_ALLOWED_TOOLS: allowedTools.join(","),
    // Let the proxy know which Python binary to use for fcop-mcp.
    FCOP_PYTHON_BIN: pythonBin,
  };

  return {
    fcop: {
      type: "stdio",
      // Use tsx (TypeScript runner) to execute the filter script.
      // tsx is a dev dependency of codeflowmu-shell so it's always
      // available in the project tree.
      command: "tsx",
      args: [filterScript],
      env: filterEnv,
      cwd: projectRoot,
    },
  };
}

/**
 * Returns the in-memory adapter (`InMemorySdkAdapter`) — settles
 * agents synthetically via `setImmediate`, without making any real
 * SDK / network call. Used by:
 *
 *   - Automated tests (94/94 in `@codeflowmu/runtime`).
 *   - Local smoke tests where no `CURSOR_API_KEY` is present.
 *   - The Hello World demo (so `examples/hello-world/sample-task.md`
 *     drops cleanly even without a Cursor account).
 */
export function makeFakeCursorSdkAdapter(): AgentSdkAdapter {
  return new InMemorySdkAdapter();
}

/**
 * Diagnostic helper for the banner — returns a one-line description
 * of which adapter mode we picked (and why).
 */
export function describeAdapterChoice(
  cfg: CursorAdapterConfig,
  picked: AgentSdkAdapter,
): string {
  const isReal = picked instanceof CursorSdkAdapter;
  if (isReal) {
    const keySource = cfg.apiKey ? "config" : "process.env.CURSOR_API_KEY";
    const modelSuffix = cfg.defaultModel
      ? `, defaultModel="${cfg.defaultModel}"`
      : "";
    let mcpSuffix = "";
    if (cfg.pythonBin && cfg.projectRoot) {
      const toolCount = cfg.allowedTools?.length ?? 45;
      const filterNote =
        cfg.allowedTools?.length
          ? ` filtered=${toolCount}/${45}`
          : "";
      mcpSuffix = `, mcpServers=[fcop${filterNote}]`;
    }
    return `live (CursorSdkAdapter; apiKey from ${keySource}, listScope="${cfg.listScope ?? "local"}"${modelSuffix}${mcpSuffix})`;
  }
  return "fake (InMemorySdkAdapter; CURSOR_API_KEY not set — set it in ~/.codeflowmu/v2/.env or config.json to use real SDK)";
}
