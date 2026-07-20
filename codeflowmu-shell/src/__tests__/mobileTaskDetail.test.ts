import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAvailableTaskActions,
  buildFlowOverview,
  filterTasksForRecipient,
  findChildTasksForParent,
  isAdminToPmTask,
  sortTasksNewestFirst,
  taskMatchesRecipientFilter,
  taskRecipientCode,
} from "../mobile/mobileTaskDetail.ts";

test("taskMatchesRecipientFilter matches recipient only", () => {
  const adminToPm = {
    filename: "TASK-20260617-001-ADMIN-to-PM.md",
    sender: "ADMIN",
    recipient: "PM",
  };
  const pmToDev = {
    filename: "TASK-20260617-002-PM-to-DEV.md",
    sender: "PM",
    recipient: "DEV",
  };
  assert.equal(taskMatchesRecipientFilter(adminToPm, "PM"), true);
  assert.equal(taskMatchesRecipientFilter(pmToDev, "PM"), false);
  assert.equal(taskMatchesRecipientFilter(pmToDev, "DEV"), true);
});

test("filterTasksForRecipient keeps full lifecycle and sorts newest first", () => {
  const rows = [
    {
      filename: "TASK-20260615-001-ADMIN-to-PM.md",
      recipient: "PM",
      updated_at: "2026-06-15T10:00:00Z",
      bucket: "done",
    },
    {
      filename: "TASK-20260617-005-ADMIN-to-PM.md",
      recipient: "PM",
      updated_at: "2026-06-17T20:36:00Z",
      bucket: "active",
    },
    {
      filename: "TASK-20260616-003-PM-to-DEV.md",
      recipient: "DEV",
      updated_at: "2026-06-16T12:00:00Z",
      bucket: "active",
    },
    {
      filename: "TASK-20260614-001-ADMIN-to-PM.md",
      recipient: "PM",
      updated_at: "2026-06-14T08:00:00Z",
      bucket: "archive",
    },
  ];
  const pm = filterTasksForRecipient(rows, "PM");
  assert.equal(pm.length, 3);
  assert.equal(pm[0]!.filename, "TASK-20260617-005-ADMIN-to-PM.md");
  assert.equal(pm[1]!.filename, "TASK-20260615-001-ADMIN-to-PM.md");
  assert.equal(pm[2]!.filename, "TASK-20260614-001-ADMIN-to-PM.md");
});

test("findChildTasksForParent links ADMIN child by parent_task_id", () => {
  const parent = {
    filename: "TASK-20260618-001-ADMIN-to-PM.md",
    task_id: "TASK-20260618-001-ADMIN-to-PM",
    sender: "ADMIN",
    recipient: "PM",
    thread_key: "thread-main",
  };
  const all = [
    parent,
    {
      filename: "TASK-20260618-002-ADMIN-to-PM.md",
      parent_task_id: "TASK-20260618-001-ADMIN-to-PM",
      sender: "ADMIN",
      recipient: "PM",
      thread_key: "thread-main",
      bucket: "inbox",
    },
    {
      filename: "TASK-20260618-003-ADMIN-to-PM.md",
      sender: "ADMIN",
      recipient: "PM",
      thread_key: "thread-main",
      bucket: "inbox",
    },
  ];
  const children = findChildTasksForParent(parent, all);
  assert.equal(children.length, 1);
  assert.equal(children[0]!.filename, "TASK-20260618-002-ADMIN-to-PM.md");
});

test("findChildTasksForParent links by parent and thread_key", () => {
  const parent = {
    filename: "TASK-20260617-001-ADMIN-to-PM.md",
    task_id: "TASK-20260617-001-ADMIN-to-PM",
    sender: "ADMIN",
    recipient: "PM",
    thread_key: "thread-main",
  };
  const all = [
    parent,
    {
      filename: "TASK-20260617-002-PM-to-DEV.md",
      parent: "TASK-20260617-001-ADMIN-to-PM",
      sender: "PM",
      recipient: "DEV",
      thread_key: "thread-main",
      bucket: "active",
    },
    {
      filename: "TASK-20260617-003-PM-to-QA.md",
      parent_task_id: "TASK-20260617-001-ADMIN-to-PM",
      sender: "PM",
      recipient: "QA",
      bucket: "review",
    },
    {
      filename: "TASK-20260617-004-ADMIN-to-DEV.md",
      sender: "ADMIN",
      recipient: "DEV",
      bucket: "active",
    },
  ];
  const children = findChildTasksForParent(parent, all);
  assert.equal(children.length, 2);
  assert.ok(children.every((c) => taskRecipientCode(c) === "DEV" || taskRecipientCode(c) === "QA"));
});

test("buildFlowOverview for ADMIN to PM includes children and gate", () => {
  const parent = {
    filename: "TASK-20260617-001-ADMIN-to-PM.md",
    title: "Main task",
    sender: "ADMIN",
    recipient: "PM",
    status: "active",
  };
  const children = [
    {
      filename: "TASK-20260617-002-PM-to-DEV.md",
      sender: "PM",
      recipient: "DEV",
      status: "active",
    },
  ];
  const nodes = buildFlowOverview(parent, children, {
    pm_final_report: { filename: "REPORT-20260617-001-PM-to-ADMIN.md", status: "done" },
    eval_observation: {
      filename: "REVIEW-20260617-001-ADMIN.md",
      status: "pending",
    },
  });
  assert.ok(nodes.length >= 4);
  assert.equal(nodes[0]!.kind, "start");
  assert.equal(isAdminToPmTask(parent), true);
  assert.ok(nodes.some((n) => n.ref_kind === "report"));
  assert.ok(nodes.some((n) => n.kind === "gate"));
});

test("buildAvailableTaskActions by bucket", () => {
  const active = buildAvailableTaskActions(
    { bucket: "active", status: "active" },
    { panelPort: 8787 },
  );
  assert.ok(active.some((a) => a.id === "nudge" && a.enabled));
  assert.ok(active.some((a) => a.id === "unstick" && a.enabled));

  const review = buildAvailableTaskActions({ bucket: "review" }, { panelPort: 8787 });
  assert.ok(review.some((a) => a.id === "approve"));
  assert.ok(review.some((a) => a.id === "reject"));

  const done = buildAvailableTaskActions({ bucket: "done", status: "done" }, { panelPort: 8787 });
  assert.ok(done.some((a) => a.id === "archive"));

  const noPanel = buildAvailableTaskActions({ bucket: "active" }, {});
  const nudge = noPanel.find((a) => a.id === "nudge");
  assert.equal(nudge?.enabled, false);
  assert.ok(nudge?.disabled_reason);
});

test("buildAvailableTaskActions disables mainline archive while child is open", () => {
  const actions = buildAvailableTaskActions(
    {
      filename: "TASK-20260709-005-ADMIN-to-PM.md",
      task_id: "TASK-20260709-005",
      sender: "ADMIN",
      recipient: "PM",
      bucket: "done",
      status: "done",
    },
    {
      panelPort: 8787,
      childTasks: [
        {
          filename: "TASK-20260709-009-PM-to-OPS.md",
          parent: "TASK-20260709-005",
          sender: "PM",
          recipient: "OPS",
          bucket: "inbox",
          status: "pending",
        },
      ],
    },
  );
  const archive = actions.find((a) => a.id === "archive");
  assert.equal(archive?.enabled, false);
  assert.match(archive?.disabled_reason ?? "", /子任务未收口/);
});

test("buildAvailableTaskActions allows mainline archive when child is done with review attention", () => {
  const actions = buildAvailableTaskActions(
    {
      filename: "TASK-20260709-005-ADMIN-to-PM.md",
      task_id: "TASK-20260709-005",
      sender: "ADMIN",
      recipient: "PM",
      bucket: "done",
      status: "done",
    },
    {
      panelPort: 8787,
      childTasks: [
        {
          filename: "TASK-20260709-007-PM-to-OPS.md",
          parent: "TASK-20260709-005",
          sender: "PM",
          recipient: "OPS",
          bucket: "done",
          status: "done",
          review_attention: { reason: "evidence warning" },
        },
      ],
    },
  );
  const archive = actions.find((a) => a.id === "archive");
  assert.equal(archive?.enabled, true);
});

test("findChildTasksForParent includes archived-bucket PM children", () => {
  const parent = {
    filename: "TASK-20260619-014-ADMIN-to-PM.md",
    task_id: "TASK-20260619-014",
    sender: "ADMIN",
    recipient: "PM",
    thread_key: "panel-task-014",
  };
  const all = [
    parent,
    {
      filename: "TASK-20260620-001-PM-to-DEV.md",
      parent: "TASK-20260619-014",
      sender: "PM",
      recipient: "DEV",
      thread_key: "panel-task-014",
      bucket: "archive",
    },
    {
      filename: "TASK-20260620-003-PM-to-QA.md",
      parent: "TASK-20260619-014",
      sender: "PM",
      recipient: "QA",
      bucket: "done",
    },
  ];
  const children = findChildTasksForParent(parent, all);
  assert.equal(children.length, 2);
  assert.ok(children.every((c) => taskRecipientCode(c) === "DEV" || taskRecipientCode(c) === "QA"));
});

test("sortTasksNewestFirst uses updated_at then filename", () => {
  const sorted = sortTasksNewestFirst([
    { filename: "TASK-20260615-001-ADMIN-to-PM.md", updated_at: "2026-06-15T10:00:00Z" },
    { filename: "TASK-20260617-005-ADMIN-to-PM.md", updated_at: "2026-06-17T20:36:00Z" },
  ]);
  assert.equal(sorted[0]!.filename, "TASK-20260617-005-ADMIN-to-PM.md");
});
