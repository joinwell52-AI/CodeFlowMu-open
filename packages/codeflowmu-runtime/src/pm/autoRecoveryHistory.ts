/**
 * Query auto-recovery history from runtime event log.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { fcopLogsRuntimeDir } from "../logs/actionLogPaths.ts";
import { AUTO_RECOVERY_EVENT_TYPES } from "./autoRecoveryEvents.ts";

const AUTO_RECOVERY_SET = new Set<string>(AUTO_RECOVERY_EVENT_TYPES);

export interface AutoRecoveryHistoryEntry {
  ts: number;
  at: string;
  event_type: string;
  task_id?: string;
  agent_id?: string;
  payload: Record<string, unknown>;
}

export function listAutoRecoveryHistory(
  projectRoot: string,
  limit = 50,
): AutoRecoveryHistoryEntry[] {
  const dir = fcopLogsRuntimeDir(projectRoot);
  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((f) => f.startsWith("runtime-events-") && f.endsWith(".jsonl"))
      .sort()
      .reverse();
  } catch {
    return [];
  }

  const out: AutoRecoveryHistoryEntry[] = [];
  for (const file of files) {
    if (out.length >= limit) break;
    let text = "";
    try {
      text = readFileSync(join(dir, file), "utf-8");
    } catch {
      continue;
    }
    const lines = text.trim().split("\n").filter(Boolean).reverse();
    for (const line of lines) {
      if (out.length >= limit) break;
      try {
        const row = JSON.parse(line) as {
          ts?: number;
          at?: string;
          event_type?: string;
          task_id?: string;
          agent_id?: string;
          payload?: Record<string, unknown>;
        };
        const et = String(row.event_type ?? "");
        if (!AUTO_RECOVERY_SET.has(et)) continue;
        out.push({
          ts: row.ts ?? 0,
          at: row.at ?? "",
          event_type: et,
          task_id: row.task_id ?? (row.payload?.task_id as string | undefined),
          agent_id: row.agent_id ?? (row.payload?.agent_id as string | undefined),
          payload: row.payload ?? {},
        });
      } catch {
        /* skip bad line */
      }
    }
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

export interface AutoRecoveryPanelEntry {
  task_id: string;
  agent_id: string;
  type: string;
  status: string;
  attempt: number;
  lastAction: string;
  new_session_id?: string;
  at: string;
}

function panelStatusFromEvent(eventType: string): string {
  if (eventType.includes("executed")) return "executed";
  if (eventType.includes("delayed")) return "delayed";
  if (eventType.includes("escalated")) return "escalated";
  if (eventType.includes("failed")) return "failed";
  if (eventType.includes("skipped")) return "skipped";
  if (eventType.includes("detected")) return "detected";
  if (eventType.includes("planned")) return "planned";
  return "unknown";
}

/** Latest auto-recovery row per task+agent for Panel queue API. */
export function formatAutoRecoveryForPanel(
  projectRoot: string,
  limit = 20,
): AutoRecoveryPanelEntry[] {
  const history = listAutoRecoveryHistory(projectRoot, limit * 4);
  const byKey = new Map<string, AutoRecoveryPanelEntry>();
  for (const row of history) {
    const taskId = String(row.task_id ?? row.payload.task_id ?? "").trim();
    const agentId = String(row.agent_id ?? row.payload.agent_id ?? "").trim();
    if (!taskId || !agentId) continue;
    const key = `${taskId}:${agentId}`;
    if (byKey.has(key)) continue;
    const payload = row.payload;
    byKey.set(key, {
      task_id: taskId,
      agent_id: agentId,
      type: String(payload.deadlock_kind ?? payload.action ?? ""),
      status: panelStatusFromEvent(row.event_type),
      attempt: Number(payload.attempt ?? 0) || 0,
      lastAction: String(
        payload.plan_action ?? payload.action ?? row.event_type,
      ),
      new_session_id:
        typeof payload.new_session_id === "string"
          ? payload.new_session_id
          : undefined,
      at: row.at,
    });
    if (byKey.size >= limit) break;
  }
  return Array.from(byKey.values());
}
