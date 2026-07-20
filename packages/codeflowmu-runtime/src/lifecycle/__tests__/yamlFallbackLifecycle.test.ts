import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LifecycleGovernor } from "../../scheduler/LifecycleGovernor.ts";
import { ReportResolver } from "../../ledger/ReportResolver.ts";
import { LifecycleStateMachine } from "../LifecycleStateMachine.ts";
import { withTempLifecycle, writeTaskAt } from "./helpers.ts";

type GovInternals = {
  _moveInboxToActive: (p: string) => Promise<void>;
};

describe("yaml fallback lifecycle write guard", () => {
  it("LifecycleStateMachine allows automatic runtimeDispatchInboxToActive", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const path = await writeTaskAt(
        lifecycleRoot,
        "inbox",
        "TASK-20260612-010-ADMIN-to-PM.md",
        { task_id: "TASK-20260612-010", state: "inbox" },
      );
      const sm = new LifecycleStateMachine({
        lifecycleRoot,
        yamlFallbackMode: true,
      });
      await sm.runtimeDispatchInboxToActive(path);
      assert.equal(
        existsSync(join(lifecycleRoot, "active", "TASK-20260612-010-ADMIN-to-PM.md")),
        true,
      );
    });
  });

  it("LifecycleStateMachine allows admin submitReview in yaml fallback", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskId = "TASK-20260612-011-PM-to-OPS";
      await writeTaskAt(lifecycleRoot, "active", `${taskId}.md`, {
        task_id: taskId,
        from: "PM",
        to: "OPS",
        driver: "OPS",
        done_authority: "PM",
      });
      const sm = new LifecycleStateMachine({
        lifecycleRoot,
        yamlFallbackMode: true,
      });
      const result = await sm.submitReview({
        taskId,
        actor: "OPS",
        reportId: "REPORT-20260612-001-OPS-to-PM",
      });
      assert.equal(result.to, "review");
    });
  });

  it("LifecycleGovernor scheduleInboxToActive moves inbox to active in yaml fallback", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const path = await writeTaskAt(
        lifecycleRoot,
        "inbox",
        "TASK-20260612-012-ADMIN-to-PM.md",
        { task_id: "TASK-20260612-012", state: "inbox" },
      );
      const gov = new LifecycleGovernor({
        lifecycleRoot,
        yamlFallbackMode: true,
      });
      gov.scheduleInboxToActive(path);
      await new Promise((r) => setTimeout(r, 50));
      const activePath = join(lifecycleRoot, "active", "TASK-20260612-012-ADMIN-to-PM.md");
      const raw = await readFile(activePath, "utf-8");
      assert.match(raw, /runtime_dispatch/);
    });
  });

  it("ReportResolver reconcile submits review in yaml fallback", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      await writeTaskAt(
        lifecycleRoot,
        "active",
        "TASK-20260612-013-ADMIN-to-PM.md",
        {
          task_id: "TASK-20260612-013",
          from: "ADMIN",
          to: "PM",
          driver: "PM",
          done_authority: "ADMIN",
        },
      );
      const reportsDir = join(rootDir, "fcop", "reports");
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(reportsDir, { recursive: true });
      const reportPath = join(reportsDir, "REPORT-20260612-013-PM-to-ADMIN.md");
      await writeFile(
        reportPath,
        `---\nprotocol: fcop\nsender: PM\nrecipient: ADMIN\nstatus: done\ntask_id: TASK-20260612-013\n---\n# r\n`,
        "utf-8",
      );

      const resolver = new ReportResolver({
        lifecycleRoot,
        projectRoot: rootDir,
        yamlFallbackMode: true,
      });
      const outcome = await resolver.resolve(reportPath);
      assert.equal(outcome, "reconciled");
      assert.equal(
        existsSync(join(lifecycleRoot, "review", "TASK-20260612-013-ADMIN-to-PM.md")),
        true,
      );
    });
  });
});
