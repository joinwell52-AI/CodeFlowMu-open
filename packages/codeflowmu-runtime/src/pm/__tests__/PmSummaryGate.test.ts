import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  evaluatePmSummaryGate,
  reportKindIsFinalSummary,
} from "../PmSummaryGate.ts";
import { isPmAdminFinalSummaryReport } from "../../ledger/reportParenting.ts";
import type {
  LedgerReportRecord,
  LedgerTaskRecord,
  LedgerThreadRecord,
} from "../../ledger/types.ts";

const THREAD = "pm-summary-gate";
const ROOT = "TASK-20260610-001-ADMIN-to-PM";
const OPS = "TASK-20260610-002-PM-to-OPS";

function mkThread(overrides?: Partial<LedgerThreadRecord>): LedgerThreadRecord {
  return {
    thread_key: THREAD,
    root_task_id: ROOT,
    task_ids: [ROOT, OPS],
    report_ids: [],
    pending_pm_review: [],
    ...overrides,
  };
}

function mkTask(overrides: Partial<LedgerTaskRecord>): LedgerTaskRecord {
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

function mkReport(overrides: Partial<LedgerReportRecord>): LedgerReportRecord {
  return {
    report_id: "REPORT-20260610-003-OPS-to-PM",
    task_id: OPS,
    filename: "REPORT-20260610-003-OPS-to-PM.md",
    sender: "OPS",
    recipient: "PM",
    status: "done",
    path: "",
    created_at: "2026-06-10T11:00:00+08:00",
    updated_at: "2026-06-10T11:00:00+08:00",
    timezone: "Asia/Shanghai",
    created_at_utc: "2026-06-10T03:00:00Z",
    thread_key: THREAD,
    parent_task_id: OPS,
    report_kind: "worker_to_pm",
    ...overrides,
  };
}

function happyPath(): {
  thread: LedgerThreadRecord;
  tasks: LedgerTaskRecord[];
  reports: LedgerReportRecord[];
} {
  return {
    thread: mkThread(),
    tasks: [
      mkTask({}),
      mkTask({
        task_id: OPS,
        filename: `${OPS}.md`,
        sender: "PM",
        recipient: "OPS",
        parent: ROOT,
        bucket: "done",
      }),
    ],
    reports: [
      mkReport({
        references: [OPS],
      }),
    ],
  };
}

describe("evaluatePmSummaryGate", () => {
  it("allows when PM downstream child is in review (settled lifecycle)", () => {
    const { thread, tasks, reports } = happyPath();
    tasks[1] = { ...tasks[1]!, bucket: "review" };
    const result = evaluatePmSummaryGate({ thread, tasks, reports });
    assert.equal(result.ok, true);
  });

  it("blocks when PM downstream child is not settled", () => {
    const { thread, tasks, reports } = happyPath();
    tasks[1] = { ...tasks[1]!, bucket: "active" };
    const result = evaluatePmSummaryGate({ thread, tasks, reports });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.skipped_reason, /^child_tasks_not_settled:/);
    }
  });

  it("blocks when pending_pm_review has unresolved report id", () => {
    const { thread, tasks, reports } = happyPath();
    const result = evaluatePmSummaryGate({
      thread: mkThread({
        pending_pm_review: ["REPORT-20260610-099-OPS-to-PM"],
      }),
      tasks,
      reports,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.skipped_reason, /^pending_pm_review_nonempty:/);
    }
  });

  it("ignores stale pending_pm_review when child is already done", () => {
    const { thread, tasks, reports } = happyPath();
    const result = evaluatePmSummaryGate({
      thread: mkThread({ pending_pm_review: [OPS] }),
      tasks,
      reports,
    });
    assert.equal(result.ok, true);
  });

  it("blocks when display_status is waiting_pm_attention", () => {
    const { thread, tasks, reports } = happyPath();
    tasks[1] = { ...tasks[1]!, display_status: "waiting_pm_attention" };
    const result = evaluatePmSummaryGate({ thread, tasks, reports });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.skipped_reason, /^waiting_pm_attention:/);
    }
  });

  it("allows final summary when all children done and worker report exists", () => {
    const { thread, tasks, reports } = happyPath();
    const result = evaluatePmSummaryGate({ thread, tasks, reports });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.root_task_id, ROOT);
      assert.ok(result.references.includes(ROOT));
      assert.ok(result.references.includes(OPS));
      assert.ok(
        result.references.some((id) => id.includes("REPORT-20260610-003-OPS-to-PM")),
      );
    }
  });

  it("blocks final summary when root body requires QA/OPS/v2 but children are missing", () => {
    const { thread, tasks, reports } = happyPath();
    tasks[1] = {
      ...tasks[1]!,
      task_id: "TASK-20260610-002-PM-to-DEV",
      filename: "TASK-20260610-002-PM-to-DEV.md",
      recipient: "DEV",
    };
    reports[0] = {
      ...reports[0]!,
      report_id: "REPORT-20260610-003-DEV-to-PM",
      filename: "REPORT-20260610-003-DEV-to-PM.md",
      sender: "DEV",
      task_id: "TASK-20260610-002-PM-to-DEV",
      parent_task_id: "TASK-20260610-002-PM-to-DEV",
      references: ["TASK-20260610-002-PM-to-DEV"],
    };
    const result = evaluatePmSummaryGate({
      thread,
      tasks,
      reports,
      root_body: [
        "Required chain:",
        "1. PM dispatches DEV child task to build v1.",
        "2. PM dispatches QA child task to verify v1.",
        "3. PM dispatches DEV child task for v2 improvement.",
        "4. PM dispatches OPS child task to verify delivery.",
      ].join("\n"),
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.skipped_reason, /^required_child_role_missing:/);
      assert.match(result.skipped_reason, /DEV:1\/2/);
      assert.match(result.skipped_reason, /QA:0\/1/);
      assert.match(result.skipped_reason, /OPS:0\/1/);
    }
  });

  it("blocks final summary for a product development task that asks for validation delivery flow", () => {
    const devTaskId = "TASK-20260610-002-PM-to-DEV";
    const thread = mkThread({
      root_task_id: ROOT,
      task_ids: [ROOT, devTaskId],
      pending_pm_review: [],
    });
    const tasks = [
      mkTask({}),
      mkTask({
        task_id: devTaskId,
        filename: `${devTaskId}.md`,
        sender: "PM",
        recipient: "DEV",
        parent: ROOT,
        bucket: "done",
        display_status: "done",
      }),
    ];
    const reports = [
      mkReport({
        report_id: "REPORT-20260610-003-DEV-to-PM",
        filename: "REPORT-20260610-003-DEV-to-PM.md",
        sender: "DEV",
        recipient: "PM",
        task_id: devTaskId,
        parent_task_id: devTaskId,
        references: [devTaskId],
      }),
    ];

    const result = evaluatePmSummaryGate({
      thread,
      tasks,
      reports,
      root_body: [
        "请在本地开发一个浏览器小游戏，用于验证一个轻量级产品从需求、开发、验证到交付的完整流程。",
        "游戏 UI 设计、产品设计、游戏名称由团队完成。",
      ].join("\n"),
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.skipped_reason, /^required_child_role_missing:/);
      assert.match(result.skipped_reason, /QA:0\/1/);
    }
  });

  it("requires browser evidence and a PASS verdict from product QA", () => {
    const devId = "TASK-20260610-002";
    const qaId = "TASK-20260610-003";
    const thread = mkThread({ task_ids: [ROOT, devId, qaId] });
    const tasks = [
      mkTask({}),
      mkTask({ task_id: devId, filename: `${devId}.md`, sender: "PM", recipient: "DEV", parent: ROOT, bucket: "done" }),
      mkTask({ task_id: qaId, filename: `${qaId}.md`, sender: "PM", recipient: "QA", parent: ROOT, bucket: "done" }),
    ];
    const reports = [
      mkReport({
        report_id: "REPORT-20260610-002-DEV-to-PM",
        filename: "REPORT-20260610-002-DEV-to-PM.md",
        sender: "DEV",
        task_id: devId,
        parent_task_id: devId,
        references: [devId],
      }),
      mkReport({
        report_id: "REPORT-20260610-003-QA-to-PM",
        filename: "REPORT-20260610-003-QA-to-PM.md",
        sender: "QA",
        task_id: qaId,
        parent_task_id: qaId,
        references: [qaId],
        qa_verdict: "pass",
        qa_browser_verified: false,
      }),
    ];
    const input = {
      thread,
      tasks,
      reports,
      root_body: "创建一个中文 Web 应用，包含 UI、核心交互和手机响应式布局",
    };
    const missingBrowser = evaluatePmSummaryGate(input);
    assert.deepEqual(missingBrowser, {
      ok: false,
      skipped_reason: "qa_browser_evidence_missing",
    });

    reports[1] = { ...reports[1]!, qa_browser_verified: true };
    const passed = evaluatePmSummaryGate(input);
    assert.equal(passed.ok, true, JSON.stringify(passed));

    reports[1] = { ...reports[1]!, valid: false, superseded_by: "REPORT-NEW" };
    assert.deepEqual(evaluatePmSummaryGate(input), {
      ok: false,
      skipped_reason: "qa_not_passed",
    });

    reports[1] = {
      ...reports[1]!,
      valid: true,
      superseded_by: undefined,
      qa_verdict: "fail",
    };
    assert.deepEqual(evaluatePmSummaryGate(input), {
      ok: false,
      skipped_reason: "qa_not_passed",
    });
  });

  it("blocks stale worker report that predates the child task", () => {
    const { thread, tasks, reports } = happyPath();
    tasks[1] = {
      ...tasks[1]!,
      created_at: "2026-06-10T12:00:00+08:00",
      created_at_utc: "2026-06-10T04:00:00Z",
    };
    reports[0] = {
      ...reports[0]!,
      created_at: "2026-06-10T11:00:00+08:00",
      created_at_utc: "2026-06-10T03:00:00Z",
    };
    const result = evaluatePmSummaryGate({ thread, tasks, reports });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.skipped_reason, "no_effective_worker_to_pm_report");
    }
  });

  it("blocks DEV report when filename seq differs even if ledger parenting points to child", () => {
    const devTaskId = "TASK-20260610-007-PM-to-DEV";
    const thread = mkThread({
      root_task_id: ROOT,
      task_ids: [ROOT, devTaskId],
      pending_pm_review: [],
    });
    const tasks = [
      mkTask({}),
      mkTask({
        task_id: devTaskId,
        filename: `${devTaskId}.md`,
        sender: "PM",
        recipient: "DEV",
        parent: ROOT,
        bucket: "done",
        display_status: "done",
      }),
    ];
    const reports = [
      mkReport({
        report_id: "REPORT-20260610-012-DEV-to-PM",
        filename: "REPORT-20260610-012-DEV-to-PM.md",
        sender: "DEV",
        recipient: "PM",
        task_id: devTaskId,
        parent_task_id: devTaskId,
        references: [],
      }),
    ];

    const result = evaluatePmSummaryGate({ thread, tasks, reports });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.skipped_reason, "dev_report_attribution_fail");
    }
  });

  it("blocks when PM-to-ADMIN final already exists", () => {
    const { thread, tasks, reports } = happyPath();
    reports.push(
      mkReport({
        report_id: "REPORT-20260610-005-PM-to-ADMIN",
        filename: "REPORT-20260610-005-PM-to-ADMIN.md",
        sender: "PM",
        recipient: "ADMIN",
        status: "done",
        task_id: ROOT,
        parent_task_id: ROOT,
        report_kind: "pm_to_admin_final",
        references: [ROOT, OPS],
      }),
    );
    const result = evaluatePmSummaryGate({ thread, tasks, reports });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.skipped_reason, "pm_admin_final_already_exists");
    }
  });

  it("allows a successful summary after an earlier blocked PM final", () => {
    const { thread, tasks, reports } = happyPath();
    reports.push(
      mkReport({
        report_id: "REPORT-20260610-005-PM-to-ADMIN",
        filename: "REPORT-20260610-005-PM-to-ADMIN.md",
        sender: "PM",
        recipient: "ADMIN",
        status: "blocked",
        task_id: ROOT,
        parent_task_id: ROOT,
        report_kind: "pm_to_admin_final",
        references: [ROOT, OPS],
      }),
    );
    assert.equal(evaluatePmSummaryGate({ thread, tasks, reports }).ok, true);
  });

  it("ignores old PM-to-ADMIN final summary after ADMIN rejects root for rework", () => {
    const { thread, tasks, reports } = happyPath();
    tasks[0] = {
      ...tasks[0]!,
      review_status: "rejected",
      display_status: "waiting_pm_rework",
      bucket: "active",
      scope: "active",
      updated_at: "2026-06-10T12:00:00+08:00",
      updated_at_utc: "2026-06-10T04:00:00Z",
      reopen_reason: "needs QA verification",
    };
    reports.push(
      mkReport({
        report_id: "REPORT-20260610-005-PM-to-ADMIN",
        filename: "REPORT-20260610-005-PM-to-ADMIN.md",
        sender: "PM",
        recipient: "ADMIN",
        status: "done",
        task_id: ROOT,
        parent_task_id: ROOT,
        report_kind: "pm_to_admin_final",
        created_at: "2026-06-10T11:30:00+08:00",
        created_at_utc: "2026-06-10T03:30:00Z",
        references: [ROOT, OPS],
      }),
    );

    const result = evaluatePmSummaryGate({ thread, tasks, reports });

    assert.equal(result.ok, true);
  });
});

describe("isPmAdminFinalSummaryReport", () => {
  it("ack report on root is not final summary", () => {
    const ack = mkReport({
      report_id: "REPORT-20260610-004-PM-to-ADMIN",
      filename: "REPORT-20260610-004-PM-to-ADMIN.md",
      sender: "PM",
      recipient: "ADMIN",
      status: "",
      task_id: ROOT,
      parent_task_id: ROOT,
      report_kind: "pm_to_admin_ack",
    });
    assert.equal(isPmAdminFinalSummaryReport(ROOT, ack, "已收到任务，正在派发。"), false);
    assert.equal(reportKindIsFinalSummary("pm_to_admin_ack"), false);
  });

  it("done report with root task_id is final summary", () => {
    const final = mkReport({
      report_id: "REPORT-20260610-005-PM-to-ADMIN",
      filename: "REPORT-20260610-005-PM-to-ADMIN.md",
      sender: "PM",
      recipient: "ADMIN",
      status: "done",
      task_id: ROOT,
      parent_task_id: ROOT,
      report_kind: "pm_to_admin_final",
      report_type: "final_summary",
      final: true,
      references: [ROOT, OPS],
    });
    assert.equal(
      isPmAdminFinalSummaryReport(ROOT, final, "## 结论\n全部完成"),
      true,
    );
    assert.equal(reportKindIsFinalSummary("pm_to_admin_final"), true);
  });

  for (const status of ["blocked", "needs_admin", "failed"] as const) {
    it(`${status} PM-to-ADMIN final summary is recognized`, () => {
      const body = "## 结论\n子任务阻塞\n\n## 证据\n- OPS blocked\n";
      const final = mkReport({
        report_id: "REPORT-20260609-006-PM-to-ADMIN",
        filename: "REPORT-20260609-006-PM-to-ADMIN.md",
        sender: "PM",
        recipient: "ADMIN",
        status,
        task_id: ROOT,
        parent_task_id: ROOT,
        report_type: "final_summary",
        final: true,
        references: [ROOT, OPS],
      });
      assert.equal(isPmAdminFinalSummaryReport(ROOT, final, body), true);
    });
  }

  it("blocked legacy final without report_type/final markers is recognized", () => {
    const body = "## 结论\n子任务阻塞\n\n## 证据\n- OPS blocked\n";
    const legacy = mkReport({
      report_id: "REPORT-20260609-006-PM-to-ADMIN",
      filename: "REPORT-20260609-006-PM-to-ADMIN.md",
      sender: "PM",
      recipient: "ADMIN",
      status: "blocked",
      task_id: ROOT,
      parent_task_id: ROOT,
      references: [ROOT, OPS],
    });
    assert.equal(isPmAdminFinalSummaryReport(ROOT, legacy, body), true);
  });

  for (const status of ["in_progress", "dispatching"] as const) {
    it(`${status} PM-to-ADMIN is not final summary`, () => {
      const progress = mkReport({
        report_id: "REPORT-20260610-007-PM-to-ADMIN",
        filename: "REPORT-20260610-007-PM-to-ADMIN.md",
        sender: "PM",
        recipient: "ADMIN",
        status,
        task_id: ROOT,
        parent_task_id: ROOT,
        report_kind: "pm_to_admin_in_progress",
        references: [ROOT],
      });
      assert.equal(
        isPmAdminFinalSummaryReport(ROOT, progress, "## 进展\n派发中"),
        false,
      );
    });
  }
});
