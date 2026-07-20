/**
 * Agent reconcile / recovery / swap-AI runtime event append (fcop/logs/runtime).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { fcopLogsRuntimeDir } from "../logs/actionLogPaths.ts";

export const AGENT_RECONCILE_EVENT_TYPES = [
  "agent_reconcile.checked",
  "agent_reconcile.running",
  "agent_reconcile.waiting_report",
  "agent_reconcile.recoverable",
  "agent_reconcile.failed",
  "agent_reconcile.blocked",
  "agent_reconcile.done",
  "agent_recovery.started",
  "agent_recovery.completed",
  "agent_recovery.skipped",
  "agent_recovery.delayed",
  "agent_recovery.failed",
  "ai_swap.checked",
  "ai_swap.deferred",
  "ai_swap.recovered",
  "ai_swap.blocked",
  "ai_swap.manual_override",
] as const;

export type AgentReconcileEventType = (typeof AGENT_RECONCILE_EVENT_TYPES)[number];

export interface AgentReconcileEventPayload {
  task_id?: string | null;
  role?: string | null;
  agent_id?: string | null;
  old_session_id?: string | null;
  new_session_id?: string | null;
  reason_code?: string | null;
  reason_text?: string | null;
  action_taken?: string | null;
  admin_hint?: string | null;
  trigger?: string | null;
  reconcile_state?: string | null;
  remaining_ms?: number | null;
}

function logsDateKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function eventPath(projectRoot: string): string {
  const dir = fcopLogsRuntimeDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  return join(dir, `runtime-events-${logsDateKey()}.jsonl`);
}

export function appendAgentReconcileEvent(
  projectRoot: string,
  eventType: AgentReconcileEventType,
  payload: AgentReconcileEventPayload,
): void {
  const line = {
    ts: Date.now(),
    at: new Date().toISOString(),
    event_type: eventType,
    ...(payload.agent_id ? { agent_id: payload.agent_id } : {}),
    ...(payload.new_session_id
      ? { session_id: payload.new_session_id }
      : payload.old_session_id
        ? { session_id: payload.old_session_id }
        : {}),
    ...(payload.task_id ? { task_id: payload.task_id } : {}),
    payload,
  };
  try {
    appendFileSync(eventPath(projectRoot), `${JSON.stringify(line)}\n`, "utf-8");
  } catch {
    /* best-effort */
  }
}
