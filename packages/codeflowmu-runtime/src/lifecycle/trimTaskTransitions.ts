import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";

import { findTaskPathById } from "./taskPathUtils.ts";
import { TaskFrontmatterStore } from "./TaskFrontmatterStore.ts";

export interface TrimTaskTransitionsOpts {
  lifecycleRoot: string;
  taskId: string;
  keep: number;
  /** Default: `fcop/_lifecycle/_repair` under project root parent of lifecycle. */
  repairDir?: string;
}

export interface TrimTaskTransitionsResult {
  ok: true;
  task_id: string;
  task_path: string;
  backup_path: string;
  repair_path: string;
  before_count: number;
  after_count: number;
  trimmed_count: number;
}

function repairDirDefault(lifecycleRoot: string): string {
  return join(lifecycleRoot, "_repair");
}

export async function trimTaskTransitions(
  opts: TrimTaskTransitionsOpts,
): Promise<TrimTaskTransitionsResult> {
  const taskIdInput = opts.taskId.replace(/\.md$/i, "").trim();
  const keep = Math.max(1, Math.floor(opts.keep));
  const located = await findTaskPathById(opts.lifecycleRoot, taskIdInput);
  if (!located) {
    throw new Error(`task not found: ${taskIdInput}`);
  }

  const taskPath = located.path;
  const raw = await fs.readFile(taskPath, "utf-8");
  const store = new TaskFrontmatterStore();
  const { fm, body } = await store.read(taskPath);
  const fmTaskId = String(fm.task_id ?? "").replace(/\.md$/i, "").trim();
  const idMatch = /^TASK-\d{8}-\d{3,}/i.exec(taskIdInput);
  const taskId =
    fmTaskId ||
    (idMatch ? idMatch[0].toUpperCase() : taskIdInput);
  const transitions = Array.isArray(fm.transitions) ? fm.transitions : [];
  const beforeCount = transitions.length;

  if (beforeCount <= keep) {
    const repairDir = opts.repairDir ?? repairDirDefault(opts.lifecycleRoot);
    await fs.mkdir(repairDir, { recursive: true });
    const repairPath = join(repairDir, `${taskId}.transitions.trimmed.json`);
    await fs.writeFile(
      repairPath,
      JSON.stringify(
        {
          task_id: taskId,
          task_path: taskPath,
          trimmed_at: new Date().toISOString(),
          before_count: beforeCount,
          after_count: beforeCount,
          trimmed_count: 0,
          removed: [],
        },
        null,
        2,
      ),
      "utf-8",
    );
    const backupPath = `${taskPath}.bak`;
    await fs.copyFile(taskPath, backupPath);
    return {
      ok: true,
      task_id: taskId,
      task_path: taskPath,
      backup_path: backupPath,
      repair_path: repairPath,
      before_count: beforeCount,
      after_count: beforeCount,
      trimmed_count: 0,
    };
  }

  const removed = transitions.slice(0, beforeCount - keep);
  const kept = transitions.slice(beforeCount - keep);

  const backupPath = `${taskPath}.bak`;
  await fs.copyFile(taskPath, backupPath);

  const repairDir = opts.repairDir ?? repairDirDefault(opts.lifecycleRoot);
  await fs.mkdir(repairDir, { recursive: true });
  const repairPath = join(repairDir, `${taskId}.transitions.trimmed.json`);
  await fs.writeFile(
    repairPath,
    JSON.stringify(
      {
        task_id: taskId,
        task_path: taskPath,
        trimmed_at: new Date().toISOString(),
        before_count: beforeCount,
        after_count: kept.length,
        trimmed_count: removed.length,
        removed,
        kept,
      },
      null,
      2,
    ),
    "utf-8",
  );

  const nextFm = { ...fm, transitions: kept };
  await store.write(taskPath, nextFm, body);

  return {
    ok: true,
    task_id: taskId,
    task_path: taskPath,
    backup_path: backupPath,
    repair_path: repairPath,
    before_count: beforeCount,
    after_count: kept.length,
    trimmed_count: removed.length,
  };
}
