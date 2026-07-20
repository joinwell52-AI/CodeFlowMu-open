import { promises as fs } from "node:fs";
import { basename, join } from "node:path";

import { resolveLedgerLayout } from "../ledger/paths.ts";
import { TaskFrontmatterStore } from "./TaskFrontmatterStore.ts";
import { lifecycleRelPath, stageFromPath } from "./taskPathUtils.ts";

const REPAIR_SOURCE_STAGES = ["inbox", "active", "review", "done"] as const;

export type RepairMisplacedArchiveResult = {
  task_id: string;
  from: string;
  to: string;
};

/**
 * Files that were half-archived (frontmatter state=archive / frozen) but never
 * left inbox|active|review|done — e.g. force archive before active→archive bypass.
 */
export async function repairMisplacedArchivedTasks(
  projectRoot: string,
): Promise<RepairMisplacedArchiveResult[]> {
  const layout = resolveLedgerLayout(projectRoot);
  const lifecycleRoot = layout.lifecycleRoot;
  const store = new TaskFrontmatterStore();
  const repaired: RepairMisplacedArchiveResult[] = [];

  for (const stage of REPAIR_SOURCE_STAGES) {
    const stageDir = join(lifecycleRoot, stage);
    let entries: string[];
    try {
      entries = await fs.readdir(stageDir);
    } catch {
      continue;
    }

    for (const name of entries) {
      if (!/^TASK-[\w-]+\.md$/i.test(name)) continue;
      const srcPath = join(stageDir, name);
      let fm: Record<string, unknown>;
      try {
        ({ fm } = await store.read(srcPath));
      } catch {
        continue;
      }

      const state = String(fm.state ?? "").toLowerCase();
      const frozen = fm.frozen === true;
      if (state !== "archive" && !frozen) continue;

      const destPath = join(lifecycleRoot, "archive", name);
      if (srcPath === destPath) continue;

      try {
        await fs.access(destPath);
        continue;
      } catch {
        /* dest absent — proceed */
      }

      await fs.mkdir(join(lifecycleRoot, "archive"), { recursive: true });
      await fs.rename(srcPath, destPath);

      const relFrom = lifecycleRelPath(stage, name);
      const relTo = lifecycleRelPath("archive", name);
      repaired.push({
        task_id: String(fm.task_id ?? basename(name, ".md")),
        from: relFrom,
        to: relTo,
      });
    }
  }

  return repaired;
}

/** True when task file claims archive/frozen but path is not under archive/. */
export async function isHalfArchivedTaskFile(
  taskPath: string,
  lifecycleRoot: string,
): Promise<boolean> {
  const stage = stageFromPath(taskPath, lifecycleRoot);
  if (!stage || stage === "archive") return false;
  const store = new TaskFrontmatterStore();
  try {
    const { fm } = await store.read(taskPath);
    const state = String(fm.state ?? "").toLowerCase();
    return state === "archive" || fm.frozen === true;
  } catch {
    return false;
  }
}
