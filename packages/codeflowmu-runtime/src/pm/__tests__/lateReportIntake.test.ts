import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  taskMarkdown,
  withTempLifecycle,
  writeTaskAt,
} from "../../lifecycle/__tests__/helpers.ts";
import { ensureLedgerLayout } from "../../ledger/paths.ts";
import {
  appendLateReportIntake,
  evaluateLateReportIntake,
  lateReportIntakePath,
  LATE_REPORT_INTAKE_ACTION,
  LATE_REPORT_INTAKE_REASON,
  tryApplyLateReportIntake,
} from "../lateReportIntake.ts";
import type { LedgerTaskRecord } from "../../ledger/types.ts";

async function writeReportAt(
  lifecycleRoot: string,
  filename: string,
  fm: Record<string, string>,
): Promise<string> {
  const dir = join(lifecycleRoot, "..", "reports");
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  const path = join(dir, filename);
  await writeFile(
    path,
    taskMarkdown(
      {
        protocol: "fcop",
        version: 1,
        kind: "report",
        ...fm,
      } as Parameters<typeof taskMarkdown>[0],
      "# Report\n",
    ),
    "utf-8",
  );
  return path;
}

function archivedTask(taskId: string): LedgerTaskRecord {
  return {
    task_id: taskId,
    filename: `${taskId}.md`,
    sender: "PM",
    recipient: "DEV",
    bucket: "archive",
    path: `fcop/_lifecycle/archive/${taskId}.md`,
    created_at: "2026-06-10T10:00:00+08:00",
    updated_at: "2026-06-10T12:00:00+08:00",
    timezone: "Asia/Shanghai",
    created_at_utc: "2026-06-10T02:00:00.000Z",
    thread_key: "panel-task-209",
    display_status: "archived",
  };
}

describe("lateReportIntake", () => {
  it("evaluateLateReportIntake returns noted_only when linked task is archived", () => {
    const taskId = "TASK-20260610-027-PM-to-DEV";
    const tasks = [archivedTask(taskId)];
    const eval_ = evaluateLateReportIntake(tasks, taskId, {
      thread_key: "panel-task-209",
    });
    assert.ok(eval_);
    assert.equal(eval_!.action, LATE_REPORT_INTAKE_ACTION);
    assert.equal(eval_!.reason, LATE_REPORT_INTAKE_REASON);
    assert.equal(eval_!.thread_status, "archived");
    assert.equal(eval_!.related_task_id, taskId);
  });

  it("appendLateReportIntake is idempotent per report_id", async () => {
    await withTempLifecycle(async ({ rootDir }) => {
      await ensureLedgerLayout(rootDir);
      const record = {
        kind: "late_report_intake" as const,
        at: "2026-06-10T12:00:00.000Z",
        report_id: "REPORT-20260610-074-DEV-to-PM",
        related_task_id: "TASK-20260610-027-PM-to-DEV",
        thread_status: "archived" as const,
        action: LATE_REPORT_INTAKE_ACTION as "noted_only",
        reason: LATE_REPORT_INTAKE_REASON as "closed_thread_supplemental_report",
        risk_assessment: "none" as const,
      };
      const first = await appendLateReportIntake(rootDir, record);
      const second = await appendLateReportIntake(rootDir, record);
      assert.equal(first.appended, true);
      assert.equal(second.appended, false);
      const raw = await readFile(lateReportIntakePath(rootDir), "utf-8");
      assert.equal(raw.trim().split("\n").length, 1);
    });
  });

  it("tryApplyLateReportIntake writes JSONL for worker report on archived thread", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      await ensureLedgerLayout(rootDir);
      const taskId = "TASK-20260610-027-PM-to-DEV";
      await writeTaskAt(lifecycleRoot, "archive", `${taskId}.md`, {
        protocol: "fcop",
        version: 1,
        kind: "task",
        sender: "PM",
        recipient: "DEV",
        to: "DEV",
        thread_key: "panel-task-209",
        display_status: "archived",
      });
      const reportPath = await writeReportAt(
        lifecycleRoot,
        "REPORT-20260610-099-DEV-to-PM.md",
        {
          sender: "DEV",
          recipient: "PM",
          status: "done",
          task_id: taskId,
          thread_key: "panel-task-209",
        },
      );

      const record = await tryApplyLateReportIntake({
        projectRoot: rootDir,
        reportId: "REPORT-20260610-099-DEV-to-PM",
        reportFilePath: reportPath,
        filename: "REPORT-20260610-099-DEV-to-PM.md",
        taskId,
        reportFm: {
          sender: "DEV",
          recipient: "PM",
          status: "done",
          task_id: taskId,
          thread_key: "panel-task-209",
        },
        sender: "DEV",
        recipient: "PM",
      });
      assert.ok(record);
      assert.equal(record!.action, LATE_REPORT_INTAKE_ACTION);
      const raw = await readFile(lateReportIntakePath(rootDir), "utf-8");
      assert.match(raw, /REPORT-20260610-099-DEV-to-PM/);
    });
  });
});
