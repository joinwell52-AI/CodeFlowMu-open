import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateTaskReportScopes,
  computeRelatedTaskIds,
  inferredBodyTaskMentionsFromMarkdown,
  ledgerThreadForReport,
  reportBelongsToRelatedThread,
  reportLinkedTaskIdPrefixes,
  structuredLinkedTaskIdsFromReport,
} from "../panel-report-aggregation.ts";

const task214 = {
  filename: "TASK-20260610-214-ADMIN-to-PM.md",
  thread_key: "panel-task-214",
  path: "fcop/_lifecycle/archive/TASK-20260610-214-ADMIN-to-PM.md",
};

const task034 = {
  filename: "TASK-20260610-034-PM-to-QA.md",
  thread_key: "panel-task-214",
  references: "TASK-20260610-214-ADMIN-to-PM.md",
  path: "fcop/_lifecycle/done/TASK-20260610-034-PM-to-QA.md",
};

const report091 = {
  filename: "REPORT-20260610-091-PM-to-ADMIN.md",
  task_id: "TASK-20260610-214",
  linked_task_ids: ["TASK-20260610-214"],
  thread_key: "panel-task-214",
};

const report092 = {
  filename: "REPORT-20260610-092-QA-to-PM.md",
  task_id: "TASK-20260610-034",
  linked_task_ids: ["TASK-20260610-034"],
  thread_key: "panel-task-214",
};

const report093 = {
  filename: "REPORT-20260610-093-PM-to-ADMIN.md",
  task_id: "TASK-20260610-214",
  linked_task_ids: ["TASK-20260610-214"],
  thread_key: "panel-task-214",
};

const ledger214 = {
  thread_key: "panel-task-214",
  root_task_id: "TASK-20260610-214",
  task_ids: ["TASK-20260610-034", "TASK-20260610-214"],
  report_ids: ["REPORT-20260610-091", "REPORT-20260610-092", "REPORT-20260610-093"],
};

const allReports = [report091, report092, report093];
const allTasks = [task214, task034];

test("reportLinkedTaskIdPrefixes extracts short ids from linked_task_ids", () => {
  assert.deepEqual(reportLinkedTaskIdPrefixes(report092), ["TASK-20260610-034"]);
});

test("computeRelatedTaskIds includes root, ledger children, and thread_key peers", () => {
  const ids = computeRelatedTaskIds("TASK-20260610-214", allTasks, allReports, {
    ledgerRow: ledger214,
  });
  assert.ok(ids.has("TASK-20260610-214"));
  assert.ok(ids.has("TASK-20260610-034"));
});

test("reportBelongsToRelatedThread matches QA child report 092", () => {
  const related = computeRelatedTaskIds("TASK-20260610-214", allTasks, allReports, {
    ledgerRow: ledger214,
  });
  assert.equal(reportBelongsToRelatedThread(report091, related, "panel-task-214"), true);
  assert.equal(reportBelongsToRelatedThread(report092, related, "panel-task-214"), true);
  assert.equal(reportBelongsToRelatedThread(report093, related, "panel-task-214"), true);
});

test("child report 092 included when only root task object is loaded (034 missing from list)", () => {
  const related = computeRelatedTaskIds("TASK-20260610-214", [task214], allReports, {
    ledgerRow: ledger214,
  });
  assert.ok(related.has("TASK-20260610-034"));
  assert.equal(reportBelongsToRelatedThread(report092, related, "panel-task-214"), true);
});

const ledger213 = {
  thread_key: "panel-task-213",
  root_task_id: "TASK-20260610-213",
  task_ids: ["TASK-20260610-213", "TASK-20260610-032", "TASK-20260610-033"],
  report_ids: ["REPORT-20260610-088-PM-to-ADMIN"],
};

const report092BodyPolluted = {
  ...report092,
  linked_task_ids: [
    "TASK-20260610-034",
    "TASK-20260610-213",
    "TASK-20260610-032",
    "TASK-20260610-033",
  ],
};

test("structuredLinkedTaskIdsFromReport ignores report body TASK mentions", () => {
  const raw = `---
task_id: TASK-20260610-034
linked_task_ids:
  - TASK-20260610-034
---
## Smoke
Compared TASK-20260610-213 vs TASK-20260610-032 and TASK-20260610-033.
`;
  const fm = { task_id: "TASK-20260610-034", linked_task_ids: ["TASK-20260610-034"] };
  const structured = structuredLinkedTaskIdsFromReport(
    { linked_task_ids: ["TASK-20260610-034"] },
    fm,
  );
  const bodyMentions = inferredBodyTaskMentionsFromMarkdown(raw);
  assert.deepEqual(structured, ["TASK-20260610-034"]);
  assert.ok(bodyMentions.includes("TASK-20260610-213"));
  assert.ok(bodyMentions.includes("TASK-20260610-032"));
  assert.ok(bodyMentions.includes("TASK-20260610-033"));
  assert.equal(structured.includes("TASK-20260610-213"), false);
});

test("ledgerThreadForReport prefers report_ids exact match over task_ids intersection", () => {
  const rows = [ledger213, ledger214];
  const row = ledgerThreadForReport(report092BodyPolluted, rows);
  assert.equal(row?.thread_key, "panel-task-214");
});

test("REPORT-003 PM-to-ADMIN maps to panel-task-221 via ledger report_ids", () => {
  const ledger221 = {
    thread_key: "panel-task-221",
    root_task_id: "TASK-20260610-221",
    task_ids: ["TASK-20260610-221"],
    report_ids: ["REPORT-20260611-003-PM-to-ADMIN"],
  };
  const report003 = {
    filename: "REPORT-20260611-003-PM-to-ADMIN.md",
    task_id: "TASK-20260610-221",
    linked_task_ids: ["TASK-20260610-221"],
    sender: "PM",
    recipient: "ADMIN",
  };
  const row = ledgerThreadForReport(report003, [ledger221]);
  assert.equal(row?.thread_key, "panel-task-221");
});

test("REPORT-092 assigns to panel-task-214 not panel-task-213", () => {
  const rows = [ledger213, ledger214];
  const row = ledgerThreadForReport(report092, rows);
  assert.equal(row?.thread_key, "panel-task-214");
  assert.notEqual(row?.thread_key, "panel-task-213");
});

const task215 = {
  task_id: "TASK-20260610-215",
  filename: "TASK-20260610-215-ADMIN-to-PM.md",
  sender: "ADMIN",
  recipient: "PM",
  thread_key: "panel-task-215",
};

const task035 = {
  task_id: "TASK-20260610-035",
  filename: "TASK-20260610-035-PM-to-OPS.md",
  sender: "PM",
  recipient: "OPS",
  parent: "TASK-20260610-215",
  thread_key: "panel-task-215",
};

const report094 = {
  report_id: "REPORT-20260610-094-PM-to-ADMIN",
  filename: "REPORT-20260610-094-PM-to-ADMIN.md",
  task_id: "TASK-20260610-215",
  parent_task_id: "TASK-20260610-215",
  sender: "PM",
  recipient: "ADMIN",
  status: "in_progress",
  references: ["TASK-20260610-215"],
  linked_task_ids: ["TASK-20260610-215"],
};

const report095 = {
  report_id: "REPORT-20260610-095-OPS-to-PM",
  filename: "REPORT-20260610-095-OPS-to-PM.md",
  task_id: "TASK-20260610-035",
  parent_task_id: "TASK-20260610-035",
  sender: "OPS",
  recipient: "PM",
  status: "done",
  references: ["TASK-20260610-035"],
  linked_task_ids: ["TASK-20260610-035"],
};

const report096 = {
  report_id: "REPORT-20260610-096-PM-to-ADMIN",
  filename: "REPORT-20260610-096-PM-to-ADMIN.md",
  task_id: "TASK-20260610-215",
  parent_task_id: "TASK-20260610-215",
  sender: "PM",
  recipient: "ADMIN",
  status: "done",
  references: ["TASK-20260610-215"],
  linked_task_ids: ["TASK-20260610-215"],
};

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

test("TASK-215: direct_reports=2 (PM ack + final), thread_reports=3 (incl OPS)", () => {
  const allTasks215 = [task215, task035];
  const allReports215 = [report094, report095, report096];
  const scopes = aggregateTaskReportScopes("TASK-20260610-215", allTasks215, allReports215, {
    ledgerRow: ledger215,
  });
  assert.equal(scopes.direct_reports.length, 2);
  assert.equal(scopes.thread_reports.length, 3);
  assert.ok(
    scopes.thread_reports.some((r) =>
      String(r.filename).includes("REPORT-20260610-095-OPS-to-PM"),
    ),
  );
  assert.ok(
    scopes.direct_reports.every((r) => /PM-to-ADMIN/i.test(String(r.filename))),
  );
  assert.equal(
    scopes.direct_reports.some((r) =>
      String(r.filename).includes("REPORT-20260610-095"),
    ),
    false,
  );
});
