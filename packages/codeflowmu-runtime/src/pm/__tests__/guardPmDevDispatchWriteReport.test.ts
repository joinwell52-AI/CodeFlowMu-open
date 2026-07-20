import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evaluatePmDevDispatchTerminalWriteReportGate } from "../guardPmDevDispatchWriteReport.ts";
import type {
  LedgerReportRecord,
  LedgerTaskRecord,
  LedgerThreadRecord,
} from "../../ledger/types.ts";

const THREAD = "pm-dev-dispatch-guard";
const ROOT = "TASK-20260610-001-ADMIN-to-PM";
const OPS = "TASK-20260610-002-PM-to-OPS";

function mkThread(overrides?: Partial<LedgerThreadRecord>): LedgerThreadRecord {
  return {
    thread_key: THREAD,
    root_task_id: ROOT,
    task_ids: [ROOT, OPS],
    report_ids: [],
    pending_pm_review: [],
    ...overrides,
  };
}

function mkTask(overrides: Partial<LedgerTaskRecord>): LedgerTaskRecord {
  return {
    task_id: ROOT,
    filename: `${ROOT}.md`,
    sender: "ADMIN",
    recipient: "PM",
    bucket: "active",
    path: "",
    created_at: "2026-06-10T10:00:00+08:00",
    updated_at: "2026-06-10T10:00:00+08:00",
    timezone: "Asia/Shanghai",
    created_at_utc: "2026-06-10T02:00:00Z",
    thread_key: THREAD,
    ...overrides,
  };
}

function mkReport(overrides: Partial<LedgerReportRecord>): LedgerReportRecord {
  return {
    report_id: "REPORT-20260610-003-OPS-to-PM",
    task_id: OPS,
    filename: "REPORT-20260610-003-OPS-to-PM.md",
    sender: "OPS",
    recipient: "PM",
    status: "done",
    path: "",
    created_at: "2026-06-10T11:00:00+08:00",
    updated_at: "2026-06-10T11:00:00+08:00",
    timezone: "Asia/Shanghai",
    created_at_utc: "2026-06-10T03:00:00Z",
    thread_key: THREAD,
    parent_task_id: OPS,
    report_kind: "worker_to_pm",
    references: [OPS],
    ...overrides,
  };
}

function happyPath(): {
  thread: LedgerThreadRecord;
  tasks: LedgerTaskRecord[];
  reports: LedgerReportRecord[];
} {
  return {
    thread: mkThread(),
    tasks: [
      mkTask({}),
      mkTask({
        task_id: OPS,
        filename: `${OPS}.md`,
        sender: "PM",
        recipient: "OPS",
        parent: ROOT,
        bucket: "done",
      }),
    ],
    reports: [mkReport({})],
  };
}

describe("evaluatePmDevDispatchTerminalWriteReportGate", () => {
  it("allows non-terminal PM-to-ADMIN status", () => {
    const { thread, tasks, reports } = happyPath();
    const result = evaluatePmDevDispatchTerminalWriteReportGate({
      reporter: "PM",
      recipient: "ADMIN",
      status: "in_progress",
      thread,
      tasks,
      reports,
    });
    assert.deepEqual(result, { allowed: true });
  });

  it("allows non-PM-to-ADMIN write_report", () => {
    const { thread, tasks, reports } = happyPath();
    const result = evaluatePmDevDispatchTerminalWriteReportGate({
      reporter: "DEV",
      recipient: "PM",
      status: "done",
      thread,
      tasks,
      reports,
    });
    assert.deepEqual(result, { allowed: true });
  });

  it("blocks terminal summary when downstream child not settled", () => {
    const { thread, tasks, reports } = happyPath();
    tasks[1] = { ...tasks[1]!, bucket: "active" };
    const result = evaluatePmDevDispatchTerminalWriteReportGate({
      reporter: "PM",
      recipient: "ADMIN",
      status: "done",
      thread,
      tasks,
      reports,
      root_task_id: ROOT,
    });
    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.equal(result.code, "CLOSE_GATE_FAILED");
      assert.equal(result.skipped_reason, "close_gate_failed");
      assert.match(result.findings?.join("\n") ?? "", /^child_tasks_not_settled:/);
    }
  });

  it("blocks duplicate PM-to-ADMIN final report", () => {
    const { thread, tasks, reports } = happyPath();
    reports.push(
      mkReport({
        report_id: "REPORT-20260610-005-PM-to-ADMIN",
        filename: "REPORT-20260610-005-PM-to-ADMIN.md",
        sender: "PM",
        recipient: "ADMIN",
        status: "done",
        task_id: ROOT,
        parent_task_id: ROOT,
        report_kind: "pm_to_admin_final",
        references: [ROOT, OPS],
      }),
    );
    const result = evaluatePmDevDispatchTerminalWriteReportGate({
      reporter: "PM",
      recipient: "ADMIN",
      status: "done",
      thread,
      tasks,
      reports,
      root_task_id: ROOT,
    });
    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.equal(result.code, "PM_ADMIN_FINAL_ALREADY_EXISTS");
      assert.equal(result.skipped_reason, "pm_admin_final_already_exists");
    }
  });

  it("allows terminal summary when gate passes", () => {
    const { thread, tasks, reports } = happyPath();
    const result = evaluatePmDevDispatchTerminalWriteReportGate({
      reporter: "PM",
      recipient: "ADMIN",
      status: "blocked",
      thread,
      tasks,
      reports,
      root_task_id: ROOT,
    });
    assert.deepEqual(result, { allowed: true });
  });
});
