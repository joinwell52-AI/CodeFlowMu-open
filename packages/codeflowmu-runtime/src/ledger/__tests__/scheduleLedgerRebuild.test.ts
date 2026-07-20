import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { taskMarkdown } from "../../lifecycle/__tests__/helpers.ts";
import { LedgerBuilder } from "../LedgerBuilder.ts";
import { resolveLedgerLayout } from "../paths.ts";
import {
  flushScheduledLedgerRebuild,
  resetScheduleLedgerRebuildForTests,
  scheduleLedgerRebuild,
} from "../scheduleLedgerRebuild.ts";

async function withTempProject(
  fn: (ctx: { root: string }) => Promise<void>,
): Promise<void> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "schedule-rebuild-"));
  try {
    await fn({ root });
  } finally {
    resetScheduleLedgerRebuildForTests();
    await rm(root, { recursive: true, force: true });
  }
}

describe("scheduleLedgerRebuild", () => {
  it("refreshes role todo views after disk write without manual rebuild", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const inboxDir = join(layout.lifecycleRoot, "inbox");
      await mkdir(inboxDir, { recursive: true });

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      await writeFile(
        join(inboxDir, "TASK-20260612-028-PM-to-DEV.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            sender: "PM",
            recipient: "DEV",
            task_id: "TASK-20260612-028-PM-to-DEV",
          },
          "# auto-rebuild fixture\n",
        ),
        "utf-8",
      );

      assert.equal(await builder.detectStale(), true);
      scheduleLedgerRebuild(root);
      await flushScheduledLedgerRebuild(root);

      assert.equal(await builder.detectStale(), false);
      assert.equal(await builder.detectViewsStale(), false);
      const devView = await readFile(
        join(layout.ledgerDir, "views", "DEV.todo.md"),
        "utf-8",
      );
      assert.match(devView, /TASK-20260612-028-PM-to-DEV/);
    });
  });

  it("refreshes views when jsonl and views diverge", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const inboxDir = join(layout.lifecycleRoot, "inbox");
      await mkdir(inboxDir, { recursive: true });
      await writeFile(
        join(inboxDir, "TASK-20260612-028-PM-to-OPS.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            sender: "PM",
            recipient: "OPS",
            task_id: "TASK-20260612-028-PM-to-OPS",
          },
          "# ops fixture\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      const viewPath = join(layout.ledgerDir, "views", "OPS.todo.md");
      await writeFile(viewPath, "# OPS 待办\n\n（暂无任务）\n", "utf-8");

      assert.equal(await builder.detectViewsStale(), true);
      scheduleLedgerRebuild(root);
      await flushScheduledLedgerRebuild(root);

      assert.equal(await builder.detectViewsStale(), false);
      const opsView = await readFile(viewPath, "utf-8");
      assert.match(opsView, /TASK-20260612-028-PM-to-OPS/);
    });
  });
});
