import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LedgerBuilder } from "../../ledger/LedgerBuilder.ts";
import { resolveLedgerLayout } from "../../ledger/paths.ts";
import { TaskFrontmatterStore } from "../TaskFrontmatterStore.ts";
import {
  ChildTasksOpenError,
  LifecycleStateMachine,
} from "../LifecycleStateMachine.ts";
import { taskMarkdown, withTempLifecycle, writeTaskAt } from "./helpers.ts";

describe("LifecycleStateMachine", () => {
  it("1. active → review 成功并写 transitions", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskId = "TASK-20260530-010-PM-to-OPS";
      await writeTaskAt(lifecycleRoot, "active", `${taskId}.md`, {
        task_id: taskId,
        from: "PM",
        to: "OPS",
        driver: "OPS",
        done_authority: "PM",
        archive_authority: "PM",
      });

      const sm = new LifecycleStateMachine({ lifecycleRoot });
      const result = await sm.submitReview({
        taskId,
        actor: "OPS",
        reportId: "REPORT-20260530-001-OPS-to-PM",
      });

      assert.equal(result.from, "active");
      assert.equal(result.to, "review");
      assert.match(result.path, /review\//);

      const store = new TaskFrontmatterStore();
      const { fm } = await store.read(
        `${lifecycleRoot}/review/${taskId}.md`.replace(/\\/g, "/"),
      );
      assert.equal(fm.state, "review");
      assert.equal(fm.review_status, "pending");
      assert.ok(Array.isArray(fm.transitions) && fm.transitions.length >= 1);
    });
  });

  it("2. review → done 成功并写 transitions", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskId = "TASK-20260530-011-PM-to-OPS";
      await writeTaskAt(lifecycleRoot, "review", `${taskId}.md`, {
        task_id: taskId,
        from: "PM",
        to: "OPS",
        driver: "OPS",
        done_authority: "PM",
        archive_authority: "PM",
        review_status: "pending",
        lifecycle_projection: "review",
      });

      const sm = new LifecycleStateMachine({ lifecycleRoot });
      const result = await sm.approveReview({ taskId, actor: "PM" });

      assert.equal(result.to, "done");
      const store = new TaskFrontmatterStore();
      const { fm } = await store.read(
        `${lifecycleRoot}/done/${taskId}.md`.replace(/\\/g, "/"),
      );
      assert.equal(fm.review_status, "approved");
      assert.equal(fm.lifecycle_projection, "done");
      assert.ok(fm.transitions && fm.transitions.length >= 1);
    });
  });

  it("needs_human blocks automatic PM approval but allows explicit ADMIN acceptance", async () => {
    await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
      const taskId = "TASK-20260712-003-PM-to-QA";
      await writeTaskAt(lifecycleRoot, "review", `${taskId}.md`, {
        task_id: taskId,
        from: "PM",
        to: "QA",
        driver: "QA",
        reviewer: "PM",
        done_authority: "PM",
        review_status: "pending",
      });
      const reviewsDir = join(rootDir, "fcop", "reviews");
      await mkdir(reviewsDir, { recursive: true });
      await writeFile(
        join(reviewsDir, "REVIEW-20260712-003.md"),
        ["---", `task_id: ${taskId}`, "decision: needs_human", "---"].join("\n"),
        "utf-8",
      );

      const sm = new LifecycleStateMachine({ lifecycleRoot });
      await assert.rejects(
        () => sm.approveReview({ taskId, actor: "PM" }),
        /explicit ADMIN risk acceptance/,
      );
      const accepted = await sm.approveReview({
        taskId,
        actor: "ADMIN",
        note: "risk accepted",
      });
      assert.equal(accepted.to, "done");
    });
  });

  it("3. review → active 打回成功并 reopened_count + 1", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskId = "TASK-20260530-012-PM-to-OPS";
      await writeTaskAt(lifecycleRoot, "review", `${taskId}.md`, {
        task_id: taskId,
        from: "PM",
        to: "OPS",
        driver: "OPS",
        reviewer: "PM",
        done_authority: "PM",
        reopened_count: 0,
      });

      const sm = new LifecycleStateMachine({ lifecycleRoot });
      await sm.rejectReview({
        taskId,
        actor: "PM",
        reason: "需要补证据",
      });

      const store = new TaskFrontmatterStore();
      const { fm } = await store.read(
        `${lifecycleRoot}/active/${taskId}.md`.replace(/\\/g, "/"),
      );
      assert.equal(fm.review_status, "rejected");
      assert.equal(fm.reopened_count, 1);
      assert.equal(fm.display_status, "waiting_rework");
    });
  });

  it("3a. ADMIN 打回 ADMIN→PM 主任务设 display_status waiting_pm_rework", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskId = "TASK-20260609-003-ADMIN-to-PM";
      await writeTaskAt(lifecycleRoot, "review", `${taskId}.md`, {
        task_id: taskId,
        from: "ADMIN",
        to: "PM",
        driver: "PM",
        reviewer: "ADMIN",
        done_authority: "ADMIN",
        reopened_count: 0,
      });

      const sm = new LifecycleStateMachine({ lifecycleRoot });
      await sm.rejectReview({
        taskId,
        actor: "ADMIN",
        reason: "证据不足",
      });

      const store = new TaskFrontmatterStore();
      const { fm } = await store.read(
        `${lifecycleRoot}/active/${taskId}.md`.replace(/\\/g, "/"),
      );
      assert.equal(fm.display_status, "waiting_pm_rework");
    });
  });

  it("3c. active 打回后返工完成可 submit_review", async () => {
    await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
      const taskId = "TASK-20260610-210-ADMIN-to-PM";
      const rejectAt = "2026-06-10T17:47:55+08:00";
      await writeTaskAt(lifecycleRoot, "active", `${taskId}.md`, {
        task_id: taskId,
        from: "ADMIN",
        to: "PM",
        driver: "PM",
        reviewer: "ADMIN",
        thread_key: "panel-task-210",
        reopen_reason: "有问题，最好重做",
        review_status: "rejected",
        reopened_count: 1,
        display_status: "waiting_pm_rework",
        transitions: [
          {
            at: rejectAt,
            from: "review",
            to: "active",
            by: "ADMIN",
            action: "reject_review",
            decision: "rejected",
          },
        ],
      });

      const reportsDir = join(rootDir, "fcop", "reports");
      await mkdir(reportsDir, { recursive: true });
      const reportId = "REPORT-20260610-085-PM-to-ADMIN";
      await writeFile(
        join(reportsDir, `${reportId}.md`),
        `---
sender: PM
recipient: ADMIN
status: done
created_at: 2026-06-10T18:10:00+08:00
references:
  - ${taskId}
---
# PM final
`,
        "utf-8",
      );

      const ledgerDir = join(rootDir, "fcop", "ledger");
      await mkdir(ledgerDir, { recursive: true });
      const lines = [
        {
          task_id: "TASK-20260610-029",
          thread_key: "panel-task-210",
          recipient: "DEV",
          bucket: "done",
          created_at: "2026-06-10T17:59:23+08:00",
          yaml: {
            references: [taskId],
            thread_key: "panel-task-210",
            recipient: "DEV",
          },
        },
        {
          task_id: "TASK-20260610-030",
          thread_key: "panel-task-210",
          recipient: "QA",
          bucket: "done",
          created_at: "2026-06-10T18:02:13+08:00",
          yaml: {
            references: [taskId],
            thread_key: "panel-task-210",
            recipient: "QA",
          },
        },
      ];
      await writeFile(
        join(ledgerDir, "tasks.jsonl"),
        lines.map((row) => JSON.stringify(row)).join("\n"),
        "utf-8",
      );

      const sm = new LifecycleStateMachine({ lifecycleRoot });
      const result = await sm.submitReview({
        taskId,
        actor: "PM",
        reportId,
      });

      assert.equal(result.to, "review");
      const store = new TaskFrontmatterStore();
      const { fm } = await store.read(
        `${lifecycleRoot}/review/${taskId}.md`.replace(/\\/g, "/"),
      );
      assert.equal(fm.review_status, "pending");
      assert.equal(fm.reopen_reason, "有问题，最好重做");
      assert.equal(fm.reopened_count, 1);
      assert.equal(fm.rework_completed_by_report, reportId);
    });
  });

  it("3b. active 打回后 submit_review 被拒（rework 期间禁止自动再提交）", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskId = "TASK-20260530-012b-ADMIN-to-PM";
      await writeTaskAt(lifecycleRoot, "active", `${taskId}.md`, {
        task_id: taskId,
        from: "ADMIN",
        to: "PM",
        driver: "PM",
        reviewer: "ADMIN",
        done_authority: "ADMIN",
        reopen_reason: "打回",
        review_status: "rejected",
        reopened_count: 1,
      });

      const sm = new LifecycleStateMachine({ lifecycleRoot });
      await assert.rejects(
        () =>
          sm.submitReview({
            taskId,
            actor: "PM",
            reportId: "REPORT-20260530-012b-PM-to-ADMIN",
          }),
        /reopened for ADMIN rework/,
      );
    });
  });

  it("4. done → active 重开成功", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskId = "TASK-20260530-013-PM-to-OPS";
      await writeTaskAt(lifecycleRoot, "done", `${taskId}.md`, {
        task_id: taskId,
        from: "PM",
        to: "OPS",
        driver: "OPS",
        reviewer: "PM",
        done_authority: "PM",
        review_status: "approved",
      });

      const sm = new LifecycleStateMachine({ lifecycleRoot });
      await sm.reopenTask({
        taskId,
        actor: "PM",
        reason: "ADMIN 要求返工",
      });

      const store = new TaskFrontmatterStore();
      const { fm } = await store.read(
        `${lifecycleRoot}/active/${taskId}.md`.replace(/\\/g, "/"),
      );
      assert.equal(fm.review_status, "reopened");
    });
  });

  it("5. done → archive 成功并 frozen: true", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskId = "TASK-20260530-014-PM-to-OPS";
      await writeTaskAt(lifecycleRoot, "done", `${taskId}.md`, {
        task_id: taskId,
        from: "PM",
        to: "OPS",
        driver: "OPS",
        done_authority: "PM",
        archive_authority: "PM",
        review_status: "approved",
      });

      const sm = new LifecycleStateMachine({ lifecycleRoot });
      await sm.archiveTask({
        taskId,
        actor: "PM",
        reason: "主线已验收",
      });

      const store = new TaskFrontmatterStore();
      const path = `${lifecycleRoot}/archive/${taskId}.md`.replace(/\\/g, "/");
      const { fm } = await store.read(path);
      assert.equal(fm.frozen, true);
      assert.equal(fm.state, "archive");
    });
  });

  it("6. active → done 被拒", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskId = "TASK-20260530-015-PM-to-OPS";
      await writeTaskAt(lifecycleRoot, "active", `${taskId}.md`, {
        task_id: taskId,
        driver: "OPS",
        done_authority: "PM",
      });

      const sm = new LifecycleStateMachine({ lifecycleRoot });
      await assert.rejects(
        () => sm.finishTaskLegacy({ taskId, actor: "PM" }),
        /active task to done/,
      );
    });
  });

  it("7. review → archive 被拒", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskId = "TASK-20260530-016-PM-to-OPS";
      await writeTaskAt(lifecycleRoot, "review", `${taskId}.md`, {
        task_id: taskId,
        done_authority: "PM",
        archive_authority: "PM",
        review_status: "approved",
      });

      const sm = new LifecycleStateMachine({ lifecycleRoot });
      await assert.rejects(
        () =>
          sm.archiveTask({
            taskId,
            actor: "PM",
            reason: "skip",
          }),
        /expected state done/,
      );
    });
  });

  it("7b. inbox force_archive 成功（archive_authority）", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskId = "TASK-20260530-016b-ADMIN-to-PM";
      await writeTaskAt(lifecycleRoot, "inbox", `${taskId}.md`, {
        task_id: taskId,
        from: "ADMIN",
        to: "PM",
        driver: "PM",
        done_authority: "ADMIN",
        archive_authority: "ADMIN",
      });

      const sm = new LifecycleStateMachine({ lifecycleRoot });
      const result = await sm.archiveTask({
        taskId,
        actor: "ADMIN",
        reason: "作废测试指令",
        force: true,
      });

      assert.equal(result.from, "inbox");
      assert.equal(result.to, "archive");
      const store = new TaskFrontmatterStore();
      const { fm } = await store.read(
        `${lifecycleRoot}/archive/${taskId}.md`.replace(/\\/g, "/"),
      );
      assert.equal(fm.frozen, true);
      assert.equal(fm.state, "archive");
      assert.equal(fm.archive_mode, "force");
      assert.equal(fm.task_type, "force_archive");
      assert.equal(fm.lifecycle_projection, "archive");
      assert.equal(fm.display_status, "archived");
      const transitions = Array.isArray(fm.transitions) ? fm.transitions : [];
      const last = transitions[transitions.length - 1] as Record<string, unknown>;
      assert.equal(last.action, "force_archive_task");
    });
  });

  it("7c. active force_archive 成功（半归档 bug 回归）", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskId = "TASK-20260530-016c-ADMIN-to-PM";
      await writeTaskAt(lifecycleRoot, "active", `${taskId}.md`, {
        task_id: taskId,
        from: "ADMIN",
        to: "PM",
        driver: "PM",
        done_authority: "ADMIN",
        archive_authority: "ADMIN",
        state: "active",
      });

      const sm = new LifecycleStateMachine({ lifecycleRoot });
      const result = await sm.archiveTask({
        taskId,
        actor: "ADMIN",
        reason: "作废进行中任务",
        force: true,
      });

      assert.equal(result.from, "active");
      assert.equal(result.to, "archive");
      assert.match(result.path, /archive\//);

      const store = new TaskFrontmatterStore();
      const activePath = `${lifecycleRoot}/active/${taskId}.md`.replace(/\\/g, "/");
      const archivePath = `${lifecycleRoot}/archive/${taskId}.md`.replace(/\\/g, "/");
      await assert.rejects(() => store.read(activePath));
      const { fm } = await store.read(archivePath);
      assert.equal(fm.state, "archive");
      assert.equal(fm.frozen, true);
      assert.equal(fm.archive_mode, "force");
      assert.equal(fm.task_type, "force_archive");
      assert.equal(fm.lifecycle_projection, "archive");
      assert.equal(fm.display_status, "archived");
      const transitions = Array.isArray(fm.transitions) ? fm.transitions : [];
      const last = transitions[transitions.length - 1] as Record<string, unknown>;
      assert.equal(last.action, "force_archive_task");
    });
  });

  it("7d. ADMIN mainline normal archive blocked when child still open (CHILD_TASKS_OPEN)", async () => {
    await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
      const mainId = "TASK-20260610-220-ADMIN-to-PM";
      const childId = "TASK-20260610-028-PM-to-DEV";
      await writeTaskAt(lifecycleRoot, "done", `${mainId}.md`, {
        task_id: mainId,
        from: "ADMIN",
        to: "PM",
        driver: "PM",
        done_authority: "ADMIN",
        archive_authority: "ADMIN",
        review_status: "approved",
        thread_key: "panel-task-220",
      });
      await writeTaskAt(lifecycleRoot, "inbox", `${childId}.md`, {
        task_id: childId,
        from: "PM",
        to: "DEV",
        parent: "TASK-20260610-220",
        thread_key: "panel-task-210",
        state: "dispatched",
      });
      const ledgerDir = join(rootDir, "fcop", "ledger");
      await mkdir(ledgerDir, { recursive: true });
      await writeFile(
        join(ledgerDir, "threads.jsonl"),
        `${JSON.stringify({
          thread_key: "panel-task-220",
          root_task_id: mainId,
          task_ids: [mainId, childId],
        })}\n`,
        "utf-8",
      );

      const sm = new LifecycleStateMachine({ lifecycleRoot });
      await assert.rejects(
        () =>
          sm.archiveTask({
            taskId: mainId,
            actor: "ADMIN",
            reason: "主线验收",
          }),
        (err: unknown) => {
          assert.ok(err instanceof ChildTasksOpenError);
          assert.equal(err.code, "CHILD_TASKS_OPEN");
          assert.equal(err.openChildren.length, 1);
          assert.equal(err.openChildren[0]!.task_id, "TASK-20260610-028");
          return true;
        },
      );
    });
  });

  it("7e. ADMIN mainline force archive terminates open children with residue marks", async () => {
    await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
      const mainId = "TASK-20260610-220-ADMIN-to-PM";
      const childId = "TASK-20260610-031-PM-to-DEV";
      await writeTaskAt(lifecycleRoot, "active", `${mainId}.md`, {
        task_id: mainId,
        from: "ADMIN",
        to: "PM",
        driver: "PM",
        done_authority: "ADMIN",
        archive_authority: "ADMIN",
        thread_key: "panel-task-220",
        state: "active",
      });
      await writeTaskAt(lifecycleRoot, "inbox", `${childId}.md`, {
        task_id: childId,
        from: "PM",
        to: "DEV",
        parent: "TASK-20260610-220",
        thread_key: "panel-task-211",
      });
      const ledgerDir = join(rootDir, "fcop", "ledger");
      await mkdir(ledgerDir, { recursive: true });
      await writeFile(join(ledgerDir, "threads.jsonl"), "", "utf-8");

      const sm = new LifecycleStateMachine({ lifecycleRoot });
      await sm.archiveTask({
        taskId: mainId,
        actor: "ADMIN",
        reason: "作废并终止子任务",
        force: true,
      });

      const store = new TaskFrontmatterStore();
      const childPath = `${lifecycleRoot}/archive/${childId}.md`.replace(/\\/g, "/");
      const { fm } = await store.read(childPath);
      assert.equal(fm.terminated_by_parent_archive, true);
      assert.equal(fm.closed_parent_residue, true);
      assert.equal(fm.display_status, "closed_parent_residue");
      const transitions = Array.isArray(fm.transitions) ? fm.transitions : [];
      const term = transitions.find(
        (t) =>
          (t as Record<string, unknown>).action === "terminate_by_parent_archive",
      ) as Record<string, unknown> | undefined;
      assert.ok(term);
    });
  });

  it("7f. ADMIN mainline archive leaves settled done child in done/", async () => {
    await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
      const mainId = "TASK-20260610-220-ADMIN-to-PM";
      const childId = "TASK-20260610-040-PM-to-DEV";
      await writeTaskAt(lifecycleRoot, "done", `${mainId}.md`, {
        task_id: mainId,
        from: "ADMIN",
        to: "PM",
        driver: "PM",
        done_authority: "ADMIN",
        archive_authority: "ADMIN",
        review_status: "approved",
        thread_key: "panel-task-220",
      });
      await writeTaskAt(lifecycleRoot, "done", `${childId}.md`, {
        task_id: childId,
        from: "PM",
        to: "DEV",
        parent: "TASK-20260610-220",
        thread_key: "panel-task-220",
        review_status: "approved",
        display_status: "done",
      });

      const layout = resolveLedgerLayout(rootDir);
      await mkdir(layout.reportsDir, { recursive: true });
      await writeFile(
        join(layout.reportsDir, "REPORT-20260610-110-DEV-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "DEV",
            recipient: "PM",
            task_id: childId,
            status: "done",
            references: [childId],
          },
          "## 结论\n\n完成实现。\n\n## 详情\n- tests pass\n",
        ),
        "utf-8",
      );
      const builder = new LedgerBuilder({ projectRoot: rootDir });
      await builder.rebuild();

      const sm = new LifecycleStateMachine({ lifecycleRoot });
      await sm.archiveTask({
        taskId: mainId,
        actor: "ADMIN",
        reason: "主线验收",
      });

      const store = new TaskFrontmatterStore();
      const childPath = `${lifecycleRoot}/done/${childId}.md`.replace(/\\/g, "/");
      const { fm } = await store.read(childPath);
      assert.equal(fm.display_status, "done");
      assert.equal(fm.archived_by_parent_mainline, undefined);
    });
  });

  it("7f2. approved child no longer blocks mainline archive", async () => {
    await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
      const mainId = "TASK-20260610-220-ADMIN-to-PM";
      const childId = "TASK-20260610-042-PM-to-DEV";
      await writeTaskAt(lifecycleRoot, "done", `${mainId}.md`, {
        task_id: mainId,
        from: "ADMIN",
        to: "PM",
        driver: "PM",
        done_authority: "ADMIN",
        archive_authority: "ADMIN",
        review_status: "approved",
        thread_key: "panel-task-220",
      });
      await writeTaskAt(lifecycleRoot, "review", `${childId}.md`, {
        task_id: childId,
        from: "PM",
        to: "DEV",
        parent: "TASK-20260610-220",
        thread_key: "panel-task-220",
        driver: "DEV",
        done_authority: "PM",
        review_status: "pending",
        lifecycle_projection: "review",
        display_status: "pending_pm_review",
      });

      const layout = resolveLedgerLayout(rootDir);
      await mkdir(layout.reportsDir, { recursive: true });
      await writeFile(
        join(layout.reportsDir, "REPORT-20260610-111-DEV-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "DEV",
            recipient: "PM",
            task_id: childId,
            status: "done",
            references: [childId],
          },
          "## 结论\n\n完成实现。\n\n## 详情\n- tests pass\n",
        ),
        "utf-8",
      );
      const builder = new LedgerBuilder({ projectRoot: rootDir });
      await builder.rebuild();

      const sm = new LifecycleStateMachine({ lifecycleRoot });
      await sm.approveReview({ taskId: childId, actor: "PM" });

      const store = new TaskFrontmatterStore();
      const childDonePath = `${lifecycleRoot}/done/${childId}.md`.replace(/\\/g, "/");
      const { fm: childFm } = await store.read(childDonePath);
      assert.equal(childFm.lifecycle_projection, "done");
      assert.equal(childFm.review_status, "approved");

      await sm.archiveTask({
        taskId: mainId,
        actor: "ADMIN",
        reason: "主线验收",
      });

      const childDonePathAfterArchive = `${lifecycleRoot}/done/${childId}.md`.replace(/\\/g, "/");
      const { fm } = await store.read(childDonePathAfterArchive);
      assert.equal(fm.lifecycle_projection, "done");
      assert.equal(fm.archived_by_parent_mainline, undefined);
    });
  });

  it("7g. references and thread_key do not block archive without parent", async () => {
    await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
      const mainId = "TASK-20260610-220-ADMIN-to-PM";
      const childId = "TASK-20260610-041-PM-to-DEV";
      await writeTaskAt(lifecycleRoot, "done", `${mainId}.md`, {
        task_id: mainId,
        from: "ADMIN",
        to: "PM",
        driver: "PM",
        done_authority: "ADMIN",
        archive_authority: "ADMIN",
        review_status: "approved",
        thread_key: "panel-task-220",
      });
      await writeTaskAt(lifecycleRoot, "inbox", `${childId}.md`, {
        task_id: childId,
        from: "PM",
        to: "DEV",
        thread_key: "panel-task-220",
        references: [mainId],
      });

      const builder = new LedgerBuilder({ projectRoot: rootDir });
      await builder.rebuild();

      const sm = new LifecycleStateMachine({ lifecycleRoot });
      const result = await sm.archiveTask({
        taskId: mainId,
        actor: "ADMIN",
        reason: "主线验收",
      });
      assert.equal(result.to, "archive");
    });
  });

  it("runtimeDispatchInboxToActive does not duplicate identical transition", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskId = "TASK-20260530-016e-ADMIN-to-PM";
      const inboxPath = await writeTaskAt(lifecycleRoot, "inbox", `${taskId}.md`, {
        task_id: taskId,
        from: "ADMIN",
        to: "PM",
        state: "inbox",
      });
      await new TaskFrontmatterStore().write(
        inboxPath,
        {
          task_id: taskId,
          from: "ADMIN",
          to: "PM",
          state: "inbox",
          transitions: [
            {
              at: "2026-06-12T00:00:00+08:00",
              from: "inbox",
              to: "active",
              by: "CodeFlowMu",
              action: "runtime_dispatch",
            },
          ],
        },
        "# Task\n",
      );

      const sm = new LifecycleStateMachine({ lifecycleRoot });
      await sm.runtimeDispatchInboxToActive(inboxPath);
      const activePath = `${lifecycleRoot}/active/${taskId}.md`.replace(/\\/g, "/");
      const { fm } = await new TaskFrontmatterStore().read(activePath);
      assert.equal(fm.transitions?.length, 1);
    });
  });

  it("runtimeRestoreActiveToInbox moves file back to inbox with transition record", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskId = "TASK-20260530-016d-ADMIN-to-PM";
      const inboxPath = await writeTaskAt(lifecycleRoot, "inbox", `${taskId}.md`, {
        task_id: taskId,
        from: "ADMIN",
        to: "PM",
        state: "inbox",
      });

      const sm = new LifecycleStateMachine({ lifecycleRoot });
      await sm.runtimeDispatchInboxToActive(inboxPath);
      const activePath = `${lifecycleRoot}/active/${taskId}.md`.replace(/\\/g, "/");
      await new TaskFrontmatterStore().patch(activePath, { state: "dispatched" });
      await sm.runtimeRestoreActiveToInbox(activePath, "session_failed");

      const store = new TaskFrontmatterStore();
      await assert.rejects(() => store.read(activePath));
      const { fm } = await store.read(inboxPath);
      assert.equal(fm.state, "inbox");
      const last = fm.transitions?.[fm.transitions.length - 1];
      assert.equal(last?.from, "active");
      assert.equal(last?.to, "inbox");
      assert.equal(last?.action, "runtime_restore_failed_dispatch");
    });
  });

  it("8. archive → active 被拒", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskId = "TASK-20260530-017-PM-to-OPS";
      await writeTaskAt(lifecycleRoot, "archive", `${taskId}.md`, {
        task_id: taskId,
        frozen: true,
        state: "archive",
        reviewer: "PM",
        done_authority: "PM",
      });

      const sm = new LifecycleStateMachine({ lifecycleRoot });
      await assert.rejects(
        () =>
          sm.reopenTask({
            taskId,
            actor: "PM",
            reason: "不应成功",
          }),
        /frozen/,
      );
    });
  });
});

describe("finishTaskLegacy", () => {
  it("1. active 状态 finish_task 被拒", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskId = "TASK-20260530-020-PM-to-OPS";
      await writeTaskAt(lifecycleRoot, "active", `${taskId}.md`, {
        task_id: taskId,
        driver: "OPS",
        done_authority: "PM",
      });
      const sm = new LifecycleStateMachine({ lifecycleRoot });
      await assert.rejects(
        () => sm.finishTaskLegacy({ taskId, actor: "PM" }),
        /submit_review first/,
      );
    });
  });

  it("2. review 状态 actor == done_authority 时 finish_task 映射 approve_review", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskId = "TASK-20260530-021-PM-to-OPS";
      await writeTaskAt(lifecycleRoot, "review", `${taskId}.md`, {
        task_id: taskId,
        done_authority: "PM",
        archive_authority: "PM",
      });
      const sm = new LifecycleStateMachine({ lifecycleRoot });
      const result = await sm.finishTaskLegacy({ taskId, actor: "PM" });
      assert.equal(result.to, "done");
    });
  });

  it("3. review 状态 actor != done_authority 时 finish_task 被拒", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskId = "TASK-20260530-022-PM-to-OPS";
      await writeTaskAt(lifecycleRoot, "review", `${taskId}.md`, {
        task_id: taskId,
        done_authority: "PM",
      });
      const sm = new LifecycleStateMachine({ lifecycleRoot });
      await assert.rejects(
        () => sm.finishTaskLegacy({ taskId, actor: "OPS" }),
        /not done_authority/,
      );
    });
  });

  it("4. done 状态 finish_task 被拒", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskId = "TASK-20260530-023-PM-to-OPS";
      await writeTaskAt(lifecycleRoot, "done", `${taskId}.md`, {
        task_id: taskId,
        done_authority: "PM",
      });
      const sm = new LifecycleStateMachine({ lifecycleRoot });
      await assert.rejects(
        () => sm.finishTaskLegacy({ taskId, actor: "PM" }),
        /use archive_task/,
      );
    });
  });

  it("5. archive 状态 finish_task 被拒", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskId = "TASK-20260530-024-PM-to-OPS";
      await writeTaskAt(lifecycleRoot, "archive", `${taskId}.md`, {
        task_id: taskId,
        frozen: true,
        done_authority: "PM",
      });
      const sm = new LifecycleStateMachine({ lifecycleRoot });
      await assert.rejects(
        () => sm.finishTaskLegacy({ taskId, actor: "PM" }),
        /frozen/,
      );
    });
  });
});
