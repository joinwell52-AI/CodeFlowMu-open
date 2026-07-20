/**
 * fcop/logs/runtime — runtime-events JSONL 路径（与 shell logs-paths 语义对齐）。
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { fcopLogsRuntimeDir } from "./actionLogPaths.ts";

export function runtimeLogsDateKey(d = new Date()): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export function runtimeEventsLogPath(
  projectRoot: string,
  dateKey?: string,
): string {
  const key = dateKey ?? runtimeLogsDateKey();
  return join(fcopLogsRuntimeDir(projectRoot), `runtime-events-${key}.jsonl`);
}

/** 读取用：legacy + 按日 runtime-events（旧 → 新） */
export function listRuntimeEventLogPaths(projectRoot: string): string[] {
  const out: string[] = [];
  const legacy = [
    join(projectRoot, ".codeflowmu", "events", "runtime-events.jsonl"),
    join(fcopLogsRuntimeDir(projectRoot), "runtime-events.jsonl"),
  ];
  for (const p of legacy) {
    if (existsSync(p)) out.push(p);
  }
  const dir = fcopLogsRuntimeDir(projectRoot);
  try {
    out.push(
      ...readdirSync(dir)
        .filter((f) => /^runtime-events-\d{8}\.jsonl$/.test(f))
        .sort()
        .map((f) => join(dir, f)),
    );
  } catch {
    /* no runtime dir */
  }
  return [...new Set(out)];
}
