import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assignReportsToWorkflowTree,
  buildThreadChainOrderedTaskIds,
  workflowReportNodeCount,
} from "../panel-report-workflow-chain.ts";

const ledger215 = {
  thread_key: "panel-task-215",
  root_task_id: "TASK-20260610-215",
  task_ids: ["TASK-20260610-035", "TASK-20260610-215"],
  report_ids: [
    "REPORT-20260610-094-PM-to-ADMIN",
    "REPORT-20260610-095-OPS-to-PM",
    "REPORT-20260610-096-PM-to-ADMIN",
  ],
};

const task215 = {
  filename: "TASK-20260610-215-ADMIN-to-PM.md",
  thread_key: "panel-task-215",
};

const task035 = {
  filename: "TASK-20260610-035-PM-to-OPS.md",
  parent: "TASK-20260610-215",
  thread_key: "panel-task-215",
};

const report095 = {
  filename: "REPORT-20260610-095-OPS-to-PM.md",
  task_id: "TASK-20260610-035",
  parent_task_id: "TASK-20260610-035",
  linked_task_ids: ["TASK-20260610-035"],
};

const ledger216 = {
  thread_key: "panel-task-216",
  root_task_id: "TASK-20260610-216",
  task_ids: ["TASK-20260610-037", "TASK-20260610-216", "TASK-20260610-036"],
  report_ids: [
    "REPORT-20260610-097-PM-to-ADMIN",
    "REPORT-20260610-098-DEV-to-PM",
    "REPORT-20260610-099-PM-to-ADMIN",
  ],
};

const task216 = {
  filename: "TASK-20260610-216-ADMIN-to-PM.md",
  thread_key: "panel-task-216",
};

const report098 = {
  filename: "REPORT-20260610-098-DEV-to-PM.md",
  task_id: "TASK-20260610-036",
  parent_task_id: "TASK-20260610-036",
  linked_task_ids: ["TASK-20260610-036"],
};

test("buildThreadChainOrderedTaskIds includes ledger children missing from task list", () => {
  const ids = buildThreadChainOrderedTaskIds(ledger216, [task216]);
  assert.ok(ids.includes("TASK-20260610-216"));
  assert.ok(ids.includes("TASK-20260610-036"));
  assert.ok(ids.includes("TASK-20260610-037"));
});

test("assignReportsToWorkflowTree routes worker report to orphans when subtask not in tree", () => {
  const tree = [{ taskId: "TASK-20260610-215", depth: 0 }];
  const { byTask, orphans } = assignReportsToWorkflowTree(
    [report095],
    tree,
    "TASK-20260610-215",
  );
  assert.equal(byTask.get("TASK-20260610-215")!.length, 0);
  assert.equal(orphans.length, 1);
  assert.ok(String(orphans[0]!.filename).includes("095-OPS-to-PM"));
});

test("workflowReportNodeCount matches thread_reports length for TASK-215", () => {
  const ordered = buildThreadChainOrderedTaskIds(ledger215, [task215, task035]);
  const tree = ordered.map((id, idx) => ({
    taskId: id,
    depth: id === "TASK-20260610-215" ? 0 : 1,
    sortKey: idx,
  }));
  const reports = [
    { filename: "REPORT-20260610-094-PM-to-ADMIN.md", task_id: "TASK-20260610-215", parent_task_id: "TASK-20260610-215" },
    report095,
    { filename: "REPORT-20260610-096-PM-to-ADMIN.md", task_id: "TASK-20260610-215", parent_task_id: "TASK-20260610-215" },
  ];
  assert.equal(workflowReportNodeCount(reports, tree, "TASK-20260610-215"), 3);
});

test("workflowReportNodeCount includes DEV worker report 098 when subtask stub in tree", () => {
  const ordered = buildThreadChainOrderedTaskIds(ledger216, [task216]);
  const tree = ordered.map((id, idx) => ({
    taskId: id,
    depth: id === "TASK-20260610-216" ? 0 : 1,
    sortKey: idx,
  }));
  const reports = [
    { filename: "REPORT-20260610-097-PM-to-ADMIN.md", task_id: "TASK-20260610-216", parent_task_id: "TASK-20260610-216" },
    report098,
    { filename: "REPORT-20260610-099-PM-to-ADMIN.md", task_id: "TASK-20260610-216", parent_task_id: "TASK-20260610-216" },
  ];
  assert.equal(workflowReportNodeCount(reports, tree, "TASK-20260610-216"), 3);
});
