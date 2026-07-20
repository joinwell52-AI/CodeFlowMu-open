/**
 * Panel runtime action log — ADMIN/PM 操作结果（催单、唤醒、换 AI、lifecycle 等）
 * 持久化至 fcop/logs/runtime/panel-actions-YYYYMMDD.jsonl，并与 runtime-events 合并查询。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { basename, join } from "node:path";

import {
  readRecentActionEvidence,
  type ActionEvidenceRecord,
} from "@codeflowmu/runtime";

import {
  fcopLogsRuntimeDir,
  listRuntimeEventsReadPaths,
  logsDateKey,
} from "./logs-paths.ts";
import type { RuntimeEventRecord } from "./runtime-event-logger.ts";

export type PanelRuntimeActionResult =
  | "ok"
  | "skipped"
  | "failed"
  | "delayed"
  | "pending"
  | "partial";

export interface PanelRuntimeActionRecord {
  ts: number;
  at: string;
  operator: string;
  action: string;
  target_agent?: string;
  target_task?: string;
  result: PanelRuntimeActionResult;
  reason?: string;
  detail?: string;
  session_id?: string;
  model_id?: string;
  current_leg?: string | null;
  blocked_target?: string;
  cooldownReason?: string;
  remainingMs?: number;
  untilMs?: number;
  policy?: string;
  next_owner?: string;
  message?: string;
  source?: string;
  caller?: string;
  role?: string;
  next_retry_at?: number;
  before_state?: unknown;
  after_state?: unknown;
  /** Merged audit chain for the same task_id (dispatch → session → report → done). */
  raw_events?: PanelRuntimeActionRecord[];
  lifecycle_phase?: string;
  /** Agent work summary (from action evidence — display only). */
  op_type?: string;
  object_short?: string;
  intent?: string;
  result_summary?: string;
  edit_count?: number;
  full_object?: string;
}

export function fcopLogsPanelActionsPath(
  projectRoot: string,
  dateKey?: string,
): string {
  const key = dateKey ?? logsDateKey();
  return join(fcopLogsRuntimeDir(projectRoot), `panel-actions-${key}.jsonl`);
}

export function listPanelActionsReadPaths(projectRoot: string): string[] {
  const dir = fcopLogsRuntimeDir(projectRoot);
  const paths: string[] = [];
  try {
    readdirSync(dir)
      .filter((f) => /^panel-actions-\d{8}\.jsonl$/.test(f))
      .sort((a, b) => b.localeCompare(a))
      .forEach((f) => paths.push(join(dir, f)));
  } catch {
    /* dir may not exist */
  }
  return paths;
}

export type PanelRuntimeActionInput = Omit<PanelRuntimeActionRecord, "ts" | "at"> &
  Partial<Pick<PanelRuntimeActionRecord, "ts" | "at">>;

export function appendPanelRuntimeAction(
  projectRoot: string,
  input: PanelRuntimeActionInput,
): PanelRuntimeActionRecord {
  const dir = fcopLogsRuntimeDir(projectRoot);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort */
  }
  const now = Date.now();
  const record: PanelRuntimeActionRecord = {
    ts: input.ts ?? now,
    at: input.at ?? new Date(input.ts ?? now).toISOString(),
    operator: String(input.operator || "ADMIN").trim() || "ADMIN",
    action: String(input.action || "unknown").trim() || "unknown",
    result: input.result ?? "ok",
    ...(input.target_agent ? { target_agent: input.target_agent } : {}),
    ...(input.target_task ? { target_task: input.target_task } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.session_id ? { session_id: input.session_id } : {}),
    ...(input.model_id ? { model_id: input.model_id } : {}),
    ...(input.current_leg !== undefined ? { current_leg: input.current_leg } : {}),
    ...(input.blocked_target ? { blocked_target: input.blocked_target } : {}),
    ...(input.cooldownReason ? { cooldownReason: input.cooldownReason } : {}),
    ...(input.remainingMs !== undefined ? { remainingMs: input.remainingMs } : {}),
    ...(input.untilMs !== undefined ? { untilMs: input.untilMs } : {}),
    ...(input.policy ? { policy: input.policy } : {}),
    ...(input.next_owner ? { next_owner: input.next_owner } : {}),
    ...(input.message ? { message: input.message } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.caller ? { caller: input.caller } : {}),
    ...(input.role ? { role: input.role } : {}),
    ...(input.next_retry_at !== undefined ? { next_retry_at: input.next_retry_at } : {}),
    ...(input.before_state !== undefined ? { before_state: input.before_state } : {}),
    ...(input.after_state !== undefined ? { after_state: input.after_state } : {}),
  };
  try {
    appendFileSync(
      fcopLogsPanelActionsPath(projectRoot),
      `${JSON.stringify(record)}\n`,
      "utf-8",
    );
  } catch {
    /* best-effort */
  }
  return record;
}

function parsePanelActionLines(raw: string): PanelRuntimeActionRecord[] {
  const out: PanelRuntimeActionRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as PanelRuntimeActionRecord);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

export function readPanelActionsFromDisk(
  projectRoot: string,
  scanLimit = 500,
): PanelRuntimeActionRecord[] {
  const paths = listPanelActionsReadPaths(projectRoot);
  const merged: PanelRuntimeActionRecord[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      merged.push(...parsePanelActionLines(readFileSync(p, "utf-8")));
    } catch {
      /* skip unreadable */
    }
    if (merged.length >= scanLimit) break;
  }
  merged.sort((a, b) => a.ts - b.ts);
  return merged.slice(-scanLimit);
}

function readRuntimeEventsForPanelActions(
  projectRoot: string,
  scanLimit: number,
): RuntimeEventRecord[] {
  const paths = listRuntimeEventsReadPaths(projectRoot);
  const merged: RuntimeEventRecord[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      for (const line of readFileSync(p, "utf-8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          merged.push(JSON.parse(line) as RuntimeEventRecord);
        } catch {
          /* skip */
        }
      }
    } catch {
      /* skip */
    }
  }
  merged.sort((a, b) => a.ts - b.ts);
  return merged.slice(-scanLimit);
}

const PANEL_SSE_EVENT_TYPES = new Set([
  "wake_agent.requested",
  "wake_agent.accepted",
  "wake_agent.skipped",
  "wake_agent.failed",
  "wake_agent.delayed",
  "runtime.session_started",
  "runtime.session_ended",
  "codeflowmu.agent_recycled",
  "codeflowmu.team_updated",
  "codeflowmu.lifecycle.task_to_review",
  "codeflowmu.lifecycle.review_to_done",
  "codeflowmu.lifecycle.review_to_active",
  "codeflowmu.lifecycle.done_to_archive",
  "codeflowmu.downstream_auto_nudge",
  "codeflowmu.task_dispatched",
  "codeflowmu.task_held",
  "codeflowmu.dispatch_skipped",
  "dispatch_skipped",
  "codeflowmu.execution_recovered",
  "codeflowmu.report_detected",
]);

/** Lifecycle chain actions merged per task_id; terminal phases win over dispatch. */
const LIFECYCLE_CHAIN_ACTIONS = new Set([
  "dispatch",
  "wake",
  "recover",
  "session_started",
  "report_written",
  "submit_review",
  "approve",
  "archive",
  "task_done",
]);

function normalizeTaskId(task?: string): string {
  return (task || "").replace(/\.md$/i, "").trim();
}

function lifecycleActionPriority(
  action: string,
  result: PanelRuntimeActionResult,
): number {
  if (action === "archive") return 100;
  if (action === "approve" || action === "task_done") return 90;
  if (action === "submit_review") return 80;
  if (action === "report_written") return 70;
  if (action === "session_started") return 50;
  if (action === "recover" || action === "wake") return 45;
  if (action === "dispatch" && result === "ok") return 30;
  if (action === "dispatch") return 25;
  return 10;
}

export function mergeTaskLifecycleActions(
  actions: PanelRuntimeActionRecord[],
): PanelRuntimeActionRecord[] {
  const lifecycleByTask = new Map<string, PanelRuntimeActionRecord[]>();
  const passthrough: PanelRuntimeActionRecord[] = [];

  for (const rec of actions) {
    const tid = normalizeTaskId(rec.target_task);
    if (!tid || !LIFECYCLE_CHAIN_ACTIONS.has(rec.action)) {
      passthrough.push(rec);
      continue;
    }
    const group = lifecycleByTask.get(tid) ?? [];
    group.push(rec);
    lifecycleByTask.set(tid, group);
  }

  const mergedLifecycle: PanelRuntimeActionRecord[] = [];
  for (const group of lifecycleByTask.values()) {
    if (group.length === 1) {
      mergedLifecycle.push(group[0]!);
      continue;
    }
    const sorted = [...group].sort((a, b) => {
      const pa = lifecycleActionPriority(a.action, a.result);
      const pb = lifecycleActionPriority(b.action, b.result);
      if (pb !== pa) return pb - pa;
      return b.ts - a.ts;
    });
    const representative = {
      ...sorted[0]!,
      raw_events: [...group].sort((a, b) => a.ts - b.ts),
      lifecycle_phase: sorted[0]!.action,
    };
    mergedLifecycle.push(representative);
  }

  return [...passthrough, ...mergedLifecycle].sort((a, b) => b.ts - a.ts);
}

function strField(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function runtimeEventToPanelAction(
  rec: RuntimeEventRecord,
): PanelRuntimeActionRecord | null {
  if (!PANEL_SSE_EVENT_TYPES.has(rec.event_type)) return null;
  const p = rec.payload ?? {};
  const agent =
    strField(rec.agent_id) ||
    strField(p.agent_id) ||
    strField(p.agentId);
  const task =
    strField(rec.task_id) ||
    strField(p.task_id) ||
    strField(p.taskId) ||
    strField(p.filename);
  const operator =
    strField(p.operator_role) ||
    strField(p.actor) ||
    strField(p.role) ||
    "system";

  switch (rec.event_type) {
    case "wake_agent.requested":
      return {
        ts: rec.ts,
        at: rec.at,
        operator,
        action: "wake",
        target_agent: agent || undefined,
        target_task: task || undefined,
        result: "pending",
        detail: strField(p.reason) || undefined,
      };
    case "wake_agent.accepted":
      return {
        ts: rec.ts,
        at: rec.at,
        operator,
        action: "wake",
        target_agent: agent || undefined,
        target_task: task || undefined,
        result: "ok",
        session_id: strField(rec.session_id) || strField(p.session_id) || undefined,
      };
    case "wake_agent.skipped":
      return {
        ts: rec.ts,
        at: rec.at,
        operator,
        action: "wake",
        target_agent: agent || undefined,
        target_task: task || undefined,
        result: "skipped",
        reason: strField(p.reason) || "skipped",
        detail: strField(p.detail) || undefined,
      };
    case "wake_agent.failed":
      return {
        ts: rec.ts,
        at: rec.at,
        operator,
        action: "wake",
        target_agent: agent || undefined,
        target_task: task || undefined,
        result: "failed",
        reason: strField(p.error) || "failed",
      };
    case "wake_agent.delayed":
      return {
        ts: rec.ts,
        at: rec.at,
        operator,
        action: "wake",
        target_agent: agent || undefined,
        target_task: task || undefined,
        result: "delayed",
        reason: strField(p.error) || "transient_sdk_error",
      };
    case "codeflowmu.agent_recycled":
      return {
        ts: rec.ts,
        at: rec.at,
        operator: strField(p.operator_role) || "ADMIN",
        action: "swap_ai",
        target_agent: agent || undefined,
        result: "ok",
        detail: strField(p.new_sdk_agent_id)
          ? `sdk ${String(p.new_sdk_agent_id).slice(0, 12)}…`
          : undefined,
      };
    case "codeflowmu.team_updated":
      return {
        ts: rec.ts,
        at: rec.at,
        operator: "ADMIN",
        action: "change_model",
        target_agent: agent || undefined,
        result: "ok",
        model_id: strField(p.model_id) || undefined,
      };
    case "codeflowmu.lifecycle.review_to_done":
      return {
        ts: rec.ts,
        at: rec.at,
        operator,
        action: "approve",
        target_task: task || undefined,
        result: "ok",
      };
    case "codeflowmu.lifecycle.review_to_active":
      return {
        ts: rec.ts,
        at: rec.at,
        operator,
        action: "reject",
        target_task: task || undefined,
        result: "ok",
        reason: strField(p.reason) || strField(p.reopen_reason) || undefined,
      };
    case "codeflowmu.lifecycle.done_to_archive":
      return {
        ts: rec.ts,
        at: rec.at,
        operator,
        action: "archive",
        target_task: task || undefined,
        result: "ok",
        reason: strField(p.reason) || undefined,
      };
    case "codeflowmu.lifecycle.task_to_review":
      return {
        ts: rec.ts,
        at: rec.at,
        operator,
        action: "submit_review",
        target_task: task || undefined,
        result: "ok",
      };
    case "codeflowmu.downstream_auto_nudge":
      return {
        ts: rec.ts,
        at: rec.at,
        operator: "system",
        action: "nudge",
        target_agent: agent || undefined,
        target_task: task || undefined,
        result: p.skipped === true ? "skipped" : "ok",
        reason: strField(p.reason) || undefined,
      };
    case "codeflowmu.task_dispatched":
      return {
        ts: rec.ts,
        at: rec.at,
        operator: strField(p.source) || "system",
        action: "dispatch",
        target_task: task || undefined,
        target_agent: strField(p.recipient) || strField(p.role) || undefined,
        result: p.deduplicated ? "skipped" : "ok",
        reason: p.deduplicated ? "deduplicated" : undefined,
        detail: strField(p.role) ? `to ${strField(p.role)}` : undefined,
      };
    case "codeflowmu.task_held":
      return {
        ts: rec.ts,
        at: rec.at,
        operator: "system",
        action: "task_held",
        target_task: task || strField(p.filename) || undefined,
        target_agent: strField(p.role) || undefined,
        result: "skipped",
        reason: strField(p.reason) || "waiting_explicit_dispatch",
      };
    case "codeflowmu.dispatch_skipped":
    case "dispatch_skipped":
      return {
        ts: rec.ts,
        at: rec.at,
        operator: "system",
        action: "dispatch",
        target_task: task || strField(p.filename) || undefined,
        result: "skipped",
        reason:
          strField(p.reason) === "task_not_dispatched"
            ? "task_not_dispatched"
            : strField(p.reason) || "dispatch_skipped",
        detail: strField(p.detail) || strField(p.waiting_on) || undefined,
      };
    case "codeflowmu.execution_recovered":
      return {
        ts: rec.ts,
        at: rec.at,
        operator: strField(p.operator) || "ADMIN",
        action: "recover",
        target_agent: agent || undefined,
        target_task: task || undefined,
        result: "ok",
        session_id: strField(p.session_id) || strField(rec.session_id) || undefined,
        detail: "recover_session_unsettled",
      };
    case "runtime.session_started":
      return {
        ts: rec.ts,
        at: rec.at,
        operator: "system",
        action: "session_started",
        target_agent: agent || undefined,
        target_task: task || undefined,
        result: "ok",
        session_id: strField(rec.session_id) || strField(p.session_id) || undefined,
      };
    case "runtime.session_ended": {
      const reportWritten = p.report_written === true;
      const st = strField(p.status).toLowerCase();
      if (reportWritten) {
        const reportPath = strField(p.report_path);
        const reportId = reportPath
          ? basename(reportPath).replace(/\.md$/i, "")
          : strField(p.report_id);
        return {
          ts: rec.ts,
          at: rec.at,
          operator: agent || "system",
          action: "report_written",
          target_agent: agent || undefined,
          target_task: task || undefined,
          result: "ok",
          session_id: strField(rec.session_id) || strField(p.session_id) || undefined,
          detail: reportId || reportPath || undefined,
        };
      }
      if (st === "completed" || st === "success" || st === "done") {
        return {
          ts: rec.ts,
          at: rec.at,
          operator: agent || "system",
          action: "session_started",
          target_agent: agent || undefined,
          target_task: task || undefined,
          result: "ok",
          session_id: strField(rec.session_id) || strField(p.session_id) || undefined,
          detail: "session_completed",
        };
      }
      return null;
    }
    case "codeflowmu.report_detected": {
      const filename = strField(p.filename);
      const reportId = filename.replace(/\.md$/i, "");
      const reportTask =
        strField(p.task_id) ||
        strField(p.references) ||
        task ||
        undefined;
      return {
        ts: rec.ts,
        at: rec.at,
        operator: strField(p.sender_role) || "system",
        action: "report_written",
        target_task: reportTask,
        target_agent: strField(p.sender_role) || undefined,
        result: "ok",
        detail: reportId || filename || undefined,
      };
    }
    default:
      return null;
  }
}

function dedupeKey(rec: PanelRuntimeActionRecord): string {
  if (rec.action.startsWith("agent_")) {
    return [
      rec.action,
      rec.operator,
      rec.object_short ?? "",
      rec.target_task ?? "",
      rec.result,
      String(rec.edit_count ?? 1),
      String(rec.ts),
    ].join("|");
  }
  return [
    rec.action,
    rec.target_agent ?? "",
    rec.target_task ?? "",
    rec.result,
    rec.reason ?? "",
    Math.floor(rec.ts / 3000),
  ].join("|");
}

/** Collapse long paths to repo-relative short form for ADMIN display. */
export function shortenDisplayPath(path: string): string {
  const norm = String(path || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim();
  if (!norm || norm === "(unknown)") return norm || "(unknown)";
  const parts = norm.split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join("/");
  const anchor = parts.findIndex((p) =>
    [
      "panel",
      "src",
      "fcop",
      "packages",
      "codeflowmu-shell",
      "codeflowmu-desktop",
      "docs",
    ].includes(p),
  );
  if (anchor >= 0) return parts.slice(anchor).join("/");
  return parts.slice(-2).join("/");
}

function pathContextLabel(shortPath: string): string {
  const p = shortPath.toLowerCase();
  if (p.includes("panel/index.html")) return "Panel 页面";
  if (p.includes("web-panel.ts")) return "Panel 服务";
  if (p.includes("panel-runtime-actions")) return "实时操作模块";
  if (p.includes(".test.")) return "测试文件";
  if (p.includes("fcop/reports")) return "回执报告";
  return "";
}

function opTypeLabel(eventType: ActionEvidenceRecord["event_type"]): string {
  switch (eventType) {
    case "file.read":
      return "读取";
    case "file.edit":
      return "修改";
    case "file.write":
      return "写入";
    case "command.run":
      return "执行命令";
    case "report.write":
      return "写报告";
    case "task.write":
      return "创建任务";
    case "data.query":
      return "查询";
    default:
      return "操作";
  }
}

function panelActionFromEvidenceType(
  eventType: ActionEvidenceRecord["event_type"],
): string {
  switch (eventType) {
    case "file.read":
      return "agent_read";
    case "file.edit":
      return "agent_edit";
    case "file.write":
      return "agent_write";
    case "command.run":
      return "agent_command";
    case "report.write":
      return "agent_report";
    case "task.write":
      return "agent_task";
    case "data.query":
      return "agent_query";
    default:
      return "agent_work";
  }
}

function inferActionIntent(rec: ActionEvidenceRecord): string {
  if (rec.event_type === "command.run") {
    const cmd = rec.command.toLowerCase();
    if (/test|vitest|jest|mocha|tsx --test|node:test/.test(cmd)) return "运行测试验证";
    if (/build|compile|tsc|typecheck/.test(cmd)) return "构建或类型检查";
    if (/npm install|pnpm install|yarn/.test(cmd)) return "安装依赖";
    if (/write_report|ledger_cli/.test(cmd)) return "写入回执或台账";
    return "执行本地命令";
  }
  if (rec.event_type === "file.read") return "读取代码上下文";
  if (rec.event_type === "report.write") return "提交任务回执";
  if (rec.event_type === "task.write") return "派发或创建子任务";
  if (rec.event_type === "data.query") return "查询数据";
  const path =
    "path" in rec ? shortenDisplayPath(rec.path) : "";
  if (rec.event_type === "file.edit" || rec.event_type === "file.write") {
    if (path.includes("panel/")) return "修改 Panel 界面或逻辑";
    if (path.includes(".test.")) return "更新或补充测试";
    if (path.includes("fcop/")) return "修改协作台账或协议文件";
    return "修改代码文件";
  }
  return "Agent 执行操作";
}

function agentActionHeadline(
  rec: ActionEvidenceRecord,
  opType: string,
): string {
  const agent = rec.agent_id || rec.role || "Agent";
  if (rec.event_type === "command.run") {
    const cmd = rec.command.toLowerCase();
    if (/test|vitest|jest|mocha|tsx --test|node:test/.test(cmd)) {
      return `${agent} 运行测试`;
    }
    return `${agent} 执行命令`;
  }
  if (rec.event_type === "report.write") return `${agent} 写回执`;
  if (rec.event_type === "task.write") return `${agent} 创建任务`;
  if (rec.event_type === "file.read") {
    const ctx = pathContextLabel(
      "path" in rec ? shortenDisplayPath(rec.path) : "",
    );
    return ctx ? `${agent} 读取 ${ctx}` : `${agent} 读取文件`;
  }
  const path = "path" in rec ? shortenDisplayPath(rec.path) : "";
  const ctx = pathContextLabel(path);
  return ctx ? `${agent} ${opType} ${ctx}` : `${agent} ${opType}文件`;
}

function buildResultSummary(rec: ActionEvidenceRecord): string {
  const failed = rec.status === "failed";
  if (rec.event_type === "command.run") {
    const isTest = /test|vitest|jest|mocha|tsx --test|node:test/i.test(
      rec.command,
    );
    if (failed) return "失败";
    if (isTest) {
      return rec.exit_code === 0 ? "通过" : `失败（退出码 ${rec.exit_code ?? "?"})`;
    }
    if (rec.exit_code != null) {
      return rec.exit_code === 0 ? "成功" : `退出码 ${rec.exit_code}`;
    }
    return "成功";
  }
  if (rec.event_type === "file.edit") return failed ? "修改失败" : "已修改";
  if (rec.event_type === "file.write") return failed ? "写入失败" : "已写入";
  if (rec.event_type === "file.read") return failed ? "读取失败" : "已读取";
  if (rec.event_type === "report.write") return failed ? "回执失败" : "回执已写";
  if (rec.event_type === "task.write") return failed ? "创建失败" : "任务已创建";
  if (rec.event_type === "data.query") {
    const rows =
      rec.row_count != null ? `，${rec.row_count} 行` : "";
    return failed ? "查询失败" : `查询完成${rows}`;
  }
  return failed ? "失败" : "成功";
}

export function actionEvidenceToPanelAction(
  rec: ActionEvidenceRecord,
): PanelRuntimeActionRecord {
  const ts = Date.parse(rec.at);
  const opType = opTypeLabel(rec.event_type);
  const path = "path" in rec ? String(rec.path ?? "") : "";
  const command = rec.event_type === "command.run" ? rec.command : "";
  const objectShort =
    rec.event_type === "command.run"
      ? command.split(/\s+/).slice(0, 6).join(" ")
      : shortenDisplayPath(path);
  const fullObject =
    rec.event_type === "command.run" ? command : path.replace(/\\/g, "/");

  return {
    ts: Number.isFinite(ts) ? ts : Date.now(),
    at: rec.at,
    operator: rec.agent_id || rec.role || "system",
    action: panelActionFromEvidenceType(rec.event_type),
    target_agent: rec.agent_id || rec.role || undefined,
    target_task: rec.task_id || undefined,
    result: rec.status === "failed" ? "failed" : "ok",
    session_id: rec.session_id,
    op_type: opType,
    object_short: objectShort,
    intent: inferActionIntent(rec),
    result_summary: buildResultSummary(rec),
    full_object: fullObject,
    detail: fullObject,
  };
}

const MERGEABLE_AGENT_ACTIONS = new Set(["agent_edit", "agent_write"]);

/** Merge consecutive edits/writes to the same file by the same agent (anti-spam). */
export function mergeConsecutiveAgentFileEdits(
  actions: PanelRuntimeActionRecord[],
): PanelRuntimeActionRecord[] {
  const sorted = [...actions].sort((a, b) => a.ts - b.ts);
  const out: PanelRuntimeActionRecord[] = [];

  for (const rec of sorted) {
    const prev = out[out.length - 1];
    const canMerge =
      prev &&
      MERGEABLE_AGENT_ACTIONS.has(prev.action) &&
      MERGEABLE_AGENT_ACTIONS.has(rec.action) &&
      prev.operator === rec.operator &&
      prev.object_short === rec.object_short &&
      prev.target_task === rec.target_task &&
      Math.abs(rec.ts - prev.ts) <= 10 * 60 * 1000;

    if (canMerge) {
      const count = (prev.edit_count ?? 1) + 1;
      const chain = [
        ...(prev.raw_events ?? [structuredClone(prev)]),
        rec,
      ];
      out[out.length - 1] = {
        ...prev,
        ts: rec.ts,
        at: rec.at,
        edit_count: count,
        result_summary:
          rec.result === "failed"
            ? "修改失败"
            : `已修改 ${count} 处`,
        raw_events: chain,
        result: rec.result === "failed" ? "failed" : prev.result,
      };
      continue;
    }

    out.push({
      ...rec,
      edit_count: MERGEABLE_AGENT_ACTIONS.has(rec.action) ? 1 : undefined,
    });
  }

  return out;
}

export function queryPanelRuntimeActions(
  projectRoot: string,
  limit = 20,
): PanelRuntimeActionRecord[] {
  const cap = Math.min(Math.max(limit, 1), 50);
  const scan = Math.max(cap * 8, 200);
  const fromDisk = readPanelActionsFromDisk(projectRoot, scan);
  const fromEvents = readRuntimeEventsForPanelActions(projectRoot, scan)
    .map(runtimeEventToPanelAction)
    .filter((r): r is PanelRuntimeActionRecord => r != null);

  const fromAgentWork = mergeConsecutiveAgentFileEdits(
    readRecentActionEvidence(projectRoot, scan).map(actionEvidenceToPanelAction),
  );

  const seen = new Set<string>();
  const deduped: PanelRuntimeActionRecord[] = [];
  for (const rec of [...fromDisk, ...fromEvents, ...fromAgentWork].sort(
    (a, b) => b.ts - a.ts,
  )) {
    const key = dedupeKey(rec);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(rec);
    if (deduped.length >= scan) break;
  }
  const merged = mergeTaskLifecycleActions(deduped);
  return merged.slice(0, cap).sort((a, b) => b.ts - a.ts);
}

export function maybeRecordPanelRuntimeActionFromSse(
  projectRoot: string,
  eventType: string,
  payload: Record<string, unknown>,
): void {
  if (!PANEL_SSE_EVENT_TYPES.has(eventType)) return;
  const mapped = runtimeEventToPanelAction({
    ts: Date.now(),
    at: new Date().toISOString(),
    event_type: eventType,
    agent_id: strField(payload.agent_id) || strField(payload.agentId) || undefined,
    session_id: strField(payload.session_id) || undefined,
    task_id: strField(payload.task_id) || strField(payload.taskId) || undefined,
    thread_key: strField(payload.thread_key) || undefined,
    payload,
  });
  if (!mapped) return;
  if (eventType === "wake_agent.requested") return;
  appendPanelRuntimeAction(projectRoot, mapped);
}
