import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildReportIssueDoc,
  extractEvidenceLinesFromReportBody,
  extractSummaryFromReportBody,
  inferReportIssueReason,
} from "../reportIssueTemplate.ts";

describe("reportIssueTemplate", () => {
  it("extractSummaryFromReportBody prefers 结论 section", () => {
    const body = [
      "## 背景",
      "",
      "noise",
      "",
      "## 结论",
      "",
      "这是结论段落。",
      "",
      "## 其他",
      "",
      "later",
    ].join("\n");
    assert.equal(extractSummaryFromReportBody(body), "这是结论段落。");
  });

  it("extractEvidenceLinesFromReportBody caps at 5 keyword hits", () => {
    const body = [
      "- blocked on step 1",
      "- QA failed review",
      "- missing DEV sign-off",
      "- EVAL incomplete",
      "- OPS cannot deploy",
      "- request_rework needed",
      "- extra line should not appear",
    ].join("\n");
    const lines = extractEvidenceLinesFromReportBody(body);
    assert.equal(lines.length, 5);
    assert.ok(lines.some((l) => l.includes("blocked")));
  });

  it("inferReportIssueReason maps status to reason", () => {
    assert.equal(inferReportIssueReason({ status: "blocked" }), "blocked_report");
    assert.equal(inferReportIssueReason({ status: "failed" }), "failed_report");
    assert.equal(inferReportIssueReason({ status: "done" }), "report_escalation");
  });

  it("buildReportIssueDoc includes required frontmatter and sections", () => {
    const { frontmatter, bodyMarkdown } = buildReportIssueDoc({
      issueId: "ISSUE-20260605-001-REPORT-action",
      reportId: "REPORT-20260605-001-PM-blocked",
      reportFilePath: "/tmp/REPORT-20260605-001-PM-blocked.md",
      reportRaw: [
        "---",
        "status: blocked",
        "thread_key: tk-1",
        "---",
        "",
        "## 结论",
        "",
        "blocked 摘要。",
        "",
        "- QA 不建议 approve",
      ].join("\n"),
      reportFm: {
        status: "blocked",
        thread_key: "tk-1",
      },
      taskId: "TASK-20260605-001-ADMIN-to-PM",
      sender: "PM",
      createdAt: new Date("2026-06-05T12:00:00.000Z"),
    });
    assert.equal(frontmatter.type, "ISSUE");
    assert.equal(frontmatter.source_report, "REPORT-20260605-001-PM-blocked");
    assert.equal(frontmatter.source_task, "TASK-20260605-001-ADMIN-to-PM");
    assert.equal(frontmatter.thread_key, "tk-1");
    assert.equal(frontmatter.reason, "blocked_report");
    assert.match(bodyMarkdown, /## 问题摘要/);
    assert.match(bodyMarkdown, /blocked 摘要/);
    assert.match(bodyMarkdown, /## 建议动作/);
    assert.match(bodyMarkdown, /request_rework/);
  });
});
