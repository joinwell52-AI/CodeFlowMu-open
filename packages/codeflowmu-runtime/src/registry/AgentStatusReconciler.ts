/**
 * AgentStatusReconciler — v0.1 integration-layer hook that keeps the
 * persisted `Agent.status` in sync with the SessionManager lifecycle.
 *
 * Why this file exists (REPORT-20260509-018 §五决策 B'):
 *
 * Phase B's `SessionManager.startSession` deliberately does NOT mutate
 * `record.protocol.status` to `"running"` — that would tangle the session
 * layer with registry write semantics (and create a double-write across
 * `agents.json` + the new SessionRecord, with the attendant rollback
 * complications). The Phase B decision was: SessionManager is *only*
 * responsible for the session record + transcript; *somebody else* must
 * promote `agent.status` if v0.1 wants the doorbell `reject_busy` path
 * (TaskDispatcher's `InvalidAgentStatusError` branch) to ever fire on
 * a real concurrent dispatch.
 *
 * Phase C left the gap visible (TaskDispatcher TS-5.13 had to manually
 * write `agents.json` to simulate `running` status). S4 closes it via
 * this Reconciler — a thin observer that listens to the SessionManager
 * event bus and toggles `agent.status` between `idle` and `running`
 * without touching the SessionManager surface.
 *
 * Scope (TASK-20260509-022 §主交付 3'):
 *
 *   1. `runtime.session_started`            → status: "running"
 *   2. `runtime.session_ended`              → status: "idle"
 *   3. `runtime.session_cancelled`          → status: "idle"
 *
 * Invariants:
 *
 * - This is an integration-LAYER hook. It does NOT modify `SessionManager`
 *   or `AgentRegistry` source — both Phase B/C contracts stay frozen.
 * - Only mutates an agent that the registry already knows about. If
 *   `registry.get(agentId)` returns `null` (which means the agent has been
 *   deleted between session_started and session_ended), the reconciler
 *   logs a warning and skips. v0.1 deletion of running agents is
 *   not a supported flow (would need an emergency-stop kind of UX).
 * - If the agent's current status is already what we want, no write is
 *   issued (idempotent — important for the cancelled-after-ended replay
 *   pathological case).
 * - If `register.upsert` (via PersistentStore) throws, the error is logged
 *   but NOT re-thrown — a one-off failure here must not crash the runtime.
 *   The next state transition will retry. The cost is: in a crash window
 *   the on-disk status may be stale; that's acceptable per crash-recovery.md
 *   decision 3 (RuntimeBootstrap reconciles on next startup).
 *
 * Reference:
 *   - REPORT-20260509-018 §五决策 B'
 *   - TASK-20260509-022 §主交付 3'
 *   - design doc §0.9.1 + §3.2 (agent.status state machine)
 */

import type { AgentRegistry } from "./AgentRegistry.ts";
import type { PersistentStore } from "./PersistentStore.ts";
import type {
  AgentRecord,
  RuntimeEvent,
  Unsubscribe,
} from "../types/state.ts";
import type { SessionManager } from "../session/SessionManager.ts";

export interface AgentStatusReconcilerLogger {
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

export interface AgentStatusReconcilerOptions {
  sessionManager: SessionManager;
  /**
   * Used to look up the AgentRecord by `agent_id` for each event. The
   * registry is the source of truth for the *current* status; we never
   * synthesize a record from scratch.
   */
  registry: AgentRegistry;
  /**
   * Used to write the mutated AgentRecord back to disk. Bypasses the
   * registry's higher-level methods (`updateRuntimeBinding`, `markFailed`)
   * because they would log/route under different semantics. We're a
   * lifecycle observer, not an end-user action.
   */
  store: PersistentStore;
  /** Defaults to a quiet `console`-backed logger. */
  logger?: AgentStatusReconcilerLogger;
  /** Wall clock — tests inject for deterministic `last_active_at`. */
  now?: () => Date;
}

export class AgentStatusReconciler {
  private readonly _sessionManager: SessionManager;
  private readonly _registry: AgentRegistry;
  private readonly _store: PersistentStore;
  private readonly _logger: AgentStatusReconcilerLogger;
  private readonly _now: () => Date;

  private _unsubscribe: Unsubscribe | null = null;
  /**
   * Pending writes are awaitable so tests + Runtime.stop can deterministically
   * wait for the last status mutation to land before tearing down.
   */
  private readonly _inflight = new Set<Promise<void>>();
  /**
   * Per-agent serialization chain. Two events for the same agent (e.g.
   * session_started immediately followed by session_ended on a fast
   * auto-settle path) MUST run their reconcile work in order — otherwise
   * Call 1 reads `status="idle"` then Call 2 also reads `status="idle"`
   * (still pre-Call 1's write) and Call 2's `target===idle` short-circuit
   * skips the write the second event needed. Result: status sticks at
   * "running" forever.
   */
  private readonly _agentChain = new Map<string, Promise<void>>();

  constructor(opts: AgentStatusReconcilerOptions) {
    this._sessionManager = opts.sessionManager;
    this._registry = opts.registry;
    this._store = opts.store;
    this._logger = opts.logger ?? {
      warn: (m, ...a) => console.warn(m, ...a),
      error: (m, ...a) => console.error(m, ...a),
    };
    this._now = opts.now ?? (() => new Date());
  }

  /**
   * Crash-recovery sweep: scan all registered agents for orphaned "running"
   * status (left behind by a previous process crash) and reset them to "idle".
   *
   * Must be called BEFORE `start()` so the event subscription doesn't race
   * with the writes here. Safe to call multiple times (idempotent).
   *
   * Returns the list of agent_ids that were recovered.
   */
  async recoverOrphans(): Promise<string[]> {
    const all = await this._registry.list();
    const orphans = all.filter((r) => r.protocol.status === "running");
    if (orphans.length === 0) return [];

    const recovered: string[] = [];
    for (const record of orphans) {
      const agentId = record.protocol.agent_id;
      const updated: AgentRecord = {
        ...record,
        protocol: {
          ...record.protocol,
          status: "idle",
          last_active_at: this._now().toISOString(),
        },
      };
      try {
        await this._store.upsert(updated);
        recovered.push(agentId);
        this._logger.warn(
          `[AgentStatusReconciler] orphan recovered: agent_id="${agentId}" running→idle (crash-recovery on startup)`,
        );
      } catch (err) {
        this._logger.error(
          `[AgentStatusReconciler] orphan recovery failed for agent_id="${agentId}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return recovered;
  }

  /**
   * Subscribe to SessionManager events. Idempotent — calling twice is a
   * caller error (matches dispatcher.start's discipline).
   */
  start(): void {
    if (this._unsubscribe) {
      throw new Error("AgentStatusReconciler.start() already called");
    }
    this._unsubscribe = this._sessionManager.onEvent((event) =>
      this._onEvent(event),
    );
  }

  /**
   * Unsubscribe from SessionManager + flush any in-flight writes. Idempotent.
   */
  async stop(): Promise<void> {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    if (this._inflight.size > 0) {
      await Promise.allSettled([...this._inflight]);
    }
  }

  /**
   * Test/diagnostic helper — wait for any in-flight reconciliation writes
   * to settle (used by integration tests to observe the state transition
   * deterministically without polling).
   */
  async whenSettled(): Promise<void> {
    if (this._inflight.size === 0) return;
    await Promise.allSettled([...this._inflight]);
  }

  /**
   * Release stale `running` when registry says busy but SessionManager has no
   * active session (recoverable dispatch / wake path).
   */
  async releaseStaleBusyIfNoSession(
    agentId: string,
    sessionManager: SessionManager,
  ): Promise<boolean> {
    const record = await this._registry.get(agentId);
    if (!record || record.protocol.status !== "running") return false;
    const active = await sessionManager.listActive();
    if (active.some((s) => s.agent_id === agentId)) return false;
    await this._reconcile(agentId, "idle");
    return true;
  }

  // ── private ──────────────────────────────────────────────────────────

  private _onEvent(event: RuntimeEvent): void {
    let target: "running" | "idle" | null = null;
    if (event.event_type === "runtime.session_started") {
      target = "running";
    } else if (
      event.event_type === "runtime.session_ended" ||
      event.event_type === "runtime.session_cancelled"
    ) {
      target = "idle";
    }
    if (!target) return;
    const finalTarget: "running" | "idle" = target;

    const agentId = event.agent_id;
    const prev = this._agentChain.get(agentId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => this._reconcile(agentId, finalTarget))
      .catch((err) => {
        this._logger.error(
          `[AgentStatusReconciler] reconcile failed for agent_id="${agentId}" -> "${finalTarget}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    this._agentChain.set(agentId, next);
    this._inflight.add(next);
    void next.finally(() => {
      this._inflight.delete(next);
      // Only forget the chain head if we're still the latest entry.
      if (this._agentChain.get(agentId) === next) {
        this._agentChain.delete(agentId);
      }
    });
  }

  private async _reconcile(
    agentId: string,
    target: "running" | "idle",
  ): Promise<void> {
    const record = await this._registry.get(agentId);
    if (!record) {
      this._logger.warn(
        `[AgentStatusReconciler] agent_id="${agentId}" not found in registry; ` +
          `cannot apply status="${target}" (registry race or agent deleted mid-session).`,
      );
      return;
    }

    if (record.protocol.status === target) {
      // Idempotent skip — common when ended fires after we already saw
      // a cancel-driven idle transition.
      return;
    }

    // Don't override "error" status from a session lifecycle event.
    // markFailed sets status="error" deliberately and should outrank
    // a benign idle transition. ("error" recovery is a separate flow.)
    if (record.protocol.status === "error" && target === "idle") {
      this._logger.warn(
        `[AgentStatusReconciler] refusing to clear status="error" for agent_id="${agentId}" ` +
          `via session lifecycle; keep error state until explicit recovery.`,
      );
      return;
    }

    const updated: AgentRecord = {
      ...record,
      protocol: {
        ...record.protocol,
        status: target,
        last_active_at: this._now().toISOString(),
      },
    };
    await this._store.upsert(updated);
  }

  /**
   * ADMIN force-recovery: clear error→idle when lifecycle would normally refuse.
   */
  async forceIdleFromAdmin(agentId: string): Promise<boolean> {
    const record = await this._registry.get(agentId);
    if (!record) return false;
    if (record.protocol.status === "idle") return true;
    const updated: AgentRecord = {
      ...record,
      protocol: {
        ...record.protocol,
        status: "idle",
        last_active_at: this._now().toISOString(),
      },
    };
    await this._store.upsert(updated);
    return true;
  }
}
