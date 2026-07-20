import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { taskMarkdown } from "../../lifecycle/__tests__/helpers.ts";
import { ensureLedgerLayout, resolveLedgerLayout } from "../paths.ts";
import { LedgerBuilder } from "../LedgerBuilder.ts";
import {
  approveProjectedLifecycleTaskReview,
  isTaskPendingPmReviewInLedger,
  locateProjectedPmReviewLifecycleTask,
} from "../projectedLifecycleTaskLifecycle.ts";

async function withTempProject(
  fn: (ctx: { root: string }) => Promise<void>,
): Promise<void> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "projected-lifecycle-review-"));
  try {
    await ensureLedgerLayout(root);
    await fn({ root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const THREAD = "panel-task-005";
const OPS_TASK = "TASK-20260608-003-PM-to-OPS";
const OPS_REPORT = "REPORT-20260608-005-OPS-to-PM";

describe("projectedLifecycleTaskLifecycle", () => {
  it("approves active lifecycle branch task when ledger pending_pm_review", async () => {
    await withTempProject(async ({ root }) => {
      const { writeFile } = await import("node:fs/promises");
      const layout = resolveLedgerLayout(root);

      await writeFile(
        join(layout.lifecycleRoot, "active", `${OPS_TASK}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "OPS",
            task_id: OPS_TASK,
            thread_key: THREAD,
            state: "active",
          },
          "# OPS branch task\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(layout.reportsDir, `${OPS_REPORT}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "OPS",
            recipient: "PM",
            task_id: OPS_TASK,
            parent_task_id: OPS_TASK,
            thread_key: THREAD,
            status: "done",
            references: [OPS_TASK],
          },
          "## 结论\nOPS done\n",
        ),
        "utf-8",
      );

      await new LedgerBuilder({ projectRoot: root }).rebuild();
      assert.equal(await isTaskPendingPmReviewInLedger(root, OPS_TASK), true);

      const located = await locateProjectedPmReviewLifecycleTask(root, OPS_TASK);
      assert.ok(located);
      assert.match(located!.path, /active[/\\]TASK-20260608-003-PM-to-OPS\.md$/);

      const result = await approveProjectedLifecycleTaskReview({
        projectRoot: root,
        taskId: OPS_TASK,
        actor: "PM",
        note: "panel approve",
      });
      assert.equal(result.ok, true);
      assert.equal(result.from, "review");
      assert.equal(result.to, "done");

      await access(join(layout.lifecycleRoot, "done", `${OPS_TASK}.md`));
    });
  });
});
