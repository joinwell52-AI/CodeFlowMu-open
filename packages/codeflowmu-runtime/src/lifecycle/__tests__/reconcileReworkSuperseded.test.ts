import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { parseMarkdownFrontmatter } from "../../ledger/frontmatter.ts";
import { reconcileReworkSupersededTasks } from "../reconcileReworkSuperseded.ts";
import { withTempLifecycle, writeTaskAt } from "./helpers.ts";

test("启动回填将旧返工来源任务迁入 done 并指向最新替代任务", async () => {
  await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
    const sourceId = "TASK-20260712-906-PM-to-QA";
    const reworkId = "TASK-20260712-001-PM-to-QA-rework-1";
    await writeTaskAt(lifecycleRoot, "active", `${sourceId}.md`, {
      task_id: sourceId,
      sender: "PM",
      recipient: "QA",
      state: "active",
      review_status: "rejected",
      display_status: "waiting_rework",
    });
    await writeTaskAt(lifecycleRoot, "active", `${reworkId}.md`, {
      task_id: reworkId,
      sender: "PM",
      recipient: "QA",
      state: "active",
      rework_of: sourceId,
      rework_reason: "缺少 QA 证据",
    });

    const result = await reconcileReworkSupersededTasks(rootDir);
    assert.deepEqual(result.superseded, [sourceId]);
    const raw = await readFile(join(lifecycleRoot, "done", `${sourceId}.md`), "utf-8");
    const fm = parseMarkdownFrontmatter(raw);
    assert.equal(fm.state, "done");
    assert.equal(fm.review_status, "rejected");
    assert.equal(fm.display_status, "rejected_superseded");
    assert.equal(fm.superseded_by, reworkId);
  });
});
