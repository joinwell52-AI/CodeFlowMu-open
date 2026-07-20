/**
 * Log center query — merges doorbell ring buffer + runtime-events.jsonl.
 */

import { EventDisplayDedupeRegistry } from "@codeflowmu/runtime";
import type { DoorbellBuffer, DoorbellEvent } from "./doorbell-buffer.js";
import type { RuntimeEventFileLogger, RuntimeEventRecord } from "./runtime-event-logger.js";

export type LogCenterTab =
  | "all"
  | "alerts"
  | "runtime"
  | "tools"
  | "actions"
  | "skills"
  | "sessions"
  | "wake"
  | "gateway"
  | "raw";

export interface LogCenterQueryParams {
  tab?: LogCenterTab;
  agent?: string;
  role?: string;
  task_id?: string;
  session_id?: string;
  event_type?: string;
  status?: string;
  reason?: string;
  skill_id?: string;
  since?: number;
  limit?: number;
}

export interface LogCenterRow {
  id: string;
  ts: number;
  at: string;
  tab: LogCenterTab;
  event_type: string;
  level: "ERROR" | "WARN" | "INFO";
  agent_id?: string;
  session_id?: string;
  task_id?: string;
  status?: string;
  reason?: string;
  call_id?: string;
  normalized_error_code?: string;
  message?: string;
  tool_name?: string;
  args_preview?: string;
  duration_ms?: number;
  tool_call_count?: number;
  last_tool?: string;
  last_action?: string;
  report_written?: boolean;
  report_path?: string;
  started_at?: string;
  ended_at?: string;
  thread_key?: string;
  payload?: unknown;
}

export interface AgentSessionRow {
  ts: number;
  at: string;
  agent_id: string;
  session_id: string;
  task_id: string;
  status: string;
  reason: string;
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
  tool_call_count: number;
  last_tool?: string;
  last_action?: string;
  report_written: boolean;
  report_path?: string;
}

/** Events shown on the Runtime tab (in addition to row.tab === "runtime"). */
const RUNTIME_TAB_EVENTS = new Set([
  "runtime.session_started",
  "runtime.session_completed",
  "runtime.session_ended",
  "runtime.session_cancelled",
  "sdk.result",
  "sdk.status",
  "codeflowmu.task_dispatched",
  "codeflowmu.report_detected",
  "codeflowmu.lifecycle.inbox_to_active",
  "codeflowmu.lifecycle.task_to_review",
  "codeflowmu.lifecycle.root_review_blocked",
  "codeflowmu.lifecycle.review_to_done",
  "codeflowmu.lifecycle.done_to_archive",
  "codeflowmu.lifecycle.review_to_active",
  "codeflowmu.report_gate.missing_report",
  "codeflowmu.report_gate.waiting_report",
  "transient_sdk_error",
  "transient_sdk_retry",
]);

const RUNTIME_TYPES = new Set([
  "runtime.session_started",
  "runtime.session_completed",
  "runtime.session_ended",
  "runtime.session_cancelled",
  "sdk.result",
  "sdk.status",
  "transient_sdk_error",
  "transient_sdk_retry",
  "codeflowmu.failure",
  "codeflowmu.failure_recorded",
  "codeflowmu.task_dispatched",
  "codeflowmu.report_detected",
  "codeflowmu.lifecycle.inbox_to_active",
  "codeflowmu.lifecycle.task_to_review",
  "codeflowmu.lifecycle.root_review_blocked",
  "codeflowmu.lifecycle.review_to_done",
  "codeflowmu.lifecycle.done_to_archive",
  "codeflowmu.lifecycle.review_to_active",
  "codeflowmu.report_gate.missing_report",
  "codeflowmu.report_gate.waiting_report",
]);

const WAKE_TYPES = new Set([
  "wake_agent.requested",
  "wake_agent.accepted",
  "wake_agent.failed",
  "wake_agent.skipped",
  "wake_agent.delayed",
]);

function pluckPayload(p: unknown): Record<string, unknown> {
  const outer = (p ?? {}) as Record<string, unknown>;
  const inner = outer["payload"];
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    return { ...outer, ...(inner as Record<string, unknown>) };
  }
  return outer;
}

function pickPayloadString(
  payload: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  const candidates: Record<string, unknown>[] = [payload];
  for (const nestedKey of ["raw", "error", "details"] as const) {
    const nested = payload[nestedKey];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      candidates.push(nested as Record<string, unknown>);
    }
  }
  for (const candidate of candidates) {
    for (const key of keys) {
      const value = candidate[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return undefined;
}

function rowLevel(
  eventType: string,
  merged: Record<string, unknown>,
): "ERROR" | "WARN" | "INFO" {
  if (eventType === "codeflowmu.failure") {
    if (String(merged.severity ?? "").toUpperCase() === "WARN") return "WARN";
    return "ERROR";
  }
  if (eventType === "codeflowmu.report_gate.waiting_report") return "INFO";
  if (eventType === "codeflowmu.report_gate.missing_report") return "WARN";
  if (eventType === "sdk.result") {
    const raw = merged["raw"];
    const sdkStatus =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? String((raw as Record<string, unknown>)["status"] ?? "")
        : "";
    if (sdkStatus === "cancelled") return "WARN";
  }
  const st = String(merged.status ?? "");
  const reason = String(merged.reason ?? merged.failure_code ?? "");
  if (st === "failed" || st === "error") return "ERROR";
  if (
    st === "cancelled" ||
    reason === "TURN_LIMIT" ||
    merged.failure_code === "TURN_LIMIT" ||
    eventType === "transient_sdk_error" ||
    eventType === "wake_agent.failed"
  ) {
    return "WARN";
  }
  return "INFO";
}

function classifyTab(eventType: string): LogCenterTab {
  if (
    eventType === "codeflowmu.failure" ||
    eventType === "codeflowmu.failure_recorded" ||
    eventType === "codeflowmu.report_gate.missing_report"
  ) {
    return "alerts";
  }
  if (eventType === "codeflowmu.report_gate.waiting_report") {
    return "runtime";
  }
  if (eventType === "sdk.tool_call") return "tools";
  if (WAKE_TYPES.has(eventType)) return "wake";
  if (eventType.startsWith("runtime.session_")) return "sessions";
  if (RUNTIME_TYPES.has(eventType)) return "runtime";
  return "runtime";
}

function doorbellToRow(e: DoorbellEvent): LogCenterRow {
  const merged = pluckPayload(e.payload);
  const eventType = e.event_type;
  const tab = classifyTab(eventType);
  const level = rowLevel(eventType, merged);
  const sessionId =
    typeof merged.session_id === "string"
      ? merged.session_id
      : undefined;
  const taskId =
    typeof merged.task_id === "string" ? merged.task_id : undefined;
  const status = typeof merged.status === "string" ? merged.status : undefined;
  const callId = pickPayloadString(merged, ["call_id", "tool_call_id", "tool_use_id"]);
  const normalizedErrorCode = pickPayloadString(merged, [
    "normalized_error_code",
    "error_code",
    "failure_code",
    "code",
    "reason_code",
  ]);
  const reason =
    typeof merged.reason === "string"
      ? merged.reason
      : typeof merged.failure_code === "string"
        ? merged.failure_code
        : typeof merged.settlement_reason === "string"
          ? merged.settlement_reason
          : undefined;

  let message = "";
  if (eventType === "codeflowmu.failure") {
    message = String(merged.description ?? merged.message ?? "");
  } else if (eventType === "codeflowmu.report_gate.waiting_report") {
    message = String(
      merged.message ??
        `waiting REPORT for ${String(merged.task_id ?? taskId ?? "?")}`,
    );
  } else if (eventType === "codeflowmu.report_gate.missing_report") {
    message = String(
      merged.message ??
        `missing REPORT for ${String(merged.task_id ?? taskId ?? "?")}`,
    );
  } else if (eventType === "runtime.session_ended" || eventType === "runtime.session_cancelled") {
    message = [status, reason, merged.error].filter(Boolean).join(" · ");
  } else {
    message = String(merged.message ?? merged.error ?? reason ?? eventType);
  }

  return {
    id: e.id,
    ts: e.ts,
    at: new Date(e.ts).toISOString(),
    tab,
    event_type: eventType,
    level,
    ...(e.agent_id ? { agent_id: e.agent_id } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(taskId ? { task_id: taskId } : {}),
    ...(status ? { status } : {}),
    ...(reason ? { reason } : {}),
    ...(callId ? { call_id: callId } : {}),
    ...(normalizedErrorCode ? { normalized_error_code: normalizedErrorCode } : {}),
    message: message.slice(0, 500),
    ...(e.tool_name ? { tool_name: e.tool_name } : {}),
    ...(e.args_preview ? { args_preview: e.args_preview } : {}),
    ...(e.duration_ms != null ? { duration_ms: e.duration_ms } : {}),
    ...(typeof merged.tool_call_count === "number"
      ? { tool_call_count: merged.tool_call_count }
      : {}),
    ...(typeof merged.last_tool === "string" ? { last_tool: merged.last_tool } : {}),
    ...(typeof merged.last_action === "string"
      ? { last_action: merged.last_action }
      : {}),
    ...(typeof merged.report_written === "boolean"
      ? { report_written: merged.report_written }
      : merged.report_on_disk === true
        ? { report_written: true }
        : {}),
    ...(typeof merged.report_path === "string"
      ? { report_path: merged.report_path }
      : {}),
    ...(typeof merged.started_at === "string"
      ? { started_at: merged.started_at }
      : {}),
    ...(typeof merged.ended_at === "string" ? { ended_at: merged.ended_at } : {}),
    payload: e.payload,
  };
}

function recordToRow(rec: RuntimeEventRecord): LogCenterRow {
  return doorbellToRow({
    id: `jsonl-${rec.ts}-${rec.event_type}-${rec.session_id ?? ""}`,
    ts: rec.ts,
    at: new Date(rec.ts).toISOString(),
    event_type: rec.event_type,
    ...(rec.agent_id ? { agent_id: rec.agent_id } : {}),
    ...(rec.session_id ? { session_id: rec.session_id } : {}),
    ...(rec.task_id ? { task_id: rec.task_id } : {}),
    payload: {
      ...rec.payload,
      ...(rec.agent_id ? { agent_id: rec.agent_id } : {}),
      ...(rec.session_id ? { session_id: rec.session_id } : {}),
      ...(rec.task_id ? { task_id: rec.task_id } : {}),
    },
  });
}

function buildAgentSessions(rows: LogCenterRow[]): AgentSessionRow[] {
  const bySession = new Map<string, AgentSessionRow>();

  for (const r of rows) {
    if (
      r.event_type !== "runtime.session_ended" &&
      r.event_type !== "runtime.session_cancelled"
    ) {
      continue;
    }
    if (!r.session_id || !r.agent_id) continue;
    const merged = pluckPayload(r.payload);
    const status =
      r.status ??
      (r.event_type === "runtime.session_cancelled"
        ? "cancelled"
        : String(merged.status ?? "failed"));
    const reason =
      r.reason ??
      String(merged.reason ?? merged.failure_code ?? merged.settlement_reason ?? "UNKNOWN");
    const durationMs =
      typeof merged.duration_ms === "number"
        ? merged.duration_ms
        : r.duration_ms;
    bySession.set(r.session_id, {
      ts: r.ts,
      at: r.at,
      agent_id: r.agent_id,
      session_id: r.session_id,
      task_id: r.task_id ?? String(merged.task_id ?? ""),
      status,
      reason,
      ...(typeof merged.started_at === "string"
        ? { started_at: merged.started_at }
        : {}),
      ...(typeof merged.ended_at === "string" ? { ended_at: merged.ended_at } : {}),
      ...(durationMs != null ? { duration_ms: durationMs } : {}),
      tool_call_count:
        typeof merged.tool_call_count === "number"
          ? merged.tool_call_count
          : typeof merged.tool_calls_count === "number"
            ? merged.tool_calls_count
            : 0,
      ...(typeof merged.last_tool === "string"
        ? { last_tool: merged.last_tool }
        : r.last_tool
          ? { last_tool: r.last_tool }
          : {}),
      ...(typeof merged.last_action === "string"
        ? { last_action: merged.last_action }
        : r.last_action
          ? { last_action: r.last_action }
          : {}),
      report_written:
        merged.report_written === true || merged.report_on_disk === true,
      ...(typeof merged.report_path === "string"
        ? { report_path: merged.report_path }
        : r.report_path
          ? { report_path: r.report_path }
          : {}),
    });
  }

  return [...bySession.values()].sort((a, b) => b.ts - a.ts);
}

function matchesRoleFilter(
  agentId: string | undefined,
  p: LogCenterQueryParams,
): boolean {
  if (p.role) {
    const rq = p.role.trim().toUpperCase();
    const aid = (agentId ?? "").toUpperCase();
    return !!aid && aid.includes(rq);
  }
  if (p.agent) return agentId === p.agent;
  return true;
}

function matchesFilters(row: LogCenterRow, p: LogCenterQueryParams): boolean {
  if (!matchesRoleFilter(row.agent_id, p)) return false;
  if (p.task_id) {
    const norm = p.task_id.replace(/\.md$/i, "").toUpperCase();
    const tid = (row.task_id ?? "").replace(/\.md$/i, "").toUpperCase();
    if (!tid || (!tid.includes(norm) && !norm.includes(tid))) return false;
  }
  if (p.session_id && row.session_id !== p.session_id) return false;
  if (p.event_type) {
    const et = (row.event_type ?? "").toLowerCase();
    const q = p.event_type.toLowerCase();
    if (et !== q && !et.includes(q)) return false;
  }
  if (p.status && row.status !== p.status) return false;
  if (p.reason) {
    const rsn = (row.reason ?? "").toUpperCase();
    if (!rsn.includes(p.reason.toUpperCase())) return false;
  }
  if (p.skill_id) {
    const sid = (row.tool_name ?? "").toLowerCase();
    const q = p.skill_id.toLowerCase();
    if (!sid.includes(q) && !q.includes(sid)) return false;
  }
  if (p.since != null && row.ts <= p.since) return false;
  return true;
}

function tabFilter(row: LogCenterRow, tab: LogCenterTab): boolean {
  if (tab === "all") return true;
  if (tab === "alerts") return row.level === "ERROR" || row.level === "WARN";
  if (tab === "raw") return false;
  if (tab === "runtime") {
    return row.tab === "runtime" || RUNTIME_TAB_EVENTS.has(row.event_type);
  }
  return row.tab === tab;
}

export function queryLogCenter(
  doorbell: DoorbellBuffer,
  logger: RuntimeEventFileLogger | null,
  params: LogCenterQueryParams,
  extraRows: LogCenterRow[] = [],
): {
  total: number;
  rows: LogCenterRow[];
  sessions: AgentSessionRow[];
  jsonl_path: string | null;
  jsonl_tail: RuntimeEventRecord[];
  actions_path?: string | null;
} {
  const limit = Math.min(Math.max(params.limit ?? 200, 1), 500);
  const tab = params.tab ?? "all";

  const door = doorbell.query({ limit: 500 });
  const jsonl = logger?.tailRecent(800) ?? [];

  const seen = new Set<string>();
  const merged: LogCenterRow[] = [];
  // Query-local dedupe keeps repeated/concurrent API reads deterministic.
  // A process-global registry would make the second request temporarily lose rows.
  const displayDedupe = new EventDisplayDedupeRegistry();

  // Display dedupe applies only to streaming doorbell/jsonl rows. Persisted
  // action/skill evidence (extraRows) must always show — otherwise opening
  // tab=all first registers keys and tab=actions later returns 0 rows.
  const passDisplayDedupe = (row: LogCenterRow): boolean =>
    displayDedupe.shouldDisplay({
      ts: row.ts,
      actor: row.agent_id,
      event_type: row.event_type,
      message: row.message,
    });

  for (const e of door.events) {
    const row = doorbellToRow(e);
    if (!seen.has(row.id) && passDisplayDedupe(row)) {
      seen.add(row.id);
      merged.push(row);
    }
  }
  for (const rec of jsonl) {
    const row = recordToRow(rec);
    const key = `${row.ts}:${row.event_type}:${row.session_id ?? ""}`;
    if (!seen.has(key) && passDisplayDedupe(row)) {
      seen.add(key);
      merged.push(row);
    }
  }
  for (const row of extraRows) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      merged.push(row);
    }
  }

  merged.sort((a, b) => b.ts - a.ts);

  const filtered = merged.filter(
    (r) => tabFilter(r, tab) && matchesFilters(r, params),
  );
  const sessions = buildAgentSessions(
    merged.filter((r) => matchesFilters(r, params)),
  );
  const filteredJsonl = jsonl.filter((record) => matchesFilters(recordToRow(record), params));

  return {
    total: tab === "raw" ? filteredJsonl.length : filtered.length,
    rows: filtered.slice(0, limit),
    sessions:
      tab === "sessions" || tab === "all"
        ? sessions.filter((s) => {
            if (!matchesRoleFilter(s.agent_id, params)) return false;
            if (params.session_id && s.session_id !== params.session_id) return false;
            if (params.task_id) {
              const norm = params.task_id.replace(/\.md$/i, "").toUpperCase();
              const tid = s.task_id.replace(/\.md$/i, "").toUpperCase();
              if (!tid.includes(norm) && !norm.includes(tid)) return false;
            }
            if (params.status && s.status !== params.status) return false;
            if (params.reason && !s.reason.toUpperCase().includes(params.reason.toUpperCase())) {
              return false;
            }
            return true;
          }).slice(0, limit)
        : [],
    jsonl_path: logger?.filePath ?? null,
    jsonl_tail: filteredJsonl.slice(-Math.min(limit, 300)),
  };
}
