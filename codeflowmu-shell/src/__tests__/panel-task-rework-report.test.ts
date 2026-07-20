/**
 * ADMIN 打回返工后「查看报告」配对与 API 字段透传（TASK-20260611-010）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getLatestSubmitReviewReportId,
  hasReportForTaskPanel,
  isReworkResubmitUnblocked,
  normalizeReportFileKey,
  resolvePreferredReworkReport,
  type ReportLike,
  type TaskReworkLike,
} from "../panel-task-rework-report.ts";

const TASK014: TaskReworkLike = {
  filename: "TASK-20260611-014-ADMIN-to-PM.md",
  display_status: "ready_for_review",
  review_status: "pending",
  reopened_count: 1,
  reopen_reason: "需要补证据",
  rework_completed_by_report: "REPORT-20260611-022-PM-to-ADMIN",
  transitions: [
    { at: "2026-06-11T08:00:00Z", action: "reject_review", report: "REPORT-20260611-020-PM-to-ADMIN" },
    { at: "2026-06-11T10:00:00Z", action: "submit_review", report: "REPORT-20260611-022-PM-to-ADMIN" },
  ],
};

const REPORT020: ReportLike = {
  filename: "REPORT-20260611-020-PM-to-ADMIN.md",
  status: "done",
  created_at: "2026-06-11T07:30:00Z",
  task_id: "TASK-20260611-014",
};

const REPORT022: ReportLike = {
  filename: "REPORT-20260611-022-PM-to-ADMIN.md",
  status: "done",
  created_at: "2026-06-11T10:30:00Z",
  task_id: "TASK-20260611-014",
};

test("rework: isReworkResubmitUnblocked when ready_for_review + rework_completed_by_report", () => {
  assert.equal(isReworkResubmitUnblocked(TASK014), true);
});

test("rework: getLatestSubmitReviewReportId picks 022 not 020", () => {
  assert.equal(
    getLatestSubmitReviewReportId(TASK014),
    "REPORT-20260611-022-PM-to-ADMIN",
  );
});

test("rework: resolvePreferredReworkReport prefers rework_completed_by_report 022", () => {
  const hit = resolvePreferredReworkReport(TASK014, [REPORT020, REPORT022]);
  assert.equal(hit?.filename, "REPORT-20260611-022-PM-to-ADMIN.md");
});

test("rework: hasReportForTaskPanel true for pending review + 022 (not stale 020)", () => {
  const preferred = resolvePreferredReworkReport(TASK014, [REPORT020, REPORT022]);
  assert.ok(preferred);
  assert.equal(hasReportForTaskPanel(TASK014, preferred), true);
  assert.equal(
    normalizeReportFileKey(preferred!.filename ?? ""),
    "REPORT-20260611-022-PM-to-ADMIN",
  );
});

test("rework: hasReportForTaskPanel false when only pre-reject PM report paired", () => {
  const taskBeforeSubmit: TaskReworkLike = {
    ...TASK014,
    display_status: "admin_rejected",
    review_status: "rejected",
    rework_completed_by_report: undefined,
    transitions: [
      { at: "2026-06-11T08:00:00Z", action: "reject_review" },
    ],
  };
  assert.equal(hasReportForTaskPanel(taskBeforeSubmit, REPORT020), false);
});
