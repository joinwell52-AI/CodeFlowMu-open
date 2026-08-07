import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { compactDuplicateRuntimeHistory } from "../compactDuplicateRuntimeHistory.ts";
import { TaskFrontmatterStore } from "../TaskFrontmatterStore.ts";
import { withTempLifecycle, writeTaskAt } from "./helpers.ts";

describe("compactDuplicateRuntimeHistory", () => {
  it("keeps one meaningful observation and preserves removed rows in a repair sidecar", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskId = "TASK-20260807-054";
      const path = await writeTaskAt(
        lifecycleRoot,
        "inbox",
        `${taskId}-ADMIN-to-PM.md`,
        { task_id: taskId, sender: "ADMIN", recipient: "PM", state: "inbox" },
      );
      const history = Array.from({ length: 385 }, (_value, index) =>
        `- **2026-08-07T10:00:${String(index % 60).padStart(2, "0")}.000Z** | by \`runtime\` | \`inbox\` → \`already_dispatched\``,
      ).join("\n");
      await new TaskFrontmatterStore().write(
        path,
        { task_id: taskId, sender: "ADMIN", recipient: "PM", state: "inbox" },
        `# task\n\n## state_history (auto-appended by runtime)\n\n${history}\n`,
      );

      const result = await compactDuplicateRuntimeHistory({ taskPath: path });
      assert.equal(result.before_count, 385);
      assert.equal(result.after_count, 1);
      assert.equal(result.compacted_count, 384);
      const repaired = await readFile(path, "utf-8");
      assert.equal((repaired.match(/already_dispatched/g) ?? []).length, 1);
      assert.match(repaired, /duplicate_scan summary: 385 equivalent observations compacted/);
      assert.ok(result.backup_path);
      assert.ok(result.repair_path);
      const sidecar = JSON.parse(await readFile(result.repair_path!, "utf-8")) as { removed: string[] };
      assert.equal(sidecar.removed.length, 384);
    });
  });
});
