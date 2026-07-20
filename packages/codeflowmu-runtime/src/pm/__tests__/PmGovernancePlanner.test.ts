import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { taskMarkdown } from "../../lifecycle/__tests__/helpers.ts";
import { LedgerBuilder } from "../../ledger/LedgerBuilder.ts";
import { resolveLedgerLayout } from "../../ledger/paths.ts";
import {
  runPmGovernanceCycle,
  readRecentPmGovernanceCycles,
  flattenRecentPmGovernanceDecisions,
  pmGovernanceCycleJournalPath,
} from "../PmGovernancePlanner.ts";

async function withTempProject(
  fn: (ctx: { root: string }) => Promise<void>,
): Promise<void> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "pm-planner-"));
  try {
    await fn({ root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const THREAD = "panel-home-fcop-reactor";
const ROOT_ADMIN = "TASK-20260531-237-ADMIN-to-PM";
const CHILD_OPS = "TASK-20260531-238-PM-to-OPS";
const OPS_REPORT = "REPORT-20260531-001-OPS-to-PM";

async function writeCloseAdminReadyFixture(
  root: string,
  threadKey: string = THREAD,
): Promise<void> {
  const layout = resolveLedgerLayout(root);
  const activeDir = join(layout.lifecycleRoot, "active");
  const doneDir = join(layout.lifecycleRoot, "done");
  const reportsDir = layout.reportsDir;
  await mkdir(activeDir, { recursive: true });
  await mkdir(doneDir, { recursive: true });
  await mkdir(reportsDir, { recursive: true });

  await writeFile(
    join(activeDir, `${ROOT_ADMIN}.md`),
    taskMarkdown(
      {
        protocol: "fcop",
        version: 1,
        kind: "task",
        sender: "ADMIN",
        recipient: "PM",
        task_id: ROOT_ADMIN,
        thread_key: threadKey,
      },
      "# Main\n",
    ),
    "utf-8",
  );
  await writeFile(
    join(doneDir, `${CHILD_OPS}.md`),
    taskMarkdown(
      {
        protocol: "fcop",
        version: 1,
        kind: "task",
        sender: "PM",
        recipient: "OPS",
        task_id: CHILD_OPS,
        thread_key: threadKey,
        parent: ROOT_ADMIN,
      },
      "# OPS child\n",
    ),
    "utf-8",
  );
  await writeFile(
    join(reportsDir, `${OPS_REPORT}.md`),
    taskMarkdown(
      {
        protocol: "fcop",
        version: 1,
        kind: "report",
        sender: "OPS",
        recipient: "PM",
        task_id: CHILD_OPS,
        thread_key: threadKey,
        status: "done",
        references: [CHILD_OPS],
      },
      "## 结论\n下游已完成\n\n## 证据\n- ok\n",
    ),
    "utf-8",
  );

  const builder = new LedgerBuilder({ projectRoot: root });
  await builder.rebuild();
}

describe("PmGovernancePlanner", () => {
  it("runPmGovernanceCycle emits pending_pm_review → pm.review_check", async () => {
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
          },
          "## 结论\n下游已完成\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      const cycle = await runPmGovernanceCycle(root, { triggered_by: "pm_wake" });
      const review = cycle.decisions.find((d) => d.suggested_skill === "pm.review_check");
      assert.ok(review, "expected pm.review_check decision");
      assert.equal(review!.detected_state, "pending_pm_review");
      assert.equal(review!.thread_key, THREAD);
      assert.ok(review!.task_id);
      assert.equal(review!.can_auto_execute, true);
      assert.equal(review!.requires_confirmation, false);
      assert.ok(review!.evidence_paths.length >= 1);
    });
  });

  it("runPmGovernanceCycle auto-writes PM-to-ADMIN summary on patrol (default)", async () => {
    await withTempProject(async ({ root }) => {
      await writeCloseAdminReadyFixture(root);

      const cycle = await runPmGovernanceCycle(root, { triggered_by: "patrol" });
      const close = cycle.decisions.find((d) => d.suggested_skill === "pm.close_admin_task");
      assert.ok(close, "expected pm.close_admin_task decision");
      assert.equal(close!.detected_state, "ready_to_close_admin");
      assert.equal(close!.requires_confirmation, false);
      assert.equal(close!.can_auto_execute, true);
      assert.equal(close!.outcome, "ok");
      assert.equal(close!.persisted, true);
      assert.ok(close!.persist_path?.endsWith(".md"));

      const layout = resolveLedgerLayout(root);
      const reportFiles = await readdir(layout.reportsDir);
      assert.ok(
        reportFiles.some((f) => /^REPORT-\d{8}-\d{3,}-PM-to-ADMIN(-[a-z][a-z0-9-]*)?\.md$/i.test(f)),
        "expected PM-to-ADMIN report on disk",
      );
      const rootRaw = await readFile(
        join(layout.lifecycleRoot, "review", `${ROOT_ADMIN}.md`),
        "utf-8",
      );
      assert.match(rootRaw, /review_status:\s*pending/);
      assert.match(rootRaw, /action:\s*submit_review/);
    });
  });

  it("runPmGovernanceCycle persists close_admin JSON draft only when auto_review is false", async () => {
    await withTempProject(async ({ root }) => {
      await writeCloseAdminReadyFixture(root);

      const cycle = await runPmGovernanceCycle(root, {
        triggered_by: "patrol",
        auto_review: false,
      });
      const close = cycle.decisions.find((d) => d.suggested_skill === "pm.close_admin_task");
      assert.ok(close, "expected pm.close_admin_task decision");
      assert.equal(close!.requires_confirmation, true);
      assert.equal(close!.can_auto_execute, false);
      assert.equal(close!.persisted, true);
      assert.ok(close!.persist_path?.endsWith(".json"));
    });
  });

  it("runPmGovernanceCycle skips duplicate PM-to-ADMIN summary", async () => {
    await withTempProject(async ({ root }) => {
      await writeCloseAdminReadyFixture(root);

      const first = await runPmGovernanceCycle(root, { triggered_by: "patrol" });
      const firstClose = first.decisions.find(
        (d) => d.suggested_skill === "pm.close_admin_task",
      );
      assert.ok(firstClose);
      assert.equal(firstClose!.outcome, "ok");
      assert.equal(firstClose!.persisted, true);

      const second = await runPmGovernanceCycle(root, { triggered_by: "patrol" });
      const secondClose = second.decisions.find(
        (d) => d.suggested_skill === "pm.close_admin_task",
      );
      assert.ok(secondClose);
      assert.equal(secondClose!.outcome, "skipped");
      assert.match(secondClose!.summary ?? "", /总报告|pm_admin_final_already_exists/);
    });
  });

  it("runPmGovernanceCycle suggests wake for legacy tasks/ bucket missing_report", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const activeDir = join(layout.lifecycleRoot, "active");
      const legacyTasksDir = layout.tasksDir;
      await mkdir(activeDir, { recursive: true });
      await mkdir(legacyTasksDir, { recursive: true });

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
          "# ADMIN task 240\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(legacyTasksDir, "TASK-20260601-001-PM-to-DEV.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "DEV",
            task_id: "TASK-20260601-001",
            thread_key: "panel-task-240",
          },
          "# Dev work\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      const cycle = await runPmGovernanceCycle(root, { triggered_by: "pm_wake" });
      const wake = cycle.decisions.find(
        (d) =>
          d.thread_key === "panel-task-240" &&
          d.suggested_skill === "pm.wake_downstream",
      );
      assert.ok(wake, "expected pm.wake_downstream for panel-task-240");
      assert.equal(wake!.detected_state, "missing_report");
      assert.equal(wake!.task_id, "TASK-20260601-001");
      assert.equal(wake!.requires_confirmation, true);
      assert.equal(wake!.can_auto_execute, false);
      assert.equal(wake!.safety_level, "suggest_only");
      for (const key of [
        "thread_key",
        "task_id",
        "detected_state",
        "suggested_skill",
        "reason",
        "safety_level",
        "requires_confirmation",
        "can_auto_execute",
        "evidence_paths",
      ] as const) {
        assert.ok(key in wake!, `decision missing ${key}`);
      }
      assert.ok(wake!.evidence_paths.length >= 1);
    });
  });

  it("runPmGovernanceCycle suggests wake for missing_report without auto execute", async () => {
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

      const cycle = await runPmGovernanceCycle(root, { triggered_by: "api" });
      const wake = cycle.decisions.find((d) => d.suggested_skill === "pm.wake_downstream");
      assert.ok(wake, "expected pm.wake_downstream decision");
      assert.equal(wake!.detected_state, "missing_report");
      assert.equal(wake!.requires_confirmation, true);
      assert.equal(wake!.can_auto_execute, false);
      assert.equal(wake!.persisted, false);
    });
  });

  it("runPmGovernanceCycle auto-wakes when executor + allow_auto_wake", async () => {
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

      let wakeCalls = 0;
      const cycle = await runPmGovernanceCycle(root, {
        triggered_by: "pm_wake",
        allow_auto_wake: true,
        wake_downstream: async (req) => {
          wakeCalls += 1;
          assert.equal(req.task_id, "TASK-20260531-238");
          return { ok: true, session_id: "sess-test-01", agent_id: req.agent_id };
        },
      });

      const wake = cycle.decisions.find((d) => d.suggested_skill === "pm.wake_downstream");
      assert.ok(wake, "expected pm.wake_downstream decision");
      assert.equal(wake!.detected_state, "missing_report");
      assert.equal(wakeCalls, 1, "executor should be invoked once");
      const judgment = cycle.judgments.find((j) => j.skill_id === "pm.wake_downstream");
      assert.ok(judgment);
      assert.equal(judgment!.mode, "executed");
      assert.match(judgment!.summary, /已直接唤醒/);
    });
  });

  it("does not review or mark attention when wake is skipped without a REPORT", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const activeDir = join(layout.lifecycleRoot, "active");
      await mkdir(activeDir, { recursive: true });
      const taskId = "TASK-20260531-239-PM-to-DEV";
      const taskPath = join(activeDir, `${taskId}.md`);
      await writeFile(
        taskPath,
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "DEV",
            task_id: taskId,
            thread_key: THREAD,
          },
          "# Dev work\n",
        ),
        "utf-8",
      );
      await new LedgerBuilder({ projectRoot: root }).rebuild();

      const cycle = await runPmGovernanceCycle(root, {
        triggered_by: "pm_wake",
        allow_auto_wake: true,
        wake_downstream: async () => ({
          ok: true,
          skipped: true,
          reason: "already_running",
          agent_id: "DEV-01",
        }),
      });

      const judgment = cycle.judgments.find(
        (item) => item.skill_id === "pm.wake_downstream",
      );
      assert.ok(judgment);
      assert.equal(judgment!.outcome, "skipped");
      assert.match(judgment!.summary, /AI 已在运行/);
      const raw = await readFile(taskPath, "utf-8");
      assert.doesNotMatch(raw, /waiting_pm_attention/);
    });
  });

  it("runPmGovernanceCycle wakes PM intake while selecting REPORT review", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const activeDir = join(layout.lifecycleRoot, "active");
      const reportsDir = layout.reportsDir;
      await mkdir(activeDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });

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
        join(reportsDir, "REPORT-20260531-001-DEV-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "DEV",
            recipient: "PM",
            task_id: "TASK-20260531-238-PM-to-DEV",
            thread_key: THREAD,
            status: "done",
          },
          "## 结论\n已完成\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      let wakeCalls = 0;
      const cycle = await runPmGovernanceCycle(root, {
        triggered_by: "api",
        allow_auto_wake: true,
        wake_downstream: async () => {
          wakeCalls += 1;
          return { ok: true, session_id: "should-not-run" };
        },
      });

      assert.equal(wakeCalls, 1, "PM intake AI should inspect the arrived report");
      const wake = cycle.decisions.find((d) => d.suggested_skill === "pm.wake_downstream");
      assert.equal(wake, undefined, "missing_report 不应出现，故无 wake_downstream");
      const review = cycle.decisions.find((d) => d.suggested_skill === "pm.review_check");
      assert.ok(review, "expected pm.review_check when REPORT on disk");
      assert.equal(review!.detected_state, "pending_pm_review");
      assert.equal(review!.task_id, "TASK-20260531-238");
    });
  });

  it("flattenRecentPmGovernanceDecisions reads journal newest-first", async () => {
    await withTempProject(async ({ root }) => {
      await runPmGovernanceCycle(root, { triggered_by: "pm_wake", max_threads: 1 });
      await runPmGovernanceCycle(root, { triggered_by: "patrol", max_threads: 1 });

      const cycles = await readRecentPmGovernanceCycles(root, 5);
      assert.ok(cycles.length >= 2);
      assert.equal(cycles[0]!.triggered_by, "patrol");

      const flat = flattenRecentPmGovernanceDecisions(cycles, 10);
      assert.ok(flat.length >= 0);

      const journal = pmGovernanceCycleJournalPath(root);
      const raw = await import("node:fs/promises").then((fs) => fs.readFile(journal, "utf-8"));
      assert.ok(raw.includes('"cycle_id"'));
    });
  });

  it("runPmGovernanceCycle emits ready_to_close_admin when PM-to-ADMIN report exists", async () => {
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
            task_id: "TASK-20260531-240",
            thread_key: "panel-task-240",
          },
          "# Main\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, "REPORT-20260601-002-DEV-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "DEV",
            recipient: "PM",
            task_id: "TASK-20260601-001-PM-to-DEV",
            thread_key: "panel-task-240",
            status: "done",
          },
          "## 结论\nDEV 已完成\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, "REPORT-20260601-006-PM-to-ADMIN.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "report",
            sender: "PM",
            recipient: "ADMIN",
            task_id: "TASK-20260531-240",
            thread_key: "panel-task-240",
            status: "done",
          },
          "## 关单\n已汇总\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      const cycle = await runPmGovernanceCycle(root, { triggered_by: "api" });
      const close = cycle.decisions.find(
        (d) => d.suggested_skill === "pm.close_admin_task" && d.thread_key === "panel-task-240",
      );
      assert.ok(close, "expected pm.close_admin_task for panel-task-240");
      assert.equal(close!.detected_state, "ready_to_close_admin");
      assert.equal(close!.outcome, "skipped");
      assert.match(close!.summary ?? "", /总报告|pm_admin_final_already_exists/);
    });
  });
});
