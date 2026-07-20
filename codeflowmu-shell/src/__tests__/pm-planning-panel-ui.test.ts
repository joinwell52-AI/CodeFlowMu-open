import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const html = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "codeflowmu-desktop", "panel", "index.html"),
  "utf8",
);

test("Panel task detail explains PM planning level, gaps, and dispatch state", () => {
  assert.match(html, /id="tdp-planning-gate"/);
  assert.match(html, /function renderTaskPlanningGate\(data\)/);
  assert.match(html, /classification_reason/);
  assert.match(html, /missing_sections/);
  assert.match(html, /missing_skills/);
  assert.match(html, /invalid_skill_evidence/);
  assert.match(html, /下游派单/);
  assert.match(html, /PM 下一步/);
  assert.match(html, /ADMIN 调整规划等级/);
  assert.match(html, /function adjustPmPlanningLevel\(/);
});

test("root task rows expose an in-app PM planning brief card", () => {
  assert.match(html, /class="pm-planning-card"/);
  assert.match(html, /data-planning-task=/);
  assert.match(html, /function hydratePmPlanningCards\(/);
  assert.match(html, /function openPmPlanningBrief\(/);
  assert.match(html, /function pmPlanningArtifactReadPath\(/);
  assert.match(html, /markerAt\+1/);
  assert.match(html, /planning_artifact_path/);
  assert.match(html, /openChatFilePreview\(path\)/);
  assert.match(html, /📋 查看 PM 规划方案/);
  const adminSectionAt = html.indexOf("function _renderAdminSection(){");
  const adminSectionEnd = html.indexOf("const TDP_WIDTH_STORAGE_KEY", adminSectionAt);
  const adminSection = html.slice(adminSectionAt, adminSectionEnd);
  const teamSectionAt = html.indexOf("function _renderTeamSection(){");
  const teamSectionEnd = html.indexOf("function _renderSmokeSection(){", teamSectionAt);
  const teamSection = html.slice(teamSectionAt, teamSectionEnd);
  const summaryStackAt = adminSection.indexOf(
    '<td><div class="tp-summary-stack"><button type="button" class="pm-planning-card"',
  );
  const summaryTextAt = adminSection.indexOf(
    "${tpListTextCell(summary,88,'tp-cell-sum')}",
    summaryStackAt,
  );
  const summaryStackEnd = adminSection.indexOf("</div></td>", summaryStackAt);
  assert.ok(summaryStackAt >= 0);
  assert.ok(summaryTextAt > summaryStackAt && summaryTextAt < summaryStackEnd);
  assert.doesNotMatch(teamSection, /class="pm-planning-card"/);
  assert.match(html, /\.tp-summary-stack\{display:flex;min-width:0;align-items:center/);
  assert.doesNotMatch(
    html,
    /<td style="white-space:nowrap"><button type="button" class="pm-planning-card"/,
  );
  assert.match(
    adminSection,
    /openTaskDetail\(_taskReg\['\$\{sfn\}'\]\)[\s\S]*?\$\{adminListActionsHtml\(f\)\}/,
  );
  assert.match(html, /if\(_canAdminArchive\(f\)\)\{/);
  assert.match(html, /openChildTasksForMainlineArchive\(f\)\.length>0\)return false/);
  assert.match(html, /function taskIsObsoleteArchivedRework\(f\)/);
  assert.match(html, /if\(taskIsObsoleteArchivedRework\(f\)\)return false/);
  assert.match(
    html,
    /function _canAdminArchive\(f\)\{return _canOperatorArchive\(f\);\}/,
  );
});
