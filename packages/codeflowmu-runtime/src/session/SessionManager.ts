/**
 * SessionManager — the runtime's process-scheduler analogue at the
 * session layer. Owns the question "which agent is running which task
 * via which run, and how do we drive / cancel / observe it".
 *
 * Sprint S2 shipped only the surface (every method threw
 * `[S2 skeleton]`). Sprint S3 Phase B (TASK-20260509-013 §主交付 1)
 * ships the full implementation. This file replaces the S2 throws but
 * keeps the surface contract — JSDoc invariants are unchanged.
 *
 * Reference:
 * - design doc `docs/design/codeflowmu-v2-on-fcop-sdk.md` §2.1 subsystem 1,
 *   §3.5 Session Schema, §0.9.5 Mobile Emergency Stop
 * - TASK-20260509-013 §主交付 1 (six method specs)
 * - crash-recovery.md decision 4 (transcript split)
 */

import type { AgentLayer, Session, SessionRun } from "@codeflowmu/protocol";
import { dirname, join } from "node:path";

import type { AgentRegistry } from "../registry/AgentRegistry.ts";
import type {
  AgentRunMode,
  AgentSdkAdapter,
  AgentSendSpec,
} from "../registry/AgentSdkAdapter.ts";
import {
  extractTaskIdPrefixFromFilepath,
  normalizeWriteReportTaskIdPrefix,
} from "../registry/writeReportTaskIdGuard.ts";
import {
  applyThinkingLanguageToPrompt,
  readPanelUiLang,
  type UiLang,
} from "../panel/PanelUiLang.ts";
import {
  AgentNotFoundError,
  InvalidAgentStatusError,
  SessionNotFoundError,
} from "../registry/errors.ts";
import type {
  RunHandle,
  RuntimeEvent,
  SessionRecord,
  Unsubscribe,
} from "../types/state.ts";
import { maybeRecordActionEvidenceFromToolCall } from "../logs/ActionEvidenceFromToolCall.ts";
import type { SessionStore } from "./SessionStore.ts";
import { SessionLeaseStore } from "./SessionLeaseStore.ts";
import type { TranscriptWriter } from "./TranscriptWriter.ts";
import {
  isTransientSdkError,
  TRANSIENT_SDK_DELAYED,
  TransientSdkDelayedError,
  withTransientSdkRetry,
} from "../_internal/transient-sdk-error.ts";
import {
  findReportForTaskOnDisk,
  findReportPathForTaskOnDisk,
  roleFromAgentId,
} from "../_internal/report-reconcile.ts";
import { normalizeSessionEndReason } from "../_internal/session-end-reason.ts";
import { agentSdkMutex } from "../_internal/KeyedMutex.ts";
import {
  sdkCooldownRegistry,
} from "../_internal/SdkCooldownRegistry.ts";
import { isAgentNotFoundLike } from "../registry/verifiedSdkBinding.ts";
import {
  rebuildSdkFailureForSessionEnd,
  type SessionRunWithSdkFailure,
} from "./sdk-failure-classifier.ts";


/**
 * Payload passed into `Agent.send()` for a freshly started session.
 *
 * S2 leaves this loosely typed — concrete payload schema is part of S3
 * Task Scheduler design (the bridge from `Task.md` front-matter to the
 * SDK send call). For Phase B we just need a name to thread through.
 */
export interface SessionStartPayload {
  /** Plain text body sent to the SDK (Task.md body, typically). */
  text: string;
  /**
   * Optional structured context (schema decided in Phase C). MUST NOT
   * carry any FCoP protocol field as a top-level key; protocol fields
   * live in `Task` proper, which is referenced via `task_id`, not
   * duplicated here.
   */
  context?: Record<string, unknown>;
  /** Override doorbell default for this session only (e.g. light patrol = 4). */
  maxToolRounds?: number;
  /** Multimodal images forwarded to SDK send (runtime-only, not from TASK yaml). */
  images?: import("../registry/AgentSdkAdapter.ts").SessionSdkImage[];
  /** Panel UI language for this session. Falls back to persisted project setting. */
  uiLang?: UiLang;
}

/** Result of `cancelAllForEmergencyStop()`. */
export interface EmergencyStopResult {
  /** The session_ids that were running and got cancelled. */
  cancelled: string[];
  /**
   * Sessions that failed to cancel cleanly (e.g. SDK call timed out).
   * In v0.1 these are surfaced for the operator to investigate; the
   * runtime does NOT retry automatically (that's S6+ behavior).
   */
  failed_to_cancel: { session_id: string; reason: string }[];
}

/** Constructor options for `SessionManager`. */
export interface SessionManagerOptions {
  /** AgentRegistry — for `get(agentId)` agent lookup. */
  registry: AgentRegistry;
  /** SDK adapter — `send` is the only method SessionManager calls. */
  sdk: AgentSdkAdapter;
  /** Persistence layer for SessionRecord. */
  sessionStore: SessionStore;
  /** Transcript layer (decision 4 right-half). */
  transcriptWriter: TranscriptWriter;
  /** Cross-process lease store; defaults beside the session store. */
  leaseStore?: SessionLeaseStore;
  /**
   * ID minter for new `session_id`s. Default = monotonic `session-mem-N`.
   * Tests inject a deterministic minter to make assertions readable.
   */
  newSessionId?: () => string;
  /** Wall clock; tests inject a controlled clock. */
  now?: () => Date;
  /**
   * Optional per-agent MCP config for each `send()`. When provided,
   * `SessionManager` passes the result as `AgentSendSpec.mcpServers`,
   * overriding any adapter-level default (fcop-mcp tool allowlist by layer).
   */
  resolveMcpServers?: (params: {
    agentId: string;
    layer: AgentLayer;
    sessionId: string;
    currentTaskId: string;
  }) => Record<string, unknown> | undefined;
  /**
   * Max SDK `tool_call` rounds per doorbell session (default 5).
   * Omit / undefined = adapter default; set `0` to disable limit.
   */
  sessionMaxToolRounds?: number;
  /** fcop/reports/ — reconcile session outcome against on-disk REPORT. */
  fcopReportsDir?: string;
  /** Project root — scan _lifecycle/review|done for REPORT files. */
  projectRoot?: string;
  /**
   * Active runtime provider — selects failure classifier on session end.
   * Default `cursor` for backward compatibility.
   */
  runtimeProvider?: "cursor";
}

/**
 * SessionHandle — short-lived handle returned by `startSession`.
 *
 * Encapsulates the active RunHandle for callers that want to cancel /
 * await without going through the SessionManager again. The persisted
 * form remains `SessionRecord`.
 */
export interface SessionHandle {
  readonly session_id: string;
  readonly agent_id: string;
  readonly task_id: string;
  /** The currently in-flight run, if any. */
  readonly activeRun: RunHandle | null;
  /** Convenience: latest snapshot of the persisted record. */
  snapshot(): Promise<SessionRecord>;
}

let _sessionSeq = 0;
function defaultMintSessionId(): string {
  // Pattern `^session-[a-z0-9-]+$` (per Session.session_id schema regex).
  return `session-${(++_sessionSeq).toString(36)}-${Date.now().toString(36)}`;
}

const ALLOWED_START_STATUSES: readonly Session["status"][] = [
  // §3.5 SessionStatus = running | completed | failed | cancelled
  // — we do NOT treat any of those as legal "start" states. The check
  // operates on Agent.status (idle | running | error) per §3.2.
];

const ALLOWED_AGENT_START_STATUSES: readonly string[] = ["idle", "error"];

/**
 * SessionManager — central coordinator for agent×task×run sessions.
 *
 * Lifecycle (Phase B impl):
 *
 * 1. `startSession(agentId, taskId, payload)` → resolve agent record →
 *    `_sdk.send(sdk_agent_id, payload)` → wrap in `SessionHandle` +
 *    persist `SessionRecord` + attach `TranscriptWriter`.
 * 2. `getSession(sessionId)` / `listActive()` → store-backed query.
 * 3. `cancelSession(sessionId, reason)` → SDK `run.cancel()` first,
 *    then update SessionRecord + transcript line + emit
 *    `runtime.session_cancelled`.
 * 4. `cancelAllForEmergencyStop()` → §0.9.5 red button: cancel everything
 *    via `Promise.allSettled` (one failing cancel does NOT block peers).
 * 5. `onEvent(handler)` → subscribe to all 12 RuntimeEventType (see
 *    decision M for the spike-aligned 8 sdk.* + 4 runtime.* set).
 *
 * Invariants enforced at this layer (TASK-013 §"关键不变量"):
 *
 * - `startSession` validates agent record + agent status BEFORE calling
 *   the SDK (so a rejected attempt costs no SDK quota).
 * - `cancelSession` calls SDK `run.cancel()` BEFORE updating the store
 *   ("取消生效" 先于 "持久化记录").
 * - `cancelAllForEmergencyStop` continues even when individual cancels
 *   fail — `Promise.allSettled` semantics.
 * - All transcript writes go through `TranscriptWriter`; SessionManager
 *   never writes a transcript file directly.
 * - Errors are named classes (Phase A `errors.ts` + Phase B additions).
 */
export class SessionManager {
  private readonly _opts: SessionManagerOptions;
  private readonly _registry: AgentRegistry;
  private readonly _sdk: AgentSdkAdapter;
  private readonly _sessionStore: SessionStore;
  private readonly _transcriptWriter: TranscriptWriter;
  private readonly _leaseStore: SessionLeaseStore;
  private readonly _leaseHeartbeats = new Map<string, NodeJS.Timeout>();
  private readonly _now: () => Date;
  private readonly _newSessionId: () => string;
  private readonly _activeRuns = new Map<string, RunHandle>();
  /** session_id → task_id for action evidence on sdk.tool_call events. */
  private readonly _sessionTaskIds = new Map<string, string>();
  private readonly _sessionThreadKeys = new Map<string, string>();
  /**
   * Promise per-session for the post-settle "natural settle" pipeline
   * (run.whenSettled → store.save(status=completed/failed) → emit
   * session_ended). Tests `await` this to deterministically observe the
   * end state without having to chain `setImmediate`s.
   *
   * Public via `awaitSettled(sessionId)` — kept private here so the
   * field is the test seam, the method is the explicit API.
   */
  private readonly _settlementChain = new Map<string, Promise<void>>();
  private readonly _eventListeners = new Set<
    (event: RuntimeEvent) => void
  >();

  constructor(opts: SessionManagerOptions) {
    this._opts = opts;
    this._registry = opts.registry;
    this._sdk = opts.sdk;
    this._sessionStore = opts.sessionStore;
    this._transcriptWriter = opts.transcriptWriter;
    this._leaseStore = opts.leaseStore ?? new SessionLeaseStore({
      dir: join(dirname(opts.sessionStore.dir), "leases"),
    });
    this._now = opts.now ?? (() => new Date());
    this._newSessionId = opts.newSessionId ?? defaultMintSessionId;
    void this._opts; // retained for future-deprecation diagnostics
    void ALLOWED_START_STATUSES; // retained as a documentation anchor
  }

  /**
   * Start a new agent×task session. See class doc for full lifecycle.
   *
   * @throws `AgentNotFoundError` if `agentId` is unknown to the registry.
   * @throws `InvalidAgentStatusError` if the agent is not in `{idle, error}`.
   * @throws on SDK `send` failure — bubbled with the SDK adapter's
   *   translation already applied.
   */
  async startSession(
    agentId: string,
    taskId: string,
    payload: SessionStartPayload,
  ): Promise<SessionHandle> {
    taskId = normalizeWriteReportTaskIdPrefix(taskId) || taskId;
    // Step (a): resolve agent record.
    const record = await this._registry.get(agentId);
    if (!record) {
      throw new AgentNotFoundError(agentId);
    }

    // Step (b): validate agent status. Phase B = serial sessions per agent.
    const status = record.protocol.status;
    if (await this._isStartBlocked(agentId, status)) {
      throw new InvalidAgentStatusError(
        agentId,
        status,
        ALLOWED_AGENT_START_STATUSES,
      );
    }

    const sdkAgentId = record.protocol.sdk_agent_id;
    if (!sdkAgentId) {
      throw new InvalidAgentStatusError(
        agentId,
        `(no sdk_agent_id; status="${status}")`,
        ALLOWED_AGENT_START_STATUSES,
      );
    }

    return agentSdkMutex.run(sdkAgentId, async () => {
      sdkCooldownRegistry.assertNotPaused(`startSession(${agentId})`);
      const freshRecord = await this._registry.get(agentId);
      if (!freshRecord) {
        throw new AgentNotFoundError(agentId);
      }
      const freshStatus = freshRecord.protocol.status;
      if (await this._isStartBlocked(agentId, freshStatus)) {
        throw new InvalidAgentStatusError(
          agentId,
          freshStatus,
          ALLOWED_AGENT_START_STATUSES,
        );
      }

    // Step (c): mint identifiers + call SDK.send.
    const sessionId = this._newSessionId();
    const startedAt = this._now().toISOString();

    const context = payload.context ?? {};
    const canonicalRootTaskId = String(
      context.canonical_root_task_id ?? context.root_task_id ?? taskId,
    ).trim();
    const fallbackProjectId = this._opts.projectRoot
      ? this._opts.projectRoot.replace(/[\\/]+$/, "").split(/[\\/]/).pop()
      : undefined;
    const projectId = String(context.project_id ?? fallbackProjectId ?? "project").trim();
    await this._leaseStore.acquire({
      project_id: projectId,
      agent_id: agentId,
      canonical_root_task_id: canonicalRootTaskId,
    }, sessionId);
    this._startLeaseHeartbeat(sessionId);

    let mcpServers: Record<string, unknown> | undefined;
    try {
      mcpServers = this._opts.resolveMcpServers?.({
        agentId,
        layer: freshRecord.protocol.layer,
        sessionId,
        currentTaskId: canonicalRootTaskId,
      });
    } catch (error) {
      await this._releaseLease(sessionId);
      throw error;
    }

    const maxToolRounds =
      payload.maxToolRounds != null && payload.maxToolRounds > 0
        ? payload.maxToolRounds
        : this._opts.sessionMaxToolRounds;

    const projectRoot = this._opts.projectRoot;
    let sessionText = payload.text;
    let uiLang: UiLang | undefined;
    uiLang = payload.uiLang;
    if (!uiLang && projectRoot) {
      uiLang = readPanelUiLang(projectRoot);
    }
    if (uiLang) {
      sessionText = applyThinkingLanguageToPrompt(payload.text, uiLang);
    }

    const ctx = payload.context;
    const taskFilepath =
      typeof ctx?.task_filepath === "string" ? ctx.task_filepath : undefined;
    const frontmatter =
      ctx?.frontmatter && typeof ctx.frontmatter === "object"
        ? (ctx.frontmatter as Record<string, unknown>)
        : undefined;
    const frontmatterTaskId =
      typeof frontmatter?.task_id === "string"
        ? frontmatter.task_id
        : undefined;
    const ctxPinned =
      typeof ctx?.pinned_task_id === "string" ? ctx.pinned_task_id : undefined;
    const pmSelfReportOnly = ctx?.pm_self_report_only === true;
    const pinnedFromSession =
      normalizeWriteReportTaskIdPrefix(ctxPinned) ||
      normalizeWriteReportTaskIdPrefix(taskId) ||
      extractTaskIdPrefixFromFilepath(taskFilepath) ||
      normalizeWriteReportTaskIdPrefix(frontmatterTaskId) ||
      undefined;
    const runMode: AgentRunMode | undefined = pmSelfReportOnly
      ? "pm_self_report_only"
      : undefined;

    const sendSpec: AgentSendSpec = {
      sessionId,
      agentId,
      text: sessionText,
      ...(pinnedFromSession ? { pinnedTaskId: pinnedFromSession } : {}),
      ...(taskFilepath ? { taskFilepath } : {}),
      ...(frontmatterTaskId ? { frontmatterTaskId } : {}),
      ...(runMode ? { runMode } : {}),
      ...(freshRecord.protocol.model?.id !== undefined
        ? { modelId: freshRecord.protocol.model.id }
        : {}),
      ...(mcpServers
        ? { mcpServers: mcpServers as AgentSendSpec["mcpServers"] }
        : {}),
      ...(maxToolRounds != null && maxToolRounds > 0
        ? { maxToolRounds }
        : {}),
      ...(payload.images && payload.images.length > 0
        ? { images: payload.images }
        : {}),
      ...(projectRoot ? { workspace: projectRoot } : {}),
      ...(uiLang ? { uiLang } : {}),
    };
    const sendWithTransientRetry = (bindingId: string) =>
      withTransientSdkRetry(
        () => this._sdk.send(sendSpec, bindingId),
        {
          onRetry: (attempt, delayMs, error) =>
            this._emitTransientSdkStatus(
              sessionId,
              agentId,
              null,
              attempt,
              delayMs,
              error,
            ),
        },
      );
    let sendResult;
    try {
      try {
        sendResult = await sendWithTransientRetry(sdkAgentId);
      } catch (err) {
        if (!isAgentNotFoundLike(err)) throw err;
        const recovered = await this._registry.recoverSdkBinding(
          agentId,
          projectRoot,
        );
        const recoveredId = recovered.protocol.sdk_agent_id;
        if (!recoveredId) {
          throw new AgentNotFoundError(`${agentId} (recovery returned no sdk_agent_id)`);
        }
        sendResult = await sendWithTransientRetry(recoveredId);
      }
    } catch (error) {
      await this._releaseLease(sessionId);
      throw error;
    }
    if (!sendResult.ok) {
      await this._releaseLease(sessionId);
      throw new TransientSdkDelayedError(
        sendResult.lastError.message,
        sendResult.lastError,
      );
    }
    const handle = sendResult.value;

    this._activeRuns.set(sessionId, handle);

    // Step (d): construct SessionRecord with the in-flight run.
    const sessionProto: Session = {
      session_id: sessionId,
      agent_id: agentId,
      task_id: taskId,
      started_at: startedAt,
      ended_at: null,
      status: "running",
      runs: [
        {
          run_id: handle.run_id,
          started_at: startedAt,
          ended_at: null,
          status: "running",
          tool_calls_count: 0,
        },
      ],
    };
    const sessionRecord: SessionRecord = {
      protocol: sessionProto,
      runtime_last_event_at: startedAt,
      runtime_active_run_id: handle.run_id,
      ...(typeof payload.context?.trigger_chat_id === "string"
        ? { runtime_trigger_chat_id: payload.context.trigger_chat_id }
        : {}),
      ...(typeof payload.context?.thread_key === "string"
        ? { runtime_thread_key: payload.context.thread_key }
        : {}),
      runtime_root_task_id: canonicalRootTaskId,
    };

    // Step (e): attach TranscriptWriter + bridge events to onEvent fan-out
    // BEFORE awaiting the persistence write. The SDK Run can start
    // streaming events any time after `send()` returned the handle; if
    // we awaited persistence first, those early events would race into
    // a void on fast SDK paths (the in-memory test mock makes this race
    // observable: a `setImmediate`-scheduled emit would land DURING the
    // fs-IO macrotask of `sessionStore.save` and find zero listeners).
    //
    // If `save` fails, the transcript file is harmless (orphan one-line
    // header), the handle.onEvent listener is harmless (manager's
    // dispatcher fans out to listeners that don't care about the record
    // either), and `_activeRuns` is rolled back. The Phase A
    // `RegistryWriteError` semantics still apply: original on-disk
    // state is untouched on a failed atomic write.
    this._transcriptWriter.attach(handle.run_id, handle);
    handle.onEvent((event) => this._dispatchToListeners(event));

    // Step (f): persist. If this throws, roll back the in-memory state.
    try {
      await this._sessionStore.save(sessionRecord);
    } catch (saveErr) {
      this._sessionTaskIds.delete(sessionId);
      this._activeRuns.delete(sessionId);
      // Best-effort: close transcript so the file ends gracefully.
      await this._transcriptWriter.close(handle.run_id).catch(() => undefined);
      // Best-effort: cancel the SDK run so we don't leak a runaway agent.
      await handle.cancel("startSession persistence failed").catch(() => undefined);
      await this._releaseLease(sessionId);
      throw saveErr;
    }

    this._sessionTaskIds.set(sessionId, taskId);
    if (typeof payload.context?.thread_key === "string" && payload.context.thread_key.trim()) {
      this._sessionThreadKeys.set(sessionId, payload.context.thread_key.trim());
    }

    // Emit runtime.session_started after everything is durable.
    this._emit({
      event_id: `${sessionId}-started`,
      at: startedAt,
      event_type: "runtime.session_started",
      session_id: sessionId,
      run_id: handle.run_id,
      agent_id: agentId,
      payload: {
        task_id: taskId,
        ...(typeof payload.context?.trigger_chat_id === "string"
          ? { trigger_chat_id: payload.context.trigger_chat_id }
          : {}),
        ...(typeof payload.context?.thread_key === "string"
          ? { thread_key: payload.context.thread_key }
          : {}),
      },
    });

    // Step (g): wire settlement to update record.status when the run ends
    // naturally (success / failure). cancelSession drives the cancelled
    // path explicitly — see invariants. The settlement chain is exposed
    // via `awaitSettled(sessionId)` so callers (and tests) can observe
    // end state without polling.
    //
    // RACE-CONDITION DEFENCE: We wrap the whenSettled chain inside a
    // `setImmediate` callback.  In tests that use InMemoryRunHandle, the
    // `_settled` promise can already be resolved by the time startSession
    // reaches this step (the auto-drive fires through `setImmediate` in
    // InMemoryRunHandle, which can complete before every `await` inside
    // startSession fully unwinds).  When `_settled` is already resolved,
    // calling `.then(_handleNaturalSettle)` immediately schedules a
    // *microtask*; that microtask executes before the caller of
    // startSession (TaskDispatcher._dispatch) has a chance to register
    // its `onEvent` listener — so the `runtime.session_ended` event fires
    // into the void and the state-history append never happens.
    //
    // Wrapping in `setImmediate` (a macrotask) defers the entire
    // settlement chain until after the current microtask queue and the
    // surrounding `await startSession(...)` continuation in _dispatch
    // have both completed, giving the caller a guaranteed window to attach
    // its listener first.  This is safe for real SDK runs because the
    // SDK's own whenSettled() only resolves after the LLM run ends (many
    // seconds later) — the extra tick is imperceptible.
    const settlementChain = new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        void (async () => {
          try {
            const settledRun = await handle.whenSettled();
            await this._handleNaturalSettle(sessionId, settledRun);
            resolve();
          } catch (err) {
            const settleErr =
              err instanceof Error ? err : new Error(String(err));
            try {
              if (isTransientSdkError(settleErr)) {
                await this._handleNaturalSettle(
                  sessionId,
                  {
                    run_id: handle.run_id,
                    started_at: startedAt,
                    ended_at: this._now().toISOString(),
                    status: "finished",
                    tool_calls_count: 0,
                    failure_code: TRANSIENT_SDK_DELAYED,
                  },
                  settleErr,
                );
              } else {
                await this._handleNaturalSettle(
                  sessionId,
                  {
                    run_id: handle.run_id,
                    started_at: startedAt,
                    ended_at: this._now().toISOString(),
                    status: "failed",
                    tool_calls_count: 0,
                  },
                  settleErr,
                );
              }
              resolve();
            } catch (inner) {
              reject(inner instanceof Error ? inner : new Error(String(inner)));
            }
          } finally {
            this._settlementChain.delete(sessionId);
          }
        })().catch((err) => {
          this._settlementChain.delete(sessionId);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      });
    });
    this._settlementChain.set(sessionId, settlementChain);

    // Construct the handle returned to the caller. snapshot() always
    // re-loads from the store so the caller sees the latest persisted
    // state (e.g. after a cancel-in-flight).
    const self = this;
    const returned: SessionHandle = {
      session_id: sessionId,
      agent_id: agentId,
      task_id: taskId,
      get activeRun() {
        return self._activeRuns.get(sessionId) ?? null;
      },
      async snapshot() {
        const r = await self._sessionStore.load(sessionId);
        if (!r) {
          throw new SessionNotFoundError(sessionId);
        }
        return r;
      },
    };
    return returned;
    });
  }

  /**
   * Single-record lookup by `session_id`. Returns `null` for absent —
   * does NOT throw (symmetric with `AgentRegistry.get`).
   */
  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this._sessionStore.load(sessionId);
  }

  /**
   * List sessions whose `protocol.status === "running"`.
   *
   * Backed by `SessionStore.listAll` so we always reflect on-disk truth
   * (no in-memory cache that can drift across SessionManager restarts).
   */
  async listActive(): Promise<SessionRecord[]> {
    const all = await this._sessionStore.listAll();
    return all.filter((r) => r.protocol.status === "running");
  }

  private async _isStartBlocked(
    agentId: string,
    status: string,
  ): Promise<boolean> {
    if (ALLOWED_AGENT_START_STATUSES.includes(status)) {
      return false;
    }
    if (status !== "running") {
      return true;
    }
    const active = await this.listActive();
    return active.some((session) => session.protocol.agent_id === agentId);
  }

  /**
   * Graceful cancellation of a running session.
   *
   * Order is invariant (TASK-013 §"关键不变量"):
   *   1. SDK cancel  ← actually stops the run
   *   2. Append cancel-reason to transcript
   *   3. Update SessionRecord.status = "cancelled" + persist
   *   4. Emit `runtime.session_cancelled`
   *
   * Idempotent — calling twice succeeds; the second call is a no-op
   * + warning-line in the transcript.
   *
   * @throws `SessionNotFoundError` if the session is not in the store.
   */
  async cancelSession(sessionId: string, reason: string): Promise<void> {
    const record = await this._sessionStore.load(sessionId);
    if (!record) {
      throw new SessionNotFoundError(sessionId);
    }

    // Idempotency: already-terminal sessions get a transcript note + return.
    if (record.protocol.status !== "running") {
      const handle = this._activeRuns.get(sessionId);
      if (handle) {
        // best-effort detach; transcript may already be closed
        await this._transcriptWriter
          .append(handle.run_id, "warning", `cancel after ${record.protocol.status}: ${reason}`)
          .catch(() => undefined);
      }
      await this._releaseLease(sessionId);
      return;
    }

    const handle = this._activeRuns.get(sessionId);
    const runId =
      handle?.run_id ??
      record.runtime_active_run_id ??
      record.protocol.runs[record.protocol.runs.length - 1]?.run_id;

    // Step 1: SDK cancel (must come BEFORE persistence per invariant).
    if (handle && handle.isActive()) {
      await handle.cancel(reason);
    }

    // Step 2: transcript line.
    if (runId) {
      await this._transcriptWriter
        .append(runId, "session_cancelled", `reason: ${reason}`)
        .catch(() => undefined);
    }

    // Step 3: update + persist record.
    const cancelledAt = this._now().toISOString();
    const updated: SessionRecord = {
      ...record,
      protocol: {
        ...record.protocol,
        status: "cancelled",
        ended_at: cancelledAt,
        runs: record.protocol.runs.map((r, i, arr) =>
          i === arr.length - 1 && r.status === "running"
            ? { ...r, status: "cancelled" as const, ended_at: cancelledAt }
            : r,
        ),
      },
      runtime_last_event_at: cancelledAt,
    };
    await this._sessionStore.save(updated);

    this._activeRuns.delete(sessionId);
    this._sessionTaskIds.delete(sessionId);
    this._sessionThreadKeys.delete(sessionId);
    await this._releaseLease(sessionId);

    // Step 4: emit runtime.session_cancelled.
    this._emit({
      event_id: `${sessionId}-cancelled`,
      at: cancelledAt,
      event_type: "runtime.session_cancelled",
      session_id: sessionId,
      run_id: runId ?? undefined,
      agent_id: record.protocol.agent_id,
      payload: { reason },
    });
  }

  /**
   * Cancel all running sessions for one agent (e.g. manual「换 AI」).
   * Uses `cancelSession` per session — does not mutate session JSON directly.
   */
  async cancelRunningSessionsForAgent(
    agentId: string,
    reason: string,
  ): Promise<{
    cancelled: string[];
    failed: { session_id: string; reason: string }[];
  }> {
    const active = await this.listActive();
    const targets = active.filter(
      (r) =>
        r.protocol.agent_id === agentId &&
        r.protocol.status === "running",
    );

    const results = await Promise.allSettled(
      targets.map((r) =>
        this.cancelSession(r.protocol.session_id, reason).then(
          () => ({ session_id: r.protocol.session_id }) as const,
        ),
      ),
    );

    const cancelled: string[] = [];
    const failed: { session_id: string; reason: string }[] = [];

    results.forEach((res, i) => {
      const sessionId = targets[i]!.protocol.session_id;
      if (res.status === "fulfilled") {
        cancelled.push(sessionId);
      } else {
        failed.push({
          session_id: sessionId,
          reason:
            res.reason instanceof Error
              ? res.reason.message
              : String(res.reason),
        });
      }
    });

    return { cancelled, failed };
  }

  /**
   * §0.9.5 Mobile Emergency Stop ⛔ — cancel every running session.
   *
   * Uses `Promise.allSettled` so one failing cancel does NOT block the
   * rest (TASK-013 §"关键不变量"). Phase B leaves the EMERGENCY-{ts}.md
   * write hook unimplemented (v0.2 S10 scope) — the JSDoc captures the
   * contract for the future implementer.
   *
   * AUTHORIZATION: this method itself does NOT check for admin layer —
   * the caller (CLI handler, mobile bridge) is responsible. The method
   * name is intentionally explicit as a code-review tripwire.
   */
  async cancelAllForEmergencyStop(): Promise<EmergencyStopResult> {
    const active = await this.listActive();
    const results = await Promise.allSettled(
      active.map((r) =>
        this.cancelSession(r.protocol.session_id, "emergency_stop").then(
          () => ({ session_id: r.protocol.session_id }) as const,
        ),
      ),
    );

    const cancelled: string[] = [];
    const failed_to_cancel: EmergencyStopResult["failed_to_cancel"] = [];
    results.forEach((res, i) => {
      const sessionId = active[i]!.protocol.session_id;
      if (res.status === "fulfilled") {
        cancelled.push(sessionId);
      } else {
        failed_to_cancel.push({
          session_id: sessionId,
          reason:
            res.reason instanceof Error
              ? res.reason.message
              : String(res.reason),
        });
      }
    });

    // Phase B leaves EMERGENCY-{ts}.md write to v0.2 S10 — JSDoc above
    // describes the contract; this is the documented hook point.

    return { cancelled, failed_to_cancel };
  }

  /**
   * Resolve when the session's natural-settle chain has fully landed
   * (status persisted, `runtime.session_ended` emitted, transcript closed).
   *
   * Returns immediately if the session is unknown, already settled, or
   * was cancelled (the cancel path runs synchronously inside
   * `cancelSession`, not through this chain).
   *
   * Primarily a test seam — production code observes settlement via
   * `onEvent("runtime.session_ended")` instead. Kept on the public
   * surface because Phase C's Task Scheduler may want it for "wait for
   * task to finish" semantics.
   */
  async awaitSettled(sessionId: string): Promise<void> {
    const chain = this._settlementChain.get(sessionId);
    if (!chain) return;
    await chain;
  }

  /**
   * Subscribe to runtime events (12 types — see `RuntimeEventType`).
   *
   * Listeners receive events from BOTH the SDK stream (for sessions
   * started via this manager) and the runtime layer (lifecycle).
   * Filtering is the listener's job.
   *
   * Throwing listeners are unsubscribed and the error is logged; the
   * other listeners continue to receive events. Unsubscribe is idempotent.
   */
  onEvent(handler: (event: RuntimeEvent) => void): Unsubscribe {
    this._eventListeners.add(handler);
    return () => {
      this._eventListeners.delete(handler);
    };
  }

  // ── private helpers ──────────────────────────────────────────────

  private _startLeaseHeartbeat(sessionId: string): void {
    const timer = setInterval(() => {
      void this._leaseStore.heartbeat(sessionId).catch(() => undefined);
    }, 20_000);
    timer.unref();
    this._leaseHeartbeats.set(sessionId, timer);
  }

  private async _releaseLease(sessionId: string): Promise<void> {
    const timer = this._leaseHeartbeats.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this._leaseHeartbeats.delete(sessionId);
    }
    await this._leaseStore.release(sessionId).catch(() => false);
  }

  private _emit(event: RuntimeEvent): void {
    this._dispatchToListeners(event);
  }

  private _maybeRecordActionEvidenceFromToolCall(event: RuntimeEvent): void {
    const projectRoot = this._opts.projectRoot;
    if (!projectRoot || event.event_type !== "sdk.tool_call") return;
    if (!event.session_id || !event.agent_id) return;

    const payload =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : {};

    const taskId =
      (event.session_id ? this._sessionTaskIds.get(event.session_id) : undefined) ||
      (typeof payload.task_id === "string" ? payload.task_id : "") ||
      "";

    const threadKey =
      (typeof payload.thread_key === "string" ? payload.thread_key : undefined) ||
      this._sessionThreadKeys.get(event.session_id);

    maybeRecordActionEvidenceFromToolCall({
      projectRoot,
      agent_id: event.agent_id,
      session_id: event.session_id,
      run_id: event.run_id,
      payload,
      thread_key: threadKey,
      task_id: taskId || undefined,
    });
  }

  private _dispatchToListeners(event: RuntimeEvent): void {
    this._maybeRecordActionEvidenceFromToolCall(event);
    for (const listener of [...this._eventListeners]) {
      try {
        listener(event);
      } catch (err) {
        this._eventListeners.delete(listener);
        // eslint-disable-next-line no-console -- contract-mandated visibility
        console.error(
          `[SessionManager] listener threw on event ${event.event_type}; unsubscribed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  private _emitTransientSdkStatus(
    sessionId: string,
    agentId: string,
    runId: string | null,
    attempt: number,
    delayMs: number,
    error: Error,
  ): void {
    this._emit({
      event_id: `${sessionId}-sdk-retry-${attempt}`,
      at: this._now().toISOString(),
      event_type: "sdk.status",
      session_id: sessionId,
      run_id: runId ?? undefined,
      agent_id: agentId,
      payload: {
        status: "retrying",
        transient_sdk_error: true,
        attempt,
        delay_ms: delayMs,
        error: error.message,
      },
    });
  }

  private async _handleNaturalSettle(
    sessionId: string,
    settledRun: SessionRun,
    err?: Error,
  ): Promise<void> {
    const record = await this._sessionStore.load(sessionId);
    if (!record) {
      await this._releaseLease(sessionId);
      return; // already removed; nothing to do
    }
    if (record.protocol.status !== "running") {
      await this._releaseLease(sessionId);
      return; // cancel already won
    }

    const reporter = roleFromAgentId(record.protocol.agent_id);
    const reportLookupOpts = {
      taskId: record.protocol.task_id,
      reporter,
      ...(this._opts.fcopReportsDir
        ? { fcopReportsDir: this._opts.fcopReportsDir }
        : {}),
      ...(this._opts.projectRoot ? { projectRoot: this._opts.projectRoot } : {}),
    };
    const reportOnDisk =
      this._opts.fcopReportsDir || this._opts.projectRoot
        ? await findReportForTaskOnDisk(reportLookupOpts)
        : false;
    const reportPath = reportOnDisk
      ? await findReportPathForTaskOnDisk(reportLookupOpts)
      : null;

    let protocolStatus: Session["status"];
    let finalRun: SessionRun = { ...settledRun };
    const settledWithSdkError =
      typeof (settledRun as SessionRun & { sdk_error?: unknown }).sdk_error === "string" &&
      String((settledRun as SessionRun & { sdk_error?: unknown }).sdk_error).trim().length > 0;
    const settledWithFailure =
      settledRun.status === "failed" ||
      Boolean(settledRun.failure_code) ||
      settledWithSdkError ||
      err != null;

    // A stale or earlier REPORT must never turn a failed SDK run into a
    // completed session. Runtime failure evidence takes precedence.
    if (settledWithFailure) {
      protocolStatus = "failed";
      finalRun = {
        ...finalRun,
        status: "failed",
        ...(settledRun.failure_code === TRANSIENT_SDK_DELAYED ||
        (err != null && isTransientSdkError(err))
          ? { failure_code: TRANSIENT_SDK_DELAYED }
          : {}),
      };
    } else if (reportOnDisk) {
      protocolStatus = "completed";
      finalRun = {
        ...finalRun,
        status: "finished",
        failure_code: undefined,
      };
    } else if (settledRun.status === "finished") {
      protocolStatus = "completed";
    } else if (settledRun.status === "cancelled") {
      protocolStatus = "cancelled";
    } else {
      protocolStatus = "failed";
    }

    const endedAt = this._now().toISOString();
    const updated: SessionRecord = {
      ...record,
      protocol: {
        ...record.protocol,
        status: protocolStatus,
        ended_at: endedAt,
        runs: record.protocol.runs.map((r, i, arr) =>
          i === arr.length - 1 ? finalRun : r,
        ),
      },
      runtime_last_event_at: endedAt,
    };
    try {
      await this._sessionStore.save(updated);
    } catch {
      // Persistence failure here is logged by the store layer; we cannot
      // rollback the SDK side, so the session record on disk remains
      // "running" until a future reconciliation.
    }
    this._activeRuns.delete(sessionId);
    this._sessionTaskIds.delete(sessionId);
    this._sessionThreadKeys.delete(sessionId);
    await this._releaseLease(sessionId);

    let settlement_reason: string;
    if (reportOnDisk && protocolStatus === "completed") {
      settlement_reason = "completed-with-report";
    } else if (reportOnDisk && protocolStatus === "cancelled") {
      settlement_reason = "cancelled-after-success";
    } else if (protocolStatus === "cancelled") {
      settlement_reason = "cancelled-without-report";
    } else if (
      finalRun.failure_code === TRANSIENT_SDK_DELAYED ||
      (err != null && isTransientSdkError(err))
    ) {
      settlement_reason = "transient_delayed";
    } else if (protocolStatus === "failed") {
      settlement_reason = "failed";
    } else {
      settlement_reason = "completed";
    }

    const startedAt = record.protocol.started_at;
    const durationMs =
      startedAt && endedAt
        ? Math.max(
            0,
            new Date(endedAt).getTime() - new Date(startedAt).getTime(),
          )
        : undefined;
    const runWithFailure = finalRun as SessionRun & SessionRunWithSdkFailure;
    const sessionErrorMessage =
      err?.message ??
      (typeof runWithFailure.sdk_error === "string"
        ? runWithFailure.sdk_error
        : undefined);

    const reason = normalizeSessionEndReason({
      protocolStatus: updated.protocol.status,
      failureCode: finalRun.failure_code,
      settlementReason: settlement_reason,
      errorMessage: sessionErrorMessage,
    });

    const runtimeProvider = "cursor" as const;
    const failureRebuildInput = {
      runDetail: runWithFailure.sdk_failure_detail,
      duration_ms: durationMs!,
      tool_call_count: finalRun.tool_calls_count ?? 0,
      agent_id: record.protocol.agent_id,
      role: reporter,
      session_id: sessionId,
      task_id: record.protocol.task_id,
      error_message: sessionErrorMessage,
      status: "error" as const,
    };
    const sdkFailurePayload =
      protocolStatus === "failed" && durationMs != null
        ? rebuildSdkFailureForSessionEnd(failureRebuildInput)
        : undefined;

    this._emit({
      event_id: `${sessionId}-ended`,
      at: endedAt,
      event_type: "runtime.session_ended",
      session_id: sessionId,
      run_id: settledRun.run_id,
      agent_id: record.protocol.agent_id,
      payload: {
        event: "session_end",
        status: updated.protocol.status,
        task_id: record.protocol.task_id,
        settlement_reason,
        reason,
        error: sessionErrorMessage,
        started_at: startedAt,
        ended_at: endedAt,
        ...(durationMs != null ? { duration_ms: durationMs } : {}),
        tool_call_count: finalRun.tool_calls_count ?? 0,
        ...(finalRun.last_tool ? { last_tool: finalRun.last_tool } : {}),
        ...(finalRun.last_action ? { last_action: finalRun.last_action } : {}),
        report_written: reportOnDisk,
        ...(reportPath ? { report_path: reportPath } : {}),
        ...(finalRun.failure_code
          ? { failure_code: finalRun.failure_code }
          : {}),
        ...(finalRun.failure_code === TRANSIENT_SDK_DELAYED
          ? { transient_sdk_error: true }
          : {}),
        ...(reportOnDisk ? { report_on_disk: true } : {}),
        runtime_provider: runtimeProvider,
        ...(sdkFailurePayload ?? {}),
      },
    });
  }
}
