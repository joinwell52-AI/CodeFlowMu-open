/**
 * PM decision layer — outputs next action only; no FCoP writes, no dispatch side effects.
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
  isDoneReportStatus,
  isUpstreamWorkerSettled,
  normalizeWorkerRole,
  type DispatchGateTaskRef,
} from "./taskDispatchGate.ts";

export type PmEvaluateAction =
  | "WAKE_DEV"
  | "WAIT"
  | "RETRY_QA"
  | "RESOLVE_BLOCKED"
  | "ESCALATE_ADMIN"
  | "OK";

export interface PmEvaluateResult {
  action: PmEvaluateAction;
  reason: string;
  execution_state?: ExecutionState;
}

function qaReportDoneForTask(
  qaTask: DispatchGateTaskRef | undefined,
  ctx: ExecutionGateContext,
): boolean {
  if (!qaTask) return false;
  const qaId = normalizeTaskIdPrefix(qaTask.taskId);
  return ctx.reports.some((r) => {
    if (normalizeWorkerRole(r.reporter) !== "QA") return false;
    if (normalizeTaskIdPrefix(r.taskId) !== qaId) return false;
    return isDoneReportStatus(r.status);
  });
}

export function pmEvaluate(
  target: DispatchGateTaskRef,
  ctx: ExecutionGateContext,
  threadTasks?: DispatchGateTaskRef[],
): PmEvaluateResult {
  const scoped =
    threadTasks ?? filterThreadTasks(ctx.tasks, target.threadKey);
  const execution_state = resolveExecutionState(target, ctx, scoped);
  const meta =
    ctx.taskMeta.get(normalizeTaskIdPrefix(target.taskId)) ??
    ctx.taskMeta.get(target.taskId);
  const role = normalizeWorkerRole(target.recipient);
  const displayStatus = String(target.displayStatus ?? "").toLowerCase();

  if (execution_state === "superseded" || isTaskSuperseded(target, ctx)) {
    return { action: "WAIT", reason: "task superseded", execution_state };
  }

  // Lifecycle terminal state is authoritative. Never let an old queue entry
  // or an earlier rejected QA round turn a done task back into RETRY_QA.
  if (execution_state === "completed" || isTaskCompleted(target)) {
    return { action: "OK", reason: "task already completed", execution_state: "completed" };
  }

  if (isTaskCancelled(target, meta)) {
    return { action: "WAIT", reason: "task cancelled", execution_state: "blocked" };
  }

  if (displayStatus === "worker_report_blocked") {
    return {
      action: "RESOLVE_BLOCKED",
      reason: "formal worker blocked report requires PM acknowledgement or rework",
      execution_state,
    };
  }

  if (displayStatus.includes("qa_fail") || displayStatus.includes("admin_reject")) {
    return {
      action: "ESCALATE_ADMIN",
      reason: `display_status=${displayStatus}`,
      execution_state,
    };
  }

  if (role === "DEV") {
    const devSettled = isUpstreamWorkerSettled(
      "DEV",
      target.threadKey,
      scoped,
      ctx.reports,
    );
    if (devSettled) {
      return { action: "OK", reason: "DEV report done", execution_state };
    }
    if (
      execution_state === "runnable" &&
      (target.lifecycleBucket === "inbox" || target.fmState === "inbox")
    ) {
      return { action: "WAKE_DEV", reason: "DEV inbox runnable", execution_state };
    }
    return { action: "WAKE_DEV", reason: "DEV work incomplete", execution_state };
  }

  if (role === "QA") {
    if (execution_state === "waiting_dependency") {
      return {
        action: "WAKE_DEV",
        reason: "DEV report not done",
        execution_state,
      };
    }

    const artifact = resolveArtifactPathForThread(
      target.threadKey,
      scoped,
      ctx,
    );
    if (artifact && !artifactPathExists(ctx, artifact)) {
      return {
        action: "WAKE_DEV",
        reason: "artifact missing for QA thread",
        execution_state: "blocked",
      };
    }

    // A thread can contain several QA rework rounds. The decision must be
    // based on the current target, not the first QA task in the thread.
    if (qaReportDoneForTask(target, ctx)) {
      return { action: "OK", reason: "QA report done", execution_state };
    }

    if (
      target.lifecycleBucket === "active" ||
      target.fmState === "active" ||
      target.lifecycleBucket === "review"
    ) {
      return { action: "WAIT", reason: "QA in flight", execution_state };
    }

    if (execution_state === "runnable") {
      return {
        action: "RETRY_QA",
        reason: "QA ready to dispatch",
        execution_state,
      };
    }

    return { action: "RETRY_QA", reason: "QA blocked", execution_state };
  }

  return { action: "WAIT", reason: "no PM action for role", execution_state };
}
