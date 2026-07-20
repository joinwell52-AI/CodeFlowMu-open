import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readActionEvidenceLines } from "../ActionEvidenceLogger.ts";
import {
  maybeRecordReportWriteAction,
  resetReportWriteActionDedupeForTests,
} from "../ActionEvidenceFromReport.ts";

describe("ActionEvidenceFromReport", () => {
  beforeEach(() => resetReportWriteActionDedupeForTests());
  afterEach(() => resetReportWriteActionDedupeForTests());

  it("REPORT file on disk → report.write", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-act-rpt-"));
    try {
      const content = `---
protocol: fcop
version: 1
kind: report
task_id: TASK-20260607-002
sender: DEV
session_id: sess-rpt
---

# Report
`;
      maybeRecordReportWriteAction({
        projectRoot: root,
        filepath: join(root, "_lifecycle", "review", "REPORT-20260607-002-DEV-to-PM.md"),
        filename: "REPORT-20260607-002-DEV-to-PM.md",
        senderRole: "DEV",
        content,
      });
      const records = readActionEvidenceLines(root);
      assert.equal(records.length, 1);
      assert.equal(records[0]!.event_type, "report.write");
      const rw = records[0] as { report_id?: string; task_id?: string; session_id?: string };
      assert.equal(rw.report_id, "REPORT-20260607-002-DEV-to-PM");
      assert.equal(rw.task_id, "TASK-20260607-002");
      assert.equal(rw.session_id, "sess-rpt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deduplicates same REPORT filepath", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-act-rpt-"));
    try {
      const content = `---
protocol: fcop
version: 1
task_id: TASK-20260607-003
sender: OPS
---

# Report
`;
      const filepath = join(root, "_lifecycle", "review", "REPORT-20260607-003-OPS-to-PM.md");
      const input = {
        projectRoot: root,
        filepath,
        filename: "REPORT-20260607-003-OPS-to-PM.md",
        senderRole: "OPS",
        content,
      };
      maybeRecordReportWriteAction(input);
      maybeRecordReportWriteAction(input);
      assert.equal(readActionEvidenceLines(root).length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
