/**
 * recover_task_execution — re-wake worker on same task after unsettled session.
 */

import type { AgentRegistry } from "../registry/AgentRegistry.ts";
import type { AgentStatusReconciler } from "../registry/AgentStatusReconciler.ts";
import type { SessionManager } from "../session/SessionManager.ts";
import { evaluateAgentWakeGate } from "../_internal/AgentWakeGuard.ts";
import { evaluateTaskDispatchWakeGate } from "../_internal/AgentWakeGuard.ts";
import { appendAgentReconcileEvent } from "./agentReconcileEvents.ts";
import {
  buildWakeDownstreamRequest,
  type WakeDownstreamRequest,
} from "./PmGovernanceActions.ts";
import { clearWorkerReceiptFailed } from "./workerReceiptDurableHints.ts";
import type { WakeDownstreamExecutor } from "./PmGovernancePlanner.ts";
import {
  getTaskDispatchStatusFromState,
  loadAgentTaskQueue,
} from "./agentTaskQueue.ts";
import {
  ADMIN_FORCE_RECOVERY_POLICY,
  PM_STOP_POLICY,
  markPmStop,
  shouldEscalateAdminForceRecovery,
  tryBeginPmRecover,
} from "./pmExecutionGovernance.ts";

export interface RecoverTaskExecutionOpts {
  projectRoot: string;
  taskId: string;
  role: string;
  registry: AgentRegistry;
  sessionManager: SessionManager;
  wakeExecutor: WakeDownstreamExecutor;
  statusReconciler?: AgentStatusReconciler;
  threadKey?: string | null;
  agentId?: string | null;
  reasonCode?: string | null;
  /** Clears in-memory PmQueueGuard downstream failed mark (paired with durable clear). */
  clearInMemoryWorkerFailed?: (taskId: string) => void;
  /** Schedule delayed wake retry (cooldown / throttle). */
  scheduleDelayedWake?: (
    plan: WakeDownstreamRequest,
    remainingMs: number,
    reason: string,
  ) => boolean;
  onRecovered?: (info: {
    task_id: string;
    role: string;
    agent_id: string;
    session_id?: string;
  }) => void;
}

export interface RecoverTaskExecutionResult {
  ok: boolean;
  status?: "recovered" | "skipped" | "failed" | "delayed";
  skipped?: boolean;
  delayed?: boolean;
  remainingMs?: number;
  reason?: string;
  reason_code?: string;
  detail?: string;
  message?: string;
  task_id?: string;
  role?: string;
  agent_id?: string;
  session_id?: string;
  old_session_id?: string | null;
  new_session_id?: string | null;
  untilMs?: number;
  cooldownReason?: string;
  policy?: typeof PM_STOP_POLICY | typeof ADMIN_FORCE_RECOVERY_POLICY;
  next_owner?: "PM" | "ADMIN";
}

export async function recoverTaskExecution(
  opts: RecoverTaskExecutionOpts,
): Promise<RecoverTaskExecutionResult> {
  const taskId = opts.taskId.replace(/\.md$/i, "").trim();
  const role = String(opts.role ?? "").trim().toUpperCase();
  if (!taskId || !role) {
    return { ok: false, reason: "missing_params", detail: "task_id and role required" };
  }

  const agents = await opts.registry.list({ role });
  const agent = agents.find(
    (a) => !opts.agentId || a.protocol.agent_id === opts.agentId,
  );
  if (!agent) {
    return { ok: false, reason: "agent_not_found", detail: `no agent for role ${role}` };
  }

  const agentId = agent.protocol.agent_id;

  if (opts.reasonCode !== "admin_force_recovery") {
    const attempt = tryBeginPmRecover({ taskId, agentId });
    if (!attempt.allow) {
      return {
        ok: false,
        status: "skipped",
        skipped: true,
        reason: attempt.reason,
        reason_code: attempt.reason,
        detail: "PM 已停手，不再重复 wake/recover",
        message: "PM 已停手，不再重复 wake/recover",
        task_id: taskId,
        role,
        agent_id: agentId,
        remainingMs: attempt.state.remainingMs,
        untilMs: attempt.state.untilMs,
        cooldownReason: attempt.state.cooldownReason,
        policy: PM_STOP_POLICY,
        next_owner: "ADMIN",
      };
    }
  }

  const activeBefore = await opts.sessionManager.listActive();
  const oldSessionId =
    activeBefore.find((s) => s.protocol.agent_id === agentId)?.protocol
      .session_id ?? null;

  if (opts.statusReconciler) {
    await opts.statusReconciler.releaseStaleBusyIfNoSession(
      agentId,
      opts.sessionManager,
    );
  }

  appendAgentReconcileEvent(opts.projectRoot, "agent_recovery.started", {
    task_id: taskId,
    role,
    agent_id: agentId,
    old_session_id: oldSessionId,
    reason_code: opts.reasonCode ?? "recover_session_unsettled",
    action_taken: "recover_task_execution",
  });

  try {
    const queueFile = await loadAgentTaskQueue(opts.projectRoot);
    const dispatchStatus = getTaskDispatchStatusFromState(queueFile, taskId);
    if (dispatchStatus === "paused" || dispatchStatus === "queued") {
      const out = {
        ok: false,
        status: "skipped" as const,
        skipped: true,
        reason: dispatchStatus === "paused" ? "task_paused" : "task_queued",
        reason_code: dispatchStatus === "paused" ? "task_paused" : "task_queued",
        detail:
          dispatchStatus === "paused"
            ? "paused task must not auto-recover"
            : "queued task is waiting for agent FIFO",
        task_id: taskId,
        role,
        agent_id: agentId,
        old_session_id: oldSessionId,
        message:
          dispatchStatus === "paused"
            ? "task is paused — use resume instead of recover"
            : "task is queued — waiting for agent",
      };
      appendAgentReconcileEvent(opts.projectRoot, "agent_recovery.skipped", {
        task_id: taskId,
        role,
        agent_id: agentId,
        old_session_id: oldSessionId,
        reason_code: out.reason_code,
        reason_text: out.detail,
        action_taken: "recover_skipped_dispatch_status",
      });
      return out;
    }
  } catch {
    /* optional queue file */
  }

  const dispatchGate = await evaluateTaskDispatchWakeGate({
    projectRoot: opts.projectRoot,
    taskId,
  });
  if (!dispatchGate.allow) {
    const out = {
      ok: false,
      status: "skipped" as const,
      skipped: true,
      reason: dispatchGate.reason,
      reason_code: dispatchGate.reason,
      detail: dispatchGate.detail,
      task_id: taskId,
      role,
      agent_id: agentId,
      old_session_id: oldSessionId,
      message: dispatchGate.detail,
    };
    appendAgentReconcileEvent(opts.projectRoot, "agent_recovery.skipped", {
      task_id: taskId,
      role,
      agent_id: agentId,
      old_session_id: oldSessionId,
      reason_code: out.reason_code,
      reason_text: out.detail,
      action_taken: "recover_skipped",
    });
    return out;
  }

  const wakeGate = await evaluateAgentWakeGate({
    agentId,
    registry: opts.registry,
    sessionManager: opts.sessionManager,
  });
  if (!wakeGate.allow) {
    const plan = buildWakeDownstreamRequest({
      task_id: taskId,
      role,
      reason: "recover_session_unsettled",
      thread_key: opts.threadKey ?? undefined,
      agent_id: agentId,
    });
    const retryMs = wakeGate.retryAfterMs ?? 0;
    if (retryMs > 0 && wakeGate.reason === "sdk_cooldown") {
      const stopped = markPmStop({
        taskId,
        agentId,
        reason: wakeGate.reason,
        remainingMs: retryMs,
        cooldownReason: wakeGate.reason,
      });
      const out = {
        ok: false,
        status: "delayed" as const,
        delayed: true,
        remainingMs: retryMs,
        untilMs: stopped.untilMs,
        cooldownReason: stopped.cooldownReason,
        policy: PM_STOP_POLICY,
        next_owner: "PM" as const,
        reason: wakeGate.reason,
        reason_code: wakeGate.reason,
        detail: wakeGate.detail,
        task_id: taskId,
        role,
        agent_id: agentId,
        old_session_id: oldSessionId,
        message: wakeGate.detail,
      };
      appendAgentReconcileEvent(opts.projectRoot, "agent_recovery.delayed", {
        task_id: taskId,
        role,
        agent_id: agentId,
        old_session_id: oldSessionId,
        reason_code: out.reason_code,
        reason_text: out.detail,
        action_taken: "recover_delayed",
        remaining_ms: retryMs,
      });
      return out;
    }
    const out = {
      ok: false,
      status: "skipped" as const,
      skipped: true,
      reason: wakeGate.reason,
      reason_code: wakeGate.reason,
      detail: wakeGate.detail,
      task_id: taskId,
      role,
      agent_id: agentId,
      old_session_id: oldSessionId,
      message: wakeGate.detail,
    };
    appendAgentReconcileEvent(opts.projectRoot, "agent_recovery.skipped", {
      task_id: taskId,
      role,
      agent_id: agentId,
      old_session_id: oldSessionId,
      reason_code: out.reason_code,
      reason_text: out.detail,
      action_taken: "recover_skipped",
    });
    return out;
  }

  await clearWorkerReceiptFailed(opts.projectRoot, taskId);
  opts.clearInMemoryWorkerFailed?.(taskId);

  const plan = buildWakeDownstreamRequest({
    task_id: taskId,
    role,
    reason: "recover_session_unsettled",
    thread_key: opts.threadKey ?? undefined,
    agent_id: agentId,
  });

  const result = await opts.wakeExecutor(plan);
  if (result.delayed) {
    const remainingMs = result.remainingMs ?? 0;
    const stopped = markPmStop({
      taskId,
      agentId,
      reason: result.delayedReason ?? result.reason ?? "wake_delayed",
      remainingMs,
      untilMs: result.untilMs,
      cooldownReason: result.cooldownReason ?? result.delayedReason ?? result.reason,
    });
    const out = {
      ok: false,
      status: "delayed" as const,
      delayed: true,
      remainingMs: remainingMs || undefined,
      untilMs: stopped.untilMs,
      cooldownReason: stopped.cooldownReason,
      policy: PM_STOP_POLICY,
      next_owner: "PM" as const,
      reason: result.delayedReason ?? result.reason ?? "wake_delayed",
      reason_code: result.delayedReason ?? result.reason ?? "wake_delayed",
      detail: String(result.error ?? ""),
      task_id: taskId,
      role,
      agent_id: agentId,
      old_session_id: oldSessionId,
      new_session_id: result.session_id ?? null,
      message: String(result.error ?? result.reason ?? "wake delayed"),
    };
    appendAgentReconcileEvent(opts.projectRoot, "agent_recovery.delayed", {
      task_id: taskId,
      role,
      agent_id: agentId,
      old_session_id: oldSessionId,
      reason_code: out.reason_code,
      reason_text: out.detail,
      action_taken: "recover_wake_delayed",
      remaining_ms: remainingMs,
    });
    return out;
  }
  if (!result.ok) {
    const resultReason = result.skipped ? String(result.reason ?? "wake_skipped") : "wake_failed";
    const escalate = shouldEscalateAdminForceRecovery({ reason: resultReason });
    const out = {
      ok: false,
      status: "failed" as const,
      reason: resultReason,
      reason_code: resultReason,
      detail: String(result.error ?? ""),
      task_id: taskId,
      role,
      agent_id: agentId,
      old_session_id: oldSessionId,
      new_session_id: result.session_id ?? null,
      session_id: result.session_id,
      message: String(result.error ?? result.reason ?? "wake failed"),
      remainingMs: result.remainingMs,
      untilMs: result.untilMs,
      cooldownReason: result.cooldownReason,
      policy:
        result.policy === PM_STOP_POLICY
          ? PM_STOP_POLICY
          : escalate
            ? ADMIN_FORCE_RECOVERY_POLICY
            : undefined,
      next_owner:
        result.policy === PM_STOP_POLICY
          ? "PM" as const
          : escalate
            ? "ADMIN" as const
            : undefined,
    };
    appendAgentReconcileEvent(opts.projectRoot, "agent_recovery.skipped", {
      task_id: taskId,
      role,
      agent_id: agentId,
      old_session_id: oldSessionId,
      new_session_id: result.session_id ?? null,
      reason_code: out.reason_code,
      reason_text: out.detail,
      action_taken: "recover_failed",
    });
    return out;
  }

  opts.onRecovered?.({
    task_id: taskId,
    role,
    agent_id: agentId,
    session_id: result.session_id,
  });

  const newSessionId = result.session_id ?? null;
  if (!newSessionId) {
    const out = {
      ok: false,
      status: "failed" as const,
      reason: "new_session_id_null",
      reason_code: "new_session_id_null",
      detail: "wake returned ok but no session_id",
      task_id: taskId,
      role,
      agent_id: agentId,
      old_session_id: oldSessionId,
      new_session_id: null,
      message: "recover failed: new_session_id is null",
    };
    appendAgentReconcileEvent(opts.projectRoot, "agent_recovery.failed", {
      task_id: taskId,
      role,
      agent_id: agentId,
      old_session_id: oldSessionId,
      reason_code: out.reason_code,
      reason_text: out.detail,
      action_taken: "recover_no_session",
    });
    return out;
  }

  const message = `已恢复 ${agentId} 执行`;
  appendAgentReconcileEvent(opts.projectRoot, "agent_recovery.completed", {
    task_id: taskId,
    role,
    agent_id: agentId,
    old_session_id: oldSessionId,
    new_session_id: result.session_id ?? null,
    reason_code: opts.reasonCode ?? "recover_session_unsettled",
    action_taken: "recover_completed",
    admin_hint: message,
  });

  return {
    ok: true,
    status: "recovered",
    task_id: taskId,
    role,
    agent_id: agentId,
    old_session_id: oldSessionId,
    new_session_id: newSessionId,
    session_id: newSessionId,
    reason_code: opts.reasonCode ?? "recover_session_unsettled",
    message,
  };
}
