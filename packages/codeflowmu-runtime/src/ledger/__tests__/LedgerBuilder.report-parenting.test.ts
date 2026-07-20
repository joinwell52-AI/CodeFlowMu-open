import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { taskMarkdown } from "../../lifecycle/__tests__/helpers.ts";
import { LedgerBuilder } from "../LedgerBuilder.ts";
import { ensureLedgerLayout, resolveLedgerLayout } from "../paths.ts";
import {
  applyReportParenting,
  classifyReportKind,
  isPmAdminFinalSummaryReport,
  resolveThreadBucketKey,
} from "../reportParenting.ts";
import type { LedgerReportRecord, LedgerTaskRecord } from "../types.ts";

async function withTempProject(
  fn: (ctx: { root: string }) => Promise<void>,
): Promise<void> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "ledger-report-parenting-"));
  try {
    await ensureLedgerLayout(root);
    await fn({ root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const THREAD = "report-parenting-mvp";
const ROOT = "TASK-20260610-001-ADMIN-to-PM";
const OPS = "TASK-20260610-002-PM-to-OPS";

function baseTask(overrides: Partial<LedgerTaskRecord>): LedgerTaskRecord {
  return {
    task_id: ROOT,
    filename: `${ROOT}.md`,
    sender: "ADMIN",
    recipient: "PM",
    bucket: "active",
    path: "",
    created_at: "2026-06-10T10:00:00+08:00",
    updated_at: "2026-06-10T10:00:00+08:00",
    timezone: "Asia/Shanghai",
    created_at_utc: "2026-06-10T02:00:00Z",
    thread_key: THREAD,
    ...overrides,
  };
}

function baseReport(overrides: Partial<LedgerReportRecord>): LedgerReportRecord {
  return {
    report_id: "REPORT-20260610-001-PM-to-ADMIN",
    task_id: ROOT,
    filename: "REPORT-20260610-001-PM-to-ADMIN.md",
    sender: "PM",
    recipient: "ADMIN",
    status: "done",
    path: "",
    created_at: "2026-06-10T11:00:00+08:00",
    updated_at: "2026-06-10T11:00:00+08:00",
    timezone: "Asia/Shanghai",
    created_at_utc: "2026-06-10T03:00:00Z",
    thread_key: THREAD,
    ...overrides,
  };
}

describe("reportParenting unit", () => {
  const tasks: LedgerTaskRecord[] = [
    baseTask({}),
    baseTask({
      task_id: OPS,
      filename: `${OPS}.md`,
      sender: "PM",
      recipient: "OPS",
      parent: ROOT,
      bucket: "done",
    }),
  ];

  it("PM-to-ADMIN final recognizes terminal status and root task_id", () => {
    const ack = baseReport({
      report_id: "REPORT-20260610-004-PM-to-ADMIN",
      filename: "REPORT-20260610-004-PM-to-ADMIN.md",
      status: "",
      task_id: ROOT,
    });
    assert.equal(classifyReportKind(ack, "已收到任务，正在分析并派发。"), "pm_to_admin_ack");
    assert.equal(isPmAdminFinalSummaryReport(ROOT, ack, "已收到任务，正在分析并派发。"), false);

    const final = baseReport({
      report_id: "REPORT-20260610-005-PM-to-ADMIN",
      filename: "REPORT-20260610-005-PM-to-ADMIN.md",
      status: "done",
      task_id: ROOT,
      report_type: "final_summary",
      final: true,
      references: [ROOT, OPS],
    });
    assert.equal(classifyReportKind(final, "## 结论\n全部子任务已完成。"), "pm_to_admin_final");
    assert.equal(isPmAdminFinalSummaryReport(ROOT, final, "## 结论\n全部子任务已完成。"), true);

    const blockedBody = "## 结论\n子任务阻塞\n\n## 证据\n- OPS blocked\n";
    const blocked = baseReport({
      report_id: "REPORT-20260609-006-PM-to-ADMIN",
      filename: "REPORT-20260609-006-PM-to-ADMIN.md",
      status: "blocked",
      task_id: ROOT,
      references: [ROOT, OPS],
    });
    assert.equal(classifyReportKind(blocked, blockedBody), "pm_to_admin_final");
    assert.equal(isPmAdminFinalSummaryReport(ROOT, blocked, blockedBody), true);

    const needsAdmin = baseReport({
      report_id: "REPORT-20260610-008-PM-to-ADMIN",
      filename: "REPORT-20260610-008-PM-to-ADMIN.md",
      status: "needs_admin",
      task_id: ROOT,
      report_type: "final_summary",
      final: true,
      references: [ROOT],
    });
    assert.equal(
      classifyReportKind(needsAdmin, "## 结论\n需 ADMIN 决策"),
      "pm_to_admin_final",
    );
    assert.equal(
      isPmAdminFinalSummaryReport(ROOT, needsAdmin, "## 结论\n需 ADMIN 决策"),
      true,
    );

    const inProgress = baseReport({
      report_id: "REPORT-20260610-009-PM-to-ADMIN",
      filename: "REPORT-20260610-009-PM-to-ADMIN.md",
      status: "in_progress",
      task_id: ROOT,
      references: [ROOT],
    });
    assert.equal(
      classifyReportKind(inProgress, "## 进展\n派发中"),
      "pm_to_admin_in_progress",
    );
    assert.equal(
      isPmAdminFinalSummaryReport(ROOT, inProgress, "## 进展\n派发中"),
      false,
    );
  });

  it("applyReportParenting pins worker-to-PM under PM→OPS child", () => {
    const worker = baseReport({
      report_id: "REPORT-20260610-003-OPS-to-PM",
      filename: "REPORT-20260610-003-OPS-to-PM.md",
      sender: "OPS",
      recipient: "PM",
      status: "done",
      task_id: OPS,
      references: [OPS],
    });
    const [parented = worker] = applyReportParenting([worker], tasks);
    assert.equal(parented.parent_task_id, OPS);
    assert.equal(parented.report_kind, "worker_to_pm");
  });

  it("applyReportParenting pins worker-to-PM by report date sequence when task_id is missing", () => {
    const devTask = baseTask({
      task_id: "TASK-20260610-003-PM-to-DEV",
      filename: "TASK-20260610-003-PM-to-DEV.md",
      sender: "PM",
      recipient: "DEV",
      parent: ROOT,
      bucket: "active",
    });
    const worker = baseReport({
      report_id: "REPORT-20260610-003-DEV-to-PM",
      filename: "REPORT-20260610-003-DEV-to-PM.md",
      sender: "DEV",
      recipient: "PM",
      status: "done",
      task_id: "",
      references: [],
    });

    const [parented = worker] = applyReportParenting([worker], [...tasks, devTask]);

    assert.equal(parented.task_id, devTask.task_id);
    assert.equal(parented.parent_task_id, devTask.task_id);
    assert.equal(parented.report_kind, "worker_to_pm");
  });

  it("keeps a rework REPORT on its explicit task when references mention rejected predecessors", () => {
    const rejected = baseTask({
      task_id: "TASK-20260712-905",
      filename: "TASK-20260712-905-PM-to-QA.md",
      sender: "PM",
      recipient: "QA",
      bucket: "active",
    });
    const rework = baseTask({
      task_id: "TASK-20260712-908",
      filename: "TASK-20260712-908-PM-to-QA.md",
      sender: "PM",
      recipient: "QA",
      bucket: "active",
    });
    const report = baseReport({
      report_id: "REPORT-20260712-032-QA-to-PM",
      filename: "REPORT-20260712-032-QA-to-PM.md",
      sender: "QA",
      recipient: "PM",
      task_id: "TASK-20260712-908",
      source_task_id: "TASK-20260712-908",
      references: ["TASK-20260712-908", "TASK-20260712-905"],
    });

    const [parented = report] = applyReportParenting(
      [report],
      [rejected, rework],
      {
        reportBodies: new Map([
          [
            report.report_id,
            "ADMIN 打回 TASK-20260712-905；本轮返工 TASK-20260712-908 验收通过。",
          ],
        ]),
      },
    );

    assert.equal(parented.task_id, "TASK-20260712-908");
    assert.equal(parented.parent_task_id, "TASK-20260712-908");
    assert.ok(parented.linked_task_ids?.includes("TASK-20260712-905"));
  });

  it("applyReportParenting pins taskless worker-to-PM to recent open child", () => {
    const oldQaTask = baseTask({
      task_id: "TASK-20260609-002-PM-to-QA",
      filename: "TASK-20260609-002-PM-to-QA.md",
      sender: "PM",
      recipient: "QA",
      parent: "TASK-20260609-001-ADMIN-to-PM",
      bucket: "done",
      display_status: "done",
      created_at: "2026-06-09T10:00:00+08:00",
      created_at_utc: "2026-06-09T02:00:00Z",
    });
    const currentQaTask = baseTask({
      task_id: "TASK-20260610-008-PM-to-QA",
      filename: "TASK-20260610-008-PM-to-QA.md",
      sender: "PM",
      recipient: "QA",
      parent: ROOT,
      bucket: "active",
      display_status: "waiting_pm_attention",
      created_at: "2026-06-10T10:24:00+08:00",
      created_at_utc: "2026-06-10T02:24:00Z",
    });
    const worker = baseReport({
      report_id: "REPORT-20260610-013-QA-to-PM",
      filename: "REPORT-20260610-013-QA-to-PM.md",
      sender: "QA",
      recipient: "PM",
      status: "done",
      task_id: "",
      references: [],
      created_at: "2026-06-10T10:26:00+08:00",
      created_at_utc: "2026-06-10T02:26:00Z",
    });

    const [parented = worker] = applyReportParenting(
      [worker],
      [...tasks, oldQaTask, currentQaTask],
    );

    assert.equal(parented.task_id, currentQaTask.task_id);
    assert.equal(parented.parent_task_id, currentQaTask.task_id);
    assert.equal(parented.report_kind, "worker_to_pm");
  });

  it("applyReportParenting uses body overlap before stale open task fallback", () => {
    const oldDevTask = baseTask({
      task_id: "TASK-20260610-004-PM-to-DEV",
      filename: "TASK-20260610-004-PM-to-DEV.md",
      path: "fcop/_lifecycle/active/TASK-20260610-004-PM-to-DEV.md",
      sender: "PM",
      recipient: "DEV",
      parent: "TASK-20260610-004-ADMIN-to-PM",
      bucket: "active",
      display_status: "waiting_pm_attention",
      created_at: "2026-06-10T10:10:00+08:00",
      created_at_utc: "2026-06-10T02:10:00Z",
    });
    const currentDevTask = baseTask({
      task_id: "TASK-20260610-007-PM-to-DEV",
      filename: "TASK-20260610-007-PM-to-DEV.md",
      path: "fcop/_lifecycle/done/TASK-20260610-007-PM-to-DEV.md",
      sender: "PM",
      recipient: "DEV",
      parent: ROOT,
      bucket: "done",
      display_status: "done",
      created_at: "2026-06-10T10:22:00+08:00",
      created_at_utc: "2026-06-10T02:22:00Z",
    });
    const worker = baseReport({
      report_id: "REPORT-20260610-012-DEV-to-PM",
      filename: "REPORT-20260610-012-DEV-to-PM.md",
      path: "fcop/reports/REPORT-20260610-012-DEV-to-PM.md",
      sender: "DEV",
      recipient: "PM",
      status: "done",
      task_id: "",
      references: [],
      created_at: "2026-06-10T10:24:00+08:00",
      created_at_utc: "2026-06-10T02:24:00Z",
    });

    const [parented = worker] = applyReportParenting(
      [worker],
      [...tasks, oldDevTask, currentDevTask],
      {
        reportBodies: new Map([
          [
            worker.path,
            "Delivered mini-game-flow-test with index.html style.css game.js README.md v1.",
          ],
        ]),
        taskBodies: new Map([
          [
            oldDevTask.path,
            "Create report-resolver smoke file codex-mother-smoke-report-resolver.txt.",
          ],
          [
            currentDevTask.path,
            "Build mini-game-flow-test v1 browser game using index.html style.css game.js README.md.",
          ],
        ]),
      },
    );

    assert.equal(parented.task_id, currentDevTask.task_id);
    assert.equal(parented.parent_task_id, currentDevTask.task_id);
    assert.equal(parented.report_kind, "worker_to_pm");
  });

  it("applyReportParenting pins worker-to-PM to child when body mentions root before child", () => {
    const devTask = baseTask({
      task_id: "TASK-20260610-003-PM-to-DEV",
      filename: "TASK-20260610-003-PM-to-DEV.md",
      sender: "PM",
      recipient: "DEV",
      parent: ROOT,
      bucket: "active",
    });
    const worker = baseReport({
      report_id: "REPORT-20260610-007-DEV-to-PM",
      filename: "REPORT-20260610-007-DEV-to-PM.md",
      sender: "DEV",
      recipient: "PM",
      status: "done",
      task_id: "TASK-20260610-001",
      references: [],
    });

    const [parented = worker] = applyReportParenting([worker], [...tasks, devTask], {
      reportBodies: new Map([
        [
          worker.path,
          "references: TASK-20260610-001 then TASK-20260610-003",
        ],
      ]),
    });

    assert.equal(parented.task_id, devTask.task_id);
    assert.equal(parented.parent_task_id, devTask.task_id);
    assert.equal(parented.report_kind, "worker_to_pm");
  });

  it("applyReportParenting pins PM-to-ADMIN under ADMIN root even when task_id points at OPS child", () => {
    const pmAdmin = baseReport({
      report_id: "REPORT-20260610-006-PM-to-ADMIN",
      filename: "REPORT-20260610-006-PM-to-ADMIN.md",
      status: "done",
      task_id: OPS,
      references: [OPS],
    });
    const [parented = pmAdmin] = applyReportParenting([pmAdmin], tasks, {
      reportBodies: new Map([
        [pmAdmin.path, "## 结论\nPM 总报告\n\n## 证据\n- 子任务完成"],
      ]),
    });
    assert.equal(parented.parent_task_id, ROOT);
    assert.notEqual(parented.parent_task_id, OPS);
    assert.equal(parented.report_kind, "pm_to_admin_final");
  });

  it("same thread_key with two ADMIN roots: old PM final does not bind to new root", () => {
    const PANEL = "panel-task-005";
    const ROOT_OLD = "TASK-20260608-005-ADMIN-to-PM";
    const ROOT_NEW = "TASK-20260609-005-ADMIN-to-PM";
    const dualTasks: LedgerTaskRecord[] = [
      baseTask({
        task_id: ROOT_OLD,
        filename: `${ROOT_OLD}.md`,
        thread_key: PANEL,
        bucket: "done",
      }),
      baseTask({
        task_id: ROOT_NEW,
        filename: `${ROOT_NEW}.md`,
        thread_key: PANEL,
        bucket: "active",
      }),
    ];
    const oldFinal = baseReport({
      report_id: "REPORT-20260608-006-PM-to-ADMIN",
      filename: "REPORT-20260608-006-PM-to-ADMIN.md",
      task_id: ROOT_OLD,
      thread_key: PANEL,
      status: "done",
      references: [ROOT_OLD],
    });

    assert.equal(
      resolveThreadBucketKey(dualTasks[0]!, dualTasks),
      `${PANEL}#TASK-20260608-005`,
    );
    assert.equal(
      resolveThreadBucketKey(dualTasks[1]!, dualTasks),
      `${PANEL}#TASK-20260609-005`,
    );
    assert.equal(isPmAdminFinalSummaryReport(ROOT_NEW, oldFinal), false);
    assert.equal(isPmAdminFinalSummaryReport(ROOT_OLD, oldFinal), true);

    const [parented = oldFinal] = applyReportParenting([oldFinal], dualTasks, {
      reportBodies: new Map([
        [oldFinal.path, "## 结论\n旧主线已完成\n\n## 证据\n- done"],
      ]),
    });
    assert.equal(parented.parent_task_id, ROOT_OLD);
    assert.notEqual(parented.parent_task_id, ROOT_NEW);
  });

  it("mis-typed task_id on old PM final still parents to lineage root via references", () => {
    const PANEL = "panel-task-005";
    const ROOT_OLD = "TASK-20260608-005-ADMIN-to-PM";
    const ROOT_NEW = "TASK-20260609-005-ADMIN-to-PM";
    const dualTasks: LedgerTaskRecord[] = [
      baseTask({
        task_id: ROOT_OLD,
        filename: `${ROOT_OLD}.md`,
        thread_key: PANEL,
        bucket: "done",
      }),
      baseTask({
        task_id: ROOT_NEW,
        filename: `${ROOT_NEW}.md`,
        thread_key: PANEL,
        bucket: "active",
      }),
    ];
    const wronglyTyped = baseReport({
      report_id: "REPORT-20260608-006-PM-to-ADMIN",
      filename: "REPORT-20260608-006-PM-to-ADMIN.md",
      task_id: ROOT_NEW,
      thread_key: PANEL,
      status: "done",
      references: [ROOT_OLD],
    });
    const [parented = wronglyTyped] = applyReportParenting([wronglyTyped], dualTasks, {
      reportBodies: new Map([
        [wronglyTyped.path, "## 结论\n旧主线\n\n## 证据\n- x"],
      ]),
    });
    assert.equal(parented.parent_task_id, ROOT_OLD);
    assert.equal(isPmAdminFinalSummaryReport(ROOT_NEW, parented), false);
  });
});

describe("LedgerBuilder report parenting (rebuild)", () => {
  it("PM-to-ADMIN does not hang under PM-to-OPS; OPS-to-PM hangs under PM-to-OPS", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const activeDir = join(layout.lifecycleRoot, "active");
      const doneDir = join(layout.lifecycleRoot, "done");
      const reportsDir = layout.reportsDir;
      await mkdir(activeDir, { recursive: true });
      await mkdir(doneDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });

      await writeFile(
        join(activeDir, `${ROOT}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: ROOT,
            thread_key: THREAD,
          },
          "# ADMIN root\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(doneDir, `${OPS}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "OPS",
            task_id: OPS,
            parent: ROOT,
            thread_key: THREAD,
          },
          "# OPS sub-task\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, "REPORT-20260610-003-OPS-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            sender: "OPS",
            recipient: "PM",
            task_id: OPS,
            thread_key: THREAD,
            status: "done",
            references: [OPS],
          },
          "## 结论\nOPS 完成\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, "REPORT-20260610-004-PM-to-ADMIN.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            sender: "PM",
            recipient: "ADMIN",
            task_id: OPS,
            thread_key: THREAD,
            status: "done",
            references: [OPS, ROOT],
          },
          "## 结论\nPM 总报告\n\n## 证据\n- OPS done\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();

      const rootReports = await builder.listReportsForTask(ROOT);
      const opsReports = await builder.listReportsForTask(OPS);

      const pmAdmin = rootReports.find((r) =>
        r.report_id.includes("REPORT-20260610-004-PM-to-ADMIN"),
      );
      const opsReport = opsReports.find((r) =>
        r.report_id.includes("REPORT-20260610-003-OPS-to-PM"),
      );

      assert.ok(pmAdmin, "PM-to-ADMIN listed under ADMIN root");
      assert.equal(pmAdmin!.parent_task_id, "TASK-20260610-001");
      assert.ok(opsReport, "OPS-to-PM listed under PM-to-OPS");
      assert.equal(opsReport!.parent_task_id, "TASK-20260610-002");

      const pmOnOps = opsReports.find((r) =>
        r.report_id.includes("REPORT-20260610-004-PM-to-ADMIN"),
      );
      assert.equal(pmOnOps, undefined, "PM-to-ADMIN must not appear under OPS child");
    });
  });

  it("TASK-220: 004 auto + 111 manual coexist — ledger marks 004 as auto_final_summary_fallback", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const reviewDir = join(layout.lifecycleRoot, "review");
      const doneDir = join(layout.lifecycleRoot, "done");
      const reportsDir = layout.reportsDir;
      const ROOT220 = "TASK-20260610-220-ADMIN-to-PM";
      const THREAD220 = "panel-task-220";
      await mkdir(reviewDir, { recursive: true });
      await mkdir(doneDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });

      await writeFile(
        join(reviewDir, `${ROOT220}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            sender: "ADMIN",
            recipient: "PM",
            task_id: ROOT220,
            thread_key: THREAD220,
          },
          "# Root 220\n",
        ),
        "utf-8",
      );

      await writeFile(
        join(reportsDir, "REPORT-20260610-109-PM-to-ADMIN.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            sender: "PM",
            recipient: "ADMIN",
            status: "in_progress",
            thread_key: THREAD220,
            references: [ROOT220],
          },
          "## 执行状态\nin_progress 派单中\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, "REPORT-20260610-004-PM-to-ADMIN.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            sender: "PM",
            recipient: "ADMIN",
            status: "done",
            report_type: "final_summary",
            auto_final_summary: true,
            task_id: ROOT220,
            thread_key: THREAD220,
            references: [ROOT220],
          },
          "验收（Runtime 总线自动汇总）\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, "REPORT-20260610-111-PM-to-ADMIN.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            sender: "PM",
            recipient: "ADMIN",
            status: "done",
            thread_key: THREAD220,
            references: [ROOT220],
          },
          "## 执行结果\nPM 手写最终\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();
      const reports = await builder.listReportsForTask(ROOT220);
      const auto = reports.find((r) =>
        r.report_id.includes("REPORT-20260610-004-PM-to-ADMIN"),
      );
      const manual = reports.find((r) =>
        r.report_id.includes("REPORT-20260610-111-PM-to-ADMIN"),
      );
      const ack = reports.find((r) =>
        r.report_id.includes("REPORT-20260610-109-PM-to-ADMIN"),
      );

      assert.ok(auto);
      assert.ok(manual);
      assert.ok(ack);
      assert.equal(auto!.report_kind, "auto_final_summary_fallback");
      assert.equal(manual!.report_kind, "pm_to_admin_final");
      assert.notEqual(ack!.report_kind, "pm_to_admin_final");
    });
  });

  it("PM-to-ADMIN ack hangs on root via thread_key and is not final summary", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const activeDir = join(layout.lifecycleRoot, "active");
      const reportsDir = layout.reportsDir;
      await mkdir(activeDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });

      await writeFile(
        join(activeDir, `${ROOT}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "PM",
            task_id: ROOT,
            thread_key: THREAD,
          },
          "# Root\n",
        ),
        "utf-8",
      );
      await writeFile(
        join(reportsDir, "REPORT-20260610-004-PM-to-ADMIN.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            sender: "PM",
            recipient: "ADMIN",
            thread_key: THREAD,
          },
          "已收到任务，正在分析并派发。\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();
      const reports = await builder.listReportsForTask(ROOT);
      const ack = reports.find((r) =>
        r.report_id.includes("REPORT-20260610-004-PM-to-ADMIN"),
      );
      assert.ok(ack);
      assert.equal(ack!.parent_task_id, "TASK-20260610-001");
      assert.equal(ack!.report_kind, "pm_to_admin_ack");
      assert.equal(isPmAdminFinalSummaryReport(ROOT, ack!), false);

      const threadsRaw = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(layout.ledgerDir, "threads.jsonl"), "utf-8"),
      );
      const threads = threadsRaw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { thread_key: string });
      const orphan = threads.find((t) => String(t.thread_key).startsWith("_orphan"));
      assert.equal(orphan, undefined, "inferable PM-to-ADMIN must not be orphan");
    });
  });
});
