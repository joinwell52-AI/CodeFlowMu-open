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

test("force archived parent makes an open issue historical", () => {
  const root = projectWithReports([
    {
      report_id: "REPORT-20260614-020-OPS-to-PM",
      task_id: "TASK-20260614-020",
      sender: "OPS",
      status: "blocked",
    },
  ]);
  writeFileSync(
    join(root, "fcop", "ledger", "tasks.jsonl"),
    JSON.stringify({
      task_id: "TASK-20260614-020",
      bucket: "archive",
      yaml: { archive_mode: "force" },
    }),
    "utf-8",
  );
  const result = enrichIssueMetadata(
    root,
    { source_report: "REPORT-20260614-020-OPS-to-PM.md" },
    "dependency pending",
  );
  assert.equal(result.effective_status, "historical");
  assert.equal(result.parent_task_state, "archive");
  assert.equal(result.inactive_reason, "parent_force_archived");
});

test("separates report trigger from a project algorithm regression root cause", () => {
  const root = projectWithReports([]);
  const result = enrichIssueMetadata(
    root,
    { reason: "failed_report", summary: "WP09 住址 exact 回退 0/8" },
    "## 问题摘要\n\nlive expansion 门禁未通过，住址 exact 相对 ROI=off 基线无增益。\n\n## 证据\n\nQA 对比结果为 0/8 FAIL。\n\n## 建议动作\n\n固定样本与基线后重新验证。",
  );
  assert.equal(result.analysis.trigger_type, "failed_report");
  assert.equal(result.analysis.cause_type, "product_algorithm_regression");
  assert.equal(result.analysis.ownership_scope, "project_product");
  assert.equal(result.analysis.public_eligibility, "local_only");
  assert.match(result.analysis.public_reason, /产品、算法或数据问题/);
});

test("classifies REVIEW-GATE file evidence false positive as a public product candidate", () => {
  const root = projectWithReports([]);
  const result = enrichIssueMetadata(
    root,
    { summary: "误闸返工需要撤销" },
    "## 背景\n\n自动 REVIEW-GATE 判定 missing_data_evidence，要求补造 data.query。\n\n## 真实事实\n\nQA 使用本地 JSON 文件读取与脚本评测，未声称数据库或 SQL；不应补造 data.query。\n\n## 影响\n\n误闸会生成无意义返工并阻塞 approve。\n\n## 仍需 Runtime\n\n修复证据类型判断并增加回归测试。",
  );
  assert.equal(result.analysis.cause_type, "evidence_gate_false_positive");
  assert.equal(result.analysis.ownership_scope, "codeflowmu_product");
  assert.equal(result.analysis.public_eligibility, "candidate");
  assert.match(result.analysis.suggested_title, /REVIEW-GATE/);
});

test("blocks public promotion when an issue contains real-name and full-address evidence", () => {
  const root = projectWithReports([]);
  const result = enrichIssueMetadata(
    root,
    { summary: "生僻字 OCR 未吐字" },
    "## 现象\n\n人审真值：呙生建。正确住址为资阳市安岳县周礼镇海棠村7组47号。\n\n## 处置\n\n脱敏后保留最小复现样本。",
  );
  assert.equal(result.analysis.privacy_risk, "high");
  assert.equal(result.analysis.public_eligibility, "blocked_sensitive");
});

test("structured closed state wins over missing later report and body-only closure is flagged", () => {
  const root = projectWithReports([]);
  const closed = enrichIssueMetadata(root, { status: "closed" }, "## 现象\n\n存在明确问题。" );
  assert.equal(closed.effective_status, "resolved");
  const stale = enrichIssueMetadata(root, { status: "open" }, "## 状态更新\n\nstatus -> closed");
  assert.equal(stale.effective_status, "active");
  assert.equal(stale.analysis.state_consistency, "body_status_conflict");
});

test("issue detail UI renders structured analysis", () => {
  const html = readFileSync(join(process.cwd(), "..", "codeflowmu-desktop", "panel", "index.html"), "utf-8");
  assert.match(html, /## 分析判断/);
  assert.match(html, /a\.cause_type/);
  assert.match(html, /a\.public_eligibility/);
  assert.match(html, /a\.quality_score/);
  assert.match(html, /这不是质量验收失败/);
  assert.doesNotMatch(html, /预分类未通过/);
  assert.match(html, /severity_level/);
});

test("issue page exposes row operations and an aggregate mother-evidence submission page", () => {
  const html = readFileSync(join(process.cwd(), "..", "codeflowmu-desktop", "panel", "index.html"), "utf-8");
  assert.match(html, /id="is-promotion-summary-btn"/);
  assert.match(html, /id="is-promotion-tbody"/);
  assert.match(html, /data-issue-action="close"/);
  assert.match(html, /data-issue-action="promote"/);
  assert.match(html, /downloadIssuePromotion/);
  assert.match(html, /\/api\/v2\/issues\/promotions/);
});
