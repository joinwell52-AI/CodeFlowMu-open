/**
 * fcop/logs/runtime — Action Evidence Log 路径（与 shell logs-paths 语义对齐）。
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const ACTION_LOG_SCHEMA_VERSION = "action-log-v1";
export const ACTION_LOG_SOURCE = "codeflowmu-runtime";

/** 自然日键 YYYYMMDD（UTC，与 thinking / usage 一致） */
export function actionLogsDateKey(d = new Date()): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export function fcopLogsRoot(projectRoot: string): string {
  return join(projectRoot, "fcop", "logs");
}

export function fcopLogsRuntimeDir(projectRoot: string): string {
  return join(fcopLogsRoot(projectRoot), "runtime");
}

export function fcopLogsRuntimeCommandsDir(projectRoot: string): string {
  return join(fcopLogsRuntimeDir(projectRoot), "commands");
}

/** 当日（或指定日）actions 写入路径 */
export function actionEvidenceLogPath(
  projectRoot: string,
  dateKey?: string,
): string {
  const key = dateKey ?? actionLogsDateKey();
  return join(fcopLogsRuntimeDir(projectRoot), `actions-${key}.jsonl`);
}

/** 读取用：按日 actions 文件（新 → 旧） */
export function listActionEvidenceLogPaths(projectRoot: string): string[] {
  const dir = fcopLogsRuntimeDir(projectRoot);
  try {
    return readdirSync(dir)
      .filter((f) => /^actions-\d{8}\.jsonl$/.test(f))
      .sort((a, b) => b.localeCompare(a))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** 解析当日 actions 路径；目录不存在时仍返回预期路径 */
export function resolveActionEvidenceReadPath(projectRoot: string): string {
  const paths = listActionEvidenceLogPaths(projectRoot);
  if (paths.length > 0) return paths[0]!;
  return actionEvidenceLogPath(projectRoot);
}
