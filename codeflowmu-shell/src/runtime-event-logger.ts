/**
 * RuntimeEventFileLogger — 持久化 wake / session / SDK 事件到 fcop/logs/runtime/runtime-events-YYYYMMDD.jsonl
 *
 * 重启后可通过 tailRecent / queryWakeChain 回放最近链路，供 doorbell buffer 与 API 查询。
 * 兼容旧单文件 runtime-events.jsonl 与 `.codeflowmu/events/runtime-events.jsonl`（只读）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";

import {
  fcopLogsRuntimeDir,
  fcopLogsRuntimeEventsPath,
  listRuntimeEventsReadPaths,
  logsDateKey,
} from "./logs-paths.ts";

export interface RuntimeEventRecord {
  ts: number;
  at: string;
  event_type: string;
  agent_id?: string;
  session_id?: string;
  task_id?: string;
  thread_key?: string;
  payload: Record<string, unknown>;
}

export interface WakeChainStep {
  event_type: string;
  ts: number;
  at: string;
  agent_id?: string;
  session_id?: string;
  settlement_reason?: string;
  status?: string;
  error?: string;
}

export interface WakeChainResult {
  task_id: string;
  steps: WakeChainStep[];
  outcome?:
    | "report_written"
    | "cancelled_after_success"
    | "cancelled_without_report"
    | "failed"
    | "in_progress"
    | "transient_delayed";
}

const RUNTIME_EVENT_TYPES = new Set([
  "wake_agent.requested",
  "wake_agent.accepted",
  "wake_agent.failed",
  "wake_agent.skipped",
  "wake_agent.delayed",
  "runtime.session_started",
  "runtime.session_ended",
  "runtime.session_cancelled",
  "sdk.result",
  "sdk.tool_call",
  "transient_sdk_error",
  "transient_sdk_retry",
  "codeflowmu.task_dispatched",
  "codeflowmu.report_detected",
  "codeflowmu.lifecycle.inbox_to_active",
  "codeflowmu.lifecycle.task_to_review",
  "codeflowmu.lifecycle.root_review_blocked",
  "codeflowmu.lifecycle.pending_pm_review",
  "codeflowmu.lifecycle.review_to_done",
  "codeflowmu.lifecycle.done_to_archive",
  "codeflowmu.lifecycle.review_to_active",
  "codeflowmu.lifecycle.done_to_active",
  "codeflowmu.report_gate.missing_report",
  "codeflowmu.report_gate.waiting_report",
  "codeflowmu.failure",
  "codeflowmu.failure_recorded",
  "codeflowmu.downstream_auto_nudge",
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
  "ai_swap.checked",
  "ai_swap.deferred",
  "ai_swap.recovered",
  "ai_swap.blocked",
]);

function parseRuntimeLines(raw: string): RuntimeEventRecord[] {
  const out: RuntimeEventRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RuntimeEventRecord);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function readAllRuntimeRecords(projectRoot: string): RuntimeEventRecord[] {
  const paths = listRuntimeEventsReadPaths(projectRoot);
  if (paths.length === 0) return [];
  const merged: RuntimeEventRecord[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      merged.push(...parseRuntimeLines(readFileSync(p, "utf-8")));
    } catch {
      /* skip unreadable file */
    }
  }
  merged.sort((a, b) => a.ts - b.ts);
  return merged;
}

export class RuntimeEventFileLogger {
  private readonly _projectRoot: string;
  private _writeDateKey = "";
  private _path = "";

  constructor(projectRoot: string) {
    this._projectRoot = projectRoot;
    try {
      mkdirSync(fcopLogsRuntimeDir(projectRoot), { recursive: true });
    } catch {
      /* best-effort */
    }
    this._refreshWritePath();
  }

  private _refreshWritePath(): void {
    const key = logsDateKey();
    if (key === this._writeDateKey && this._path) return;
    this._writeDateKey = key;
    this._path = fcopLogsRuntimeEventsPath(this._projectRoot, key);
  }

  get filePath(): string {
    this._refreshWritePath();
    return this._path;
  }

  append(
    event_type: string,
    payload: Record<string, unknown> & {
      agent_id?: string;
      session_id?: string;
      task_id?: string;
      thread_key?: string;
    },
  ): void {
    if (!RUNTIME_EVENT_TYPES.has(event_type)) return;
    this._refreshWritePath();
    const line: RuntimeEventRecord = {
      ts: Date.now(),
      at: new Date().toISOString(),
      event_type,
      ...(payload.agent_id ? { agent_id: String(payload.agent_id) } : {}),
      ...(payload.session_id ? { session_id: String(payload.session_id) } : {}),
      ...(payload.task_id ? { task_id: String(payload.task_id) } : {}),
      ...(payload.thread_key ? { thread_key: String(payload.thread_key) } : {}),
      payload,
    };
    try {
      appendFileSync(this._path, JSON.stringify(line) + "\n", "utf-8");
    } catch {
      /* best-effort */
    }
  }

  /** 读取多源合并后尾部最近 N 条（顺序：旧 → 新）。 */
  tailRecent(limit = 500): RuntimeEventRecord[] {
    const all = readAllRuntimeRecords(this._projectRoot);
    return all.slice(-Math.max(1, limit));
  }

  /** 按 task_id 聚合 wake → session → report 链路。 */
  queryWakeChain(taskId: string, scanLimit = 2000): WakeChainResult {
    const norm = taskId.replace(/\.md$/i, "").trim().toUpperCase();
    const records = this.tailRecent(scanLimit).filter((r) => {
      const tid = String(r.task_id ?? r.payload?.task_id ?? "")
        .replace(/\.md$/i, "")
        .trim()
        .toUpperCase();
      if (!tid) return false;
      return tid === norm || tid.startsWith(`${norm}-`) || norm.startsWith(`${tid}-`);
    });

    const steps: WakeChainStep[] = records.map((r) => ({
      event_type: r.event_type,
      ts: r.ts,
      at: r.at,
      ...(r.agent_id ? { agent_id: r.agent_id } : {}),
      ...(r.session_id ? { session_id: r.session_id } : {}),
      ...(typeof r.payload.settlement_reason === "string"
        ? { settlement_reason: r.payload.settlement_reason }
        : {}),
      ...(typeof r.payload.status === "string" ? { status: r.payload.status } : {}),
      ...(typeof r.payload.error === "string" ? { error: r.payload.error } : {}),
    }));

    let outcome: WakeChainResult["outcome"] = "in_progress";
    const delayedWake = records.some((r) => r.event_type === "wake_agent.delayed");
    const ended = records.filter((r) => r.event_type === "runtime.session_ended").pop();
    if (delayedWake && !ended) {
      outcome = "transient_delayed";
    } else if (ended) {
      const sr = String(ended.payload.settlement_reason ?? "");
      const reportOnDisk = ended.payload.report_on_disk === true;
      if (sr === "cancelled-after-success" || (reportOnDisk && ended.payload.status === "cancelled")) {
        outcome = "cancelled_after_success";
      } else if (sr === "cancelled-without-report" || ended.payload.status === "cancelled") {
        outcome = "cancelled_without_report";
      } else if (sr === "transient_delayed" || ended.payload.transient_sdk_error === true) {
        outcome = "transient_delayed";
      } else if (reportOnDisk || sr === "completed-with-report") {
        outcome = "report_written";
      } else if (ended.payload.status === "failed") {
        outcome = "failed";
      }
    }

    return { task_id: taskId, steps, outcome };
  }
}

export { RUNTIME_EVENT_TYPES };
