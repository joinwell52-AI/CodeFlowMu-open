import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  classifyIssueCause,
  enrichIssueMetadata,
  inferIssueReporter,
} from "../issue-enrichment.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function projectWithReports(rows: Record<string, unknown>[]): string {
  const root = mkdtempSync(join(tmpdir(), "cf-issue-enrichment-"));
  roots.push(root);
  const ledger = join(root, "fcop", "ledger");
  mkdirSync(ledger, { recursive: true });
  writeFileSync(join(ledger, "reports.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n"), "utf-8");
  return root;
}

test("reporter priority uses explicit reporter, source report, then body source report", () => {
  assert.equal(inferIssueReporter({ reporter: "PM", source_report: "REPORT-20260614-012-QA-to-PM.md" }, ""), "PM");
  assert.equal(inferIssueReporter({ source_report: "REPORT-20260614-012-QA-to-PM.md" }, ""), "QA");
  assert.equal(inferIssueReporter({}, "Source report: REPORT-20260614-009-DEV-to-PM.md"), "DEV");
  assert.equal(inferIssueReporter({}, "no source"), "?");
});

test("classifies premature execution and dependency pending separately", () => {
  const premature = "QA blocked：DEV TASK-20260614-005 与 OPS TASK-20260614-006 尚无 write_report，前置未满足。";
  const dependency = "OPS blocked：前置未满足，DEV TASK-20260614-005 尚无 write_report，未 done。";
  assert.equal(classifyIssueCause("QA", {}, premature), "premature_execution");
  assert.equal(classifyIssueCause("OPS", {}, dependency), "dependency_pending");
});

test("business validation failure is high while active", () => {
  const root = projectWithReports([{ report_id: "REPORT-20260614-012-QA-to-PM", task_id: "TASK-20260614-007", sender: "QA", status: "blocked", created_at: "2026-06-14T11:21:57+08:00" }]);
  const result = enrichIssueMetadata(root, { source_report: "REPORT-20260614-012-QA-to-PM.md", severity: "medium" }, "试玩 9/10 PASS，第 4 关磁铁 FAIL。");
  assert.equal(result.reporter, "QA");
  assert.equal(result.analysis.cause_type, "business_validation_fail");
  assert.equal(result.severity, "high");
  assert.equal(result.severity_level, "P1");
  assert.equal(result.effective_status, "active");
});

test("later done report for the same task marks an issue covered", () => {
  const root = projectWithReports([
    { report_id: "REPORT-20260614-012-QA-to-PM", task_id: "TASK-20260614-007", sender: "QA", status: "blocked", created_at: "2026-06-14T11:21:57+08:00" },
    { report_id: "REPORT-20260614-015-QA-to-PM", task_id: "TASK-20260614-007", sender: "QA", status: "done", created_at: "2026-06-14T12:07:22+08:00" },
  ]);
  const result = enrichIssueMetadata(root, { source_report: "REPORT-20260614-012-QA-to-PM.md" }, "试玩 9/10 PASS，第 4 关磁铁 FAIL。");
  assert.equal(result.analysis.cause_type, "business_validation_fail");
  assert.equal(result.effective_status, "resolved");
  assert.equal(result.severity, "medium");
  assert.match(result.analysis.recommended_action, /结案/);
});

test("issue detail UI renders structured analysis", () => {
  const html = readFileSync(join(process.cwd(), "..", "codeflowmu-desktop", "panel", "index.html"), "utf-8");
  assert.match(html, /## 分析判断/);
  assert.match(html, /a\.cause_type/);
  assert.match(html, /severity_level/);
});
