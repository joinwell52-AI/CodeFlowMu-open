/**
 * AgentWakeGuard — pre-flight gate before PM wake / startSession.
 *
 * Blocks wake when agent is not idle|error, SDK cooldown is active,
 * or the agent already has an active session.
 */

import type { AgentRegistry } from "../registry/AgentRegistry.ts";
import type { SessionManager } from "../session/SessionManager.ts";
import { sdkCooldownRegistry } from "./SdkCooldownRegistry.ts";

const ALLOWED_WAKE_STATUSES = new Set(["idle", "error"]);

export type AgentWakeSkipReason =
  | "agent_running"
  | "agent_blocked"
  | "agent_review"
  | "agent_stopped"
  | "agent_status_not_idle"
  | "sdk_cooldown"
  | "active_session"
  | "task_not_dispatched"
  | "task_paused";

export type AgentWakeGateResult =
  | { allow: true }
  | {
      allow: false;
      reason: AgentWakeSkipReason;
      detail: string;
      /** When set, caller should schedule a delayed wake retry. */
      retryAfterMs?: number;
    };

function mapStatusToSkipReason(status: string): AgentWakeSkipReason {
  const s = status.toLowerCase();
  if (s === "running") return "agent_running";
  if (s === "blocked") return "agent_blocked";
  if (s === "review") return "agent_review";
  if (s === "stopped") return "agent_stopped";
  return "agent_status_not_idle";
}

export async function evaluateAgentWakeGate(opts: {
  agentId: string;
  registry: AgentRegistry;
  sessionManager: SessionManager;
  sdkCooldownActive?: boolean;
}): Promise<AgentWakeGateResult> {
  const agentId = opts.agentId.trim();
  if (!agentId) {
    return {
      allow: false,
      reason: "agent_status_not_idle",
      detail: "empty agent_id",
    };
  }

  if (opts.sdkCooldownActive ?? sdkCooldownRegistry.active) {
    const remainingMs = sdkCooldownRegistry.remainingMs();
    return {
      allow: false,
      reason: "sdk_cooldown",
      detail: sdkCooldownRegistry.reason || "SDK cooldown active",
      retryAfterMs: remainingMs > 0 ? remainingMs : undefined,
    };
  }

  const record = await opts.registry.get(agentId);
  if (!record) {
    return {
      allow: false,
      reason: "agent_status_not_idle",
      detail: `agent not found: ${agentId}`,
    };
  }

  const status = String(record.protocol.status ?? "").toLowerCase();
  if (!ALLOWED_WAKE_STATUSES.has(status)) {
    return {
      allow: false,
      reason: mapStatusToSkipReason(status),
      detail: `agent status=${status}`,
    };
  }

  const active = await opts.sessionManager.listActive();
  const hasSession = active.some((s) => s.agent_id === agentId);
  if (hasSession) {
    return {
      allow: false,
      reason: "active_session",
      detail: `agent ${agentId} has active session`,
    };
  }

  return { allow: true };
}

/** Block wake when TASK is still held in inbox (two-phase dispatch). */
export async function evaluateTaskDispatchWakeGate(opts: {
  projectRoot: string;
  taskId: string;
}): Promise<AgentWakeGateResult> {
  const taskId = opts.taskId.trim().replace(/\.md$/i, "");
  if (!taskId) {
    return { allow: true };
  }

  const { isTaskPaused, loadAgentTaskQueue } = await import(
    "../pm/agentTaskQueue.ts"
  );
  const queueFile = await loadAgentTaskQueue(opts.projectRoot);
  if (isTaskPaused(queueFile, taskId)) {
    return {
      allow: false,
      reason: "task_paused",
      detail: "task is paused — use resume instead of wake",
    };
  }

  const { loadDispatchGateContext } = await import("../pm/taskDispatchContext.ts");
  const { isTaskRunnableForWake } = await import("../pm/taskDispatchGate.ts");
  const ctx = await loadDispatchGateContext(opts.projectRoot);
  const task = ctx.tasks.find(
    (t) =>
      t.taskId === taskId ||
      t.taskId.startsWith(taskId) ||
      t.filename.replace(/\.md$/i, "") === taskId,
  );
  if (!task) {
    return { allow: true };
  }

  const check = isTaskRunnableForWake(task);
  if (!check.runnable && check.reason === "task_not_dispatched") {
    return {
      allow: false,
      reason: "task_not_dispatched",
      detail: check.detail ?? "task held in inbox awaiting explicit dispatch",
    };
  }
  return { allow: true };
}
