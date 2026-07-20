/**
 * QA dispatch hard gate — DEV→QA execution fence (no fallback).
 */

import { filterThreadTasks, type ExecutionGateContext } from "./taskDispatchContext.ts";
import {
  artifactPathExists,
  isTaskCancelled,
  isTaskCompleted,
  isTaskSuperseded,
  normalizeTaskIdPrefix,
  resolveArtifactPathForThread,
  resolveExecutionState,
  type ExecutionState,
} from "./executionState.ts";
import {
  evaluateUpstreamWorkerSettlement,
  normalizeWorkerRole,
  type DispatchGateTaskRef,
} from "./taskDispatchGate.ts";

export type QaDispatchBlockReason =
  | "not_qa_task"
  | "already_done"
  | "dev_report_pending"
  | "artifact_missing"
  | "cancelled"
  | "superseded";

export interface QaDispatchGateResult {
  allowed: boolean;
  reason?: QaDispatchBlockReason;
  detail?: string;
  waiting_on?: string;
  execution_state?: ExecutionState;
}

export function canDispatchQA(
  target: DispatchGateTaskRef,
  ctx: ExecutionGateContext,
  threadTasks?: DispatchGateTaskRef[],
): QaDispatchGateResult {
  const role = normalizeWorkerRole(target.recipient);
  if (role !== "QA") {
    return { allowed: false, reason: "not_qa_task" };
  }

  const scoped =
    threadTasks ?? filterThreadTasks(ctx.tasks, target.threadKey);
  const execution_state = resolveExecutionState(target, ctx, scoped);
  const meta =
    ctx.taskMeta.get(normalizeTaskIdPrefix(target.taskId)) ??
    ctx.taskMeta.get(target.taskId);

  if (isTaskSuperseded(target, ctx)) {
    return {
      allowed: false,
      reason: "superseded",
      execution_state: "superseded",
      detail: meta?.supersededBy
        ? `superseded by ${meta.supersededBy}`
        : undefined,
    };
  }

  if (execution_state === "completed" || isTaskCompleted(target)) {
    return {
      allowed: false,
      reason: "already_done",
      execution_state: "completed",
      detail: "task completed",
    };
  }

  if (isTaskCancelled(target, meta)) {
    return {
      allowed: false,
      reason: "cancelled",
      execution_state: "blocked",
      detail: meta?.cancelReason,
    };
  }

  const dependency = evaluateUpstreamWorkerSettlement(
    "",
    target.threadKey,
    scoped,
    ctx.reports,
    target,
  );
  if (!dependency.settled) {
    return {
      allowed: false,
      reason: "dev_report_pending",
      waiting_on: dependency.waitingOn ?? "dependency",
      execution_state: "waiting_dependency",
    };
  }

  const artifact = resolveArtifactPathForThread(
    target.threadKey,
    scoped,
    ctx,
  );
  if (artifact && !artifactPathExists(ctx, artifact)) {
    return {
      allowed: false,
      reason: "artifact_missing",
      execution_state: "blocked",
      detail: `artifact not found: ${artifact}`,
    };
  }

  return { allowed: true, execution_state: "runnable" };
}

/** Map QA gate block reason to panel / DispatchOutcome skip reason. */
export function qaGateToDispatchSkipReason(
  reason: QaDispatchBlockReason | undefined,
): "waiting_dependency" | "cancelled" | "superseded" | "execution_blocked" {
  switch (reason) {
    case "dev_report_pending":
      return "waiting_dependency";
    case "cancelled":
      return "cancelled";
    case "superseded":
      return "superseded";
    default:
      return "execution_blocked";
  }
}
