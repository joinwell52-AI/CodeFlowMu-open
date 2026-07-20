import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyReportIntake,
  isLateOrphanIntakeReport,
  partitionReportsByIntake,
} from "../panel-report-intake.ts";

const report004 = {
  report_id: "REPORT-20260610-004-OPS-to-PM",
  filename: "REPORT-20260610-004-OPS-to-PM.md",
  task_id: "TASK-20260609-018",
  references: ["TASK-20260609-018"],
  linked_task_ids: ["TASK-20260609-018"],
  sender: "OPS",
  recipient: "PM",
  status: "done",
  report_kind: "worker_to_pm",
};

const ledgerRows = [
  {
    thread_key: "_orphan_REPORT-20260610-004-OPS-to-PM",
    task_ids: [],
    report_ids: ["REPORT-20260610-004-OPS-to-PM"],
  },
  {
    thread_key: "panel-task-014",
    root_task_id: "TASK-20260609-014",
    task_ids: ["TASK-20260609-014", "TASK-20260609-017"],
    report_ids: ["REPORT-20260609-004-PM-to-ADMIN"],
  },
  {
    thread_key: "panel-task-215",
    root_task_id: "TASK-20260610-215",
    task_ids: ["TASK-20260610-035", "TASK-20260610-215"],
    report_ids: [
      "REPORT-20260610-094-PM-to-ADMIN",
      "REPORT-20260610-095-OPS-to-PM",
      "REPORT-20260610-096-PM-to-ADMIN",
    ],
  },
];

const tasks = [
  {
    task_id: "TASK-20260609-014",
    filename: "TASK-20260609-014-ADMIN-to-PM.md",
    bucket: "archive",
    path: "fcop/_lifecycle/archive/TASK-20260609-014-ADMIN-to-PM.md",
    thread_key: "panel-task-014",
  },
  {
    task_id: "TASK-20260609-017",
    filename: "TASK-20260609-017-PM-to-QA.md",
    bucket: "archive",
    path: "fcop/_lifecycle/archive/TASK-20260609-017-PM-to-QA.md",
    thread_key: "panel-task-014",
  },
  {
    task_id: "TASK-20260610-215",
    filename: "TASK-20260610-215-ADMIN-to-PM.md",
    bucket: "review",
    path: "fcop/_lifecycle/review/TASK-20260610-215-ADMIN-to-PM.md",
    thread_key: "panel-task-215",
  },
  {
    task_id: "TASK-20260610-035",
    filename: "TASK-20260610-035-PM-to-OPS.md",
    parent: "TASK-20260610-215",
    bucket: "done",
    path: "fcop/_lifecycle/done/TASK-20260610-035-PM-to-OPS.md",
    thread_key: "panel-task-215",
  },
];

const report095 = {
  filename: "REPORT-20260610-095-OPS-to-PM.md",
  task_id: "TASK-20260610-035",
  parent_task_id: "TASK-20260610-035",
  linked_task_ids: ["TASK-20260610-035"],
  sender: "OPS",
  recipient: "PM",
  status: "done",
};

test("REPORT-004 on archived thread-014 is late_report_intake noted_only", () => {
  const meta = classifyReportIntake(report004, tasks, ledgerRows);
  assert.equal(meta.kind, "late_report_intake");
  assert.equal(meta.action, "noted_only");
  assert.equal(meta.related_task_id, "TASK-20260609-018");
});

test("REPORT-095 on active thread-215 stays active (no regression)", () => {
  const meta = classifyReportIntake(report095, tasks, ledgerRows);
  assert.equal(meta.kind, "active");
  assert.equal(isLateOrphanIntakeReport(report095, tasks, ledgerRows), false);
});

test("partitionReportsByIntake splits late intake from active pool", () => {
  const parts = partitionReportsByIntake(
    [report004, report095],
    tasks,
    ledgerRows,
  );
  assert.equal(parts.late_orphan_intake_count, 1);
  assert.equal(parts.active.length, 1);
  assert.ok(parts.active[0]!.filename!.includes("095"));
  assert.ok(parts.late_orphan_intake[0]!.filename!.includes("004"));
});

const pmAdminOnArchived = {
  filename: "REPORT-20260610-094-PM-to-ADMIN.md",
  task_id: "TASK-20260610-215",
  linked_task_ids: ["TASK-20260610-215"],
  sender: "PM",
  recipient: "ADMIN",
  status: "done",
};

test("PM-to-ADMIN on sealed thread stays active (not late intake)", () => {
  const meta = classifyReportIntake(pmAdminOnArchived, tasks, ledgerRows);
  assert.equal(meta.kind, "active");
});

test("true orphan when _orphan_REPORT has no linked task ids", () => {
  const rep = {
    filename: "REPORT-20260610-999-OPS-to-PM.md",
    sender: "OPS",
    recipient: "PM",
  };
  const rows = [
    {
      thread_key: "_orphan_REPORT-20260610-999-OPS-to-PM",
      report_ids: ["REPORT-20260610-999-OPS-to-PM"],
    },
  ];
  const meta = classifyReportIntake(rep, tasks, rows);
  assert.equal(meta.kind, "true_orphan");
});
