import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const panelHtml = readFileSync(
  join(here, "..", "..", "..", "codeflowmu-desktop", "panel", "index.html"),
  "utf8",
);

test("任务列表以 done/archive 终态覆盖残留队列状态", () => {
  const start = panelHtml.indexOf("function taskStatusBadge(f)");
  const end = panelHtml.indexOf("function toggleSection(name)", start);
  assert.ok(start >= 0 && end > start, "taskStatusBadge function missing");
  const body = panelHtml.slice(start, end);

  const terminal = body.indexOf("if (scope === 'done')");
  const queued = body.indexOf("if(dqStatus==='queued')");
  assert.ok(terminal >= 0, "done status branch missing");
  assert.ok(queued >= 0, "queued status branch missing");
  assert.ok(terminal < queued, "done must be evaluated before queued");
  assert.match(body, /rejected_superseded/);
  assert.match(body, /ts\.reworkSuperseded/);
});

test("中文界面映射旧版 Rework Request 标题", () => {
  assert.match(panelHtml, /'task\.reworkTitle':'QA 返工任务'/);
  assert.match(panelHtml, /\^Rework Request\$/);
  assert.match(panelHtml, /task\.reworkReason/);
});

test("等待 PM 汇总的 active 主任务仍向归档权限角色显示强制归档", () => {
  const gateStart = panelHtml.indexOf("function _canOperatorForceArchive(f)");
  const gateEnd = panelHtml.indexOf("function _canOperatorApprove(f)", gateStart);
  assert.ok(gateStart >= 0 && gateEnd > gateStart);
  const gate = panelHtml.slice(gateStart, gateEnd);
  assert.match(gate, /waiting_pm_consolidation/);
  assert.match(gate, /openPhysical/);

  const buttonsStart = panelHtml.indexOf("function updateTdpLifecycleButtons(f)");
  const buttonsEnd = panelHtml.indexOf("async function taskLifecyclePost", buttonsStart);
  const buttons = panelHtml.slice(buttonsStart, buttonsEnd);
  assert.match(
    buttons,
    /if\(effScope==='waiting_pm_consolidation'\)\{[\s\S]*?if\(_canOperatorForceArchive\(f\)\)show\(forceArchBtn\)/,
  );
});

test("PM formal terminal reports remain eligible for track auto submit", () => {
  const start = panelHtml.indexOf("function taskPendingPmSubmitReview(f)");
  const end = panelHtml.indexOf("async function autoSubmitPmPendingReviews()", start);
  assert.ok(start >= 0 && end > start, "PM auto-submit predicate missing");
  const body = panelHtml.slice(start, end);
  for (const status of ["done", "completed", "blocked", "failed", "aborted"]) {
    assert.match(body, new RegExp(`['\"]${status}['\"]`));
  }
});
