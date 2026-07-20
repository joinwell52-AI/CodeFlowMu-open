import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isAutoPmFinalSummaryReport,
  selectCanonicalPmFinalReport,
} from "../selectCanonicalPmFinalReport.ts";
import type { LedgerReportRecord } from "../types.ts";

const ROOT = "TASK-20260610-220";
const THREAD = "panel-task-220";

function pmReport(
  overrides: Partial<LedgerReportRecord> & { report_id: string; filename: string },
): LedgerReportRecord {
  return {
    sender: "PM",
    recipient: "ADMIN",
    status: "done",
    path: `/tmp/${overrides.filename}`,
    created_at: "2026-06-10T12:00:00+08:00",
    updated_at: "2026-06-10T12:00:00+08:00",
    timezone: "Asia/Shanghai",
    created_at_utc: "2026-06-10T04:00:00Z",
    thread_key: THREAD,
    task_id: ROOT,
    references: [ROOT],
    ...overrides,
  };
}

describe("selectCanonicalPmFinalReport", () => {
  it("TASK-220: manual 111 beats auto 004; 109 ack excluded", () => {
    const ack = pmReport({
      report_id: "REPORT-20260610-109-PM-to-ADMIN",
      filename: "REPORT-20260610-109-PM-to-ADMIN.md",
      status: "in_progress",
      report_kind: "pm_to_admin_in_progress",
    });
    const auto = pmReport({
      report_id: "REPORT-20260610-004-PM-to-ADMIN",
      filename: "REPORT-20260610-004-PM-to-ADMIN.md",
      report_type: "final_summary",
      final: true,
      auto_final_summary: true,
    });
    const manual = pmReport({
      report_id: "REPORT-20260610-111-PM-to-ADMIN",
      filename: "REPORT-20260610-111-PM-to-ADMIN.md",
      references: [ROOT],
      task_id: undefined,
    });

    const bodies = new Map<string, string>([
      [
        auto.path,
        "---\nreport_type: final_summary\n---\n无自动 blocked 噪声（Runtime 总线自动汇总）\n",
      ],
      [manual.path, "---\nstatus: done\n---\n## 执行结果\nPM 手写最终报告\n"],
      [ack.path, "---\nstatus: in_progress\n---\n## 执行状态\nin_progress 派单中\n"],
    ]);

    const { canonical, superseded, autoFallback } = selectCanonicalPmFinalReport(
      [ack, auto, manual],
      { rootTaskId: ROOT, threadKey: THREAD },
      bodies,
    );

    assert.equal(canonical?.report_id, "REPORT-20260610-111-PM-to-ADMIN");
    assert.ok(superseded.some((r) => r.report_id === "REPORT-20260610-004-PM-to-ADMIN"));
    assert.ok(autoFallback.some((r) => r.report_id === "REPORT-20260610-004-PM-to-ADMIN"));
    assert.ok(!superseded.some((r) => r.report_id === "REPORT-20260610-109-PM-to-ADMIN"));
  });

  it("isAutoPmFinalSummaryReport detects Runtime auto summary markers", () => {
    const auto = pmReport({
      report_id: "REPORT-20260610-004-PM-to-ADMIN",
      filename: "REPORT-20260610-004-PM-to-ADMIN.md",
      report_type: "final_summary",
    });
    assert.equal(
      isAutoPmFinalSummaryReport(
        auto,
        "验收结果\n- 下游 REPORT 已落盘（Runtime 总线自动汇总）\n",
      ),
      true,
    );

    const manual = pmReport({
      report_id: "REPORT-20260610-111-PM-to-ADMIN",
      filename: "REPORT-20260610-111-PM-to-ADMIN.md",
    });
    assert.equal(
      isAutoPmFinalSummaryReport(manual, "## 执行结果\nPM 手写最终报告\n"),
      false,
    );
  });

  it("latest manual wins when multiple manual candidates exist", () => {
    const older = pmReport({
      report_id: "REPORT-20260610-010-PM-to-ADMIN",
      filename: "REPORT-20260610-010-PM-to-ADMIN.md",
    });
    const newer = pmReport({
      report_id: "REPORT-20260610-020-PM-to-ADMIN",
      filename: "REPORT-20260610-020-PM-to-ADMIN.md",
    });
    const { canonical } = selectCanonicalPmFinalReport([older, newer], {
      rootTaskId: ROOT,
      threadKey: THREAD,
    });
    assert.equal(canonical?.report_id, "REPORT-20260610-020-PM-to-ADMIN");
  });
});
