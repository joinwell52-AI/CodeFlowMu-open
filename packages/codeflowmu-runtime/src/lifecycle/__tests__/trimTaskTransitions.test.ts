import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { trimTaskTransitions } from "../trimTaskTransitions.ts";
import { TaskFrontmatterStore } from "../TaskFrontmatterStore.ts";
import { withTempLifecycle, writeTaskAt } from "./helpers.ts";

describe("trimTaskTransitions", () => {
  it("backs up, writes repair file, keeps last N transitions", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskId = "TASK-20260612-020";
      const transitions = Array.from({ length: 50 }, (_, i) => ({
        at: `2026-06-12T10:${String(i).padStart(2, "0")}:00+08:00`,
        from: i % 2 === 0 ? "inbox" : "active",
        to: i % 2 === 0 ? "active" : "inbox",
        by: "CodeFlowMu",
        action: i % 2 === 0 ? "runtime_dispatch" : "runtime_restore_failed_dispatch",
      }));
      const path = await writeTaskAt(
        lifecycleRoot,
        "inbox",
        `${taskId}-ADMIN-to-PM.md`,
        {
        task_id: taskId,
        sender: "ADMIN",
        recipient: "PM",
        state: "inbox",
        },
      );
      await new TaskFrontmatterStore().write(
        path,
        {
          task_id: taskId,
          sender: "ADMIN",
          recipient: "PM",
          state: "inbox",
          transitions,
        },
        "## body preserved\n",
      );

      const bodyBefore = await readFile(path, "utf-8");
      const result = await trimTaskTransitions({
        lifecycleRoot,
        taskId,
        keep: 30,
      });

      assert.equal(result.before_count, 50);
      assert.equal(result.after_count, 30);
      assert.equal(result.trimmed_count, 20);
      assert.ok(result.backup_path.endsWith(".bak"));
      assert.ok(
        result.repair_path.replace(/\\/g, "/").endsWith(
          "_repair/TASK-20260612-020.transitions.trimmed.json",
        ),
      );

      const { fm } = await new TaskFrontmatterStore().read(path);
      assert.equal(fm.transitions?.length, 30);
      assert.equal(fm.sender, "ADMIN");
      assert.equal(fm.state, "inbox");

      const backup = await readFile(result.backup_path, "utf-8");
      assert.equal(backup, bodyBefore);

      const repairRaw = await readFile(result.repair_path, "utf-8");
      const repair = JSON.parse(repairRaw) as { removed: unknown[]; kept: unknown[] };
      assert.equal(repair.removed.length, 20);
      assert.equal(repair.kept.length, 30);
    });
  });
});
