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

test("desktop task page has a persistent submission review surface", () => {
  for (const marker of [
    'id="task-primary-submissions"',
    'id="task-submission-board"',
    "renderTaskSubmissionBoard",
    "reviseTaskSubmissionFromPanel",
    "abandonTaskSubmissionFromPanel",
    "/api/v2/task-submissions?limit=200",
    "任务书需要风险预授权",
    "任务书需要修订",
    "任务书被拒绝",
    "未生成正式 TASK",
    "期望：",
    "实际：",
    "修复建议：",
  ]) {
    assert.match(panel, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
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
    /e\.payload && e\.payload\.decision === "rejected"/,
  );
  assert.match(mobileJs, /BUNDLE_VERSION = "V1\.0\.56"/);
});
