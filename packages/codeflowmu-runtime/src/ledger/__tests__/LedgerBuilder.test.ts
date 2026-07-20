import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { taskMarkdown } from "../../lifecycle/__tests__/helpers.ts";
import { detectReportTaskLinkMismatch, LedgerBuilder } from "../LedgerBuilder.ts";
import { resolveLedgerLayout } from "../paths.ts";

async function withTempProject(
  fn: (ctx: { root: string }) => Promise<void>,
): Promise<void> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "ledger-builder-"));
  try {
    await fn({ root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("LedgerBuilder", () => {
  it("derives browser verification from Playwright user-flow evidence without requiring console text", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      await mkdir(layout.reportsDir, { recursive: true });
      await writeFile(
        join(layout.reportsDir, "REPORT-20260713-108-QA-to-PM.md"),
        [
          "---",
          "protocol: fcop",
          "sender: QA",
          "recipient: PM",
          "status: done",
          "references:",
          "  - TASK-20260713-011",
          "---",
          "## 模拟用户操作",
          "Playwright 点击登录、保存和评论，7/7 PASS。",
          "截图：workspace/noteflow/evidence/qa-910/dashboard.png",
          "结构化证据：workspace/noteflow/evidence/qa-910/qa-results.json",
        ].join("\n"),
        "utf-8",
      );

      await new LedgerBuilder({ projectRoot: root }).rebuild();
      const rows = (await readFile(join(layout.ledgerDir, "reports.jsonl"), "utf-8"))
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { qa_browser_verified?: boolean });
      assert.equal(rows[0]?.qa_browser_verified, true);
    });
  });

  it("keeps references weak and derives parent only from parent frontmatter", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const inboxDir = join(layout.lifecycleRoot, "inbox");
      await mkdir(inboxDir, { recursive: true });
      await writeFile(
        join(inboxDir, "TASK-20260615-001-ADMIN-to-PM.md"),
        taskMarkdown({
          protocol: "fcop",
          task_id: "TASK-20260615-001-ADMIN-to-PM",
          sender: "ADMIN",
          recipient: "PM",
          thread_key: "continued-line",
          references: ["TASK-20260614-001"],
        }),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();
      const tasks = await builder.listTasks("PM");
      assert.equal(tasks[0]?.parent, undefined);
      assert.deepEqual(tasks[0]?.yaml?.references, ["TASK-20260614-001"]);
    });
  });

  it("preserves task sequence numbers longer than three digits", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const inboxDir = join(layout.lifecycleRoot, "inbox");
      await mkdir(inboxDir, { recursive: true });
      const taskId = "TASK-20260708-1005-ADMIN-to-PM";
      await writeFile(
        join(inboxDir, `${taskId}.md`),
        taskMarkdown({
          protocol: "fcop",
          task_id: taskId,
          sender: "ADMIN",
          recipient: "PM",
          thread_key: "four-digit-task-seq",
        }),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();
      const tasks = await builder.listTasks("PM");
      assert.equal(tasks[0]?.task_id, "TASK-20260708-1005");
      assert.equal(tasks[0]?.filename, `${taskId}.md`);
    });
  });

  it("preserves routing-complete parent id in parent and parent_task_id", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const activeDir = join(layout.lifecycleRoot, "active");
      await mkdir(activeDir, { recursive: true });
      const parentId = "TASK-20260617-001-ADMIN-to-PM";
      const childId = "TASK-20260617-002-PM-to-DEV";
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
            parent: parentId,
            thread_key: "thread-mobile-role-filter",
          },
          "# Child\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();
      const tasks = await builder.listTasks("DEV");
      const child = tasks.find((t) => t.task_id === "TASK-20260617-002");
      assert.ok(child, "child task in ledger");
      assert.equal(child!.parent, "TASK-20260617-001");
      assert.equal(child!.parent_task_id, "TASK-20260617-001");
    });
  });

  it("ensureLedgerLayout + rebuild scans _lifecycle/inbox tasks", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const inboxDir = join(layout.lifecycleRoot, "inbox");
      await mkdir(inboxDir, { recursive: true });
      await writeFile(
        join(inboxDir, "TASK-20260531-001-ADMIN-to-OPS.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "OPS",
            task_id: "TASK-20260531-001-ADMIN-to-OPS",
          },
          "# Test task\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      const result = await builder.rebuild();
      assert.equal(result.tasks, 1);

      const tasks = await builder.listTasks("OPS");
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]?.bucket, "inbox");
      assert.equal(tasks[0]?.recipient, "OPS");
    });
  });

  it("listTasks excludes done bucket by default", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const doneDir = join(layout.lifecycleRoot, "done");
      await mkdir(doneDir, { recursive: true });
      await writeFile(
        join(doneDir, "TASK-20260531-002-PM-to-DEV.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "DEV",
            task_id: "TASK-20260531-002-PM-to-DEV",
          },
          "# Done task\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();
      const pending = await builder.listTasks("DEV");
      assert.equal(pending.length, 0);

      const all = await builder.listTasks("DEV", { pendingOnly: false });
      assert.equal(all.length, 1);
      assert.equal(all[0]?.bucket, "done");
    });
  });

  it("pending_pm_review matches report task_id to worker task filename", async () => {
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
            thread_key: "panel-task-238",
            parent: "TASK-20260531-238-ADMIN-to-PM",
          },
          "# Worker task\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, "REPORT-20260531-005-OPS-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            sender: "OPS",
            recipient: "PM",
            task_id: "TASK-20260531-238-PM-to-OPS",
            status: "done",
            thread_key: "panel-task-238",
          },
          "# Report\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      const raw = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(layout.ledgerDir, "threads.jsonl"), "utf-8"),
      );
      const thread = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { thread_key: string; pending_pm_review: string[] })
        .find((t) => t.thread_key === "panel-task-238");
      assert.ok(thread);
      assert.ok(thread!.pending_pm_review.length >= 1);
    });
  });

  it("pending_pm_review includes hot_path child when recipient is PM", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const tasksDir = layout.tasksDir;
      const reportsDir = layout.reportsDir;
      await mkdir(tasksDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });

      const childId = "TASK-20260531-002-OPS-to-PM";
      const rootId = "TASK-20260531-001-ADMIN-to-PM";

      await writeFile(
        join(tasksDir, `${childId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            task_id: childId,
            sender: "OPS",
            recipient: "PM",
            thread_key: "hot-path-002",
            parent: rootId,
          },
          "# Hot path child\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, "REPORT-20260531-002-OPS-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "OPS",
            recipient: "PM",
            task_id: childId,
            status: "done",
            thread_key: "hot-path-002",
          },
          "# Done\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      const raw = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(layout.ledgerDir, "threads.jsonl"), "utf-8"),
      );
      const thread = raw
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              thread_key: string;
              pending_pm_review: string[];
            },
        )
        .find((t) => t.thread_key === "hot-path-002");
      assert.ok(thread);
      assert.ok(
        thread!.pending_pm_review.includes("TASK-20260531-002"),
        "recipient PM must not exclude hot_path child from pending_pm_review",
      );
    });
  });

  it("REVIEW-GATE approved links via task_id and clears pending_pm_review", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const tasksDir = layout.tasksDir;
      const reportsDir = layout.reportsDir;
      const reviewsDir = layout.reviewsDir;
      await mkdir(tasksDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });
      await mkdir(reviewsDir, { recursive: true });

      const childId = "TASK-20260531-002-OPS-to-PM";
      const rootId = "TASK-20260531-001-ADMIN-to-PM";
      const reportId = "REPORT-20260531-002-OPS-to-PM";

      await writeFile(
        join(tasksDir, `${childId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            task_id: childId,
            sender: "OPS",
            recipient: "PM",
            thread_key: "hot-path-review-gate",
            parent: rootId,
          },
          "# Hot path child\n",
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
            task_id: childId,
            status: "done",
            thread_key: "hot-path-review-gate",
          },
          "# Done\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(
          reviewsDir,
          `REVIEW-20260531-001-REVIEW-GATE-on-${childId}.md`,
        ),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "review",
            sender: "REVIEW-GATE",
            recipient: "PM",
            subject_id: reportId,
            task_id: childId,
            report_id: reportId,
            reviewer: "REVIEW-GATE",
            decision: "approved",
          },
          "# Fact-check approved\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      const raw = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(layout.ledgerDir, "threads.jsonl"), "utf-8"),
      );
      const thread = raw
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              thread_key: string;
              pending_pm_review: string[];
            },
        )
        .find((t) => t.thread_key === "hot-path-review-gate");
      assert.ok(thread);
      assert.equal(
        thread!.pending_pm_review.includes(childId),
        false,
        "REVIEW-GATE approved must mark child task_id in reviewApproved",
      );
    });
  });

  it("pending_pm_review skips tasks with display_status waiting_pm_attention", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const activeDir = join(layout.lifecycleRoot, "active");
      const reportsDir = layout.reportsDir;
      await mkdir(activeDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });

      const childId = "TASK-20260608-002-PM-to-OPS";
      const rootId = "TASK-20260608-001-ADMIN-to-PM";

      await writeFile(
        join(activeDir, `${rootId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            task_id: rootId,
            sender: "ADMIN",
            recipient: "PM",
            thread_key: "panel-task-001",
          },
          "# Root\n",
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
            task_id: childId,
            sender: "PM",
            recipient: "OPS",
            thread_key: "panel-task-001",
            parent: rootId,
            display_status: "waiting_pm_attention",
            pm_attention_reason:
              "事实核查未通过：REPORT 含表格或数字统计，但动作日志缺少 command.run、file.read 或 data.query 等执行证据",
          },
          "# Child awaiting PM attention\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, "REPORT-20260608-002-OPS-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "OPS",
            recipient: "PM",
            task_id: childId,
            status: "done",
            thread_key: "panel-task-001",
          },
          "# OPS report\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      const raw = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(layout.ledgerDir, "threads.jsonl"), "utf-8"),
      );
      const thread = raw
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              thread_key: string;
              pending_pm_review: string[];
            },
        )
        .find((t) => t.thread_key === "panel-task-001");
      assert.ok(thread);
      assert.equal(
        thread!.pending_pm_review.includes(childId),
        false,
        "waiting_pm_attention must not enqueue pending_pm_review",
      );
    });
  });

  it("clears pending_pm_review after PM-to-ADMIN done report for root task", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const activeDir = join(layout.lifecycleRoot, "active");
      const reportsDir = layout.reportsDir;
      await mkdir(activeDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });

      await writeFile(
        join(activeDir, "TASK-20260531-240-ADMIN-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            thread_key: "panel-task-240",
          },
          "# Root\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(activeDir, "TASK-20260601-001-PM-to-DEV.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "DEV",
            thread_key: "panel-task-240",
            parent: "TASK-20260531-240-ADMIN-to-PM",
          },
          "# Worker\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, "REPORT-20260601-002-DEV-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            sender: "DEV",
            recipient: "PM",
            task_id: "TASK-20260601-001-PM-to-DEV",
            status: "done",
            thread_key: "panel-task-240",
          },
          "# DEV done\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, "REPORT-20260601-006-PM-to-ADMIN.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            sender: "PM",
            recipient: "ADMIN",
            task_id: "TASK-20260531-240",
            status: "done",
            thread_key: "panel-task-240",
          },
          "# PM close\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      const raw = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(layout.ledgerDir, "threads.jsonl"), "utf-8"),
      );
      const thread = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { thread_key: string; pending_pm_review: string[] })
        .find((t) => t.thread_key === "panel-task-240");
      assert.ok(thread);
      assert.equal(thread!.pending_pm_review.length, 0);
    });
  });

  it("clears pending_pm_review when worker task is archived (force archive)", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const archiveDir = join(layout.lifecycleRoot, "archive");
      const activeDir = join(layout.lifecycleRoot, "active");
      const reportsDir = layout.reportsDir;
      await mkdir(archiveDir, { recursive: true });
      await mkdir(activeDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });

      const childId = "TASK-20260608-002-PM-to-OPS";
      const rootId = "TASK-20260608-001-ADMIN-to-PM";

      await writeFile(
        join(activeDir, `${rootId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            task_id: rootId,
            sender: "ADMIN",
            recipient: "PM",
            thread_key: "panel-task-001",
          },
          "# Root\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(archiveDir, `${childId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            task_id: childId,
            sender: "PM",
            recipient: "OPS",
            thread_key: "panel-task-001",
            parent: rootId,
            display_status: "archived",
            archive_mode: "force",
            task_type: "force_archive",
          },
          "# Force archived child\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, "REPORT-20260608-002-OPS-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "OPS",
            recipient: "PM",
            task_id: childId,
            status: "done",
            thread_key: "panel-task-001",
          },
          "# OPS report\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      const raw = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(layout.ledgerDir, "threads.jsonl"), "utf-8"),
      );
      const thread = raw
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              thread_key: string;
              pending_pm_review: string[];
            },
        )
        .find((t) => t.thread_key === "panel-task-001");
      assert.ok(thread);
      assert.equal(
        thread!.pending_pm_review.includes(childId),
        false,
        "archived worker task must not stay in pending_pm_review",
      );
    });
  });

  it("threads aggregate reports via references when task_id is absent", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const activeDir = join(layout.lifecycleRoot, "active");
      const tasksDir = layout.tasksDir;
      const reportsDir = layout.reportsDir;
      await mkdir(activeDir, { recursive: true });
      await mkdir(tasksDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });

      await writeFile(
        join(activeDir, "TASK-20260531-239-ADMIN-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: "TASK-20260531-239",
            thread_key: "panel-task-239",
          },
          "# Root\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(tasksDir, "TASK-20260531-002-PM-to-OPS.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "OPS",
            task_id: "TASK-20260531-002",
            thread_key: "panel-task-239",
            parent: "TASK-20260531-239",
          },
          "# Child\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, "REPORT-20260531-008-OPS-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            sender: "OPS",
            recipient: "PM",
            status: "done",
            references: ["TASK-20260531-002"],
          },
          "# OPS report\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, "REPORT-20260531-009-PM-to-ADMIN.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            sender: "PM",
            recipient: "ADMIN",
            status: "done",
            references: ["TASK-20260531-239"],
          },
          "# PM summary\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      const raw = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(layout.ledgerDir, "threads.jsonl"), "utf-8"),
      );
      const thread = raw
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              thread_key: string;
              report_ids: string[];
            },
        )
        .find((t) => t.thread_key === "panel-task-239");
      assert.ok(thread, "panel-task-239 thread exists");
      assert.ok(
        thread!.report_ids.includes("REPORT-20260531-008-OPS-to-PM"),
        "008 via references→002→thread_key",
      );
      assert.ok(
        thread!.report_ids.includes("REPORT-20260531-009-PM-to-ADMIN"),
        "009 via references→239→thread_key",
      );
    });
  });

  it("links report to task via body title when frontmatter references are empty", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const reviewDir = join(layout.lifecycleRoot, "review");
      const reportsDir = layout.reportsDir;
      await mkdir(reviewDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });

      await writeFile(
        join(reviewDir, "TASK-20260606-006-ADMIN-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: "TASK-20260606-006-ADMIN-to-PM",
            thread_key: "sys-test",
          },
          "# 系统测试\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, "REPORT-20260606-016-PM-to-ADMIN.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            sender: "PM",
            recipient: "ADMIN",
            status: "done",
          },
          "# FCoP 系统自检 (TASK-20260606-006)\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();
      const reports = await builder.listReportsForTask("TASK-20260606-006");
      const hit = reports.find((r) => r.report_id === "REPORT-20260606-016-PM-to-ADMIN");
      assert.ok(hit, "report linked to task");
      assert.equal(hit!.task_id, "TASK-20260606-006");
    });
  });

  it("links PM-to-ADMIN ack report via filename date-seq when references empty", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const activeDir = join(layout.lifecycleRoot, "active");
      const reportsDir = layout.reportsDir;
      await mkdir(activeDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });

      await writeFile(
        join(activeDir, "TASK-20260608-004-ADMIN-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: "TASK-20260608-004-ADMIN-to-PM",
            thread_key: "panel-task-004",
          },
          "# 系统初始化\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, "REPORT-20260608-004-PM-to-ADMIN.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            sender: "PM",
            recipient: "ADMIN",
          },
          "已收到任务，正在分析并派发。\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();
      const reports = await builder.listReportsForTask("TASK-20260608-004");
      const hit = reports.find((r) => r.report_id === "REPORT-20260608-004-PM-to-ADMIN");
      assert.ok(hit, "ack report linked via filename");
      assert.equal(hit!.task_id, "TASK-20260608-004");

      const threadsRaw = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(layout.ledgerDir, "threads.jsonl"), "utf-8"),
      );
      const threads = threadsRaw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { thread_key: string; report_ids: string[] });
      const orphan = threads.find((t) => String(t.thread_key).startsWith("_orphan"));
      assert.equal(orphan, undefined, "no orphan thread for ack PM-to-ADMIN");
      const panel = threads.find((t) => t.thread_key === "panel-task-004");
      assert.ok(panel, "report on panel-task-004 thread");
      assert.ok(
        (panel!.report_ids || []).some((id) => id.includes("REPORT-20260608-004")),
      );
    });
  });

  it("task records include offset timestamps from frontmatter", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const inboxDir = join(layout.lifecycleRoot, "inbox");
      await mkdir(inboxDir, { recursive: true });
      await writeFile(
        join(inboxDir, "TASK-20260531-010-ADMIN-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: "TASK-20260531-010-ADMIN-to-PM",
            created_at: "2026-05-31T22:26:47+08:00",
            updated_at: "2026-05-31T22:26:47+08:00",
            timezone: "Asia/Shanghai",
            created_at_utc: "2026-05-31T14:26:47Z",
          },
          "# Timestamps\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();
      const tasks = await builder.listTasks("PM");
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]?.created_at, "2026-05-31T22:26:47+08:00");
      assert.equal(tasks[0]?.timezone, "Asia/Shanghai");
      assert.equal(tasks[0]?.created_at_utc, "2026-05-31T14:26:47Z");
      assert.match(tasks[0]?.created_at ?? "", /\+08:00$/);
    });
  });

  it("worker todo views include hot_path fcop/tasks/ rows for DEV and OPS", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const tasksDir = layout.tasksDir;
      await mkdir(tasksDir, { recursive: true });

      await writeFile(
        join(tasksDir, "TASK-20260602-022-PM-to-OPS.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "OPS",
            task_id: "TASK-20260602-022",
            thread_key: "eval-promotion-032",
          },
          "# Hot path OPS task\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(tasksDir, "TASK-20260602-013-PM-to-DEV.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "DEV",
            task_id: "TASK-20260602-013",
            thread_key: "panel-task-dev",
          },
          "# Hot path DEV task\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      const opsView = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(layout.ledgerDir, "views", "OPS.todo.md"), "utf-8"),
      );
      const devView = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(layout.ledgerDir, "views", "DEV.todo.md"), "utf-8"),
      );

      assert.ok(opsView.includes("TASK-20260602-022"), "OPS.todo lists hot_path task");
      assert.ok(devView.includes("TASK-20260602-013"), "DEV.todo lists hot_path task");
      assert.ok(!opsView.includes("（暂无任务）"), "OPS.todo not empty");
    });
  });

  it("ensureFresh rebuilds when disk has tasks missing from ledger", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const activeDir = join(layout.lifecycleRoot, "active");
      await mkdir(activeDir, { recursive: true });

      await writeFile(
        join(activeDir, "TASK-20260531-001-ADMIN-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: "TASK-20260531-001",
            thread_key: "panel-task-001",
          },
          "# First\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();
      assert.equal((await builder.listTasks("PM")).length, 1);

      await writeFile(
        join(activeDir, "TASK-20260531-240-ADMIN-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: "TASK-20260531-240",
            thread_key: "panel-task-240",
          },
          "# New task\n",
        ),
        "utf-8",
      );

      assert.equal(await builder.detectStale(), true);
      assert.equal(await builder.ensureFresh(), true);

      const tasks = await builder.listTasks("PM");
      assert.equal(tasks.length, 2);
      assert.ok(
        tasks.some((t) => t.task_id === "TASK-20260531-240"),
        "240 present after ensureFresh",
      );

      const raw = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(layout.ledgerDir, "threads.jsonl"), "utf-8"),
      );
      assert.ok(
        raw.includes("panel-task-240"),
        "threads.jsonl includes panel-task-240",
      );
    });
  });

  it("rebuild merges split threads when root_task_id points to canonical thread_key", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const reviewDir = join(layout.lifecycleRoot, "review");
      const archiveDir = join(layout.lifecycleRoot, "archive");
      await mkdir(reviewDir, { recursive: true });
      await mkdir(archiveDir, { recursive: true });
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
          "# Child dev\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(archiveDir, "TASK-20260604-003-PM-to-QA.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "QA",
            task_id: "TASK-20260604-003",
            thread_key: "panel-task-003",
            parent: "TASK-20260604-001",
          },
          "# Child qa\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();
      const raw = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(layout.ledgerDir, "threads.jsonl"), "utf-8"),
      );
      const rows = raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { thread_key?: string; task_ids?: string[]; root_task_id?: string });
      const main = rows.find((r) => r.thread_key === "panel-task-001");
      assert.ok(main, "panel-task-001 remains");
      assert.ok(main!.task_ids?.includes("TASK-20260604-001"));
      assert.ok(main!.task_ids?.includes("TASK-20260604-002"));
      assert.ok(main!.task_ids?.includes("TASK-20260604-003"));
      assert.ok(
        !rows.some(
          (r) =>
            r.thread_key === "panel-task-003" &&
            (r.task_ids?.length ?? 0) > 0,
        ),
        "panel-task-003 split row merged away",
      );
    });
  });

  it("rebuild merges child with parent into main thread (not orphan-only row)", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const doneDir = join(layout.lifecycleRoot, "done");
      const archiveDir = join(layout.lifecycleRoot, "archive");
      await mkdir(doneDir, { recursive: true });
      await mkdir(archiveDir, { recursive: true });
      await writeFile(
        join(doneDir, "TASK-20260604-005-ADMIN-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: "TASK-20260604-005",
            thread_key: "panel-task-005",
          },
          "# Main\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(archiveDir, "TASK-20260604-006-PM-to-DEV.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "DEV",
            task_id: "TASK-20260604-006",
            parent: "TASK-20260604-005",
          },
          "# Child\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();
      const raw = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(layout.ledgerDir, "threads.jsonl"), "utf-8"),
      );
      const lines = raw.trim().split("\n").filter(Boolean);
      const rows = lines.map((l) => JSON.parse(l) as { thread_key?: string; task_ids?: string[] });
      const main = rows.find((r) => r.thread_key === "panel-task-005");
      assert.ok(main, "panel-task-005 thread exists");
      assert.ok(
        main!.task_ids?.includes("TASK-20260604-006"),
        "child task_id merged into parent thread",
      );
      assert.ok(
        !rows.some(
          (r) =>
            r.thread_key === "_orphan_TASK-20260604-006" &&
            (r.task_ids?.length ?? 0) > 0,
        ),
        "orphan-only row removed after merge",
      );
    });
  });

  it("rebuild does not infer task parent from body text", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const inboxDir = join(layout.lifecycleRoot, "inbox");
      const activeDir = join(layout.lifecycleRoot, "active");
      await mkdir(inboxDir, { recursive: true });
      await mkdir(activeDir, { recursive: true });
      await writeFile(
        join(inboxDir, "TASK-20260606-013-ADMIN-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: "TASK-20260606-013",
            thread_key: "panel-task-013",
          },
          "# Main task\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(activeDir, "TASK-20260607-001-PM-to-DEV.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "DEV",
          },
          "**父任务引用：** TASK-20260606-013\n\n## 返工\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();
      const tasks = await builder.listTasks("DEV");
      const child = tasks.find((t) => t.task_id === "TASK-20260607-001");
      assert.ok(child, "child task in ledger");
      assert.equal(child!.parent, undefined);

      const raw = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(layout.ledgerDir, "threads.jsonl"), "utf-8"),
      );
      const main = raw
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { thread_key?: string; task_ids?: string[] })
        .find((r) => r.thread_key === "panel-task-013");
      assert.ok(main, "parent thread exists");
      assert.ok(!main!.task_ids?.includes("TASK-20260607-001"));
    });
  });

  it("PM.todo lists ADMIN-rejected tasks when review_status is pending but reopen_reason set", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const reviewDir = join(layout.lifecycleRoot, "review");
      await mkdir(reviewDir, { recursive: true });
      await writeFile(
        join(reviewDir, "TASK-20260606-007-ADMIN-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: "TASK-20260606-007-ADMIN-to-PM",
            review_status: "pending",
            reopen_reason: "重做！",
            reopened_count: 1,
          },
          "# ADMIN rejected — pending resubmit\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();
      const view = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(layout.ledgerDir, "views", "PM.todo.md"), "utf-8"),
      );
      assert.match(view, /ADMIN 判定打回/);
      assert.match(view, /TASK-20260606-007/);
      assert.match(view, /重做！/);
    });
  });

  it("panel-task-004 thread root prefers ADMIN mainline over PM child (003 before 004 scan order)", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const activeDir = join(layout.lifecycleRoot, "active");
      const reportsDir = layout.reportsDir;
      await mkdir(activeDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });

      const mainId = "TASK-20260608-004-ADMIN-to-PM";
      const childId = "TASK-20260608-003-PM-to-OPS";
      const otherThreadTask = "TASK-20260608-002-PM-to-OPS";
      const otherReportId = "REPORT-20260608-003-OPS-to-PM";

      await writeFile(
        join(activeDir, `${childId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "OPS",
            thread_key: "panel-task-004",
          },
          "# PM child (003)\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(activeDir, `${mainId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            thread_key: "panel-task-004",
          },
          "# P1 总线闭环真实运行验收\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(activeDir, `${otherThreadTask}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "OPS",
            thread_key: "panel-task-001",
          },
          "# Other thread init patrol\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, `${otherReportId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "OPS",
            recipient: "PM",
            task_id: otherThreadTask,
            status: "done",
            thread_key: "panel-task-001",
            references: [otherThreadTask],
          },
          "# Report for 001 thread\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      const raw = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(layout.ledgerDir, "threads.jsonl"), "utf-8"),
      );
      const rows = raw
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              thread_key: string;
              root_task_id?: string;
              task_ids?: string[];
              report_ids?: string[];
            },
        );
      const t004 = rows.find((r) => r.thread_key === "panel-task-004");
      assert.ok(t004, "panel-task-004 thread");
      assert.match(
        String(t004!.root_task_id || ""),
        /^TASK-20260608-004/,
        "root must be ADMIN mainline 004, not PM child 003",
      );
      assert.ok(
        !t004!.task_ids?.includes(otherThreadTask),
        "001-thread task 002 must not appear in panel-task-004",
      );
      assert.ok(
        !t004!.report_ids?.includes(otherReportId),
        "001-thread report must not appear in panel-task-004",
      );

      const t001 = rows.find((r) => r.thread_key === "panel-task-001");
      assert.ok(t001, "panel-task-001 thread");
      assert.ok(
        t001!.report_ids?.includes(otherReportId),
        "report stays on panel-task-001",
      );
    });
  });

  it("does not match short task id prefix to rework filename (002 vs 002-OPS-to-OPS-rework-1)", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const inboxDir = join(layout.lifecycleRoot, "inbox");
      const reportsDir = layout.reportsDir;
      await mkdir(inboxDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });

      const baseId = "TASK-20260608-002-PM-to-OPS";
      const reworkId = "TASK-20260608-002-OPS-to-OPS-rework-1";

      await writeFile(
        join(inboxDir, `${baseId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "OPS",
            thread_key: "panel-task-001",
          },
          "# Base task\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(inboxDir, `${reworkId}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "OPS",
            recipient: "OPS",
            thread_key: "panel-task-004",
            parent: "TASK-20260608-003-PM-to-OPS",
          },
          "# Rework\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, "REPORT-20260608-010-OPS-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "OPS",
            recipient: "PM",
            task_id: baseId,
            status: "done",
            thread_key: "panel-task-001",
          },
          "# Report for base PM-to-OPS\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      const raw = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(layout.ledgerDir, "threads.jsonl"), "utf-8"),
      );
      const rows = raw
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              thread_key: string;
              task_ids?: string[];
            },
        );
      const t004 = rows.find((r) => r.thread_key === "panel-task-004");
      if (t004) {
        assert.ok(
          !t004.task_ids?.some((id) => id.startsWith("TASK-20260608-002-PM-to-OPS")),
          "short-id report must not pull 001-thread base task into 004 via rework prefix",
        );
      }
    });
  });

  it("parent ref TASK-20260608-002 resolves to 001-thread base, not 004 rework filename", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const inboxDir = join(layout.lifecycleRoot, "inbox");
      const activeDir = join(layout.lifecycleRoot, "active");
      await mkdir(inboxDir, { recursive: true });
      await mkdir(activeDir, { recursive: true });

      const base002 = "TASK-20260608-002-PM-to-OPS";
      const rework001 = "TASK-20260608-001-OPS-to-OPS-rework-1";
      const rework004 = "TASK-20260608-002-OPS-to-OPS-rework-1";
      const main004 = "TASK-20260608-004-ADMIN-to-PM";
      const child003 = "TASK-20260608-003-PM-to-OPS";

      await writeFile(
        join(activeDir, `${base002}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "OPS",
            thread_key: "panel-task-001",
          },
          "# Init patrol\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(inboxDir, `${rework001}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "OPS",
            recipient: "OPS",
            thread_key: "panel-task-001",
            parent: "TASK-20260608-002",
          },
          "# 001 rework\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(inboxDir, `${rework004}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "OPS",
            recipient: "OPS",
            thread_key: "panel-task-004",
            parent: "TASK-20260608-003-PM-to-OPS",
          },
          "# 004 rework\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(activeDir, `${child003}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "OPS",
            thread_key: "panel-task-004",
          },
          "# PM child\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(activeDir, `${main004}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            thread_key: "panel-task-004",
          },
          "# P1 mainline\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      const raw = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(layout.ledgerDir, "threads.jsonl"), "utf-8"),
      );
      const rows = raw
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              thread_key: string;
              root_task_id?: string;
              task_ids?: string[];
            },
        );
      const t004 = rows.find((r) => r.thread_key === "panel-task-004");
      const t001 = rows.find((r) => r.thread_key === "panel-task-001");
      assert.ok(t004, "panel-task-004");
      assert.ok(t001, "panel-task-001");
      assert.ok(
        !t004!.task_ids?.includes("TASK-20260608-001"),
        "001-thread rework must not merge into panel-task-004",
      );
      assert.ok(
        t001!.task_ids?.includes("TASK-20260608-001"),
        "001-thread rework stays on panel-task-001",
      );
      assert.ok(
        t001!.task_ids?.includes("TASK-20260608-002"),
        "001-thread base TASK-20260608-002 stays on panel-task-001",
      );
      assert.ok(
        t004!.task_ids?.includes("TASK-20260608-002"),
        "004-thread rework (canonical id TASK-20260608-002) stays on panel-task-004",
      );
      assert.match(String(t004!.root_task_id || ""), /^TASK-20260608-004/);
    });
  });

  it("does not flag same-date seq-only mismatch (REPORT-041→TASK-017)", () => {
    const warning = detectReportTaskLinkMismatch(
      "REPORT-20260611-041-DEV-to-PM.md",
      {
        task_id: "TASK-20260611-017",
        references: ["TASK-20260611-017"],
      },
      "TASK-20260611-017",
    );
    assert.equal(warning, undefined);
  });

  it("does not flag worker report when filename seq differs but fm agrees (REPORT-039→TASK-016)", () => {
    const warning = detectReportTaskLinkMismatch(
      "REPORT-20260611-039-DEV-to-PM.md",
      {
        task_id: "TASK-20260611-016",
        references: ["TASK-20260611-016"],
      },
      "TASK-20260611-016",
    );
    assert.equal(warning, undefined);
  });

  it("flags task_id vs references mismatch on worker report", () => {
    const warning = detectReportTaskLinkMismatch(
      "REPORT-20260611-039-DEV-to-PM.md",
      {
        task_id: "TASK-20260611-016",
        references: ["TASK-20260611-017"],
      },
      "TASK-20260611-016",
    );
    assert.ok(warning);
    assert.match(warning!, /016/);
    assert.match(warning!, /017/);
  });

  it("rebuild persists task_id_link_warning on mismatched worker report", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const reportsDir = layout.reportsDir;
      await mkdir(reportsDir, { recursive: true });
      await writeFile(
        join(reportsDir, "REPORT-20260611-039-DEV-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            sender: "DEV",
            recipient: "PM",
            task_id: "TASK-20260611-016",
            references: ["TASK-20260611-017"],
            status: "done",
          },
          "# mismatch fixture\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();
      const reports = await builder.listReportsForTask("TASK-20260611-016");
      const hit = reports.find((r) => r.report_id === "REPORT-20260611-039-DEV-to-PM");
      assert.ok(hit?.task_id_link_warning);
      assert.match(hit!.task_id_link_warning!, /017/);
    });
  });

  it("excludes MCP-PROBE bootstrap tasks from role todo views", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const inboxDir = join(layout.lifecycleRoot, "inbox");
      await mkdir(inboxDir, { recursive: true });
      await writeFile(
        join(inboxDir, "TASK-20260612-023-DEV-to-DEV.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            sender: "DEV",
            recipient: "DEV",
            thread_key: "mcp-tool-probe",
            subject: "ISSUE-MCP-PROBE sandbox task",
            task_id: "TASK-20260612-023",
          },
          "# probe sandbox\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(inboxDir, "TASK-20260612-027-PM-to-DEV.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            sender: "PM",
            recipient: "DEV",
            thread_key: "panel-task-029",
            subject: "正式 DEV 任务",
            task_id: "TASK-20260612-027",
          },
          "# real work\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();
      const devView = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(layout.ledgerDir, "views", "DEV.todo.md"), "utf-8"),
      );
      assert.doesNotMatch(devView, /TASK-20260612-023/);
      assert.match(devView, /TASK-20260612-027/);
      assert.equal(await builder.detectViewsStale(), false);
    });
  });
});
