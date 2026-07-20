/**
 * codeflowmu-shell main entry — v0.3.0-alpha (P4 sprint Day 1 — TASK-20260511-007).
 *
 * Reference:
 *   - design doc §11.2 + §11.3 (Layer 1 minimal entry)
 *   - TASK-20260510-002-PM-to-DEV §三 P1 §1 main.ts wiring (still in force)
 *   - TASK-20260510-007-PM-to-DEV §四 P2 §3 + §4 (P2 acceptance: spike + MT-2)
 *   - TASK-20260510-010-PM-to-DEV (MT-1 hotfix: defaultModel wire-through;
 *     adds banner WARNING block when live + local + no model)
 *   - TASK-20260510-012-PM-to-DEV (MT-2 hotfix: agent.send() carries
 *     local.force=true to expire wedged persisted runs; closes BUG-SDK-002.)
 *   - TASK-20260510-013-PM-to-DEV (MT-3 + MT-4 hotfixes: CURSOR_DEFAULT_MODEL
 *     default; ReviewEngine.extractText() walks content[] array.)
 *   - TASK-20260511-001-PM-to-DEV (MT-5 hotfix: Agent.create() no longer
 *     receives a `model` field — closes BUG-SDK-007.)
 *   - TASK-20260511-007-PM-to-DEV (P4 main sprint Day 1: introduce
 *     `FcopProjectClient` + banner PYTHON_BIN/fcop check + .env.example
 *     PYTHON_BIN entry. Day 2-5 will progressively swap TaskDispatcher /
 *     ReviewEngine / NeedsHumanGate / AgentRegistry over to fcop@1.1.0
 *     Python API via pythonia. v0.3.0-alpha.)
 *
 * Pipeline:
 *
 *   1. `loadConfig()` — merge defaults / config.json / .env / process.env / CLI args.
 *   2. Ensure data dirs exist (chokidar doesn't auto-create).
 *   3. Plant fixture skills if `<skillsDir>/fcop.json` is missing.
 *   4. **NEW (P4 Day 1.4)**: Probe pythonia + fcop@1.1.0 readiness via
 *      `assertFcopReady()`. Fail fast with actionable error if PYTHON_BIN
 *      points nowhere / Python < 3.10 / fcop@1.1.0 not installed.
 *   5. Pick the SDK adapter — real CursorSdkAdapter if cfg.cursor.apiKey
 *      resolves, else InMemorySdkAdapter (smoke-test fallback).
 *   6. Construct Runtime (synchronously runs RuntimeBootstrap).
 *   7. Register the default agent kit if `agents.json` is empty.
 *   8. Start dispatcher / review engine / status reconciler.
 *   9. Print banner with config provenance + adapter mode + watcher dir +
 *      PYTHON_BIN + fcop version + PID.
 *   10. Wait for SIGINT / SIGTERM → graceful stop (now also
 *       `disposeFcopBridge()` to kill the pythonia child Python process).
 *
 * What this file does NOT do (deferred to later v0.3 days / sprints):
 *
 *   - Day 2-5: swap TaskDispatcher / ReviewEngine.writeReview /
 *              NeedsHumanGate / AgentRegistry to FcopProjectClient.
 *   - Day 6:   bump version + CHANGELOG + release notes.
 *   - P3:      instantiate `RelayBridge` from `cfg.relay.*`.
 *   - P5:      install.ps1 auto-install Python + fcop.
 */

import { existsSync } from "node:fs";
import { homedir as _homedir } from "node:os";
import { dirname, join, resolve as pathResolve, basename as pathBasename } from "node:path";

import {
  Runtime,
  assertFcopReady,
  disposeFcopBridge,
  FcopClientError,
  FcopProjectClient,
  PlanScheduler,
  FixedTaskRunner,
  buildDefaultRules,
  plantPmSkillManifestIfMissing,
  plantAgentSkillsManifestIfMissing,
} from "@codeflowmu/runtime";

import {
  ensureDataDirs,
  plantSkillFixturesIfMissing,
  readTeamMeta,
  registerDefaultAgentKitIfEmpty,
  syncTeamModelsFromConfig,
} from "./bootstrap.ts";
import { loadConfig } from "./config.ts";
import { resolveLegacyReviewEngine } from "./runtime-flags.ts";
import {
  describeAdapterChoice,
  makeFakeCursorSdkAdapter,
  makeRealCursorSdkAdapter,
  mcpServersForAgentLayer,
} from "./sdk-factory.ts";
import { logFcopClientCreateFailure } from "./fcop-client-diagnostics.ts";
import { startWebPanel, type WebPanelHandle } from "./web-panel.ts";
import { readFcopJsonMeta, readShellVersion } from "./fcop-env-probe.ts";
import { ensureAdoptedFromSource } from "./fcop-adopted-bootstrap.ts";
import { resolveRuntimeStartupProjectRoot } from "./project-registry.ts";
import { fileURLToPath } from "node:url";

const SHELL_PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Shell semver — always from codeflowmu-shell/package.json (not Python fcop). */
const VERSION = readShellVersion(SHELL_PKG_ROOT);

interface ShellLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

const consoleLogger: ShellLogger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
};

/**
 * Result of {@link probeFcopBridge}. We discriminate three states so the
 * banner can print the right thing and tests can drive each branch:
 *
 *   - `ok`       fcop@1.1.0 reachable + version captured.
 *   - `failed`   probe threw. `probeFcopBridge` already printed actionable
 *                  errors to stderr and called `process.exit(1)` — this
 *                  variant exists so TS knows the branch is unreachable in
 *                  production, but the type stays sound for tests / sandbox.
 *   - `skipped`  user explicitly opted out via `CODEFLOW_SKIP_FCOP_PROBE=1`.
 *                  Used during integration tests that pre-stub fcop and
 *                  during early P4 dev when Python isn't yet on the box.
 */
type FcopProbeResult =
  | {
      status: "ok";
      fcopVersion: string;
      pythonVersion: string;
      pythonExecutable: string;
    }
  | {
      status: "skipped";
      reason: string;
    }
  | {
      status: "failed";
      message: string;
    };

/**
 * Probe pythonia + fcop@1.1.0 readiness. **Side-effect: kills the process
 * with exit code 2 on failure** (after printing actionable hints to
 * stderr). Returns a structured result for the banner if the probe
 * succeeds or was skipped.
 *
 * Why exit code **2** (not 1)? `main().catch` already uses exit code 1
 * for unexpected fatals. Splitting "config / env failure" → 2 from
 * "uncaught exception" → 1 lets ops scripts (Day 6 smoke tests; later
 * install.ps1 / EXE bundler) distinguish them.
 */
async function probeFcopBridge(): Promise<FcopProbeResult> {
  if (process.env["CODEFLOW_SKIP_FCOP_PROBE"] === "1") {
    return {
      status: "skipped",
      reason: "CODEFLOW_SKIP_FCOP_PROBE=1 in env",
    };
  }
  // PRE-flight check: pythonia's StdioCom synchronously cp.spawn()s
  // `process.env.PYTHON_BIN || 'python3'` the first time something from
  // the pythonia module is imported. `cp.spawn()` returns synchronously
  // even when the target doesn't exist — the ENOENT surfaces as an
  // async 'error' event on the child process, which pythonia doesn't
  // listen for, so Node crashes with exit code 1 BEFORE assertFcopReady's
  // try/catch can ever run.
  //
  // Therefore we verify PYTHON_BIN points to an existing file BEFORE we
  // touch any code path that transitively imports pythonia. The check is
  // intentionally only "file exists" (not "is a Python interpreter +
  // version + has fcop") — the deeper checks live in assertFcopReady().
  const pythonBin = process.env["PYTHON_BIN"];
  if (pythonBin && !existsSync(pythonBin)) {
    printFcopProbeFailure(
      `PYTHON_BIN points at a path that does not exist: ${pythonBin}`,
      [
        "Check the spelling, escape backslashes properly in .env, or unset",
        "PYTHON_BIN to let pythonia fall back to PATH `python3` / `python`.",
        "",
        "Find a valid path with:",
        "  Windows: where.exe python  OR  py -3 -c \"import sys; print(sys.executable)\"",
        "  macOS:   which python3      OR  python3 -c \"import sys; print(sys.executable)\"",
        "  Linux:   which python3      OR  python3 -c \"import sys; print(sys.executable)\"",
      ],
    );
  }
  try {
    const info = await assertFcopReady();
    return {
      status: "ok",
      fcopVersion: info.fcopVersion,
      pythonVersion: info.pythonVersion,
      pythonExecutable: info.pythonExecutable,
    };
  } catch (err) {
    const isClientError = err instanceof FcopClientError;
    const message = err instanceof Error ? err.message : String(err);
    if (isClientError) {
      // assertFcopReady already builds a multi-line actionable message.
      printFcopProbeFailure(message, []);
    } else {
      printFcopProbeFailure("Unexpected error during fcop bridge probe:", [
        message,
        "",
        "Hints:",
        "  - Set PYTHON_BIN to a Python 3.10+ executable that has fcop installed.",
        `    Current PYTHON_BIN = ${process.env["PYTHON_BIN"] ?? "<unset>"}`,
        "  - Install fcop: `py -3 -m pip install fcop` (or `pip install fcop`",
        "    on the same interpreter PYTHON_BIN points to).",
      ]);
    }
  }
  // Unreachable but TS requires a return.
  return { status: "failed", message: "unreachable" };
}

/**
 * Print a structured FATAL banner with hints and exit with code 2.
 *
 * **never returns** — the function is typed `never` so TS knows control flow
 * after a call to it can't reach further statements (we still write a
 * sentinel `return` after the `process.exit(2)` for runtime sanity).
 */
function printFcopProbeFailure(headline: string, lines: string[]): never {
  console.error("===========================================================");
  console.error("FATAL: pythonia + fcop@1.1.0 bridge is not ready.");
  console.error("===========================================================");
  console.error(headline);
  for (const line of lines) console.error(line);
  console.error("");
  console.error(
    "To run codeflowmu-shell without the fcop bridge (Day 1 development only),",
  );
  console.error("set CODEFLOW_SKIP_FCOP_PROBE=1 and the probe will be skipped.");
  console.error("===========================================================");
  process.exit(2);
}

function describeSources(sources: ReturnType<typeof loadConfig>["sources"]): string {
  const order = [
    sources.userConfig ? "user-config" : null,
    sources.projectConfig ? "project-config" : null,
    sources.userEnvFile ? "user-env" : null,
    sources.projectEnvFile ? "project-env" : null,
    sources.processEnv ? "process.env" : null,
    sources.cliArgs ? "cli-args" : null,
  ].filter(Boolean);
  return order.length === 0 ? "defaults only" : order.join(" → ");
}

/**
 * Resolve the codeflowmu project root by walking up from `start` looking for
 * a `fcop/fcop.json` marker — the same marker `fcop.Project.is_initialized()`
 * checks. Returns the matching directory and whether `start` itself was the
 * match; returns `{ root: null }` when no marker is found within 8 ancestors.
 *
 * Why this exists (D12 P-path PM #34, DEV-024 D24-S2 latent realization):
 * `npm start` invoked from a subdir (e.g. `cd codeflowmu-shell ; npm start`)
 * sets `process.cwd() = codeflowmu-shell`. With `ensureInitialized: true`,
 * `FcopProjectClient.create({ projectRoot: process.cwd() })` then triggers
 * `_ensureInitialized()` which writes 18+ fcop init files to
 * `codeflowmu-shell/fcop/` — a phantom副本 that violates ADMIN D14 = A
 * (only the repo root `fcop/` is a sanctioned init artifact). Pinning to
 * the marker prevents that without touching `FcopProjectClient` internals
 * (PM-25 redline: only the caller may change).
 */
function resolveCodeflowProjectRoot(start: string): {
  root: string | null;
  cwdMatched: boolean;
} {
  let dir = pathResolve(start);
  const startAbs = dir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "fcop", "fcop.json"))) {
      return { root: dir, cwdMatched: dir === startAbs };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { root: null, cwdMatched: false };
}

function resolveOpenEditionStartupProjectRoot(): string | null {
  if (process.env["CODEFLOW_OPEN_EDITION"] !== "1") return null;
  const explicit = process.env["CODEFLOW_OPEN_DEFAULT_PROJECT_ROOT"];
  if (explicit?.trim()) return pathResolve(explicit);
  const hostRoot = process.env["CODEFLOW_OPEN_HOST_ROOT"];
  if (hostRoot?.trim()) return pathResolve(hostRoot, "projects", "newproject");
  return null;
}

function resolveOpenEditionHostRoot(): string | null {
  if (process.env["CODEFLOW_OPEN_EDITION"] !== "1") return null;
  const hostRoot = process.env["CODEFLOW_OPEN_HOST_ROOT"];
  return hostRoot?.trim() ? pathResolve(hostRoot) : null;
}

async function main(): Promise<void> {
  // The mother application owns one Mobile Gateway identity. Switching the
  // active development project must not switch Gateway endpoint/credentials.
  if (
    process.env["CODEFLOW_OPEN_EDITION"] !== "1" &&
    !process.env["CODEFLOWMU_HOST_ROOT"]?.trim()
  ) {
    process.env["CODEFLOWMU_HOST_ROOT"] = pathResolve(dirname(SHELL_PKG_ROOT));
  }

  // ── 0. Early-read codeflowmu.team.json for panel_port + project slug ─
  // Done before loadConfig() so panel_port is available before Runtime.create.
  // We do a quick walk to find the project root (same logic as resolveCodeflowProjectRoot,
  // but lighter — just looks for codeflowmu.team.json in cwd and two ancestors).
  const _bootstrapProjectRoot = (() => {
    let d = pathResolve(process.cwd());
    for (let i = 0; i < 4; i++) {
      if (existsSync(join(d, "codeflowmu.team.json"))) return d;
      const p = dirname(d); if (p === d) break; d = p;
    }
    return null;
  })();
  const _openEditionBootstrapRoot = resolveOpenEditionStartupProjectRoot();
  const _earlyProjectRoot = resolveRuntimeStartupProjectRoot(
    _openEditionBootstrapRoot,
    _bootstrapProjectRoot,
  );
  const _teamConfigRoot =
    resolveOpenEditionHostRoot() ?? _bootstrapProjectRoot ?? _earlyProjectRoot;
  const _teamMeta = _teamConfigRoot
    ? await readTeamMeta(_teamConfigRoot).catch(() => null)
    : null;
  const _panelPort = _teamMeta?.panelPort ?? 18766;

  // ── 1. Resolve config (5-tier merge) ───────────────────────────────
  const cfg = loadConfig();

  // Per-project data dir. Open keeps Runtime state inside the actual project
  // root so separate installations with the same slug (usually newproject)
  // never reuse sdk_agent_id/session state from a previous installation.
  // Mother keeps the historical per-user slug layout for compatibility.
  const _dataDirOverridden = !!(
    process.env["CODEFLOW_DATA_DIR"] ||
    process.argv.some((a) => a.startsWith("--data-dir"))
  );
  const _projectSlug = _earlyProjectRoot
    ? pathResolve(_earlyProjectRoot).split(/[\\/]/).pop()?.toLowerCase().replace(/[^a-z0-9-]/g, "-") ?? "default"
    : "default";
  const dataDir = _dataDirOverridden
    ? cfg.dataDir
    : process.env["CODEFLOW_OPEN_EDITION"] === "1" && _earlyProjectRoot
      ? join(pathResolve(_earlyProjectRoot), ".codeflowmu", "runtime")
    : join(_homedir(), ".codeflowmu", "projects", _projectSlug);

  const inboxDir = join(dataDir, "inbox");
  const skillsDir = join(dataDir, "skills");

  // ── 2. Ensure all data dirs exist BEFORE Runtime.create ────────────
  await ensureDataDirs(dataDir);

  // ── 3. Plant fixture skills BEFORE Runtime.create ──────────────────
  const skillResult = await plantSkillFixturesIfMissing(skillsDir);

  // ── 4. fcop bridge readiness probe (P4 sprint Day 1.4) ─────────────
  //
  // BUG-SDK-001 taught us: silent feature-flags that surface as obscure
  // failures 30 seconds into a task dispatch waste user time. The fcop
  // bridge has THREE common ways to be misconfigured on Windows:
  //
  //   1. `PYTHON_BIN` env var not set, and PATH `python3` / `python` is a
  //      Python that doesn't have fcop installed (Windows defaults to
  //      python.org PATH installer which is often a separate interpreter
  //      from the one with fcop).
  //   2. Python < 3.10 (fcop requires 3.10+; DEV-005 §五 S2).
  //   3. fcop@1.1.0 missing (`pip install fcop` was never run, or run on
  //      the wrong interpreter — see #1).
  //
  // We probe NOW (before Runtime.create) so users see the error at the
  // banner stage with actionable hints, not after the first task drop.
  const fcopReady = await probeFcopBridge();

  // ── 4.5 Resolve codeflowmu workspace root (always — panel / git / file browse) ──
  // Pin to the directory containing fcop/fcop.json, never process.cwd() when
  // Shell is started from codeflowmu-shell/ (D12 P-path / PM #34).
  const _cwd = process.cwd();
  const { root: _resolvedWorkspaceRoot, cwdMatched: _cwdMatched } =
    resolveCodeflowProjectRoot(_cwd);
  // Panel's persisted active project is authoritative.  `_earlyProjectRoot`
  // already resolves it for the mother edition; the Open startup shim passes
  // the same value through CODEFLOW_OPEN_DEFAULT_PROJECT_ROOT.
  let workspaceRoot = _earlyProjectRoot ?? _resolvedWorkspaceRoot;
  let monorepoFallback = false;
  const openEditionHostMode = process.env["CODEFLOW_OPEN_EDITION"] === "1";
  const openEditionStartupRoot = resolveOpenEditionStartupProjectRoot();

  if (openEditionHostMode && !workspaceRoot && openEditionStartupRoot) {
    workspaceRoot = openEditionStartupRoot;
  }

  if (!workspaceRoot) {
    // 超级鲁棒兜底：如果从 Cwd 往上找不着 fcop.json（比如在一键初始化前启动，或者在其他目录下启动），
    // 检查是否处于标准的 monorepo 代码树内（即 SHELL_PKG_ROOT 目录是 codeflowmu-shell）。
    if (pathBasename(SHELL_PKG_ROOT) === "codeflowmu-shell") {
      const parent = dirname(SHELL_PKG_ROOT);
      if (existsSync(join(parent, "package.json")) && existsSync(join(parent, "codeflowmu-shell", "package.json"))) {
        workspaceRoot = parent;
        monorepoFallback = true;
      }
    }
  }

  if (openEditionHostMode && workspaceRoot) {
    const openHostRoot = pathResolve(dirname(SHELL_PKG_ROOT));
    if (pathResolve(workspaceRoot).toLowerCase() === openHostRoot.toLowerCase()) {
      consoleLogger.warn(
        `[shell] open edition host root detected: ${workspaceRoot}; ` +
          `waiting for an external project root before enabling FCoP project writes.`,
      );
      workspaceRoot = null;
      monorepoFallback = false;
    }
  }

  if (workspaceRoot && monorepoFallback) {
    consoleLogger.warn(
      `[shell] workspace root fallback to monorepo root: ${workspaceRoot} ` +
        `(process.cwd()=${_cwd} did not contain fcop/fcop.json).`,
    );
  } else if (workspaceRoot && !_cwdMatched) {
    consoleLogger.warn(
      `[shell] workspace root pinned to ${workspaceRoot} ` +
        `(process.cwd()=${_cwd} did not contain fcop/fcop.json).`,
    );
  } else if (!workspaceRoot) {
    consoleLogger.warn(
      `[shell] no fcop/fcop.json found from ${_cwd} or its 8 ancestors — ` +
        `file browse / env check will use cwd until a workspace is detected.`,
    );
  }

  const workspaceHasFcop = Boolean(
    workspaceRoot && existsSync(join(workspaceRoot, "fcop", "fcop.json")),
  );

  // Open first-run/repair is an explicit Panel action. Do not silently plant
  // adopted clauses or Skills before env/check can present the init button.
  if (workspaceRoot && workspaceHasFcop && !openEditionHostMode) {
    const pmManifest = await plantPmSkillManifestIfMissing(workspaceRoot);
    if (pmManifest.planted) {
      consoleLogger.info(`[shell] planted PM skill manifest: ${pmManifest.path}`);
    }

    const agentManifest = await plantAgentSkillsManifestIfMissing(workspaceRoot);
    if (agentManifest.planted) {
      consoleLogger.info(
        `[shell] restored agent-skills manifest from ${agentManifest.sourcePath} → ${agentManifest.path}`,
      );
    } else if (agentManifest.sourceMissing) {
      consoleLogger.warn(
        `[shell] missing ${agentManifest.path} and source ${agentManifest.sourcePath} — ` +
          "cannot restore Agent Playbook catalog after .codeflowmu/ cleanup",
      );
    }

    try {
      const adopted = await ensureAdoptedFromSource(workspaceRoot);
      if (adopted.bootstrapped) {
        consoleLogger.info(
          `[shell] adopted bootstrap: copied ${adopted.copied} file(s) from adoptedSource/ → fcop/adopted/` +
            (adopted.skipped > 0 ? ` (${adopted.skipped} skipped, already present)` : ""),
        );
      } else if (adopted.adoptedSourceMissing && adopted.adoptedWasEmpty) {
        consoleLogger.warn(
          "[shell] fcop/adopted/ 为空且 adoptedSource/ 不存在 — 环境检查将报错，请恢复 adoptedSource/",
        );
      }
    } catch (err) {
      consoleLogger.warn(
        `[shell] ensureAdoptedFromSource failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const _pythonBin = process.env["PYTHON_BIN"];

  // ── 5. Pick the SDK adapter ────────────────────────────────────────
  const adapterCfg = {
    ...cfg.cursor,
    ...(_pythonBin ? { pythonBin: _pythonBin } : {}),
    ...(workspaceRoot ? { projectRoot: workspaceRoot } : {}),
  };
  const sdkAdapter =
    makeRealCursorSdkAdapter(adapterCfg) ?? makeFakeCursorSdkAdapter();
  const adapterDescription = describeAdapterChoice(adapterCfg, sdkAdapter);

  // ── 6. Construct runtime (bootstrap runs synchronously) ────────────
  // P4 sprint Day 2: when the fcop probe succeeded, build a
  // FcopProjectClient bound to the data dir and inject it into Runtime
  // so TaskDispatcher's parser walks fcop @1.1.0 instead of in-process
  // yaml. When the probe was skipped or fcop is otherwise unavailable,
  // omit the client — Runtime then keeps the legacy yaml parser
  // (back-compat + CODEFLOW_SKIP_FCOP_PROBE=1 escape hatch).
  //
  // P4 OPS-015 layout migration: codeflowmu now uses fcop's default
  // `<projectRoot>/fcop/` workspace layout, so we intentionally do not
  // pass `workspaceDir`.
  //
  // BUG-FCOP-001 remediation (5/12, D12 P-path): `ensureInitialized: true`
  // since OPS-023 (5/11 20:21) generated `fcop/fcop.json` (+ LETTER-TO-ADMIN.md
  // + workspace/README.md), so `Project.is_initialized() = True`. With this
  // flag, the fcop write APIs (writeReview / writeTask / markHumanApproved)
  // succeed as first-class fcop writes instead of silently falling back to
  // YAML — which was the actual production behavior on the original
  // v0.3.0-alpha tag (`ea0f374`, BUG-FCOP-001 P1 surfaced by QA-005).
  // The force-updated `v0.3.0-alpha` tag (OPS-026) re-points the existing
  // tag at the remediation commit so the public artifact name is unchanged.
  //
  // PM #34 / D24-S2 defense (TASK-025): we do NOT pass `projectRoot: process.cwd()`
  // verbatim because that allows `npm start` from a subdir to write a phantom
  // `<subdir>/fcop/` init tree. Instead, walk up from cwd to find the directory
  // that already has `fcop/fcop.json`; if none is found within 8 ancestors,
  // disable the fcop client entirely and stay on the YAML emit fallback (same
  // posture as `CODEFLOW_SKIP_FCOP_PROBE=1`).
  let fcopClient: FcopProjectClient | undefined;
  let fcopProjectRoot: string | null = workspaceHasFcop ? workspaceRoot : null;
  type FcopFallbackReason =
    | "windows_stdio_guard"
    | "no_fcop_json"
    | "create_failed"
    | null;
  let fcopFallbackReason: FcopFallbackReason = null;
  if (fcopReady.status === "ok") {
    if (fcopProjectRoot === null) {
      consoleLogger.warn(
        `[shell] fcop bridge ready but no fcop/fcop.json — ` +
          `disabling fcop write path, falling back to YAML emit.`,
      );
      fcopClient = undefined;
      fcopProjectRoot = null;
      fcopFallbackReason = "no_fcop_json";
    } else {
      // 🚨 Windows 安全阀：由于 Windows 底层 Stdio 对 pythonia 桥接长连接极易引发 4KB 全缓冲死锁，
      // 为了彻底根除 Windows 用户在 FCoP 读写时的 120 秒超时卡死，在 Windows 环境下默认跳过 FcopProjectClient，
      // 顺畅降级回退到纯 Node 内存的 in-process yaml 极速解析模式（escape hatch 逃生舱）。
      const isWin = process.platform === "win32";
      if (isWin) {
        consoleLogger.warn(
          `[shell] Windows environment detected — skipping FcopProjectClient to avoid ` +
            `pythonia stdio buffer deadlocks. Falling back to ultra-fast in-process yaml parser.`,
        );
        fcopClient = undefined;
        fcopFallbackReason = "windows_stdio_guard";
      } else {
        try {
          fcopClient = await FcopProjectClient.create({
            projectRoot: fcopProjectRoot,
            ensureInitialized: true,
            // Explicit workspace dir required when both fcop/ and docs/agents/
            // exist under project root (fcop 1.5.1 ADR-0022 ambiguity guard).
            workspaceDir: "fcop",
          });
        } catch (err) {
          logFcopClientCreateFailure(consoleLogger.warn, err, {
            workspaceRoot: fcopProjectRoot,
            fcopRoot: join(fcopProjectRoot, "fcop"),
            fcopVersion: fcopReady.fcopVersion,
            failedFunction: "FcopProjectClient.create",
          });
          consoleLogger.warn(
            "[shell] falling back to in-process yaml parser after FcopProjectClient.create failure",
          );
          fcopClient = undefined;
          fcopFallbackReason = "create_failed";
        }
      }
    }
  }

  // FCoP v3 lifecycle inbox — all incoming tasks land here.
  // (v2 used fcop/tasks/; v3 uses fcop/_lifecycle/inbox/ per ADR-0022+v3-migration)
  const fcopTasksDir =
    fcopProjectRoot
      ? join(fcopProjectRoot, "fcop", "_lifecycle", "inbox")
      : undefined;
  // v0.3 loop closure: watch fcop/reports/ so worker reports trigger PM
  // consolidation sessions automatically (DEV → PM → ADMIN chain).
  const fcopReportsDir =
    fcopProjectRoot ? join(fcopProjectRoot, "fcop", "reports") : undefined;

  // ADMIN direct drop: same as PM→worker, tasks land in the lifecycle inbox.
  const adminTasksDir = fcopTasksDir;

  // Build additional inbox dirs: _lifecycle/inbox covers both PM→worker and ADMIN→PM.
  const additionalInboxDirs: string[] = [
    ...(fcopTasksDir ? [fcopTasksDir] : []),
  ];

  const mcpBridgeCfg = {
    ...(_pythonBin ? { pythonBin: _pythonBin } : {}),
    ...(workspaceRoot ? { projectRoot: workspaceRoot } : {}),
  };

  const runtime = await Runtime.create({
    sdkAdapter,
    persistDir: dataDir,
    inboxDir,
    skillsDir,
    logger: consoleLogger,
    ...(mcpBridgeCfg.pythonBin && mcpBridgeCfg.projectRoot
      ? {
          resolveMcpServers: ({ agentId, layer, sessionId }) =>
            mcpServersForAgentLayer(mcpBridgeCfg, layer, agentId, sessionId),
        }
      : {}),
    ...(fcopClient ? { fcopClient } : {}),
    // Tell TaskParser where the fcop tasks dir is so it skips readTask()
    // for inbox-only files (avoids pythonia hang on TaskNotFoundError).
    ...(fcopClient && fcopTasksDir ? { fcopTasksDir } : {}),
    // v3: watch fcop/_lifecycle/inbox/ (PM→worker + ADMIN→PM)
    ...(additionalInboxDirs.length > 0 ? { additionalInboxDirs } : {}),
    // v0.3 loop: report watcher closes DEV→PM→ADMIN chain.
    // Enable "the other half doorbell" by default:
    // REPORT-*-to-PM.md -> start a PM consolidation session.
    legacyReportDispatcher: false,
    legacyReviewEngine: resolveLegacyReviewEngine(),
    ...(fcopReportsDir ? { fcopReportsDir } : {}),
    ...(fcopProjectRoot ? { projectRoot: fcopProjectRoot } : {}),
    ...(mcpBridgeCfg.pythonBin ? { pythonBin: mcpBridgeCfg.pythonBin } : {}),
    sessionMaxToolRounds: cfg.doorbell.maxToolRounds,
    runtimeProvider: cfg.provider,
  });

  // ── 7. Register default agent kit ──────────────────────────────────
  // Agent cwd belongs to the selected development project even before that
  // project has completed FCoP initialization.  FCoP availability controls
  // lifecycle/watchers only; it must not fall back the agent workspace to
  // codeflowmu-shell (the mother-app process cwd).
  const agentResult = await registerDefaultAgentKitIfEmpty({
    dataDir,
    runtime,
    projectRoot: workspaceRoot ?? undefined,
    teamConfigRoot: _teamConfigRoot ?? undefined,
  });

  if (fcopProjectRoot) {
    const modelSync = await syncTeamModelsFromConfig({
      dataDir,
      runtime,
      projectRoot: fcopProjectRoot,
      teamConfigRoot: _teamConfigRoot ?? undefined,
    });
    if (modelSync.updated > 0) {
      console.log(
        `[bootstrap] synced gemini model ids from team config (${modelSync.updated} agent(s))`,
      );
    }
  }

  // ── 8. Start ───────────────────────────────────────────────────────
  await runtime.start();

  // ── 8.1 PlanScheduler (Sprint-G — TASK-20260514-968) ───────────────
  // Scans fcop/_lifecycle/inbox/PLAN-*.md and auto-advances sprints by calling
  // runtime.sessionManager.startSession() directly (no file-drop needed).
  const planDir =
    fcopTasksDir ??
    (workspaceRoot
      ? join(workspaceRoot, "fcop", "_lifecycle", "inbox")
      : join(process.cwd(), "fcop", "_lifecycle", "inbox"));
  const planScheduler = new PlanScheduler({
    runtime,
    planDir,
    scanIntervalMs: 60_000,
    logger: consoleLogger,
  });
  await planScheduler.start();

  // ── 8.2 FixedTaskRunner (Sprint-G) ─────────────────────────────────
  // Default rules: health-check DISABLED (LLM cost); restart-recovery
  // disabled; milestone-commit (manual trigger every 3 sprints).
  // Non-LLM 30min/15s timers live elsewhere (UsageSyncer, panel recycle, SSE).
  let _completedSprintCount = 0;
  const fixedTaskRunner = new FixedTaskRunner(
    runtime,
    buildDefaultRules(() => _completedSprintCount),
    consoleLogger,
  );
  fixedTaskRunner.start();

  // Sprint counter side-channel (reserved for future hook).
  void _completedSprintCount;

  // ── 8.5 Web Panel (Lane A D1+D2 / TASK-20260512-018) ───────────────
  const noPanel =
    process.argv.includes("--no-panel") ||
    process.env["CODEFLOW_NO_PANEL"] === "1";
  let webPanel: WebPanelHandle | null = null;
  if (!noPanel) {
    const fcopJsonMeta = workspaceRoot ? readFcopJsonMeta(workspaceRoot) : { protocolVersion: null };
    webPanel = await startWebPanel(runtime, {
      logger: consoleLogger,
      port: _panelPort,
      projectRoot: workspaceRoot ?? undefined,
      adminTasksDir: adminTasksDir,
      fcopReportsDir: fcopReportsDir,
      fcopReviewsDir: fcopProjectRoot ? join(fcopProjectRoot, "fcop", "reviews") : undefined,
      failuresDir: fcopProjectRoot
        ? join(fcopProjectRoot, "fcop", "internal", "failures")
        : undefined,
      sdkAdapter,
      dataDir,
      agentRecycle: cfg.agentRecycle,
      reloadOnProjectSwitch: true,
      fcopRuntime: {
        ...(fcopReady.status === "ok"
          ? {
              fcopVersion: fcopReady.fcopVersion,
              pythonExecutable: fcopReady.pythonExecutable,
            }
          : {}),
        ...(fcopJsonMeta.protocolVersion != null
          ? { protocolVersion: fcopJsonMeta.protocolVersion }
          : {}),
      },
    });
  }

  // ── 9. Banner ──────────────────────────────────────────────────────
  console.log("===========================================================");
  console.log(`codeflowmu v${VERSION} — internal preview`);
  console.log("===========================================================");
  console.log(`Data dir       : ${dataDir}${_dataDirOverridden ? " (explicit)" : ` (project: ${_projectSlug})`}`);
  if (workspaceRoot) {
    console.log(`Workspace root : ${workspaceRoot}`);
  }
  console.log(`Inbox          : ${runtime.watcher.dir}`);
  console.log(`Reviews        : ${runtime.reviewWriter.reviewsDir}`);
  console.log(`Config sources : ${describeSources(cfg.sources)}`);
  console.log(`Cursor SDK     : ${adapterDescription}`);
  // P4 Day 1.4: surface fcop bridge state in the banner. When the probe
  // skipped (FAKE_PYTHONIA env / probe disabled), show "(skipped)".
  // P4 Day 3 (TASK-20260511-011): added `Review writer` line to surface
  // the per-subsystem fcop wire-up so operators see WHICH layers route
  // through fcop and which stay on YAML — same transparency idiom as
  // the Day 2 `Task parser` line.
  if (fcopReady.status === "ok") {
    const fallbackLabel =
      fcopFallbackReason === "windows_stdio_guard"
        ? "yaml fallback (Windows stdio guard)"
        : fcopFallbackReason === "no_fcop_json"
          ? "yaml fallback (no fcop/fcop.json)"
          : fcopFallbackReason === "create_failed"
            ? "yaml fallback (FcopProjectClient.create failed)"
            : "yaml fallback (no fcop client)";
    const parserMode = fcopClient ? "TaskParser=fcop" : `TaskParser=${fallbackLabel}`;
    const reviewMode = fcopClient
      ? "ReviewWriter=fcop + NeedsHumanGate fcop audit wired"
      : "ReviewWriter=yaml (no fcop client)";
    // P4 Day 4 (TASK-20260511-013): Inbox watcher gating line — same
    // transparency idiom as Day 2 `Task parser` + Day 3 `Review writer`.
    const watcherMode = fcopClient
      ? `InboxWatcher=fcop schema-gating (onValidationFail=${runtime.watcher.onValidationFail})`
      : "InboxWatcher=Day-1 pass-through (no fcop client)";
    console.log(
      `fcop bridge    : fcop ${fcopReady.fcopVersion} via pythonia ` +
        `(Python at ${fcopReady.pythonExecutable})`,
    );
    console.log(`Task parser    : ${parserMode}`);
    console.log(`Review writer  : ${reviewMode}`);
    console.log(`Inbox watcher  : ${watcherMode}`);
    if (fcopTasksDir) {
      console.log(
        `  ↳ PM→worker:     ${fcopTasksDir} (v0.3 multi-role dispatch)`,
      );
    }
    // adminTasksDir === fcopTasksDir — no separate log line needed
    if (fcopReportsDir) {
      console.log(
        `  ↳ report loop:   ${fcopReportsDir} (v0.3 loop — DEV/OPS/QA→PM→ADMIN)`,
      );
    }
  } else if (fcopReady.status === "skipped") {
    console.log(`fcop bridge    : (skipped — ${fcopReady.reason})`);
    console.log(`Task parser    : yaml fallback (no fcop client)`);
    console.log(`Review writer  : ReviewWriter=yaml (no fcop client)`);
    console.log(`Inbox watcher  : InboxWatcher=Day-1 pass-through (no fcop client)`);
  } else {
    console.log(`fcop bridge    : FAILED — see message above`);
    console.log(`Task parser    : yaml fallback`);
    console.log(`Review writer  : ReviewWriter=yaml (no fcop client)`);
    console.log(`Inbox watcher  : InboxWatcher=Day-1 pass-through (no fcop client)`);
  }
  // MT-1 friendly hint: live adapter without a default model + local
  // listScope = nothing actually wrong yet, but every task drop will
  // fail at `agent.send()` with `Local SDK agents require an explicit
  // model.` We surface that up-front instead of letting users hit it
  // after a 30-second governance loop. (BUG-SDK-001 / TASK-007 §3.5)
  const listScope = cfg.cursor.listScope ?? "local";
  const liveAdapterPicked = adapterDescription.startsWith("live ");
  if (
    liveAdapterPicked &&
    listScope === "local" &&
    !cfg.cursor.defaultModel
  ) {
    console.warn(
      "WARNING        : live SDK + local mode + no CURSOR_DEFAULT_MODEL set.",
    );
    console.warn(
      "                 First task drop will fail with 'Local SDK agents",
    );
    console.warn(
      "                 require an explicit model.' Set CURSOR_DEFAULT_MODEL",
    );
    console.warn(
      "                 in ~/.codeflowmu/v2/.env (e.g. `default`, `claude-sonnet-4`)",
    );
    console.warn(
      "                 or per-task `spec.modelId`. See README §Cursor API key.",
    );
  }
  console.log(
    `Skills loaded  : ${runtime.skillRegistry.size()} ` +
      `(${runtime.skillRegistry.list().map((s) => s.skill_id).join(", ") || "(none)"})`,
  );
  console.log(
    `MCP injector   : mode="${runtime.mcpInjector.mode}" ` +
      `(${runtime.mcpInjector.listMounted().length} agents mounted)`,
  );
  if (cfg.relay.autoConnect && cfg.relay.url && cfg.relay.roomKey) {
    console.log(
      `Relay (P3)     : ${cfg.relay.url} (room=${cfg.relay.roomKey}) — wiring deferred to v0.2.0-rc.1`,
    );
  } else {
    console.log(`Relay (P3)     : not configured (set CODEFLOW_RELAY_URL + CODEFLOW_ROOM_KEY to enable in P3)`);
  }
  if (skillResult.planted > 0) {
    console.log(
      `(planted ${skillResult.planted} fixture skill(s) on first launch)`,
    );
  }
  if (agentResult.registered > 0) {
    const src = agentResult.source === "config"
      ? `codeflowmu.team.json (${agentResult.teamName ?? "unnamed team"})`
      : "built-in default kit";
    console.log(
      `(registered ${agentResult.registered} agent(s) from ${src})`,
    );
  }
  console.log(
    `Bootstrap      : success=${runtime.bootstrap.report.success.length}, ` +
      `failed=${runtime.bootstrap.report.failed.length}, ` +
      `kernel_failures=${runtime.bootstrap.report.kernel_failures.length}`,
  );
  if (webPanel) {
    console.log(`Web panel      : ${webPanel.url}  (--no-panel or CODEFLOW_NO_PANEL=1 to skip)`);
    console.log(
      `Agent recycle  : auto=${cfg.agentRecycle.enabled ? "on" : "off"} ` +
        `(threshold=${cfg.agentRecycle.sessionThreshold}, ` +
        `interval=${Math.round(cfg.agentRecycle.checkIntervalMs / 60_000)}min, idle-only)`,
    );
    console.log(
      `Doorbell turns : max_tool_rounds=${cfg.doorbell.maxToolRounds}` +
        (cfg.doorbell.maxToolRounds === 0 ? " (unlimited)" : "") +
        ` (CODEFLOW_DOORBELL_MAX_TOOL_ROUNDS)`,
    );
  } else if (noPanel) {
    console.log(`Web panel      : disabled (--no-panel / CODEFLOW_NO_PANEL=1)`);
  } else {
    console.log(`Web panel      : failed to start (port ${_panelPort} busy?)`);
  }
  // Sprint-G: PlanScheduler + FixedTaskRunner status
  const backlog = planScheduler.getBacklog();
  const currentSprint = planScheduler.getCurrentSprint();
  console.log(
    `PlanScheduler  : ${planScheduler.getStatus().length} plan(s) loaded` +
      ` | current=${currentSprint?.id ?? "none"}` +
      ` | backlog=${backlog.length}`,
  );
  const schedule = fixedTaskRunner.getSchedule();
  console.log(
    `FixedTaskRunner: ${schedule.length} rule(s)` +
      (schedule.length > 0
        ? ` (${schedule.map((s) => s.rule.description).join(", ")})`
        : ""),
  );
  console.log(`Status         : running. Drop TASK-*-XXX-to-AGENT.md to inbox.`);
  console.log(`Stop           : Ctrl+C`);
  console.log(`PID            : ${process.pid}`);
  console.log("===========================================================");

  // ── 10. Graceful stop ──────────────────────────────────────────────
  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[shell] received ${signal}, stopping runtime...`);
    try {
      // Lane A: stop web panel before runtime (in-flight requests drain first)
      if (webPanel) {
        try { await webPanel.close(); } catch { /* non-fatal */ }
      }
      // Sprint-G: stop schedulers before runtime
      planScheduler.stop();
      fixedTaskRunner.stop();
      await runtime.stop();
      // P4 Day 1.4: tear down pythonia child Python process. Without this
      // Node would hang on shutdown because pythonia keeps a stdio-piped
      // child alive (see fcop-client.ts `__killRealPythonChildForTests`
      // JSDoc for the same hazard surfaced in tests).
      await disposeFcopBridge();
      console.log("[shell] runtime stopped cleanly. Goodbye.");
      process.exit(0);
    } catch (err) {
      console.error(
        "[shell] error during stop:",
        err instanceof Error ? err.message : err,
      );
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  
  const isTransientSdkLikeError = (value: unknown, seen = new Set<unknown>()): boolean => {
    if (value == null || seen.has(value)) return false;
    seen.add(value);
    const textParts: string[] = [];
    if (value instanceof Error) {
      textParts.push(value.name, value.message);
      const record = value as Error & {
        code?: unknown;
        rawMessage?: unknown;
        cause?: unknown;
      };
      if (record.code != null) textParts.push(String(record.code));
      if (record.rawMessage != null) textParts.push(String(record.rawMessage));
      if (record.cause != null && isTransientSdkLikeError(record.cause, seen)) return true;
    } else if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const key of ["name", "message", "code", "rawMessage"]) {
        if (record[key] != null) textParts.push(String(record[key]));
      }
      if ("cause" in record && isTransientSdkLikeError(record.cause, seen)) return true;
    } else {
      textParts.push(String(value));
    }
    const text = textParts.join(" ").toLowerCase();
    return [
      "nghttp2_enhance_your_calm",
      "enhance_your_calm",
      "stream closed",
      "aborted",
      "econnreset",
      "socket disconnected",
      "socket hang up",
      "tls connection",
      "timeout",
      "timed out",
      "fetch failed",
      "network error",
      "rate limit",
    ].some((pattern) => text.includes(pattern));
  };

  // Handle unhandled promise rejections (e.g., from Cursor SDK HTTP/2 errors)
  process.on("unhandledRejection", (reason, promise) => {
    const errorMsg = reason instanceof Error ? reason.message : String(reason);
    if (isTransientSdkLikeError(reason)) {
      // Log but don't crash — transient SDK errors should not kill the process
      console.warn(`[shell] transient SDK error (non-fatal): ${errorMsg}`);
    } else {
      console.error("[shell] unhandled rejection:", reason);
      // Don't exit — let the system continue, as this might be a background operation
    }
  });
  
  process.on("uncaughtException", (err) => {
    const errorMsg = err.message || String(err);
    if (isTransientSdkLikeError(err)) {
      // Log but don't crash
      console.warn(`[shell] transient SDK error (non-fatal): ${errorMsg}`);
    } else {
      console.error("[shell] uncaught exception:", err);
      process.exit(1);
    }
  });
}

main().catch((err) => {
  console.error("[shell] fatal:", err);
  process.exit(1);
});
