import { existsSync, readFileSync } from "node:fs";

import {
  actionEvidenceLogPath,
  listActionEvidenceLogPaths,
} from "./actionLogPaths.ts";
import type { ActionEvidenceRecord } from "./actionLogTypes.ts";

function actionTargetSummary(rec: ActionEvidenceRecord): string {
  switch (rec.event_type) {
    case "file.read":
    case "file.edit":
    case "file.write":
      return rec.path;
    case "command.run":
      return rec.command.slice(0, 200);
    case "report.write":
      return rec.path || rec.report_id;
    case "task.write":
      return rec.path || rec.task_ref || "";
    case "data.query":
      return rec.query_summary || rec.query_id || "";
    default:
      return "";
  }
}

/** 按日 JSONL 尾部读取最近动作证据（新文件优先） */
export function readRecentActionEvidence(
  projectRoot: string,
  limit = 300,
): ActionEvidenceRecord[] {
  const cap = Math.min(Math.max(limit, 1), 2000);
  const paths = listActionEvidenceLogPaths(projectRoot);
  const out: ActionEvidenceRecord[] = [];

  for (const p of paths) {
    if (out.length >= cap) break;
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, "utf-8");
      const lines = raw.split(/\r?\n/).filter((l) => l.trim());
      for (let i = lines.length - 1; i >= 0 && out.length < cap; i--) {
        try {
          out.push(JSON.parse(lines[i]!) as ActionEvidenceRecord);
        } catch {
          /* skip malformed */
        }
      }
    } catch {
      /* skip file */
    }
  }
  return out;
}

/** 将动作证据记录映射为日志中心行 */
export function actionEvidenceToLogCenterRow(rec: ActionEvidenceRecord): {
  id: string;
  ts: number;
  at: string;
  tab: "actions";
  event_type: string;
  level: "ERROR" | "WARN" | "INFO";
  agent_id?: string;
  session_id?: string;
  task_id?: string;
  thread_key?: string;
  status?: string;
  message?: string;
  tool_name?: string;
  args_preview?: string;
  duration_ms?: number;
  payload?: ActionEvidenceRecord;
} {
  const ts = Date.parse(rec.at);
  const target = actionTargetSummary(rec);
  const level: "ERROR" | "WARN" | "INFO" =
    rec.status === "failed" ? "ERROR" : "INFO";
  const msgParts = [rec.event_type, target].filter(Boolean);
  const row: ReturnType<typeof actionEvidenceToLogCenterRow> = {
    id: `action-${rec.event_id}`,
    ts: Number.isFinite(ts) ? ts : Date.now(),
    at: rec.at,
    tab: "actions",
    event_type: rec.event_type,
    level,
    agent_id: rec.role || rec.agent_id,
    session_id: rec.session_id,
    ...(rec.task_id ? { task_id: rec.task_id } : {}),
    ...(rec.thread_key ? { thread_key: rec.thread_key } : {}),
    status: rec.status,
    message: msgParts.join(" · ").slice(0, 500),
    tool_name: target.slice(0, 120) || rec.event_type,
    args_preview: target.slice(0, 300),
    payload: rec,
  };
  if (rec.event_type === "command.run" && rec.duration_ms != null) {
    row.duration_ms = rec.duration_ms;
  }
  return row;
}

/** 动作证据主日志路径（最新按日文件，无则今日路径） */
export function actionEvidenceDisplayPath(projectRoot: string): string {
  const paths = listActionEvidenceLogPaths(projectRoot);
  return paths[0] ?? actionEvidenceLogPath(projectRoot);
}
