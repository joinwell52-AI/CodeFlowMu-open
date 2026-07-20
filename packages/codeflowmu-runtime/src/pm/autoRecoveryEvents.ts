/**
 * Auto-recovery runtime audit events (extends reconcile log stream).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { fcopLogsRuntimeDir } from "../logs/actionLogPaths.ts";

export const AUTO_RECOVERY_EVENT_TYPES = [
  "deadlock.detected",
  "auto_recovery.detected",
  "auto_recovery.planned",
  "auto_recovery.executed",
  "auto_recovery.delayed",
  "auto_recovery.escalated",
  "auto_recovery.failed",
  "auto_recovery.skipped",
  "wake_agent.delayed",
  "auto_recovery.retry_loop_guarded",
  "auto_recovery.stale_failed_receipt_cleared",
] as const;

export type AutoRecoveryEventType = (typeof AUTO_RECOVERY_EVENT_TYPES)[number];

/** Known audit events plus forward-compatible string for extensions. */
export type AutoRecoveryEventName = AutoRecoveryEventType | string;

export interface AutoRecoveryEventPayload {
  task_id?: string | null;
  role?: string | null;
  agent_id?: string | null;
  reason_code?: string | null;
  admin_hint?: string | null;
  trigger?: string | null;
  deadlock_kind?: string | null;
  plan_action?: string | null;
  action?: string | null;
  attempt?: number | null;
  delay_ms?: number | null;
  remaining_ms?: number | null;
  retry_at?: string | null;
  new_session_id?: string | null;
  result?: string | null;
  skipped_reason?: string | null;
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

export function appendAutoRecoveryEvent(
  projectRoot: string,
  eventType: AutoRecoveryEventName,
  payload: AutoRecoveryEventPayload,
): void {
  const line = {
    ts: Date.now(),
    at: new Date().toISOString(),
    event_type: eventType,
    ...(payload.agent_id ? { agent_id: payload.agent_id } : {}),
    ...(payload.task_id ? { task_id: payload.task_id } : {}),
    payload,
  };
  try {
    appendFileSync(eventPath(projectRoot), `${JSON.stringify(line)}\n`, "utf-8");
  } catch {
    /* best-effort */
  }
}
