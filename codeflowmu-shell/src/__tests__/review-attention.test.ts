import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildReviewAttentionIndex,
  enrichTasksWithReviewAttention,
  resolveReviewAttentionForTask,
} from "../review-attention.ts";

function seedCycle(root: string, lines: object[]): void {
  const dir = join(root, ".codeflowmu", "pm-governance");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "cycle.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf-8",
  );
}

describe("review-attention", () => {
  test("buildReviewAttentionIndex prefers latest report_arrival cycle", () => {
    const root = mkdtempSync(join(tmpdir(), "cf-review-attn-"));
    seedCycle(root, [
      {
        triggered_by: "pm_wake",
        judgments: [
          {
            skill_id: "pm.review_check",
            task_id: "TASK-20260612-030",
            outcome: "failed",
            payload: {
              review: {
                ok: false,
                report_id: "REPORT-old",
                findings: [{ code: "old_code", severity: "error", message: "旧原因" }],
              },
            },
          },
        ],
      },
      {
        triggered_by: "report_arrival",
        decisions: [
          {
            task_id: "TASK-20260612-030",
            detected_state: "waiting_pm_attention",
            reason: "事实核查未通过：缺少 file.edit 证据",
            outcome: "failed",
          },
        ],
        judgments: [
          {
            skill_id: "pm.review_check",
            task_id: "TASK-20260612-030",
            outcome: "failed",
            payload: {
              review: {
                ok: false,
                report_id: "REPORT-20260612-043-DEV-to-PM",
                findings: [
                  {
                    code: "fact_check_needs_human",
                    severity: "error",
                    message: "REPORT 声称改了文件，但 usage 动作日志里缺少 file.read / file.edit 证据",
                  },
                ],
              },
            },
          },
        ],
      },
    ]);

    const index = buildReviewAttentionIndex(root);
    const entry = index.get("TASK-20260612-030");
    assert.ok(entry);
    assert.equal(entry!.source, "cycle.jsonl");
    assert.equal(entry!.report_id, "REPORT-20260612-043-DEV-to-PM");
    assert.match(entry!.reason, /file\.edit/);
    assert.equal(entry!.findings.length, 1);
    assert.equal(entry!.findings[0]!.code, "fact_check_needs_human");
  });

  test("resolveReviewAttentionForTask falls back to pm_attention_reason", () => {
    const root = mkdtempSync(join(tmpdir(), "cf-review-attn-"));
    const index = buildReviewAttentionIndex(root);
    const task = {
      task_id: "TASK-20260611-099",
      display_status: "waiting_pm_attention",
      pm_attention_reason: "PM 自动审查未通过，需 PM 人工处理",
      scope: "review",
    };
    const resolved = resolveReviewAttentionForTask(task, index);
    assert.ok(resolved);
    assert.equal(resolved!.source, "task_frontmatter");
    assert.equal(resolved!.reason, "PM 自动审查未通过，需 PM 人工处理");
    assert.deepEqual(resolved!.findings, []);
  });

  test("enrichTasksWithReviewAttention attaches field only when needed", () => {
    const root = mkdtempSync(join(tmpdir(), "cf-review-attn-"));
    seedCycle(root, [
      {
        triggered_by: "report_arrival",
        judgments: [
          {
            skill_id: "pm.review_check",
            task_id: "TASK-20260612-030",
            outcome: "failed",
            payload: {
              review: {
                findings: [
                  { code: "fact_check_needs_human", severity: "error", message: "缺证据" },
                ],
              },
            },
          },
        ],
      },
    ]);

    const rows = enrichTasksWithReviewAttention(root, [
      {
        task_id: "TASK-20260612-030",
        display_status: "waiting_pm_attention",
        scope: "review",
      },
      {
        task_id: "TASK-20260612-099",
        display_status: "ready_for_review",
        scope: "active",
      },
    ]);

    assert.ok(rows[0]!.review_attention);
    assert.equal((rows[0]!.review_attention as { findings: unknown[] }).findings.length, 1);
    assert.equal(rows[1]!.review_attention, undefined);
  });

  test("clears stale report_missing attention after ledger links the terminal report", () => {
    const root = mkdtempSync(join(tmpdir(), "cf-review-attn-"));
    seedCycle(root, [
      {
        triggered_by: "report_arrival",
        judgments: [
          {
            skill_id: "pm.review_check",
            task_id: "TASK-20260712-908",
            outcome: "failed",
            payload: {
              review: {
                report_id: null,
                findings: [
                  {
                    code: "report_missing",
                    severity: "error",
                    message: "无 REPORT 关联 task_id TASK-20260712-908",
                  },
                ],
              },
            },
          },
        ],
      },
    ]);
    const ledgerDir = join(root, "fcop", "ledger");
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(
      join(ledgerDir, "reports.jsonl"),
      `${JSON.stringify({
        report_id: "REPORT-20260712-032-QA-to-PM",
        task_id: "TASK-20260712-908",
        source_task_id: "TASK-20260712-908",
        status: "done",
      })}\n`,
      "utf-8",
    );

    const rows = enrichTasksWithReviewAttention(root, [
      {
        task_id: "TASK-20260712-908",
        display_status: "waiting_pm_review",
        scope: "active",
        pm_attention_reason: "PM 自动审查未通过，需 PM 人工处理",
      },
    ]);

    assert.equal(rows[0]!.review_attention, undefined);
    assert.equal(rows[0]!.pm_attention_reason, undefined);
  });

  test("resolveReviewAttentionForTask ignores stale pm_attention when settled approved", () => {
    const root = mkdtempSync(join(tmpdir(), "cf-review-attn-"));
    const index = buildReviewAttentionIndex(root);
    const settled = {
      task_id: "TASK-20260618-001-PM-to-QA",
      display_status: "human_review_approved",
      review_status: "approved",
      scope: "done",
      bucket: "done",
      pm_attention_reason: "事实核查未通过：缺少 file.edit 证据",
    };
    assert.equal(resolveReviewAttentionForTask(settled, index), undefined);
  });

  test("resolveReviewAttentionForTask does not project historical cycle findings as current status", () => {
    const root = mkdtempSync(join(tmpdir(), "cf-review-attn-"));
    seedCycle(root, [
      {
        triggered_by: "report_arrival",
        judgments: [
          {
            skill_id: "pm.review_check",
            task_id: "TASK-20260618-001-PM-to-QA",
            outcome: "failed",
            payload: {
              review: {
                findings: [
                  {
                    code: "fact_check_needs_human",
                    severity: "error",
                    message: "REPORT 缺少 file.edit 证据",
                  },
                ],
              },
            },
          },
        ],
      },
    ]);
    const index = buildReviewAttentionIndex(root);
    const settled = {
      task_id: "TASK-20260618-001-PM-to-QA",
      display_status: "human_review_approved",
      review_status: "approved",
      scope: "done",
      bucket: "done",
    };
    assert.equal(resolveReviewAttentionForTask(settled, index), undefined);
  });

  test("resolveReviewAttentionForTask ignores old cycle failure after task marker is cleared", () => {
    const root = mkdtempSync(join(tmpdir(), "cf-review-attn-"));
    seedCycle(root, [
      {
        triggered_by: "pm_wake",
        judgments: [
          {
            skill_id: "pm.review_check",
            task_id: "TASK-20260713-011",
            outcome: "failed",
            payload: {
              review: {
                findings: [
                  { code: "report_missing", severity: "error", message: "missing" },
                ],
              },
            },
          },
        ],
      },
    ]);
    const index = buildReviewAttentionIndex(root);
    assert.equal(
      resolveReviewAttentionForTask(
        { task_id: "TASK-20260713-011", scope: "inbox" },
        index,
      ),
      undefined,
    );
  });

  test("resolveReviewAttentionForTask hides empty cycle note for settled approved task", () => {
    const root = mkdtempSync(join(tmpdir(), "cf-review-attn-"));
    seedCycle(root, [
      {
        triggered_by: "report_arrival",
        decisions: [
          {
            task_id: "TASK-20260618-009-PM-to-DEV",
            detected_state: "active_stalled_done_report",
            reason: "done report(s): REPORT-20260618-009-DEV-to-PM",
            outcome: "blocked",
          },
        ],
      },
    ]);
    const index = buildReviewAttentionIndex(root);
    const settled = {
      task_id: "TASK-20260618-009-PM-to-DEV",
      display_status: "done",
      review_status: "approved",
      scope: "done",
      bucket: "done",
    };

    assert.equal(resolveReviewAttentionForTask(settled, index), undefined);
  });

  test("enrichTasksWithReviewAttention does not treat settled approved as open attention", () => {
    const root = mkdtempSync(join(tmpdir(), "cf-review-attn-"));
    seedCycle(root, [
      {
        triggered_by: "report_arrival",
        judgments: [
          {
            skill_id: "pm.review_check",
            task_id: "TASK-20260618-002-ADMIN-to-PM",
            outcome: "failed",
            payload: {
              review: {
                findings: [
                  { code: "report_pending", severity: "error", message: "等待 PM 汇总" },
                ],
              },
            },
          },
        ],
      },
    ]);

    const rows = enrichTasksWithReviewAttention(root, [
      {
        task_id: "TASK-20260618-002-ADMIN-to-PM",
        display_status: "human_review_approved",
        review_status: "approved",
        scope: "archive",
        bucket: "archive",
        pm_attention_reason: "report_pending",
      },
    ]);

    const row = rows[0]!;
    assert.equal(row.display_status, "human_review_approved");
    assert.equal(row.review_status, "approved");
    // Historical cycle findings may remain for detail; not synthesized from stale frontmatter.
    if (row.review_attention) {
      assert.equal(
        (row.review_attention as { source: string }).source,
        "cycle.jsonl",
      );
    }
  });
});
