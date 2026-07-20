import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { taskMarkdown } from "../../lifecycle/__tests__/helpers.ts";
import { LedgerBuilder } from "../../ledger/LedgerBuilder.ts";
import { resolveLedgerLayout } from "../../ledger/paths.ts";
import {
  summarizeThread,
  detectThreadStall,
  closeAdminTaskDraft,
  buildWakeDownstreamRequest,
  buildAdminRejectPmWakeRequest,
  reviewCheck,
} from "../PmGovernanceActions.ts";

async function withTempProject(
  fn: (ctx: { root: string }) => Promise<void>,
): Promise<void> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "pm-governance-"));
  try {
    await fn({ root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const THREAD = "panel-home-fcop-reactor";

describe("PmGovernanceActions", () => {
  it("summarizeThread aggregates tasks, reports, pending_pm_review", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const activeDir = join(layout.lifecycleRoot, "active");
      const reportsDir = layout.reportsDir;
      await mkdir(activeDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });

      await writeFile(
        join(activeDir, "TASK-20260531-237-ADMIN-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: "TASK-20260531-237-ADMIN-to-PM",
            thread_key: THREAD,
          },
          "# Admin mainline\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(activeDir, "TASK-20260531-238-PM-to-OPS.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "OPS",
            task_id: "TASK-20260531-238-PM-to-OPS",
            thread_key: THREAD,
            parent: "TASK-20260531-237-ADMIN-to-PM",
          },
          "# Worker task\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, "REPORT-20260531-001-OPS-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "OPS",
            recipient: "PM",
            task_id: "TASK-20260531-238-PM-to-OPS",
            thread_key: THREAD,
            status: "done",
          },
          "## 结论\nOPS done\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      const summary = await summarizeThread(root, THREAD);
      assert.ok(summary);
      assert.equal(summary!.thread_key, THREAD);
      assert.equal(summary!.tasks.length, 2);
      assert.ok(summary!.reports.some((r) => r.sender === "OPS"));
      assert.equal(summary!.root_task?.sender, "ADMIN");
    });
  });

  it("closeAdminTaskDraft references downstream PM reports", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const activeDir = join(layout.lifecycleRoot, "active");
      const reportsDir = layout.reportsDir;
      await mkdir(activeDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });

      await writeFile(
        join(activeDir, "TASK-20260531-237-ADMIN-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: "TASK-20260531-237-ADMIN-to-PM",
            thread_key: THREAD,
          },
          "# Main\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, "REPORT-20260531-001-OPS-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "OPS",
            recipient: "PM",
            task_id: "TASK-20260531-238-PM-to-OPS",
            thread_key: THREAD,
            status: "done",
          },
          "## 结论\n下游已完成\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      const draft = await closeAdminTaskDraft(root, { thread_key: THREAD });
      assert.ok(draft);
      assert.equal(draft!.reporter, "PM");
      assert.equal(draft!.recipient, "ADMIN");
      assert.match(draft!.body, /REPORT-20260531-001-OPS-to-PM/);
      assert.equal(draft!.write_report_hint.task_id, "TASK-20260531-237");
    });
  });

  it("detectThreadStall flags missing report on active worker task", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const activeDir = join(layout.lifecycleRoot, "active");
      await mkdir(activeDir, { recursive: true });

      await writeFile(
        join(activeDir, "TASK-20260531-237-ADMIN-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: "TASK-20260531-237-ADMIN-to-PM",
            thread_key: THREAD,
          },
          "# Main\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(activeDir, "TASK-20260531-238-PM-to-DEV.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "DEV",
            task_id: "TASK-20260531-238-PM-to-DEV",
            thread_key: THREAD,
          },
          "# Dev work\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      const stall = await detectThreadStall(root, THREAD);
      assert.ok(stall);
      assert.ok(
        stall!.findings.some((f) => f.code === "missing_report"),
        "expected missing_report finding",
      );
      assert.ok(
        stall!.suggestions.some((s) => s.action === "wake_downstream"),
      );
    });
  });

  it("buildWakeDownstreamRequest uses doorbell wake shape", () => {
    const req = buildWakeDownstreamRequest({
      task_id: "TASK-20260531-238-PM-to-OPS",
      role: "OPS",
      reason: "nudge",
      thread_key: THREAD,
    });
    assert.equal(req.intent, "wake");
    assert.equal(req.operator_role, "PM");
    assert.equal(req.agent_id, "OPS-01");
    assert.match(req.message, /非新派单/);
    assert.equal(req.journal_entry.action, "wake_agent");
    assert.equal(req.journal_entry.reason, "nudge");
  });

  it("reviewCheck validates REPORT on disk with status done", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const activeDir = join(layout.lifecycleRoot, "active");
      const reportsDir = layout.reportsDir;
      await mkdir(activeDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });

      await writeFile(
        join(activeDir, "TASK-20260531-238-PM-to-OPS.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "OPS",
            task_id: "TASK-20260531-238-PM-to-OPS",
            thread_key: THREAD,
          },
          "# Worker\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, "REPORT-20260531-001-OPS-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "OPS",
            recipient: "PM",
            task_id: "TASK-20260531-238-PM-to-OPS",
            thread_key: THREAD,
            status: "done",
            references: ["TASK-20260531-238-PM-to-OPS"],
          },
          "## 结论\n下游已完成\n\n## 证据\n- pytest 207 passed\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      const byReport = await reviewCheck(root, {
        report_id: "REPORT-20260531-001-OPS-to-PM",
      });
      assert.ok(byReport);
      assert.equal(byReport!.report_id, "REPORT-20260531-001-OPS-to-PM");
      assert.equal(byReport!.ok, true, JSON.stringify(byReport!.findings));

      const byTask = await reviewCheck(root, {
        task_id: "TASK-20260531-238-PM-to-OPS",
      });
      assert.ok(byTask);
      assert.equal(byTask!.ok, true);
    });
  });

  it("closeAdminTaskDraft resolves root from ledger when thread task_ids omit mainline", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const reviewDir = join(layout.lifecycleRoot, "review");
      const archiveDir = join(layout.lifecycleRoot, "archive");
      const reportsDir = layout.reportsDir;
      await mkdir(reviewDir, { recursive: true });
      await mkdir(archiveDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });

      await writeFile(
        join(reviewDir, "TASK-20260604-001-ADMIN-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: "TASK-20260604-001",
            thread_key: "panel-task-001",
          },
          "# Main\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(archiveDir, "TASK-20260604-002-PM-to-DEV.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "DEV",
            task_id: "TASK-20260604-002",
            thread_key: "panel-task-003",
            parent: "TASK-20260604-001",
          },
          "# Child\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, "REPORT-20260604-003-DEV-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "DEV",
            recipient: "PM",
            task_id: "TASK-20260604-002",
            thread_key: "panel-task-003",
            status: "done",
          },
          "## 结论\nDEV done\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      const threadsPath = join(layout.ledgerDir, "threads.jsonl");
      const staleThreads = [
        {
          thread_key: "panel-task-001",
          task_ids: ["TASK-20260604-001"],
          report_ids: [],
          pending_pm_review: [],
          root_task_id: "TASK-20260604-001",
        },
        {
          thread_key: "panel-task-003",
          task_ids: ["TASK-20260604-002", "TASK-20260604-003"],
          report_ids: ["REPORT-20260604-003-DEV-to-PM"],
          pending_pm_review: [],
          root_task_id: "TASK-20260604-001",
        },
      ];
      await writeFile(
        threadsPath,
        `${staleThreads.map((r) => JSON.stringify(r)).join("\n")}\n`,
        "utf-8",
      );

      const draft = await closeAdminTaskDraft(root, {
        thread_key: "panel-task-003",
      });
      assert.ok(draft, "draft should resolve ADMIN root via tasks.jsonl");
      assert.equal(draft!.write_report_hint.task_id, "TASK-20260604-001");
      assert.match(draft!.body, /TASK-20260604-001/);
    });
  });

  it("reviewCheck flags missing report", async () => {
    await withTempProject(async ({ root }) => {
      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      const result = await reviewCheck(root, {
        report_id: "REPORT-20260531-999-NONE-to-PM",
      });
      assert.ok(result);
      assert.equal(result!.ok, false);
      assert.ok(result!.findings.some((f) => f.code === "report_missing"));
    });
  });

  it("reviewCheck ignores a legacy pre-report attention marker once a receipt exists", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const activeDir = join(layout.lifecycleRoot, "active");
      await mkdir(activeDir, { recursive: true });
      await mkdir(layout.reportsDir, { recursive: true });
      const taskId = "TASK-20260713-012";
      const reportId = "REPORT-20260713-022-OPS-to-PM";

      await writeFile(
        join(activeDir, `${taskId}-PM-to-OPS.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "OPS",
            task_id: taskId,
            thread_key: THREAD,
            display_status: "waiting_pm_attention",
            pm_attention_reason: "premature review before REPORT existed",
          },
          "# OPS verification\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(layout.reportsDir, `${reportId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "OPS",
            recipient: "PM",
            task_id: taskId,
            thread_key: THREAD,
            status: "blocked",
            references: [taskId],
          },
          "## Outcome\nBlocked with reproducible build and Playwright evidence.\n",
        ),
        "utf-8",
      );
      await new LedgerBuilder({ projectRoot: root }).rebuild();

      const result = await reviewCheck(root, { task_id: taskId });
      assert.ok(result);
      assert.equal(result!.report_id, reportId);
      assert.equal(result!.ok, true);
      assert.ok(
        !result!.findings.some((f) => f.code === "fact_check_needs_human"),
      );
      const taskAfterReview = await readFile(
        join(activeDir, `${taskId}-PM-to-OPS.md`),
        "utf-8",
      );
      assert.doesNotMatch(taskAfterReview, /waiting_pm_attention/);
    });
  });

  it("reviewCheck accepts PM-to-ADMIN final report for short ADMIN task id", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const reviewDir = join(layout.lifecycleRoot, "review");
      const reportsDir = layout.reportsDir;
      await mkdir(reviewDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });

      const fullTaskId = "TASK-20260709-015-ADMIN-to-PM";
      const shortTaskId = "TASK-20260709-015";
      const reportId = "REPORT-20260709-060-PM-to-ADMIN";

      await writeFile(
        join(reviewDir, `${fullTaskId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: fullTaskId,
            thread_key: THREAD,
            state: "review",
          },
          "# Gateway release\n",
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
            sender: "PM",
            recipient: "ADMIN",
            task_id: fullTaskId,
            source_task_id: fullTaskId,
            thread_key: THREAD,
            status: "done",
            references: [fullTaskId],
          },
          "## Summary\nFinal PM report with enough evidence for ADMIN review.\n",
        ),
        "utf-8",
      );

      await writeFile(
        join(reportsDir, "REPORT-20260709-061-PM-to-ADMIN.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "PM",
            recipient: "ADMIN",
            task_id: fullTaskId,
            source_task_id: fullTaskId,
            thread_key: THREAD,
            status: "in_progress",
            references: [fullTaskId],
          },
          "## Patrol\nLater process note; this must not replace the final report.\n",
        ),
        "utf-8",
      );

      await new LedgerBuilder({ projectRoot: root }).rebuild();

      const result = await reviewCheck(root, { task_id: shortTaskId });
      assert.ok(result);
      assert.equal(result!.ok, true);
      assert.equal(result!.report_id, reportId);
      assert.ok(!result!.findings.some((f) => f.code === "report_missing"));
    });
  });

  it("detectThreadStall still flags missing_report when only EVAL-to-PM exists", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const activeDir = join(layout.lifecycleRoot, "active");
      const reportsDir = layout.reportsDir;
      await mkdir(activeDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });

      await writeFile(
        join(activeDir, "TASK-20260531-237-ADMIN-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: "TASK-20260531-237-ADMIN-to-PM",
            thread_key: THREAD,
          },
          "# Main\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(activeDir, "TASK-20260531-238-PM-to-DEV.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "DEV",
            task_id: "TASK-20260531-238-PM-to-DEV",
            thread_key: THREAD,
          },
          "# Dev work\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, "REPORT-20260605-001-EVAL-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "EVAL",
            recipient: "PM",
            task_id: "TASK-20260531-238-PM-to-DEV",
            thread_key: THREAD,
            status: "done",
          },
          "## 观察\nEVAL 扫描结论\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      const stall = await detectThreadStall(root, THREAD);
      assert.ok(stall);
      assert.ok(
        stall!.findings.some((f) => f.code === "missing_report"),
        "EVAL-to-PM must not satisfy worker reciprocity",
      );
    });
  });

  it("reviewCheck excludes EVAL-to-PM governance report", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const reportsDir = layout.reportsDir;
      await mkdir(reportsDir, { recursive: true });

      await writeFile(
        join(reportsDir, "REPORT-20260605-002-EVAL-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "EVAL",
            recipient: "PM",
            task_id: "TASK-20260531-238-PM-to-DEV",
            thread_key: THREAD,
            status: "done",
          },
          "## 观察\nEVAL 不参与 worker review\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      const result = await reviewCheck(root, {
        report_id: "REPORT-20260605-002-EVAL-to-PM",
      });
      assert.ok(result);
      assert.equal(result!.ok, true);
      assert.ok(
        result!.findings.some((f) => f.code === "governance_report_excluded"),
      );
    });
  });

  it("buildAdminRejectPmWakeRequest mandates Cold Path dispatch and task_path", () => {
    const plan = buildAdminRejectPmWakeRequest({
      task_id: "TASK-20260606-007-ADMIN-to-PM",
      reason: "重做！",
      task_path: "fcop/_lifecycle/review/TASK-20260606-007-ADMIN-to-PM.md",
      thread_key: "issue-triage",
    });
    assert.equal(plan.intent, "wake");
    assert.equal(plan.operator_role, "PM");
    assert.match(plan.message, /Cold Path/);
    assert.match(plan.message, /fcop\/_lifecycle\/review\/TASK-20260606-007/);
    assert.match(plan.message, /write_task/);
    assert.match(plan.message, /禁止.*write_report/);
    assert.match(plan.journal_entry.reason, /admin_reject:TASK-20260606-007/);
  });

  it("buildAdminRejectPmWakeRequest uses Hot Path when task body on disk declares PM 亲自执行", async () => {
    await withTempProject(async ({ root }) => {
      const activeDir = join(root, "fcop", "_lifecycle", "active");
      await mkdir(activeDir, { recursive: true });
      await writeFile(
        join(activeDir, "TASK-20260607-017-ADMIN-to-PM-google-gemini-smoke.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: "TASK-20260607-017-ADMIN-to-PM-google-gemini-smoke",
          },
          "本任务为 **Hot Path**：PM 亲自执行，**不得**向下游派发 DEV/QA/OPS。\n",
        ),
        "utf-8",
      );
      const plan = buildAdminRejectPmWakeRequest({
        task_id: "TASK-20260607-017",
        reason: "重新启动，重新做！",
        projectRoot: root,
      });
      assert.match(plan.message, /Hot Path/);
      assert.match(plan.message, /fcop_check/);
      assert.match(plan.message, /write_report\(status=done\)/);
      assert.match(plan.message, /不代表可修改产品代码/);
      assert.match(plan.message, /禁止.*edit 产品代码/);
      assert.doesNotMatch(plan.message, /向 DEV \/ QA \/ OPS 派发子任务/);
    });
  });
});
