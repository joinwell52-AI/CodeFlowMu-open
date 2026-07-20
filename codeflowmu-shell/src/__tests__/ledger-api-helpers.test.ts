/**
 * ledger-api-helpers — ledger-first panel reads + ensureFresh TTL gate
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, afterEach } from "node:test";

import {
  LEDGER_FRESH_TTL_MS,
  ensureLedgerFresh,
  invalidateLedgerFreshCache,
  listReportsFromLedgerFile,
  listTasksFromLedgerFile,
  countLedgerTaskOrphans,
  isLedgerTaskIdOrphan,
  readLedgerThreads,
  resetLedgerFreshGateForTests,
  aggregateApprovalHistoryFromLedger,
  classifyApprovalHistoryOutcome,
  projectLedgerTaskFromRow,
  buildLedgerThreadIndex,
  buildLedgerProjectionContext,
  applyExecutionGateProjection,
} from "../ledger-api-helpers.ts";
import {
  loadExecutionGateContext,
  resolveLedgerLayout,
  VIRTUAL_PM_AUTO_REVIEW_NOTE,
} from "@codeflowmu/runtime";

function makeLedgerProject(): string {
  const root = mkdtempSync(join(tmpdir(), "cf-ledger-api-helpers-"));
  const layout = resolveLedgerLayout(root);
  mkdirSync(layout.ledgerDir, { recursive: true });
  mkdirSync(join(root, "fcop", "_lifecycle", "inbox"), { recursive: true });
  mkdirSync(join(root, "fcop", "_lifecycle", "active"), { recursive: true });
  mkdirSync(join(root, "fcop", "reports"), { recursive: true });

  const inboxTask = join(root, "fcop", "_lifecycle", "inbox", "TASK-20260531-240-ADMIN-to-PM.md");
  const activeTask = join(root, "fcop", "_lifecycle", "active", "TASK-20260531-241-PM-to-OPS.md");
  writeFileSync(inboxTask, "---\nprotocol: fcop\nversion: 1\nsender: ADMIN\nrecipient: PM\n---\n", "utf-8");
  writeFileSync(activeTask, "---\nprotocol: fcop\nversion: 1\nsender: PM\nrecipient: OPS\n---\n", "utf-8");
  writeFileSync(
    join(root, "fcop", "reports", "REPORT-20260531-001-PM-to-ADMIN.md"),
    "---\nprotocol: fcop\nversion: 1\nsender: PM\nrecipient: ADMIN\n---\n",
    "utf-8",
  );
  writeFileSync(
    join(root, "fcop", "reports", "REPORT-20260531-002-OPS-to-PM.md"),
    "---\nprotocol: fcop\nversion: 1\nsender: OPS\nrecipient: PM\n---\n",
    "utf-8",
  );

  writeFileSync(
    join(layout.ledgerDir, "tasks.jsonl"),
    [
      JSON.stringify({
        task_id: "TASK-20260531-240-ADMIN-to-PM",
        filename: "TASK-20260531-240-ADMIN-to-PM.md",
        sender: "ADMIN",
        recipient: "PM",
        bucket: "inbox",
        state: "inbox",
        path: "fcop/_lifecycle/inbox/TASK-20260531-240-ADMIN-to-PM.md",
      }),
      JSON.stringify({
        task_id: "TASK-20260531-241-PM-to-OPS",
        filename: "TASK-20260531-241-PM-to-OPS.md",
        sender: "PM",
        recipient: "OPS",
        bucket: "active",
        state: "active",
        path: "fcop/_lifecycle/active/TASK-20260531-241-PM-to-OPS.md",
      }),
    ].join("\n"),
    "utf-8",
  );

  writeFileSync(
    join(layout.ledgerDir, "reports.jsonl"),
    [
      JSON.stringify({
        report_id: "REPORT-20260531-001-PM-to-ADMIN",
        task_id: "TASK-20260531-240-ADMIN-to-PM",
        filename: "REPORT-20260531-001-PM-to-ADMIN.md",
        sender: "PM",
        recipient: "ADMIN",
        status: "done",
        references: ["TASK-20260531-240"],
        path: "fcop/reports/REPORT-20260531-001-PM-to-ADMIN.md",
      }),
      JSON.stringify({
        report_id: "REPORT-20260531-002-OPS-to-PM",
        task_id: "TASK-20260531-241-PM-to-OPS",
        filename: "REPORT-20260531-002-OPS-to-PM.md",
        sender: "OPS",
        recipient: "PM",
        status: "done",
        references: ["TASK-20260531-241"],
        path: "fcop/reports/REPORT-20260531-002-OPS-to-PM.md",
      }),
    ].join("\n"),
    "utf-8",
  );

  writeFileSync(
    join(layout.ledgerDir, "threads.jsonl"),
    [
      JSON.stringify({
        thread_key: "panel-task-240",
        task_ids: ["TASK-20260531-240-ADMIN-to-PM", "TASK-20260531-241-PM-to-OPS"],
        pending_pm_review: ["TASK-20260531-241-PM-to-OPS"],
      }),
    ].join("\n"),
    "utf-8",
  );

  mkdirSync(join(root, "fcop", "_lifecycle", "inbox"), { recursive: true });
  writeFileSync(
    join(root, "fcop", "fcop.json"),
    JSON.stringify({ protocol_version: 3, mode: "team" }),
    "utf-8",
  );

  return root;
}

const EXEC_GATE_THREAD = "exec-gate-panel-001";
const EXEC_GATE_DEV_TASK = "TASK-20260620-002-PM-to-DEV";
const EXEC_GATE_QA_TASK = "TASK-20260620-003-PM-to-QA";
const EXEC_GATE_DEV_REPORT = "REPORT-20260620-001-DEV-to-PM";

/** DEV + QA in one thread; DEV settled when devSettled=true (done bucket + done report). */
function makeExecutionGateThreadProject(opts: { devSettled: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), "cf-exec-gate-proj-"));
  const layout = resolveLedgerLayout(root);
  mkdirSync(layout.ledgerDir, { recursive: true });
  mkdirSync(join(root, "fcop", "_lifecycle", "inbox"), { recursive: true });
  mkdirSync(join(root, "fcop", "_lifecycle", "active"), { recursive: true });
  mkdirSync(join(root, "fcop", "_lifecycle", "done"), { recursive: true });
  mkdirSync(join(root, "fcop", "reports"), { recursive: true });

  const devBucket = opts.devSettled ? "done" : "active";
  const devPath = join(
    root,
    "fcop",
    "_lifecycle",
    devBucket,
    `${EXEC_GATE_DEV_TASK}.md`,
  );
  const qaPath = join(
    root,
    "fcop",
    "_lifecycle",
    "inbox",
    `${EXEC_GATE_QA_TASK}.md`,
  );

  writeFileSync(
    devPath,
    [
      "---",
      "protocol: fcop",
      "version: 1",
      "sender: PM",
      "recipient: DEV",
      `thread_key: ${EXEC_GATE_THREAD}`,
      "---",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    qaPath,
    [
      "---",
      "protocol: fcop",
      "version: 1",
      "sender: PM",
      "recipient: QA",
      `thread_key: ${EXEC_GATE_THREAD}`,
      `depends_on: [${EXEC_GATE_DEV_TASK}]`,
      "---",
    ].join("\n"),
    "utf-8",
  );

  const taskLines = [
    JSON.stringify({
      task_id: EXEC_GATE_DEV_TASK,
      filename: `${EXEC_GATE_DEV_TASK}.md`,
      sender: "PM",
      recipient: "DEV",
      thread_key: EXEC_GATE_THREAD,
      bucket: devBucket,
      state: devBucket,
      path: `fcop/_lifecycle/${devBucket}/${EXEC_GATE_DEV_TASK}.md`,
    }),
    JSON.stringify({
      task_id: EXEC_GATE_QA_TASK,
      filename: `${EXEC_GATE_QA_TASK}.md`,
      sender: "PM",
      recipient: "QA",
      thread_key: EXEC_GATE_THREAD,
      bucket: "inbox",
      state: "inbox",
      path: `fcop/_lifecycle/inbox/${EXEC_GATE_QA_TASK}.md`,
    }),
  ];
  writeFileSync(join(layout.ledgerDir, "tasks.jsonl"), taskLines.join("\n"), "utf-8");

  const reportLines: string[] = [];
  if (opts.devSettled) {
    writeFileSync(
      join(root, "fcop", "reports", `${EXEC_GATE_DEV_REPORT}.md`),
      [
        "---",
        "protocol: fcop",
        "version: 1",
        `task_id: ${EXEC_GATE_DEV_TASK}`,
        "status: done",
        "---",
      ].join("\n"),
      "utf-8",
    );
    reportLines.push(
      JSON.stringify({
        report_id: EXEC_GATE_DEV_REPORT,
        task_id: EXEC_GATE_DEV_TASK,
        filename: `${EXEC_GATE_DEV_REPORT}.md`,
        sender: "DEV",
        recipient: "PM",
        status: "done",
        thread_key: EXEC_GATE_THREAD,
        path: `fcop/reports/${EXEC_GATE_DEV_REPORT}.md`,
      }),
    );
  }
  writeFileSync(
    join(layout.ledgerDir, "reports.jsonl"),
    reportLines.join("\n"),
    "utf-8",
  );

  writeFileSync(
    join(root, "fcop", "fcop.json"),
    JSON.stringify({ protocol_version: 3, mode: "team" }),
    "utf-8",
  );

  return root;
}

const tempRoots: string[] = [];

afterEach(() => {
  resetLedgerFreshGateForTests();
  while (tempRoots.length) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

test("listTasksFromLedgerFile skips ledger rows whose task file is missing", () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  const layout = resolveLedgerLayout(root);
  writeFileSync(
    join(layout.ledgerDir, "tasks.jsonl"),
    [
      JSON.stringify({
        task_id: "TASK-20260531-240-ADMIN-to-PM",
        filename: "TASK-20260531-240-ADMIN-to-PM.md",
        sender: "ADMIN",
        recipient: "PM",
        bucket: "inbox",
        state: "inbox",
        path: "fcop/_lifecycle/inbox/TASK-20260531-240-ADMIN-to-PM.md",
      }),
      JSON.stringify({
        task_id: "TASK-20260531-999-PM-to-DEV",
        filename: "TASK-20260531-999-PM-to-DEV.md",
        sender: "PM",
        recipient: "DEV",
        bucket: "archive",
        state: "archive",
        path: "fcop/_lifecycle/archive/TASK-20260531-999-PM-to-DEV.md",
      }),
    ].join("\n"),
    "utf-8",
  );

  const tasks = listTasksFromLedgerFile(root, { limit: 10 });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.task_id, "TASK-20260531-240-ADMIN-to-PM");
  assert.equal(countLedgerTaskOrphans(root), 1);
});

test("listTasksFromLedgerFile skips ledger rows with empty path when file is missing", () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  const layout = resolveLedgerLayout(root);
  writeFileSync(
    join(layout.ledgerDir, "tasks.jsonl"),
    JSON.stringify({
      task_id: "TASK-20260609-005-ADMIN-to-PM",
      filename: "TASK-20260609-005-ADMIN-to-PM.md",
      sender: "ADMIN",
      recipient: "PM",
      bucket: "inbox",
      state: "inbox",
      path: "",
    }),
    "utf-8",
  );

  const tasks = listTasksFromLedgerFile(root, { limit: 10 });
  assert.equal(tasks.length, 0);
  assert.equal(countLedgerTaskOrphans(root), 1);
  assert.equal(isLedgerTaskIdOrphan(root, "TASK-20260609-005-ADMIN-to-PM"), true);
});

test("listReportsFromLedgerFile skips reports whose file is missing", () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  const layout = resolveLedgerLayout(root);
  writeFileSync(
    join(layout.ledgerDir, "reports.jsonl"),
    JSON.stringify({
      report_id: "REPORT-ghost-001",
      task_id: "TASK-ghost",
      filename: "REPORT-ghost-001.md",
      sender: "DEV",
      recipient: "PM",
      status: "done",
      path: "fcop/reports/REPORT-ghost-001.md",
    }),
    "utf-8",
  );

  const reports = listReportsFromLedgerFile(root, { limit: 10 });
  assert.equal(reports.length, 0);
});

test("listTasksFromLedgerFile maps ledger task rows", () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  const tasks = listTasksFromLedgerFile(root, { limit: 10 });
  assert.equal(tasks.length, 2);
  const t240 = tasks.find((t) => t.task_id === "TASK-20260531-240-ADMIN-to-PM");
  const t241 = tasks.find((t) => t.task_id === "TASK-20260531-241-PM-to-OPS");
  assert.ok(t240);
  assert.ok(t241);
  assert.equal(t240?._source, "ledger");
  assert.equal(t240?.scope, "inbox");
  assert.equal(t240?.bucket, "inbox");
  assert.equal(t241?.scope, "review");
  assert.equal(t241?.bucket, "active");
  assert.equal(t241?.display_status, "waiting_pm_review");
});

test("listTasksFromLedgerFile projects pending_pm_review and waiting_pm_consolidation", () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  const layout = resolveLedgerLayout(root);
  writeFileSync(
    join(layout.ledgerDir, "threads.jsonl"),
    [
      JSON.stringify({
        thread_key: "panel-task-240",
        root_task_id: "TASK-20260531-240-ADMIN-to-PM",
        task_ids: ["TASK-20260531-240-ADMIN-to-PM", "TASK-20260531-241-PM-to-OPS"],
        pending_pm_review: ["TASK-20260531-241-PM-to-OPS"],
        waiting_pm_consolidation: true,
      }),
    ].join("\n"),
    "utf-8",
  );

  const tasks = listTasksFromLedgerFile(root, { limit: 10 });
  const t241 = tasks.find((t) => t.task_id === "TASK-20260531-241-PM-to-OPS");
  const t240 = tasks.find((t) => t.task_id === "TASK-20260531-240-ADMIN-to-PM");
  assert.equal(t241?.scope, "review");
  assert.equal(t241?.bucket, "active");
  assert.equal(t241?.display_status, "waiting_pm_review");
  assert.equal(t240?.display_status, "waiting_pm_consolidation");
});

test("listTasksFromLedgerFile projects waiting_pm_attention when excluded from pending_pm_review", () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  const layout = resolveLedgerLayout(root);
  writeFileSync(
    join(layout.ledgerDir, "tasks.jsonl"),
    JSON.stringify({
      task_id: "TASK-20260531-241-PM-to-OPS",
      filename: "TASK-20260531-241-PM-to-OPS.md",
      sender: "PM",
      recipient: "OPS",
      bucket: "active",
      state: "active",
      display_status: "waiting_pm_attention",
      pm_attention_reason:
        "事实核查未通过：REPORT 含表格或数字统计，但动作日志缺少 command.run、file.read 或 data.query 等执行证据",
      path: "fcop/_lifecycle/active/TASK-20260531-241-PM-to-OPS.md",
    }),
    "utf-8",
  );
  writeFileSync(
    join(layout.ledgerDir, "threads.jsonl"),
    JSON.stringify({
      thread_key: "panel-task-240",
      root_task_id: "TASK-20260531-240-ADMIN-to-PM",
      task_ids: ["TASK-20260531-240-ADMIN-to-PM", "TASK-20260531-241-PM-to-OPS"],
      pending_pm_review: [],
    }),
    "utf-8",
  );

  const tasks = listTasksFromLedgerFile(root, { limit: 10 });
  const t241 = tasks.find((t) => t.task_id === "TASK-20260531-241-PM-to-OPS");
  assert.equal(t241?.bucket, "active");
  assert.equal(t241?.scope, "active");
  assert.equal(t241?.display_status, "waiting_pm_attention");
  const expectedReason =
    "事实核查未通过：REPORT 含表格或数字统计，但动作日志缺少 command.run、file.read 或 data.query 等执行证据";
  assert.equal(t241?.display_reason, expectedReason);
});

test("listTasksFromLedgerFile keeps waiting_pm_attention on physical bucket when pending_pm_review", () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  const layout = resolveLedgerLayout(root);
  const tasksPath = join(layout.ledgerDir, "tasks.jsonl");
  writeFileSync(
    tasksPath,
    [
      JSON.stringify({
        task_id: "TASK-20260531-240-ADMIN-to-PM",
        filename: "TASK-20260531-240-ADMIN-to-PM.md",
        sender: "ADMIN",
        recipient: "PM",
        bucket: "inbox",
        state: "inbox",
        path: "fcop/_lifecycle/inbox/TASK-20260531-240-ADMIN-to-PM.md",
      }),
      JSON.stringify({
        task_id: "TASK-20260531-241-PM-to-OPS",
        filename: "TASK-20260531-241-PM-to-OPS.md",
        sender: "PM",
        recipient: "OPS",
        bucket: "active",
        state: "active",
        display_status: "waiting_pm_attention",
        pm_attention_reason:
          "事实核查未通过：REPORT 含表格或数字统计，但动作日志缺少 command.run、file.read 或 data.query 等执行证据",
        path: "fcop/_lifecycle/active/TASK-20260531-241-PM-to-OPS.md",
      }),
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    join(layout.ledgerDir, "threads.jsonl"),
    JSON.stringify({
      thread_key: "panel-task-240",
      root_task_id: "TASK-20260531-240-ADMIN-to-PM",
      task_ids: ["TASK-20260531-240-ADMIN-to-PM", "TASK-20260531-241-PM-to-OPS"],
      pending_pm_review: ["TASK-20260531-241-PM-to-OPS"],
    }),
    "utf-8",
  );

  const tasks = listTasksFromLedgerFile(root, { limit: 10 });
  const t241 = tasks.find((t) => t.task_id === "TASK-20260531-241-PM-to-OPS");
  assert.equal(t241?.bucket, "active");
  assert.equal(t241?.scope, "active");
  assert.equal(t241?.display_status, "waiting_pm_attention");
  const expectedReason =
    "事实核查未通过：REPORT 含表格或数字统计，但动作日志缺少 command.run、file.read 或 data.query 等执行证据";
  assert.equal(t241?.display_reason, expectedReason);
  assert.equal(t241?.pm_attention_reason, expectedReason);
});

test("listTasksFromLedgerFile projects human_review_approved when settled approved", () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  const layout = resolveLedgerLayout(root);
  mkdirSync(join(root, "fcop", "_lifecycle", "done"), { recursive: true });
  const donePath = join(root, "fcop", "_lifecycle", "done", "TASK-20260618-003-PM-to-QA.md");
  writeFileSync(
    donePath,
    "---\nprotocol: fcop\nversion: 1\nsender: PM\nrecipient: QA\nreview_status: approved\n---\n",
    "utf-8",
  );
  writeFileSync(
    join(layout.ledgerDir, "tasks.jsonl"),
    JSON.stringify({
      task_id: "TASK-20260618-003-PM-to-QA",
      filename: "TASK-20260618-003-PM-to-QA.md",
      sender: "PM",
      recipient: "QA",
      bucket: "done",
      state: "done",
      review_status: "approved",
      display_status: "waiting_pm_attention",
      pm_attention_reason: "事实核查未通过：缺少 file.edit 证据",
      path: "fcop/_lifecycle/done/TASK-20260618-003-PM-to-QA.md",
    }),
    "utf-8",
  );
  writeFileSync(
    join(layout.ledgerDir, "threads.jsonl"),
    JSON.stringify({
      thread_key: "panel-task-qa",
      root_task_id: "TASK-20260618-003-PM-to-QA",
      task_ids: ["TASK-20260618-003-PM-to-QA"],
      pending_pm_review: ["TASK-20260618-003-PM-to-QA"],
    }),
    "utf-8",
  );

  const tasks = listTasksFromLedgerFile(root, { limit: 10 });
  const qa = tasks.find((t) => t.task_id === "TASK-20260618-003-PM-to-QA");
  assert.equal(qa?.scope, "done");
  assert.equal(qa?.display_status, "human_review_approved");
  assert.equal(qa?.display_reason, undefined);
});

test("listTasksFromLedgerFile projects human_review_approved for archived ADMIN mainline", () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  const layout = resolveLedgerLayout(root);
  mkdirSync(join(root, "fcop", "_lifecycle", "archive"), { recursive: true });
  const archivePath = join(
    root,
    "fcop",
    "_lifecycle",
    "archive",
    "TASK-20260618-004-ADMIN-to-PM.md",
  );
  writeFileSync(
    archivePath,
    "---\nprotocol: fcop\nversion: 1\nsender: ADMIN\nrecipient: PM\nreview_status: approved\n---\n",
    "utf-8",
  );
  writeFileSync(
    join(layout.ledgerDir, "tasks.jsonl"),
    JSON.stringify({
      task_id: "TASK-20260618-004-ADMIN-to-PM",
      filename: "TASK-20260618-004-ADMIN-to-PM.md",
      sender: "ADMIN",
      recipient: "PM",
      bucket: "archive",
      state: "archive",
      review_status: "approved",
      display_status: "waiting_pm_review",
      path: "fcop/_lifecycle/archive/TASK-20260618-004-ADMIN-to-PM.md",
    }),
    "utf-8",
  );
  writeFileSync(
    join(layout.ledgerDir, "threads.jsonl"),
    JSON.stringify({
      thread_key: "panel-task-admin",
      root_task_id: "TASK-20260618-004-ADMIN-to-PM",
      task_ids: ["TASK-20260618-004-ADMIN-to-PM"],
      pending_pm_review: ["TASK-20260618-004-ADMIN-to-PM"],
    }),
    "utf-8",
  );

  const tasks = listTasksFromLedgerFile(root, { limit: 10 });
  const main = tasks.find((t) => t.task_id === "TASK-20260618-004-ADMIN-to-PM");
  assert.equal(main?.scope, "archive");
  assert.equal(main?.display_status, "human_review_approved");
});

test("listTasksFromLedgerFile prefers admin_rejected over waiting_pm_consolidation when task was reopened", () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  const layout = resolveLedgerLayout(root);
  const tasksPath = join(layout.ledgerDir, "tasks.jsonl");
  const rows = [
    JSON.stringify({
      task_id: "TASK-20260531-240-ADMIN-to-PM",
      filename: "TASK-20260531-240-ADMIN-to-PM.md",
      sender: "ADMIN",
      recipient: "PM",
      bucket: "inbox",
      state: "inbox",
      review_status: "rejected",
      reopen_reason: "没报告？",
      reopened_count: 1,
      path: "fcop/_lifecycle/inbox/TASK-20260531-240-ADMIN-to-PM.md",
    }),
    JSON.stringify({
      task_id: "TASK-20260531-241-PM-to-OPS",
      filename: "TASK-20260531-241-PM-to-OPS.md",
      sender: "PM",
      recipient: "OPS",
      bucket: "active",
      state: "active",
      path: "fcop/_lifecycle/active/TASK-20260531-241-PM-to-OPS.md",
    }),
  ];
  writeFileSync(tasksPath, rows.join("\n"), "utf-8");
  writeFileSync(
    join(layout.ledgerDir, "threads.jsonl"),
    [
      JSON.stringify({
        thread_key: "panel-task-240",
        root_task_id: "TASK-20260531-240-ADMIN-to-PM",
        task_ids: ["TASK-20260531-240-ADMIN-to-PM", "TASK-20260531-241-PM-to-OPS"],
        pending_pm_review: ["TASK-20260531-241-PM-to-OPS"],
        waiting_pm_consolidation: true,
      }),
    ].join("\n"),
    "utf-8",
  );

  const tasks = listTasksFromLedgerFile(root, { limit: 10 });
  const t240 = tasks.find((t) => t.task_id === "TASK-20260531-240-ADMIN-to-PM");
  assert.equal(t240?.display_status, "admin_rejected");
  assert.notEqual(t240?.display_status, "waiting_pm_consolidation");
});

test("listReportsFromLedgerFile maps linked_task_ids for report pairing", () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  const reports = listReportsFromLedgerFile(root, { limit: 10 });
  assert.equal(reports.length, 2);
  const r240 = reports.find((r) => r.report_id === "REPORT-20260531-001-PM-to-ADMIN");
  const r241 = reports.find((r) => r.report_id === "REPORT-20260531-002-OPS-to-PM");
  const linked240 = (r240?.linked_task_ids ?? []) as string[];
  const linked241 = (r241?.linked_task_ids ?? []) as string[];
  assert.ok(linked240.includes("TASK-20260531-240-ADMIN-to-PM"));
  assert.ok(linked240.includes("TASK-20260531-240"));
  assert.ok(linked241.includes("TASK-20260531-241-PM-to-OPS"));
  assert.ok(linked241.includes("TASK-20260531-241"));
});

test("readLedgerThreads exposes pending_pm_review from ledger", () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  const threads = readLedgerThreads(root);
  assert.equal(threads.length, 1);
  assert.equal(threads[0]?.thread_key, "panel-task-240");
  assert.deepEqual(threads[0]?.pending_pm_review, ["TASK-20260531-241-PM-to-OPS"]);
});

test("ensureLedgerFresh coalesces parallel calls within TTL", async () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  resetLedgerFreshGateForTests();

  const results = await Promise.all([
    ensureLedgerFresh(root),
    ensureLedgerFresh(root),
    ensureLedgerFresh(root),
  ]);
  assert.equal(results.length, 3);
  for (const ok of results) {
    assert.equal(typeof ok, "boolean");
  }

  invalidateLedgerFreshCache(root);
  const again = await ensureLedgerFresh(root);
  assert.equal(typeof again, "boolean");
});

test("LEDGER_FRESH_TTL_MS is positive debounce window", () => {
  assert.ok(LEDGER_FRESH_TTL_MS >= 1000);
});

test("listTasksFromLedgerFile: reopened PM branch child must not scope done despite parent", () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  const layout = resolveLedgerLayout(root);

  const devTaskFn = "TASK-20260602-010-PM-to-DEV.md";
  const devTaskPath = join(root, "fcop", "_lifecycle", "active", devTaskFn);
  writeFileSync(
    devTaskPath,
    [
      "---",
      "protocol: fcop",
      "version: 1",
      "sender: PM",
      "recipient: DEV",
      "parent: TASK-20260602-001-ADMIN-to-PM",
      "reopen_reason: ADMIN reject_review",
      "reopened_count: 2",
      "review_status: rejected",
      "---",
      "",
      "# 打回重做",
    ].join("\n"),
    "utf-8",
  );

  writeFileSync(
    join(layout.ledgerDir, "tasks.jsonl"),
    JSON.stringify({
      task_id: "TASK-20260602-010-PM-to-DEV",
      filename: devTaskFn,
      sender: "PM",
      recipient: "DEV",
      bucket: "tasks",
      state: "active",
      parent: "TASK-20260602-001-ADMIN-to-PM",
      path: `fcop/_lifecycle/active/${devTaskFn}`,
      reopen_reason: "ADMIN reject_review",
      reopened_count: 2,
      review_status: "rejected",
    }),
    "utf-8",
  );

  const tasks = listTasksFromLedgerFile(root, { recipient: "DEV", limit: 20 });
  const dev = tasks.find((t) => t.task_id === "TASK-20260602-010-PM-to-DEV");
  assert.ok(dev, "DEV task should appear in ledger list");
  assert.equal(dev?.display_status, "admin_rejected");
  assert.notEqual(dev?.scope, "done");
  assert.equal(dev?.scope, "active");
});

test("listTasksFromLedgerFile: approved done task ignores historical reopen fields", () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  const layout = resolveLedgerLayout(root);
  mkdirSync(join(root, "fcop", "_lifecycle", "done"), { recursive: true });

  const taskFn = "TASK-20260603-002-ADMIN-to-PM.md";
  const taskPath = join(root, "fcop", "_lifecycle", "done", taskFn);
  writeFileSync(
    taskPath,
    [
      "---",
      "protocol: fcop",
      "version: 1",
      "sender: ADMIN",
      "recipient: PM",
      "state: done",
      "review_status: approved",
      "reopen_reason: 历史打回原因",
      "reopened_count: 2",
      "---",
      "",
      "# 已完成主线",
    ].join("\n"),
    "utf-8",
  );

  writeFileSync(
    join(layout.ledgerDir, "tasks.jsonl"),
    JSON.stringify({
      task_id: "TASK-20260603-002",
      filename: taskFn,
      sender: "ADMIN",
      recipient: "PM",
      bucket: "done",
      state: "done",
      path: `fcop/_lifecycle/done/${taskFn}`,
      reopen_reason: "历史打回原因",
      reopened_count: 2,
      review_status: "approved",
    }),
    "utf-8",
  );

  const tasks = listTasksFromLedgerFile(root, { recipient: "PM", limit: 20 });
  const task = tasks.find((t) => t.task_id === "TASK-20260603-002");
  assert.ok(task, "done task should appear in ledger list");
  assert.equal(task?.scope, "done");
  assert.notEqual(task?.display_status, "admin_rejected");
});

test("listTasksFromLedgerFile: PM branch child with parent must not scope done without DEV-to-PM report", () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  const layout = resolveLedgerLayout(root);
  mkdirSync(join(root, "fcop", "tasks"), { recursive: true });

  const devTaskFn = "TASK-20260603-003-PM-to-DEV.md";
  const devTaskPath = join(root, "fcop", "tasks", devTaskFn);
  writeFileSync(
    devTaskPath,
    [
      "---",
      "protocol: fcop",
      "version: 1",
      "sender: PM",
      "recipient: DEV",
      "parent: TASK-20260603-002-ADMIN-to-PM",
      "---",
      "",
      "# DEV branch",
    ].join("\n"),
    "utf-8",
  );

  writeFileSync(
    join(root, "fcop", "reports", "REPORT-20260603-003-PM-to-ADMIN.md"),
    [
      "---",
      "protocol: fcop",
      "version: 1",
      "sender: PM",
      "recipient: ADMIN",
      "parent: TASK-20260603-002-ADMIN-to-PM",
      "---",
    ].join("\n"),
    "utf-8",
  );

  writeFileSync(
    join(layout.ledgerDir, "tasks.jsonl"),
    JSON.stringify({
      task_id: "TASK-20260603-003-PM-to-DEV",
      filename: devTaskFn,
      sender: "PM",
      recipient: "DEV",
      bucket: "tasks",
      state: "active",
      parent: "TASK-20260603-002-ADMIN-to-PM",
      path: `fcop/tasks/${devTaskFn}`,
    }),
    "utf-8",
  );

  writeFileSync(
    join(layout.ledgerDir, "reports.jsonl"),
    JSON.stringify({
      report_id: "REPORT-20260603-003-PM-to-ADMIN",
      task_id: "TASK-20260603-002-ADMIN-to-PM",
      filename: "REPORT-20260603-003-PM-to-ADMIN.md",
      sender: "PM",
      recipient: "ADMIN",
      status: "done",
      references: ["TASK-20260603-002"],
      path: "fcop/reports/REPORT-20260603-003-PM-to-ADMIN.md",
    }),
    "utf-8",
  );

  const tasks = listTasksFromLedgerFile(root, { recipient: "DEV", limit: 20 });
  const dev = tasks.find((t) => t.task_id === "TASK-20260603-003-PM-to-DEV");
  assert.ok(dev, "DEV task should appear in ledger list");
  assert.notEqual(dev?.scope, "done");
  assert.equal(dev?.scope, "active");
});

test("aggregateApprovalHistoryFromLedger last-wins counts one task_id across jsonl rows", () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  const layout = resolveLedgerLayout(root);
  mkdirSync(join(root, "fcop", "_lifecycle", "done"), { recursive: true });
  const donePath = join(root, "fcop", "_lifecycle", "done", "TASK-20260618-010-PM-to-QA.md");
  writeFileSync(
    donePath,
    "---\nprotocol: fcop\nversion: 1\nsender: PM\nrecipient: QA\nreview_status: approved\n---\n",
    "utf-8",
  );
  writeFileSync(
    join(layout.ledgerDir, "tasks.jsonl"),
    [
      JSON.stringify({
        task_id: "TASK-20260618-010-PM-to-QA",
        filename: "TASK-20260618-010-PM-to-QA.md",
        sender: "PM",
        recipient: "QA",
        bucket: "review",
        state: "review",
        review_status: "pending",
        path: "fcop/_lifecycle/done/TASK-20260618-010-PM-to-QA.md",
      }),
      JSON.stringify({
        task_id: "TASK-20260618-010-PM-to-QA",
        filename: "TASK-20260618-010-PM-to-QA.md",
        sender: "PM",
        recipient: "QA",
        bucket: "done",
        state: "done",
        review_status: "approved",
        path: "fcop/_lifecycle/done/TASK-20260618-010-PM-to-QA.md",
      }),
    ].join("\n"),
    "utf-8",
  );

  const { stats, total, history } = aggregateApprovalHistoryFromLedger(root);
  assert.equal(stats.approved, 1);
  assert.equal(stats.rejected, 0);
  assert.equal(stats.total, 1);
  assert.equal(total, 1);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.resolved_decision, "approved");
});

test("aggregateApprovalHistoryFromLedger includes settled approved and rejected", () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  const layout = resolveLedgerLayout(root);
  mkdirSync(join(root, "fcop", "_lifecycle", "done"), { recursive: true });
  mkdirSync(join(root, "fcop", "_lifecycle", "archive"), { recursive: true });
  writeFileSync(
    join(root, "fcop", "_lifecycle", "done", "TASK-20260618-011-PM-to-QA.md"),
    "---\nprotocol: fcop\nversion: 1\nsender: PM\nrecipient: QA\nreview_status: approved\n---\n",
    "utf-8",
  );
  writeFileSync(
    join(root, "fcop", "_lifecycle", "archive", "TASK-20260618-012-PM-to-OPS.md"),
    "---\nprotocol: fcop\nversion: 1\nsender: PM\nrecipient: OPS\nreview_status: rejected\n---\n",
    "utf-8",
  );
  writeFileSync(
    join(layout.ledgerDir, "tasks.jsonl"),
    [
      JSON.stringify({
        task_id: "TASK-20260618-011-PM-to-QA",
        filename: "TASK-20260618-011-PM-to-QA.md",
        sender: "PM",
        recipient: "QA",
        bucket: "done",
        state: "done",
        review_status: "approved",
        path: "fcop/_lifecycle/done/TASK-20260618-011-PM-to-QA.md",
      }),
      JSON.stringify({
        task_id: "TASK-20260618-012-PM-to-OPS",
        filename: "TASK-20260618-012-PM-to-OPS.md",
        sender: "PM",
        recipient: "OPS",
        bucket: "archive",
        state: "archive",
        review_status: "rejected",
        path: "fcop/_lifecycle/archive/TASK-20260618-012-PM-to-OPS.md",
      }),
    ].join("\n"),
    "utf-8",
  );

  const { stats, history } = aggregateApprovalHistoryFromLedger(root);
  assert.equal(stats.approved, 1);
  assert.equal(stats.rejected, 1);
  assert.equal(stats.total, 2);
  assert.equal(history.length, 2);
  const decisions = history.map((h) => h.resolved_decision).sort();
  assert.deepEqual(decisions, ["approved", "rejected"]);
});

test("aggregateApprovalHistoryFromLedger treats reopened active rework as pending not history", () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  const layout = resolveLedgerLayout(root);
  writeFileSync(
    join(layout.ledgerDir, "tasks.jsonl"),
    JSON.stringify({
      task_id: "TASK-20260531-240-ADMIN-to-PM",
      filename: "TASK-20260531-240-ADMIN-to-PM.md",
      sender: "ADMIN",
      recipient: "PM",
      bucket: "active",
      state: "active",
      review_status: "rejected",
      reopen_reason: "needs rework",
      reopened_count: 1,
      path: "fcop/_lifecycle/inbox/TASK-20260531-240-ADMIN-to-PM.md",
    }),
    "utf-8",
  );

  const ctx = buildLedgerThreadIndex(root);
  const latest = [...aggregateApprovalHistoryFromLedger(root).history];
  assert.equal(latest.length, 0);

  const row = JSON.parse(
    readFileSync(join(layout.ledgerDir, "tasks.jsonl"), "utf-8").trim(),
  ) as Record<string, unknown>;
  const proj = projectLedgerTaskFromRow(root, row as never, ctx);
  assert.ok(proj);
  assert.equal(classifyApprovalHistoryOutcome(proj), "pending");

  const { stats } = aggregateApprovalHistoryFromLedger(root);
  assert.equal(stats.pending, 1);
  assert.equal(stats.total, 0);
});

test("aggregateApprovalHistoryFromLedger filters by decision", () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  const layout = resolveLedgerLayout(root);
  mkdirSync(join(root, "fcop", "_lifecycle", "done"), { recursive: true });
  mkdirSync(join(root, "fcop", "_lifecycle", "archive"), { recursive: true });
  writeFileSync(
    join(root, "fcop", "_lifecycle", "done", "TASK-20260618-011-PM-to-QA.md"),
    "---\nprotocol: fcop\nversion: 1\nsender: PM\nrecipient: QA\nreview_status: approved\n---\n",
    "utf-8",
  );
  writeFileSync(
    join(root, "fcop", "_lifecycle", "archive", "TASK-20260618-012-PM-to-OPS.md"),
    "---\nprotocol: fcop\nversion: 1\nsender: PM\nrecipient: OPS\nreview_status: rejected\n---\n",
    "utf-8",
  );
  writeFileSync(
    join(layout.ledgerDir, "tasks.jsonl"),
    [
      JSON.stringify({
        task_id: "TASK-20260618-011-PM-to-QA",
        filename: "TASK-20260618-011-PM-to-QA.md",
        sender: "PM",
        recipient: "QA",
        bucket: "done",
        state: "done",
        review_status: "approved",
        path: "fcop/_lifecycle/done/TASK-20260618-011-PM-to-QA.md",
      }),
      JSON.stringify({
        task_id: "TASK-20260618-012-PM-to-OPS",
        filename: "TASK-20260618-012-PM-to-OPS.md",
        sender: "PM",
        recipient: "OPS",
        bucket: "archive",
        state: "archive",
        review_status: "rejected",
        path: "fcop/_lifecycle/archive/TASK-20260618-012-PM-to-OPS.md",
      }),
    ].join("\n"),
    "utf-8",
  );

  const approvedOnly = aggregateApprovalHistoryFromLedger(root, { decision: "approved" });
  assert.equal(approvedOnly.stats.total, 2);
  assert.ok(approvedOnly.history.every((h) => h.resolved_decision === "approved"));

  const rejectedOnly = aggregateApprovalHistoryFromLedger(root, { decision: "rejected" });
  assert.ok(rejectedOnly.history.every((h) => h.resolved_decision === "rejected"));
});

test("projectLedgerTaskFromRow projects parent from yaml.parent only", () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  mkdirSync(join(root, "fcop", "_lifecycle", "archive"), { recursive: true });
  writeFileSync(
    join(root, "fcop", "_lifecycle", "archive", "TASK-20260618-017-ADMIN-to-PM.md"),
    "---\nprotocol: fcop\nversion: 1\nsender: ADMIN\nrecipient: PM\nparent: TASK-20260618-016\n---\n",
    "utf-8",
  );
  const ctx = buildLedgerThreadIndex(root);
  const row = {
    task_id: "TASK-20260618-017-ADMIN-to-PM",
    filename: "TASK-20260618-017-ADMIN-to-PM.md",
    sender: "ADMIN",
    recipient: "PM",
    bucket: "archive",
    state: "archive",
    path: "fcop/_lifecycle/archive/TASK-20260618-017-ADMIN-to-PM.md",
    yaml: { parent: "TASK-20260618-016" },
  };
  const proj = projectLedgerTaskFromRow(root, row as never, ctx);
  assert.ok(proj);
  assert.equal(proj!.parent, "TASK-20260618-016");
  assert.equal(proj!.parent_task_id, "TASK-20260618-016");
});

test("listTasksFromLedgerFile projects cancelled when force_archive transition", () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  const layout = resolveLedgerLayout(root);
  mkdirSync(join(root, "fcop", "_lifecycle", "archive"), { recursive: true });
  writeFileSync(
    join(root, "fcop", "_lifecycle", "archive", "TASK-20260619-005-PM-to-QA.md"),
    "---\nprotocol: fcop\nversion: 1\nsender: PM\nrecipient: QA\n---\n",
    "utf-8",
  );
  writeFileSync(
    join(layout.ledgerDir, "tasks.jsonl"),
    JSON.stringify({
      task_id: "TASK-20260619-005-PM-to-QA",
      filename: "TASK-20260619-005-PM-to-QA.md",
      sender: "PM",
      recipient: "QA",
      bucket: "archive",
      state: "archive",
      path: "fcop/_lifecycle/archive/TASK-20260619-005-PM-to-QA.md",
      transitions: [{ action: "force_archive_task", reason: "recovery cancelled" }],
    }),
    "utf-8",
  );

  const tasks = listTasksFromLedgerFile(root, { limit: 10 });
  const row = tasks.find((t) => t.task_id === "TASK-20260619-005-PM-to-QA");
  assert.equal(row?.display_status, "cancelled");
  assert.equal(row?.archive_mode, "force");
  assert.equal(row?.display_reason, "recovery cancelled");
});

test("listTasksFromLedgerFile projects worker_report_blocked for QA blocked REPORT", () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  const layout = resolveLedgerLayout(root);
  mkdirSync(join(root, "fcop", "_lifecycle", "active"), { recursive: true });
  mkdirSync(join(root, "fcop", "reports"), { recursive: true });
  const reportPath = join(root, "fcop", "reports", "REPORT-20260619-005-QA-to-PM.md");
  writeFileSync(
    join(root, "fcop", "_lifecycle", "active", "TASK-20260619-003-PM-to-QA.md"),
    "---\nprotocol: fcop\nversion: 1\nsender: PM\nrecipient: QA\n---\n",
    "utf-8",
  );
  writeFileSync(
    reportPath,
    [
      "---",
      "protocol: fcop",
      "version: 1",
      "sender: QA",
      "recipient: PM",
      "status: blocked",
      "---",
      "",
      "**FAIL** — dependency not met",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    join(layout.ledgerDir, "tasks.jsonl"),
    JSON.stringify({
      task_id: "TASK-20260619-003-PM-to-QA",
      filename: "TASK-20260619-003-PM-to-QA.md",
      sender: "PM",
      recipient: "QA",
      bucket: "active",
      state: "active",
      path: "fcop/_lifecycle/active/TASK-20260619-003-PM-to-QA.md",
    }),
    "utf-8",
  );
  writeFileSync(
    join(layout.ledgerDir, "reports.jsonl"),
    JSON.stringify({
      report_id: "REPORT-20260619-005-QA-to-PM",
      task_id: "TASK-20260619-003-PM-to-QA",
      filename: "REPORT-20260619-005-QA-to-PM.md",
      sender: "QA",
      recipient: "PM",
      status: "blocked",
      references: ["TASK-20260619-003"],
      path: "fcop/reports/REPORT-20260619-005-QA-to-PM.md",
    }),
    "utf-8",
  );

  const tasks = listTasksFromLedgerFile(root, { limit: 10 });
  const qa = tasks.find((t) => t.task_id === "TASK-20260619-003-PM-to-QA");
  assert.equal(qa?.display_status, "worker_report_blocked");
  assert.match(String(qa?.display_reason ?? ""), /blocked|依赖/);
});

test("listTasksFromLedgerFile projects worker_report_blocked for OPS blocked REPORT", () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  const layout = resolveLedgerLayout(root);
  mkdirSync(join(root, "fcop", "_lifecycle", "active"), { recursive: true });
  mkdirSync(join(root, "fcop", "reports"), { recursive: true });
  const taskId = "TASK-20260619-008-PM-to-OPS";
  const reportPath = join(root, "fcop", "reports", "REPORT-20260619-009-OPS-to-PM.md");
  writeFileSync(
    join(root, "fcop", "_lifecycle", "active", `${taskId}.md`),
    "---\nprotocol: fcop\nversion: 1\nsender: PM\nrecipient: OPS\n---\n",
    "utf-8",
  );
  writeFileSync(
    reportPath,
    "---\nprotocol: fcop\nversion: 1\nsender: OPS\nrecipient: PM\nstatus: blocked\n---\n\nbuild failed\n",
    "utf-8",
  );
  writeFileSync(
    join(layout.ledgerDir, "tasks.jsonl"),
    `${JSON.stringify({
      task_id: taskId,
      filename: `${taskId}.md`,
      sender: "PM",
      recipient: "OPS",
      bucket: "active",
      state: "active",
      path: `fcop/_lifecycle/active/${taskId}.md`,
    })}\n`,
    "utf-8",
  );
  writeFileSync(
    join(layout.ledgerDir, "reports.jsonl"),
    `${JSON.stringify({
      report_id: "REPORT-20260619-009-OPS-to-PM",
      task_id: taskId,
      filename: "REPORT-20260619-009-OPS-to-PM.md",
      sender: "OPS",
      recipient: "PM",
      status: "blocked",
      path: "fcop/reports/REPORT-20260619-009-OPS-to-PM.md",
    })}\n`,
    "utf-8",
  );

  const tasks = listTasksFromLedgerFile(root, { limit: 10 });
  const ops = tasks.find((t) => t.task_id === taskId);
  assert.equal(ops?.display_status, "worker_report_blocked");
  assert.match(String(ops?.display_reason ?? ""), /OPS REPORT status=blocked/);
});

test("listTasksFromLedgerFile projects qa_acceptance_fail when virtual PM settled but body FAIL", () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  const layout = resolveLedgerLayout(root);
  mkdirSync(join(root, "fcop", "_lifecycle", "done"), { recursive: true });
  mkdirSync(join(root, "fcop", "reports"), { recursive: true });
  writeFileSync(
    join(root, "fcop", "_lifecycle", "done", "TASK-20260619-007-PM-to-QA.md"),
    [
      "---",
      "protocol: fcop",
      "version: 1",
      "sender: PM",
      "recipient: QA",
      `review_status: approved`,
      `review_note: ${VIRTUAL_PM_AUTO_REVIEW_NOTE}`,
      "---",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    join(root, "fcop", "reports", "REPORT-20260619-010-QA-to-PM.md"),
    [
      "---",
      "protocol: fcop",
      "version: 1",
      "sender: QA",
      "recipient: PM",
      "status: done",
      "---",
      "",
      "## 结论",
      "",
      "**FAIL** — 1/10 checklist failed",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    join(layout.ledgerDir, "tasks.jsonl"),
    JSON.stringify({
      task_id: "TASK-20260619-007-PM-to-QA",
      filename: "TASK-20260619-007-PM-to-QA.md",
      sender: "PM",
      recipient: "QA",
      bucket: "done",
      state: "done",
      review_status: "approved",
      review_note: VIRTUAL_PM_AUTO_REVIEW_NOTE,
      path: "fcop/_lifecycle/done/TASK-20260619-007-PM-to-QA.md",
    }),
    "utf-8",
  );
  writeFileSync(
    join(layout.ledgerDir, "reports.jsonl"),
    JSON.stringify({
      report_id: "REPORT-20260619-010-QA-to-PM",
      task_id: "TASK-20260619-007-PM-to-QA",
      filename: "REPORT-20260619-010-QA-to-PM.md",
      sender: "QA",
      recipient: "PM",
      status: "done",
      references: ["TASK-20260619-007"],
      path: "fcop/reports/REPORT-20260619-010-QA-to-PM.md",
    }),
    "utf-8",
  );

  const tasks = listTasksFromLedgerFile(root, { limit: 10 });
  const qa = tasks.find((t) => t.task_id === "TASK-20260619-007-PM-to-QA");
  assert.equal(qa?.display_status, "qa_acceptance_fail");
  assert.match(String(qa?.display_reason ?? ""), /FAIL/);
});

test("listTasksFromLedgerFile projects auto_review_approved for virtual PM pass", () => {
  const root = makeLedgerProject();
  tempRoots.push(root);
  const layout = resolveLedgerLayout(root);
  mkdirSync(join(root, "fcop", "_lifecycle", "done"), { recursive: true });
  mkdirSync(join(root, "fcop", "reports"), { recursive: true });
  writeFileSync(
    join(root, "fcop", "_lifecycle", "done", "TASK-20260619-008-PM-to-QA.md"),
    "---\nprotocol: fcop\nversion: 1\nsender: PM\nrecipient: QA\nreview_status: approved\n---\n",
    "utf-8",
  );
  writeFileSync(
    join(root, "fcop", "reports", "REPORT-20260619-011-QA-to-PM.md"),
    [
      "---",
      "protocol: fcop",
      "version: 1",
      "sender: QA",
      "recipient: PM",
      "status: done",
      "---",
      "",
      "功能验收结论：**PASS**",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    join(layout.ledgerDir, "tasks.jsonl"),
    JSON.stringify({
      task_id: "TASK-20260619-008-PM-to-QA",
      filename: "TASK-20260619-008-PM-to-QA.md",
      sender: "PM",
      recipient: "QA",
      bucket: "done",
      state: "done",
      review_status: "approved",
      review_note: VIRTUAL_PM_AUTO_REVIEW_NOTE,
      path: "fcop/_lifecycle/done/TASK-20260619-008-PM-to-QA.md",
    }),
    "utf-8",
  );
  writeFileSync(
    join(layout.ledgerDir, "reports.jsonl"),
    JSON.stringify({
      report_id: "REPORT-20260619-011-QA-to-PM",
      task_id: "TASK-20260619-008-PM-to-QA",
      filename: "REPORT-20260619-011-QA-to-PM.md",
      sender: "QA",
      recipient: "PM",
      status: "done",
      references: ["TASK-20260619-008"],
      path: "fcop/reports/REPORT-20260619-011-QA-to-PM.md",
    }),
    "utf-8",
  );

  const tasks = listTasksFromLedgerFile(root, { limit: 10 });
  const qa = tasks.find((t) => t.task_id === "TASK-20260619-008-PM-to-QA");
  assert.equal(qa?.display_status, "auto_review_approved");
  assert.equal(qa?.display_reason, VIRTUAL_PM_AUTO_REVIEW_NOTE);
});

test("classifyApprovalHistoryOutcome excludes cancelled and qa_acceptance_fail", () => {
  assert.equal(
    classifyApprovalHistoryOutcome({ display_status: "cancelled" }),
    null,
  );
  assert.equal(
    classifyApprovalHistoryOutcome({ display_status: "qa_acceptance_fail" }),
    null,
  );
  assert.equal(
    classifyApprovalHistoryOutcome({ display_status: "worker_report_blocked" }),
    null,
  );
  assert.equal(
    classifyApprovalHistoryOutcome({ display_status: "auto_review_approved" }),
    "approved",
  );
});

test("listTasksFromLedgerFile projects execution gate when DEV settled (RETRY_QA)", async () => {
  const root = makeExecutionGateThreadProject({ devSettled: true });
  tempRoots.push(root);
  const gateCtx = await loadExecutionGateContext(root);
  const tasks = listTasksFromLedgerFile(root, { limit: 20, executionGate: gateCtx });
  const qa = tasks.find((t) => t.task_id === EXEC_GATE_QA_TASK);
  assert.ok(qa, "QA task row missing");
  assert.equal(qa?.qa_dispatch_allowed, true);
  assert.equal(qa?.qa_dispatch_block, undefined);
  assert.equal(qa?.pm_action, "RETRY_QA");
  assert.equal(qa?.execution_state, "runnable");
});

test("listTasksFromLedgerFile projects execution gate when DEV report pending (WAKE_DEV)", async () => {
  const root = makeExecutionGateThreadProject({ devSettled: false });
  tempRoots.push(root);
  const gateCtx = await loadExecutionGateContext(root);
  const tasks = listTasksFromLedgerFile(root, { limit: 20, executionGate: gateCtx });
  const qa = tasks.find((t) => t.task_id === EXEC_GATE_QA_TASK);
  assert.ok(qa, "QA task row missing");
  assert.equal(qa?.qa_dispatch_allowed, false);
  assert.equal(qa?.qa_dispatch_block, "dev_report_pending");
  assert.equal(qa?.qa_dispatch_waiting_on, "TASK-20260620-002");
  assert.equal(qa?.pm_action, "WAKE_DEV");
});

test("applyExecutionGateProjection enriches minimal task rows", async () => {
  const root = makeExecutionGateThreadProject({ devSettled: true });
  tempRoots.push(root);
  const gateCtx = await loadExecutionGateContext(root);
  const projected = applyExecutionGateProjection(
    [{ task_id: EXEC_GATE_QA_TASK, recipient: "QA" }],
    gateCtx,
  );
  assert.equal(projected.length, 1);
  assert.equal(projected[0]?.pm_action, "RETRY_QA");
  assert.equal(projected[0]?.qa_dispatch_allowed, true);
});

test("applyExecutionGateProjection keeps a done QA rework completed, never queued for retry", async () => {
  const root = makeExecutionGateThreadProject({ devSettled: true });
  tempRoots.push(root);
  const gateCtx = await loadExecutionGateContext(root);
  const qaRef = gateCtx.tasks.find((task) => task.taskId === EXEC_GATE_QA_TASK);
  assert.ok(qaRef, "QA task ref missing");
  qaRef.lifecycleBucket = "done";
  qaRef.fmState = "done";
  qaRef.displayStatus = "done";

  const projected = applyExecutionGateProjection(
    [{ task_id: EXEC_GATE_QA_TASK, recipient: "QA", scope: "done" }],
    gateCtx,
  );
  assert.equal(projected[0]?.pm_action, "OK");
  assert.equal(projected[0]?.execution_state, "completed");
  assert.equal(projected[0]?.qa_dispatch_allowed, false);
  assert.equal(projected[0]?.qa_dispatch_block, "already_done");
});
