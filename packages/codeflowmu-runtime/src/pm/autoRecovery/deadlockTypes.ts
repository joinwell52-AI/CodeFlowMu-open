/**
 * Auto-recovery deadlock detection / planning types.
 */

export type DeadlockKind =
  | "first_turn_abort"
  | "sdk_cooldown"
  | "session_unsettled"
  | "stale_busy_no_session"
  | "stale_failed_receipt"
  | "retry_loop_risk";

export type RecoveryTrigger =
  | "session_ended"
  | "session_started_stall"
  | "sdk_cooldown"
  | "report_arrival"
  | "reconcile_result"
  | "agent_status_change"
  | "task_dispatcher_retry"
  | "watchdog";

export const AUTO_RECOVERY_ESCALATE_REASON = "auto_recovery_limit_reached";

export type RecoveryPlanAction =
  | "clear_guard"
  | "delayed_retry"
  | "release_and_recover"
  | "cancel_release_recover"
  | "recycle_and_delayed_retry"
  | "escalate_admin"
  | "force_safe_delay"
  | "wait";

export type RecoveryPlanStatus =
  | "detected"
  | "planned"
  | "executed"
  | "delayed"
  | "escalated"
  | "failed"
  | "skipped";

export interface DeadlockDetectContext {
  projectRoot: string;
  trigger: RecoveryTrigger;
  taskId: string | null;
  role: string | null;
  agentId: string;
  threadKey?: string | null;
  /** Reconcile snapshot (optional). */
  reconcileState?: string | null;
  reasonCode?: string | null;
  durationMs?: number;
  toolCallCount?: number;
  failureCategory?: string | null;
  failureCode?: string | null;
  isFirstTurnAbort?: boolean;
  sessionUnsettled?: boolean;
  sessionStartedAt?: string | null;
  lastActivityAt?: string | null;
  agentRunning?: boolean;
  agentStatus?: string | null;
  hasActiveSession?: boolean;
  hasReportOnDisk?: boolean;
  workerFailedPersisted?: boolean;
  displayStatusWaitingPm?: boolean;
  sdkCooldownActive?: boolean;
  sdkCooldownRemainingMs?: number;
  retryDelayMs?: number;
  hasPendingDelayedRetry?: boolean;
  sessionFailed?: boolean;
  /** TASK-101: queued tasks are intentionally waiting — not stale. */
  dispatchStatusQueued?: boolean;
  /** TASK-101: paused tasks must not auto-recover. */
  dispatchStatusPaused?: boolean;
}

export interface DeadlockDetection {
  kind: DeadlockKind;
  trigger: RecoveryTrigger;
  taskId: string;
  role: string;
  agentId: string;
  reason: string;
  detail?: string;
  /** Extra fields for planner (cooldown ms, attempt index hints, etc.). */
  meta?: Record<string, unknown>;
}

export interface RecoveryPlan {
  detection: DeadlockDetection;
  action: RecoveryPlanAction;
  delayMs: number;
  reasonCode: string;
  adminHint?: string;
  countsTowardLimit: boolean;
  escalate?: boolean;
}

export interface RecoveryExecutionResult {
  status: RecoveryPlanStatus;
  plan: RecoveryPlan;
  message?: string;
  remainingMs?: number;
  skippedReason?: string;
}

export const AUTO_RECOVERY_MAX_PER_TASK_AGENT = 2;
export const AUTO_RECOVERY_DEDUP_MS = 60_000;
export const AUTO_RECOVERY_MIN_RETRY_MS = 60_000;
export const SESSION_UNSETTLED_SUSPECT_MS = 5 * 60_000;
export const SESSION_UNSETTLED_RECOVER_MS = 10 * 60_000;
export const FIRST_TURN_ABORT_RETRY_1_MS = 60_000;
export const FIRST_TURN_ABORT_RETRY_2_MS = 180_000;

/** Priority: lower index = handle first. */
export const DEADLOCK_KIND_PRIORITY: DeadlockKind[] = [
  "stale_failed_receipt",
  "first_turn_abort",
  "retry_loop_risk",
  "sdk_cooldown",
  "stale_busy_no_session",
  "session_unsettled",
];
