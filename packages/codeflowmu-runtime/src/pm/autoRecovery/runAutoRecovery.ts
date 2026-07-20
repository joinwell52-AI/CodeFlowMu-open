/**
 * Orchestrate detect → plan → execute for auto deadlock recovery.
 */

import { appendAutoRecoveryEvent } from "../autoRecoveryEvents.ts";
import { detectPrimaryDeadlock } from "./DeadlockDetector.ts";
import { planRecovery } from "./RecoveryPlanner.ts";
import {
  executeRecoveryPlan,
  type RecoveryExecutorDeps,
} from "./RecoveryExecutor.ts";
import type {
  DeadlockDetectContext,
  RecoveryExecutionResult,
} from "./deadlockTypes.ts";

export interface RunAutoRecoveryOpts {
  ctx: DeadlockDetectContext;
  deps: RecoveryExecutorDeps;
  /** When true, skip auto-cancel for unsettled sessions that still show running output. */
  blockCancelForActiveOutput?: boolean;
}

export async function runAutoRecovery(
  opts: RunAutoRecoveryOpts,
): Promise<RecoveryExecutionResult | null> {
  const detection = detectPrimaryDeadlock(opts.ctx);
  if (!detection) return null;

  const detectedPayload = {
    task_id: detection.taskId,
    role: detection.role,
    agent_id: detection.agentId,
    reason_code: detection.reason,
    trigger: detection.trigger,
    deadlock_kind: detection.kind,
    action: detection.kind,
    admin_hint: detection.detail,
  };
  appendAutoRecoveryEvent(opts.deps.projectRoot, "deadlock.detected", detectedPayload);
  appendAutoRecoveryEvent(opts.deps.projectRoot, "auto_recovery.detected", detectedPayload);

  const plan = planRecovery({
    projectRoot: opts.deps.projectRoot,
    detection,
    blockCancelForActiveOutput: opts.blockCancelForActiveOutput,
  });
  if (!plan) {
    appendAutoRecoveryEvent(opts.deps.projectRoot, "auto_recovery.skipped", {
      task_id: detection.taskId,
      role: detection.role,
      agent_id: detection.agentId,
      reason_code: "dedup_or_no_plan",
      deadlock_kind: detection.kind,
      skipped_reason: "dedup_window",
    });
    return null;
  }

  if (plan.action === "wait") {
    appendAutoRecoveryEvent(opts.deps.projectRoot, "auto_recovery.skipped", {
      task_id: detection.taskId,
      role: detection.role,
      agent_id: detection.agentId,
      reason_code: plan.reasonCode,
      deadlock_kind: detection.kind,
      plan_action: plan.action,
      admin_hint: plan.adminHint,
      skipped_reason: "wait",
    });
    return {
      status: "skipped",
      plan,
      skippedReason: "wait",
      message: plan.adminHint,
    };
  }

  return executeRecoveryPlan(plan, opts.deps);
}

export type { DeadlockDetectContext, RecoveryExecutionResult, RecoveryExecutorDeps };
