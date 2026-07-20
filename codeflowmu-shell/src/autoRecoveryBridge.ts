/**
 * Shell bridge: wires panel/runtime deps into pm auto-recovery.
 */

import {
  AUTO_RECOVERY_MIN_RETRY_MS,
  buildAutoRecoveryContext,
  formatAutoRecoveryForPanel,
  runAutoRecovery,
  type RecoveryExecutorDeps,
  type RecoveryTrigger,
  type ReconcileAgentTaskStateResult,
  type Runtime,
  type TaskDispatcher,
  type WakeDownstreamRequest,
} from "@codeflowmu/runtime";
import { setAgentReconcileResultCallback } from "./agent-reconcile-hooks.ts";

export { AUTO_RECOVERY_MIN_RETRY_MS };

export interface AutoRecoveryBridgeDeps {
  resolveProjectRoot: () => string;
  runtime: Runtime;
  wakeExecutor: () =>
    | ((plan: WakeDownstreamRequest) => Promise<{ ok: boolean; reason?: string }>)
    | null;
  performAgentRecycle: (
    agentId: string,
    params: { reason: string; operator_role?: string },
  ) => Promise<{ new_sdk_agent_id: string }>;
  scheduleDelayedWake: (
    plan: WakeDownstreamRequest,
    remainingMs: number,
    reason: string,
  ) => boolean;
  dispatcher: TaskDispatcher;
}

let bridgeDeps: AutoRecoveryBridgeDeps | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
const sessionStallTimers = new Map<string, ReturnType<typeof setTimeout>>();
const recentDedup = new Map<string, number>();
const DEDUP_MS = 60_000;

function buildDedupKey(input: PanelAutoRecoveryInput): string {
  const extra =
    input.reconcile?.reason_code ?? input.reconcile?.state ?? "";
  return `${input.trigger}:${input.taskId ?? ""}:${input.agentId}:${extra}`;
}

function isDedupBlocked(key: string): boolean {
  const last = recentDedup.get(key);
  if (last == null) return false;
  return Date.now() - last < DEDUP_MS;
}

function markDedup(key: string): void {
  recentDedup.set(key, Date.now());
}

export interface PanelAutoRecoveryInput {
  trigger: RecoveryTrigger;
  agentId: string;
  taskId?: string | null;
  role?: string | null;
  threadKey?: string | null;
  reconcile?: ReconcileAgentTaskStateResult | null;
  sessionPayload?: Record<string, unknown> | null;
}

function buildExecutorDeps(threadKey?: string | null): RecoveryExecutorDeps {
  if (!bridgeDeps) {
    throw new Error("autoRecoveryBridge not initialized");
  }
  const {
    resolveProjectRoot,
    wakeExecutor,
    performAgentRecycle,
    scheduleDelayedWake,
    runtime,
  } = bridgeDeps;

  return {
    projectRoot: resolveProjectRoot(),
    registry: runtime.registry,
    sessionManager: runtime.sessionManager,
    statusReconciler: runtime.statusReconciler,
    threadKey: threadKey ?? null,
    wakeExecutor: async (plan) => {
      const exec = wakeExecutor();
      if (!exec) return { ok: false, reason: "wake_executor_unavailable" };
      return exec(plan);
    },
    forceReleaseAgent: (agentId, reason) =>
      runtime.forceReleaseAgent(agentId, reason),
    recycleAgent: performAgentRecycle,
    scheduleDelayedWake,
    clearInMemoryWorkerFailed: (taskId) => {
      runtime.pmQueueGuard.clearDownstreamWorkerFailed(taskId);
    },
  };
}

export async function triggerPanelAutoRecovery(
  input: PanelAutoRecoveryInput,
): Promise<void> {
  if (!bridgeDeps) return;
  const key = buildDedupKey(input);
  if (isDedupBlocked(key)) return;
  markDedup(key);

  const { runtime, resolveProjectRoot } = bridgeDeps;
  const projectRoot = resolveProjectRoot();
  const taskId =
    input.taskId ?? input.reconcile?.task_id ?? null;

  const ctx = await buildAutoRecoveryContext({
    projectRoot,
    trigger: input.trigger,
    agentId: input.agentId,
    taskId,
    role: input.role ?? input.reconcile?.role ?? null,
    threadKey: input.threadKey ?? null,
    registry: runtime.registry,
    sessionManager: runtime.sessionManager,
    reconcile: input.reconcile ?? null,
    sessionPayload: input.sessionPayload ?? null,
    inMemory: taskId
      ? {
          nudgeCount: runtime.pmQueueGuard.nudgeCountForTask(taskId),
          workerFailed: runtime.pmQueueGuard.isDownstreamWorkerFailed(taskId),
        }
      : undefined,
  });

  try {
    await runAutoRecovery({
      ctx,
      deps: buildExecutorDeps(input.threadKey),
    });
  } catch (err) {
    console.warn(
      "[auto-recovery] trigger failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function getPanelAutoRecoverySnapshot(limit = 20) {
  if (!bridgeDeps) {
    return [];
  }
  return formatAutoRecoveryForPanel(bridgeDeps.resolveProjectRoot(), limit);
}

function onReconcileResult(
  result: ReconcileAgentTaskStateResult,
  _trigger: string,
): void {
  if (!bridgeDeps) return;
  const agentId = result.agent_id;
  if (!agentId) return;

  void triggerPanelAutoRecovery({
    trigger: "reconcile_result",
    agentId,
    taskId: result.task_id,
    role: result.role,
    reconcile: result,
  });
}

function onDispatchRetry(info: {
  agentId: string;
  taskId: string;
  delayMs: number;
  note: string;
}): void {
  void triggerPanelAutoRecovery({
    trigger: "task_dispatcher_retry",
    agentId: info.agentId,
    taskId: info.taskId,
    sessionPayload: {
      retry_delay_ms: info.delayMs,
      dispatch_retry_note: info.note,
    },
  });
}

async function runWatchdogTick(): Promise<void> {
  if (!bridgeDeps) return;
  const { runtime } = bridgeDeps;
  const agents = await runtime.registry.list();
  for (const agent of agents) {
    const snap = agent.runtime?.["task_binding"] as
      | { task_id?: string; thread_key?: string }
      | undefined;
    void triggerPanelAutoRecovery({
      trigger: "watchdog",
      agentId: agent.protocol.agent_id,
      taskId: snap?.task_id ?? null,
      role: agent.protocol.role,
      threadKey: snap?.thread_key ?? null,
    });
  }
}

export function initAutoRecoveryBridge(deps: AutoRecoveryBridgeDeps): void {
  stopAutoRecoveryBridge();
  bridgeDeps = deps;

  setAgentReconcileResultCallback(onReconcileResult);
  deps.dispatcher.setDispatchRetryHook(onDispatchRetry);

  watchdogTimer = setInterval(() => {
    void runWatchdogTick();
  }, AUTO_RECOVERY_MIN_RETRY_MS);
}

export function stopAutoRecoveryBridge(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  setAgentReconcileResultCallback(null);
  bridgeDeps?.dispatcher.setDispatchRetryHook(null);
  for (const t of sessionStallTimers.values()) {
    clearTimeout(t);
  }
  sessionStallTimers.clear();
  bridgeDeps = null;
}

export function scheduleSessionStartedStallCheck(input: {
  agentId: string;
  taskId?: string | null;
  sessionId?: string | null;
}): void {
  const key = `${input.agentId}:${input.taskId ?? ""}:${input.sessionId ?? ""}`;
  const existing = sessionStallTimers.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    sessionStallTimers.delete(key);
    void triggerPanelAutoRecovery({
      trigger: "session_started_stall",
      agentId: input.agentId,
      taskId: input.taskId ?? null,
      sessionPayload: {
        session_id: input.sessionId ?? null,
        stall_check_ms: AUTO_RECOVERY_MIN_RETRY_MS,
      },
    });
  }, AUTO_RECOVERY_MIN_RETRY_MS);

  sessionStallTimers.set(key, timer);
}
