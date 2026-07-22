/**
 * Runtime — high-level composition root for the codeflowmu AI Runtime.
 *
 * Sprint S3 Phase C shipped the first 8 subsystems; Sprint S4 added
 * three more (review layer + the AgentStatusReconciler integration hook
 * resolving REPORT-018 §五决策 B'); Sprint S5 Phase E now adds three
 * more for Skill Runtime + fcop hard-dependency enforcement. The full
 * v0.1 stack is now:
 *
 *   PersistentStore (agents.json)
 *     → SkillRegistry (.codeflowmu/state/skills/)              ★ S5
 *     → KernelDependencyValidator (fcop hard-dep gate)       ★ S5
 *     → MCPInjector (stub mode v0.1)                         ★ S5
 *     → AgentRegistry (with optional kernel + mcp hooks)
 *     → RuntimeBootstrap (run once + kernel-dep gate)        ★ S5
 *     → SessionStore (per-session JSON)
 *     → TranscriptWriter (per-run markdown)
 *     → SessionManager
 *     → InboxWatcher (chokidar)
 *     → StateHistoryWriter
 *     → TaskDispatcher (glue)
 *     → ReviewWriter (.codeflowmu/state/reviews/)              ★ S4
 *     → NeedsHumanGate (v0.1 sink="cli")                     ★ S4
 *     → ReviewEngine (subscribes to SessionManager.onEvent)  ★ S4
 *     → AgentStatusReconciler (B' integration hook)          ★ S4
 *
 * Reference:
 *   - TASK-20260509-018 §主交付 5b (this file, original Phase C version)
 *   - TASK-20260509-022 §主交付 5a (this file, S4 update)
 *   - TASK-20260509-024 §主交付 5b (this file, S5 update)
 *   - design doc §0.5 + §0.7.5 (fcop hard-dep) + §0.8.3 + §10.2
 *
 * Unified execution axiom (one core, adapter slots):
 *
 *   TASK (disk) → AgentSdkAdapter slot (Cursor / Gemini / Codex / in-memory) → REPORT (disk).
 *   `_lifecycle/` is the governance view; PM dispatch is a single path (`TaskDispatcher`).
 *   Python fcop_mcp `claim_task` / `read_task` / `inspect_task` are cold-path only — not startup.
 *
 * What this file deliberately is NOT:
 *
 *   - A long-lived daemon entry point. That's `codeflowmu-shell` (S6).
 *     Runtime.ts is a building block; the daemon binary will import it
 *     and add SIGTERM/SIGINT trapping, log routing, etc.
 *   - A multi-tenant orchestrator. v0.1 = single PC, single workspace.
 *   - A CLI argument parser. Caller passes options as a typed object.
 */

import { join } from "node:path";

import { quarantineStaleReportTmps } from "./_internal/report-tmp-quarantine.ts";
import { ensureLedgerLayout } from "./ledger/paths.ts";
import type { FcopProjectClient } from "./_external/fcop-client.ts";
import { AgentRegistry } from "./registry/AgentRegistry.ts";
import type { AgentLayer } from "@codeflowmu/protocol";

import type { AgentSdkAdapter } from "./registry/AgentSdkAdapter.ts";
import { AgentStatusReconciler } from "./registry/AgentStatusReconciler.ts";
import {
  JsonFileStore,
  type PersistentStore,
} from "./registry/PersistentStore.ts";
import { RuntimeBootstrap } from "./registry/RuntimeBootstrap.ts";
import { reconcileReworkSupersededTasks } from "./lifecycle/reconcileReworkSuperseded.ts";
import {
  NeedsHumanGate,
  ReviewEngine,
  ReviewWriter,
  type ReviewPolicy,
} from "./review/index.ts";
import {
  InboxWatcher,
  LifecycleGovernor,
  lifecycleRootFromInboxDir,
  ReportDispatcher,
  ReportActionResolver,
  ReportGate,
  ReportWatcher,
  ReportWatcherSeenStore,
  StateHistoryWriter,
  TaskDispatcher,
  type TaskDispatcherLogger,
  TaskParser,
  PmQueueGuard,
} from "./scheduler/index.ts";
import { PanelEventBridge } from "./panel/PanelEventBridge.ts";
import { maybeRecordReportWriteAction } from "./logs/ActionEvidenceFromReport.ts";
import { maybeWriteEvalObservation } from "./eval/EvalObservationGenerator.ts";
import { parseMarkdownFrontmatter, strField } from "./ledger/frontmatter.ts";
import { isWorkerReportToPm } from "./fcop/governance.ts";
import { AUTO_RECOVERY_MIN_RETRY_MS } from "./pm/autoRecovery/deadlockTypes.ts";
import { runPmGovernanceCycle } from "./pm/PmGovernancePlanner.ts";
import {
  getAgentQueueApiSnapshot,
  pauseTaskExecution,
  resumeTaskExecution,
  completeAgentTaskAndAdvance,
  syncQueueOnSessionStarted,
} from "./pm/agentTaskQueueControl.ts";
import type { ReportActionOutcome } from "./scheduler/ReportActionResolver.ts";
import { sdkCooldownRegistry } from "./_internal/SdkCooldownRegistry.ts";
import { SessionManager } from "./session/SessionManager.ts";
import { SessionStore } from "./session/SessionStore.ts";
import { TranscriptWriter } from "./session/TranscriptWriter.ts";
import {
  KernelDependencyValidator,
  MCPInjector,
  SkillRegistry,
} from "./skill/index.ts";
import type { ReconciliationReport } from "./types/state.ts";

export interface RuntimeCreateOptions {
  /**
   * SDK adapter (real `CursorSdkAdapter` for production, `InMemorySdkAdapter`
   * for the Phase C E2E demo). Caller owns construction so they can plant
   * a fixture roster ahead of time.
   */
  sdkAdapter: AgentSdkAdapter;
  /**
   * Directory that owns runtime persistence (agents.json + sessions/ +
   * transcripts/). Default: `.codeflowmu/state` rooted at process.cwd().
   *
   * Sub-paths derived from this:
   *   <persistDir>/agents.json
   *   <persistDir>/sessions/<session_id>.json
   *   <persistDir>/transcripts/<run_id>.md
   */
  persistDir: string;
  /**
   * Directory the InboxWatcher monitors. Default: `fcop/_lifecycle/inbox/`
   * relative to process.cwd().
   */
  inboxDir: string;
  /**
   * Directory the `ReviewWriter` writes `REVIEW-*.md` files into.
   * Default: `<persistDir>/reviews`. Sprint S4 addition.
   */
  reviewsDir?: string;
  /**
   * Override the review policy. Default: `DefaultReviewPolicy` (always
   * review, always pick `"REVIEW"` role). Sprint S4 addition.
   */
  reviewPolicy?: ReviewPolicy;
  /**
   * Legacy session-ended review chain. Default false: session settlement
   * must not trigger ReviewEngine or move task lifecycle.
   */
  legacyReviewEngine?: boolean;
  /**
   * Directory the `SkillRegistry` scans for `<skill_id>.json` files.
   * Default: `<persistDir>/skills`. Sprint S5 addition.
   *
   * If absent or empty, the kernel-dep validator will reject every
   * non-trivial agent (no fcop@.+ resolvable) — the demo opts out of
   * this by registering only agents with `skills: []` and not wiring
   * the validator. Production deployments MUST plant at least one
   * fcop-providing skill file here before starting.
   */
  skillsDir?: string;
  /**
   * v0.1 = "stub". Setting "live" makes `Runtime.create` eager-throw
   * `MCPInjectorLiveModeNotImplementedError` — see decision T in
   * REPORT-024. Sprint S5 addition.
   */
  mcpInjectorMode?: "stub" | "live";
  /** Optional logger override forwarded to TaskDispatcher + Bootstrap. */
  logger?: TaskDispatcherLogger;
  /**
   * Optional fcop@1.1.0 client (P4 sprint Day 2 — TASK-20260511-009).
   *
   * When provided, `Runtime` wires a `TaskParser` instance configured to
   * delegate to `fcopClient.readTask(filename)` instead of doing
   * in-process YAML parsing. fcop validates the front-matter against the
   * official `task.schema` and returns a typed `FcopTask`, which the
   * parser then shapes back into codeflowmu's existing `ParsedTask`
   * interface — TaskDispatcher / SessionManager / state-history paths
   * downstream are untouched.
   *
   * When omitted (CODEFLOW_SKIP_FCOP_PROBE=1 path, unit tests, demo),
   * Runtime keeps the legacy static yaml parser. This preserves backward
   * compat with all pre-Day-2 callers and the 4 existing TaskParser
   * tests.
   */
  fcopClient?: FcopProjectClient;
  /**
   * Absolute path to the fcop tasks directory. Passed to TaskParser so it
   * skips fcopClient.readTask() for files outside the workspace (e.g. inbox
   * drops) — avoids pythonia hang on TaskNotFoundError.
   */
  fcopTasksDir?: string;
  /**
   * Additional directories to watch for incoming task files.
   *
   * Use-case: multi-role flow where PM-01 calls `write_task` (fcop-mcp)
   * and the resulting TASK-*-PM-to-DEV.md lands in `fcop/_lifecycle/inbox/` rather
   * than the primary inbox.  Listing that directory here creates a second
   * InboxWatcher + TaskDispatcher pair that funnels those files through the
   * same SessionManager and AgentRegistry, completing the
   * ADMIN → PM-01 → DEV-01 chain automatically.
   *
   * Each entry is watched with the same options as the primary inbox.
   * Added in v0.3 (multi-role sprint).
   */
  additionalInboxDirs?: string[];
  /**
   * Absolute path to fcop/reports/ directory.
   *
   * When provided, a `ReportWatcher` is wired to the default hot path:
   * REPORT arrival -> referenced active TASK -> review. PM consolidation
   * sessions are legacy behavior and require `legacyReportDispatcher=true`.
   *
   * Omitting this leaves loop closure as a manual step (operator drops
   * a task to PM-01 themselves).
   *
   * Added in v0.3 (report-triggered PM sprint).
   */
  fcopReportsDir?: string;
  /**
   * Legacy report-triggered PM consolidation sessions. Default false.
   * REPORT files still drive active -> review through LifecycleGovernor.
   */
  legacyReportDispatcher?: boolean;
  /**
   * FCoP project root (directory containing `fcop/`). Used by ReportGate for
   * Rule 6 backstop. When omitted but `fcopReportsDir` is set, derived as
   * `<fcopReportsDir>/../..`.
   */
  projectRoot?: string;
  /** Python executable for ReportGate `write_report` one-shot invoke. */
  pythonBin?: string;
  /** ADR-0002 ReportGate settle delay before blocked reciprocity (ms). Default 3000. */
  reportGateSettleDelayMs?: number;
  /** When true, ReportGate may auto write blocked/aborted REPORT on session end. Default false. */
  reportGateAutoWrite?: boolean;
  /**
   * Per-agent fcop-mcp allowlist for each `SessionManager.startSession` send.
   * Shell typically resolves `layer` → `toolsForProfile` → filtered stdio MCP.
   */
  resolveMcpServers?: (params: {
    agentId: string;
    layer: AgentLayer;
    sessionId: string;
    currentTaskId: string;
  }) => Record<string, unknown> | undefined;
  /**
   * Doorbell token guard: max SDK tool rounds per session (default 5).
   * `0` disables the limit.
   */
  sessionMaxToolRounds?: number;
  /** Active runtime provider for session-end failure classification. */
  runtimeProvider?: "cursor";
}

export interface RuntimeBootstrapResult {
  report: ReconciliationReport;
}

/**
 * Composed runtime. Opaque-ish to callers: most code only needs
 * `.start()` / `.stop()`. The public sub-systems are exposed as
 * read-only fields for tests and for the demo to register agents.
 */
export class Runtime {
  /** Reconciliation report from the constructor's RuntimeBootstrap.run(). */
  public readonly bootstrap: RuntimeBootstrapResult;

  public readonly store: PersistentStore;
  public readonly skillRegistry: SkillRegistry;
  public readonly kernelValidator: KernelDependencyValidator;
  public readonly mcpInjector: MCPInjector;
  public readonly registry: AgentRegistry;
  public readonly sessionStore: SessionStore;
  public readonly transcriptWriter: TranscriptWriter;
  public readonly sessionManager: SessionManager;
  public readonly historyWriter: StateHistoryWriter;
  public readonly watcher: InboxWatcher;
  public readonly dispatcher: TaskDispatcher;
  public readonly reviewWriter: ReviewWriter;
  public readonly needsHumanGate: NeedsHumanGate;
  public readonly reviewEngine: ReviewEngine;
  public readonly statusReconciler: AgentStatusReconciler;
  /**
   * Additional watcher+dispatcher pairs for `additionalInboxDirs`.
   * Shared with the primary SessionManager / AgentRegistry.
   * Added in v0.3 (multi-role sprint).
   */
  public readonly secondaryDispatchers: readonly TaskDispatcher[];
  /**
   * Optional report-watcher + dispatcher that closes the multi-role loop.
   * Watches fcop/reports/ for REPORT-*-{ROLE}-to-PM.md and triggers
   * a PM-01 consolidation session automatically.
   * Added in v0.3 (report-triggered PM sprint).
   */
  public readonly reportWatcher: ReportWatcher | null;
  public readonly reportDispatcher: ReportDispatcher | null;
  /** PM queue busy-state guard (panel queue bar + stale release). */
  public readonly pmQueueGuard: PmQueueGuard;
  /** FCoP lifecycle moves (inbox→active, report→review). */
  public readonly lifecycleGovernor: LifecycleGovernor;
  /** True when fcop client is absent; lifecycle still uses local YAML/filesystem moves. */
  public readonly yamlFallbackMode: boolean;
  /** Shell attaches SSE sink for governance / lifecycle panel events. */
  public readonly panelEventBridge: PanelEventBridge;
  /** Rule 6 reciprocity gate (session end → compensating REPORT). */
  public readonly reportGate: ReportGate | undefined;
  private readonly _fcopReportsDir: string | null;
  private readonly _projectRoot: string | null;
  private readonly _legacyReviewEngine: boolean;

  private constructor(parts: {
    bootstrap: RuntimeBootstrapResult;
    store: PersistentStore;
    skillRegistry: SkillRegistry;
    kernelValidator: KernelDependencyValidator;
    mcpInjector: MCPInjector;
    registry: AgentRegistry;
    sessionStore: SessionStore;
    transcriptWriter: TranscriptWriter;
    sessionManager: SessionManager;
    historyWriter: StateHistoryWriter;
    watcher: InboxWatcher;
    dispatcher: TaskDispatcher;
    reviewWriter: ReviewWriter;
    needsHumanGate: NeedsHumanGate;
    reviewEngine: ReviewEngine;
    statusReconciler: AgentStatusReconciler;
    secondaryDispatchers: TaskDispatcher[];
    reportWatcher: ReportWatcher | null;
    reportDispatcher: ReportDispatcher | null;
    pmQueueGuard: PmQueueGuard;
    lifecycleGovernor: LifecycleGovernor;
    fcopReportsDir: string | null;
    projectRoot: string | null;
    panelEventBridge: PanelEventBridge;
    reportGate?: ReportGate;
    legacyReviewEngine: boolean;
    yamlFallbackMode: boolean;
  }) {
    this.bootstrap = parts.bootstrap;
    this.store = parts.store;
    this.skillRegistry = parts.skillRegistry;
    this.kernelValidator = parts.kernelValidator;
    this.mcpInjector = parts.mcpInjector;
    this.registry = parts.registry;
    this.sessionStore = parts.sessionStore;
    this.transcriptWriter = parts.transcriptWriter;
    this.sessionManager = parts.sessionManager;
    this.historyWriter = parts.historyWriter;
    this.watcher = parts.watcher;
    this.dispatcher = parts.dispatcher;
    this.reviewWriter = parts.reviewWriter;
    this.needsHumanGate = parts.needsHumanGate;
    this.reviewEngine = parts.reviewEngine;
    this.statusReconciler = parts.statusReconciler;
    this.secondaryDispatchers = parts.secondaryDispatchers;
    this.reportWatcher = parts.reportWatcher;
    this.reportDispatcher = parts.reportDispatcher;
    this.pmQueueGuard = parts.pmQueueGuard;
    this.lifecycleGovernor = parts.lifecycleGovernor;
    this.yamlFallbackMode = parts.yamlFallbackMode;
    this.panelEventBridge = parts.panelEventBridge;
    this.reportGate = parts.reportGate;
    this._fcopReportsDir = parts.fcopReportsDir;
    this._projectRoot = parts.projectRoot;
    this._legacyReviewEngine = parts.legacyReviewEngine;
  }

  /**
   * Compose all sub-systems and run RuntimeBootstrap.
   *
   * After this resolves the runtime is "ready" but NOT yet listening for
   * inbox events — call `.start()` to engage the dispatcher.
   *
   * @throws `RuntimeBootstrapError` if `agents.json` is corrupt or
   *   `SDK.list()` fails (HARD FAIL per crash-recovery.md decision 2).
   */
  static async create(opts: RuntimeCreateOptions): Promise<Runtime> {
    const agentsJsonPath = join(opts.persistDir, "agents.json");
    const sessionsDir = join(opts.persistDir, "sessions");
    const transcriptsDir = join(opts.persistDir, "transcripts");
    const reviewsDir = opts.reviewsDir ?? join(opts.persistDir, "reviews");
    const skillsDir = opts.skillsDir ?? join(opts.persistDir, "skills");

    // --- skill layer (Sprint S5) — must come BEFORE registry so the
    //     registry's kernel-dep hook has a non-null validator. The
    //     mcpInjector ctor eager-throws on mode="live" (decision T)
    //     before any other side effect runs.
    const skillRegistry = new SkillRegistry({
      skillsDir,
      ...(opts.logger ? { logger: opts.logger } : {}),
    });
    await skillRegistry.load();
    const kernelValidator = new KernelDependencyValidator({
      skillRegistry,
      ...(opts.logger ? { logger: opts.logger } : {}),
    });
    const mcpInjector = new MCPInjector({
      skillRegistry,
      sdkAdapter: opts.sdkAdapter,
      mode: opts.mcpInjectorMode ?? "stub",
      ...(opts.logger ? { logger: opts.logger } : {}),
    });

    // --- registry layer ---
    const store = new JsonFileStore({ path: agentsJsonPath });
    const registry = new AgentRegistry({
      store,
      sdk: opts.sdkAdapter,
      kernelValidator,
      mcpInjector,
    });
    const bootstrap = new RuntimeBootstrap({
      store,
      sdk: opts.sdkAdapter,
      registry,
      kernelValidator,
      mcpInjector,
      ...(opts.projectRoot ? { expectedWorkspace: opts.projectRoot } : {}),
    });
    const report = await bootstrap.run();

    const projectRoot =
      opts.projectRoot ??
      (opts.fcopReportsDir
        ? join(opts.fcopReportsDir, "..", "..")
        : opts.fcopTasksDir
          ? join(opts.fcopTasksDir, "..", "..")
          : join(opts.inboxDir, "..", "..", ".."));

    if (projectRoot) {
      try {
        await ensureLedgerLayout(projectRoot);
      } catch (err) {
        opts.logger?.warn?.(
          `[Runtime] ensureLedgerLayout failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      try {
        const repaired = await reconcileReworkSupersededTasks(projectRoot);
        if (repaired.superseded.length > 0) {
          opts.logger?.info?.(
            `[Runtime] reconciled ${repaired.superseded.length} superseded rework task(s)`,
          );
        }
      } catch (err) {
        opts.logger?.warn?.(
          `[Runtime] rework state reconciliation failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // --- session layer ---
    const sessionStore = new SessionStore({ dir: sessionsDir });
    const transcriptWriter = new TranscriptWriter({ dir: transcriptsDir });
    const sessionManager = new SessionManager({
      registry,
      sdk: opts.sdkAdapter,
      sessionStore,
      transcriptWriter,
      ...(opts.resolveMcpServers
        ? { resolveMcpServers: opts.resolveMcpServers }
        : {}),
      ...(opts.sessionMaxToolRounds != null
        ? { sessionMaxToolRounds: opts.sessionMaxToolRounds }
        : { sessionMaxToolRounds: 100 }),
      ...(opts.fcopReportsDir ? { fcopReportsDir: opts.fcopReportsDir } : {}),
      ...(projectRoot ? { projectRoot } : {}),
      ...(opts.runtimeProvider ? { runtimeProvider: opts.runtimeProvider } : {}),
    });

    // --- scheduler layer ---
    const historyWriter = new StateHistoryWriter();
    // P4 sprint Day 4 (TASK-20260511-013): when a fcop client is supplied,
    // wire InboxWatcher with fcop schema gating (default policy
    // `dispatch_anyway` keeps Day 1 behavior; operators can override via
    // env / config when v0.5 ack queue lands). When fcopClient=null,
    // InboxWatcher stays exactly on the Day 1 code path.
    const watcher = new InboxWatcher({
      dir: opts.inboxDir,
      ...(opts.fcopClient ? { fcopClient: opts.fcopClient } : {}),
    });
    // P4 sprint Day 2: when a fcop client is supplied, wire a TaskParser
    // instance whose `.parse(filepath)` delegates to fcop's typed
    // `read_task(filename_or_id)`. Otherwise leave dispatcher on the
    // legacy static parser (back-compat + CODEFLOW_SKIP_FCOP_PROBE=1
    // escape hatch).
    const lifecycleInboxDir =
      opts.fcopTasksDir ??
      (opts.additionalInboxDirs?.[0] ?? opts.inboxDir);
    const panelEventBridge = new PanelEventBridge();
    sdkCooldownRegistry.setOnCooldown((untilMs, reason) => {
      panelEventBridge.emit("codeflowmu.sdk.cooldown", {
        active: true,
        until_ms: untilMs,
        reason,
      });
      void import("./alerts/RuntimeAlertManager.ts").then(({ runtimeAlertManager }) => {
        runtimeAlertManager.setSdkCooldown(untilMs, reason);
      });
    });

    const yamlFallbackMode = !opts.fcopClient;
    const lifecycleGovernor = new LifecycleGovernor({
      lifecycleRoot: lifecycleRootFromInboxDir(lifecycleInboxDir),
      yamlFallbackMode,
      ...(projectRoot ? { projectRoot } : {}),
      panelEvents: panelEventBridge,
      ...(opts.logger ? { logger: opts.logger } : {}),
    });

    const pmQueueGuard = new PmQueueGuard({
      ...(opts.logger
        ? {
            logger: {
              warn: (msg) => opts.logger?.warn?.(msg),
              info: (msg) => opts.logger?.info?.(msg),
            },
          }
        : {}),
      onStaleReleased: () => {
        panelEventBridge.emit("runtime.warning", {
          code: "PM_QUEUE_STALE_RELEASED",
          message: "PM queue busy released after stale timeout",
        });
      },
    });

    sessionManager.onEvent((event) => {
      const agentId = event.agent_id ?? "";
      if (!/^PM/i.test(agentId)) return;
      pmQueueGuard.touchPmEvent();
      if (event.event_type === "runtime.session_started") {
        pmQueueGuard.onPmSessionStarted(agentId);
      } else if (event.event_type === "runtime.session_ended") {
        pmQueueGuard.onPmSessionEnded(agentId, "session_ended");
      } else if (event.event_type === "runtime.session_cancelled") {
        pmQueueGuard.onPmSessionEnded(agentId, "session_cancelled");
      }
    });

    sessionManager.onEvent((event) => {
      if (!projectRoot) return;
      const agentId = String(event.agent_id ?? "").trim();
      if (!agentId || /^PM/i.test(agentId)) return;
      const payload = event.payload as { task_id?: string } | undefined;
      const taskId = String(payload?.task_id ?? "")
        .replace(/\.md$/i, "")
        .trim();
      const sessionId = String(event.session_id ?? "").trim();
      if (event.event_type === "runtime.session_started" && taskId && sessionId) {
        void syncQueueOnSessionStarted({
          projectRoot,
          agentId,
          taskId,
          sessionId,
        }).catch((err) => {
          opts.logger?.warn?.(
            `[Runtime] syncQueueOnSessionStarted failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      } else if (
        (event.event_type === "runtime.session_ended" ||
          event.event_type === "runtime.session_cancelled") &&
        taskId
      ) {
        void completeAgentTaskAndAdvance({
          projectRoot,
          agentId,
          taskId,
          sessionId: sessionId || undefined,
          dispatcher,
        }).catch((err) => {
          opts.logger?.warn?.(
            `[Runtime] completeAgentTaskAndAdvance failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }
    });

    const reportGate =
      projectRoot && opts.fcopReportsDir
        ? new ReportGate({
            projectRoot,
            fcopReportsDir: opts.fcopReportsDir,
            panelEvents: panelEventBridge,
            autoWrite: opts.reportGateAutoWrite === true,
            ...(opts.pythonBin ? { pythonBin: opts.pythonBin } : {}),
            ...(opts.reportGateSettleDelayMs != null
              ? { settleDelayMs: opts.reportGateSettleDelayMs }
              : {}),
          })
        : undefined;

    const parserOverride = opts.fcopClient
      ? (() => {
          const inst = new TaskParser({
            fcopClient: opts.fcopClient,
            fcopTasksDir: opts.fcopTasksDir,
            yamlOnly: true,
          });
          return { parse: inst.parse.bind(inst) };
        })()
      : undefined;
    // P4 sprint Day 2 (TASK-20260515-001): when a fcop client is supplied,
    // pass it to TaskDispatcher so state_history writes can be routed through
    // fcopClient.appendStateHistory() once that API lands on FcopProjectClient.
    // Until then the dispatcher falls back to the legacy StateHistoryWriter
    // path automatically (no behavior change for existing tests/deployments).
    const dispatcher = new TaskDispatcher({
      watcher,
      historyWriter,
      registry,
      sessionManager,
      lifecycleGovernor,
      yamlFallbackMode,
      panelEvents: panelEventBridge,
      pmQueueGuard,
      ...(reportGate ? { reportGate } : {}),
      ...(parserOverride ? { parser: parserOverride } : {}),
      ...(opts.fcopClient ? { fcopClient: opts.fcopClient } : {}),
      ...(opts.logger ? { logger: opts.logger } : {}),
      ...(projectRoot ? { projectRoot } : {}),
      minScheduleRetryDelayMs: AUTO_RECOVERY_MIN_RETRY_MS,
    });

    // --- review + B' integration layer (Sprint S4) ---
    // P4 sprint Day 3 (TASK-20260511-011): when a fcop client is supplied,
    // wire ReviewWriter + NeedsHumanGate to forward through fcop so the
    // review file front-matter + human-approval audit trail flow through
    // fcop@1.1.0 instead of the v0.1 YAML emitter. fcopClient=null keeps
    // the legacy YAML behavior for backward compat + skip-mode.
    const reviewWriter = new ReviewWriter({
      reviewsDir,
      ...(opts.fcopClient ? { fcopClient: opts.fcopClient } : {}),
    });
    const needsHumanGate = new NeedsHumanGate({
      sink: "cli",
      ...(opts.fcopClient ? { fcopClient: opts.fcopClient } : {}),
      ...(opts.logger ? { logger: opts.logger } : {}),
    });
    const reviewEngine = new ReviewEngine({
      sessionManager,
      registry,
      sessionStore,
      historyWriter,
      reviewWriter,
      needsHumanGate,
      inboxDir: opts.inboxDir,
      ...(opts.reviewPolicy ? { policy: opts.reviewPolicy } : {}),
      ...(opts.logger ? { logger: opts.logger } : {}),
    });
    const statusReconciler = new AgentStatusReconciler({
      sessionManager,
      registry,
      store,
      ...(opts.logger ? { logger: opts.logger } : {}),
    });

    // --- secondary watchers for additionalInboxDirs (v0.3 multi-role) ---
    // Each additional directory (e.g. fcop/_lifecycle/inbox/) gets its own
    // InboxWatcher + TaskDispatcher that share the primary SessionManager
    // and AgentRegistry.  The same fcop schema options apply so that
    // PM-01's write_task output is validated identically to primary-inbox
    // tasks dropped by ADMIN.
    const secondaryDispatchers: TaskDispatcher[] = (
      opts.additionalInboxDirs ?? []
    ).map((dir) => {
      const sw = new InboxWatcher({
        dir,
        ...(opts.fcopClient ? { fcopClient: opts.fcopClient } : {}),
      });
      return new TaskDispatcher({
        watcher: sw,
        historyWriter,
        registry,
        sessionManager,
        lifecycleGovernor,
        yamlFallbackMode,
        panelEvents: panelEventBridge,
        pmQueueGuard,
        ...(reportGate ? { reportGate } : {}),
        ...(parserOverride ? { parser: parserOverride } : {}),
        ...(opts.fcopClient ? { fcopClient: opts.fcopClient } : {}),
        ...(opts.logger ? { logger: opts.logger } : {}),
        ...(projectRoot ? { projectRoot } : {}),
        minScheduleRetryDelayMs: AUTO_RECOVERY_MIN_RETRY_MS,
      });
    });

    // --- report-watcher for task-report lifecycle closure ---
    // Default path: REPORT arrival moves the referenced active TASK to review.
    // Legacy PM consolidation sessions are opt-in via legacyReportDispatcher.
    let reportWatcher: ReportWatcher | null = null;
    let reportDispatcher: ReportDispatcher | null = null;
    let reportActionResolver: ReportActionResolver | null = null;
    if (opts.fcopReportsDir) {
      if (opts.legacyReportDispatcher === true) {
        reportDispatcher = new ReportDispatcher({
          registry,
          sessionManager,
          fcopTasksDir: opts.fcopTasksDir,
          fcopReportsDir: opts.fcopReportsDir,
          lifecycleGovernor,
          pmQueueGuard,
          ...(opts.logger ? { logger: opts.logger } : {}),
        });
      }
      reportActionResolver = new ReportActionResolver({
        projectRoot,
        lifecycleGovernor,
        panelEvents: panelEventBridge,
        ...(opts.logger ? { logger: opts.logger } : {}),
      });
      const reportSeenStore = projectRoot
        ? new ReportWatcherSeenStore(projectRoot)
        : undefined;
      reportWatcher = new ReportWatcher({
        dir: opts.fcopReportsDir,
        onIntegrityViolation: (violation) => {
          panelEventBridge.emit("codeflowmu.governance.alert", {
            event: "governance_alert",
            signal: "formal_report_modified_in_place",
            severity: "high",
            ...violation,
          });
          opts.logger?.warn?.(
            `[Runtime] formal REPORT integrity violation: ${violation.filename}`,
          );
        },
        onReport: async (evt) => {
          panelEventBridge.emit("codeflowmu.report_detected", {
            event: "report_detected",
            filepath: evt.filepath,
            filename: evt.filename,
            sender_role: evt.senderRole,
          });
          if (projectRoot) {
            maybeRecordReportWriteAction({
              projectRoot,
              filepath: evt.filepath,
              filename: evt.filename,
              senderRole: evt.senderRole,
              content: evt.content,
            });
          }
          const outcome = await reportActionResolver!.resolve(evt.filepath);
          const reportFm = parseMarkdownFrontmatter(evt.content) as Record<
            string,
            unknown
          >;
          const isWorkerToPmReport = isWorkerReportToPm(
            evt.filename,
            strField(reportFm, "sender"),
            strField(reportFm, "recipient"),
          );
          const pmReviewOutcomes: ReportActionOutcome[] = [
            "submitted",
            "reconciled",
            "noop",
          ];
          if (projectRoot && isWorkerToPmReport && pmReviewOutcomes.includes(outcome)) {
            const reportTaskId = strField(reportFm, "task_id").replace(/\.md$/i, "").trim();
            const reporterRole = strField(reportFm, "sender").toUpperCase();
            if (reportTaskId && reporterRole) {
              const agents = await registry.list({ role: reporterRole });
              const agentId = agents[0]?.protocol.agent_id;
              if (agentId) {
                void completeAgentTaskAndAdvance({
                  projectRoot,
                  agentId,
                  taskId: reportTaskId,
                  dispatcher,
                }).catch((err) => {
                  opts.logger?.warn?.(
                    `[Runtime] agent queue advance on report failed: ${
                      err instanceof Error ? err.message : String(err)
                    }`,
                  );
                });
              }
            }
          }
          if (
            projectRoot &&
            isWorkerToPmReport &&
            pmReviewOutcomes.includes(outcome)
          ) {
            await pmQueueGuard
              .runGuarded(
                "governance:report_arrival",
                () =>
                  runPmGovernanceCycle(projectRoot, {
                    triggered_by: "report_arrival",
                    max_threads: 3,
                    max_judgments: 5,
                    allow_auto_wake: false,
                    auto_review: true,
                  }),
                "completed",
              )
              .catch((err) => {
              opts.logger?.warn?.(
                `[Runtime] runPmGovernanceCycle(report_arrival) failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });
          }
          const isPmToAdminReport =
            /^REPORT-\d{8}-\d{3,}-PM-to-ADMIN(-[a-z][a-z0-9-]*)?\.md$/i.test(
              evt.filename,
            );
          if (projectRoot && isPmToAdminReport) {
            const pmFm = reportFm;
            await maybeWriteEvalObservation({
              projectRoot,
              pmReportPath: evt.filepath,
              pmReportFilename: evt.filename,
              pmReportContent: evt.content,
              pmReportFm: pmFm,
            }).catch((err) => {
              opts.logger?.warn?.(
                `[Runtime] maybeWriteEvalObservation failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });
          }
          if (reportDispatcher && !isPmToAdminReport) {
            if (outcome !== "submitted" && outcome !== "noop") return;
            await reportDispatcher.handle(evt);
            return;
          }
        },
        ...(reportSeenStore ? { seenStore: reportSeenStore } : {}),
        ...(opts.logger ? { logger: opts.logger } : {}),
      });
    }

    return new Runtime({
      bootstrap: { report },
      store,
      skillRegistry,
      kernelValidator,
      mcpInjector,
      registry,
      sessionStore,
      transcriptWriter,
      sessionManager,
      historyWriter,
      watcher,
      dispatcher,
      reviewWriter,
      needsHumanGate,
      reviewEngine,
      statusReconciler,
      secondaryDispatchers,
      reportWatcher,
      reportDispatcher,
      pmQueueGuard,
      lifecycleGovernor,
      fcopReportsDir: opts.fcopReportsDir ?? null,
      projectRoot: projectRoot ?? null,
      panelEventBridge,
      ...(reportGate ? { reportGate } : {}),
      legacyReviewEngine: opts.legacyReviewEngine === true,
      yamlFallbackMode,
    });
  }

  /**
   * Start the dispatcher (which starts the watcher under the hood) plus
   * the review engine + status reconciler. Subscribers are wired in this
   * order:
   *
   *   1. AgentStatusReconciler (so session_started promotes status BEFORE
   *      the dispatcher's listener can pick up the next dropped task)
   *   2. ReviewEngine          (subject session_ended → reviewer flow)
   *   3. TaskDispatcher        (inbox → startSession)
   *
   * Sprint S4: order matters for correctness — the reconciler must be
   * up first so the doorbell `reject_busy` path is reachable.
   */
  async start(): Promise<void> {
    // Crash-recovery: reset any orphaned "running" agents BEFORE subscribing
    // to new session events — ensures a clean slate after unexpected exits.
    const recovered = await this.statusReconciler.recoverOrphans();
    if (recovered.length > 0) {
      console.warn(
        `[Runtime] crash-recovery: reset ${recovered.length} orphaned agent(s) to idle: ${recovered.join(", ")}`,
      );
    }

    this.statusReconciler.start();
    if (this._legacyReviewEngine) {
      this.reviewEngine.start();
    }
    await this.dispatcher.start();
    for (const sd of this.secondaryDispatchers) {
      await sd.start();
    }
    if (this._fcopReportsDir) {
      const projectRoot = join(this._fcopReportsDir, "..", "..");
      await quarantineStaleReportTmps(this._fcopReportsDir, projectRoot, {
        info: (msg) => console.info(msg),
        warn: (msg) => console.warn(msg),
      });
    }
    if (this.reportWatcher) {
      await this.reportWatcher.start();
    }
    if (this._fcopReportsDir) {
      this.lifecycleGovernor.reconcileStuckPmOutboundReports(
        this._fcopReportsDir,
      );
    }
    this.pmQueueGuard.startStaleWatch();
  }

  /**
   * Force-release an agent: cancel its running sessions, wait for status
   * reconciliation, then verify registry is no longer `running`.
   */
  get projectRoot(): string | null {
    return this._projectRoot;
  }

  async getAgentQueueSnapshot(): Promise<
    Awaited<ReturnType<typeof getAgentQueueApiSnapshot>> | null
  > {
    if (!this._projectRoot) return null;
    return getAgentQueueApiSnapshot(this._projectRoot);
  }

  async pauseTask(
    taskId: string,
    agentId: string,
    opts?: { pausedBy?: string; pauseReason?: string },
  ): Promise<Awaited<ReturnType<typeof pauseTaskExecution>>> {
    if (!this._projectRoot) {
      return {
        ok: false,
        task_id: taskId,
        agent_id: agentId,
        error: "no_project_root",
      };
    }
    return pauseTaskExecution({
      projectRoot: this._projectRoot,
      taskId,
      agentId,
      pausedBy: opts?.pausedBy,
      pauseReason: opts?.pauseReason,
      sessionManager: this.sessionManager,
      forceReleaseAgent: (id, reason) => this.forceReleaseAgent(id, reason),
      dispatcher: this.dispatcher,
    });
  }

  async resumeTask(
    taskId: string,
    opts?: { priority?: boolean },
  ): Promise<Awaited<ReturnType<typeof resumeTaskExecution>>> {
    if (!this._projectRoot) {
      return { ok: false, task_id: taskId, error: "no_project_root" };
    }
    return resumeTaskExecution({
      projectRoot: this._projectRoot,
      taskId,
      priority: opts?.priority,
      dispatcher: this.dispatcher,
      registry: this.registry,
    });
  }

  async forceReleaseAgent(
    agentId: string,
    reason: string,
  ): Promise<{
    ok: boolean;
    agent_id: string;
    cancelled: string[];
    failed: { session_id: string; reason: string }[];
    status?: string;
    error?: string;
  }> {
    const result =
      await this.sessionManager.cancelRunningSessionsForAgent(
        agentId,
        reason,
      );

    if (result.failed.length > 0) {
      return {
        ok: false,
        agent_id: agentId,
        cancelled: result.cancelled,
        failed: result.failed,
        error: "SESSION_CANCEL_FAILED",
      };
    }

    await this.statusReconciler.whenSettled();

    const record = await this.registry.get(agentId);
    const status = record?.protocol.status;

    if (status === "running") {
      return {
        ok: false,
        agent_id: agentId,
        cancelled: result.cancelled,
        failed: result.failed,
        status,
        error: "AGENT_STILL_RUNNING",
      };
    }

    return {
      ok: true,
      agent_id: agentId,
      cancelled: result.cancelled,
      failed: [],
      status,
    };
  }

  /**
   * Gracefully stop everything in reverse order. Does NOT cancel running
   * sessions — callers wanting that should call
   * `runtime.sessionManager.cancelAllForEmergencyStop()` first.
   */
  async stop(): Promise<void> {
    this.pmQueueGuard.stopStaleWatch();
    if (this.reportWatcher) {
      await this.reportWatcher.stop();
    }
    for (const sd of this.secondaryDispatchers) {
      await sd.stop();
    }
    await this.dispatcher.stop();
    await this.reviewEngine.stop();
    await this.statusReconciler.stop();
  }
}

