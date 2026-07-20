import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LedgerBuilder } from "../../ledger/LedgerBuilder.ts";
import { resolveLedgerLayout } from "../../ledger/paths.ts";
import {
  ChildTasksOpenError,
  assertMainlineArchiveChildrenReady,
  classifyRelatedChildTasksForMainlineArchive,
} from "../childTaskArchiveGate.ts";
import { taskMarkdown, withTempLifecycle, writeTaskAt } from "./helpers.ts";

describe("childTaskArchiveGate mainline archive classification", () => {
  it("classifies inbox child as blocking open", async () => {
    await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
      const mainId = "TASK-20260610-220-ADMIN-to-PM";
      const childId = "TASK-20260610-028-PM-to-DEV";
      await writeTaskAt(lifecycleRoot, "done", `${mainId}.md`, {
        task_id: mainId,
        thread_key: "panel-task-220",
      });
      await writeTaskAt(lifecycleRoot, "inbox", `${childId}.md`, {
        task_id: childId,
        parent: "TASK-20260610-220",
      });

      const classified = await classifyRelatedChildTasksForMainlineArchive({
        lifecycleRoot,
        projectRoot: rootDir,
        mainTaskId: mainId,
        mainFilename: `${mainId}.md`,
        mainThreadKey: "panel-task-220",
      });
      assert.equal(classified.blockingOpen.length, 1);
      assert.equal(classified.autoArchive.length, 0);
      assert.equal(classified.blockingNotAccepted.length, 0);

      await assert.rejects(
        () =>
          assertMainlineArchiveChildrenReady({
            lifecycleRoot,
            projectRoot: rootDir,
            mainTaskId: mainId,
            mainFilename: `${mainId}.md`,
            mainThreadKey: "panel-task-220",
          }),
        (err: unknown) => {
          assert.ok(err instanceof ChildTasksOpenError);
          return true;
        },
      );
    });
  });

  it("classifies done child without report as already settled for parent archive", async () => {
    await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
      const mainId = "TASK-20260610-220-ADMIN-to-PM";
      const childId = "TASK-20260610-040-PM-to-DEV";
      await writeTaskAt(lifecycleRoot, "done", `${mainId}.md`, {
        task_id: mainId,
        thread_key: "panel-task-220",
      });
      await writeTaskAt(lifecycleRoot, "done", `${childId}.md`, {
        task_id: childId,
        parent: "TASK-20260610-220",
        review_status: "approved",
      });

      const builder = new LedgerBuilder({ projectRoot: rootDir });
      await builder.rebuild();

      const classified = await classifyRelatedChildTasksForMainlineArchive({
        lifecycleRoot,
        projectRoot: rootDir,
        mainTaskId: mainId,
        mainFilename: `${mainId}.md`,
        mainThreadKey: "panel-task-220",
      });
      assert.equal(classified.blockingOpen.length, 0);
      assert.equal(classified.blockingNotAccepted.length, 0);
      assert.equal(classified.autoArchive.length, 0);

      const ready = await assertMainlineArchiveChildrenReady({
        lifecycleRoot,
        projectRoot: rootDir,
        mainTaskId: mainId,
        mainFilename: `${mainId}.md`,
        mainThreadKey: "panel-task-220",
      });
      assert.equal(ready.length, 0);
    });
  });

  it("classifies done child with review pass as settled without auto-archive", async () => {
    await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
      const mainId = "TASK-20260610-220-ADMIN-to-PM";
      const childId = "TASK-20260610-040-PM-to-DEV";
      await writeTaskAt(lifecycleRoot, "done", `${mainId}.md`, {
        task_id: mainId,
        thread_key: "panel-task-220",
      });
      await writeTaskAt(lifecycleRoot, "done", `${childId}.md`, {
        task_id: childId,
        parent: "TASK-20260610-220",
        review_status: "approved",
      });

      const layout = resolveLedgerLayout(rootDir);
      await mkdir(layout.reportsDir, { recursive: true });
      await writeFile(
        join(layout.reportsDir, "REPORT-20260610-110-DEV-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "DEV",
            recipient: "PM",
            task_id: childId,
            status: "done",
            references: [childId],
          },
          "## 结论\n完成。\n\n## 详情\n- ok\n",
        ),
        "utf-8",
      );
      const builder = new LedgerBuilder({ projectRoot: rootDir });
      await builder.rebuild();

      const classified = await classifyRelatedChildTasksForMainlineArchive({
        lifecycleRoot,
        projectRoot: rootDir,
        mainTaskId: mainId,
        mainFilename: `${mainId}.md`,
        mainThreadKey: "panel-task-220",
      });
      assert.equal(classified.autoArchive.length, 0);
      assert.equal(classified.blockingOpen.length, 0);
      assert.equal(classified.blockingNotAccepted.length, 0);

      const ready = await assertMainlineArchiveChildrenReady({
        lifecycleRoot,
        projectRoot: rootDir,
        mainTaskId: mainId,
        mainFilename: `${mainId}.md`,
        mainThreadKey: "panel-task-220",
      });
      assert.equal(ready.length, 0);
    });
  });

  it("classifies ADMIN→PM child with explicit parent as related child", async () => {
    await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
      const mainId = "TASK-20260610-220-ADMIN-to-PM";
      const childId = "TASK-20260610-221-ADMIN-to-PM";
      await writeTaskAt(lifecycleRoot, "done", `${mainId}.md`, {
        task_id: mainId,
        thread_key: "panel-task-220",
      });
      await writeTaskAt(lifecycleRoot, "inbox", `${childId}.md`, {
        task_id: childId,
        parent: mainId,
        thread_key: "panel-task-220",
      });

      const classified = await classifyRelatedChildTasksForMainlineArchive({
        lifecycleRoot,
        projectRoot: rootDir,
        mainTaskId: mainId,
        mainFilename: `${mainId}.md`,
        mainThreadKey: "panel-task-220",
      });
      assert.equal(classified.blockingOpen.length, 1);
      assert.equal(classified.blockingOpen[0]!.task_id, "TASK-20260610-221");
    });
  });
});
