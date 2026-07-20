/**
 * Map completed/failed SDK tool_call payloads to Action Evidence Log records.
 * Only Runtime / panel hooks call this — agents must not self-write.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { roleFromAgentId } from "../_internal/report-reconcile.ts";
import {
  appendActionEvidence,
  nextActionEventId,
  writeCommandOutputRefs,
  type ActionEvidenceWriteBase,
  type ActionEvidenceWriteInput,
} from "./ActionEvidenceLogger.ts";
import type { ActionEvidenceRecord } from "./actionLogTypes.ts";

const RECORDED_CALLS = new Map<string, true>();
const MAX_DEDUPE = 20_000;
/** 超过此长度的 stdout/stderr 落盘到 fcop/logs/runtime/commands/ */
const COMMAND_OUTPUT_REF_THRESHOLD = 4096;

export type MaybeRecordActionEvidenceFromToolCallInput = {
  projectRoot: string;
  agent_id: string;
  session_id: string;
  run_id?: string;
  payload: Record<string, unknown>;
  thread_key?: string;
  task_id?: string;
};

function dedupeKey(sessionId: string, callId: string): string {
  return `${sessionId}::${callId}`;
}

function rememberCall(key: string): boolean {
  if (RECORDED_CALLS.has(key)) return false;
  RECORDED_CALLS.set(key, true);
  if (RECORDED_CALLS.size > MAX_DEDUPE) {
    const first = RECORDED_CALLS.keys().next().value;
    if (first) RECORDED_CALLS.delete(first);
  }
  return true;
}

export function resetActionEvidenceToolCallDedupeForTests(): void {
  RECORDED_CALLS.clear();
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v != null ? String(v).trim() : "";
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function normalizeLoggedPath(projectRoot: string, p: string): string {
  const trimmed = p.trim();
  if (!trimmed) return "";
  try {
    if (isAbsolute(trimmed)) {
      return relative(resolve(projectRoot), resolve(trimmed)).replace(/\\/g, "/");
    }
  } catch {
    /* keep as-is */
  }
  return trimmed.replace(/\\/g, "/");
}

function extractArgs(payload: Record<string, unknown>): Record<string, unknown> {
  const raw = payload.raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    const args = r.args ?? r.arguments ?? r.input;
    if (args && typeof args === "object" && !Array.isArray(args)) {
      return args as Record<string, unknown>;
    }
  }
  const top = payload.args ?? payload.arguments;
  if (top && typeof top === "object" && !Array.isArray(top)) {
    return top as Record<string, unknown>;
  }
  return {};
}

function extractResult(payload: Record<string, unknown>): Record<string, unknown> {
  const raw = payload.raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    const result = r.result ?? r.output;
    if (result && typeof result === "object" && !Array.isArray(result)) {
      return result as Record<string, unknown>;
    }
  }
  const top = payload.result ?? payload.output;
  if (top && typeof top === "object" && !Array.isArray(top)) {
    return top as Record<string, unknown>;
  }
  return {};
}

function rawPayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  const raw = payload.raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return null;
}

function toolName(payload: Record<string, unknown>): string {
  const raw = rawPayload(payload);
  return str(
    payload.tool ?? payload.tool_name ?? payload.name ?? raw?.name ?? raw?.tool,
  ).toLowerCase();
}

function extractPathsFromArgs(args: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  for (const key of ["path", "file_path", "filepath", "target_file", "file"]) {
    const v = str(args[key]);
    if (v) paths.add(v);
  }
  const pathsVal = args.paths;
  if (Array.isArray(pathsVal)) {
    for (const p of pathsVal) {
      const s = str(p);
      if (s) paths.add(s);
    }
  }
  return [...paths];
}

function extractPathsFromResult(result: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  for (const key of ["path", "file_path", "filepath"]) {
    const v = str(result[key]);
    if (v) paths.add(v);
  }
  return [...paths];
}

function classifyTool(tool: string): ActionEvidenceRecord["event_type"] | "skip" | null {
  if (!tool) return null;
  if (tool === "write_report" || tool === "write_report_file") return "skip";

  const readTools = new Set([
    "read",
    "read_file",
    "grep",
    "grep_files",
    "glob",
    "glob_file_search",
    "list_dir",
    "list_directory",
    "semanticsearch",
    "codebase_search",
    "fetch",
  ]);
  if (readTools.has(tool)) return "file.read";

  const writeTools = new Set(["write", "write_file", "create_file"]);
  if (writeTools.has(tool)) return "file.write";

  const editTools = new Set([
    "search_replace",
    "strreplace",
    "apply_patch",
    "edit_notebook",
    "delete",
    "delete_file",
  ]);
  if (editTools.has(tool)) return "file.edit";

  const commandTools = new Set([
    "shell",
    "run_terminal_cmd",
    "run_command",
    "execute_command",
    "bash",
    "exec_command",
  ]);
  if (commandTools.has(tool)) return "command.run";

  const taskTools = new Set(["write_task", "create_task", "submit_task"]);
  if (taskTools.has(tool)) return "task.write";

  const dataTools = new Set([
    "query",
    "sql_query",
    "execute_sql",
    "run_sql",
    "data_query",
    "db_query",
  ]);
  if (dataTools.has(tool)) return "data.query";

  if (
    /^(browser|playwright|chrome|computer)(?:[._-]|$)/i.test(tool) ||
    /^(navigate|click|screenshot|snapshot|fill|type|press_key)$/i.test(tool)
  ) {
    return "browser.action";
  }

  return null;
}

function terminalStatusFromPayload(payload: Record<string, unknown>): string {
  const raw = rawPayload(payload);
  return str(payload.status ?? raw?.status).toLowerCase();
}

function canonicalTaskId(value: unknown): string {
  const raw = str(value).replace(/\.md$/i, "");
  return /^TASK-\d{8}-\d{3,}/i.exec(raw)?.[0].toUpperCase() ?? raw;
}

function baseFields<T extends ActionEvidenceRecord["event_type"]>(
  input: MaybeRecordActionEvidenceFromToolCallInput,
  eventType: T,
  callId: string,
  eventId?: string,
): ActionEvidenceWriteBase & { event_type: T } {
  const statusRaw = terminalStatusFromPayload(input.payload);
  const status: ActionEvidenceRecord["status"] =
    statusRaw === "failed" || statusRaw === "error" ? "failed" : "success";
  return {
    event_type: eventType,
    ...(eventId ? { event_id: eventId } : {}),
    at: new Date().toISOString(),
    task_id: canonicalTaskId(input.task_id),
    session_id: input.session_id,
    run_id: input.run_id,
    agent_id: input.agent_id,
    role: roleFromAgentId(input.agent_id),
    status,
    thread_key: str(input.thread_key) || undefined,
    call_id: callId,
  } as ActionEvidenceWriteBase & { event_type: T };
}

function buildBrowserAction(
  input: MaybeRecordActionEvidenceFromToolCallInput,
  callId: string,
  tool: string,
): ActionEvidenceWriteInput {
  const args = extractArgs(input.payload);
  const result = extractResult(input.payload);
  return {
    ...baseFields(input, "browser.action", callId),
    action: tool,
    url: str(args.url ?? result.url) || undefined,
    screenshot_ref:
      str(result.screenshot_ref ?? result.path ?? args.path) || undefined,
  } as ActionEvidenceWriteInput;
}

function buildFileRead(
  input: MaybeRecordActionEvidenceFromToolCallInput,
  paths: string[],
  callId: string,
): ActionEvidenceWriteInput[] {
  return paths.map((p) => ({
    ...baseFields(input, "file.read", callId),
    path: normalizeLoggedPath(input.projectRoot, p),
  }));
}

function buildFileWrite(
  input: MaybeRecordActionEvidenceFromToolCallInput,
  paths: string[],
  callId: string,
): ActionEvidenceWriteInput[] {
  return paths.map((p) => ({
    ...baseFields(input, "file.write", callId),
    path: normalizeLoggedPath(input.projectRoot, p),
    change_type: "created" as const,
  }));
}

function buildFileEdit(
  input: MaybeRecordActionEvidenceFromToolCallInput,
  paths: string[],
  callId: string,
): ActionEvidenceWriteInput[] {
  return paths.map((p) => ({
    ...baseFields(input, "file.edit", callId),
    path: normalizeLoggedPath(input.projectRoot, p),
    change_type: "modified" as const,
  }));
}

function buildCommandRun(
  input: MaybeRecordActionEvidenceFromToolCallInput,
  callId: string,
): ActionEvidenceWriteInput {
  const args = extractArgs(input.payload);
  const result = extractResult(input.payload);
  const raw = (input.payload.raw ?? {}) as Record<string, unknown>;
  const statusRaw = terminalStatusFromPayload(input.payload);
  const exitFromPayload = num(raw.exit_code ?? raw.exitCode ?? result.exit_code ?? result.exitCode);
  const exit_code =
    exitFromPayload ??
    (statusRaw === "failed" || statusRaw === "error" ? 1 : statusRaw === "completed" ? 0 : null);
  const duration_ms = num(raw.duration_ms ?? raw.durationMs ?? result.duration_ms);
  const command = str(args.command ?? args.cmd ?? input.payload.command) || "(unknown)";
  const stdout = str(result.stdout ?? raw.stdout);
  const stderr = str(result.stderr ?? raw.stderr);

  const eventId = nextActionEventId(input.projectRoot);
  const refs =
    stdout.length >= COMMAND_OUTPUT_REF_THRESHOLD ||
    stderr.length >= COMMAND_OUTPUT_REF_THRESHOLD
      ? writeCommandOutputRefs({
          projectRoot: input.projectRoot,
          eventId,
          stdout: stdout.length >= COMMAND_OUTPUT_REF_THRESHOLD ? stdout : undefined,
          stderr: stderr.length >= COMMAND_OUTPUT_REF_THRESHOLD ? stderr : undefined,
        })
      : {};

  return {
    ...baseFields(input, "command.run", callId, eventId),
    command,
    exit_code,
    duration_ms,
    stdout_ref: refs.stdout_ref,
    stderr_ref: refs.stderr_ref,
  };
}

function buildTaskWrite(
  input: MaybeRecordActionEvidenceFromToolCallInput,
  callId: string,
): ActionEvidenceWriteInput {
  const args = extractArgs(input.payload);
  const recipient = str(args.recipient ?? args.to ?? args.assignee);
  const taskRef = str(args.task_id ?? args.task_ref ?? args.id);
  return {
    ...baseFields(input, "task.write", callId),
    recipient: recipient || undefined,
    task_ref: taskRef || undefined,
  };
}

function buildDataQuery(
  input: MaybeRecordActionEvidenceFromToolCallInput,
  callId: string,
): ActionEvidenceWriteInput {
  const args = extractArgs(input.payload);
  const query = str(args.query ?? args.sql ?? args.statement).slice(0, 500);
  const rowCount = num(extractResult(input.payload).row_count ?? extractResult(input.payload).rows);
  return {
    ...baseFields(input, "data.query", callId),
    query_summary: query || "(query)",
    snapshot_level: "summary_only",
    row_count: rowCount,
  };
}

/**
 * Append action evidence for a terminal tool_call (completed/failed). Ignores `running`.
 * Deduplicates by session_id + call_id. Skips write_report (disk watcher owns report.write).
 */
export function maybeRecordActionEvidenceFromToolCall(
  input: MaybeRecordActionEvidenceFromToolCallInput,
): void {
  const status = terminalStatusFromPayload(input.payload);
  if (status === "running" || status === "started" || status === "in_progress") {
    return;
  }
  if (status !== "completed" && status !== "failed" && status !== "error" && status !== "") {
    return;
  }

  const raw = rawPayload(input.payload);
  const callId = str(
    input.payload.call_id ?? input.payload.id ?? raw?.call_id ?? raw?.id,
  );
  if (!callId || !input.session_id) return;
  const key = dedupeKey(input.session_id, callId);
  if (!rememberCall(key)) return;

  const tool = toolName(input.payload);
  const kind = classifyTool(tool);
  if (kind === "skip" || kind === null) return;

  const args = extractArgs(input.payload);
  const result = extractResult(input.payload);
  let paths = [...extractPathsFromArgs(args), ...extractPathsFromResult(result)];
  if (paths.length === 0 && str(args.path)) {
    paths = [str(args.path)];
  }

  const records: ActionEvidenceWriteInput[] = [];
  switch (kind) {
    case "file.read":
      if (paths.length === 0) paths = ["(unknown)"];
      records.push(...buildFileRead(input, paths, callId));
      break;
    case "file.write":
      if (paths.length === 0) paths = ["(unknown)"];
      records.push(...buildFileWrite(input, paths, callId));
      break;
    case "file.edit":
      if (paths.length === 0) paths = ["(unknown)"];
      records.push(...buildFileEdit(input, paths, callId));
      break;
    case "command.run":
      records.push(buildCommandRun(input, callId));
      break;
    case "task.write":
      records.push(buildTaskWrite(input, callId));
      break;
    case "data.query":
      records.push(buildDataQuery(input, callId));
      break;
    case "browser.action":
      records.push(buildBrowserAction(input, callId, tool));
      break;
    default:
      return;
  }

  for (const rec of records) {
    appendActionEvidence(input.projectRoot, rec);
  }
}
