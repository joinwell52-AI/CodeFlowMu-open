/**
 * Action Evidence Logger — append-only fcop/logs/runtime/actions-YYYYMMDD.jsonl
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ACTION_LOG_SCHEMA_VERSION,
  ACTION_LOG_SOURCE,
  actionEvidenceLogPath,
  actionLogsDateKey,
  fcopLogsRuntimeCommandsDir,
  fcopLogsRuntimeDir,
  listActionEvidenceLogPaths,
} from "./actionLogPaths.ts";
import type {
  ActionEvidenceRecord,
  CommandRunAction,
  DataQueryAction,
  FileEditAction,
  FileReadAction,
  FileWriteAction,
  ReportWriteAction,
  TaskWriteAction,
  BrowserAction,
} from "./actionLogTypes.ts";

type ActionEvidenceAutoFields = "schema_version" | "event_id" | "source";

type WriteInputFor<T extends ActionEvidenceRecord> = Omit<T, ActionEvidenceAutoFields> &
  Partial<Pick<T, ActionEvidenceAutoFields>>;

/** 写入前可省略 schema_version / event_id / source（由 logger 补齐） */
export type ActionEvidenceWriteInput =
  | WriteInputFor<FileReadAction>
  | WriteInputFor<FileEditAction>
  | WriteInputFor<FileWriteAction>
  | WriteInputFor<CommandRunAction>
  | WriteInputFor<ReportWriteAction>
  | WriteInputFor<TaskWriteAction>
  | WriteInputFor<DataQueryAction>
  | WriteInputFor<BrowserAction>;

/** 各 event_type 共用的写入字段（不含类型专有 payload） */
export type ActionEvidenceWriteBase = Pick<
  ActionEvidenceWriteInput,
  | "event_type"
  | "event_id"
  | "at"
  | "task_id"
  | "report_id"
  | "thread_key"
  | "session_id"
  | "run_id"
  | "agent_id"
  | "role"
  | "status"
  | "call_id"
>;

const seqByProjectDay = new Map<string, number>();

function seqKey(projectRoot: string, dateKey: string): string {
  return `${projectRoot}::${dateKey}`;
}

/** 生成 act-YYYYMMDD-NNNNNN（每日递增，进程内缓存） */
export function nextActionEventId(projectRoot: string, at?: Date): string {
  const dateKey = actionLogsDateKey(at);
  const key = seqKey(projectRoot, dateKey);
  const next = (seqByProjectDay.get(key) ?? 0) + 1;
  seqByProjectDay.set(key, next);
  return `act-${dateKey}-${String(next).padStart(6, "0")}`;
}

export function resetActionEventIdCounterForTests(): void {
  seqByProjectDay.clear();
}

function ensureRuntimeDirs(projectRoot: string): void {
  try {
    mkdirSync(fcopLogsRuntimeDir(projectRoot), { recursive: true });
    mkdirSync(fcopLogsRuntimeCommandsDir(projectRoot), { recursive: true });
  } catch {
    /* best-effort */
  }
}

export interface AppendActionEvidenceOpts {
  projectRoot: string;
  record: ActionEvidenceWriteInput;
  /** 覆盖默认按日路径（测试用） */
  logPath?: string;
}

function finalizeRecord(
  projectRoot: string,
  input: ActionEvidenceWriteInput,
): ActionEvidenceRecord {
  return {
    ...input,
    schema_version: ACTION_LOG_SCHEMA_VERSION,
    event_id: input.event_id ?? nextActionEventId(projectRoot),
    source: ACTION_LOG_SOURCE,
  } as ActionEvidenceRecord;
}

/** 追加一条 action 记录；失败只 warn，不抛错阻断主流程 */
export function appendActionEvidence(
  projectRootOrOpts: string | AppendActionEvidenceOpts,
  recordMaybe?: ActionEvidenceWriteInput,
): boolean {
  const projectRoot =
    typeof projectRootOrOpts === "string"
      ? projectRootOrOpts
      : projectRootOrOpts.projectRoot;
  const input =
    typeof projectRootOrOpts === "string"
      ? recordMaybe!
      : projectRootOrOpts.record;
  const logPath =
    typeof projectRootOrOpts === "string" ? undefined : projectRootOrOpts.logPath;
  const record = finalizeRecord(projectRoot, input);
  try {
    ensureRuntimeDirs(projectRoot);
    const path = logPath ?? actionEvidenceLogPath(projectRoot);
    const line = `${JSON.stringify(record)}\n`;
    appendFileSync(path, line, "utf-8");
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[ActionEvidenceLogger] append failed:", msg);
    return false;
  }
}

export interface WriteCommandOutputRefsOpts {
  projectRoot: string;
  eventId: string;
  stdout?: string;
  stderr?: string;
}

/**
 * 将 command 大输出写入 fcop/logs/runtime/commands/，返回相对 projectRoot 的 ref 路径。
 */
export function writeCommandOutputRefs(
  opts: WriteCommandOutputRefsOpts,
): { stdout_ref?: string; stderr_ref?: string } {
  const { projectRoot, eventId } = opts;
  const out: { stdout_ref?: string; stderr_ref?: string } = {};
  try {
    ensureRuntimeDirs(projectRoot);
    const dir = fcopLogsRuntimeCommandsDir(projectRoot);
    if (opts.stdout && opts.stdout.length > 0) {
      const name = `${eventId}.stdout.log`;
      const abs = join(dir, name);
      appendFileSync(abs, opts.stdout, "utf-8");
      out.stdout_ref = `fcop/logs/runtime/commands/${name}`;
    }
    if (opts.stderr && opts.stderr.length > 0) {
      const name = `${eventId}.stderr.log`;
      const abs = join(dir, name);
      appendFileSync(abs, opts.stderr, "utf-8");
      out.stderr_ref = `fcop/logs/runtime/commands/${name}`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[ActionEvidenceLogger] command output ref failed:", msg);
  }
  return out;
}

/** 读取指定日的 actions JSONL（测试 / resolver 用） */
export function readActionEvidenceLines(
  projectRoot: string,
  dateKey?: string,
): ActionEvidenceRecord[] {
  const path = actionEvidenceLogPath(projectRoot, dateKey);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
    const out: ActionEvidenceRecord[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as ActionEvidenceRecord);
      } catch {
        /* skip malformed */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 读取项目下全部按日 actions 文件（新文件在前） */
export function readAllActionEvidenceRecords(
  projectRoot: string,
): ActionEvidenceRecord[] {
  const paths = listActionEvidenceLogPaths(projectRoot);
  const out: ActionEvidenceRecord[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, "utf-8");
      for (const line of raw.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        try {
          out.push(JSON.parse(t) as ActionEvidenceRecord);
        } catch {
          /* skip */
        }
      }
    } catch {
      /* skip file */
    }
  }
  return out;
}
