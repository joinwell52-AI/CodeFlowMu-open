/**
 * Agent rotation (recycle) — config + idle gating + state for auto-recycle.
 *
 * Recycle = fresh Cursor SDK agent (clears conversation history). Auto mode
 * only runs when the agent is idle (no running session, no current_task).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentStatus } from "@codeflowmu/protocol";
import { listRuntimeEventsReadPaths } from "./logs-paths.ts";

export interface AgentRecycleConfig {
  /** When false, only manual POST /api/v2/agents/:id/recycle works. Default false. */
  enabled: boolean;
  /** Sessions (today, from thinking log) before recycle is considered. Default 10. */
  sessionThreshold: number;
  /** How often to scan for auto-recycle candidates. Default 30 minutes. */
  checkIntervalMs: number;
}

export const DEFAULT_AGENT_RECYCLE_CONFIG: AgentRecycleConfig = {
  enabled: false,
  sessionThreshold: 10,
  checkIntervalMs: 30 * 60 * 1000,
};

export interface AgentRecycleStateEntry {
  recycled_at: string;
  sessions_at_recycle: number;
  reason?: string;
}

export type AgentRecycleState = Record<string, AgentRecycleStateEntry>;

export function parseEnvBool(value: string | undefined): boolean | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return undefined;
}

export function mergeAgentRecycleConfig(
  base: AgentRecycleConfig,
  partial?: Partial<AgentRecycleConfig>,
): AgentRecycleConfig {
  if (!partial) return { ...base };
  return {
    enabled: partial.enabled ?? base.enabled,
    sessionThreshold: partial.sessionThreshold ?? base.sessionThreshold,
    checkIntervalMs: partial.checkIntervalMs ?? base.checkIntervalMs,
  };
}

export function recycleStatePath(dataDir: string): string {
  return join(dataDir, "agent-recycle-state.json");
}

export function loadRecycleState(dataDir: string): AgentRecycleState {
  const p = recycleStatePath(dataDir);
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as AgentRecycleState;
    }
  } catch {
    /* corrupt — treat as empty */
  }
  return {};
}

export function saveRecycleState(dataDir: string, state: AgentRecycleState): void {
  const p = recycleStatePath(dataDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2), "utf8");
}

/** Sessions accumulated since the last recorded recycle (or all of today if never). */
export function sessionsSinceLastRecycle(
  sessionsToday: number,
  last?: AgentRecycleStateEntry,
): number {
  if (!last) return sessionsToday;
  return Math.max(0, sessionsToday - last.sessions_at_recycle);
}

/**
 * Whether an agent is eligible for automatic recycle right now.
 * Requires: feature enabled, enough new sessions since last recycle, fully idle.
 */
export function shouldAutoRecycleAgent(input: {
  enabled: boolean;
  sessionsToday: number;
  threshold: number;
  agentStatus: AgentStatus;
  hasRunningSession: boolean;
  currentTask?: string | null;
  lastRecycle?: AgentRecycleStateEntry;
}): { should: boolean; reason: string } {
  if (!input.enabled) {
    return { should: false, reason: "auto_recycle_disabled" };
  }
  const since = sessionsSinceLastRecycle(input.sessionsToday, input.lastRecycle);
  if (since < input.threshold) {
    return { should: false, reason: "below_session_threshold" };
  }
  if (input.hasRunningSession) {
    return { should: false, reason: "running_session_active" };
  }
  if (input.agentStatus === "running") {
    return { should: false, reason: "agent_status_running" };
  }
  if (input.currentTask) {
    return { should: false, reason: "current_task_set" };
  }
  if (input.agentStatus !== "idle") {
    return { should: false, reason: `agent_status_${input.agentStatus}` };
  }
  return { should: true, reason: "idle_threshold_met" };
}

/** Today's thinking jsonl paths: legacy flat + chat/ + task/ subdirs. */
function thinkingLogPathsForDay(
  projectRoot: string,
  dayYmd: string,
): string[] {
  const root = join(projectRoot, "fcop", "logs", "thinking");
  const name = `thinking-${dayYmd}.jsonl`;
  return [
    join(root, name),
    join(root, "chat", name),
    join(root, "task", name),
  ];
}

function mergeSessionIdsFromLogFile(
  seen: Map<string, Set<string>>,
  logPath: string,
): void {
  if (!existsSync(logPath)) return;
  try {
    const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as {
          agent_id?: string;
          session_id?: string;
        };
        if (!row.agent_id || !row.session_id) continue;
        if (!seen.has(row.agent_id)) seen.set(row.agent_id, new Set());
        seen.get(row.agent_id)!.add(row.session_id);
      } catch {
        /* skip bad line */
      }
    }
  } catch {
    /* unreadable log */
  }
}

function ymdFromRuntimeRow(row: { at?: string; ts?: number }): string {
  const raw = row.at ?? (typeof row.ts === "number" ? row.ts : undefined);
  if (raw == null || raw === "") return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function mergeSessionIdsFromRuntimeEventFile(
  seen: Map<string, Set<string>>,
  logPath: string,
  dayYmd: string,
): void {
  if (!existsSync(logPath)) return;
  try {
    const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as {
          at?: string;
          ts?: number;
          event_type?: string;
          agent_id?: string;
          session_id?: string;
          payload?: {
            agent_id?: string;
            agentId?: string;
            session_id?: string;
            sessionId?: string;
          };
        };
        if (row.event_type !== "runtime.session_started") continue;
        if (ymdFromRuntimeRow(row) !== dayYmd) continue;
        const agentId = row.agent_id ?? row.payload?.agent_id ?? row.payload?.agentId;
        const sessionId =
          row.session_id ?? row.payload?.session_id ?? row.payload?.sessionId;
        if (!agentId || !sessionId) continue;
        if (!seen.has(agentId)) seen.set(agentId, new Set());
        seen.get(agentId)!.add(sessionId);
      } catch {
        /* skip bad line */
      }
    }
  } catch {
    /* unreadable log */
  }
}

/**
 * Count distinct session_ids per agent_id from today's logs.
 * Runtime session_started is the source of truth; thinking logs are retained
 * as a compatibility fallback for older builds.
 */
export function getAgentSessionStats(
  projectRoot: string,
  dayYmd?: string,
): Record<string, number> {
  const stats: Record<string, number> = {};
  const today =
    dayYmd ?? new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const seen = new Map<string, Set<string>>();
  for (const logPath of thinkingLogPathsForDay(projectRoot, today)) {
    mergeSessionIdsFromLogFile(seen, logPath);
  }
  for (const logPath of listRuntimeEventsReadPaths(projectRoot)) {
    mergeSessionIdsFromRuntimeEventFile(seen, logPath, today);
  }
  for (const [agentId, set] of seen) {
    stats[agentId] = set.size;
  }
  return stats;
}
