export {
  detectDeadlocks,
  detectPrimaryDeadlock,
} from "./DeadlockDetector.ts";
export { planRecovery, type PlanRecoveryOpts } from "./RecoveryPlanner.ts";
export {
  executeRecoveryPlan,
  type RecoveryExecutorDeps,
} from "./RecoveryExecutor.ts";
export {
  buildAutoRecoveryContext,
  type BuildAutoRecoveryContextInput,
} from "./buildAutoRecoveryContext.ts";
export { runAutoRecovery, type RunAutoRecoveryOpts } from "./runAutoRecovery.ts";
export {
  getRecoveryCount,
  getKindAttemptCount,
  isDedupBlocked,
  isRecoveryLimitReached,
  recordRecoveryAction,
  resetAutoRecoveryStateForTests,
} from "./autoRecoveryState.ts";
export type {
  DeadlockKind,
  RecoveryTrigger,
  RecoveryPlanAction,
  RecoveryPlanStatus,
  DeadlockDetectContext,
  DeadlockDetection,
  RecoveryPlan,
  RecoveryExecutionResult,
} from "./deadlockTypes.ts";
export {
  AUTO_RECOVERY_MAX_PER_TASK_AGENT,
  AUTO_RECOVERY_DEDUP_MS,
  AUTO_RECOVERY_MIN_RETRY_MS,
  DEADLOCK_KIND_PRIORITY,
} from "./deadlockTypes.ts";
