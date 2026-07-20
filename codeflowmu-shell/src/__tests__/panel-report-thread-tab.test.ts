/**
 * Report thread grouping + archive tab (TASK-20260611-013).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ledgerThreadForReport } from "../panel-report-aggregation.ts";
import {
  allReportsDone,
  legacyReportGroupMatchesArchiveTab,
  mergeThreadChainReports,
  shouldShowReportThreadInActiveTab,
} from "../panel-report-workflow-chain.ts";

const ledger221 = {
  thread_key: "panel-task-221",
  root_task_id: "TASK-20260610-221",
  task_ids: ["TASK-20260610-221"],
  report_ids: ["REPORT-20260611-002-PM-to-ADMIN"],
};

const report002 = {
  filename: "REPORT-20260611-002-PM-to-ADMIN.md",
  task_id: "TASK-20260610-221",
  status: "done",
  sender: "PM",
  recipient: "ADMIN",
};

const report003 = {
  filename: "REPORT-20260611-003-PM-to-ADMIN.md",
  task_id: "TASK-20260610-221",
  linked_task_ids: ["TASK-20260610-221"],
  references: "TASK-20260610-221",
  status: "done",
  sender: "PM",
  recipient: "ADMIN",
};

test("REPORT-003 maps to panel-task-221 via references/root (not legacy)", () => {
  const row = ledgerThreadForReport(report003, [ledger221]);
  assert.equal(row?.thread_key, "panel-task-221");
});

test("mergeThreadChainReports includes 003 when report_ids only lists 002", () => {
  const pool = [report002, report003];
  const merged = mergeThreadChainReports(
    ledger221,
    [report003],
    pool,
    ["TASK-20260610-221"],
  );
  assert.equal(merged.length, 2);
  assert.ok(merged.some((r) => r.filename?.includes("003")));
  assert.ok(merged.some((r) => r.filename?.includes("002")));
});

test("221 thread hidden on active tab when all reports done and no pool members", () => {
  assert.equal(allReportsDone([report002, report003]), true);
  assert.equal(
    shouldShowReportThreadInActiveTab({
      ledgerRow: ledger221,
      visibleReports: [report002, report003],
      membersInPool: [],
      isDetached: false,
      isRootSealed: false,
      hasOpenMembers: false,
    }),
    false,
  );
});

test("221 thread visible on archive tab via legacy group when all done", () => {
  assert.equal(
    legacyReportGroupMatchesArchiveTab(
      "archive",
      { fallbackId: "TASK-20260610-221", reports: [report003] },
      { rootTaskSettled: false, ledgerHasOpenMembers: false },
    ),
    true,
  );
});

test("221 legacy group hidden on active tab when all reports done", () => {
  assert.equal(
    legacyReportGroupMatchesArchiveTab(
      "active",
      { fallbackId: "TASK-20260610-221", reports: [report003] },
      { ledgerHasOpenMembers: false },
    ),
    false,
  );
});
