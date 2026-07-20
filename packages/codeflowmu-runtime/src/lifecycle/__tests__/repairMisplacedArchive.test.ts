import { access } from "node:fs/promises";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TaskFrontmatterStore } from "../TaskFrontmatterStore.ts";
import { repairMisplacedArchivedTasks } from "../repairMisplacedArchive.ts";
import { withTempLifecycle, writeTaskAt } from "./helpers.ts";

describe("repairMisplacedArchivedTasks", () => {
  it("moves half-archived active task into archive/", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      const taskId = "TASK-20260530-099-ADMIN-to-PM";
      await writeTaskAt(lifecycleRoot, "active", `${taskId}.md`, {
        task_id: taskId,
        from: "ADMIN",
        to: "PM",
        state: "archive",
        frozen: true,
      });

      const repaired = await repairMisplacedArchivedTasks(rootDir);
      assert.equal(repaired.length, 1);
      assert.equal(repaired[0]?.task_id, taskId);
      assert.match(repaired[0]?.to ?? "", /archive\//);

      const activePath = `${lifecycleRoot}/active/${taskId}.md`.replace(/\\/g, "/");
      const archivePath = `${lifecycleRoot}/archive/${taskId}.md`.replace(/\\/g, "/");
      await assert.rejects(() => access(activePath));
      await access(archivePath);

      const store = new TaskFrontmatterStore();
      const { fm } = await store.read(archivePath);
      assert.equal(fm.state, "archive");
      assert.equal(fm.frozen, true);
    });
  });
});
