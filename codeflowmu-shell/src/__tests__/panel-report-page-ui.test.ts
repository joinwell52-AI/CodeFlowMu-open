/**
 * Report page intake toggle + unlinked group hints (TASK-20260611-011).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  countRpIntakeToggleSteps,
  isLedgerThreadDetachedForPool,
  ledgerThreadLabelForTaskId,
  reportGroupFallbackHint,
  RP_INTAKE_TOGGLE_MAX_ROWS,
  toggleRpIntakeRowDisplay,
} from "../panel-report-page-ui.ts";

test("toggleRpIntakeRowDisplay toggles none/table-row", () => {
  assert.equal(toggleRpIntakeRowDisplay("none"), "table-row");
  assert.equal(toggleRpIntakeRowDisplay("table-row"), "none");
});

test("intake toggle: 91 rows completes in 91 steps with correct advance", () => {
  assert.equal(countRpIntakeToggleSteps(91), 91);
  assert.ok(countRpIntakeToggleSteps(91) < 100);
});

test("intake toggle: buggy loop hits safety max (infinite loop guard)", () => {
  assert.equal(
    countRpIntakeToggleSteps(91, { buggyAdvance: true }),
    RP_INTAKE_TOGGLE_MAX_ROWS,
  );
});

test("ledger thread with root_task_id is not detached when task file absent from pool", () => {
  const row = {
    thread_key: "panel-task-221",
    root_task_id: "TASK-20260610-221",
    task_ids: ["TASK-20260610-221"],
    report_ids: ["REPORT-20260611-003-PM-to-ADMIN"],
  };
  assert.equal(isLedgerThreadDetachedForPool(row, 0), false);
});

test("ledgerThreadLabelForTaskId resolves panel-task-221 for TASK-221", () => {
  const rows = [
    {
      thread_key: "panel-task-221",
      root_task_id: "TASK-20260610-221",
      task_ids: ["TASK-20260610-221"],
    },
  ];
  assert.equal(
    ledgerThreadLabelForTaskId("TASK-20260610-221", rows),
    "panel-task-221",
  );
});

test("reportGroupFallbackHint explains missing task file with ledger thread", () => {
  const rows = [
    {
      thread_key: "panel-task-221",
      root_task_id: "TASK-20260610-221",
    },
  ];
  const hint = reportGroupFallbackHint("TASK-20260610-221", rows);
  assert.match(hint.title, /不在当前 panel 加载池/);
  assert.match(hint.subtitle, /panel-task-221/);
});
