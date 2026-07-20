/**
 * Execute recovery plans with safety limits and audit events.
 */

import type { AgentRegistry } from "../../registry/AgentRegistry.ts";
import type { AgentStatusReconciler } from "../../registry/AgentStatusReconciler.ts";
import type { SessionManager } from "../../session/SessionManager.ts";
import { appendAutoRecoveryEvent } from "../autoRecoveryEvents.ts";
import {
  buildWakeDownstreamRequest,
  clearWaitingPmAttentionOnTask,
  markWaitingPmAttentionOnTask,
  type WakeDownstreamRequest,
} from "../PmGovernanceActions.ts";
import { recoverTaskExecution } from "../recoverTaskExecution.ts";
import type { WakeDownstreamExecutor } from "../PmGovernancePlanner.ts";
import { clearWorkerReceiptFailed } from "../workerReceiptDurableHints.ts";
import {
  getKindAttemptCount,
  recordRecoveryAction,
} from "./autoRecoveryState.ts";
import {
  AUTO_RECOVERY_ESCALATE_REASON,
  AUTO_RECOVERY_MIN_RETRY_MS,
  type RecoveryExecutionResult,
  type RecoveryPlan,
} from "./deadlockTypes.ts";

export interface RecoveryExecutorDeps {
  projectRoot: string;
  registry: AgentRegistry;
  sessionManager: SessionManager;
  statusReconciler: AgentStatusReconciler;
  wakeExecutor: WakeDownstreamExecutor;
  threadKey?: string | null;
  forceReleaseAgent?: (
    agentId: string,
    reason: string,
  ) => Promise<{ ok: boolean; cancelled: string[]; error?: string }>;
  recycleAgent?: (
    agentId: string,
    params: { reason: string; operator_role?: string },
  ) => Promise<{ new_sdk_agent_id: string }>;
  clearInMemoryWorkerFailed?: (taskId: string) => void;
  scheduleDelayedWake?: (
    plan: WakeDownstreamRequest,
    remainingMs: number,
    reason: string,
  ) => boolean;
}

async function wakePlan(
  deps: RecoveryExecutorDeps,
  taskId: string,
  role: string,
  reasonCode: string,
): Promise<WakeDownstreamRequest> {
  return buildWakeDownstreamRequest({
    task_id: taskId,
    role,
    thread_key: deps.threadKey,
    reason: reasonCode,
  });
}

export async function executeRecoveryPlan(
  plan: RecoveryPlan,
  deps: RecoveryExecutorDeps,
): Promise<RecoveryExecutionResult> {
  const { detection } = plan;
  const { taskId, role, agentId, kind } = detection;

  const attempt =
    getKindAttemptCount(deps.projectRoot, taskId, agentId, kind) + 1;

  appendAutoRecoveryEvent(deps.projectRoot, "auto_recovery.planned", {
    task_id: taskId,
    role,
    agent_id: agentId,
    reason_code: plan.reasonCode,
    admin_hint: plan.adminHint,
    deadlock_kind: kind,
    plan_action: plan.action,
    action: plan.action,
    attempt,
    delay_ms: plan.delayMs,
  });

  const audit = (
    eventType: string,
    extra?: Partial<{
      remainingMs: number;
      retryAt: string;
      newSessionId: string;
      message: string;
      skippedReason: string;
    }>,
  ) => {
    appendAutoRecoveryEvent(deps.projectRoot, eventType, {
      task_id: taskId,
      role,
      agent_id: agentId,
      reason_code: plan.reasonCode,
      admin_hint: plan.adminHint ?? extra?.message,
      deadlock_kind: kind,
      plan_action: plan.action,
      action: plan.action,
      attempt,
      delay_ms: plan.delayMs,
      remaining_ms: extra?.remainingMs,
      retry_at: extra?.retryAt,
      new_session_id: extra?.newSessionId,
      result: extra?.message,
      skipped_reason: extra?.skippedReason,
    });
  };

  const finish = (
    status: RecoveryExecutionResult["status"],
    extra?: Partial<RecoveryExecutionResult> & {
      auditEvent?: string;
      retryAt?: string;
      newSessionId?: string;
    },
  ): RecoveryExecutionResult => {
    const result: RecoveryExecutionResult = {
      status,
      plan,
      ...extra,
    };
    const eventName =
      extra?.auditEvent ?? `auto_recovery.${status}`;
    audit(eventName, {
      remainingMs: extra?.remainingMs,
      retryAt: extra?.retryAt,
      newSessionId: extra?.newSessionId,
      message: extra?.message,
      skippedReason: extra?.skippedReason,
    });
    if (status !== "skipped" && status !== "failed") {
      recordRecoveryAction({
        projectRoot: deps.projectRoot,
        taskId,
        agentId,
        kind,
        reasonCode: plan.reasonCode,
        countsTowardLimit: plan.countsTowardLimit,
      });
    }
    return result;
  };

  try {
    switch (plan.action) {
      case "wait":
        return finish("skipped", {
          skippedReason: "wait",
          message: plan.adminHint,
        });

      case "clear_guard": {
        await clearWorkerReceiptFailed(deps.projectRoot, taskId);
        deps.clearInMemoryWorkerFailed?.(taskId);
        await clearWaitingPmAttentionOnTask(deps.projectRoot, taskId);
        audit("auto_recovery.stale_failed_receipt_cleared", {
          message: "cleared stale failed guard",
        });
        return finish("executed", {
          message: "cleared stale failed guard",
          auditEvent: "auto_recovery.executed",
        });
      }

      case "force_safe_delay":
      case "delayed_retry": {
        const delayMs = Math.max(
          AUTO_RECOVERY_MIN_RETRY_MS,
          plan.delayMs || AUTO_RECOVERY_MIN_RETRY_MS,
        );
        const retryAt = new Date(Date.now() + delayMs).toISOString();
        const req = await wakePlan(deps, taskId, role, plan.reasonCode);
        const scheduled =
          deps.scheduleDelayedWake?.(req, delayMs, plan.reasonCode) ?? false;
        if (!scheduled) {
          return finish("failed", {
            message: "delayed wake not scheduled (duplicate or missing hook)",
          });
        }
        if (plan.action === "force_safe_delay") {
          audit("auto_recovery.retry_loop_guarded", {
            remainingMs: delayMs,
            retryAt,
            message: plan.adminHint,
          });
        }
        audit("wake_agent.delayed", {
          remainingMs: delayMs,
          retryAt,
          message: plan.adminHint,
        });
        return finish("delayed", {
          remainingMs: delayMs,
          retryAt,
          message: plan.adminHint,
          auditEvent: "auto_recovery.delayed",
        });
      }

      case "release_and_recover": {
        await deps.statusReconciler.releaseStaleBusyIfNoSession(
          agentId,
          deps.sessionManager,
        );
        const recover = await recoverTaskExecution({
          projectRoot: deps.projectRoot,
          taskId,
          role,
          registry: deps.registry,
          sessionManager: deps.sessionManager,
          wakeExecutor: deps.wakeExecutor,
          statusReconciler: deps.statusReconciler,
          threadKey: deps.threadKey,
          agentId,
          reasonCode: plan.reasonCode,
          clearInMemoryWorkerFailed: deps.clearInMemoryWorkerFailed,
          scheduleDelayedWake: deps.scheduleDelayedWake,
        });
        if (recover.delayed) {
          const retryAt =
            recover.remainingMs != null
              ? new Date(Date.now() + recover.remainingMs).toISOString()
              : undefined;
          return finish("delayed", {
            remainingMs: recover.remainingMs,
            retryAt,
            message: recover.message,
            auditEvent: "auto_recovery.delayed",
          });
        }
        if (!recover.ok) {
          const detail = recover.detail ?? recover.reason;
          if (detail === "new_session_id_null" || recover.reason === "new_session_id_null") {
            await markWaitingPmAttentionOnTask(
              deps.projectRoot,
              taskId,
              AUTO_RECOVERY_ESCALATE_REASON,
            );
            return finish("escalated", {
              message: "new_session_id_null",
              auditEvent: "auto_recovery.escalated",
            });
          }
          return finish("failed", { message: detail });
        }
        return finish("executed", {
          message: recover.message,
          newSessionId:
            recover.new_session_id ?? recover.session_id ?? undefined,
        });
      }

      case "cancel_release_recover": {
        if (deps.forceReleaseAgent) {
          await deps.forceReleaseAgent(agentId, plan.reasonCode);
        }
        await deps.statusReconciler.releaseStaleBusyIfNoSession(
          agentId,
          deps.sessionManager,
        );
        const recover = await recoverTaskExecution({
          projectRoot: deps.projectRoot,
          taskId,
          role,
          registry: deps.registry,
          sessionManager: deps.sessionManager,
          wakeExecutor: deps.wakeExecutor,
          statusReconciler: deps.statusReconciler,
          threadKey: deps.threadKey,
          agentId,
          reasonCode: plan.reasonCode,
          clearInMemoryWorkerFailed: deps.clearInMemoryWorkerFailed,
          scheduleDelayedWake: deps.scheduleDelayedWake,
        });
        if (recover.delayed) {
          const retryAt =
            recover.remainingMs != null
              ? new Date(Date.now() + recover.remainingMs).toISOString()
              : undefined;
          return finish("delayed", {
            remainingMs: recover.remainingMs,
            retryAt,
            message: recover.message,
            auditEvent: "auto_recovery.delayed",
          });
        }
        if (!recover.ok) {
          const detail = recover.detail ?? recover.reason;
          if (detail === "new_session_id_null" || recover.reason === "new_session_id_null") {
            await markWaitingPmAttentionOnTask(
              deps.projectRoot,
              taskId,
              AUTO_RECOVERY_ESCALATE_REASON,
            );
            return finish("escalated", {
              message: "new_session_id_null",
              auditEvent: "auto_recovery.escalated",
            });
          }
          return finish("failed", { message: detail });
        }
        return finish("executed", {
          message: recover.message,
          newSessionId:
            recover.new_session_id ?? recover.session_id ?? undefined,
        });
      }

      case "recycle_and_delayed_retry": {
        if (deps.recycleAgent) {
          try {
            await deps.recycleAgent(agentId, {
              reason: plan.reasonCode,
              operator_role: "SYSTEM",
            });
          } catch {
            /* best-effort recycle */
          }
        }
        const delayMs = Math.max(
          AUTO_RECOVERY_MIN_RETRY_MS,
          plan.delayMs || AUTO_RECOVERY_MIN_RETRY_MS,
        );
        const retryAt = new Date(Date.now() + delayMs).toISOString();
        const req = await wakePlan(deps, taskId, role, plan.reasonCode);
        const scheduled =
          deps.scheduleDelayedWake?.(req, delayMs, plan.reasonCode) ?? false;
        if (!scheduled) {
          return finish("failed", { message: "recycle delayed wake not scheduled" });
        }
        audit("wake_agent.delayed", {
          remainingMs: delayMs,
          retryAt,
          message: plan.adminHint,
        });
        return finish("delayed", {
          remainingMs: delayMs,
          retryAt,
          message: plan.adminHint,
          auditEvent: "auto_recovery.delayed",
        });
      }

      case "escalate_admin": {
        await markWaitingPmAttentionOnTask(
          deps.projectRoot,
          taskId,
          AUTO_RECOVERY_ESCALATE_REASON,
        );
        return finish("escalated", {
          message: plan.adminHint ?? AUTO_RECOVERY_ESCALATE_REASON,
          auditEvent: "auto_recovery.escalated",
        });
      }

      default:
        return finish("failed", { message: `unknown action ${plan.action}` });
    }
  } catch (err) {
    return finish("failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
