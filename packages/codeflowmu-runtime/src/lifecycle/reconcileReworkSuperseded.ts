import { promises as fs } from "node:fs";
import { join } from "node:path";

import { parseMarkdownFrontmatter, strField } from "../ledger/frontmatter.ts";
import { resolveLedgerLayout } from "../ledger/paths.ts";
import { removeTaskFromAgentQueue } from "../pm/agentTaskQueue.ts";
import { LifecycleStateMachine } from "./LifecycleStateMachine.ts";

const STAGES = ["inbox", "active", "review", "done", "archive"] as const;

export interface ReworkReconcileResult {
  superseded: string[];
  queues_cleared: string[];
}

/** Repair legacy rework chains and stale terminal-task queue entries at boot. */
export async function reconcileReworkSupersededTasks(
  projectRoot: string,
): Promise<ReworkReconcileResult> {
  const layout = resolveLedgerLayout(projectRoot);
  const machine = new LifecycleStateMachine({ lifecycleRoot: layout.lifecycleRoot });
  const replacements: Array<{
    taskId: string;
    reworkOf: string;
    reason: string;
  }> = [];
  const terminalTaskIds = new Set<string>();

  for (const stage of STAGES) {
    const dir = join(layout.lifecycleRoot, stage);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!/^TASK-/i.test(name) || !name.endsWith(".md")) continue;
      const raw = await fs.readFile(join(dir, name), "utf-8").catch(() => "");
      if (!raw) continue;
      const fm = parseMarkdownFrontmatter(raw);
      const taskId = strField(fm, "task_id") || name.replace(/\.md$/i, "");
      const reworkOf = strField(fm, "rework_of");
      if (reworkOf) {
        replacements.push({
          taskId,
          reworkOf,
          reason: strField(fm, "rework_reason") || `superseded by ${taskId}`,
        });
      }
      if (stage === "done" || stage === "archive") terminalTaskIds.add(taskId);
    }
  }

  const superseded: string[] = [];
  for (const replacement of replacements) {
    try {
      await machine.runtimeSupersedeForRework({
        taskId: replacement.reworkOf,
        supersededBy: replacement.taskId,
        reason: replacement.reason,
      });
      superseded.push(replacement.reworkOf);
      terminalTaskIds.add(replacement.reworkOf);
    } catch {
      // Broken legacy edges remain visible to ledger diagnostics.
    }
  }

  const queues_cleared: string[] = [];
  for (const taskId of terminalTaskIds) {
    try {
      await removeTaskFromAgentQueue(projectRoot, taskId);
      queues_cleared.push(taskId);
    } catch {
      /* best-effort queue cleanup */
    }
  }
  return { superseded, queues_cleared };
}
