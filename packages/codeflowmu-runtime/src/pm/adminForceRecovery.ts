/**
 * ADMIN force-recovery SOP — ordered unlock → clear failed → cancel → release → swap → recover.
 */

import { sdkCooldownRegistry } from "../_internal/SdkCooldownRegistry.ts";
import type { AgentRegistry } from "../registry/AgentRegistry.ts";
import type { AgentStatusReconciler } from "../registry/AgentStatusReconciler.ts";
import type { SessionManager } from "../session/SessionManager.ts";
import { LedgerBuilder } from "../ledger/LedgerBuilder.ts";
import {
  buildWakeDownstreamRequest,
  clearWaitingPmAttentionOnTask,
} from "./PmGovernanceActions.ts";
import { clearWorkerReceiptFailed } from "./workerReceiptDurableHints.ts";
import type { WakeDownstreamExecutor } from "./PmGovernancePlanner.ts";
import { recoverTaskExecution } from "./recoverTaskExecution.ts";
import type { WakeDownstreamRequest } from "./PmGovernanceActions.ts";
import { clearPmAbnormalWindow } from "./pmExecutionGovernance.ts";

export interface AdminForceRecoveryOpts {
  projectRoot: string;
  taskId: string;
  role: string;
  agentId: string;
  registry: AgentRegistry;
  sessionManager: SessionManager;
  statusReconciler: AgentStatusReconciler;
  wakeExecutor: WakeDownstreamExecutor;
  /** Cancel running sessions for agent (returns cancelled ids). */
  forceReleaseAgent: (
    agentId: string,
    reason: string,
  ) => Promise<{ ok: boolean; cancelled: string[]; error?: string }>;
  /** Swap sdk_agent_id (admin bypass for running session). */
  recycleAgent: (
    agentId: string,
    params: { reason: string; operator_role?: string },
  ) => Promise<{ new_sdk_agent_id: string }>;
  threadKey?: string | null;
  clearInMemoryWorkerFailed?: (taskId: string) => void;
  scheduleDelayedWake?: (
    plan: WakeDownstreamRequest,
    remainingMs: number,
    reason: string,
  ) => boolean;
  operator?: string;
}

export interface AdminForceRecoveryResult {
  ok: boolean;
  steps: Record<string, unknown>;
  recover?: Awaited<ReturnType<typeof recoverTaskExecution>>;
  error?: string;
}

export async function adminForceRecovery(
  opts: AdminForceRecoveryOpts,
): Promise<AdminForceRecoveryResult> {
  const taskId = opts.taskId.replace(/\.md$/i, "").trim();
  const role = String(opts.role ?? "").trim().toUpperCase();
  const agentId = String(opts.agentId ?? "").trim();
  const steps: Record<string, unknown> = {};

  if (!taskId || !role || !agentId) {
    return { ok: false, steps, error: "missing_params" };
  }

  steps.attention_cleared = await clearWaitingPmAttentionOnTask(opts.projectRoot, taskId);

  const durableCleared = await clearWorkerReceiptFailed(opts.projectRoot, taskId);
  opts.clearInMemoryWorkerFailed?.(taskId);
  steps.receipt_failed_cleared = durableCleared;

  sdkCooldownRegistry.clear();
  steps.sdk_cooldown_cleared = true;

  const release = await opts.forceReleaseAgent(agentId, "admin_force_recovery");
  steps.sessions_cancelled = release.cancelled;
  if (!release.ok && release.error !== "AGENT_STILL_RUNNING") {
    return { ok: false, steps, error: release.error ?? "force_release_failed" };
  }

  const forcedIdle = await opts.statusReconciler.forceIdleFromAdmin(agentId);
  steps.agent_forced_idle = forcedIdle;

  try {
    const recycled = await opts.recycleAgent(agentId, {
      reason: "admin_force_recovery",
      operator_role: opts.operator ?? "ADMIN",
    });
    steps.sdk_recycled = recycled.new_sdk_agent_id;
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    if (code !== "AGENT_BUSY") {
      return {
        ok: false,
        steps,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    steps.sdk_recycled = "skipped_agent_busy";
  }

  await new LedgerBuilder({ projectRoot: opts.projectRoot }).rebuild();
  steps.ledger_rebuilt = true;

  const recover = await recoverTaskExecution({
    projectRoot: opts.projectRoot,
    taskId,
    role,
    registry: opts.registry,
    sessionManager: opts.sessionManager,
    wakeExecutor: opts.wakeExecutor,
    statusReconciler: opts.statusReconciler,
    threadKey: opts.threadKey,
    agentId,
    reasonCode: "admin_force_recovery",
    clearInMemoryWorkerFailed: opts.clearInMemoryWorkerFailed,
    scheduleDelayedWake: opts.scheduleDelayedWake,
  });
  steps.recover = recover;

  const sessionOk = Boolean(recover.new_session_id ?? recover.session_id);
  if (!recover.ok || !sessionOk) {
    return {
      ok: false,
      steps,
      recover,
      error: sessionOk ? recover.reason : "new_session_id_null",
    };
  }

  clearPmAbnormalWindow(taskId, agentId);

  return { ok: true, steps, recover };
}
