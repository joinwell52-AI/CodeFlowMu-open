import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../../..");
const panel = readFileSync(
  resolve(root, "codeflowmu-desktop/panel/index.html"),
  "utf8",
);
const mobileHtml = readFileSync(
  resolve(root, "codeflowmu-desktop/mobile/index.html"),
  "utf8",
);
const mobileJs = readFileSync(
  resolve(root, "codeflowmu-desktop/mobile/mobile.js"),
  "utf8",
);
const mobileI18n = readFileSync(
  resolve(root, "codeflowmu-desktop/mobile/i18n.js"),
  "utf8",
);

test("desktop task toolbar omits the redundant member status block", () => {
  assert.doesNotMatch(panel, /id="tp-agent-status-bar"/);
  assert.doesNotMatch(panel, /function updateAgentStatusBar\(/);
  assert.match(panel, /id="tp-operator-wrap"/);
  assert.match(panel, /id="task-view-switch"/);
});

test("desktop task page has a persistent submission review surface", () => {
  for (const marker of [
    'id="task-primary-submissions"',
    'id="task-submission-board"',
    "renderTaskSubmissionBoard",
    "showTaskSubmissionRevisionComposer",
    "parseTaskSubmissionRevisionMarkdown",
    "recheckTaskSubmissionFromPanel",
    "abandonTaskSubmissionFromPanel",
    "/api/v2/task-submissions?limit=200",
    "任务书需要风险预授权",
    "任务书需要修订",
    "任务书被拒绝",
    "未生成正式 TASK",
    "期望：",
    "实际：",
    "修复建议：",
    "继续编辑（重新上传任务书）",
    "重新上传修改后的任务书",
    "重新检查当前草稿",
  ]) {
    assert.match(panel, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("desktop revision opens the task composer and requires a replacement upload", () => {
  assert.match(
    panel,
    /\['draft','checking','needs_revision','needs_approval','rejected','failed','formalization_failed'\]\.includes\(selected\.status\)/,
  );
  assert.match(
    panel,
    /\['draft','checking','failed','formalization_failed'\]\.includes\(selected\.status\)/,
  );
  assert.match(panel, /showTaskSubmissionRevisionComposer\(submissionId\)/);
  assert.match(panel, /if\(revisingSubmissionId&&!_ddRevisionUploadName\)/);
  assert.match(
    panel,
    /source_filename:_ddRevisionUploadName,check:true/,
  );
  assert.doesNotMatch(panel, /继续编辑（保存草稿）/);
  assert.ok(
    panel.includes(
      "'/api/v2/task-submissions/'+encodeURIComponent(submissionId)+'/check'",
    ),
  );
});

test("desktop task submission keeps rejection out of the success path", () => {
  assert.match(
    panel,
    /if\(d\.decision==='rejected'\|\|d\.code==='TASK_SPEC_INVALID'\)/,
  );
  assert.match(panel, /正在审查任务书…/);
  assert.match(panel, /showRejectedTaskSubmission\(d,msg\)/);
  assert.match(panel, /showRejectedTaskSubmission\(d,smsg\)/);
});

test("mobile PWA exposes the same persistent submission review semantics", () => {
  for (const marker of [
    'id="tasksPrimarySubmissionsBtn"',
    'id="taskSubmissionsPanel"',
    "loadTaskSubmissions",
    "renderTaskSubmissions",
    "reviseMobileTaskSubmission",
    "abandonMobileTaskSubmission",
    "/api/v2/mobile/task-submissions?limit=200",
    "submissionRejectedToast",
    "submissionExpected",
    "submissionActual",
    "submissionSuggestedFix",
  ]) {
    const source = marker.startsWith('id="') ? mobileHtml : mobileJs;
    assert.match(
      source,
      new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
  assert.match(mobileI18n, /任务书未通过审查，未生成正式 TASK/);
});

test("mobile rejection payload is preserved by the API helper", () => {
  assert.match(mobileJs, /err\.payload = JSON\.parse\(errText\)/);
  assert.match(
    mobileJs,
    /e\.payload && e\.payload\.decision === "needs_revision"/,
  );
  assert.match(mobileJs, /BUNDLE_VERSION = "V\d+\.\d+\.\d+"/);
});
