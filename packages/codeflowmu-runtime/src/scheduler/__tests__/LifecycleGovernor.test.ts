import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  taskMarkdown,
  withTempLifecycle,
  writeTaskAt,
} from "../../lifecycle/__tests__/helpers.ts";
import { ReportResolver } from "../../ledger/ReportResolver.ts";
import { LifecycleGovernor } from "../LifecycleGovernor.ts";

type GovInternals = {
  _moveInboxToActive: (p: string) => Promise<void>;
};

function governor(lifecycleRoot: string, projectRoot?: string): LifecycleGovernor {
  return new LifecycleGovernor({
    lifecycleRoot,
    ...(projectRoot ? { projectRoot } : {}),
    moveTimeoutMs: 10_000,
  });
}

function reportResolver(
  lifecycleRoot: string,
  projectRoot: string,
): ReportResolver {
  return new ReportResolver({
    lifecycleRoot,
    projectRoot,
    moveTimeoutMs: 10_000,
  });
}

async function writeReportAt(
  lifecycleRoot: string,
  filename: string,
  fm: Record<string, string | string[]>,
): Promise<string> {
  const dir = join(lifecycleRoot, "..", "reports");
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  const path = join(dir, filename);
  const body = taskMarkdown(
    {
      protocol: "fcop",
      version: 1,
      kind: "report",
      sender: fm.sender ?? "PM",
      recipient: fm.recipient ?? "ADMIN",
      ...fm,
    } as Parameters<typeof taskMarkdown>[0],
    "# Report\n",
  );
  await writeFile(path, body, "utf-8");
  return path;
}

describe("LifecycleGovernor", () => {
  it("inbox→active writes transitions", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskPath = await writeTaskAt(
        lifecycleRoot,
        "inbox",
        "TASK-20260530-001-ADMIN-to-PM.md",
        {
          protocol: "fcop",
          version: 1,
          kind: "task",
          sender: "ADMIN",
          recipient: "PM",
          to: "PM",
          driver: "PM",
        },
      );
      const gov = governor(lifecycleRoot);
      await (gov as unknown as GovInternals)._moveInboxToActive(taskPath);

      const activePath = join(
        lifecycleRoot,
        "active",
        "TASK-20260530-001-ADMIN-to-PM.md",
      );
      const raw = await readFile(activePath, "utf-8");
      assert.match(raw, /transitions:/);
      assert.match(raw, /runtime_dispatch/);
    });
  });

  it("REPORT sender == driver triggers submit_review", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      const taskPath = await writeTaskAt(
        lifecycleRoot,
        "active",
        "TASK-20260530-002-ADMIN-to-PM.md",
        {
          protocol: "fcop",
          version: 1,
          kind: "task",
          sender: "ADMIN",
          recipient: "PM",
          to: "PM",
          driver: "PM",
          done_authority: "ADMIN",
        },
      );
      const reportPath = await writeReportAt(
        lifecycleRoot,
        "REPORT-20260530-002-PM-to-ADMIN.md",
        {
          sender: "PM",
          recipient: "ADMIN",
          status: "done",
          task_id: "TASK-20260530-002-ADMIN-to-PM",
        },
      );

      const resolver = reportResolver(lifecycleRoot, rootDir);
      await resolver.resolve(reportPath);

      const reviewPath = join(
        lifecycleRoot,
        "review",
        "TASK-20260530-002-ADMIN-to-PM.md",
      );
      const raw = await readFile(reviewPath, "utf-8");
      assert.match(raw, /submit_review/);
      assert.ok(taskPath);
    });
  });

  it("REPORT sender != driver does not trigger submit_review", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      await writeTaskAt(
        lifecycleRoot,
        "active",
        "TASK-20260530-003-ADMIN-to-PM.md",
        {
          protocol: "fcop",
          version: 1,
          kind: "task",
          sender: "ADMIN",
          recipient: "PM",
          to: "PM",
          driver: "PM",
        },
      );
      const reportPath = await writeReportAt(
        lifecycleRoot,
        "REPORT-20260530-003-DEV-to-PM.md",
        {
          sender: "DEV",
          recipient: "PM",
          task_id: "TASK-20260530-003-ADMIN-to-PM",
        },
      );

      const resolver = reportResolver(lifecycleRoot, rootDir);
      await resolver.resolve(reportPath);

      const reviewPath = join(
        lifecycleRoot,
        "review",
        "TASK-20260530-003-ADMIN-to-PM.md",
      );
      await assert.rejects(() => readFile(reviewPath, "utf-8"));
    });
  });

  it("PM→ADMIN report with references only and task without driver triggers submit_review", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      await writeTaskAt(
        lifecycleRoot,
        "active",
        "TASK-20260603-001-ADMIN-to-PM.md",
        {
          protocol: "fcop",
          version: 1,
          kind: "task",
          sender: "ADMIN",
          recipient: "PM",
        },
      );
      const reportPath = await writeReportAt(
        lifecycleRoot,
        "REPORT-20260603-001-PM-to-ADMIN.md",
        {
          sender: "PM",
          recipient: "ADMIN",
          status: "done",
          references: ["TASK-20260603-001"],
        },
      );

      const resolver = reportResolver(lifecycleRoot, rootDir);
      await resolver.resolve(reportPath);

      const reviewPath = join(
        lifecycleRoot,
        "review",
        "TASK-20260603-001-ADMIN-to-PM.md",
      );
      const raw = await readFile(reviewPath, "utf-8");
      assert.match(raw, /submit_review/);
    });
  });

  it("reconcileStuckPmOutboundReports picks up existing PM→ADMIN done reports", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      await writeTaskAt(
        lifecycleRoot,
        "active",
        "TASK-20260603-002-ADMIN-to-PM.md",
        {
          protocol: "fcop",
          version: 1,
          kind: "task",
          sender: "ADMIN",
          recipient: "PM",
        },
      );
      await writeReportAt(
        lifecycleRoot,
        "REPORT-20260603-002-PM-to-ADMIN.md",
        {
          sender: "PM",
          recipient: "ADMIN",
          status: "done",
          references: ["TASK-20260603-002"],
        },
      );

      const reportsDir = join(rootDir, "fcop", "reports");
      const logs: string[] = [];
      const gov = new LifecycleGovernor({
        lifecycleRoot,
        projectRoot: rootDir,
        moveTimeoutMs: 10_000,
        logger: { info: (m) => logs.push(m) },
      });
      await (
        gov as unknown as {
          _reconcileStuckPmOutboundReports: (d: string) => Promise<void>;
        }
      )._reconcileStuckPmOutboundReports(reportsDir);

      const reviewPath = join(
        lifecycleRoot,
        "review",
        "TASK-20260603-002-ADMIN-to-PM.md",
      );
      const raw = await readFile(reviewPath, "utf-8");
      assert.match(raw, /submit_review/);
      assert.ok(
        logs.some((l) => l.includes("PM→ADMIN reconcile summary:")),
        `expected summary log, got: ${logs.join(" | ")}`,
      );
      assert.match(logs.join("\n"), /reconciled=1/);
    });
  });

  it("reconcile skips archived tasks and auto-generated PM→ADMIN blocked reports", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      await writeTaskAt(
        lifecycleRoot,
        "archive",
        "TASK-20260603-003-ADMIN-to-PM.md",
        {
          protocol: "fcop",
          version: 1,
          kind: "task",
          sender: "ADMIN",
          recipient: "PM",
        },
      );
      await writeReportAt(
        lifecycleRoot,
        "REPORT-20260603-003-PM-to-ADMIN.md",
        {
          sender: "PM",
          recipient: "ADMIN",
          status: "done",
          task_id: "TASK-20260603-003-ADMIN-to-PM",
        },
      );
      const autoBody = [
        "---",
        "sender: PM",
        "recipient: ADMIN",
        "status: blocked",
        "task_id: TASK-20260603-004-ADMIN-to-PM",
        "---",
        "## Runtime 自动补写 / Auto-generated reciprocal report",
        "ReportGate noise",
      ].join("\n");
      const reportsDir = join(rootDir, "fcop", "reports");
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(reportsDir, { recursive: true });
      await writeFile(
        join(reportsDir, "REPORT-20260603-004-PM-to-ADMIN.md"),
        autoBody,
        "utf-8",
      );

      const logs: string[] = [];
      const gov = new LifecycleGovernor({
        lifecycleRoot,
        projectRoot: rootDir,
        moveTimeoutMs: 10_000,
        logger: { info: (m) => logs.push(m) },
      });
      await (
        gov as unknown as {
          _reconcileStuckPmOutboundReports: (d: string) => Promise<void>;
        }
      )._reconcileStuckPmOutboundReports(reportsDir);

      const reviewPath = join(
        lifecycleRoot,
        "review",
        "TASK-20260603-003-ADMIN-to-PM.md",
      );
      await assert.rejects(() => readFile(reviewPath, "utf-8"));
      const summary = logs.find((l) => l.includes("PM→ADMIN reconcile summary:"));
      assert.ok(summary);
      assert.match(summary!, /skipped_archived=1/);
      assert.match(summary!, /skipped_auto=1/);
    });
  });

  it("DEV→PM done report still projects child task to pending_pm_review", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      await writeTaskAt(
        lifecycleRoot,
        "active",
        "TASK-20260605-025-PM-to-DEV.md",
        {
          protocol: "fcop",
          version: 1,
          kind: "task",
          sender: "PM",
          recipient: "DEV",
          driver: "DEV",
          parent: "TASK-20260605-024",
        },
      );
      const reportPath = await writeReportAt(
        lifecycleRoot,
        "REPORT-20260605-016-DEV-to-PM.md",
        {
          sender: "DEV",
          recipient: "PM",
          status: "done",
          references: ["TASK-20260605-025"],
        },
      );

      const resolver = reportResolver(lifecycleRoot, rootDir);
      const outcome = await resolver.resolve(reportPath);
      assert.equal(outcome, "reconciled");

      const activePath = join(
        lifecycleRoot,
        "active",
        "TASK-20260605-025-PM-to-DEV.md",
      );
      const raw = await readFile(activePath, "utf-8");
      assert.match(raw, /waiting_pm_review/);
    });
  });

  it("restoreToInboxAfterDispatchFailure patches inbox file state dispatched→inbox", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskPath = await writeTaskAt(
        lifecycleRoot,
        "inbox",
        "TASK-20260610-029-PM-to-DEV.md",
        {
          protocol: "fcop",
          version: 1,
          kind: "task",
          sender: "PM",
          recipient: "DEV",
          state: "dispatched",
        } as Parameters<typeof taskMarkdown>[0],
      );
      const gov = governor(lifecycleRoot);
      await gov.restoreToInboxAfterDispatchFailure(
        taskPath,
        "session_failed",
      );
      const raw = await readFile(taskPath, "utf-8");
      assert.match(raw, /^state: inbox/m);
      assert.doesNotMatch(raw, /^state: dispatched/m);
    });
  });

  it("EVAL/OBSERVATION reports do not trigger submit_review", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      await writeTaskAt(
        lifecycleRoot,
        "active",
        "TASK-20260530-004-ADMIN-to-PM.md",
        {
          protocol: "fcop",
          version: 1,
          kind: "task",
          sender: "ADMIN",
          recipient: "PM",
          to: "PM",
          driver: "PM",
        },
      );

      const resolver = reportResolver(lifecycleRoot, rootDir);
      const evalReport = await writeReportAt(
        lifecycleRoot,
        "REPORT-20260530-004-EVAL-to-PM.md",
        {
          sender: "EVAL",
          recipient: "PM",
          task_id: "TASK-20260530-004-ADMIN-to-PM",
        },
      );
      await resolver.resolve(evalReport);

      const obsReport = await writeReportAt(
        lifecycleRoot,
        "OBSERVATION-20260530-001-EVAL.md",
        {
          sender: "EVAL",
          recipient: "PM",
          task_id: "TASK-20260530-004-ADMIN-to-PM",
        },
      );
      await resolver.resolve(obsReport);

      const reviewPath = join(
        lifecycleRoot,
        "review",
        "TASK-20260530-004-ADMIN-to-PM.md",
      );
      await assert.rejects(() => readFile(reviewPath, "utf-8"));
    });
  });
});
