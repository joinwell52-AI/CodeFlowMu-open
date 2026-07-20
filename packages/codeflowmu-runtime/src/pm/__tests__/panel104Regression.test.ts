import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evaluatePmSummaryGate } from "../PmSummaryGate.ts";
import { evaluatePanel104Acceptance } from "../panel104Acceptance.ts";
import {
  evaluateReportAttribution,
  inferReportFilenameTaskId,
  isValidDevReceiptForTask,
} from "../reportAttribution.ts";
import type {
  LedgerReportRecord,
  LedgerTaskRecord,
  LedgerThreadRecord,
} from "../../ledger/types.ts";

const THREAD = "panel-task-104";
const ROOT = "TASK-20260611-104";
const DEV = "TASK-20260612-002";
const QA = "TASK-20260612-003";
const OPS = "TASK-20260612-004";

function mkThread(overrides?: Partial<LedgerThreadRecord>): LedgerThreadRecord {
  return {
    thread_key: THREAD,
    root_task_id: ROOT,
    task_ids: [ROOT, DEV, QA, OPS],
    report_ids: [],
    pending_pm_review: [],
    ...overrides,
  };
}

function mkTask(overrides: Partial<LedgerTaskRecord>): LedgerTaskRecord {
  return {
    task_id: ROOT,
    filename: `${ROOT}-ADMIN-to-PM.md`,
    sender: "ADMIN",
    recipient: "PM",
    bucket: "active",
    path: "",
    created_at: "2026-06-12T10:00:00+08:00",
    updated_at: "2026-06-12T10:00:00+08:00",
    timezone: "Asia/Shanghai",
    created_at_utc: "2026-06-12T02:00:00Z",
    thread_key: THREAD,
    ...overrides,
  };
}

function mkReport(overrides: Partial<LedgerReportRecord>): LedgerReportRecord {
  return {
    report_id: "REPORT-20260612-002-DEV-to-PM",
    task_id: DEV,
    filename: "REPORT-20260612-002-DEV-to-PM.md",
    sender: "DEV",
    recipient: "PM",
    status: "done",
    path: "",
    created_at: "2026-06-12T11:00:00+08:00",
    updated_at: "2026-06-12T11:00:00+08:00",
    timezone: "Asia/Shanghai",
    created_at_utc: "2026-06-12T03:00:00Z",
    thread_key: THREAD,
    parent_task_id: DEV,
    references: [DEV],
    report_kind: "worker_to_pm",
    ...overrides,
  };
}

function panel104BaseTasks(): LedgerTaskRecord[] {
  return [
    mkTask({}),
    mkTask({
      task_id: DEV,
      filename: "TASK-20260612-002-PM-to-DEV.md",
      sender: "PM",
      recipient: "DEV",
      parent: ROOT,
      bucket: "done",
    }),
    mkTask({
      task_id: QA,
      filename: "TASK-20260612-003-PM-to-QA.md",
      sender: "PM",
      recipient: "QA",
      parent: ROOT,
      bucket: "review",
    }),
    mkTask({
      task_id: OPS,
      filename: "TASK-20260612-004-PM-to-OPS.md",
      sender: "PM",
      recipient: "OPS",
      parent: ROOT,
      bucket: "done",
    }),
  ];
}

describe("105 case 3 — REPORT 三字段 attribution", () => {
  it("FAIL: REPORT-003 filename vs fm/ref=002", () => {
    const result = evaluateReportAttribution("REPORT-20260612-003-DEV-to-PM.md", {
      task_id: DEV,
      references: [DEV],
    });
    assert.equal(result.pass, false);
    assert.equal(result.filenameTaskId, "TASK-20260612-003");
    assert.match(result.errors.join(";"), /filename TASK-20260612-003 vs fm TASK-20260612-002/);
  });

  it("FAIL: REPORT-002 missing fm, references=001", () => {
    const result = evaluateReportAttribution("REPORT-20260612-002-DEV-to-PM.md", {
      references: ["TASK-20260612-001"],
    });
    assert.equal(result.pass, false);
    assert.equal(result.filenameTaskId, "TASK-20260612-002");
    assert.ok(result.errors.includes("frontmatter_task_id_missing"));
    assert.match(result.errors.join(";"), /references TASK-20260612-001/);
  });

  it("PASS: REPORT-002 all fields = TASK-20260612-002", () => {
    const result = evaluateReportAttribution("REPORT-20260612-002-DEV-to-PM.md", {
      task_id: DEV,
      references: [DEV],
    });
    assert.equal(result.pass, true);
    assert.equal(result.filenameTaskId, DEV);
    assert.equal(result.fmTaskId, DEV);
    assert.equal(result.refTaskId, DEV);
    assert.ok(isValidDevReceiptForTask("REPORT-20260612-002-DEV-to-PM.md", {
      task_id: DEV,
      references: [DEV],
    }, DEV));
  });

  it("inferReportFilenameTaskId uses REPORT date-seq", () => {
    assert.equal(
      inferReportFilenameTaskId("REPORT-20260612-005-DEV-to-PM.md"),
      "TASK-20260612-005",
    );
  });
});

describe("105 case 1 — QA FAIL 禁止 auto final summary", () => {
  it("blocks gate when QA report status=fail", () => {
    const thread = mkThread();
    const tasks = panel104BaseTasks();
    const reports = [
      mkReport({ references: [DEV], parent_task_id: DEV }),
      mkReport({
        report_id: "REPORT-20260612-004-OPS-to-PM",
        filename: "REPORT-20260612-004-OPS-to-PM.md",
        sender: "OPS",
        task_id: OPS,
        parent_task_id: OPS,
        references: [OPS],
      }),
      mkReport({
        report_id: "REPORT-20260612-005-QA-to-PM",
        filename: "REPORT-20260612-005-QA-to-PM.md",
        sender: "QA",
        recipient: "PM",
        task_id: QA,
        status: "fail",
        parent_task_id: QA,
        references: [QA],
      }),
    ];
    const gate = evaluatePmSummaryGate({ thread, tasks, reports });
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.skipped_reason, "qa_not_passed");
    assert.equal(tasks[0]!.bucket, "active");
  });
});

describe("105 case 2 — QA missing 禁止 submit_review / auto summary", () => {
  it("blocks gate with qa_missing when QA has no report", () => {
    const thread = mkThread();
    const tasks = panel104BaseTasks();
    tasks[2] = { ...tasks[2]!, bucket: "active" };
    const reports = [
      mkReport({ references: [DEV], parent_task_id: DEV }),
      mkReport({
        report_id: "REPORT-20260612-004-OPS-to-PM",
        filename: "REPORT-20260612-004-OPS-to-PM.md",
        sender: "OPS",
        task_id: OPS,
        parent_task_id: OPS,
        references: [OPS],
      }),
    ];
    const gate = evaluatePmSummaryGate({ thread, tasks, reports });
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.skipped_reason, "qa_missing");
  });
});

describe("105 case 4 — diagnostics=0 ≠ attribution PASS", () => {
  it("diagnostics empty but attribution FAIL → 104 acceptance FAIL", () => {
    const result = evaluatePanel104Acceptance({
      diagnostics: [],
      devReports: [
        {
          filename: "REPORT-20260612-002-DEV-to-PM.md",
          fm: { references: ["TASK-20260612-001"] },
        },
      ],
      expectedDevTaskId: DEV,
    });
    assert.equal(result.diagnosticsCount, 0);
    assert.ok(result.attributionErrors.length > 0);
    assert.equal(result.pass, false);
  });

  it("diagnostics empty and attribution PASS → acceptance PASS", () => {
    const result = evaluatePanel104Acceptance({
      diagnostics: [],
      devReports: [
        {
          filename: "REPORT-20260612-002-DEV-to-PM.md",
          fm: { task_id: DEV, references: [DEV] },
        },
      ],
      expectedDevTaskId: DEV,
    });
    assert.equal(result.diagnosticsCount, 0);
    assert.equal(result.attributionErrors.length, 0);
    assert.equal(result.pass, true);
  });
});

describe("105 — dev_report_attribution_fail in summary gate", () => {
  it("blocks when DEV report references mismatch filename seq", () => {
    const thread = mkThread();
    const tasks = panel104BaseTasks();
    const reports = [
      mkReport({
        report_id: "REPORT-20260612-003-DEV-to-PM",
        filename: "REPORT-20260612-003-DEV-to-PM.md",
        task_id: DEV,
        references: [DEV],
        parent_task_id: DEV,
      }),
      mkReport({
        report_id: "REPORT-20260612-005-QA-to-PM",
        filename: "REPORT-20260612-005-QA-to-PM.md",
        sender: "QA",
        task_id: QA,
        status: "done",
        parent_task_id: QA,
        references: [QA],
      }),
      mkReport({
        report_id: "REPORT-20260612-004-OPS-to-PM",
        filename: "REPORT-20260612-004-OPS-to-PM.md",
        sender: "OPS",
        task_id: OPS,
        parent_task_id: OPS,
        references: [OPS],
      }),
    ];
    const gate = evaluatePmSummaryGate({ thread, tasks, reports });
    assert.equal(gate.ok, false);
    if (!gate.ok) {
      assert.equal(gate.skipped_reason, "dev_report_attribution_fail");
    }
  });
});
