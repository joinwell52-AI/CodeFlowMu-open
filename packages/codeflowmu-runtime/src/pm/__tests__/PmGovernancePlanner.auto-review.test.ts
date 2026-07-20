import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { taskMarkdown } from "../../lifecycle/__tests__/helpers.ts";
import { LedgerBuilder } from "../../ledger/LedgerBuilder.ts";
import { resolveLedgerLayout } from "../../ledger/paths.ts";
import { findTaskPathById } from "../../lifecycle/taskPathUtils.ts";
import { isReportId, isTaskId } from "../PmGovernanceActions.ts";
import { runPmGovernanceCycle } from "../PmGovernancePlanner.ts";
import { tryAutoSubmitReviewForActiveChild } from "../pmAutoSubmitReview.ts";

async function withTempProject(
  fn: (ctx: { root: string }) => Promise<void>,
): Promise<void> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "pm-auto-review-"));
  try {
    await fn({ root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const THREAD = "bus-closure-auto-review";

describe("PmGovernancePlanner auto-review", () => {
  it("isReportId / isTaskId distinguish pending_pm_review entities", () => {
    assert.equal(isReportId("REPORT-20260608-003-OPS-to-PM"), true);
    assert.equal(isTaskId("TASK-20260608-002-PM-to-OPS"), true);
    assert.equal(isReportId("TASK-20260608-002-PM-to-OPS"), false);
  });

  it("pending_pm_review REPORT id passes report_id to review_check", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const viewsDir = join(layout.ledgerDir, "views");
      const reportsDir = layout.reportsDir;
      const reviewDir = join(layout.lifecycleRoot, "review");
      await mkdir(viewsDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });
      await mkdir(reviewDir, { recursive: true });

      const opsTask = "TASK-20260608-002-PM-to-OPS";
      const reportId = "REPORT-20260608-003-OPS-to-PM";

      await writeFile(
        join(reviewDir, `${opsTask}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "OPS",
            task_id: opsTask,
            thread_key: THREAD,
            parent: "TASK-20260608-001-ADMIN-to-PM",
          },
          "# OPS\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, `${reportId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "OPS",
            recipient: "PM",
            task_id: opsTask,
            thread_key: THREAD,
            status: "done",
            references: [opsTask],
          },
          "## 结论\nOPS 完成\n\n## 证据\n- ok\n",
        ),
        "utf-8",
      );

      await new LedgerBuilder({ projectRoot: root }).rebuild();

      await writeFile(
        join(layout.ledgerDir, "threads.jsonl"),
        `${JSON.stringify({
          thread_key: THREAD,
          root_task_id: "TASK-20260608-001-ADMIN-to-PM",
          task_ids: [opsTask, "TASK-20260608-001-ADMIN-to-PM"],
          report_ids: [reportId],
          pending_pm_review: [reportId],
        })}\n`,
        "utf-8",
      );

      await writeFile(
        join(viewsDir, "PM.todo.md"),
        `# PM todo\n\n- pending_pm_review: \`${reportId}\` (${THREAD})\n`,
        "utf-8",
      );

      const cycle = await runPmGovernanceCycle(root, {
        triggered_by: "report_arrival",
        allow_auto_wake: false,
        auto_review: true,
        max_threads: 2,
        max_judgments: 3,
      });

      const review = cycle.judgments.find((j) => j.skill_id === "pm.review_check");
      assert.ok(review, "expected pm.review_check judgment");
      assert.equal(review!.report_id, reportId);
      assert.equal(review!.task_id, null);
    });
  });

  it("patrol without explicit auto_review still writes PM-to-ADMIN summary", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const activeDir = join(layout.lifecycleRoot, "active");
      const doneDir = join(layout.lifecycleRoot, "done");
      const reportsDir = layout.reportsDir;
      await mkdir(activeDir, { recursive: true });
      await mkdir(doneDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });

      const rootId = "TASK-20260608-001-ADMIN-to-PM";
      const childId = "TASK-20260608-002-PM-to-OPS";
      const workerReportId = "REPORT-20260608-003-OPS-to-PM";

      await writeFile(
        join(activeDir, `${rootId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: rootId,
            thread_key: THREAD,
          },
          "# Main\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(doneDir, `${childId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "OPS",
            task_id: childId,
            thread_key: THREAD,
            parent: rootId,
          },
          "# OPS child\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, `${workerReportId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "OPS",
            recipient: "PM",
            task_id: childId,
            thread_key: THREAD,
            status: "done",
            references: [childId],
          },
          "## 结论\nOPS 完成\n\n## 证据\n- ok\n",
        ),
        "utf-8",
      );

      await new LedgerBuilder({ projectRoot: root }).rebuild();

      const cycle = await runPmGovernanceCycle(root, {
        triggered_by: "patrol",
        allow_auto_wake: false,
        max_threads: 3,
        max_judgments: 5,
      });

      const close = cycle.judgments.find((j) => j.skill_id === "pm.close_admin_task");
      assert.ok(close, "expected pm.close_admin_task judgment");
      assert.equal(close!.outcome, "ok");
      assert.match(close!.summary ?? "", /PM-to-ADMIN/);

      const reportFiles = await readdir(reportsDir);
      assert.ok(
        reportFiles.some((f) =>
          /^REPORT-\d{8}-\d{3,}-PM-to-ADMIN(-[a-z][a-z0-9-]*)?\.md$/i.test(f),
        ),
      );
    });
  });

  it("auto_review + settled children writes PM-to-ADMIN done summary report", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const activeDir = join(layout.lifecycleRoot, "active");
      const doneDir = join(layout.lifecycleRoot, "done");
      const reportsDir = layout.reportsDir;
      await mkdir(activeDir, { recursive: true });
      await mkdir(doneDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });

      const rootId = "TASK-20260608-001-ADMIN-to-PM";
      const childId = "TASK-20260608-002-PM-to-OPS";
      const workerReportId = "REPORT-20260608-003-OPS-to-PM";

      await writeFile(
        join(activeDir, `${rootId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: rootId,
            thread_key: THREAD,
          },
          "# Main\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(doneDir, `${childId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "OPS",
            task_id: childId,
            thread_key: THREAD,
            parent: rootId,
          },
          "# OPS child\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, `${workerReportId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "OPS",
            recipient: "PM",
            task_id: childId,
            thread_key: THREAD,
            status: "done",
            references: [childId],
          },
          "## 结论\nOPS 完成\n\n## 证据\n- ok\n",
        ),
        "utf-8",
      );

      await new LedgerBuilder({ projectRoot: root }).rebuild();

      await writeFile(
        join(layout.ledgerDir, "threads.jsonl"),
        `${JSON.stringify({
          thread_key: THREAD,
          root_task_id: rootId,
          task_ids: [rootId, childId],
          report_ids: [workerReportId],
          pending_pm_review: [],
        })}\n`,
        "utf-8",
      );

      const cycle = await runPmGovernanceCycle(root, {
        triggered_by: "report_arrival",
        allow_auto_wake: false,
        auto_review: true,
        max_threads: 3,
        max_judgments: 5,
      });

      const close = cycle.judgments.find((j) => j.skill_id === "pm.close_admin_task");
      assert.ok(close, "expected pm.close_admin_task judgment");
      assert.equal(close!.outcome, "ok");
      assert.equal(close!.persisted, true);
      assert.match(close!.summary ?? "", /PM-to-ADMIN/);

      const reportFiles = await readdir(reportsDir);
      const pmAdminReport = reportFiles.find((f) =>
        /^REPORT-\d{8}-\d{3,}-PM-to-ADMIN(-[a-z][a-z0-9-]*)?\.md$/i.test(f),
      );
      assert.ok(pmAdminReport, "expected PM-to-ADMIN report on disk");
      const body = await readFile(join(reportsDir, pmAdminReport!), "utf-8");
      assert.match(body, /status:\s*done/);
      assert.match(body, /sender:\s*PM/);
      assert.match(body, /recipient:\s*ADMIN/);
    });
  });

  it("033类: active child + done REPORT + review_check pass → auto submit_review", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const activeDir = join(layout.lifecycleRoot, "active");
      const reviewDir = join(layout.lifecycleRoot, "review");
      const reportsDir = layout.reportsDir;
      await mkdir(activeDir, { recursive: true });
      await mkdir(reviewDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });

      const rootId = "TASK-20260611-001-ADMIN-to-PM";
      const childId = "TASK-20260611-033-PM-to-DEV";
      const workerReportId = "REPORT-20260611-033-DEV-to-PM";

      await writeFile(
        join(activeDir, `${rootId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: rootId,
            thread_key: THREAD,
          },
          "# Main\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(activeDir, `${childId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "DEV",
            task_id: childId,
            thread_key: THREAD,
            parent: rootId,
            risk_level: "low",
          },
          "# DEV child\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, `${workerReportId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "DEV",
            recipient: "PM",
            task_id: childId,
            thread_key: THREAD,
            status: "done",
            references: [childId],
          },
          "## 结论\nDEV 完成\n\n## 证据\n- ok\n",
        ),
        "utf-8",
      );

      await new LedgerBuilder({ projectRoot: root }).rebuild();

      const cycle = await runPmGovernanceCycle(root, {
        triggered_by: "report_arrival",
        allow_auto_wake: false,
        auto_review: false,
        max_threads: 3,
        max_judgments: 8,
      });

      const review = cycle.judgments.find((j) => j.skill_id === "pm.review_check");
      assert.ok(review, "expected pm.review_check judgment");
      assert.equal(review!.outcome, "ok");
      assert.match(review!.summary ?? "", /auto submit_review/);

      const payload = review!.payload as {
        auto_submit?: { submitted?: boolean; to_stage?: string };
      };
      assert.equal(payload.auto_submit?.submitted, true);
      assert.equal(payload.auto_submit?.to_stage, "review");

      const located = await findTaskPathById(layout.lifecycleRoot, childId);
      assert.ok(
        located?.stage === "review" || located?.stage === "done",
        `expected review or done after auto chain, got ${located?.stage}`,
      );
    });
  });

  it("writes PM-to-ADMIN summary in the same cycle after final child review", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const activeDir = join(layout.lifecycleRoot, "active");
      const reportsDir = layout.reportsDir;
      await mkdir(activeDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });

      const rootId = "TASK-20260611-041-ADMIN-to-PM";
      const childId = "TASK-20260611-042-PM-to-QA";
      const workerReportId = "REPORT-20260611-042-QA-to-PM";

      await writeFile(
        join(activeDir, `${rootId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: rootId,
            thread_key: THREAD,
          },
          "# Main task\n",
        ),
        "utf-8",
      );

      await writeFile(
        join(activeDir, `${childId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "QA",
            task_id: childId,
            thread_key: THREAD,
            parent: rootId,
            risk_level: "low",
          },
          "# QA child task\n",
        ),
        "utf-8",
      );

      await writeFile(
        join(reportsDir, `${workerReportId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "QA",
            recipient: "PM",
            task_id: childId,
            thread_key: THREAD,
            status: "done",
            references: [childId, rootId],
          },
          "## Conclusion\nQA passed all checks.\n\n## Evidence\n- Mobile route opened.\n- Data persisted after refresh.\n",
        ),
        "utf-8",
      );

      await new LedgerBuilder({ projectRoot: root }).rebuild();

      const cycle = await runPmGovernanceCycle(root, {
        triggered_by: "report_arrival",
        allow_auto_wake: false,
        max_threads: 3,
        max_judgments: 8,
      });

      const review = cycle.judgments.find((j) => j.skill_id === "pm.review_check");
      assert.ok(review, "expected pm.review_check judgment");
      assert.equal(review!.outcome, "ok");
      assert.match(review!.summary ?? "", /PM-to-ADMIN/);

      const reportFiles = await readdir(reportsDir);
      const pmAdminReport = reportFiles.find((f) =>
        /^REPORT-\d{8}-\d{3,}-PM-to-ADMIN(?:-[a-z][a-z0-9-]*)?\.md$/i.test(f),
      );
      assert.ok(pmAdminReport, "expected PM-to-ADMIN report in same cycle");
      const body = await readFile(join(reportsDir, pmAdminReport!), "utf-8");
      assert.match(body, /task_id:\s*TASK-20260611-041/);
      assert.match(body, /status:\s*done/);
    });
  });

  it("已在 review 时不重复 submit_review", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const reviewDir = join(layout.lifecycleRoot, "review");
      const reportsDir = layout.reportsDir;
      await mkdir(reviewDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });

      const childId = "TASK-20260611-034-PM-to-DEV";
      const workerReportId = "REPORT-20260611-034-DEV-to-PM";

      await writeFile(
        join(reviewDir, `${childId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "DEV",
            task_id: childId,
            thread_key: THREAD,
            parent: "TASK-20260611-001-ADMIN-to-PM",
            review_status: "pending",
          },
          "# DEV child\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, `${workerReportId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "DEV",
            recipient: "PM",
            task_id: childId,
            thread_key: THREAD,
            status: "done",
            references: [childId],
          },
          "## 结论\nDEV 完成\n\n## 证据\n- ok\n",
        ),
        "utf-8",
      );

      await new LedgerBuilder({ projectRoot: root }).rebuild();

      const result = await tryAutoSubmitReviewForActiveChild(root, {
        task_id: childId,
        report_id: workerReportId,
        review_ok: true,
      });
      assert.equal(result?.submitted, false);
      assert.match(result?.skipped_reason ?? "", /review/);
    });
  });

  it("active_stalled_done_report 触发 PM report-intake wake（Plan C）", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const activeDir = join(layout.lifecycleRoot, "active");
      const reportsDir = layout.reportsDir;
      await mkdir(activeDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });

      const rootId = "TASK-20260611-001-ADMIN-to-PM";
      const childId = "TASK-20260611-035-PM-to-DEV";
      const workerReportId = "REPORT-20260611-035-DEV-to-PM";

      await writeFile(
        join(activeDir, `${rootId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: rootId,
            thread_key: THREAD,
          },
          "# Main\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(activeDir, `${childId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "DEV",
            task_id: childId,
            thread_key: THREAD,
            parent: rootId,
            display_status: "waiting_pm_attention",
            pm_attention_reason: "测试：review_check 应失败以触发 Plan C",
          },
          "# DEV child\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, `${workerReportId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "DEV",
            recipient: "PM",
            task_id: childId,
            thread_key: THREAD,
            status: "done",
            references: [childId],
          },
          "## 结论\nDEV 完成\n\n## 证据\n- ok\n",
        ),
        "utf-8",
      );

      await new LedgerBuilder({ projectRoot: root }).rebuild();

      const wakeCalls: Array<{ role?: string; task_id?: string }> = [];
      const cycle = await runPmGovernanceCycle(root, {
        triggered_by: "report_arrival",
        allow_auto_wake: true,
        auto_review: false,
        max_threads: 3,
        max_judgments: 8,
        wake_downstream: async (req) => {
          wakeCalls.push({ role: req.role, task_id: req.task_id });
          return { ok: true, session_id: "session-pm-intake-test", agent_id: req.agent_id };
        },
      });

      const stall = cycle.judgments.find((j) => j.skill_id === "pm.detect_thread_stall");
      assert.ok(stall, "expected pm.detect_thread_stall judgment");
      assert.match(stall!.summary ?? "", /wake PM report-intake/);
      assert.equal(stall!.persisted, false);
      assert.ok(
        wakeCalls.some(
          (c) => c.role === "PM" && c.task_id === "TASK-20260611-035",
        ),
        "expected PM intake wake",
      );
    });
  });
});
