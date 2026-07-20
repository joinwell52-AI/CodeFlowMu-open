/**
 * PmQueueGuard — PM report/governance queue busy-state guard.
 *
 * Prevents "PM处理中" from sticking after session end, guard return, downstream
 * dispatch, or diagnostics-only delays (e.g. file_without_ledger rescan).
 */

export type PmQueuePhase =
  | "idle"
  | "executing"
  | "waiting_downstream"
  | "stale_released";

export type PmQueueReleaseReason =
  | "completed"
  | "failed"
  | "guard_return"
  | "diagnostics_warning"
  | "file_without_ledger"
  | "session_ended"
  | "session_cancelled"
  | "downstream_dispatched"
  | "stale_timeout"
  | "start_failed";

export interface PmQueueSnapshot {
  processing: boolean;
  pm_busy: boolean;
  in_flight: boolean;
  phase: PmQueuePhase;
  waiting_downstream: boolean;
  stale_released: boolean;
  busy_since: number | null;
  last_pm_event_at: number | null;
  downstream_role: string | null;
  stale_released_at: number | null;
  /** Last runtime auto-nudge epoch ms (DOWNSTREAM_AUTO_NUDGE). */
  downstream_auto_nudged_at: number | null;
  /** Earliest next auto-nudge epoch ms for debounce display. */
  downstream_next_nudge_at: number | null;
  /** Child task_id last auto-nudged. */
  downstream_nudge_task_id: string | null;
  downstream_last_wake_session_id: string | null;
}

export interface PmQueueGuardLogger {
  warn?(msg: string): void;
  info?(msg: string): void;
}

export interface PmQueueGuardOpts {
  logger?: PmQueueGuardLogger;
  now?: () => number;
  staleMs?: number;
  onStaleReleased?: (snapshot: PmQueueSnapshot) => void;
}

const WORKER_ROLES = new Set(["DEV", "OPS", "QA"]);

function envStaleMs(fallback: number): number {
  const raw = process.env.PM_QUEUE_STALE_MS;
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 60_000 && n <= 120_000 ? n : fallback;
}

export class PmQueueGuard {
  readonly #log: NonNullable<PmQueueGuardOpts["logger"]>;
  readonly #now: () => number;
  readonly #staleMs: number;
  readonly #onStaleReleased: ((snapshot: PmQueueSnapshot) => void) | undefined;

  #processing = false;
  #inFlight = false;
  #waitingDownstream = false;
  #staleReleased = false;
  #busySince: number | null = null;
  #lastPmEventAt: number | null = null;
  #downstreamRole: string | null = null;
  #staleReleasedAt: number | null = null;
  #autoNudgedAt: number | null = null;
  #nextNudgeAt: number | null = null;
  #nudgeTaskId: string | null = null;
  #lastWakeSessionId: string | null = null;
  #nudgeCountByTask = new Map<string, number>();
  #failedWorkerTasks = new Set<string>();
  #staleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts?: PmQueueGuardOpts) {
    this.#log = opts?.logger ?? {};
    this.#now = opts?.now ?? (() => Date.now());
    this.#staleMs = opts?.staleMs ?? envStaleMs(90_000);
    this.#onStaleReleased = opts?.onStaleReleased;
  }

  startStaleWatch(intervalMs = 15_000): void {
    if (this.#staleTimer) return;
    this.#staleTimer = setInterval(() => {
      this.checkAndReleaseStale();
    }, intervalMs);
    if (typeof this.#staleTimer === "object" && "unref" in this.#staleTimer) {
      this.#staleTimer.unref();
    }
  }

  stopStaleWatch(): void {
    if (!this.#staleTimer) return;
    clearInterval(this.#staleTimer);
    this.#staleTimer = null;
  }

  touchPmEvent(): void {
    this.#lastPmEventAt = this.#now();
    this.#staleReleased = false;
    this.#staleReleasedAt = null;
  }

  acquire(reason: string): void {
    this.touchPmEvent();
    this.#processing = true;
    this.#inFlight = true;
    this.#waitingDownstream = false;
    this.#downstreamRole = null;
    if (this.#busySince == null) {
      this.#busySince = this.#now();
    }
    this.#log.info?.(`[PmQueueGuard] acquire (${reason})`);
  }

  release(reason: PmQueueReleaseReason): void {
    const wasBusy = this.#processing || this.#inFlight;
    this.#processing = false;
    this.#inFlight = false;
    this.#busySince = null;
    if (reason === "stale_timeout") {
      this.#staleReleased = true;
      this.#staleReleasedAt = this.#now();
    }
    if (wasBusy) {
      this.#log.info?.(`[PmQueueGuard] release (${reason})`);
    }
  }

  markWaitingDownstream(role: string, reason = "downstream_dispatched"): void {
    const normalized = role.trim().toUpperCase();
    this.touchPmEvent();
    this.#waitingDownstream = WORKER_ROLES.has(normalized);
    this.#downstreamRole = this.#waitingDownstream ? normalized : null;
    this.#processing = false;
    this.#inFlight = false;
    this.#busySince = null;
    this.#log.info?.(
      `[PmQueueGuard] waiting downstream ${normalized || role} (${reason})`,
    );
  }

  clearWaitingDownstream(): void {
    this.#waitingDownstream = false;
    this.#downstreamRole = null;
  }

  recordAutoNudge(opts: {
    task_id: string;
    role: string;
    nudged_at: number;
    next_nudge_at: number;
    session_id?: string | null;
  }): void {
    const role = opts.role.trim().toUpperCase();
    this.#autoNudgedAt = opts.nudged_at;
    this.#nextNudgeAt = opts.next_nudge_at;
    this.#nudgeTaskId = opts.task_id;
    this.#lastWakeSessionId = opts.session_id ?? null;
    if (!this.#waitingDownstream && WORKER_ROLES.has(role)) {
      this.markWaitingDownstream(role, "downstream_auto_nudge");
    } else if (this.#waitingDownstream && !this.#downstreamRole) {
      this.#downstreamRole = role;
    }
  }

  clearAutoNudge(): void {
    this.#autoNudgedAt = null;
    this.#nextNudgeAt = null;
    this.#nudgeTaskId = null;
    this.#lastWakeSessionId = null;
  }

  /** Increment auto-nudge count for convergence (max nudge guard). */
  bumpNudgeCount(taskId: string): number {
    const norm = taskId.replace(/\.md$/i, "").trim();
    const next = (this.#nudgeCountByTask.get(norm) ?? 0) + 1;
    this.#nudgeCountByTask.set(norm, next);
    return next;
  }

  nudgeCountForTask(taskId: string): number {
    const norm = taskId.replace(/\.md$/i, "").trim();
    return this.#nudgeCountByTask.get(norm) ?? 0;
  }

  clearNudgeCount(taskId: string): void {
    const norm = taskId.replace(/\.md$/i, "").trim();
    this.#nudgeCountByTask.delete(norm);
  }

  markDownstreamWorkerFailed(taskId: string): void {
    const norm = taskId.replace(/\.md$/i, "").trim();
    if (!norm) return;
    this.#failedWorkerTasks.add(norm);
    this.clearWaitingDownstream();
    this.clearAutoNudge();
  }

  isDownstreamWorkerFailed(taskId: string): boolean {
    const norm = taskId.replace(/\.md$/i, "").trim();
    return this.#failedWorkerTasks.has(norm);
  }

  clearDownstreamWorkerFailed(taskId?: string): void {
    if (!taskId) {
      this.#failedWorkerTasks.clear();
      return;
    }
    this.#failedWorkerTasks.delete(taskId.replace(/\.md$/i, "").trim());
  }

  async runGuarded<T>(
    reason: string,
    fn: () => Promise<T>,
    releaseReason: PmQueueReleaseReason = "completed",
  ): Promise<T> {
    this.acquire(reason);
    try {
      return await fn();
    } catch (err) {
      this.release("failed");
      throw err;
    } finally {
      if (this.#processing || this.#inFlight) {
        this.release(releaseReason);
      }
    }
  }

  onPmSessionStarted(agentId: string): void {
    if (!/^PM/i.test(agentId)) return;
    this.acquire(`session_started:${agentId}`);
  }

  onPmSessionEnded(agentId: string, reason: PmQueueReleaseReason): void {
    if (!/^PM/i.test(agentId)) return;
    this.release(reason);
    if (!this.#waitingDownstream) {
      this.clearWaitingDownstream();
    }
  }

  onPmDispatchToWorker(sender: string | undefined, recipient: string | undefined): void {
    const s = String(sender ?? "").trim().toUpperCase();
    const r = String(recipient ?? "").trim().toUpperCase();
    if (s !== "PM" || !WORKER_ROLES.has(r)) return;
    this.markWaitingDownstream(r, "pm_dispatched_worker_task");
  }

  checkAndReleaseStale(): boolean {
    if (!this.#processing && !this.#inFlight) return false;
    const now = this.#now();
    const anchor = this.#lastPmEventAt ?? this.#busySince;
    if (anchor == null) return false;
    if (now - anchor < this.#staleMs) return false;

    const snapshot = this.snapshot();
    this.release("stale_timeout");
    const msg =
      `[PmQueueGuard] PM_QUEUE_STALE_RELEASED: busy ${Math.round((now - anchor) / 1000)}s without PM events`;
    this.#log.warn?.(msg);
    this.#onStaleReleased?.(snapshot);
    return true;
  }

  snapshot(): PmQueueSnapshot {
    const executing = this.#processing || this.#inFlight;
    const pmBusy = executing && !this.#waitingDownstream;
    let phase: PmQueuePhase = "idle";
    if (this.#staleReleased && !executing) {
      phase = "stale_released";
    } else if (this.#waitingDownstream) {
      phase = "waiting_downstream";
    } else if (executing) {
      phase = "executing";
    }

    return {
      processing: this.#processing,
      pm_busy: pmBusy,
      in_flight: this.#inFlight,
      phase,
      waiting_downstream: this.#waitingDownstream,
      stale_released: this.#staleReleased,
      busy_since: this.#busySince,
      last_pm_event_at: this.#lastPmEventAt,
      downstream_role: this.#downstreamRole,
      stale_released_at: this.#staleReleasedAt,
      downstream_auto_nudged_at: this.#autoNudgedAt,
      downstream_next_nudge_at: this.#nextNudgeAt,
      downstream_nudge_task_id: this.#nudgeTaskId,
      downstream_last_wake_session_id: this.#lastWakeSessionId,
    };
  }
}

export function isPmToWorkerDispatch(
  sender: string | undefined,
  recipient: string | undefined,
  filename?: string,
): boolean {
  const s = String(sender ?? "").trim().toUpperCase();
  const r = String(recipient ?? "").trim().toUpperCase();
  if (s === "PM" && WORKER_ROLES.has(r)) return true;
  if (filename && /-PM-to-(DEV|OPS|QA)\.md$/i.test(filename)) return true;
  return false;
}
