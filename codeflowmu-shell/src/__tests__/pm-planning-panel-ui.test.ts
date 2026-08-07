import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const html = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "codeflowmu-desktop", "panel", "index.html"),
  "utf8",
);
const webPanel = readFileSync(
  join(import.meta.dirname, "..", "web-panel.ts"),
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

test("Planning approval and stage approval use distinct bounded server contracts", () => {
  assert.match(webPanel, /approvedWpScope: \["WP-00"\]/);
  assert.match(webPanel, /\/api\/v2\/pm\/governance\/planning-stage\/decide/);
  assert.match(webPanel, /PLANNING_STAGE_SCOPE_NOT_ELIGIBLE/);
  assert.match(webPanel, /requestedScope\.includes\("\*"\)/);
  assert.match(webPanel, /prerequisiteEvidence: stage\.prerequisite_evidence/);
  assert.match(webPanel, /本次批准范围：\$\{scopeText\}/);
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

test("Planning Gate has a dedicated reachable review dialog with a fixed decision footer", () => {
  assert.match(html, /id="tdp-planning-review-btn"/);
  assert.match(html, />规划审核</);
  assert.match(html, /id="planning-review-overlay"/);
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.match(html, /\.planning-review-body\{[^}]*overflow-y:auto/);
  assert.match(html, /\.planning-review-footer\{[^}]*flex-shrink:0/);
  assert.match(html, /\.planning-review-overlay\{[^}]*bottom:calc\(var\(--think-console-h,28px\) \+ var\(--queue-bar-h,0px\)\)/);
  assert.match(html, /\.planning-review-dialog\{[^}]*height:min\(760px,calc\(100% - 16px\)\)/);
  assert.match(html, /scrollBody\.insertBefore\(el,scrollBody\.firstChild\)/);
  for (const label of ["仅批准 WP-00", "要求修改规划", "暂停", "重新规划", "终止"]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /function planningReviewKeydown\(event\)/);
  assert.match(html, /event\.key!==?'Tab'/);
  assert.match(html, /规划内容已更新，旧审核窗口不能提交决定/);
  assert.match(html, /planning-gate\/history\?task_id=/);
  assert.match(html, /canonical_preview/);
  assert.match(html, /业务 Planning Gate（不属于操作审批）/);
  assert.match(html, /待规划审批/);
  assert.match(html, /待阶段审批/);
  for (const label of ["批准下一阶段", "批准所选 WP", "要求补充证据", "暂停后续阶段", "撤销未执行授权", "终止任务"]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /class="planning-wp-check planning-wp-select"/);
  assert.match(html, /wp\.recommended/);
  assert.match(html, /本次批准：/);
  assert.match(html, /尚未批准：/);
  assert.match(html, /planning-stage\/decide/);
  assert.match(html, /function ensurePlanningDecisionReachable/);
});
