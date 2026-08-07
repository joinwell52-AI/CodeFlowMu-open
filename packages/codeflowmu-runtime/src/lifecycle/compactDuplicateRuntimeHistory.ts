import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { TaskFrontmatterStore } from "./TaskFrontmatterStore.ts";

export interface CompactDuplicateRuntimeHistoryResult {
  ok: true;
  task_path: string;
  backup_path: string | null;
  repair_path: string | null;
  before_count: number;
  after_count: number;
  compacted_count: number;
}

const DUPLICATE_OBSERVATION = /\|\s*`inbox`\s*→\s*`already_dispatched`(?:\s|$)/;

/**
 * One-off compatibility repair for files inflated by the old duplicate scan.
 * It preserves the first timestamp as a summary event and stores every removed
 * line in a sidecar repair record. Normal queue scans never call this writer.
 */
export async function compactDuplicateRuntimeHistory(input: {
  taskPath: string;
  repairDir?: string;
}): Promise<CompactDuplicateRuntimeHistoryResult> {
  const store = new TaskFrontmatterStore();
  const { fm, body } = await store.read(input.taskPath);
  const lines = body.split(/\r?\n/);
  const indexes = lines
    .map((line, index) => DUPLICATE_OBSERVATION.test(line) ? index : -1)
    .filter((index) => index >= 0);
  if (indexes.length <= 1) {
    return {
      ok: true,
      task_path: input.taskPath,
      backup_path: null,
      repair_path: null,
      before_count: indexes.length,
      after_count: indexes.length,
      compacted_count: 0,
    };
  }

  const keepIndex = indexes[0]!;
  const removed = indexes.slice(1).map((index) => lines[index]!);
  lines[keepIndex] = `${lines[keepIndex]} duplicate_scan summary: ${indexes.length} equivalent observations compacted`;
  const removeSet = new Set(indexes.slice(1));
  const nextBody = lines.filter((_line, index) => !removeSet.has(index)).join("\n");
  const backupPath = `${input.taskPath}.state-history.bak`;
  await fs.copyFile(input.taskPath, backupPath);
  const repairDir = input.repairDir ?? join(dirname(input.taskPath), "_repair");
  await fs.mkdir(repairDir, { recursive: true });
  const taskId = String(fm.task_id ?? "task").replace(/\.md$/i, "").trim();
  const repairPath = join(repairDir, `${taskId}.already-dispatched.compacted.json`);
  await fs.writeFile(repairPath, `${JSON.stringify({
    task_id: taskId,
    task_path: input.taskPath,
    compacted_at: new Date().toISOString(),
    before_count: indexes.length,
    after_count: 1,
    removed,
  }, null, 2)}\n`, "utf-8");
  await store.write(input.taskPath, fm, nextBody);
  return {
    ok: true,
    task_path: input.taskPath,
    backup_path: backupPath,
    repair_path: repairPath,
    before_count: indexes.length,
    after_count: 1,
    compacted_count: indexes.length - 1,
  };
}
