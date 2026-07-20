import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { taskMarkdown } from "../../lifecycle/__tests__/helpers.ts";
import type { TaskFm } from "../../lifecycle/types.ts";
import { PanelEventBridge } from "../../panel/PanelEventBridge.ts";
import { ReportGate } from "../ReportGate.ts";

async function withTempProject(
  fn: (ctx: { root: string; reportsDir: string }) => Promise<void>,
): Promise<void> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "report-gate-"));
  const reportsDir = join(root, "fcop", "reports");
  await mkdir(reportsDir, { recursive: true });
  try {
    await fn({ root, reportsDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("ReportGate", () => {
  it("detects existing REPORT referencing task_id", async () => {
    await withTempProject(async ({ root, reportsDir }) => {
      const taskId = "TASK-20260531-001-PM-to-OPS";
      await writeFile(
        join(reportsDir, "REPORT-20260531-001-OPS-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "OPS",
            recipient: "PM",
            task_id: taskId,
          },
          "# Done\n",
        ),
        "utf-8",
      );

      const gate = new ReportGate({
        projectRoot: root,
        fcopReportsDir: reportsDir,
        autoWrite: false,
      });

      assert.equal(
        await gate.hasMatchingReport(taskId, "OPS", "PM"),
        true,
      );
    });
  });

  it("ensureReciprocalReport skips when REPORT already present", async () => {
    await withTempProject(async ({ root, reportsDir }) => {
      const taskId = "TASK-20260531-002-PM-to-DEV";
      await writeFile(
        join(reportsDir, "REPORT-20260531-002-DEV-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "DEV",
            recipient: "PM",
            task_id: taskId,
          },
          "# OK\n",
        ),
        "utf-8",
      );

      const gate = new ReportGate({
        projectRoot: root,
        fcopReportsDir: reportsDir,
        autoWrite: false,
      });

      await gate.ensureReciprocalReport({
        taskId,
        reporter: "DEV",
        reportRecipient: "PM",
        settlementKind: "session_ended",
      });

      const entries = await import("node:fs/promises").then((fs) =>
        fs.readdir(reportsDir),
      );
      assert.equal(entries.length, 1);
    });
  });

  it("ensureReciprocalReport no-ops write when autoWrite=false and no report", async () => {
    await withTempProject(async ({ root, reportsDir }) => {
      const gate = new ReportGate({
        projectRoot: root,
        fcopReportsDir: reportsDir,
        autoWrite: false,
        settleDelayMs: 0,
      });

      await gate.ensureReciprocalReport({
        taskId: "TASK-20260531-003-PM-to-QA",
        reporter: "QA",
        reportRecipient: "PM",
        settlementKind: "session_cancelled",
        settlementNote: "reason=test_cancel",
      });

      const entries = await import("node:fs/promises").then((fs) =>
        fs.readdir(reportsDir),
      );
      assert.equal(entries.length, 0);
    });
  });

  it("skips blocked when done report appears after settle delay", async () => {
    await withTempProject(async ({ root, reportsDir }) => {
      const taskId = "TASK-20260531-004-PM-to-OPS";
      const gate = new ReportGate({
        projectRoot: root,
        fcopReportsDir: reportsDir,
        autoWrite: false,
        settleDelayMs: 80,
      });

      setTimeout(async () => {
        await writeFile(
          join(reportsDir, "REPORT-20260531-004-OPS-to-PM.md"),
          taskMarkdown(
            {
              protocol: "fcop",
              version: 1,
              kind: "report",
              sender: "OPS",
              recipient: "PM",
              task_id: taskId,
              status: "done",
            } as TaskFm & { status: string },
            "# Done after settle\n",
          ),
          "utf-8",
        );
        const builder = new (await import("../../ledger/LedgerBuilder.ts"))
          .LedgerBuilder({ projectRoot: root });
        await builder.rebuild();
      }, 20);

      await gate.ensureReciprocalReport({
        taskId,
        reporter: "OPS",
        reportRecipient: "PM",
        settlementKind: "session_ended",
      });

      const entries = await import("node:fs/promises").then((fs) =>
        fs.readdir(reportsDir),
      );
      assert.equal(entries.length, 1);
      assert.match(entries[0] ?? "", /^REPORT-/);
    });
  });

  it("defaults autoWrite to false (no compensating REPORT on disk)", async () => {
    await withTempProject(async ({ root, reportsDir }) => {
      const gate = new ReportGate({
        projectRoot: root,
        fcopReportsDir: reportsDir,
        settleDelayMs: 0,
      });

      await gate.ensureReciprocalReport({
        taskId: "TASK-20260606-001-PM-to-DEV",
        reporter: "DEV",
        reportRecipient: "PM",
        settlementKind: "session_ended",
        settlementNote: "status=failed",
      });

      const entries = await import("node:fs/promises").then((fs) =>
        fs.readdir(reportsDir),
      );
      assert.equal(entries.length, 0);
    });
  });

  it("ensureReciprocalReport emits waiting_report once within TTL", async () => {
    await withTempProject(async ({ root, reportsDir }) => {
      const bridge = new PanelEventBridge();
      const events: Array<{ type: string; payload: Record<string, unknown> }> =
        [];
      bridge.setSink((type, payload) => {
        events.push({ type, payload });
      });

      const gate = new ReportGate({
        projectRoot: root,
        fcopReportsDir: reportsDir,
        autoWrite: false,
        settleDelayMs: 0,
        panelEvents: bridge,
      });

      const input = {
        taskId: "TASK-20260531-005-PM-to-DEV",
        reporter: "DEV",
        reportRecipient: "PM",
        settlementKind: "session_ended" as const,
      };

      await gate.ensureReciprocalReport(input);
      await gate.ensureReciprocalReport(input);

      const waiting = events.filter(
        (e) => e.type === "codeflowmu.report_gate.waiting_report",
      );
      assert.equal(
        waiting.length,
        1,
        "TTL should suppress duplicate waiting_report within 60s",
      );
    });
  });
});
