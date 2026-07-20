import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { EvidenceSummary } from "../ReviewEvidenceResolver.ts";
import {
  detectReportClaims,
  evaluateReviewFactGate,
  isAckOnlyReportBody,
} from "../ReviewFactGate.ts";

function emptyEvidence(overrides?: Partial<EvidenceSummary>): EvidenceSummary {
  return {
    task_id: "TASK-20260607-001",
    report_id: "REPORT-20260607-001-DEV-to-PM",
    agent_id: "",
    session: { found: false, session_id: undefined },
    files: { read: [], changed: [] },
    commands: [],
    data_queries: [],
    report: { found: false },
    warnings: [],
    ...overrides,
  };
}

describe("ReviewFactGate", () => {
  it("detectReportClaims finds test-passed wording", () => {
    const claims = detectReportClaims("单元测试全部通过，无阻塞项。");
    assert.equal(claims.claimsTestPassed, true);
    assert.equal(claims.claimsTestRun, true);
  });

  it("evaluateReviewFactGate passes when body has no detectable claims", () => {
    const result = evaluateReviewFactGate(emptyEvidence(), "# Report\n");
    assert.equal(result.verdict, "pass");
    assert.equal(result.reason_code, "no_claims_detected");
  });

  it("evaluateReviewFactGate fails when test passed claimed without command evidence", () => {
    const result = evaluateReviewFactGate(
      emptyEvidence(),
      "单元测试全部通过。",
    );
    assert.equal(result.verdict, "fail");
    assert.equal(result.reason_code, "missing_test_evidence");
    assert.ok(result.unsupported_claims.length > 0);
  });

  it("evaluateReviewFactGate passes when command.run backs test-passed claim", () => {
    const evidence = emptyEvidence({
      commands: [{ command: "npm test", exit_code: 0 }],
    });
    const result = evaluateReviewFactGate(evidence, "单元测试全部通过。");
    assert.equal(result.verdict, "pass");
  });

  it("evaluateReviewFactGate needs_admin when session_id expected but missing in log", () => {
    const result = evaluateReviewFactGate(
      emptyEvidence(),
      "单元测试全部通过。",
      { session_id: "sess-missing" },
    );
    assert.equal(result.verdict, "needs_admin");
    assert.equal(result.reason_code, "session_evidence_gap");
  });

  it("isAckOnlyReportBody detects ack-only phrasing", () => {
    assert.equal(isAckOnlyReportBody("已收到任务，正在分析。"), true);
    assert.equal(
      isAckOnlyReportBody(
        "已收到任务，正在分析并准备进行 Google PM 最小闭环冒烟测试。",
      ),
      true,
    );
    assert.equal(isAckOnlyReportBody("Acknowledged — received task."), true);
    assert.equal(
      isAckOnlyReportBody(
        "已收到任务。fcop_check 通过，交付清单见 ## 证据 节。",
      ),
      false,
    );
  });

  it("evaluateReviewFactGate fails ack-only done report", () => {
    const result = evaluateReviewFactGate(
      emptyEvidence(),
      "已收到任务，正在分析，准备执行。",
      { report_status: "done" },
    );
    assert.equal(result.verdict, "fail");
    assert.equal(result.reason_code, "ack_only_done_report");
  });

  it("evaluateReviewFactGate passes substantive done report", () => {
    const result = evaluateReviewFactGate(
      emptyEvidence({ commands: [{ command: "npm test", exit_code: 0 }] }),
      "fcop_check 通过，单元测试全部通过，交付完成。",
      { report_status: "done" },
    );
    assert.equal(result.verdict, "pass");
  });

  it("detectReportClaims ignores Action Evidence log-type heading data.query 摘要", () => {
    const body = [
      "**data.query 摘要**（原始输出见 `.codeflowmu/ops-check/inspection_summary.json`）：",
      "- `ledger_task_count=6`, `disk_task_count=6`",
      "| bucket | count |",
      "|--------|-------|",
      "| active | 2 |",
    ].join("\n");
    const claims = detectReportClaims(body);
    assert.equal(claims.claimsDataQuery, false);
    assert.equal(claims.claimsMarkdownTable, true);
  });

  it("evaluateReviewFactGate passes OPS-style patrol report with data.query 摘要 and command.run", () => {
    const body = [
      "## 执行结果",
      "**data.query 摘要**（原始输出见 inspection_summary.json）：",
      "- ledger 与磁盘 6/6 一致",
      "| bucket | *.md count |",
      "|--------|------------|",
      "| active | 2 |",
      "| done | 1 |",
    ].join("\n");
    const result = evaluateReviewFactGate(
      emptyEvidence({
        commands: [
          { command: "fcop_check(lang=zh)", exit_code: 0 },
          { command: "python run_inspection.py", exit_code: 0 },
        ],
      }),
      body,
    );
    assert.equal(result.verdict, "pass");
    assert.equal(result.reason_code, "evidence_verified");
    assert.equal(result.claims.claimsDataQuery, false);
  });

  it("evaluateReviewFactGate still fails substantive data.query claim without evidence", () => {
    const result = evaluateReviewFactGate(
      emptyEvidence({ commands: [{ command: "fcop_check", exit_code: 0 }] }),
      "已记录 data.query 动作，查询完成共 4 条。",
    );
    assert.equal(result.verdict, "fail");
    assert.equal(result.reason_code, "missing_data_evidence");
    assert.equal(result.claims.claimsDataQuery, true);
  });

  it("evaluateReviewFactGate passes patrol table when command.run backs stats", () => {
    const body = [
      "| bucket | count |",
      "|--------|-------|",
      "| active | 2 |",
      "ledger 与磁盘 bucket 4/4 一致。",
    ].join("\n");
    const result = evaluateReviewFactGate(
      emptyEvidence({
        commands: [{ command: "fcop_check(lang=zh)", exit_code: 0 }],
        files: { read: ["fcop/ledger/tasks.jsonl"], changed: [] },
      }),
      body,
    );
    assert.equal(result.verdict, "pass");
    assert.equal(result.reason_code, "evidence_verified");
    assert.equal(result.claims.claimsMarkdownTable, true);
    assert.equal(result.claims.claimsDataQuery, false);
  });

  it("evaluateReviewFactGate treats table-only QA acceptance as presentation, not stats evidence", () => {
    const body = [
      "| item | result | evidence |",
      "|------|--------|----------|",
      "| index.html | pass | path exists |",
    ].join("\n");
    const result = evaluateReviewFactGate(emptyEvidence(), body);
    assert.equal(result.verdict, "pass");
    assert.equal(result.reason_code, "no_claims_detected");
    assert.equal(result.claims.claimsMarkdownTable, true);
  });

  it("evaluateReviewFactGate fails explicit SQL claim without data.query", () => {
    const result = evaluateReviewFactGate(
      emptyEvidence({ commands: [{ command: "fcop_check", exit_code: 0 }] }),
      "执行 SELECT count(*) 共 4 条记录。",
    );
    assert.equal(result.verdict, "fail");
    assert.equal(result.reason_code, "missing_data_evidence");
  });

  it("evaluateReviewFactGate fails SQL claim with data.query but no row_count", () => {
    const result = evaluateReviewFactGate(
      emptyEvidence({
        data_queries: [{ query_summary: "SELECT * FROM tasks" }],
      }),
      "row_count 校验通过。",
    );
    assert.equal(result.verdict, "fail");
    assert.equal(result.reason_code, "missing_row_count_evidence");
  });

  it("evaluateReviewFactGate passes SQL claim with row_count evidence", () => {
    const result = evaluateReviewFactGate(
      emptyEvidence({
        data_queries: [{ query_summary: "SELECT count(*)", row_count: 4 }],
      }),
      "数据查询完成，共 4 条。",
    );
    assert.equal(result.verdict, "pass");
  });

  it("leaves semantic QA sufficiency to PM when command evidence exists", () => {
    const result = evaluateReviewFactGate(
      emptyEvidence({ commands: [{ command: "npm test", exit_code: 0 }] }),
      "All tests passed.",
      { report_status: "done", reporter_role: "QA" },
    );
    assert.equal(result.verdict, "pass");
  });

  it("does not accept jsdom as real layout evidence", () => {
    const result = evaluateReviewFactGate(
      emptyEvidence({
        commands: [{ command: "npm test", exit_code: 0 }],
        files: {
          read: [],
          changed: [
            "qa-evidence/TASK-20260712-003/test-data.json",
            "qa-evidence/TASK-20260712-003/test-cases.json",
            "qa-evidence/TASK-20260712-003/result-summary.json",
          ],
        },
      }),
      [
        "Test data: isolated fixture.",
        "User action: click export.",
        "Expected: responsive layout and download succeeds.",
        "Actual: jsdom integration test passed.",
        "Evidence: command output.",
      ].join("\n"),
      { report_status: "done", reporter_role: "QA" },
    );
    assert.equal(result.verdict, "fail");
    assert.equal(result.reason_code, "browser_evidence_required");
  });

  it("accepts a task-linked QA report with durable disk evidence after manual wake", () => {
    const result = evaluateReviewFactGate(
      emptyEvidence(),
      [
        "Test data: isolated fixture in test.db.",
        "User action: register, login, edit and restore a document.",
        "Expected: all acceptance flows complete successfully.",
        "Actual: npm test 9/9 PASS; npx playwright test 7/7 PASS.",
        "Evidence: workspace/noteflow/evidence/qa-910/qa-results.json",
        "Screenshot: workspace/noteflow/evidence/qa-910/dashboard.png",
      ].join("\n"),
      { report_status: "done", reporter_role: "QA" },
    );
    assert.equal(result.verdict, "pass");
  });

  it("does not reject durable QA evidence for missing fixed checklist wording", () => {
    const result = evaluateReviewFactGate(
      emptyEvidence(),
      [
        "npm test 9/9 PASS; npx playwright test 7/7 PASS.",
        "workspace/noteflow/evidence/qa-910/qa-results.json",
        "workspace/noteflow/evidence/qa-910/dashboard.png",
      ].join("\n"),
      { report_status: "done", reporter_role: "QA" },
    );
    assert.equal(result.verdict, "pass");
  });

  it("accepts complete QA evidence with a real browser action", () => {
    const result = evaluateReviewFactGate(
      emptyEvidence({
        commands: [{ command: "npm test", exit_code: 0 }],
        files: {
          read: [],
          changed: [
            "qa-evidence/TASK-20260712-003/test-data.json",
            "qa-evidence/TASK-20260712-003/test-cases.json",
            "qa-evidence/TASK-20260712-003/result-summary.json",
          ],
        },
        browser_actions: [{ action: "playwright.screenshot" }],
      }),
      [
        "Test data: isolated fixture.",
        "User action: click export.",
        "Expected: responsive layout and download succeeds.",
        "Actual: Playwright verified both behaviors.",
        "Evidence: screenshot and export file.",
      ].join("\n"),
      { report_status: "done", reporter_role: "QA" },
    );
    assert.equal(result.verdict, "pass");
  });

  it("accepts a traced Playwright QA report without forcing fixed evidence filenames", () => {
    const result = evaluateReviewFactGate(
      emptyEvidence({
        commands: [
          { command: "npm test 2>&1", exit_code: 0 },
          { command: "npx playwright test 2>&1", exit_code: 0 },
        ],
        files: {
          read: ["workspace/flowboard/evidence/qa-regression-907/qa-regression-results.json"],
          changed: [],
        },
      }),
      [
        "检查方法：在临时目录准备隔离环境。",
        "## 逐项验收结果（预期 / 实际）",
        "| 验收项 | 结果 | 预期 | 实际 |",
        "| 注册与登录 | PASS | 跳转项目页 | URL 变为 /projects |",
        "## 模拟用户操作（Playwright E2E）",
        "注册 → 登录 → 建项目 → 建任务 → 拖拽 → 刷新持久化。",
        "## 证据路径",
        "workspace/flowboard/evidence/qa-regression-907/qa-regression-results.json",
      ].join("\n"),
      { report_status: "done", reporter_role: "QA" },
    );
    assert.equal(result.verdict, "pass");
    assert.equal(result.reason_code, "evidence_verified");
  });

  it("accepts successful Playwright command as real browser execution evidence", () => {
    const result = evaluateReviewFactGate(
      emptyEvidence({
        commands: [{ command: "npx playwright test", exit_code: 0 }],
      }),
      [
        "测试数据：隔离 fixture。",
        "模拟用户操作：注册、登录并退出。",
        "预期：登录后进入项目页。",
        "实际：Playwright 场景通过。",
        "证据：命令输出 1 passed。",
      ].join("\n"),
      { report_status: "done", reporter_role: "QA" },
    );
    assert.equal(result.verdict, "pass");
  });
});
