/**
 * TaskDispatcher — glue layer that turns "file added to inbox" into
 * "agent driven by SessionManager" and writes the audit trail back.
 *
 * Scope (TASK-20260509-018 §主交付 4):
 *
 * Pipeline per `task_added` event:
 *   1. Parse the task.md (TaskParser).
 *      - Parse fail → log.warn + state_history `inbox → parse_failed`.
 *   2. Resolve the recipient agent via AgentRegistry.list({ role }).
 *      - Not found → log.warn + state_history `inbox → agent_not_found`.
 *   3. Call SessionManager.startSession(agent, task_id, payload).
 *      - InvalidAgentStatusError → state_history `inbox → rejected_busy`
 *        AND task is added to the ADHOC priority queue (Sprint-G).
 *      - Other error → log.error + state_history `inbox → retry_waiting` (backoff).
 *   4. Subscribe to SessionManager.onEvent for runtime.session_ended /
 *      runtime.session_cancelled filtered by session_id; on settle,
 *      append state_history `dispatched → ended | cancelled` and
 *      unsubscribe (no leak).
 *
 * # ADHOC Priority Queue (Sprint-G — TASK-20260514-968)
 *
 * When a task is rejected_busy, it is placed in an in-memory priority queue
 * instead of being silently dropped. Priority is read from frontmatter
 * `priority: P0 | P1 | P2` (default P2 when absent or unrecognised).
 *
 *   P0 — highest: placed at the head of the queue; dequeued first when
 *        the agent next becomes free. A P0 item arriving while the agent
 *        is busy also triggers an immediate retry loop with a short delay
 *        so that it catches any window where the agent finishes quickly.
 *   P1 — medium: inserted after all P0 items but before P2.
 *   P2 — normal (default): appended to the tail.
 *
 * Drain: on every `runtime.session_ended` / `runtime.session_cancelled`
 * event the dispatcher dequeues one item (highest priority) and retries
 * it. If still busy the item is re-inserted with its original priority.
 *
 * The dispatcher is intentionally robust to ALL classes of errors — a
 * single bad task must not crash the watcher loop. Errors are logged,
 * recorded as state_history when possible, and execution continues.
 */

import { promises as fs, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { toLocalIsoString } from "../_internal/local-iso.ts";
import type { FcopProjectClient } from "../_external/fcop-client.ts";
import type { AgentRegistry } from "../registry/AgentRegistry.ts";
import { InvalidAgentStatusError } from "../registry/errors.ts";
import { TaskFileNotFoundError, TaskParseError } from "../registry/errors.ts";
import type {
  SessionManager,
  SessionStartPayload,
} from "../session/SessionManager.ts";
import type { RuntimeEvent, Unsubscribe } from "../types/state.ts";
import type { SessionRecord } from "../types/state.ts";
import type { InboxEvent, InboxWatcher } from "./InboxWatcher.ts";
import {
  resolveTaskFileForMutation,
} from "../lifecycle/taskPathUtils.ts";
import type { LifecycleGovernor } from "./LifecycleGovernor.ts";
import {
  evaluateDispatchEligibility,
  extractRecipientFromFilename,
  extractSenderFromFilename,
  normalizeWorkerRole,
  resolveExplicitDispatchHoldReason,
  type ExplicitDispatchHoldReason,
} from "../pm/taskDispatchGate.ts";
import {
  canDispatchQA,
  qaGateToDispatchSkipReason,
} from "../pm/qaDispatchGate.ts";
import type { ExecutionState } from "../pm/executionState.ts";
import {
  buildSessionImagesFromTaskAttachments,
  formatTaskAttachmentPromptBlock,
  resolveTaskAttachmentsForDispatch,
} from "../pm/taskAttachments.ts";
import {
  filterThreadTasks,
  loadExecutionGateContext,
} from "../pm/taskDispatchContext.ts";
import type { PanelEventBridge } from "../panel/PanelEventBridge.ts";
import {
  isPmToWorkerDispatch,
  type PmQueueGuard,
} from "./PmQueueGuard.ts";
import type { ReportGate } from "./ReportGate.ts";
import type { StateHistoryEntry, StateHistoryWriter } from "./StateHistoryWriter.ts";
import {
  TaskParser,
  validateDurableTaskForDispatch,
  type ParsedTask,
} from "./TaskParser.ts";
import {
  collectDependencyTaskIds,
  evaluateTaskDependencyGate,
} from "./TaskDependencyGate.ts";
import {
  appendDependencyReleaseCycleEvents,
  releasePendingDependencyTasks as runDependencyReleaseScan,
} from "./DependencyReleaseRunner.ts";
import { formatPmBuiltinSkillsPlaybookBlock } from "../pm/PmSkillManifest.ts";
import { buildPmCoreCapabilitiesBlock } from "../pm/PmCoreCapabilities.ts";
import {
  isTaskHotPathBody,
  isPmDispatchForbiddenBody,
  isPmSelfReportOnlyContext,
} from "../pm/pmAdminRejectPrompt.ts";
import {
  extractTaskIdPrefixFromFilepath,
  normalizeWriteReportTaskIdPrefix,
} from "../registry/writeReportTaskIdGuard.ts";
import { buildAgentSkillRoutingBlock } from "../skills/AgentSkillRouting.ts";
import { resolveAndInjectAgentContextSkills } from "../skills/SkillContextRouter.ts";
import { buildLeaderLedgerContextPack } from "../ledger/leaderLedgerContextPack.ts";
import {
  parseMarkdownFrontmatter,
  strField,
} from "../ledger/frontmatter.ts";
import {
  dispatchRetryRegistry,
  type DispatchRetryRegistry,
} from "../_internal/DispatchRetryRegistry.ts";
import {
  isTransientSdkError,
  TransientSdkDelayedError,
  TRANSIENT_SDK_DELAYED,
} from "../_internal/transient-sdk-error.ts";
import {
  sdkCooldownRegistry,
  SdkCooldownActiveError,
} from "../_internal/SdkCooldownRegistry.ts";
import { zeroToolcallCircuitBreaker } from "../_internal/ZeroToolcallCircuitBreaker.ts";
import {
  enqueueAgentTask,
  isTaskPaused,
  isTaskQueuedInState,
  loadAgentTaskQueue,
  normalizeQueueTaskId,
  RESUME_EXECUTION_PROMPT_ZH,
  setAgentRunning,
  withAgentTaskQueue,
} from "../pm/agentTaskQueue.ts";
import {
  completeAgentTaskAndAdvance,
  isTaskPathEnqueueAllowed,
} from "../pm/agentTaskQueueControl.ts";
import { guardLandedPmProductWorkerTask } from "../pm/ProductDeliveryRuntimeGate.ts";
import { recordProductTaskClassification } from "../pm/ProductDeliveryGovernance.ts";

/** Align session/prompt task_id with LedgerBuilder.canonicalTaskId semantics. */
function resolveCanonicalTaskId(
  filename: string,
  parsed: { task_id?: string },
): string {
  const fromFm = String(parsed.task_id ?? "").replace(/\.md$/i, "").trim();
  if (fromFm) {
    const canonical = /^TASK-\d{8}-\d{3,}/i.exec(fromFm);
    return canonical ? canonical[0].toUpperCase() : fromFm;
  }
  const base = filename.replace(/\.md$/i, "");
  const m = /^TASK-\d{8}-\d{3,}/i.exec(base);
  return m ? m[0].toUpperCase() : base;
}

export interface TaskDispatcherLogger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

export interface TaskDispatcherOpts {
  watcher: InboxWatcher;
  /** Optional parser override; default = TaskParser (the static class). */
  parser?: { parse: typeof TaskParser.parse };
  historyWriter: StateHistoryWriter;
  registry: AgentRegistry;
  sessionManager: SessionManager;
  /**
   * Optional fcop@1.1.0 client (P4 sprint Day 2 — TASK-20260515-001).
   *
   * When provided, `_appendHistory` first attempts to call
   * `fcopClient.appendStateHistory(taskId, entry)` so the state transition
   * is recorded through the fcop write API. If that method does not exist
   * on the client yet (the API is a planned addition) or if the call throws,
   * the dispatcher automatically falls back to the existing `StateHistoryWriter`
   * direct-file path — the main dispatch loop never crashes due to fcop errors.
   *
   * When omitted, the legacy `StateHistoryWriter` path is used exclusively
   * (unchanged behavior vs. pre-Day-2).
   */
  fcopClient?: FcopProjectClient;
  /** When true, automatic inbox→active lifecycle moves are read-only. */
  yamlFallbackMode?: boolean;
  /**
   * Optional async `_lifecycle/` moves (inbox→active, report→review).
   * Never blocks dispatch or agent sessions.
   */
  lifecycleGovernor?: LifecycleGovernor;
  /**
   * Rule 6 backstop: when DEV/OPS/QA sessions end without a REPORT on disk,
   * schedule compensating `write_report` (blocked/aborted).
   */
  reportGate?: ReportGate;
  /** Panel / SSE bridge for task_dispatched and related events. */
  panelEvents?: PanelEventBridge;
  /** PM queue busy guard — release after PM→worker dispatch. */
  pmQueueGuard?: PmQueueGuard;
  /** Defaults to `console`. */
  logger?: TaskDispatcherLogger;
  /** Wall clock; tests inject a controlled clock. */
  now?: () => Date;
  /** Repo root — enables PM playbook auto_inject on dispatch. */
  projectRoot?: string;
  /** Dispatch failure backoff; defaults to runtime singleton. */
  dispatchRetryRegistry?: DispatchRetryRegistry;
  /**
   * Floor for dispatch-retry timer delay (ms). Production Runtime sets
   * AUTO_RECOVERY_MIN_RETRY_MS; tests should pass 0 to preserve timing.
   */
  minScheduleRetryDelayMs?: number;
  /**
   * Periodic inbox reconciliation backs up filesystem add events on Windows.
   * Set to 0 to disable in focused tests. Production defaults to 1500ms.
   */
  inboxReconcileIntervalMs?: number;
}

/** Fired when a dispatch retry timer is scheduled (panel auto-recovery hook). */
export interface DispatchRetryHookInfo {
  agentId: string;
  taskId: string;
  delayMs: number;
  note: string;
}

export type DispatchRetryHook = (info: DispatchRetryHookInfo) => void;

// ── ADHOC priority queue types ──────────────────────────────────────────────

/** FCoP task priority values. */
export type AdHocPriority = "P0" | "P1" | "P2";

/** Lower weight = higher priority (P0 dequeues first). */
const PRIORITY_WEIGHT: Record<AdHocPriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
};

/** An item held in the in-memory ADHOC priority queue. */
export interface AdhocQueueItem {
  filepath: string;
  filename: string;
  recipient: string;
  priority: AdHocPriority;
  enqueuedAt: string;
}

/** Worker roles that must reciprocate TASK with REPORT to PM (Rule 6). */
const WORKER_ROLES = new Set(["DEV", "OPS", "QA"]);
const OBSERVER_ROLES = new Set(["EVAL", "SYSTEM", "AUTO-AUDIT"]);

/** Shared by every dispatcher instance in one Runtime process. */
const PROCESS_TASK_CLAIMING_PATHS = new Set<string>();

function _isWorkerRole(role: string): boolean {
  return WORKER_ROLES.has(role.toUpperCase());
}

function _isObserverRole(role: string): boolean {
  return OBSERVER_ROLES.has(role.toUpperCase());
}

/** Extract AdHocPriority from raw frontmatter value (default P2). */
function _parsePriority(raw: unknown): AdHocPriority {
  if (raw === "P0" || raw === "P1" || raw === "P2") return raw;
  return "P2";
}

function _queuePathKey(filepath: string): string {
  return filepath.replace(/\\/g, "/").toLowerCase();
}

// ── Sprint-L1: frontmatter state helpers ────────────────────────────────────

/**
 * Read the `state:` field from the YAML frontmatter block of a raw task file.
 * Returns `undefined` when there is no frontmatter or no `state` key.
 * Deliberately regex-based (no YAML re-parse) for speed and zero new deps.
 */
function _parseFmState(raw: string): string | undefined {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return undefined;
  const yamlSection = m[1] ?? "";
  const hit = yamlSection.match(/^state:\s*(\S+)/m);
  return hit ? hit[1] : undefined;
}

/**
 * Return a new file content string with `state: <val>` set in the YAML
 * frontmatter block.  If `state:` already exists it is replaced in-place;
 * otherwise a new line is appended at the end of the frontmatter.
 * Returns `raw` unchanged when no frontmatter block is found.
 */
function _patchFmState(raw: string, val: string): string {
  const re = /^(---\r?\n)([\s\S]*?)(\r?\n---)/;
  const m = raw.match(re);
  if (!m) return raw;
  const open = m[1] ?? "---\n";
  const yamlBody = m[2] ?? "";
  const close = m[3] ?? "\n---";
  const newYaml = /^state:/m.test(yamlBody)
    ? yamlBody.replace(/^state:.*$/m, `state: ${val}`)
    : `${yamlBody}\nstate: ${val}`;
  return raw.replace(re, `${open}${newYaml}${close}`);
}

/** States eligible for explicit dispatch claim (inbox held → active → session). */
function _isDispatchClaimableState(state: string | undefined): boolean {
  const s = String(state ?? "inbox").toLowerCase();
  return s === "inbox" || s === "active";
}

function _shouldRestoreClaimedTask(outcome: DispatchOutcome): boolean {
  return (
    outcome.kind === "agent_not_found" ||
    outcome.kind === "no_task_id"
  );
}

function _isAdhocInboxPath(filepath: string, inboxDir: string): boolean {
  return resolve(dirname(filepath)).toLowerCase() === inboxDir.toLowerCase();
}

function _isLiveAdhocItemSync(
  item: AdhocQueueItem,
  inboxDir: string,
): boolean {
  if (!_isAdhocInboxPath(item.filepath, inboxDir)) return false;
  try {
    const raw = readFileSync(item.filepath, "utf-8");
    return _parseFmState(raw) === "inbox";
  } catch {
    return false;
  }
}

function _lastHistoryEntryMatches(
  content: string,
  entry: StateHistoryEntry,
): boolean {
  const lines = content.split(/\r?\n/).filter((l) => l.startsWith("- **"));
  const last = lines[lines.length - 1];
  if (!last) return false;
  const transition = `\`${entry.from}\` → \`${entry.to}\``;
  if (!last.includes(transition)) return false;
  if (entry.note && !last.includes(entry.note)) return false;
  return true;
}

// ── end Sprint-L1 helpers ────────────────────────────────────────────────────

/** Options for authorized control-plane dispatch (pm_wake, admin pin, etc.). */
export interface DispatchControlPlaneOptions {
  preferredAgentId?: string;
  sessionTextOverride?: string;
  sessionImagesOverride?: import("../registry/AgentSdkAdapter.ts").SessionSdkImage[];
  maxToolRounds?: number;
  /**
   * PM's explicit operator wake is an override of business readiness gates.
   * It does not bypass lifecycle/frozen/paused checks or agent concurrency.
   */
  bypassBusinessGates?: boolean;
}

/**
 * Dispatch result tag — used internally and surfaced via `state_history`
 * notes for downstream observability.
 */
export type DispatchOutcome =
  | { kind: "dispatched"; session_id: string; inboxHistoryRecorded?: boolean }
  | { kind: "parse_failed"; reason: string }
  | { kind: "agent_not_found"; recipient: string; reason?: string }
  | { kind: "rejected_busy"; recipient: string; status: string }
  | {
      kind: "retry_waiting";
      reason: string;
      next_retry_at: number;
      failure_count: number;
      retry_key: string;
    }
  | {
      kind: "waiting_admin_decision";
      reason: string;
      failure_count: number;
      retry_key: string;
    }
  /** @deprecated 使用 waiting_admin_decision */
  | { kind: "blocked_network"; reason: string; failure_count: number; retry_key: string }
  | { kind: "force_archived"; retry_key: string }
  | { kind: "no_task_id"; reason: string }
  | { kind: "observer_bypass"; recipient: string }
  | { kind: "already_dispatched" }
  | {
      kind: "dependency_pending";
      reason: string;
      dependency_task_ids: string[];
    }
  | { kind: "held_in_inbox"; reason: ExplicitDispatchHoldReason }
  | {
      kind: "dispatch_skipped";
      reason:
        | "waiting_dependency"
        | "task_not_dispatched"
        | "already_active"
        | "already_done"
        | "execution_blocked"
        | "product_brief_required"
        | "invalid_task_file"
        | "cancelled"
        | "superseded";
      detail?: string;
      waiting_on?: string;
      execution_state?: ExecutionState;
    }
  | {
      kind: "dispatch_bypass_blocked";
      reason: string;
      source?: string;
    };

export class TaskDispatcher {
  private readonly _watcher: InboxWatcher;
  private readonly _parser: { parse: typeof TaskParser.parse };
  private readonly _historyWriter: StateHistoryWriter;
  private readonly _fcopClient?: FcopProjectClient;
  private readonly _yamlFallbackMode: boolean;
  private readonly _registry: AgentRegistry;
  private readonly _sessionManager: SessionManager;
  private readonly _logger: TaskDispatcherLogger;
  private readonly _now: () => Date;

  private _watcherUnsubscribe: (() => void) | null = null;
  private _sessionEventUnsubscribe: (() => void) | null = null;
  private _inboxReconcileTimer: ReturnType<typeof setInterval> | null = null;
  private _inboxReconcileRunning = false;
  private readonly _inboxReconcileIntervalMs: number;
  private readonly _dispatchWaitLogAt = new Map<string, number>();
  private _started = false;

  /**
   * In-flight session subscriptions awaiting natural settlement. Keyed by
   * session_id so we can unsubscribe deterministically when the
   * runtime.session_ended / runtime.session_cancelled event lands.
   */
  private readonly _pendingSettlements = new Map<
    string,
    { unsubscribe: Unsubscribe; filepath: string; filename: string; recipient: string }
  >();

  /**
   * ADHOC priority queue — tasks that were rejected_busy and are waiting
   * to be retried. Sorted by PRIORITY_WEIGHT (P0 first).
   */
  private readonly _adhocQueue: AdhocQueueItem[] = [];

  /**
   * Reverse map: agentId → currently running sessionId.
   * Used by P0 interrupt logic to cancel the right session.
   */
  private readonly _runningByAgent = new Map<string, string>();

  /**
   * Sprint-L1: in-process guard for the brief window between reading the
   * frontmatter state and writing "dispatched" back.  Prevents a second
   * concurrent chokidar `add` event (or ADHOC retry) from racing through
   * the same claim window for the same file.
   */
  private readonly _claimingPaths = PROCESS_TASK_CLAIMING_PATHS;
  /**
   * Closes the race between watcher and reconciliation passes while an
   * explicit-dispatch hold is being recorded. Durable dedupe is performed
   * against the task history itself in `_registerHeldInboxTask`.
   */
  private readonly _registeringHeldPaths = new Set<string>();
  private readonly _lifecycleGovernor: LifecycleGovernor | undefined;
  private readonly _reportGate: ReportGate | undefined;
  private readonly _panelEvents: PanelEventBridge | undefined;
  private readonly _pmQueueGuard: PmQueueGuard | undefined;
  private readonly _projectRoot: string | undefined;
  private readonly _dispatchRetryRegistry: DispatchRetryRegistry;
  private readonly _minScheduleRetryDelayMs: number;
  private _dispatchRetryHook: DispatchRetryHook | null = null;

  constructor(opts: TaskDispatcherOpts) {
    this._watcher = opts.watcher;
    this._parser = opts.parser ?? { parse: TaskParser.parse.bind(TaskParser) };
    this._historyWriter = opts.historyWriter;
    this._fcopClient = opts.fcopClient;
    this._yamlFallbackMode = opts.yamlFallbackMode === true;
    this._registry = opts.registry;
    this._sessionManager = opts.sessionManager;
    this._logger = opts.logger ?? {
      info: (msg, ...args) => console.log(msg, ...args),
      warn: (msg, ...args) => console.warn(msg, ...args),
      error: (msg, ...args) => console.error(msg, ...args),
    };
    this._now = opts.now ?? (() => new Date());
    this._lifecycleGovernor = opts.lifecycleGovernor;
    this._reportGate = opts.reportGate;
    this._panelEvents = opts.panelEvents;
    this._pmQueueGuard = opts.pmQueueGuard;
    this._projectRoot = opts.projectRoot;
    this._dispatchRetryRegistry =
      opts.dispatchRetryRegistry ?? dispatchRetryRegistry;
    this._minScheduleRetryDelayMs = opts.minScheduleRetryDelayMs ?? 0;
    this._inboxReconcileIntervalMs = Math.max(
      0,
      opts.inboxReconcileIntervalMs ?? 1_500,
    );
  }

  setDispatchRetryHook(hook: DispatchRetryHook | null): void {
    this._dispatchRetryHook = hook;
  }

  /**
   * Returns a read-only snapshot of the current ADHOC queue (highest priority
   * first). Useful for monitoring and tests.
   */
  getAdhocQueue(): readonly AdhocQueueItem[] {
    this._pruneStaleAdhocQueue();
    return [...this._adhocQueue];
  }

  /**
   * Manually enqueue an ADHOC task item. The item will be dispatched when
   * the target agent next becomes idle. If `priority` is P0 the item is
   * placed at the head of the queue.
   */
  enqueueAdhoc(item: AdhocQueueItem): void {
    this._enqueueUniqueSorted(item);
    this._logger.info(
      `[TaskDispatcher] ADHOC enqueued ${item.filename} (${item.priority}), queue depth=${this._adhocQueue.length}`,
    );
  }

  /**
   * Start the underlying InboxWatcher and subscribe to its events.
   * Also subscribes to SessionManager events to drain the ADHOC queue
   * when an agent becomes idle (session_ended / session_cancelled).
   * Resolves once the watcher is `ready` (initial scan complete).
   */
  async start(): Promise<void> {
    if (this._started) {
      throw new Error("TaskDispatcher.start() already called");
    }
    this._started = true;

    // Subscribe to session lifecycle events for ADHOC queue draining.
    this._sessionEventUnsubscribe = this._sessionManager.onEvent((evt) => {
      if (
        evt.event_type === "runtime.session_ended" ||
        evt.event_type === "runtime.session_cancelled"
      ) {
        void this._onSessionSettled();
      }
    });

    this._watcherUnsubscribe = this._watcher.onEvent((event) =>
      this._handleInbox(event),
    );
    await this._watcher.start();
    await this.reconcileInboxNow();
    if (this._inboxReconcileIntervalMs > 0) {
      this._inboxReconcileTimer = setInterval(
        () => void this.reconcileInboxNow(),
        this._inboxReconcileIntervalMs,
      );
      this._inboxReconcileTimer.unref();
    }
  }

  /**
   * Recover TASK files whose filesystem add event was missed. The normal
   * control plane remains authoritative, so watcher/reconcile races are
   * idempotent through the existing claim and lifecycle guards.
   */
  async reconcileInboxNow(): Promise<void> {
    if (this._inboxReconcileRunning) return;
    this._inboxReconcileRunning = true;
    try {
      const entries = await fs.readdir(this._watcher.dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !/^TASK-\d{8}-\d{3,}-[A-Za-z0-9]+-to-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\.md$/i.test(entry.name)) {
          continue;
        }
        const filepath = join(this._watcher.dir, entry.name);
        let raw: string;
        try {
          raw = await fs.readFile(filepath, "utf-8");
        } catch {
          continue;
        }
        if (_parseFmState(raw) !== "inbox") continue;
        const recipient = extractRecipientFromFilename(entry.name);
        const sender = extractSenderFromFilename(entry.name);
        if (!recipient || !sender) continue;
        await this._handleInbox({
          kind: "task_added",
          filepath,
          filename: entry.name,
          sender,
          recipient,
        });
      }
    } catch (err) {
      this._logger.warn(
        `[TaskDispatcher] inbox reconcile skipped: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this._inboxReconcileRunning = false;
    }
  }

  private _shouldEmitDispatchWait(key: string, intervalMs = 300_000): boolean {
    const now = this._now().getTime();
    const last = this._dispatchWaitLogAt.get(key) ?? 0;
    if (now - last < intervalMs) return false;
    this._dispatchWaitLogAt.set(key, now);
    return true;
  }

  /**
   * Stop the watcher and tear down any in-flight settlement subscriptions.
   * Idempotent.
   */
  async stop(): Promise<void> {
    if (this._inboxReconcileTimer) {
      clearInterval(this._inboxReconcileTimer);
      this._inboxReconcileTimer = null;
    }
    if (this._watcherUnsubscribe) {
      this._watcherUnsubscribe();
      this._watcherUnsubscribe = null;
    }
    if (this._sessionEventUnsubscribe) {
      this._sessionEventUnsubscribe();
      this._sessionEventUnsubscribe = null;
    }
    for (const { unsubscribe } of this._pendingSettlements.values()) {
      unsubscribe();
    }
    this._pendingSettlements.clear();
    await this._watcher.stop();
  }

  // ── private ──────────────────────────────────────────────────────────

  private async _handleInbox(event: InboxEvent): Promise<void> {
    const { filepath, filename, recipient, sender } = event;
    let outcome: DispatchOutcome;
    try {
      const holdReason = await this._resolveExplicitHoldReason(
        filepath,
        sender,
        recipient,
        filename,
      );
      if (holdReason !== null) {
        outcome = await this._registerHeldInboxTask(
          filepath,
          filename,
          recipient,
          holdReason,
        );
      } else {
        outcome = await this.dispatchTaskFromControlPlane(
          filepath,
          filename,
          recipient,
          "inbox_watcher",
        );
        if (outcome.kind === "already_dispatched") {
          return;
        }
        if (outcome.kind === "held_in_inbox") {
          return;
        }
        if (outcome.kind === "observer_bypass") {
          this._logger.info(
            `[TaskDispatcher] skip observer role ${recipient}; not entering worker backlog`,
          );
          return;
        }
        if (outcome.kind === "rejected_busy") {
          await this._enqueueRejectedBusy(filepath, filename, recipient);
        }
        return;
      }
    } catch (err) {
      // Last-line defense: any uncaught error becomes a logged warning.
      // The watcher loop must NEVER die from one bad task.
      this._logger.error(
        `[TaskDispatcher] uncaught error dispatching ${filename}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      outcome = this._retryableStartFailureOutcome(
        this._fallbackRetryKey(recipient, filename),
        err instanceof Error ? err : new Error(String(err)),
      );
    }

    // Sprint-L1: already_dispatched means another handler claimed this file
    // first (or the frontmatter state was already non-inbox).  No audit
    // entry, no queue insertion — just a silent skip.
    if (outcome.kind === "already_dispatched") {
      return;
    }
    if (outcome.kind === "held_in_inbox") {
      return;
    }
    if (outcome.kind === "observer_bypass") {
      this._logger.info(
        `[TaskDispatcher] skip observer role ${recipient}; not entering worker backlog`,
      );
      return;
    }

    // When rejected_busy, add to ADHOC priority queue for later retry.
    // We still write rejected_busy to state_history for audit purposes.
    if (outcome.kind === "rejected_busy") {
      await this._enqueueRejectedBusy(filepath, filename, recipient);
    }

    // Always record the outcome in state_history (best-effort).
    await this._applyDispatchOutcome(filepath, filename, recipient, outcome);
  }

  private async _enqueueRejectedBusy(
    filepath: string,
    filename: string,
    recipient: string,
  ): Promise<void> {
    if (this._projectRoot && isTaskPathEnqueueAllowed(this._projectRoot, filepath)) {
      const candidates = await this._registry.list({ role: recipient }).catch(() => []);
      const agent = candidates[0];
      if (agent) {
        const parsed = await this._parser.parse(filepath).catch(() => null);
        const taskId = parsed
          ? resolveCanonicalTaskId(filename, parsed)
          : filename.replace(/\.md$/i, "");
        let queuedNow = false;
        await withAgentTaskQueue(this._projectRoot, (file) => {
          if (isTaskQueuedInState(file, taskId)) return;
          enqueueAgentTask(file, {
            task_id: taskId,
            agent_id: agent.protocol.agent_id,
            queued_at: this._now().toISOString(),
            reason: "agent_busy",
            filepath,
            filename,
            recipient,
          });
          queuedNow = true;
        });
        if (queuedNow) {
          this._logger.info(
            `[TaskDispatcher] agent FIFO queued ${filename} for ${agent.protocol.agent_id}`,
          );
        }
      }
    }

    const priority = await this._readPriority(filepath);
    this._enqueueUniqueSorted({
      filepath,
      filename,
      recipient,
      priority,
      enqueuedAt: this._now().toISOString(),
    });
    this._logger.info(
      `[TaskDispatcher] ADHOC queued ${filename} (${priority}) — queue depth=${this._adhocQueue.length}`,
    );

    // P0 preemption: cancel the currently running session for this role
    // so the queue drains as soon as the agent is free.
    if (priority === "P0") {
      const candidates = await this._registry.list({ role: recipient }).catch(() => []);
      const agent = candidates[0];
      if (agent) {
        const runningSessionId = this._runningByAgent.get(agent.protocol.agent_id);
        if (runningSessionId) {
          // Re-enqueue the interrupted task as P1 so it is not lost.
          const interrupted = this._pendingSettlements.get(runningSessionId);
          if (interrupted) {
            this._enqueueUniqueSorted({
              filepath: interrupted.filepath,
              filename: interrupted.filename,
              recipient: interrupted.recipient,
              priority: "P1",
              enqueuedAt: this._now().toISOString(),
            });
            this._logger.info(
              `[TaskDispatcher] P0 preempt — re-enqueued interrupted task` +
                ` "${interrupted.filename}" as P1`,
            );
          }
          this._logger.warn(
            `[TaskDispatcher] P0 preempt — cancelling session ${runningSessionId}` +
              ` to prioritise ${filename}`,
          );
          void this._sessionManager
            .cancelSession(runningSessionId, `preempted by P0 task ${filename}`)
            .catch((cancelErr) => {
              this._logger.warn(
                `[TaskDispatcher] P0 cancel failed for ${runningSessionId}: ${
                  cancelErr instanceof Error ? cancelErr.message : String(cancelErr)
                }`,
              );
            });
        }
      }
    }
  }

  private async _applyDispatchOutcome(
    filepath: string,
    filename: string,
    recipient: string,
    outcome: DispatchOutcome,
  ): Promise<void> {
    // Dispatched tasks already got inbox→dispatched + running inside _dispatch
    // before the settlement listener was registered.
    if (!(outcome.kind === "dispatched" && outcome.inboxHistoryRecorded)) {
      await this._appendHistory(filepath, this._outcomeToEntry(outcome)).catch(
        (err) => {
          if (err instanceof TaskFileNotFoundError) {
            this._logger.warn(
              `[TaskDispatcher] task file vanished before state_history append: ${filepath}`,
            );
          } else {
            this._logger.error(
              `[TaskDispatcher] state_history append failed for ${filename}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        },
      );
    }

    if (outcome.kind === "rejected_busy") {
      await this._restoreRejectedBusyToInbox(filepath, filename);
    } else if (_shouldRestoreClaimedTask(outcome)) {
      await this._restoreDispatchedToInbox(filepath, filename, outcome.kind);
    } else if (outcome.kind === "retry_waiting") {
      this._scheduleDispatchRetry(
        filepath,
        filename,
        recipient,
        outcome.retry_key,
        outcome.next_retry_at,
        "dispatch_retry",
      );
    } else if (outcome.kind === "waiting_admin_decision") {
      this._logger.warn(
        `[TaskDispatcher] ${filename} waiting_admin_decision after ${outcome.failure_count} failure(s): ${outcome.reason}`,
      );
    } else if (outcome.kind === "force_archived") {
      this._logger.info(
        `[TaskDispatcher] ${filename} skipped — admin force_archive (${outcome.retry_key})`,
      );
    }
  }

  /** 查询 SDK 投递重试账本（P0 总线闭环）。 */
  getDispatchRetryRecord(retryKey: string) {
    return this._dispatchRetryRegistry.get(retryKey);
  }

  listDispatchRetryRecords() {
    return this._dispatchRetryRegistry.list();
  }

  /**
   * External dispatch entry — blocked. All emission must go through
   * {@link dispatchTaskFromControlPlane} inside TaskDispatcher.
   */
  async dispatchTask(
    filepath: string,
    filename: string,
    _filenameRecipient?: string,
  ): Promise<DispatchOutcome> {
    this._logger.warn(
      `[TaskDispatcher] dispatch_bypass_blocked: external dispatchTask() for ${filename}`,
    );
    return {
      kind: "dispatch_bypass_blocked",
      reason:
        "TaskDispatcher.dispatchTask() is blocked; use dispatchTaskFromControlPlane() via the dispatch control plane",
      source: "external_dispatchTask",
    };
  }

  /**
   * Sole authorized task emission entry: dependency gate, thread gate, lifecycle claim,
   * then session wake. Runtime owns inbox→active because the task payload is preloaded
   * and agents are explicitly told not to call `claim_task` on the hot path.
   */
  async dispatchTaskFromControlPlane(
    filepath: string,
    filename: string,
    filenameRecipient?: string,
    _source?: string,
    options?: DispatchControlPlaneOptions,
  ): Promise<DispatchOutcome> {
    const recipient =
      filenameRecipient ?? extractRecipientFromFilename(filename);
    if (_isObserverRole(recipient)) {
      return { kind: "observer_bypass", recipient };
    }

    let parsedForGate: ParsedTask | null = null;
    try {
      parsedForGate = await this._parser.parse(filepath);
    } catch (err) {
      return {
        kind: "dispatch_skipped",
        reason: "invalid_task_file",
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    const durableErrors = validateDurableTaskForDispatch(parsedForGate, {
      expectedRecipient: recipient,
      expectedSender: extractSenderFromFilename(filename),
    });
    if (durableErrors.length > 0) {
      const detail = durableErrors.join(", ");
      this._logger.warn(
        `[TaskDispatcher] invalid_task_file ${filename}: ${detail}`,
      );
      this._panelEvents?.emit("codeflowmu.dispatch_skipped", {
        event: "dispatch_skipped",
        reason: "invalid_task_file",
        detail,
        task_path: filepath,
        filename,
        role: recipient,
        at: toLocalIsoString(this._now()),
      });
      return { kind: "dispatch_skipped", reason: "invalid_task_file", detail };
    }

    if (parsedForGate && !options?.bypassBusinessGates) {
      if (this._projectRoot) {
        const productGate = await guardLandedPmProductWorkerTask(
          this._projectRoot,
          parsedForGate,
        );
        if (!productGate.allowed) {
          const detail = productGate.findings.join(",");
          if (
            this._shouldEmitDispatchWait(
              `product:${filename}:${productGate.reason}:${detail}`,
            )
          ) {
            this._panelEvents?.emit("codeflowmu.dispatch_skipped", {
              event: "dispatch_skipped",
              reason: productGate.reason,
              detail,
              required_action: productGate.required_action,
              task_path: filepath,
              filename,
              role: recipient,
              at: toLocalIsoString(this._now()),
            });
            this._logger.info(
              `[TaskDispatcher] ${productGate.reason} ${filename}: ${detail}`,
            );
          }
          return {
            kind: "dispatch_skipped",
            reason: productGate.reason,
            detail,
          };
        }
      }
      const dependencyGate = await evaluateTaskDependencyGate(
        parsedForGate,
        this._projectRoot,
      );
      if (!dependencyGate.allowed) {
        const reason = dependencyGate.reason ?? "dependency pending";
        if (this._shouldEmitDispatchWait(`dependency:${filename}:${reason}`)) {
          this._logger.info(
            `[TaskDispatcher] dependency_pending ${filename}: ${reason}`,
          );
          this._panelEvents?.emit("codeflowmu.dispatch_skipped", {
            event: "dispatch_skipped",
            reason: "dependency_pending",
            detail: reason,
            dependency_task_ids: dependencyGate.dependencyTaskIds,
            task_path: filepath,
            filename,
            role: recipient,
            at: toLocalIsoString(this._now()),
          });
        }
        return {
          kind: "dependency_pending",
          reason,
          dependency_task_ids: dependencyGate.dependencyTaskIds,
        };
      }
    }

    if (this._projectRoot && !options?.bypassBusinessGates) {
      const ctx = await loadExecutionGateContext(this._projectRoot);
      let targetRecipient = recipient;
      let targetThread: string | undefined;
      try {
        const parsed = parsedForGate ?? (await this._parser.parse(filepath));
        targetThread = parsed.thread_key;
        if (parsed.recipient) targetRecipient = parsed.recipient;
      } catch {
        /* gate uses filename-derived recipient */
      }
      const existing = ctx.tasks.find((t) => t.filename === filename);
      const target = {
        taskId: existing?.taskId ?? filename.replace(/\.md$/i, ""),
        filename,
        recipient: existing?.recipient ?? targetRecipient,
        sender: existing?.sender,
        threadKey: existing?.threadKey ?? targetThread,
        lifecycleBucket: existing?.lifecycleBucket ?? "inbox",
        fmState: existing?.fmState ?? "inbox",
        displayStatus: existing?.displayStatus,
        dependsOn:
          existing?.dependsOn ??
          (parsedForGate ? collectDependencyTaskIds(parsedForGate) : []),
      };
      const threadTasks = filterThreadTasks(ctx.tasks, target.threadKey);
      const workerRole = normalizeWorkerRole(target.recipient);

      if (workerRole === "QA") {
        const qaGate = canDispatchQA(target, ctx, threadTasks);
        if (!qaGate.allowed) {
          const skipReason = qaGateToDispatchSkipReason(qaGate.reason);
          if (
            this._shouldEmitDispatchWait(
              `qa:${filename}:${skipReason}:${qaGate.detail ?? ""}`,
            )
          ) {
            this._panelEvents?.emit("codeflowmu.dispatch_skipped", {
              event: "dispatch_skipped",
              reason: skipReason,
              detail: qaGate.detail,
              waiting_on: qaGate.waiting_on,
              execution_state: qaGate.execution_state,
              task_path: filepath,
              filename,
              role: recipient,
              at: toLocalIsoString(this._now()),
            });
            this._logger.info(
              `[TaskDispatcher] qa_dispatch_blocked ${filename}: ${skipReason}${qaGate.detail ? ` (${qaGate.detail})` : ""}`,
            );
          }
          return {
            kind: "dispatch_skipped",
            reason: skipReason,
            detail: qaGate.detail,
            waiting_on: qaGate.waiting_on,
            execution_state: qaGate.execution_state,
          };
        }
      } else {
        const gate = evaluateDispatchEligibility(
          target,
          threadTasks,
          ctx.reports,
        );
        const explicitDeps = parsedForGate
          ? collectDependencyTaskIds(parsedForGate)
          : [];
        if (
          !gate.allowed &&
          !(
            gate.reason === "waiting_dependency" && explicitDeps.length > 0
          )
        ) {
          const skipReason =
            gate.reason === "waiting_dependency"
              ? "waiting_dependency"
              : gate.reason === "already_active"
                ? "already_active"
                : gate.reason === "already_done"
                  ? "already_done"
                  : "task_not_dispatched";
          const shouldEmit =
            skipReason !== "waiting_dependency" ||
            this._shouldEmitDispatchWait(
              `gate:${filename}:${skipReason}:${gate.detail ?? ""}`,
            );
          if (shouldEmit) {
            this._panelEvents?.emit("codeflowmu.dispatch_skipped", {
              event: "dispatch_skipped",
              reason: skipReason,
              detail: gate.detail,
              waiting_on: gate.waitingOn,
              task_path: filepath,
              filename,
              role: recipient,
              at: toLocalIsoString(this._now()),
            });
            this._logger.info(
              `[TaskDispatcher] dispatch_skipped ${filename}: ${skipReason}${gate.detail ? ` (${gate.detail})` : ""}`,
            );
          }
          return {
            kind: "dispatch_skipped",
            reason: skipReason,
            detail: gate.detail,
            waiting_on: gate.waitingOn,
          };
        }
      }
    }

    const outcome = await this._dispatch(filepath, filename, recipient, {
      controlPlane: options,
    });
    if (outcome.kind === "dependency_pending") {
      return outcome;
    }
    await this._applyDispatchOutcome(filepath, filename, recipient, outcome);
    return outcome;
  }

  /** ADMIN 决策：清除 waiting 并立即重新投递。 */
  async adminRetryDispatch(
    filepath: string,
    filename: string,
    recipient: string,
    retryKey: string,
  ): Promise<DispatchOutcome> {
    const rec = this._dispatchRetryRegistry.adminRetry(retryKey);
    if (!rec) {
      return {
        kind: "no_task_id",
        reason: `no dispatch retry record for ${retryKey}`,
      };
    }
    await this._restoreDispatchedToInbox(filepath, filename, "admin_retry", retryKey).catch(
      () => undefined,
    );
    return this.dispatchTaskFromControlPlane(
      filepath,
      filename,
      recipient,
      "admin_retry",
    );
  }

  /** ADMIN 决策：强制归档，停止一切自动重试。 */
  async adminForceArchiveDispatch(
    filepath: string,
    retryKey: string,
  ): Promise<void> {
    const rec = this._dispatchRetryRegistry.adminForceArchive(retryKey);
    if (!rec) return;
    await this._appendHistory(filepath, {
      at: toLocalIsoString(this._now()),
      by: "admin",
      from: "dispatched",
      to: "admin_force_archive",
      note: `${rec.lastError} (failure_count=${rec.failureCount}, retry_round=${rec.retryRound})`,
    }).catch(() => undefined);
  }

  private _fallbackRetryKey(recipient: string, filename: string): string {
    return `${recipient}:${filename.replace(/\.md$/i, "")}`;
  }

  private async _retryKeyForAdhocItem(item: AdhocQueueItem): Promise<string> {
    const taskId = item.filename.replace(/\.md$/i, "");
    const candidates = await this._registry.list({ role: item.recipient }).catch(() => []);
    const agent = candidates[0];
    if (agent) {
      return `${agent.protocol.agent_id}:${taskId}`;
    }
    return this._fallbackRetryKey(item.recipient, item.filename);
  }

  private _transientDispatchOutcome(
    retryKey: string,
    err: Error,
    meta: import("../_internal/dispatch-failure.ts").NormalizeDispatchFailureOptions & {
      filepath?: string;
      task_id?: string;
    } = {},
  ): DispatchOutcome {
    const rec = this._dispatchRetryRegistry.recordTransientFailure(retryKey, err, meta);
    if (rec.decisionRequired) {
      return {
        kind: "waiting_admin_decision",
        reason: rec.lastError,
        failure_count: rec.failureCount,
        retry_key: retryKey,
      };
    }
    return {
      kind: "retry_waiting",
      reason: rec.lastError,
      next_retry_at: rec.nextRetryAt ?? this._now().getTime(),
      failure_count: rec.failureCount,
      retry_key: retryKey,
    };
  }

  private _retryableStartFailureOutcome(
    retryKey: string,
    err: Error,
    meta: { filepath?: string; task_id?: string } = {},
  ): DispatchOutcome {
    const rec = this._dispatchRetryRegistry.recordFailure(retryKey, err, {
      ...meta,
      retryable: true,
    });
    if (rec.decisionRequired) {
      return {
        kind: "waiting_admin_decision",
        reason: rec.lastError,
        failure_count: rec.failureCount,
        retry_key: retryKey,
      };
    }
    return {
      kind: "retry_waiting",
      reason: rec.lastError,
      next_retry_at: rec.nextRetryAt ?? this._now().getTime(),
      failure_count: rec.failureCount,
      retry_key: retryKey,
    };
  }

  private _scheduleDispatchRetry(
    filepath: string,
    filename: string,
    recipient: string,
    retryKey: string,
    nextRetryAt: number,
    note: string,
  ): void {
    const rawDelay = Math.max(0, nextRetryAt - this._now().getTime());
    const delay = Math.max(rawDelay, this._minScheduleRetryDelayMs);
    if (this._dispatchRetryHook) {
      const colon = retryKey.indexOf(":");
      if (colon > 0) {
        const agentId = retryKey.slice(0, colon);
        const taskId = retryKey.slice(colon + 1);
        try {
          this._dispatchRetryHook({ agentId, taskId, delayMs: delay, note });
        } catch {
          /* hook must not break dispatch */
        }
      }
    }
    this._logger.info(
      `[TaskDispatcher] defer retry for ${filename} in ${Math.ceil(delay / 1000)}s (${note})`,
    );
    setTimeout(() => {
      void (async () => {
        if (this._dispatchRetryRegistry.shouldDeferRestore(retryKey)) {
          const rec = this._dispatchRetryRegistry.get(retryKey);
          if (rec && !rec.decisionRequired && rec.nextRetryAt != null) {
            this._scheduleDispatchRetry(
              filepath,
              filename,
              recipient,
              retryKey,
              rec.nextRetryAt,
              note,
            );
          }
          return;
        }
        await this._restoreDispatchedToInbox(filepath, filename, note);
        const priority = await this._readPriority(filepath);
        this._enqueueUniqueSorted({
          filepath,
          filename,
          recipient,
          priority,
          enqueuedAt: this._now().toISOString(),
        });
        void this._onSessionSettled();
      })().catch((err) => {
        this._logger.warn(
          `[TaskDispatcher] scheduled retry failed for ${filename}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }, delay);
  }

  private async _resolveExplicitHoldReason(
    filepath: string,
    sender: string,
    recipient: string,
    filename: string,
  ): Promise<ExplicitDispatchHoldReason | null> {
    let protocol: string | undefined;
    let fmSender: string | undefined;
    let parent: string | undefined;
    let parentTaskId: string | undefined;
    let reworkOf: string | undefined;
    try {
      const raw = await fs.readFile(filepath, "utf-8");
      const fm = parseMarkdownFrontmatter(raw);
      protocol = strField(fm, "protocol") || undefined;
      fmSender = strField(fm, "sender") || undefined;
      parent = strField(fm, "parent") || undefined;
      parentTaskId = strField(fm, "parent_task_id") || undefined;
      reworkOf = strField(fm, "rework_of") || undefined;
    } catch {
      /* filename-only fallback */
    }

    return resolveExplicitDispatchHoldReason({
      sender,
      recipient,
      filename,
      protocol,
      fmSender,
      parent,
      parentTaskId,
      reworkOf,
    });
  }

  private async _registerHeldInboxTask(
    filepath: string,
    filename: string,
    filenameRecipient: string,
    holdReason: ExplicitDispatchHoldReason,
  ): Promise<DispatchOutcome> {
    if (_isObserverRole(filenameRecipient)) {
      return { kind: "observer_bypass", recipient: filenameRecipient };
    }

    const holdMarker = `reason=${holdReason}; awaiting explicit dispatch_task`;
    if (this._registeringHeldPaths.has(filepath)) {
      return { kind: "held_in_inbox", reason: holdReason };
    }
    this._registeringHeldPaths.add(filepath);

    try {
      const raw = await fs.readFile(filepath, "utf-8");
      const currentState = _parseFmState(raw) ?? "inbox";
      if (currentState !== "inbox") {
        this._logger.info(
          `[TaskDispatcher] skip hold ${filename} — state="${currentState}" (not inbox)`,
        );
        return { kind: "already_dispatched" };
      }

      // Reconciliation runs periodically. Once this exact hold is durable,
      // later scans must be silent; otherwise appending history retriggers the
      // watcher and the task file grows forever.
      if (raw.includes(holdMarker)) {
        return { kind: "held_in_inbox", reason: holdReason };
      }

      this._panelEvents?.emit("codeflowmu.task_held", {
        event: "task_held",
        reason: holdReason,
        task_path: filepath,
        filename,
        role: filenameRecipient,
        at: toLocalIsoString(this._now()),
      });
      this._logger.info(
        `[TaskDispatcher] held ${filename} in inbox — ${holdMarker}`,
      );

      await this._appendHistory(filepath, {
        at: toLocalIsoString(this._now()),
        by: "runtime",
        from: "inbox",
        to: "held",
        note: holdMarker,
      }).catch(() => undefined);

      return { kind: "held_in_inbox", reason: holdReason };
    } catch {
      return { kind: "parse_failed", reason: "task file unreadable" };
    } finally {
      this._registeringHeldPaths.delete(filepath);
    }
  }

  private async _resolveAgentForRecipient(
    recipient: string,
    preferredAgentId?: string,
  ): Promise<
    | { agent: Awaited<ReturnType<AgentRegistry["list"]>>[number] }
    | { kind: "agent_not_found"; recipient: string; reason?: string }
  > {
    const candidates = await this._registry.list({ role: recipient });
    if (preferredAgentId) {
      const pinned = candidates.find((c) => c.protocol.agent_id === preferredAgentId);
      if (!pinned) {
        return {
          kind: "agent_not_found",
          recipient,
          reason: `preferred agent ${preferredAgentId} not registered for role ${recipient}`,
        };
      }
      return { agent: pinned };
    }
    const agent = candidates[0];
    if (!agent) {
      return { kind: "agent_not_found", recipient };
    }
    return { agent };
  }

  private async _dispatch(
    filepath: string,
    filename: string,
    filenameRecipient: string,
    opts: {
      silentAlreadyDispatched?: boolean;
      controlPlane?: DispatchControlPlaneOptions;
    } = {},
  ): Promise<DispatchOutcome> {
    const cp = opts.controlPlane;
    if (_isObserverRole(filenameRecipient)) {
      return { kind: "observer_bypass", recipient: filenameRecipient };
    }

    // Step 1: parse.
    let parsed;
    try {
      parsed = await this._parser.parse(filepath);
    } catch (err) {
      const reason =
        err instanceof TaskParseError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this._logger.warn(
        `[TaskDispatcher] parse failed for ${filename}: ${reason}`,
      );
      return { kind: "parse_failed", reason };
    }

    const recipient = parsed.recipient ?? filenameRecipient;
    if (_isObserverRole(recipient)) {
      return { kind: "observer_bypass", recipient };
    }

    const taskId = resolveCanonicalTaskId(filename, parsed);
    if (!taskId) {
      return {
        kind: "no_task_id",
        reason: "neither frontmatter.task_id nor filename yielded a task_id",
      };
    }

    if (this._projectRoot) {
      let queueFile = await loadAgentTaskQueue(this._projectRoot);
      if (isTaskPaused(queueFile, taskId)) {
        this._logger.info(
          `[TaskDispatcher] skip ${filename} — dispatch_status=paused`,
        );
        return {
          kind: "dispatch_skipped",
          reason: "task_not_dispatched",
          detail: "task paused by admin",
        };
      }
      const resolvedForQueue = await this._resolveAgentForRecipient(
        recipient,
        cp?.preferredAgentId,
      );
      if (!("agent" in resolvedForQueue)) {
        /* fall through — _dispatch will record agent_not_found after claim */
      } else {
        const agent = resolvedForQueue.agent;
        const agentId = agent.protocol.agent_id;
        if (
          process.env["CODEFLOW_OPEN_EDITION"] === "1" &&
          String(agent.protocol.sdk_agent_id ?? "").startsWith("sdk-fake-")
        ) {
          return {
            kind: "agent_not_found",
            recipient,
            reason: "AI provider is not configured; task remains in inbox",
          };
        }
        const activeSessions = await this._sessionManager.listActive();
        const liveSession = activeSessions.find(
          (s) => s.protocol.agent_id === agentId,
        );
        queueFile = await this._reconcilePersistentAgentQueue(
          agentId,
          liveSession,
          taskId,
          filepath,
        );
        if (
          liveSession &&
          normalizeQueueTaskId(String(liveSession.protocol.task_id ?? "")) ===
            normalizeQueueTaskId(taskId)
        ) {
          return { kind: "already_dispatched" };
        }
        if (isTaskQueuedInState(queueFile, taskId)) {
          this._logger.info(
            `[TaskDispatcher] skip ${filename} — already in agent FIFO queue`,
          );
          return { kind: "already_dispatched" };
        }
        if (liveSession) {
          await withAgentTaskQueue(this._projectRoot, (file) => {
            enqueueAgentTask(file, {
              task_id: taskId,
              agent_id: agentId,
              reason: "agent_busy_live_session",
              filepath,
              filename,
              recipient,
            });
          });
          this._logger.info(
            `[TaskDispatcher] agent busy — FIFO queued ${filename} for ${agentId}`,
          );
          return {
            kind: "rejected_busy",
            recipient,
            status: "running",
          };
        }
      }
    }

    // Sprint-L1 — Step 1b: atomically claim inbox state.
    // Read frontmatter `state` (absent = "inbox").  If it is already
    // "dispatched" or "done", another concurrent handler got here first —
    // return early without starting a second session.  Otherwise rewrite
    // the frontmatter to "dispatched" before proceeding so any subsequent
    // duplicate event finds a non-inbox state and bails out.
    const claimPath = _queuePathKey(filepath);
    if (this._claimingPaths.has(claimPath)) {
      this._logger.info(
        `[TaskDispatcher] skip ${filename} — claim already in progress`,
      );
      return { kind: "already_dispatched" };
    }
    this._claimingPaths.add(claimPath);
    try {
      const raw = await fs.readFile(filepath, "utf-8");
      const currentState = _parseFmState(raw) ?? "inbox";
      if (!_isDispatchClaimableState(currentState)) {
        if (!opts.silentAlreadyDispatched) {
          this._logger.info(
            `[TaskDispatcher] skip ${filename} — state="${currentState}" (not claimable)`,
          );
        }
        return { kind: "already_dispatched" };
      }
      await fs.writeFile(filepath, _patchFmState(raw, "dispatched"), "utf-8");
    } catch (claimErr) {
      this._logger.warn(
        `[TaskDispatcher] claim write failed for ${filename}: ${
          claimErr instanceof Error ? claimErr.message : String(claimErr)
        } — skipping to avoid double-dispatch`,
      );
      return { kind: "already_dispatched" };
    } finally {
      // Release the in-process lock; the durable guard is now the frontmatter.
      this._claimingPaths.delete(claimPath);
    }

    const resolved = await this._resolveAgentForRecipient(
      recipient,
      cp?.preferredAgentId,
    );
    if (!("agent" in resolved)) {
      this._logger.warn(
        `[TaskDispatcher] no agent registered for role="${recipient}" (task=${filename})` +
          (resolved.reason ? `: ${resolved.reason}` : ""),
      );
      return {
        kind: "agent_not_found",
        recipient: resolved.recipient,
        ...(resolved.reason ? { reason: resolved.reason } : {}),
      };
    }
    const agent = resolved.agent;

    const retryKey = `${agent.protocol.agent_id}:${taskId}`;

    if (this._dispatchRetryRegistry.isForceArchived(retryKey)) {
      return { kind: "force_archived", retry_key: retryKey };
    }
    const pendingRetry = this._dispatchRetryRegistry.get(retryKey);
    if (pendingRetry?.decisionRequired && !pendingRetry.forceArchived) {
      return {
        kind: "waiting_admin_decision",
        reason: pendingRetry.lastError,
        failure_count: pendingRetry.failureCount,
        retry_key: retryKey,
      };
    }

    // Step 4: hand off to SessionManager.
    // Prepend a role-context header so the agent knows its identity and
    // what tools are available (fcop-mcp write_task / write_report /
    // write_issue) before it reads the task body. The header is terse —
    // the full role spec is in `.cursor/rules/<role>-bridge.mdc` which
    // Cursor IDE loads automatically for local agents.
    const contextPrefix = await _buildRoleContextPrefixAsync(
      agent.protocol.agent_id,
      agent.protocol.role ?? "UNKNOWN",
      taskId,
      parsed.body,
      this._projectRoot,
      parsed.thread_key,
      parsed.frontmatter,
    );
    const dispatchRole = agent.protocol.role ?? "UNKNOWN";
    const pmSelfReportOnly = isPmSelfReportOnlyContext(
      dispatchRole,
      parsed.body,
    );
    const pinnedPrefix =
      normalizeWriteReportTaskIdPrefix(taskId) ||
      extractTaskIdPrefixFromFilepath(filepath);

    let bodyWithAttachments: string;
    let sessionImages: import("../registry/AgentSdkAdapter.ts").SessionSdkImage[] =
      [];
    if (cp?.sessionTextOverride !== undefined) {
      bodyWithAttachments = cp.sessionTextOverride;
      sessionImages = cp.sessionImagesOverride ?? [];
    } else {
      let attachmentBlock = "";
      if (this._projectRoot) {
        const attachments = await resolveTaskAttachmentsForDispatch(
          this._projectRoot,
          parsed.frontmatter,
          filename,
        );
        attachmentBlock = formatTaskAttachmentPromptBlock(attachments);
        sessionImages = await buildSessionImagesFromTaskAttachments(
          this._projectRoot,
          attachments,
        );
      }
      bodyWithAttachments = attachmentBlock
        ? `${parsed.body}\n\n${attachmentBlock}`
        : parsed.body;
    }

    let resumeBlock = "";
    if (this._projectRoot) {
      const queueFile = await loadAgentTaskQueue(this._projectRoot);
      const agentId = agent.protocol.agent_id;
      const slot = queueFile.agents[agentId];
      const queued = slot?.queue.find(
        (q) =>
          q.task_id.replace(/\.md$/i, "").toUpperCase() === taskId.toUpperCase(),
      );
      if (queued?.resume_dispatch) {
        resumeBlock = `\n\n${RESUME_EXECUTION_PROMPT_ZH}`;
      }
    }

    // The runtime, not the agent, owns the physical inbox→active transition.
    // Keep the resolved path so session context, history, settlement and panel
    // events all point at the canonical active file after the atomic rename.
    let executionFilepath = filepath;
    if (this._lifecycleGovernor) {
      executionFilepath =
        await this._lifecycleGovernor.awaitDispatchInboxToActive(filepath);
    }

    const payload: SessionStartPayload = {
      text: `${contextPrefix}${resumeBlock}\n\n${bodyWithAttachments}`,
      context: {
        task_filepath: executionFilepath,
        task_filename: filename,
        frontmatter: parsed.frontmatter,
        ...(pmSelfReportOnly && pinnedPrefix
          ? {
              pinned_task_id: pinnedPrefix,
              pm_self_report_only: true,
            }
          : {}),
      },
      ...(sessionImages.length > 0 ? { images: sessionImages } : {}),
      ...(cp?.maxToolRounds != null ? { maxToolRounds: cp.maxToolRounds } : {}),
    };

    let sessionId: string;
    try {
      const handle = await this._sessionManager.startSession(
        agent.protocol.agent_id,
        taskId,
        payload,
      );
      sessionId = handle.session_id;
      this._dispatchRetryRegistry.clear(retryKey);
      if (this._projectRoot) {
        await withAgentTaskQueue(this._projectRoot, (file) => {
          setAgentRunning(file, agent.protocol.agent_id, {
            task_id: taskId,
            session_id: sessionId,
            started_at: this._now().toISOString(),
          });
        });
      }
    } catch (err) {
      if (err instanceof InvalidAgentStatusError) {
        this._logger.warn(
          `[TaskDispatcher] agent ${agent.protocol.agent_id} busy ` +
            `(status=${err.attemptedStatus}); rejecting ${filename}`,
        );
        return {
          kind: "rejected_busy",
          recipient,
          status: err.attemptedStatus,
        };
      }
      if (
        err instanceof SdkCooldownActiveError ||
        err instanceof TransientSdkDelayedError
      ) {
        const cause =
          err instanceof TransientSdkDelayedError && err.cause instanceof Error
            ? err.cause
            : err;
        return this._transientDispatchOutcome(
          retryKey,
          cause instanceof Error ? cause : new Error(String(cause)),
          { filepath, task_id: taskId },
        );
      }
      if (err instanceof Error && isTransientSdkError(err)) {
        return this._transientDispatchOutcome(retryKey, err, { filepath, task_id: taskId });
      }
      const reason = err instanceof Error ? err.message : String(err);
      this._logger.error(
        `[TaskDispatcher] startSession failed for ${filename}: ${reason}`,
      );
      return this._retryableStartFailureOutcome(
        retryKey,
        err instanceof Error ? err : new Error(reason),
        { filepath, task_id: taskId },
      );
    }

    // Step 5: record inbox→dispatched and dispatched→running BEFORE
    // subscribing to session events — fast-mock sessions can emit
    // session_ended synchronously and would otherwise reorder bullets.
    const historyAt = () => toLocalIsoString(this._now());
    await this._appendHistory(executionFilepath, {
      at: historyAt(),
      by: "runtime",
      from: "inbox",
      to: "dispatched",
      note: `session_id=${sessionId}`,
    }).catch(() => {
      /* state_history is best-effort */
    });
    await this._appendHistory(executionFilepath, {
      at: historyAt(),
      by: "runtime",
      from: "dispatched",
      to: "running",
      note: `session_id=${sessionId}`,
    }).catch(() => {
      /* state_history is best-effort */
    });

    // Step 6: subscribe to terminal events for this specific session, so
    // we can append `dispatched → ended | cancelled` later. We must
    // capture `unsubscribe` first, THEN read it inside the listener —
    // listeners can fire synchronously from within `onEvent` (unlikely
    // but legal), so the variable must already be initialized.
    const agentId = agent.protocol.agent_id;
    this._runningByAgent.set(agentId, sessionId);

    let unsubscribe: Unsubscribe = () => {};
    const listener = (evt: RuntimeEvent): void => {
      if (evt.session_id !== sessionId) return;
      if (
        evt.event_type !== "runtime.session_ended" &&
        evt.event_type !== "runtime.session_cancelled"
      ) {
        return;
      }
      void this._handleSessionSettlement({
        evt,
        sessionId,
        filepath: executionFilepath,
        filename,
        recipient,
        taskId,
        reportRecipient: parsed.sender ?? "PM",
        agentId,
      });
    };
    unsubscribe = this._sessionManager.onEvent(listener);
    this._pendingSettlements.set(sessionId, {
      unsubscribe,
      filepath: executionFilepath,
      filename,
      recipient,
    });
    void this._recoverMissedTerminalSettlement({
      sessionId,
      filepath: executionFilepath,
      filename,
      recipient,
      taskId,
      reportRecipient: parsed.sender ?? "PM",
      agentId,
    });

    this._panelEvents?.emit("codeflowmu.task_dispatched", {
      event: "task_dispatched",
      task_id: taskId,
      task_path: executionFilepath,
      agent_id: agentId,
      session_id: sessionId,
      role: agent.protocol.role ?? recipient,
      at: toLocalIsoString(this._now()),
    });

    if (
      isPmToWorkerDispatch(parsed.sender, recipient, filename)
    ) {
      this._pmQueueGuard?.onPmDispatchToWorker(parsed.sender, recipient);
      this._panelEvents?.emit("codeflowmu.pm_queue.waiting_downstream", {
        event: "pm_queue_waiting_downstream",
        task_id: taskId,
        downstream_role: recipient,
        sender: parsed.sender ?? "PM",
      });
    }

    return { kind: "dispatched", session_id: sessionId, inboxHistoryRecorded: true };
  }

  private async _handleSessionSettlement(params: {
    evt: RuntimeEvent;
    sessionId: string;
    filepath: string;
    filename: string;
    recipient: string;
    taskId: string;
    reportRecipient: string;
    agentId: string;
  }): Promise<void> {
    const pending = this._pendingSettlements.get(params.sessionId);
    if (!pending) return;
    pending.unsubscribe();
    this._pendingSettlements.delete(params.sessionId);
    this._runningByAgent.delete(params.agentId);

    const toState =
      params.evt.event_type === "runtime.session_ended" ? "ended" : "cancelled";
    const note = describeSettlement(params.evt);
    if (_isWorkerRole(params.recipient)) {
      this._reportGate?.scheduleEnsureReciprocalReport({
        taskId: params.taskId,
        reporter: params.recipient,
        reportRecipient: params.reportRecipient,
        settlementKind:
          params.evt.event_type === "runtime.session_ended"
            ? "session_ended"
            : "session_cancelled",
        settlementNote: note,
        sessionId: params.sessionId,
      });
    }

    await this._appendHistory(params.filepath, {
      at: toLocalIsoString(this._now()),
      by: "runtime",
      from: "dispatched",
      to: toState,
      ...(note ? { note } : {}),
    })
      .catch((err) => {
        if (err instanceof TaskFileNotFoundError) {
          this._logger.warn(
            `[TaskDispatcher] task file vanished before settlement append: ${params.filepath}`,
          );
        } else {
          this._logger.error(
            `[TaskDispatcher] settlement append failed for ${params.filename}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      })
      .then(() =>
        this._maybeRestoreInboxAfterFailedSession(
          params.evt,
          params.filepath,
          params.filename,
        ),
      );

    if (this._projectRoot) {
      void completeAgentTaskAndAdvance({
        projectRoot: this._projectRoot,
        agentId: params.agentId,
        taskId: params.taskId,
        sessionId: params.sessionId,
        dispatcher: this,
      }).catch((err) => {
        this._logger.warn(
          `[TaskDispatcher] agent queue advance failed for ${params.agentId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
  }

  private async _recoverMissedTerminalSettlement(params: {
    sessionId: string;
    filepath: string;
    filename: string;
    recipient: string;
    taskId: string;
    reportRecipient: string;
    agentId: string;
  }): Promise<void> {
    await this._sessionManager.awaitSettled(params.sessionId).catch(() => undefined);
    if (!this._pendingSettlements.has(params.sessionId)) return;
    const record = await this._sessionManager
      .getSession(params.sessionId)
      .catch(() => null);
    if (!record || record.protocol.status === "running") return;

    const run = record.protocol.runs[record.protocol.runs.length - 1];
    const cancelled = record.protocol.status === "cancelled";
    await this._handleSessionSettlement({
      ...params,
      evt: {
        event_id: `${params.sessionId}-${cancelled ? "cancelled" : "ended"}-recovered`,
        at: record.protocol.ended_at ?? toLocalIsoString(this._now()),
        event_type: cancelled ? "runtime.session_cancelled" : "runtime.session_ended",
        session_id: params.sessionId,
        ...(run?.run_id ? { run_id: run.run_id } : {}),
        agent_id: params.agentId,
        payload: {
          status: record.protocol.status,
          task_id: params.taskId,
          started_at: record.protocol.started_at,
          ended_at: record.protocol.ended_at,
          reason: "recovered_missed_terminal_event",
          report_written: false,
        },
      },
    });
  }

  private async _maybeRestoreInboxAfterFailedSession(
    evt: RuntimeEvent,
    filepath: string,
    filename: string,
  ): Promise<void> {
    if (evt.event_type !== "runtime.session_ended") return;
    const payload = evt.payload as
      | {
          status?: string;
          report_written?: boolean;
          failure_code?: string;
          task_id?: string;
          tool_call_count?: number;
          error?: string;
          reason?: string;
        }
      | undefined;
    if (payload?.failure_code === TRANSIENT_SDK_DELAYED) {
      return;
    }
    const st = String(payload?.status ?? "").toLowerCase();
    if (st !== "failed" && st !== "timeout") return;
    if (payload?.report_written === true) return;

    const taskId = String(payload?.task_id ?? "").trim() || filename.replace(/\.md$/i, "");
    const pmWaitingDownstream =
      this._pmQueueGuard?.snapshot().waiting_downstream === true;
    if (
      pmWaitingDownstream &&
      evt.agent_id.toUpperCase().startsWith("PM") &&
      /-ADMIN-to-PM\.md$/i.test(filename)
    ) {
      this._logger.info(
        `[TaskDispatcher] skip inbox restore for ${filename}: PM is waiting downstream`,
      );
      return;
    }
    const retryKey = `${evt.agent_id}:${taskId}`;
    if (this._dispatchRetryRegistry.shouldDeferRestore(retryKey)) {
      return;
    }
    const reason = String(payload?.error ?? payload?.reason ?? `session_${st}`);
    const rec = this._dispatchRetryRegistry.recordFailure(retryKey, new Error(reason), {
      filepath,
      task_id: taskId,
      retryable: true,
    });
    if (Number(payload?.tool_call_count ?? 0) === 0) {
      const opened = zeroToolcallCircuitBreaker.recordFailedZeroToolcall();
      if (opened) {
        this._panelEvents?.emit("codeflowmu.sdk.circuit_open", {
          event: "SDK_CIRCUIT_OPEN",
          agent_id: evt.agent_id,
          task_id: taskId,
          cooldown_ms: 5 * 60_000,
        });
      }
    }
    const recipient = filename.match(/-to-([A-Za-z0-9-]+)/)?.[1] ?? "";
    if (rec.decisionRequired) {
      await this._appendHistory(filepath, {
        at: toLocalIsoString(this._now()),
        by: "runtime",
        from: "dispatched",
        to: "waiting_admin_decision",
        note: `${reason} (attempt ${rec.failureCount})`,
      }).catch(() => undefined);
      return;
    }
    const nextRetryAt = rec.nextRetryAt ?? this._now().getTime();
    if (this._now().getTime() < nextRetryAt) {
      this._scheduleDispatchRetry(
        filepath,
        filename,
        recipient,
        retryKey,
        nextRetryAt,
        `session_${st}`,
      );
      return;
    }

    await this._restoreDispatchedToInbox(
      filepath,
      filename,
      `session_${st}`,
      retryKey,
    );
    await this._appendHistory(filepath, {
      at: toLocalIsoString(this._now()),
      by: "runtime",
      from: "dispatched",
      to: "inbox",
      note: `restored after session ${st} (no REPORT on disk)`,
    }).catch((err) => {
      if (err instanceof TaskFileNotFoundError) {
        this._logger.warn(
          `[TaskDispatcher] task file vanished before inbox-restore history: ${filepath}`,
        );
      } else {
        this._logger.warn(
          `[TaskDispatcher] inbox-restore history append failed for ${filename}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    });
  }

  private async _restoreDispatchedToInbox(
    filepath: string,
    filename: string,
    reason: string,
    retryKey?: string,
  ): Promise<void> {
    const deferKey = retryKey ?? filepath;
    if (this._dispatchRetryRegistry.shouldDeferRestore(deferKey)) {
      return;
    }
    try {
      if (this._lifecycleGovernor) {
        await this._lifecycleGovernor.restoreToInboxAfterDispatchFailure(
          filepath,
          reason,
        );
        this._logger.info(
          `[TaskDispatcher] restored ${filename} to inbox after ${reason} (lifecycle)`,
        );
        return;
      }

      const resolved = await resolveTaskFileForMutation(filepath);
      const raw = await fs.readFile(resolved, "utf-8");
      const state = _parseFmState(raw);
      if (state !== "dispatched" && state !== "active") return;
      await fs.writeFile(resolved, _patchFmState(raw, "inbox"), "utf-8");
      this._logger.info(
        `[TaskDispatcher] restored ${filename} state ${state} -> inbox after ${reason}`,
      );
    } catch (err) {
      this._logger.warn(
        `[TaskDispatcher] failed to restore ${filename} to inbox after ${reason}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async _reconcilePersistentAgentQueue(
    agentId: string,
    liveSession: SessionRecord | undefined,
    currentTaskId: string,
    currentFilepath: string,
  ) {
    const projectRoot = this._projectRoot;
    if (!projectRoot) throw new Error("projectRoot required for queue reconcile");
    const snapshot = await loadAgentTaskQueue(projectRoot);
    const queued = snapshot.agents[agentId]?.queue ?? [];
    const livePaths = new Set<string>();
    await Promise.all(
      queued.map(async (item) => {
        if (!item.filepath) return;
        if (
          await this._isLiveQueuedTaskFile(item.filepath)
        ) {
          livePaths.add(_queuePathKey(item.filepath));
        }
      }),
    );

    const currentPathKey = _queuePathKey(currentFilepath);
    const currentId = normalizeQueueTaskId(currentTaskId);
    return withAgentTaskQueue(projectRoot, (file) => {
      const slot = file.agents[agentId] ?? { running: null, queue: [] };
      file.agents[agentId] = slot;
      slot.running = liveSession
        ? {
            task_id: normalizeQueueTaskId(
              String(liveSession.protocol.task_id ?? ""),
            ),
            session_id: liveSession.protocol.session_id,
            started_at:
              liveSession.protocol.started_at ?? this._now().toISOString(),
          }
        : null;
      slot.queue = slot.queue.filter((item) => {
        const itemPathKey = item.filepath
          ? _queuePathKey(item.filepath)
          : undefined;
        if (itemPathKey && !livePaths.has(itemPathKey)) return false;
        if (!liveSession) {
          if (itemPathKey === currentPathKey) return false;
          if (normalizeQueueTaskId(item.task_id) === currentId) return false;
        }
        return true;
      });
    });
  }

  private async _isLiveQueuedTaskFile(filepath: string): Promise<boolean> {
    if (!_isAdhocInboxPath(filepath, this._watcher.dir)) return false;
    try {
      const raw = await fs.readFile(filepath, "utf-8");
      return _parseFmState(raw) === "inbox";
    } catch {
      return false;
    }
  }

  private async _restoreRejectedBusyToInbox(
    filepath: string,
    filename: string,
  ): Promise<void> {
    try {
      const raw = await fs.readFile(filepath, "utf-8");
      if (_parseFmState(raw) !== "dispatched") return;
      await fs.writeFile(filepath, _patchFmState(raw, "inbox"), "utf-8");
      this._logger.info(
        `[TaskDispatcher] restored ${filename} state dispatched -> inbox after rejected_busy`,
      );
    } catch (err) {
      this._logger.warn(
        `[TaskDispatcher] failed local rejected_busy restore for ${filename}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private _outcomeToEntry(outcome: DispatchOutcome): StateHistoryEntry {
    const at = toLocalIsoString(this._now());
    const by = "runtime";
    switch (outcome.kind) {
      case "dispatched":
        return {
          at,
          by,
          from: "inbox",
          to: "dispatched",
          note: `session_id=${outcome.session_id}`,
        };
      case "parse_failed":
        return {
          at,
          by,
          from: "inbox",
          to: "parse_failed",
          note: outcome.reason,
        };
      case "agent_not_found":
        return {
          at,
          by,
          from: "inbox",
          to: "agent_not_found",
          note: `recipient=${outcome.recipient}`,
        };
      case "rejected_busy":
        return {
          at,
          by,
          from: "inbox",
          to: "rejected_busy",
          note: `recipient=${outcome.recipient}, agent_status=${outcome.status}`,
        };
      case "retry_waiting":
        return {
          at,
          by,
          from: "inbox",
          to: "retry_waiting",
          note: `${outcome.reason} (attempt ${outcome.failure_count}, retry_at=${new Date(outcome.next_retry_at).toISOString()})`,
        };
      case "waiting_admin_decision":
        return {
          at,
          by,
          from: "inbox",
          to: "waiting_admin_decision",
          note: `${outcome.reason} (attempt ${outcome.failure_count})`,
        };
      case "blocked_network":
        return {
          at,
          by,
          from: "inbox",
          to: "waiting_admin_decision",
          note: `${outcome.reason} (attempt ${outcome.failure_count})`,
        };
      case "force_archived":
        return {
          at,
          by,
          from: "dispatched",
          to: "admin_force_archive",
          note: `retry_key=${outcome.retry_key}`,
        };
      case "no_task_id":
        return {
          at,
          by,
          from: "inbox",
          to: "parse_failed",
          note: outcome.reason,
        };
      case "observer_bypass":
        return {
          at,
          by,
          from: "inbox",
          to: "observer_bypass",
          note: `recipient=${outcome.recipient}`,
        };
      case "already_dispatched":
        // This case is handled before _outcomeToEntry is called (early return
        // in _handleInbox), so we should never reach here. Included for
        // exhaustive type safety.
        return { at, by, from: "inbox", to: "already_dispatched" };
      case "dependency_pending":
        return {
          at,
          by,
          from: "inbox",
          to: "dependency_pending",
          note: outcome.reason,
        };
      case "held_in_inbox":
        return {
          at,
          by,
          from: "inbox",
          to: "held",
          note: `reason=${outcome.reason}; awaiting explicit dispatch_task`,
        };
      case "dispatch_skipped":
        return {
          at,
          by,
          from: "inbox",
          to: "dispatch_skipped",
          note: `${outcome.reason}${outcome.detail ? `: ${outcome.detail}` : ""}`,
        };
      case "dispatch_bypass_blocked":
        return {
          at,
          by,
          from: "inbox",
          to: "dispatch_bypass_blocked",
          note: outcome.reason,
        };
    }
  }

  /**
   * Append a state-transition entry.
   *
   * Write path selection (P4-D2 — TASK-20260515-001):
   *
   *   1. **fcop path** — when `fcopClient` was supplied AND exposes an
   *      `appendStateHistory(taskId, entry)` method (planned future API),
   *      the write goes through fcop so the audit trail is owned by the
   *      fcop project layer.
   *
   *   2. **YAML fallback** — in all other cases (no fcopClient, method absent,
   *      or fcop API throws) the existing `StateHistoryWriter.append()` direct-
   *      file path is used.  The fallback is transparent to callers; a `warn`
   *      log is emitted when the fcop call fails so operators know fcop is
   *      degraded without a process crash.
   *
   * NOTE: `appendStateHistory` is NOT yet a public method on
   * `FcopProjectClient` (fcop@1.1.0 Python API does not expose it).  The
   * duck-type guard below means the fcop write path is effectively disabled
   * until that API lands.  The YAML fallback is therefore the only active
   * path today — all existing tests and behaviors are preserved unchanged.
   * See ISSUE filed alongside REPORT-20260515-001-DEV-to-PM.md for the
   * blocking API gap.
   */
  private async _appendHistory(
    filepath: string,
    entry: StateHistoryEntry,
  ): Promise<void> {
    if (entry.to === "rejected_busy") {
      try {
        const historyPath = await resolveTaskFileForMutation(filepath);
        const existing = await fs.readFile(historyPath, "utf-8");
        if (_lastHistoryEntryMatches(existing, entry)) {
          return;
        }
      } catch {
        /* proceed with append */
      }
    }
    if (this._fcopClient) {
      // Duck-type guard: appendStateHistory is a planned (not yet shipped) API.
      const client = this._fcopClient as unknown as {
        appendStateHistory?: (taskId: string, entry: StateHistoryEntry) => Promise<void>;
      };
      if (typeof client.appendStateHistory === "function") {
        try {
          const taskId =
            filepath.split(/[\\/]/).pop()?.replace(/\.md$/, "") ?? filepath;
          await client.appendStateHistory(taskId, entry);
          return;
        } catch (err) {
          this._logger.warn(
            `[TaskDispatcher] fcop appendStateHistory failed for ${filepath}: ${
              err instanceof Error ? err.message : String(err)
            } — degrading to YAML fallback`,
          );
          // Fall through to YAML fallback below.
        }
      }
    }
    // YAML fallback: direct append to the markdown file body.
    const historyPath = await resolveTaskFileForMutation(filepath);
    await this._historyWriter.append(historyPath, entry);
  }

  // ── ADHOC queue helpers ──────────────────────────────────────────────

  /**
   * Insert an item into `_adhocQueue` maintaining priority order
   * (P0 first, then P1, then P2).
   */
  private _enqueueUniqueSorted(item: AdhocQueueItem): void {
    const key = _queuePathKey(item.filepath);
    const existingIdx = this._adhocQueue.findIndex(
      (q) => _queuePathKey(q.filepath) === key,
    );
    if (existingIdx !== -1) {
      const existing = this._adhocQueue.splice(existingIdx, 1)[0]!;
      const priority =
        PRIORITY_WEIGHT[item.priority] < PRIORITY_WEIGHT[existing.priority]
          ? item.priority
          : existing.priority;
      this._insertSorted({
        ...existing,
        ...item,
        priority,
        enqueuedAt: existing.enqueuedAt,
      });
      return;
    }
    this._insertSorted(item);
  }

  private _insertSorted(item: AdhocQueueItem): void {
    const weight = PRIORITY_WEIGHT[item.priority];
    const insertAt = this._adhocQueue.findIndex(
      (q) => PRIORITY_WEIGHT[q.priority] > weight,
    );
    if (insertAt === -1) {
      this._adhocQueue.push(item);
    } else {
      this._adhocQueue.splice(insertAt, 0, item);
    }
  }

  private _pruneStaleAdhocQueue(): void {
    for (let i = this._adhocQueue.length - 1; i >= 0; i -= 1) {
      if (!_isLiveAdhocItemSync(this._adhocQueue[i]!, this._watcher.dir)) {
        this._adhocQueue.splice(i, 1);
      }
    }
  }

  private async _isLiveAdhocItem(item: AdhocQueueItem): Promise<boolean> {
    if (!_isAdhocInboxPath(item.filepath, this._watcher.dir)) return false;
    try {
      const raw = await fs.readFile(item.filepath, "utf-8");
      return _parseFmState(raw) === "inbox";
    } catch {
      return false;
    }
  }

  /**
   * Scan inbox/active for dependency-satisfied `pending_dependency` tasks,
   * patch them to claimable state, and dispatch via the normal pipeline.
   */
  async releasePendingDependencyTasks(): Promise<void> {
    await this._releasePendingDependencyTasks();
  }

  private async _onSessionSettled(): Promise<void> {
    await this._releasePendingDependencyTasks();
    await this._drainAdhocQueue();
  }

  private async _releasePendingDependencyTasks(): Promise<void> {
    if (!this._projectRoot) return;
    const released = await runDependencyReleaseScan({
      projectRoot: this._projectRoot,
      extraScanDirs: [this._watcher.dir],
      parser: { parse: (filepath) => this._parser.parse(filepath) },
      logger: {
        info: (...args: unknown[]) => this._logger.info(String(args[0] ?? ""), ...args.slice(1)),
        warn: (...args: unknown[]) => this._logger.warn(String(args[0] ?? ""), ...args.slice(1)),
        error: (...args: unknown[]) => this._logger.error(String(args[0] ?? ""), ...args.slice(1)),
      },
    });
    await appendDependencyReleaseCycleEvents(this._projectRoot, released);
    for (const task of released) {
      let outcome: DispatchOutcome;
      try {
        outcome = await this.dispatchTaskFromControlPlane(
          task.filepath,
          task.filename,
          task.recipient,
          "dependency_release",
        );
      } catch (err) {
        this._logger.error(
          `[TaskDispatcher] dependency_release dispatch error for ${task.filename}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }
      if (
        outcome.kind === "already_dispatched" ||
        outcome.kind === "held_in_inbox" ||
        outcome.kind === "observer_bypass"
      ) {
        continue;
      }
      if (outcome.kind === "rejected_busy") {
        await this._enqueueRejectedBusy(
          task.filepath,
          task.filename,
          task.recipient,
        );
      }
    }
  }

  /**
   * Attempt to dispatch the highest-priority item from the ADHOC queue.
   * Called on every session_ended / session_cancelled event.
   * If the target agent is still busy the item is re-inserted.
   */
  private async _drainAdhocQueue(): Promise<void> {
    if (this._adhocQueue.length === 0) return;
    if (sdkCooldownRegistry.active) {
      const delay = Math.max(0, sdkCooldownRegistry.untilMs - this._now().getTime());
      setTimeout(() => void this._drainAdhocQueue(), delay || 5_000);
      return;
    }
    let item: AdhocQueueItem | undefined;
    while ((item = this._adhocQueue.shift())) {
      if (await this._isLiveAdhocItem(item)) break;
      this._logger.info(
        `[TaskDispatcher] ADHOC dropped stale item ${item.filename}`,
      );
    }
    if (!item) return;
    const adhocRetryKey = await this._retryKeyForAdhocItem(item);
    if (this._dispatchRetryRegistry.shouldDeferRestore(adhocRetryKey)) {
      const rec = this._dispatchRetryRegistry.get(adhocRetryKey);
      this._enqueueUniqueSorted(item);
      if (rec && !rec.decisionRequired && rec.nextRetryAt != null) {
        setTimeout(
          () => void this._drainAdhocQueue(),
          Math.max(0, rec.nextRetryAt - this._now().getTime()),
        );
      }
      return;
    }
    this._logger.info(
      `[TaskDispatcher] ADHOC drain: retrying ${item.filename} (${item.priority})`,
    );
    let outcome: DispatchOutcome;
    try {
      outcome = await this.dispatchTaskFromControlPlane(
        item.filepath,
        item.filename,
        item.recipient,
        "adhoc_queue",
      );
    } catch (err) {
      this._logger.error(
        `[TaskDispatcher] ADHOC drain error for ${item.filename}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      outcome = this._retryableStartFailureOutcome(
        adhocRetryKey,
        err instanceof Error ? err : new Error(String(err)),
      );
      await this._applyDispatchOutcome(
        item.filepath,
        item.filename,
        item.recipient,
        outcome,
      );
      return;
    }

    if (outcome.kind === "rejected_busy") {
      // Item was popped from the queue; restore + history already applied in control plane.
      this._enqueueUniqueSorted(item);
      this._logger.info(
        `[TaskDispatcher] ADHOC re-queued ${item.filename} (${item.priority}) — agent still busy`,
      );
      return;
    }

    if (outcome.kind === "dependency_pending") {
      this._logger.info(
        `[TaskDispatcher] ADHOC dependency_pending ${item.filename}: ${outcome.reason}`,
      );
    }
    // retry_waiting / waiting_admin_decision / dispatched / etc. already handled
    // by dispatchTaskFromControlPlane → _applyDispatchOutcome.
  }

  /**
   * Parse the `priority` field from a task file's frontmatter.
   * Falls back to "P2" on any error.
   */
  private async _readPriority(filepath: string): Promise<AdHocPriority> {
    try {
      const parsed = await this._parser.parse(filepath);
      return _parsePriority(parsed.frontmatter["priority"]);
    } catch {
      return "P2";
    }
  }
}

/**
 * Build the role-context prefix injected into every agent send payload.
 *
 * Design goals:
 *   - Terse (< 25 lines) — the full role spec is in `.cursor/rules/`.
 *   - Tool-aware — names the fcop-mcp tools the agent MUST use to
 *     write output files instead of just describing what files to write.
 *   - Deterministic — no timestamps / UUIDs so test snapshots stay stable.
 */
function _inferDownstreamRoleFromTaskText(text: string): string | undefined {
  if (isPmDispatchForbiddenBody(text)) return undefined;

  const recipientMatch = text.match(/recipient\s*[:=]\s*["']?(DEV|QA|OPS)\b/i);
  if (recipientMatch) return recipientMatch[1]!.toUpperCase();

  const toMatch = text.match(/\bto-(DEV|QA|OPS)\b/i);
  if (toMatch) return toMatch[1]!.toUpperCase();

  if (/派(?:给|发)?\s*开发/i.test(text)) return "DEV";
  if (/派(?:给|发)?\s*测试/i.test(text)) return "QA";
  if (/派(?:给|发)?\s*运维/i.test(text)) return "OPS";
  return undefined;
}

async function _buildRoleContextPrefixAsync(
  agentId: string,
  role: string,
  taskId: string,
  taskBody: string,
  projectRoot: string | undefined,
  threadKey?: string,
  frontmatter?: Record<string, unknown>,
): Promise<string> {
  let prefix = _buildRoleContextPrefix(agentId, role, taskId, taskBody);
  if (!projectRoot) {
    return prefix;
  }
  const pmSelfExecute = isPmSelfReportOnlyContext(role, taskBody);
  if (role.toUpperCase() === "PM") {
    try {
      await recordProductTaskClassification({
        projectRoot,
        taskId,
        taskBody,
        taskFrontmatter: frontmatter,
      });
    } catch (err) {
      console.warn(
        "[product-governance] classification record failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  try {
    const injected = await resolveAndInjectAgentContextSkills(projectRoot, {
      role,
      message: taskBody,
      intent: "task",
      downstreamRole: pmSelfExecute
        ? undefined
        : _inferDownstreamRoleFromTaskText(taskBody),
      taskId,
      threadKey,
    });
    if (injected.promptBlock) {
      prefix = `${prefix}\n\n${injected.promptBlock}`;
    }
  } catch (err) {
    console.warn(
      "[skill-router] auto_inject failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  try {
    if (!pmSelfExecute) {
      const ledgerPack = await buildLeaderLedgerContextPack({
        projectRoot,
        agentId,
        role,
        taskId,
        threadKey,
        frontmatter,
      });
      if (ledgerPack) {
        prefix = `${prefix}\n\n${ledgerPack}`;
      }
    }
  } catch (err) {
    console.warn(
      "[ledger-context] leader pack failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return prefix;
}

/**
 * Build the role-context prefix injected into every agent send payload.
 *
 * Design goals (v0.3 revision):
 *   - Concrete, not abstract — show the EXACT tool calls for this role,
 *     not just "you have these tools". The agent needs HOW, not WHAT.
 *   - Role-specific playbook — PM gets a dispatch + ack recipe;
 *     DEV/OPS/QA get a do-the-work + report recipe;
 *     REVIEW gets a review + verdict recipe.
 *   - Parameter-complete examples — every tool call shows all required
 *     params with realistic placeholder values.
 *   - Deterministic — no timestamps or UUIDs in the template itself.
 */
function _buildRoleContextPrefix(
  agentId: string,
  role: string,
  taskId: string,
  taskBody?: string,
): string {
  const pmSelfReportOnly =
    !!taskBody && isPmSelfReportOnlyContext(role, taskBody);
  const pmSelfExecute = pmSelfReportOnly;

  const runtimePackLine = pmSelfExecute
    ? pmSelfReportOnly
      ? `- run_mode: **pm_self_report_only** — 仅 \`write_report\`（可选 \`read_file\`/\`grep_files\` 读 TASK 指定冻结锚点）；**禁止** \`write_task\` / \`create_task\` / 派发 DEV|OPS|QA；**不要**读 \`PM.todo.md\`。仅对 \`${taskId}\` 写一次最终 \`write_report(status=done)\`（ack-only 不算完成）。`
      : `- **PM self-execute Hot Path**：**不要**读取 \`PM.todo.md\`（除非 TASK 正文明确要求）；**禁止** \`write_task\` 派下游。仅对 \`${taskId}\` 写最终 \`write_report(status=done)\`。`
    : `- Pre-loaded when available: \`fcop/ledger/views/${role.toUpperCase()}.todo.md\`, related TASK/REPORT/Issue bodies from frontmatter, and recent \`journal.jsonl\` lines for this thread.`;

  const header = `\
You are **${agentId}** (role: ${role}). Task ID: **${taskId}**.

## FCoP Rule 6 · 必须回执（成功与失败皆然）
- **结束前必须**调用 \`write_report\` 给 PM（或 TASK 发件人）。**沉默 = 违约**。
- **失败 / 阻塞 / 工具报错 / 被取消**：仍须 \`write_report\`，正文说明原因；\`status\` 用 \`blocked\` 或 \`aborted\`（若 MCP 支持）。
- \`write_issue\` **不能代替** \`write_report\` — Issue 是补充，不是回执。

## FCoP v3 · task-report 热路径（CodeFlowMu 2.0 速度）
- **TASK 正文已在下方 payload** — 不要为开工调用 \`read_task\` 或 \`claim_task\`。
- **完成信号**：写 \`REPORT-*.md\` 到 \`fcop/reports/\`（\`write_report\`）。
- **生命周期目录**（\`_lifecycle/inbox|active|review|done\`）由 Node Runtime **异步**维护；Python MCP 仅用于诊断/校验，**不得阻塞执行**。
- 可选治理（异步、失败可忽略）：\`submit_review\`（执行者）→ \`approve_review\` / \`archive_task\`（授权角色）；**勿**默认 \`finish_task\` 跳过 review/done。

## Runtime context pack
${runtimePackLine}
- For **other** ledger docs not pre-loaded: \`read_task\` / \`read_report\` / \`list_issues\` (PM/leader); executors must not re-read the current task below.
- Governance config: Gemini \`write_file\` (allowlist \`.codeflowmu/\`, \`docs/skills/\`) for panel-ui-lang and skill manifests.
- Network is a basic capability for every role: use \`web_search\` for discovery, \`web_extract\` for source text/tables or dynamic Playwright extraction, and \`web_research\` for multi-source evidence. For dynamic pages, set explicit quality gates such as \`required_texts\`, \`min_tables\`, or \`min_structured_items\`; a non-empty page alone is not acceptance.

## fcop-mcp · 热路径工具
| Tool | Purpose |
|---|---|
| \`write_report\` | **必须** — 完成回执（REPORT → PM）；失败也要写 |
| \`write_issue\` | 阻塞/风险上报（**补充**，不替代 report） |
| \`write_task\` | PM 派生子任务${pmSelfExecute ? "（**本任务禁止**）" : ""} |
| \`drop_suggestion\` | 协议反馈 |`;

  const playbook = _rolePlaybook(role, taskId, taskBody);
  const skillRouting = buildAgentSkillRoutingBlock();

  const pmCore = role.toUpperCase() === "PM"
    ? `\n\n${buildPmCoreCapabilitiesBlock()}`
    : "";
  return `${header}\n\n${skillRouting}${pmCore}\n\n${playbook}\n\n---`;
}

/** Role-specific playbook: concrete tool-call sequence for this role. */
function _rolePlaybook(role: string, taskId: string, taskBody?: string): string {
  switch (role.toUpperCase()) {
    case "PM":
      if (taskBody && isPmSelfReportOnlyContext("PM", taskBody)) {
        return `\
## Your playbook (PM — pm_self_report_only · 最小闭环)

> run_mode: **pm_self_report_only** — 仅 \`write_report\`；**禁止**一切 \`write_task\` / 派发 DEV|OPS|QA。  
> **This is NOT ADMIN reject Cold Path. This is NOT rework dispatch. Do NOT read PM.todo. Only one final \`write_report(status=done)\` for \`${taskId}\`. Ack-only reports do NOT count as completion.**

**Step 1 — 阅读任务**：当前 TASK 正文已在下方，**不要**对 \`${taskId}\` 再调 \`read_task\` / \`claim_task\`；**不要**读 \`PM.todo.md\`。

**Step 2 — 探针（可选）**:
\`\`\`
read_file / grep_files  # 仅限 TASK 正文指定的冻结锚点
\`\`\`
**禁止** \`fcop_report\` / \`fcop_check\` 触发 Cold Path 或读 PM.todo；**禁止**向 DEV/QA/OPS \`write_task\`。

**Step 3 — 最终回执 ADMIN（一次 done report，禁止 interim ack 循环）**:
\`\`\`
write_report(
  task_id="${taskId}",
  reporter="PM",
  recipient="ADMIN",
  status="done",
  body="## 执行结果\\n<探针证据与 fcop 运行时结论>"
)
\`\`\`

**Step 4 — ${formatPmBuiltinSkillsPlaybookBlock()}**`;
      }
      if (taskBody && isTaskHotPathBody(taskBody)) {
        return `\
## Your playbook (PM — Hot Path · PM 亲自执行)

> **This is NOT ADMIN reject Cold Path. This is NOT rework dispatch. Do NOT dispatch. Do NOT read PM.todo unless explicitly needed. Only produce final report for \`${taskId}\`.**

**Step 1 — 阅读任务**：当前 TASK 正文已在下方，**不要**对 \`${taskId}\` 再调 \`read_task\` / \`claim_task\`。

**Step 2 — 治理与探针（必做）**:
\`\`\`
fcop_report({ lang: "zh" })
fcop_check()
read_file / grep_files  # 按 TASK 正文验证 Agent 运行时与 MCP
\`\`\`
**禁止** 本 Hot Path 任务向 DEV/QA/OPS \`write_task\` 派发子任务。

**Step 3 — 最终回执 ADMIN（一次 done report，禁止 interim ack 循环）**:
\`\`\`
write_report(
  task_id="${taskId}",
  reporter="PM",
  recipient="ADMIN",
  status="done",
  body="## 执行结果\\n<fcop_check 摘要>\\n\\n## 探针证据\\n<read_file/grep 输出>"
)
\`\`\`

**Step 4 — 治理**（异步）：\`submit_review\` → 等 ADMIN \`approve_review\` / \`archive_task\`。

**Step 5 — ${formatPmBuiltinSkillsPlaybookBlock()}**`;
      }
      return `\
## Your playbook (PM — task-report 热路径)

**Step 1 — 阅读任务**：当前 TASK 正文已在下方，**不要**对 \`${taskId}\` 再调 \`read_task\` / \`claim_task\`。
- 其他 TASK/REPORT/Issue：用 \`read_task\`、\`read_report\`、\`list_issues\` 读取未预加载的 ledger 正文。
- 治理配置（\`.codeflowmu/panel-ui-lang.json\`、技能 manifest）：用 \`write_file\`（仅 allowlist 路径）。

**Step 2 — Choose the route（不要写收到类 ack）**:
- 开发 / 实现 / 创建文件 / 修改代码 / UI / 测试类任务：这是 Cold Path，**第一动作就是 Step 3 \`write_task\` 派给 DEV / OPS / QA**；不要先 \`write_report\` 说“已收到”。
- 先读取 \`new_workspace/list_workspaces\` 返回的 \`workspace_mode\` 与 \`artifact_root\`。root 模式的业务代码根就是当前项目根（\`.\`），不得再创建 \`workspace/<slug>\`；multi 模式才使用 \`workspace/<slug>\`。TASK 明确要求新建业务工作区时，只能调用 \`new_workspace(slug, title, description)\`；**禁止用 shell / Python / edit 创建目录或元数据**。\`new_workspace\` 后必须在同一轮立即 \`write_task\`，不得把建目录当作完成。
- 工作区已经存在时，用 \`list_workspaces\` 确认后直接 \`write_task\`，不要重复创建、不要改用 shell。
- 系统检查 / 巡检类任务：PM 可自行 \`fcop_report\` / \`fcop_check\` / \`list_tasks\`，完成后只写一次 \`write_report(status=done)\` 汇总。
- \`write_report\` 只用于最终汇总或明确阻塞，不用于中途 ack。

**Step 3 — Dispatch to the worker role** (pick DEV / OPS / QA based on task content):
**Branch rule**: each dispatch creates a **new** worker TASK. The first \`references\` item must be the current TASK \`${taskId}\`. Existing DEV/QA/OPS tasks elsewhere in the same \`thread_key\` are sibling/history context and must never satisfy \`${taskId}\`.
**Dependency rule**: when QA or OPS validates artefacts produced by a DEV task, include that DEV task in both \`references\` and \`depends_on\`. The runtime must keep QA/OPS queued until the DEV task has a valid \`status=done\` REPORT.
**PM-hub rule**: never hard-code a DEV -> QA -> DEV role cycle. Every worker receives a new PM TASK and returns a REPORT to PM. After each REPORT, PM reads the actual result and decides whether the next new TASK belongs to DEV, QA, OPS, another role, or nobody. A QA REPORT with completed testing and product verdict FAIL closes that QA task, but it does not close the product root; PM normally creates a new DEV correction task that references the QA REPORT, then decides whether a later QA retest is needed.
\`\`\`
write_task(
  sender="PM", recipient="DEV",   # or OPS / QA
  subject="<one-line description of what the worker should do>",
  body="## 背景\\n<why>\\n\\n## 具体要求\\n<what exactly>\\n\\n## 回执要求\\n写 REPORT-*-DEV-to-PM.md",
  priority="P1",                   # inherit from incoming task or downgrade
  references="${taskId}"
)
\`\`\`

需要 DEV→QA 顺序执行时：先调用 \`write_task(recipient="DEV")\` 并保存返回的新 DEV task_id，再调用 \`write_task(recipient="QA")\`；QA 的 \`references\` 必须包含 \`${taskId}\` 和该新 DEV task_id（工具支持 \`depends_on\` 时同步写同一 DEV id）。不得只引用父任务，也不得复用同线程旧 DEV task_id。

**Step 4 — Wait for worker REPORTs in \`fcop/reports/\`, then report to ADMIN**:
\`\`\`
write_report(
  task_id="${taskId}",
  reporter="PM",
  recipient="ADMIN",
  body="## 执行结果\\n<summary>\\n\\n## 子任务回执\\n<list of REPORT filenames>"
)
\`\`\`

**Step 5 — 治理**（异步，勿阻塞）：子任务 REPORT 齐且 PM 汇总 REPORT 后 \`submit_review\`；\`approve_review\` / \`archive_task\` 由 \`done_authority\` / \`archive_authority\` 执行（主线默认 ADMIN）。勿用 \`finish_task\` 代替验收链。

**Step 6 — ${formatPmBuiltinSkillsPlaybookBlock()}**`;

    case "DEV":
    case "OPS":
    case "QA":
      return `\
## Dependency preflight (worker-side insurance)
- Read the task conditions already present in the payload: \`depends_on\`, \`references\`, prerequisites, required REPORTs, and required artefacts.
- Runtime queue/release is the primary system gate. Your first action is a semantic second check: confirm every required upstream REPORT is \`status=done\` and every artefact named by the task is actually accessible.
- If a prerequisite is not ready, **do not perform the work, do not write a blocked/failed REPORT, and do not create an ISSUE**. End this turn with \`DEPENDENCY_PENDING: <missing task/report/artefact>\`. This means "not my turn yet", not a delivery failure. Runtime keeps or restores the task to the waiting queue and releases it when the condition becomes true.
- Write \`status=blocked\` only after prerequisites were satisfied and a real execution blocker occurred during your own assigned work.
- Your input is always a PM TASK. Your output is always a REPORT to PM. Do not directly hand work to another worker role; PM reads your REPORT and creates the next TASK.

## Your playbook (${role} — task-report 热路径)

**Step 1 — 执行**：任务正文已在下方；**禁止**先调 \`claim_task\` 或 \`read_task\`。

**Step 2 — 必须回执 PM（Rule 6）**：无论成功或失败，结束前调用 \`write_report\`。
- 成功：正文写结论与产出。
- 失败 / 阻塞 / 工具报错：正文写原因与已尝试步骤；必要时 \`status: "blocked"\`。
- \`write_issue\` 仅作补充，**不能代替**本步骤。

\`\`\`
write_report(
  task_id="${taskId}",
  reporter="${role}",
  recipient="PM",
  body="## 结论\\n<done | blocked | failed — 必须明确>\\n\\n## 详情\\n<findings / errors / output>\\n\\n## 影响范围\\n<files changed / services restarted>"
)
\`\`\`

**Step 3 — Write an issue if you find a blocker** (skip if no blocker):
\`\`\`
write_issue(
  sender="${role}", recipient="PM",
  subject="[阻塞] <issue title>",
  body="## 现象\\n<what you saw>\\n\\n## 复现步骤\\n<steps>\\n\\n## 建议\\n<fix or workaround>"
)
\`\`\`
（Step 3 不豁免 Step 2 — 有 Issue 仍须 write_report。）

**Step 4 — 治理**（异步）：REPORT 后 \`submit_review\`；勿调用 \`approve_review\` / \`archive_task\`（支线由 PM 验收）。勿用 \`finish_task\`。

执行器必须遵守当前角色工具白名单、项目根目录边界和人工审批门禁。`;

    case "REVIEW":
      return `\
## Your playbook (REVIEW — task-report 热路径)

**Step 1 — 阅读**：任务正文已在下方。

**Step 2 — Write a review report**:
\`\`\`
write_report(
  task_id="${taskId}",
  reporter="REVIEW",
  recipient="PM",
  body="## 判定\\nPASS / FAIL / NEEDS_CHANGE\\n\\n## 发现\\n<list of issues>\\n\\n## 结论\\n<approve or reject with reason>"
)
\`\`\`

**Step 3 — 治理**：\`write_report\` 后由执行者 \`submit_review\`；验收/归档由授权角色 \`approve_review\` / \`archive_task\`（勿 \`finish_task\`）。`;

    default:
      return `\
## Mandatory workflow (task-report)
1. Read the task body below (already loaded — no \`claim_task\` / \`read_task\`).
2. Do the work.
3. \`write_report(task_id="${taskId}", reporter="${role}", recipient="<task sender>", body="<summary>")\`.
4. Async governance: \`submit_review\` after REPORT; \`approve_review\` / \`archive_task\` only if you hold authority. Do not use \`finish_task\` as default.`;
  }
}

function describeSettlement(evt: RuntimeEvent): string | undefined {
  const payload = evt.payload as
    | {
        status?: string;
        error?: string;
        reason?: string;
        failure_code?: string;
      }
    | undefined;
  if (!payload) return undefined;
  if (evt.event_type === "runtime.session_cancelled") {
    return payload.reason ? `reason=${payload.reason}` : undefined;
  }
  if (payload.failure_code === "TURN_LIMIT") {
    return `status=${payload.status ?? "failed"}, failure_code=TURN_LIMIT (escalate via ISSUE-*)`;
  }
  if (payload.error) return `status=${payload.status ?? "?"}, error=${payload.error}`;
  if (payload.status) return `status=${payload.status}`;
  return undefined;
}
