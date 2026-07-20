import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { taskMarkdown } from "../../lifecycle/__tests__/helpers.ts";
import { ensureLedgerLayout, resolveLedgerLayout } from "../paths.ts";
import { LedgerBuilder } from "../LedgerBuilder.ts";
import {
  reconcileVirtualPmBranchArchives,
  settleVirtualPmBranchHotPathTask,
  VIRTUAL_PM_ACTOR,
} from "../virtualPmBranchSettle.ts";

async function withTempProject(
  fn: (ctx: { root: string }) => Promise<void>,
): Promise<void> {
  const { mkdtemp, rm, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "virtual-pm-settle-"));
  try {
    await ensureLedgerLayout(root);
    await fn({ root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const THREAD = "virtual-pm-branch-settle";
const BRANCH_TASK = "TASK-20260601-004-PM-to-DEV";
const MAIN_TASK = "TASK-20260601-001-ADMIN-to-PM";

describe("virtualPmBranchSettle", () => {
  it("auto review + archive branch hot_path task when review_check passes", async () => {
    await withTempProject(async ({ root }) => {
      const { writeFile } = await import("node:fs/promises");
      const layout = resolveLedgerLayout(root);

      await writeFile(
        join(layout.tasksDir, `${BRANCH_TASK}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "DEV",
            task_id: BRANCH_TASK,
            thread_key: THREAD,
            parent: MAIN_TASK,
          },
          "# Branch sub-task\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(layout.reportsDir, "REPORT-20260601-004-DEV-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "DEV",
            recipient: "PM",
            task_id: BRANCH_TASK,
            thread_key: THREAD,
            status: "done",
            references: [BRANCH_TASK],
          },
          "## 结论\nDEV done\n\n## 证据\n- tests passed\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      const result = await settleVirtualPmBranchHotPathTask(root, BRANCH_TASK);
      assert.ok(result);
      assert.equal(result!.review_check_ok, true);
      assert.equal(result!.reviewed, true);
      assert.equal(result!.archived, true);

      const archivePath = join(layout.lifecycleRoot, "archive", `${BRANCH_TASK}.md`);
      await access(archivePath);
      await assert.rejects(
        access(join(layout.tasksDir, `${BRANCH_TASK}.md`)),
        /ENOENT|not found/i,
      );
    });
  });

  it("does not archive when review_check fails (no REPORT)", async () => {
    await withTempProject(async ({ root }) => {
      const { writeFile } = await import("node:fs/promises");
      const layout = resolveLedgerLayout(root);

      await writeFile(
        join(layout.tasksDir, `${BRANCH_TASK}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "DEV",
            task_id: BRANCH_TASK,
            thread_key: THREAD,
            parent: MAIN_TASK,
          },
          "# Branch sub-task\n",
        ),
        "utf-8",
      );

      const result = await settleVirtualPmBranchHotPathTask(root, BRANCH_TASK);
      assert.ok(result);
      assert.equal(result!.review_check_ok, false);
      assert.equal(result!.archived, false);
      assert.match(result!.skipped_reason ?? "", /review_check/i);

      await access(join(layout.tasksDir, `${BRANCH_TASK}.md`));
    });
  });

  it("skips ADMIN mainline task on hot_path (not PM branch archivable)", async () => {
    await withTempProject(async ({ root }) => {
      const { writeFile } = await import("node:fs/promises");
      const layout = resolveLedgerLayout(root);

      await writeFile(
        join(layout.tasksDir, `${MAIN_TASK}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: MAIN_TASK,
            thread_key: THREAD,
          },
          "# Mainline\n",
        ),
        "utf-8",
      );

      const result = await settleVirtualPmBranchHotPathTask(root, MAIN_TASK);
      assert.ok(result);
      assert.equal(result!.archived, false);
      assert.match(result!.skipped_reason ?? "", /not branch/i);
    });
  });

  it("reconcile backfills already-approved branch tasks on hot path", async () => {
    await withTempProject(async ({ root }) => {
      const { writeFile } = await import("node:fs/promises");
      const layout = resolveLedgerLayout(root);

      await writeFile(
        join(layout.tasksDir, `${BRANCH_TASK}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "DEV",
            task_id: BRANCH_TASK,
            thread_key: THREAD,
            parent: MAIN_TASK,
            review_status: "approved",
            reviewed_by: VIRTUAL_PM_ACTOR,
            lifecycle_projection: "done",
            display_status: "done",
          },
          "# Already approved branch\n",
        ),
        "utf-8",
      );

      const results = await reconcileVirtualPmBranchArchives(root);
      assert.equal(results.length, 1);
      assert.equal(results[0]!.archived, true);

      await access(join(layout.lifecycleRoot, "archive", `${BRANCH_TASK}.md`));
    });
  });
});
