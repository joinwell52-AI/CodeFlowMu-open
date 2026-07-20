/**
 * Assemble DeadlockDetectContext from reconcile + runtime signals.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sdkCooldownRegistry } from "../../_internal/SdkCooldownRegistry.ts";
import type { AgentRegistry } from "../../registry/AgentRegistry.ts";
import type { SessionManager } from "../../session/SessionManager.ts";
import { findTaskPathByIdSync } from "../../lifecycle/taskPathUtils.ts";
import { parseMarkdownFrontmatter } from "../../ledger/frontmatter.ts";
import { hasPendingDelayedWakeRetry } from "../scheduleDelayedPmWakeRetry.ts";
import {
  mergeWorkerReceiptSignals,
  resolveWorkerReceiptDurableHints,
} from "../workerReceiptDurableHints.ts";
import type { ReconcileAgentTaskStateResult } from "../reconcileAgentTaskState.ts";
import type { DeadlockDetectContext, RecoveryTrigger } from "./deadlockTypes.ts";
import {
  getTaskDispatchStatusFromState,
  loadAgentTaskQueue,
} from "../agentTaskQueue.ts";

export interface BuildAutoRecoveryContextInput {
  projectRoot: string;
  trigger: RecoveryTrigger;
  agentId: string;
  taskId?: string | null;
  role?: string | null;
  threadKey?: string | null;
  registry?: AgentRegistry;
  sessionManager?: SessionManager;
  reconcile?: ReconcileAgentTaskStateResult | null;
  sessionPayload?: Record<string, unknown> | null;
  inMemory?: { nudgeCount?: number; workerFailed?: boolean };
  hasReportOnDisk?: boolean;
  agentRunning?: boolean;
}

function normTaskId(id: string | null | undefined): string | null {
  const t = String(id ?? "").replace(/\.md$/i, "").trim();
  return t || null;
}

function normRole(role: string | null | undefined): string | null {
  const r = String(role ?? "").trim().toUpperCase();
  return r || null;
}

function readDisplayStatus(projectRoot: string, taskId: string): string | null {
  try {
    const lifecycleRoot = join(projectRoot, "fcop", "_lifecycle");
    const located = findTaskPathByIdSync(lifecycleRoot, taskId);
    if (!located) return null;
    const raw = readFileSync(located.path, "utf-8");
    const fm = parseMarkdownFrontmatter(raw);
    return String(fm.display_status ?? "").trim().toLowerCase() || null;
  } catch {
    return null;
  }
}

export async function buildAutoRecoveryContext(
  input: BuildAutoRecoveryContextInput,
): Promise<DeadlockDetectContext> {
  const taskId =
    normTaskId(input.taskId) ?? normTaskId(input.reconcile?.task_id ?? null);
  const role = normRole(input.role) ?? normRole(input.reconcile?.role ?? null);
  const pl = input.sessionPayload ?? {};
  const inMemory = {
    nudgeCount: input.inMemory?.nudgeCount ?? 0,
    workerFailed: input.inMemory?.workerFailed ?? false,
  };

  let agentStatus: string | null = null;
  let agentRunning = input.agentRunning ?? false;
  if (input.registry) {
    try {
      const rec = await input.registry.get(input.agentId);
      agentStatus = String(rec?.protocol.status ?? "").toLowerCase() || null;
      agentRunning =
        input.agentRunning ??
        (agentStatus === "running" ||
          agentStatus === "busy" ||
          agentStatus === "error");
    } catch {
      /* optional */
    }
  }

  let hasActiveSession = false;
  if (input.sessionManager) {
    try {
      const active = await input.sessionManager.listActive();
      hasActiveSession = active.some(
        (s) => s.protocol.agent_id === input.agentId,
      );
    } catch {
      /* optional */
    }
  }

  let workerFailedPersisted = false;
  let sessionUnsettled = false;
  let sessionFailed = false;
  let isFirstTurnAbort = pl.is_first_turn_abort === true;
  let failureCategory = String(pl.failure_category ?? "").trim() || null;
  let failureCode = String(pl.failure_code ?? pl.reason ?? "").trim() || null;
  let sessionStartedAt: string | null = null;
  let lastActivityAt: string | null = null;

  if (taskId) {
    const durable = await resolveWorkerReceiptDurableHints(
      input.projectRoot,
      taskId,
    );
    const merged = mergeWorkerReceiptSignals(inMemory, durable, {
      agentRunning,
    });
    workerFailedPersisted = durable.workerFailedPersisted;
    sessionUnsettled = merged.sessionUnsettled;
    sessionFailed = merged.sessionFailed;
    if (merged.isFirstTurnAbort) isFirstTurnAbort = true;
    if (merged.lastFailureCategory) {
      failureCategory = merged.lastFailureCategory;
    }
    if (merged.lastFailureCode) failureCode = merged.lastFailureCode;
    sessionStartedAt = merged.summary.lastStartedAt ?? null;
    lastActivityAt = merged.summary.lastEndedAt ?? null;
  }

  const displayStatus =
    taskId != null ? readDisplayStatus(input.projectRoot, taskId) : null;
  const displayStatusWaitingPm = displayStatus === "waiting_pm_attention";

  const durationMs = Number(pl.duration_ms ?? pl.durationMs ?? 0) || 0;
  const toolCallCount = Number(pl.tool_call_count ?? pl.toolCallCount ?? 0) || 0;
  const retryDelayMs = Number(pl.retry_delay_ms ?? pl.retryDelayMs ?? 0) || 0;

  if (pl.failure_category && !failureCategory) {
    failureCategory = String(pl.failure_category);
  }
  if (pl.is_first_turn_abort === true) isFirstTurnAbort = true;

  let dispatchStatusQueued = false;
  let dispatchStatusPaused = false;
  if (taskId) {
    try {
      const queueFile = await loadAgentTaskQueue(input.projectRoot);
      const ds = getTaskDispatchStatusFromState(queueFile, taskId);
      dispatchStatusQueued = ds === "queued";
      dispatchStatusPaused = ds === "paused";
    } catch {
      /* optional */
    }
  }

  return {
    projectRoot: input.projectRoot,
    trigger: input.trigger,
    taskId,
    role,
    agentId: input.agentId,
    threadKey: input.threadKey ?? null,
    reconcileState: input.reconcile?.state ?? null,
    reasonCode: input.reconcile?.reason_code ?? null,
    durationMs,
    toolCallCount,
    failureCategory,
    failureCode,
    isFirstTurnAbort,
    sessionUnsettled,
    sessionStartedAt,
    lastActivityAt,
    agentRunning,
    agentStatus,
    hasActiveSession,
    hasReportOnDisk: input.hasReportOnDisk === true,
    workerFailedPersisted,
    displayStatusWaitingPm,
    sdkCooldownActive: sdkCooldownRegistry.active,
    sdkCooldownRemainingMs: sdkCooldownRegistry.remainingMs(),
    retryDelayMs,
    hasPendingDelayedRetry:
      taskId && role ? hasPendingDelayedWakeRetry(taskId, role) : false,
    sessionFailed:
      sessionFailed ||
      String(pl.status ?? "").toLowerCase() === "failed" ||
      String(pl.status ?? "").toLowerCase() === "timeout",
    dispatchStatusQueued,
    dispatchStatusPaused,
  };
}
