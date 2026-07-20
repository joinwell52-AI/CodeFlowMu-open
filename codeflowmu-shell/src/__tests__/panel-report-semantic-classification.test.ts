import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const panelHtml = readFileSync(
  resolve(import.meta.dirname, "../../../codeflowmu-desktop/panel/index.html"),
  "utf8",
);

function sourceOf(name: string): string {
  const start = panelHtml.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing panel helper ${name}`);
  const brace = panelHtml.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < panelHtml.length; i += 1) {
    if (panelHtml[i] === "{") depth += 1;
    if (panelHtml[i] === "}") depth -= 1;
    if (depth === 0) return panelHtml.slice(start, i + 1);
  }
  throw new Error(`unterminated panel helper ${name}`);
}

const names = [
  "reportExplicitType",
  "isAckReportType",
  "reportRouteOf",
  "reportKindText",
  "reportTextLooksProcessOnly",
  "reportStatusIsDone",
  "reportStatusIsRecord",
  "isReportRecord",
  "reportHasFinalIntent",
  "isMainTaskReport",
  "isSubTaskReport",
  "reportSemanticClass",
  "reportStatsBreakdown",
];

const helpers = new Function(`
  const classifyReportDisplay=()=>"valid";
  const taskRouteFromFn=(filename)=>{
    const m=String(filename||"").match(/(?:TASK|REPORT)-\\d{8}-\\d{3,}-([A-Za-z0-9]+)-to-([A-Za-z0-9]+)/i);
    return m?{sender:m[1].toUpperCase(),recipient:m[2].toUpperCase()}:null;
  };
  ${names.map(sourceOf).join("\n")}
  return {reportSemanticClass,reportStatsBreakdown};
`)() as {
  reportSemanticClass: (report: Record<string, unknown>) => string;
  reportStatsBreakdown: (reports: Record<string, unknown>[]) => Record<string, number>;
};

const finalReport = (body: string) => ({
  filename: "REPORT-20260712-019-PM-to-ADMIN.md",
  sender: "PM",
  recipient: "ADMIN",
  status: "done",
  report_kind: "pm_to_admin_final",
  body,
});

test("structured final stays MAIN_REPORT when body contains closeout/process words", () => {
  assert.equal(helpers.reportSemanticClass(finalReport("PM 汇总关单报告")), "MAIN_REPORT");
  assert.equal(helpers.reportSemanticClass(finalReport("等待 ADMIN 验收并请求关单")), "MAIN_REPORT");
});

test("structured in-progress stays RECORD even when body promises a final plan", () => {
  assert.equal(helpers.reportSemanticClass({
    filename: "REPORT-20260712-016-PM-to-ADMIN.md",
    sender: "PM",
    recipient: "ADMIN",
    status: "in_progress",
    report_kind: "pm_to_admin_in_progress",
    body: "最终计划将在 QA 回执后提交",
  }), "RECORD");
});

test("done worker report stays SUB_REPORT when body contains patrol words", () => {
  assert.equal(helpers.reportSemanticClass({
    filename: "REPORT-20260712-018-QA-to-PM.md",
    sender: "QA",
    recipient: "PM",
    status: "done",
    report_kind: "worker_to_pm",
    body: "巡检完成，等待 PM 汇总",
  }), "SUB_REPORT");
});

test("legacy reports without report_kind use body only as fallback", () => {
  assert.equal(helpers.reportSemanticClass({
    filename: "REPORT-20260712-003-PM-to-ADMIN.md",
    sender: "PM",
    recipient: "ADMIN",
    status: "done",
    body: "最终汇总报告，全部交付完成",
  }), "MAIN_REPORT");
  assert.equal(helpers.reportSemanticClass({
    filename: "REPORT-20260712-008-PM-to-ADMIN.md",
    sender: "PM",
    recipient: "ADMIN",
    status: "done",
    body: "巡检记录：等待下游回执",
  }), "RECORD");
});

test("Famous sayings fixture breakdown is 4 main, 5 sub, 10 records", () => {
  const reports = [
    ...Array.from({ length: 4 }, (_, i) => ({ ...finalReport("汇总关单，等待 ADMIN 验收"), filename: `REPORT-20260712-00${i + 1}-PM-to-ADMIN.md` })),
    ...Array.from({ length: 5 }, (_, i) => ({ filename: `REPORT-20260712-01${i}-DEV-to-PM.md`, sender: i === 4 ? "QA" : "DEV", recipient: "PM", status: "done", report_kind: "worker_to_pm", body: "巡检完成" })),
    ...Array.from({ length: 10 }, (_, i) => ({ filename: `REPORT-20260712-02${i}-PM-to-ADMIN.md`, sender: "PM", recipient: "ADMIN", status: i === 9 ? "blocked" : "in_progress", report_kind: i === 0 ? "pm_to_admin_ack" : "pm_to_admin_in_progress", body: "最终计划与巡检进度" })),
  ];
  assert.deepEqual(helpers.reportStatsBreakdown(reports), { total: 19, mainReport: 4, subReport: 5, record: 10 });
});
