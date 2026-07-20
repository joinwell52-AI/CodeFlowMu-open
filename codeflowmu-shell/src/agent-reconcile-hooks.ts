/**
 * Agent reconcile trigger hooks — shared by Panel API routes.
 */

import type { Runtime, WakeDownstreamExecutor } from "@codeflowmu/runtime";
import {
  appendAgentReconcileEvent,
  reconcileAgentTaskState,
  findPmSummaryBlockers,
  recoverTaskExecution,
  type ReconcileAgentTaskStateResult,
  type LedgerReportRecord,
  type LedgerTaskRecord,
} from "@codeflowmu/runtime";

import { appendPanelRuntimeAction } from "./panel-runtime-actions.ts";

type ReconcileResultCallback = (
  result: ReconcileAgentTaskStateResult,
  trigger: string,
) => void;

let reconcileResultCallback: ReconcileResultCallback | null = null;

export function setAgentReconcileResultCallback(
  cb: ReconcileResultCallback | null,
): void {
  reconcileResultCallback = cb;
}

export type ReconcileTrigger =
  | "swap_ai"
  | "wake"
  | "dispatch"
  | "recover"
  | "runtime_startup"
  | "task_detail"
  | "queue_refresh"
  | "session_ended"
  | "pm_summary";

export async function runAgentReconcile(opts: {
  projectRoot: string;
  runtime: Runtime;
  agentId: string;
  taskId?: string | null;
  trigger: ReconcileTrigger;
  tasks: LedgerTaskRecord[];
  reports: LedgerReportRecord[];
  operator?: string;
}): Promise<ReconcileAgentTaskStateResult> {
  const result = await reconcileAgentTaskState({
    projectRoot: opts.projectRoot,
    agentId: opts.agentId,
    taskId: opts.taskId,
    registry: opts.runtime.registry,
    sessionManager: opts.runtime.sessionManager,
    tasks: opts.tasks,
    reports: opts.reports,
    nudgeCount: opts.taskId
      ? opts.runtime.pmQueueGuard.nudgeCountForTask(opts.taskId)
      : 0,
    workerFailed: opts.taskId
      ? opts.runtime.pmQueueGuard.isDownstreamWorkerFailed(opts.taskId)
      : false,
  });

  const eventType =
    result.state === "unknown" || result.state === "idle"
      ? "agent_reconcile.checked"
      : (`agent_reconcile.${result.state}` as
          | "agent_reconcile.running"
          | "agent_reconcile.waiting_report"
          | "agent_reconcile.recoverable"
          | "agent_reconcile.failed"
          | "agent_reconcile.blocked"
          | "agent_reconcile.done");
  appendAgentReconcileEvent(opts.projectRoot, eventType, {
    task_id: result.task_id,
    role: result.role,
    agent_id: result.agent_id,
    old_session_id: result.session_id,
    reason_code: result.reason_code,
    reason_text: result.reason_text,
    admin_hint: result.admin_hint,
    trigger: opts.trigger,
    reconcile_state: result.state,
    action_taken: `reconcile_${opts.trigger}`,
  });

  appendPanelRuntimeAction(opts.projectRoot, {
    operator: opts.operator ?? "ADMIN",
    action: "reconcile",
    target_agent: opts.agentId,
    target_task: result.task_id ?? undefined,
    result: "ok",
    reason: result.state,
    detail: result.admin_hint.split("\n")[0]?.slice(0, 200),
  });

  reconcileResultCallback?.(result, opts.trigger);

  return result;
}

export async function handleSwapAiWithReconcile(opts: {
  projectRoot: string;
  runtime: Runtime;
  agentId: string;
  taskId?: string | null;
  operator?: string;
  /** Panel manual swap: cancel sessions first, then recycle even if reconcile is running/failed. */
  manualForce?: boolean;
  performRecycle: () => Promise<Record<string, unknown>>;
  wakeExecutor?: WakeDownstreamExecutor | null;
  tasks: LedgerTaskRecord[];
  reports: LedgerReportRecord[];
}): Promise<{
  reconcile: ReconcileAgentTaskStateResult;
  recycle?: Record<string, unknown>;
  deferred?: boolean;
  blocked?: boolean;
}> {
  const reconcile = await runAgentReconcile({
    projectRoot: opts.projectRoot,
    runtime: opts.runtime,
    agentId: opts.agentId,
    taskId: opts.taskId,
    trigger: "swap_ai",
    tasks: opts.tasks,
    reports: opts.reports,
    operator: opts.operator,
  });

  appendAgentReconcileEvent(opts.projectRoot, "ai_swap.checked", {
    agent_id: opts.agentId,
    task_id: reconcile.task_id,
    reason_code: reconcile.reason_code,
    admin_hint: reconcile.admin_hint,
    reconcile_state: reconcile.state,
  });

  if (reconcile.state === "running" && !opts.manualForce) {
    appendAgentReconcileEvent(opts.projectRoot, "ai_swap.deferred", {
      agent_id: opts.agentId,
      task_id: reconcile.task_id,
      admin_hint: "换 AI 已设置为下次生效；当前 Agent 仍在执行，不中断当前 session。",
      action_taken: "deferred",
    });
    return { reconcile, deferred: true };
  }

  if (reconcile.state === "failed" && !opts.manualForce) {
    appendAgentReconcileEvent(opts.projectRoot, "ai_swap.blocked", {
      agent_id: opts.agentId,
      task_id: reconcile.task_id,
      admin_hint: "未自动恢复：最新 REPORT 为 failed/blocked，需要 PM/ADMIN 决策。",
      action_taken: "blocked",
    });
    return { reconcile, blocked: true };
  }

  if (
    opts.manualForce &&
    (reconcile.state === "running" || reconcile.state === "failed")
  ) {
    appendAgentReconcileEvent(opts.projectRoot, "ai_swap.manual_override", {
      agent_id: opts.agentId,
      task_id: reconcile.task_id,
      admin_hint: reconcile.admin_hint,
      reconcile_state: reconcile.state,
      action_taken: "manual_force_recycle",
    });
  }

  if (
    reconcile.state === "recoverable" &&
    reconcile.task_id &&
    reconcile.role &&
    opts.wakeExecutor
  ) {
    await opts.runtime.statusReconciler.releaseStaleBusyIfNoSession(
      opts.agentId,
      opts.runtime.sessionManager,
    );
    const recycle = await opts.performRecycle();
    const recovered = await recoverTaskExecution({
      projectRoot: opts.projectRoot,
      taskId: reconcile.task_id,
      role: reconcile.role,
      registry: opts.runtime.registry,
      sessionManager: opts.runtime.sessionManager,
      wakeExecutor: opts.wakeExecutor,
      statusReconciler: opts.runtime.statusReconciler,
      reasonCode: reconcile.reason_code,
      clearInMemoryWorkerFailed: (tid) => {
        opts.runtime.pmQueueGuard.clearDownstreamWorkerFailed(tid);
      },
    });
    appendAgentReconcileEvent(opts.projectRoot, "ai_swap.recovered", {
      agent_id: opts.agentId,
      task_id: reconcile.task_id,
      old_session_id: recovered.old_session_id,
      new_session_id: recovered.new_session_id,
      admin_hint: recovered.message ?? reconcile.admin_hint,
      action_taken: "swap_and_recover",
    });
    return { reconcile, recycle, deferred: false };
  }

  const recycle = await opts.performRecycle();
  return { reconcile, recycle };
}

export async function checkPmSummaryAllowed(opts: {
  projectRoot: string;
  runtime: Runtime;
  taskId: string;
  threadKey?: string | null;
  tasks: LedgerTaskRecord[];
  reports: LedgerReportRecord[];
}): Promise<{ allowed: boolean; blockers: ReconcileAgentTaskStateResult[] }> {
  const blockers = await findPmSummaryBlockers({
    projectRoot: opts.projectRoot,
    registry: opts.runtime.registry,
    sessionManager: opts.runtime.sessionManager,
    tasks: opts.tasks,
    reports: opts.reports,
    threadKey: opts.threadKey,
  });
  if (blockers.length > 0) {
    for (const b of blockers) {
      appendAgentReconcileEvent(opts.projectRoot, "agent_reconcile.recoverable", {
        task_id: b.task_id,
        role: b.role,
        agent_id: b.agent_id,
        admin_hint: `PM 总结被阻止：${b.admin_hint}`,
        trigger: "pm_summary",
        action_taken: "pm_summary_blocked",
      });
    }
  }
  return { allowed: blockers.length === 0, blockers };
}
