import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { taskMarkdown } from "../../lifecycle/__tests__/helpers.ts";
import { ensureLedgerLayout, resolveLedgerLayout } from "../paths.ts";
import { LedgerBuilder } from "../LedgerBuilder.ts";
import {
  settleVirtualPmLifecycleReviewTask,
  VIRTUAL_PM_ACTOR,
} from "../virtualPmBranchSettle.ts";

async function withTempProject(
  fn: (ctx: { root: string }) => Promise<void>,
): Promise<void> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "lifecycle-review-settle-"));
  try {
    await ensureLedgerLayout(root);
    await fn({ root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const THREAD = "bus-closure-lifecycle-review";
const ROOT = "TASK-20260608-001-ADMIN-to-PM";
const OPS_TASK = "TASK-20260608-002-PM-to-OPS";

describe("settleVirtualPmLifecycleReviewTask", () => {
  it("review → done for PM→OPS lifecycle sub-task when review_check passes", async () => {
    await withTempProject(async ({ root }) => {
      const { writeFile } = await import("node:fs/promises");
      const layout = resolveLedgerLayout(root);

      await writeFile(
        join(layout.lifecycleRoot, "active", `${ROOT}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: ROOT,
            thread_key: THREAD,
          },
          "# Root\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(layout.lifecycleRoot, "review", `${OPS_TASK}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "OPS",
            task_id: OPS_TASK,
            parent: ROOT,
            thread_key: THREAD,
          },
          "# OPS sub-task\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(layout.reportsDir, "REPORT-20260608-003-OPS-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "OPS",
            recipient: "PM",
            task_id: OPS_TASK,
            thread_key: THREAD,
            status: "done",
            references: [OPS_TASK],
          },
          "## 结论\nOPS done\n\n## 证据\n- verified\n",
        ),
        "utf-8",
      );

      await new LedgerBuilder({ projectRoot: root }).rebuild();

      const result = await settleVirtualPmLifecycleReviewTask(root, OPS_TASK, {
        report_id: "REPORT-20260608-003-OPS-to-PM",
        autoArchive: false,
      });
      assert.ok(result);
      assert.equal(result!.review_check_ok, true);
      assert.equal(result!.reviewed, true);
      assert.equal(result!.archived, false);

      const donePath = join(layout.lifecycleRoot, "done", `${OPS_TASK}.md`);
      await access(donePath);
    });
  });

  it("review → done without autoArchive option does not archive (MVP default)", async () => {
    await withTempProject(async ({ root }) => {
      const { writeFile } = await import("node:fs/promises");
      const layout = resolveLedgerLayout(root);

      await writeFile(
        join(layout.lifecycleRoot, "active", `${ROOT}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: ROOT,
            thread_key: THREAD,
          },
          "# Root\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(layout.lifecycleRoot, "review", `${OPS_TASK}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "OPS",
            task_id: OPS_TASK,
            parent: ROOT,
            thread_key: THREAD,
          },
          "# OPS sub-task\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(layout.reportsDir, "REPORT-20260608-003-OPS-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "OPS",
            recipient: "PM",
            task_id: OPS_TASK,
            thread_key: THREAD,
            status: "done",
            references: [OPS_TASK],
          },
          "## 结论\nOPS done\n\n## 证据\n- verified\n",
        ),
        "utf-8",
      );

      await new LedgerBuilder({ projectRoot: root }).rebuild();

      const result = await settleVirtualPmLifecycleReviewTask(root, OPS_TASK, {
        report_id: "REPORT-20260608-003-OPS-to-PM",
      });
      assert.ok(result);
      assert.equal(result!.reviewed, true);
      assert.equal(result!.archived, false);

      await access(join(layout.lifecycleRoot, "done", `${OPS_TASK}.md`));
      await assert.rejects(
        access(join(layout.lifecycleRoot, "archive", `${OPS_TASK}.md`)),
      );
    });
  });

  it("does not auto-settle ADMIN→PM root task in review", async () => {
    await withTempProject(async ({ root }) => {
      const { writeFile } = await import("node:fs/promises");
      const layout = resolveLedgerLayout(root);

      await writeFile(
        join(layout.lifecycleRoot, "review", `${ROOT}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: ROOT,
            thread_key: THREAD,
          },
          "# Root in review\n",
        ),
        "utf-8",
      );

      const result = await settleVirtualPmLifecycleReviewTask(root, ROOT);
      assert.ok(result);
      assert.equal(result!.reviewed, false);
      assert.match(result!.skipped_reason ?? "", /not PM downstream/i);

      await access(join(layout.lifecycleRoot, "review", `${ROOT}.md`));
    });
  });
});
