/**
 * Detect deadlock / stale states from reconcile + session context.
 */

import {
  DEADLOCK_KIND_PRIORITY,
  type DeadlockDetectContext,
  type DeadlockDetection,
  type DeadlockKind,
  SESSION_UNSETTLED_RECOVER_MS,
  SESSION_UNSETTLED_SUSPECT_MS,
} from "./deadlockTypes.ts";

const FIRST_TURN_ABORT_MAX_MS = 60_000;

function normTaskId(id: string | null | undefined): string | null {
  const t = String(id ?? "").replace(/\.md$/i, "").trim();
  return t || null;
}

function normRole(role: string | null | undefined): string | null {
  const r = String(role ?? "").trim().toUpperCase();
  return r || null;
}

function parseIsoMs(iso: string | null | undefined): number | null {
  const s = String(iso ?? "").trim();
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function detectOne(
  ctx: DeadlockDetectContext,
  kind: DeadlockKind,
  taskId: string,
  role: string,
): DeadlockDetection | null {
  switch (kind) {
    case "stale_failed_receipt": {
      if (!ctx.workerFailedPersisted && !ctx.displayStatusWaitingPm) return null;
      if (!ctx.hasReportOnDisk) return null;
      return {
        kind,
        trigger: ctx.trigger,
        taskId,
        role,
        agentId: ctx.agentId,
        reason: "stale_failed_receipt",
        detail: "worker REPORT on disk while failed guard / waiting_pm_attention active",
      };
    }
    case "retry_loop_risk": {
      if (!ctx.sessionFailed) return null;
      if (ctx.isFirstTurnAbort === true) return null;
      if (ctx.failureCategory === "cursor_sdk_first_turn_abort") return null;
      const retryMs = ctx.retryDelayMs ?? 0;
      const risky =
        retryMs <= 0 ||
        ctx.hasPendingDelayedRetry === true;
      if (!risky) return null;
      return {
        kind,
        trigger: ctx.trigger,
        taskId,
        role,
        agentId: ctx.agentId,
        reason: "retry_loop_risk",
        detail: "session_failed with zero or duplicate pending retry",
        meta: { retryDelayMs: retryMs },
      };
    }
    case "sdk_cooldown": {
      if (!ctx.sdkCooldownActive) return null;
      const remaining = Math.max(0, Math.floor(ctx.sdkCooldownRemainingMs ?? 0));
      if (remaining <= 0) return null;
      return {
        kind,
        trigger: ctx.trigger,
        taskId,
        role,
        agentId: ctx.agentId,
        reason: "sdk_cooldown",
        detail: "SDK circuit open / cooldown active",
        meta: { remainingMs: remaining },
      };
    }
    case "stale_busy_no_session": {
      if (ctx.dispatchStatusPaused === true || ctx.dispatchStatusQueued === true) {
        return null;
      }
      const stale =
        ctx.reasonCode === "stale_busy_no_session" ||
        (ctx.agentRunning === true &&
          ctx.hasActiveSession === false &&
          (ctx.agentStatus === "running" || ctx.agentStatus === "error"));
      if (!stale) return null;
      return {
        kind,
        trigger: ctx.trigger,
        taskId,
        role,
        agentId: ctx.agentId,
        reason: "stale_busy_no_session",
        detail: "agent busy/error without active runtime session",
      };
    }
    case "first_turn_abort": {
      const ft =
        ctx.isFirstTurnAbort === true ||
        ctx.failureCategory === "cursor_sdk_first_turn_abort";
      if (!ft) return null;
      if (ctx.hasReportOnDisk) return null;
      const dur = ctx.durationMs ?? 0;
      const tools = ctx.toolCallCount ?? 0;
      if (tools > 0) return null;
      if (dur >= FIRST_TURN_ABORT_MAX_MS) return null;
      return {
        kind,
        trigger: ctx.trigger,
        taskId,
        role,
        agentId: ctx.agentId,
        reason: "first_turn_abort",
        detail: "cursor_sdk_first_turn_abort with no tool calls",
        meta: { durationMs: dur, toolCallCount: tools },
      };
    }
    case "session_unsettled": {
      if (!ctx.sessionUnsettled) return null;
      const startedMs = parseIsoMs(ctx.sessionStartedAt);
      if (startedMs == null) {
        return {
          kind,
          trigger: ctx.trigger,
          taskId,
          role,
          agentId: ctx.agentId,
          reason: "session_unsettled",
          detail: "open session without settlement (no start timestamp)",
          meta: { elapsedMs: null },
        };
      }
      const elapsed = Date.now() - startedMs;
      if (elapsed < SESSION_UNSETTLED_SUSPECT_MS) return null;
      return {
        kind,
        trigger: ctx.trigger,
        taskId,
        role,
        agentId: ctx.agentId,
        reason: "session_unsettled",
        detail:
          elapsed >= SESSION_UNSETTLED_RECOVER_MS
            ? "session unsettled beyond recover threshold"
            : "session unsettled suspected",
        meta: { elapsedMs: elapsed },
      };
    }
    default:
      return null;
  }
}

/** Return detections sorted by handling priority (may be empty). */
export function detectDeadlocks(ctx: DeadlockDetectContext): DeadlockDetection[] {
  const taskId = normTaskId(ctx.taskId);
  const role = normRole(ctx.role);
  if (!taskId || !role || !ctx.agentId) return [];

  const out: DeadlockDetection[] = [];
  for (const kind of DEADLOCK_KIND_PRIORITY) {
    const d = detectOne(ctx, kind, taskId, role);
    if (d) out.push(d);
  }
  return out;
}

/** Highest-priority single detection (convenience). */
export function detectPrimaryDeadlock(
  ctx: DeadlockDetectContext,
): DeadlockDetection | null {
  const all = detectDeadlocks(ctx);
  return all[0] ?? null;
}
