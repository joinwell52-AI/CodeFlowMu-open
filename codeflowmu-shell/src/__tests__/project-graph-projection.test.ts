import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProjectGraphProjection,
  computeWorkflowStage,
} from "../project-graph-projection.ts";

test("project graph preserves formal parent hierarchy and attaches evidence leaves", () => {
  const graph = buildProjectGraphProjection({
    projectId: "mother",
    now: "2026-07-31T00:00:00.000Z",
    tasks: [
      {
        task_id: "TASK-20260731-001",
        title: "Root",
        wp_id: "WP-00",
        state: "active",
      },
      {
        task_id: "TASK-20260731-002",
        title: "Child",
        parent: "TASK-20260731-001",
        root_task_id: "TASK-20260731-001",
        state: "active",
      },
    ],
    reports: [
      {
        report_id: "REPORT-1",
        task_id: "TASK-20260731-002",
        reporter: "DEV",
        status: "done",
      },
    ],
    issues: [
      {
        issue_id: "ISSUE-1",
        task_id: "TASK-20260731-002",
        status: "open",
      },
    ],
  });
  assert.equal(
    graph.nodes.find((node) => node.id === "task:TASK-20260731-002")?.parent_id,
    "task:TASK-20260731-001",
  );
  assert.equal(
    graph.nodes.find((node) => node.id === "report:REPORT-1")?.parent_id,
    "task:TASK-20260731-002",
  );
  assert.equal(
    graph.nodes.find((node) => node.id === "task:TASK-20260731-002")
      ?.workflow_stage,
    "waiting_qa",
  );
});

test("missing parents and unlinked leaves are explicit anomalies", () => {
  const graph = buildProjectGraphProjection({
    projectId: "mother",
    tasks: [
      {
        task_id: "TASK-20260731-010",
        parent: "TASK-20260731-999",
        state: "inbox",
      },
    ],
    reports: [{ report_id: "REPORT-ORPHAN", status: "done" }],
  });
  assert.equal(graph.anomaly_count, 2);
  assert.match(
    graph.nodes.find((node) => node.id === "task:TASK-20260731-010")?.anomaly ??
      "",
    /parent_missing/,
  );
  assert.equal(
    graph.nodes.find((node) => node.id === "report:REPORT-ORPHAN")?.parent_id,
    "unlinked:mother",
  );
});

test("workflow stages distinguish approval wait, QA wait and accepted completion", () => {
  const base = {
    task: { task_id: "TASK-20260731-020", state: "active" },
    rootTaskId: "TASK-20260731-020",
    reports: [] as Array<Record<string, unknown>>,
    reviews: [] as Array<Record<string, unknown>>,
    approvals: [] as Array<Record<string, unknown>>,
    runtimeEvents: [] as Array<Record<string, unknown>>,
  };
  assert.equal(
    computeWorkflowStage({
      ...base,
      approvals: [
        {
          task_id: "TASK-20260731-020",
          status: "pending_approval",
        },
      ],
    }),
    "waiting_admin",
  );
  assert.equal(
    computeWorkflowStage({
      ...base,
      reports: [
        {
          task_id: "TASK-20260731-020",
          reporter: "DEV",
          status: "done",
        },
      ],
    }),
    "waiting_qa",
  );
  assert.equal(
    computeWorkflowStage({
      ...base,
      reports: [
        {
          task_id: "TASK-20260731-020",
          reporter: "DEV",
          status: "done",
        },
      ],
      reviews: [
        {
          task_id: "TASK-20260731-020",
          reviewer: "QA",
          status: "approved",
        },
      ],
    }),
    "done",
  );
});

test("PM final report waits for ADMIN, then accepted task evidence becomes done", () => {
  const base = {
    task: { task_id: "TASK-20260731-030", state: "review" },
    rootTaskId: "TASK-20260731-030",
    reports: [
      {
        task_id: "TASK-20260731-030",
        reporter: "PM",
        recipient: "ADMIN",
        report_kind: "pm_to_admin_final",
        status: "done",
      },
    ],
    reviews: [] as Array<Record<string, unknown>>,
    approvals: [] as Array<Record<string, unknown>>,
    runtimeEvents: [] as Array<Record<string, unknown>>,
  };
  assert.equal(computeWorkflowStage(base), "waiting_admin");
  assert.equal(
    computeWorkflowStage({
      ...base,
      task: {
        ...base.task,
        review_status: "approved",
        display_status: "human_review_approved",
      },
    }),
    "done",
  );
});
