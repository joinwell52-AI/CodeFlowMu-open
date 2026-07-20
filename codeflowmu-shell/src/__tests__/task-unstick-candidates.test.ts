import assert from "node:assert/strict";
import { test } from "node:test";

import { collectUnstickCandidates } from "../task-unstick-candidates.ts";

test("collectUnstickCandidates: queue receipt failed", () => {
  const rows = collectUnstickCandidates({
    queue: {
      pm_downstream_receipt_phase: "worker_receipt_failed",
      pm_downstream_receipt_task_id: "TASK-20260611-007-PM-to-DEV",
      pm_downstream_role: "DEV",
      pm_downstream_receipt_session_id: "session-1",
      pm_downstream_receipt_thread_key: "panel-task-007",
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.task_id, "TASK-20260611-007-PM-to-DEV");
  assert.equal(rows[0]!.agent_id, "DEV-01");
  assert.equal(rows[0]!.session_id, "session-1");
});

test("collectUnstickCandidates: dedupes queue and dispatch retry", () => {
  const rows = collectUnstickCandidates({
    queue: {
      pm_downstream_receipt_phase: "session_recoverable",
      pm_downstream_receipt_task_id: "TASK-1-PM-to-DEV",
      pm_downstream_role: "DEV",
    },
    dispatchRetries: [
      {
        task_id: "TASK-1-PM-to-DEV",
        role: "DEV",
        failureCount: 2,
      },
    ],
  });
  assert.equal(rows.length, 1);
});

test("collectUnstickCandidates: waiting_pm_attention task", () => {
  const rows = collectUnstickCandidates({
    tasks: [
      {
        task_id: "TASK-2-PM-to-QA",
        sender: "PM",
        recipient: "QA",
        display_status: "waiting_pm_attention",
        thread_key: "thread-2",
      },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.reason, "display_status:waiting_pm_attention");
});

test("collectUnstickCandidates: empty when no signals", () => {
  const rows = collectUnstickCandidates({
    queue: { pm_downstream_receipt_phase: "none" },
    tasks: [{ task_id: "TASK-3-PM-to-DEV", sender: "PM", recipient: "DEV" }],
  });
  assert.equal(rows.length, 0);
});
