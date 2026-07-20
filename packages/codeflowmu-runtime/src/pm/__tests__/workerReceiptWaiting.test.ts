import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { LedgerReportRecord, LedgerTaskRecord } from "../../ledger/types.ts";
import {
  evaluateWorkerReceiptWaiting,
  MAX_DOWNSTREAM_AUTO_NUDGES,
} from "../workerReceiptWaiting.ts";

const QA_TASK_ID = "TASK-20260609-010-PM-to-QA";
const THREAD = "panel-task-013";

function taskRow(
  partial: Partial<LedgerTaskRecord> &
    Pick<LedgerTaskRecord, "task_id" | "sender" | "recipient">,
): LedgerTaskRecord {
  const filename = partial.filename ?? `${partial.task_id}.md`;
  const nowIso = "2026-06-09T10:00:00+08:00";
  return {
    filename,
    bucket: "active",
    path: `fcop/_lifecycle/active/${filename}`,
    created_at: nowIso,
    updated_at: nowIso,
    timezone: "Asia/Shanghai",
    created_at_utc: "2026-06-09T02:00:00.000Z",
    thread_key: THREAD,
    ...partial,
  };
}

function reportRow(
  partial: Partial<LedgerReportRecord> &
    Pick<LedgerReportRecord, "filename" | "sender" | "recipient">,
): LedgerReportRecord {
  return {
    report_id: partial.report_id ?? partial.filename.replace(/\.md$/i, ""),
    task_id: QA_TASK_ID,
    status: "done",
    path: "",
    created_at: "",
    updated_at: "",
    timezone: "UTC",
    created_at_utc: "",
    ...partial,
  };
}

describe("evaluateWorkerReceiptWaiting", () => {
  it("shows waiting_qa_receipt when QA active without report", () => {
    const tasks = [
      taskRow({ task_id: QA_TASK_ID, sender: "PM", recipient: "QA" }),
    ];
    const ev = evaluateWorkerReceiptWaiting({
      tasks,
      reports: [],
      targetRole: "QA",
      focusTaskId: QA_TASK_ID,
    });
    assert.equal(ev.phase, "waiting_qa_receipt");
    assert.equal(ev.shouldShowWaiting, true);
    assert.equal(ev.shouldClearGuard, false);
  });

  it("clears waiting when QA report done exists", () => {
    const tasks = [
      taskRow({ task_id: QA_TASK_ID, sender: "PM", recipient: "QA" }),
    ];
    const reports = [
      reportRow({
        filename: "REPORT-20260609-010-QA-to-PM.md",
        sender: "QA",
        recipient: "PM",
        status: "done",
        references: [QA_TASK_ID],
      }),
    ];
    const ev = evaluateWorkerReceiptWaiting({
      tasks,
      reports,
      targetRole: "QA",
      focusTaskId: QA_TASK_ID,
    });
    assert.equal(ev.phase, "cleared");
    assert.equal(ev.shouldShowWaiting, false);
    assert.equal(ev.shouldClearGuard, true);
  });

  it("still waiting when QA task is in review bucket", () => {
    const tasks = [
      taskRow({
        task_id: QA_TASK_ID,
        sender: "PM",
        recipient: "QA",
        bucket: "review",
        path: `fcop/_lifecycle/review/${QA_TASK_ID}.md`,
      }),
    ];
    const ev = evaluateWorkerReceiptWaiting({
      tasks,
      reports: [],
      targetRole: "QA",
      focusTaskId: QA_TASK_ID,
    });
    assert.equal(ev.phase, "waiting_qa_receipt");
    assert.equal(ev.shouldShowWaiting, true);
  });

  it("shows worker_receipt_failed after session_failed mark", () => {
    const tasks = [
      taskRow({ task_id: QA_TASK_ID, sender: "PM", recipient: "QA" }),
    ];
    const ev = evaluateWorkerReceiptWaiting({
      tasks,
      reports: [],
      targetRole: "QA",
      focusTaskId: QA_TASK_ID,
      workerFailed: true,
    });
    assert.equal(ev.phase, "worker_receipt_failed");
    assert.equal(ev.shouldShowWaiting, false);
    assert.equal(ev.shouldClearGuard, true);
    assert.match(ev.reason, /worker_failed/);
  });

  it("shows worker_receipt_failed when max nudges exceeded", () => {
    const tasks = [
      taskRow({ task_id: QA_TASK_ID, sender: "PM", recipient: "QA" }),
    ];
    const ev = evaluateWorkerReceiptWaiting({
      tasks,
      reports: [],
      targetRole: "QA",
      focusTaskId: QA_TASK_ID,
      nudgeCount: MAX_DOWNSTREAM_AUTO_NUDGES,
    });
    assert.equal(ev.phase, "worker_receipt_failed");
    assert.equal(ev.reason, "max_nudges_exceeded");
  });

  it("routes a formal QA blocked report to PM without runtime failure recovery", () => {
    const tasks = [
      taskRow({ task_id: QA_TASK_ID, sender: "PM", recipient: "QA" }),
    ];
    const reports = [
      reportRow({
        filename: "REPORT-20260609-010-QA-to-PM.md",
        sender: "QA",
        recipient: "PM",
        status: "blocked",
        references: [QA_TASK_ID],
      }),
    ];
    const ev = evaluateWorkerReceiptWaiting({
      tasks,
      reports,
      targetRole: "QA",
      focusTaskId: QA_TASK_ID,
    });
    assert.equal(ev.phase, "worker_report_needs_pm");
    assert.equal(ev.queueState, "none");
    assert.equal(ev.reason, "worker_report_blocked");
  });

  it("clears on admin_override display_status", () => {
    const tasks = [
      taskRow({
        task_id: QA_TASK_ID,
        sender: "PM",
        recipient: "QA",
        display_status: "admin_override",
      }),
    ];
    const ev = evaluateWorkerReceiptWaiting({
      tasks,
      reports: [],
      targetRole: "QA",
      focusTaskId: QA_TASK_ID,
    });
    assert.equal(ev.phase, "cleared");
    assert.match(ev.reason, /display_status/);
  });

  it("shows worker_receipt_failed on waiting_pm_attention display_status", () => {
    const tasks = [
      taskRow({
        task_id: QA_TASK_ID,
        sender: "PM",
        recipient: "QA",
        display_status: "waiting_pm_attention",
      }),
    ];
    const ev = evaluateWorkerReceiptWaiting({
      tasks,
      reports: [],
      targetRole: "QA",
      focusTaskId: QA_TASK_ID,
    });
    assert.equal(ev.phase, "worker_receipt_failed");
    assert.match(ev.reason, /waiting_pm_attention/);
  });

  it("clears waiting when ledger bucket active but path is archive", () => {
    const tasks = [
      taskRow({
        task_id: QA_TASK_ID,
        sender: "PM",
        recipient: "QA",
        bucket: "active",
        path: `fcop/_lifecycle/archive/${QA_TASK_ID}.md`,
      }),
    ];
    const ev = evaluateWorkerReceiptWaiting({
      tasks,
      reports: [],
      targetRole: "QA",
      focusTaskId: QA_TASK_ID,
    });
    assert.equal(ev.phase, "cleared");
    assert.match(ev.reason, /bucket:archive/);
  });

  it("clears waiting when ADMIN root is archived", () => {
    const rootId = "TASK-20260609-013-ADMIN-to-PM";
    const tasks = [
      taskRow({
        task_id: rootId,
        sender: "ADMIN",
        recipient: "PM",
        filename: `${rootId}.md`,
        bucket: "active",
        path: `fcop/_lifecycle/archive/${rootId}.md`,
      }),
      taskRow({
        task_id: QA_TASK_ID,
        sender: "PM",
        recipient: "QA",
        parent: rootId,
        bucket: "active",
        path: `fcop/_lifecycle/active/${QA_TASK_ID}.md`,
      }),
    ];
    const ev = evaluateWorkerReceiptWaiting({
      tasks,
      reports: [],
      targetRole: "QA",
      focusTaskId: QA_TASK_ID,
    });
    assert.equal(ev.phase, "cleared");
    assert.equal(ev.reason, "admin_root_archived");
  });

  it("clears stale failed when newer QA report is done (latest receipt wins)", () => {
    const tasks = [
      taskRow({ task_id: QA_TASK_ID, sender: "PM", recipient: "QA" }),
    ];
    const reports = [
      reportRow({
        filename: "REPORT-20260609-010-QA-to-PM.md",
        sender: "QA",
        recipient: "PM",
        status: "blocked",
        references: [QA_TASK_ID],
      }),
      reportRow({
        filename: "REPORT-20260609-011-QA-to-PM.md",
        sender: "QA",
        recipient: "PM",
        status: "done",
        references: [QA_TASK_ID],
      }),
    ];
    const ev = evaluateWorkerReceiptWaiting({
      tasks,
      reports,
      targetRole: "QA",
      focusTaskId: QA_TASK_ID,
    });
    assert.equal(ev.phase, "cleared");
    assert.equal(ev.reason, "worker_report_done");
    assert.match(String(ev.receiptReportId ?? ""), /011/);
  });

  it("clears failed hint when admin root is done awaiting ADMIN", () => {
    const rootId = "TASK-20260609-013-ADMIN-to-PM";
    const tasks = [
      taskRow({
        task_id: rootId,
        sender: "ADMIN",
        recipient: "PM",
        filename: `${rootId}.md`,
        bucket: "done",
        path: `fcop/_lifecycle/done/${rootId}.md`,
      }),
      taskRow({
        task_id: QA_TASK_ID,
        sender: "PM",
        recipient: "QA",
        parent: rootId,
      }),
    ];
    const ev = evaluateWorkerReceiptWaiting({
      tasks,
      reports: [],
      targetRole: "QA",
      focusTaskId: QA_TASK_ID,
      workerFailed: true,
    });
    assert.equal(ev.phase, "cleared");
    assert.equal(ev.reason, "admin_root_awaiting_admin");
  });

  it("clears when PM-to-ADMIN final summary done exists", () => {
    const rootId = "TASK-20260609-013-ADMIN-to-PM";
    const tasks = [
      taskRow({
        task_id: rootId,
        sender: "ADMIN",
        recipient: "PM",
        filename: `${rootId}.md`,
        thread_key: THREAD,
      }),
      taskRow({
        task_id: QA_TASK_ID,
        sender: "PM",
        recipient: "QA",
        parent: rootId,
        thread_key: THREAD,
      }),
    ];
    const reports = [
      reportRow({
        filename: "REPORT-20260609-013-PM-to-ADMIN.md",
        sender: "PM",
        recipient: "ADMIN",
        status: "done",
        task_id: rootId,
        references: [rootId],
        final: true,
      }),
      reportRow({
        filename: "REPORT-20260609-010-QA-to-PM.md",
        sender: "QA",
        recipient: "PM",
        status: "blocked",
        references: [QA_TASK_ID],
      }),
    ];
    const ev = evaluateWorkerReceiptWaiting({
      tasks,
      reports,
      targetRole: "QA",
      focusTaskId: QA_TASK_ID,
      workerFailed: true,
    });
    assert.equal(ev.phase, "cleared");
    assert.equal(ev.reason, "pm_summary_done");
  });

  it("regression: failed → done → pm summary → archived clears queue state", () => {
    const rootId = "TASK-20260609-013-ADMIN-to-PM";
    const tasksArchived = [
      taskRow({
        task_id: rootId,
        sender: "ADMIN",
        recipient: "PM",
        filename: `${rootId}.md`,
        bucket: "active",
        path: `fcop/_lifecycle/archive/${rootId}.md`,
        thread_key: THREAD,
      }),
      taskRow({
        task_id: QA_TASK_ID,
        sender: "PM",
        recipient: "QA",
        parent: rootId,
        bucket: "active",
        path: `fcop/_lifecycle/archive/${QA_TASK_ID}.md`,
        thread_key: THREAD,
      }),
    ];
    const reports = [
      reportRow({
        filename: "REPORT-20260609-010a-QA-to-PM.md",
        sender: "QA",
        recipient: "PM",
        status: "blocked",
        references: [QA_TASK_ID],
      }),
      reportRow({
        filename: "REPORT-20260609-010b-QA-to-PM.md",
        sender: "QA",
        recipient: "PM",
        status: "done",
        references: [QA_TASK_ID],
      }),
      reportRow({
        filename: "REPORT-20260609-013-PM-to-ADMIN.md",
        sender: "PM",
        recipient: "ADMIN",
        status: "done",
        task_id: rootId,
        references: [rootId],
        final: true,
      }),
    ];
    const ev = evaluateWorkerReceiptWaiting({
      tasks: tasksArchived,
      reports,
      targetRole: "QA",
      focusTaskId: QA_TASK_ID,
      workerFailed: true,
    });
    assert.equal(ev.phase, "cleared");
    assert.equal(ev.shouldShowWaiting, false);
  });

  it("shows session_recoverable when session unsettled without report", () => {
    const tasks = [
      taskRow({ task_id: QA_TASK_ID, sender: "PM", recipient: "QA" }),
    ];
    const ev = evaluateWorkerReceiptWaiting({
      tasks,
      reports: [],
      targetRole: "QA",
      focusTaskId: QA_TASK_ID,
      sessionUnsettled: true,
      recoverable: true,
      lastSessionId: "session-6",
    });
    assert.equal(ev.phase, "session_recoverable");
    assert.equal(ev.queueState, "recoverable");
    assert.equal(ev.shouldShowWaiting, true);
    assert.notEqual(ev.phase, "worker_receipt_failed");
  });

  it("does not mark failed for TURN_LIMIT recoverable session", () => {
    const tasks = [
      taskRow({ task_id: QA_TASK_ID, sender: "PM", recipient: "QA" }),
    ];
    const ev = evaluateWorkerReceiptWaiting({
      tasks,
      reports: [],
      targetRole: "QA",
      focusTaskId: QA_TASK_ID,
      sessionFailed: true,
      lastFailureCode: "TURN_LIMIT",
      lastSessionStatus: "failed",
    });
    assert.equal(ev.phase, "session_recoverable");
    assert.equal(ev.queueState, "recoverable");
  });

  it("shows session_running when agent is active", () => {
    const tasks = [
      taskRow({ task_id: QA_TASK_ID, sender: "PM", recipient: "QA" }),
    ];
    const ev = evaluateWorkerReceiptWaiting({
      tasks,
      reports: [],
      targetRole: "QA",
      focusTaskId: QA_TASK_ID,
      agentRunning: true,
      lastSessionId: "session-7",
    });
    assert.equal(ev.phase, "session_running");
    assert.equal(ev.queueState, "running");
    assert.equal(ev.shouldShowWaiting, false);
  });

  it("keeps a terminal worker report out of the receipt failure queue", () => {
    const tasks = [
      taskRow({ task_id: QA_TASK_ID, sender: "PM", recipient: "QA" }),
    ];
    const reports = [
      reportRow({
        filename: "REPORT-fail-QA-to-PM.md",
        sender: "QA",
        recipient: "PM",
        status: "blocked",
        references: [QA_TASK_ID],
      }),
    ];
    const ev = evaluateWorkerReceiptWaiting({
      tasks,
      reports,
      targetRole: "QA",
      focusTaskId: QA_TASK_ID,
    });
    assert.equal(ev.phase, "worker_report_needs_pm");
    assert.equal(ev.queueState, "none");
  });

  it("shows session_recoverable for first_turn_abort ERROR instead of worker_receipt_failed", () => {
    const devTaskId = "TASK-20260611-003";
    const tasks = [
      taskRow({
        task_id: devTaskId,
        sender: "PM",
        recipient: "DEV",
        filename: `${devTaskId}-PM-to-DEV.md`,
      }),
    ];
    const ev = evaluateWorkerReceiptWaiting({
      tasks,
      reports: [],
      targetRole: "DEV",
      focusTaskId: devTaskId,
      sessionFailed: true,
      workerFailed: true,
      lastFailureCode: "ERROR",
      lastFailureCategory: "cursor_sdk_first_turn_abort",
      isFirstTurnAbort: true,
      lastSessionStatus: "failed",
    });
    assert.equal(ev.phase, "session_recoverable");
    assert.equal(ev.queueState, "recoverable");
    assert.notEqual(ev.phase, "worker_receipt_failed");
  });
});
