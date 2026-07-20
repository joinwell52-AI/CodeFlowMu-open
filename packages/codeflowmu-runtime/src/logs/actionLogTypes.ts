import {
  ACTION_LOG_SCHEMA_VERSION,
  ACTION_LOG_SOURCE,
} from "./actionLogPaths.ts";

export type ActionEventType =
  | "file.read"
  | "file.edit"
  | "file.write"
  | "command.run"
  | "report.write"
  | "task.write"
  | "data.query"
  | "browser.action";

export type ActionStatus = "success" | "failed";

/** Action Evidence Log 通用外壳（规格 §2.3） */
export interface ActionEvidenceBase {
  schema_version: typeof ACTION_LOG_SCHEMA_VERSION;
  event_id: string;
  event_type: ActionEventType;
  at: string;
  task_id: string;
  report_id?: string | null;
  thread_key?: string;
  session_id: string;
  run_id?: string;
  agent_id: string;
  role: string;
  source: typeof ACTION_LOG_SOURCE;
  status: ActionStatus;
  call_id?: string;
}

export interface FileReadAction extends ActionEvidenceBase {
  event_type: "file.read";
  path: string;
}

export interface FileEditAction extends ActionEvidenceBase {
  event_type: "file.edit";
  path: string;
  change_type?: "modified" | "created" | "deleted";
}

export interface FileWriteAction extends ActionEvidenceBase {
  event_type: "file.write";
  path: string;
  change_type?: "created" | "modified";
}

export interface CommandRunAction extends ActionEvidenceBase {
  event_type: "command.run";
  command: string;
  cwd?: string;
  exit_code?: number | null;
  duration_ms?: number | null;
  stdout_ref?: string;
  stderr_ref?: string;
}

export interface ReportWriteAction extends ActionEvidenceBase {
  event_type: "report.write";
  report_id: string;
  path: string;
  recipient?: string;
}

export interface TaskWriteAction extends ActionEvidenceBase {
  event_type: "task.write";
  path?: string;
  recipient?: string;
  task_ref?: string;
}

export interface DataQueryAction extends ActionEvidenceBase {
  event_type: "data.query";
  query_id?: string;
  query_summary?: string;
  row_count?: number | null;
  snapshot_level?: "summary_only" | "full";
}

export interface BrowserAction extends ActionEvidenceBase {
  event_type: "browser.action";
  action: string;
  url?: string;
  screenshot_ref?: string;
}

export type ActionEvidenceRecord =
  | FileReadAction
  | FileEditAction
  | FileWriteAction
  | CommandRunAction
  | ReportWriteAction
  | TaskWriteAction
  | DataQueryAction
  | BrowserAction;

/** @deprecated 使用 ActionStatus；保留别名供 barrel export */
export type ActionLogStatus = ActionStatus;

export type FileReadActionRecord = FileReadAction;
export type FileEditActionRecord = FileEditAction;
export type FileWriteActionRecord = FileWriteAction;
export type CommandRunActionRecord = CommandRunAction;
export type ReportWriteActionRecord = ReportWriteAction;
export type TaskWriteActionRecord = TaskWriteAction;
export type DataQueryActionRecord = DataQueryAction;
