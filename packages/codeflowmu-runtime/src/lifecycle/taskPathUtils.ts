import { readdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";

import type { LifecycleStage } from "./types.ts";
export type { LifecycleStage } from "./types.ts";

const STAGES: readonly LifecycleStage[] = [
  "inbox",
  "active",
  "review",
  "done",
  "archive",
];

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

export function stageFromPath(
  taskPath: string,
  lifecycleRoot: string,
): LifecycleStage | null {
  const norm = normalizePath(taskPath);
  const root = normalizePath(lifecycleRoot).replace(/\/$/, "");
  for (const stage of STAGES) {
    const prefix = `${root}/${stage}/`;
    if (norm.includes(prefix) || norm.endsWith(`${root}/${stage}`)) {
      return stage;
    }
  }
  return null;
}

export function lifecycleRelPath(stage: LifecycleStage, filename: string): string {
  return `fcop/_lifecycle/${stage}/${filename}`;
}

export function taskFilenameStem(taskId: string): string {
  const base = taskId.replace(/\.md$/i, "");
  return base.endsWith(".md") ? base : base;
}

/** Lifecycle root directory (`…/fcop/_lifecycle`) inferred from a task file path. */
export function lifecycleRootFromTaskPath(taskFilePath: string): string | null {
  const parts = taskFilePath.split(/[\\/]/);
  const idx = parts.findIndex((p) => p === "_lifecycle");
  if (idx <= 0) return null;
  return join(...parts.slice(0, idx + 1));
}

async function hasValidTaskFrontmatter(filePath: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    if (!raw.startsWith("---")) return false;
    const end = raw.indexOf("\n---", 3);
    if (end < 0) return false;
    const fm = raw.slice(3, end);
    return /^protocol:\s*(fcop|agent_bridge)\s*$/m.test(fm);
  } catch {
    return false;
  }
}

/**
 * After inbox→active rename, callers may still hold the old inbox path.
 * StateHistoryWriter.append on a missing path creates a corrupt stub file;
 * resolve to the canonical lifecycle copy with valid frontmatter first.
 */
export async function resolveTaskFileForMutation(
  taskFilePath: string,
  lifecycleRoot?: string,
): Promise<string> {
  if (await hasValidTaskFrontmatter(taskFilePath)) {
    return taskFilePath;
  }
  const root = lifecycleRoot ?? lifecycleRootFromTaskPath(taskFilePath);
  if (!root) return taskFilePath;

  const filename = basename(taskFilePath);
  const prefer: readonly LifecycleStage[] = [
    "active",
    "review",
    "done",
    "inbox",
    "archive",
  ];
  for (const stage of prefer) {
    const cand = join(root, stage, filename);
    if (await hasValidTaskFrontmatter(cand)) {
      return cand;
    }
  }
  return taskFilePath;
}

export type TaskStorageKind = "lifecycle" | "hot_path";

export type TaskLocation = {
  path: string;
  filename: string;
  storage: TaskStorageKind;
  stage: LifecycleStage | "tasks";
};

/** Resolve task file under `_lifecycle/` or legacy `fcop/tasks/` (hot_path). */
export async function findTaskLocationById(
  lifecycleRoot: string,
  taskId: string,
  opts?: { hotTasksDir?: string },
): Promise<TaskLocation | null> {
  const lifecycle = await findTaskPathById(lifecycleRoot, taskId);
  if (lifecycle) {
    return { ...lifecycle, storage: "lifecycle" };
  }
  const hotDir = opts?.hotTasksDir?.trim();
  if (!hotDir) return null;
  const stem = taskId.replace(/\.md$/i, "");
  let entries: string[];
  try {
    entries = await fs.readdir(hotDir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    if (
      name === `${stem}.md` ||
      name.startsWith(`${stem}-`) ||
      name.startsWith(stem)
    ) {
      return {
        path: join(hotDir, name),
        filename: name,
        storage: "hot_path",
        stage: "tasks",
      };
    }
  }
  return null;
}

function matchTaskFilename(name: string, stem: string): boolean {
  if (!name.endsWith(".md")) return false;
  return name === `${stem}.md` || name.startsWith(`${stem}-`) || name.startsWith(stem);
}

export function findTaskPathByIdSync(
  lifecycleRoot: string,
  taskId: string,
): { path: string; stage: LifecycleStage; filename: string } | null {
  const stem = taskId.replace(/\.md$/i, "");
  for (const stage of STAGES) {
    const dir = join(lifecycleRoot, stage);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (matchTaskFilename(name, stem)) {
        return { path: join(dir, name), stage, filename: name };
      }
    }
  }
  return null;
}

export async function findTaskPathById(
  lifecycleRoot: string,
  taskId: string,
): Promise<{ path: string; stage: LifecycleStage; filename: string } | null> {
  const stem = taskId.replace(/\.md$/i, "");
  for (const stage of STAGES) {
    const dir = join(lifecycleRoot, stage);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (matchTaskFilename(name, stem)) {
        return { path: join(dir, name), stage, filename: name };
      }
    }
  }
  return null;
}
