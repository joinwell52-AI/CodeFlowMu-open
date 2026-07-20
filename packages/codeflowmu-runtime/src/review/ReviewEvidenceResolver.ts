/**
 * ReviewEvidenceResolver — 从 Action Evidence Log 组装 evidence_summary。
 * 只输出证据摘要，不判定 pass / fail / needs_admin（规格 P1）。
 */

import { readAllActionEvidenceRecords } from "../logs/ActionEvidenceLogger.ts";
import type { ActionEvidenceRecord } from "../logs/actionLogTypes.ts";

export interface ReviewEvidenceTimeWindow {
  from?: string;
  to?: string;
}

export interface ReviewEvidenceResolveInput {
  projectRoot: string;
  task_id?: string;
  report_id?: string;
  session_id?: string;
  run_id?: string;
  evidence_refs?: string[];
  agent_id?: string;
  role?: string;
  thread_key?: string;
  time_window?: ReviewEvidenceTimeWindow;
}

export interface EvidenceSummarySession {
  found: boolean;
  session_id?: string;
  status?: string;
  tool_calls_count?: number;
}

export interface EvidenceSummaryCommand {
  command: string;
  exit_code?: number | null;
  stdout_ref?: string;
  stderr_ref?: string;
}

export interface EvidenceSummaryDataQuery {
  query_id?: string;
  query_summary?: string;
  row_count?: number | null;
}

/** 规格 §3.4 — ReviewGate 消费的证据摘要（不含判定结论） */
export interface EvidenceSummary {
  task_id?: string;
  report_id?: string;
  agent_id?: string;
  role?: string;
  session: EvidenceSummarySession;
  files: { read: string[]; changed: string[] };
  commands: EvidenceSummaryCommand[];
  report: { found: boolean; path?: string };
  data_queries: EvidenceSummaryDataQuery[];
  browser_actions?: Array<{
    action: string;
    url?: string;
    screenshot_ref?: string;
  }>;
  warnings: string[];
}

function inTimeWindow(at: string, window?: ReviewEvidenceTimeWindow): boolean {
  if (!window?.from && !window?.to) return true;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return true;
  if (window.from) {
    const fromMs = Date.parse(window.from);
    if (!Number.isNaN(fromMs) && t < fromMs) return false;
  }
  if (window.to) {
    const toMs = Date.parse(window.to);
    if (!Number.isNaN(toMs) && t > toMs) return false;
  }
  return true;
}

function recordMatchesFilters(
  rec: ActionEvidenceRecord,
  taskId: string,
  reportId: string,
  sessionId: string,
  timeWindow?: ReviewEvidenceTimeWindow,
): boolean {
  if (!inTimeWindow(rec.at, timeWindow)) return false;
  if (sessionId && rec.session_id !== sessionId) return false;
  if (taskId && rec.task_id && rec.task_id !== taskId) return false;
  if (reportId) {
    if (rec.event_type === "report.write") {
      return rec.report_id === reportId;
    }
    if (taskId) {
      return rec.task_id === taskId;
    }
    return false;
  }
  return true;
}

function canonicalTaskId(value: string): string {
  const raw = str(value).replace(/\.md$/i, "");
  return /^TASK-\d{8}-\d{3,}/i.exec(raw)?.[0].toUpperCase() ?? raw.toUpperCase();
}

function sameTaskId(left: string, right: string): boolean {
  return Boolean(left && right && canonicalTaskId(left) === canonicalTaskId(right));
}

/**
 * 从 fcop/logs/runtime/actions-*.jsonl 聚合 evidence_summary。
 * 不输出 pass / fail / needs_admin。
 */
export function resolveReviewEvidence(
  input: ReviewEvidenceResolveInput,
): EvidenceSummary {
  const warnings: string[] = [];
  const all = readAllActionEvidenceRecords(input.projectRoot);

  let taskId = str(input.task_id);
  let reportId = str(input.report_id);
  const sessionId = str(input.session_id);
  const runId = str(input.run_id);
  const evidenceRefs = (input.evidence_refs ?? []).map(str).filter(Boolean);
  const explicitSession =
    sessionId || evidenceRefs.find((ref) => /^session-/i.test(ref)) || "";
  const explicitRun = runId || evidenceRefs.find((ref) => /^run-/i.test(ref)) || "";

  if (reportId && !taskId) {
    const reportRec = all.find(
      (r) => r.event_type === "report.write" && r.report_id === reportId,
    );
    if (reportRec?.task_id) {
      taskId = reportRec.task_id;
    } else {
      warnings.push(`report_id ${reportId} 未在 action log 中找到 report.write`);
    }
  }

  const inWindow = all.filter((rec) => inTimeWindow(rec.at, input.time_window));
  let filtered: ActionEvidenceRecord[] = [];
  if (explicitSession || explicitRun) {
    filtered = inWindow.filter(
      (rec) =>
        (!explicitSession || rec.session_id === explicitSession) &&
        (!explicitRun || rec.run_id === explicitRun),
    );
  }
  if (filtered.length === 0 && taskId) {
    filtered = inWindow.filter((rec) => sameTaskId(rec.task_id, taskId));
  }
  if (filtered.length === 0 && reportId) {
    const reportWrite = inWindow.find(
      (rec) => rec.event_type === "report.write" && rec.report_id === reportId,
    );
    if (reportWrite?.session_id) {
      filtered = inWindow.filter((rec) => rec.session_id === reportWrite.session_id);
    }
  }
  if (filtered.length === 0 && (input.agent_id || input.role || input.thread_key)) {
    filtered = inWindow.filter(
      (rec) =>
        (!input.agent_id || rec.agent_id === input.agent_id) &&
        (!input.role || rec.role.toUpperCase() === input.role.toUpperCase()) &&
        (!input.thread_key || rec.thread_key === input.thread_key),
    );
    if (filtered.length > 0) {
      warnings.push("使用 agent/thread/time_window 受控回退关联动作证据");
    }
  }

  const filesRead = new Set<string>();
  const filesChanged = new Set<string>();
  const commands: EvidenceSummaryCommand[] = [];
  const dataQueries: EvidenceSummaryDataQuery[] = [];
  const browserActions: EvidenceSummary["browser_actions"] = [];
  const callIds = new Set<string>();

  let reportFound = false;
  let reportPath: string | undefined;
  let agentId = "";
  let role = "";

  for (const rec of filtered) {
    if (rec.call_id) callIds.add(rec.call_id);
    if (!agentId && rec.agent_id) agentId = rec.agent_id;
    if (!role && rec.role) role = rec.role;

    switch (rec.event_type) {
      case "file.read":
        if (rec.path && rec.path !== "(unknown)") filesRead.add(rec.path);
        break;
      case "file.edit":
      case "file.write":
        if (rec.path && rec.path !== "(unknown)") filesChanged.add(rec.path);
        break;
      case "command.run":
        commands.push({
          command: rec.command,
          exit_code: rec.exit_code,
          stdout_ref: rec.stdout_ref,
          stderr_ref: rec.stderr_ref,
        });
        break;
      case "data.query":
        dataQueries.push({
          query_id: rec.query_id,
          query_summary: rec.query_summary,
          row_count: rec.row_count,
        });
        break;
      case "report.write":
        reportFound = true;
        reportPath = rec.path;
        if (rec.report_id) reportId = rec.report_id;
        if (rec.task_id) taskId = rec.task_id;
        break;
      case "browser.action":
        browserActions.push({
          action: rec.action,
          url: rec.url,
          screenshot_ref: rec.screenshot_ref,
        });
        break;
      default:
        break;
    }
  }

  const resolvedSessionId =
    explicitSession || filtered.find((r) => r.session_id)?.session_id || "";

  // report.write 只证明落盘，不算 session 执行证据（否则 fact gate 的 session_evidence_gap 永远触发不了）
  const sessionToolEvidence = filtered.filter(
    (r) =>
      r.session_id === resolvedSessionId &&
      r.event_type !== "report.write",
  );

  return {
    task_id: taskId || undefined,
    report_id: reportId || undefined,
    agent_id: agentId || undefined,
    role: role || undefined,
    session: {
      found: Boolean(resolvedSessionId && sessionToolEvidence.length > 0),
      session_id: resolvedSessionId || undefined,
      tool_calls_count: callIds.size > 0 ? callIds.size : filtered.length || undefined,
    },
    files: {
      read: [...filesRead].sort(),
      changed: [...filesChanged].sort(),
    },
    commands,
    report: { found: reportFound, path: reportPath },
    data_queries: dataQueries,
    browser_actions: browserActions,
    warnings,
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v != null ? String(v).trim() : "";
}
