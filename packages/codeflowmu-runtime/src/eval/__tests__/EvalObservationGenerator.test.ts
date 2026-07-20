import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { LedgerReportRecord, LedgerTaskRecord } from "../../ledger/types.ts";

import { withTempLifecycle } from "../../lifecycle/__tests__/helpers.ts";
import { parseMarkdownFrontmatter } from "../../ledger/frontmatter.ts";
import {
  buildEvalObservationAnalysisFromRows,
  maybeWriteEvalObservation,
} from "../EvalObservationGenerator.ts";
import {
  EVAL_PM_FINAL,
  seedEvalCloseoutThread,
} from "./evalThreadFixture.ts";
import {
  TASK220_MANUAL,
  TASK220_ROOT,
  seedTask220CanonicalReports,
} from "./task220CanonicalFixture.ts";
import { getAdminTaskCloseout } from "../EvalObservationGenerator.ts";

const FIXED_NOW = () => new Date("2026-06-10T12:00:00Z");

describe("EvalObservationGenerator", () => {
  it("writes OBSERVATION under fcop/internal/eval for PM-to-ADMIN summary", async () => {
    await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
      const { observationPath, pmFinalContent, pmFinalFm } =
        await seedEvalCloseoutThread(rootDir, lifecycleRoot, {
          skipObservation: true,
        });

      const written = await maybeWriteEvalObservation({
        projectRoot: rootDir,
        pmReportPath: join(rootDir, "fcop", "reports", EVAL_PM_FINAL),
        pmReportFilename: EVAL_PM_FINAL,
        pmReportContent: pmFinalContent,
        pmReportFm: pmFinalFm,
        now: FIXED_NOW,
      });

      assert.ok(written);
      const evalDir = join(rootDir, "fcop", "internal", "eval");
      const names = await readdir(evalDir);
      assert.ok(names.some((n) => n.startsWith("OBSERVATION-20260610-")));
      const raw = await readFile(written!, "utf-8");
      assert.match(raw, /INTERNAL ONLY/);
      assert.match(raw, /kind: eval-observation/);
      assert.match(raw, /source_report: REPORT-20260610-004-PM-to-ADMIN/);
    });
  });

  it("TASK-215: root REVIEW-GATE yields approve_close only, not child-chain finding", () => {
    const rootId = "TASK-20260610-215";
    const pmBody = [
      "## Summary",
      "覆盖 TASK-20260610-215",
      "子任务 TASK-20260610-035",
      "REPORT-20260610-095-OPS-to-PM",
      "REPORT-20260610-094-PM-to-ADMIN",
    ].join("\n");
    const analysis = buildEvalObservationAnalysisFromRows({
      pmReportFilename: "REPORT-20260610-096-PM-to-ADMIN.md",
      pmReportContent: `---\ntask_id: ${rootId}\nthread_key: panel-task-215\nstatus: done\n---\n${pmBody}`,
      pmReportFm: {
        task_id: rootId,
        thread_key: "panel-task-215",
        status: "done",
        sender: "PM",
        recipient: "ADMIN",
      },
      tasks: [
        {
          task_id: rootId,
          filename: "TASK-20260610-215-ADMIN-to-PM.md",
          sender: "ADMIN",
          recipient: "PM",
          thread_key: "panel-task-215",
          bucket: "review",
        },
        {
          task_id: "TASK-20260610-035",
          filename: "TASK-20260610-035-PM-to-OPS.md",
          sender: "PM",
          recipient: "OPS",
          parent: rootId,
          thread_key: "panel-task-215",
          bucket: "done",
        },
      ] as unknown as LedgerTaskRecord[],
      reports: [
        {
          report_id: "REPORT-20260610-094-PM-to-ADMIN",
          filename: "REPORT-20260610-094-PM-to-ADMIN.md",
          sender: "PM",
          recipient: "ADMIN",
          status: "in_progress",
          report_kind: "pm_to_admin_in_progress",
        },
        {
          report_id: "REPORT-20260610-095-OPS-to-PM",
          filename: "REPORT-20260610-095-OPS-to-PM.md",
          sender: "OPS",
          recipient: "PM",
          status: "done",
          report_kind: "worker_to_pm",
        },
        {
          report_id: "REPORT-20260610-096-PM-to-ADMIN",
          filename: "REPORT-20260610-096-PM-to-ADMIN.md",
          sender: "PM",
          recipient: "ADMIN",
          status: "done",
          report_kind: "pm_to_admin_final",
        },
      ] as unknown as LedgerReportRecord[],
      reviews: [
        {
          id: "REVIEW-20260610-034-REVIEW-GATE-on-TASK-20260610-215",
          reviewer: "REVIEW-GATE",
          decision: "needs_human",
          taskId: rootId,
          subjectId: rootId,
          threadKey: "panel-task-215",
          humanApprovalApprovedAt: null,
        },
      ],
      actionEvidence: [{ task_id: "TASK-20260610-035" }],
      issueCount: 0,
    });
    assert.ok(analysis);
    assert.equal(analysis!.risk_level, "low");
    assert.deepEqual(analysis!.recommended_admin_attention, ["approve_close"]);
    assert.ok(
      !analysis!.findings.some((f) => f.includes("子链路 REVIEW 需人工")),
    );
    assert.ok(
      analysis!.findings.some((f) => f.includes("主任务 ADMIN 验收待决")),
    );
    assert.equal(analysis!.evidence_gaps.length, 0);
  });

  it("TASK-220: canonical PM final is 111 when 004 auto + 109 ack coexist", async () => {
    await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
      await seedTask220CanonicalReports(rootDir, lifecycleRoot);
      const closeout = await getAdminTaskCloseout(rootDir, TASK220_ROOT, {
        ensureEval: false,
      });
      assert.ok(closeout);
      assert.equal(
        closeout!.pm_final_report?.report_id,
        "REPORT-20260610-111-PM-to-ADMIN",
      );
      assert.equal(closeout!.pm_final_report?.filename, TASK220_MANUAL);
    });
  });

  it("skips duplicate observation for same source_report", async () => {
    await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
      const { pmFinalPath, pmFinalContent, pmFinalFm } =
        await seedEvalCloseoutThread(rootDir, lifecycleRoot, {
          skipObservation: true,
        });

      const input = {
        projectRoot: rootDir,
        pmReportPath: pmFinalPath,
        pmReportFilename: EVAL_PM_FINAL,
        pmReportContent: pmFinalContent,
        pmReportFm: pmFinalFm,
        now: FIXED_NOW,
      };

      const first = await maybeWriteEvalObservation(input);
      const second = await maybeWriteEvalObservation(input);
      assert.ok(first);
      assert.equal(second, null);
    });
  });
});
