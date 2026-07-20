import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

test("PM wake directly starts the AI and does not run task gates first", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "web-panel.ts"), "utf8");
  const start = source.indexOf("if (useDirectAiWake())");
  const end = source.indexOf("/* Legacy dispatch-aware wake path", start);
  assert.ok(start >= 0 && end > start, "direct wake block missing");
  const direct = source.slice(start, end);
  assert.match(direct, /sessionManager\.startSession/);
  assert.doesNotMatch(direct, /evaluateSequentialDispatchGuard/);
  assert.doesNotMatch(direct, /evaluateDependencyGate/);
  assert.doesNotMatch(direct, /taskDispatcher\.dispatch/);
  assert.doesNotMatch(direct, /report_missing/);
});

test("governance planner executes the AI wake before report and cooldown policy", () => {
  const source = readFileSync(
    resolve(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "packages",
      "codeflowmu-runtime",
      "src",
      "pm",
      "PmGovernancePlanner.ts",
    ),
    "utf8",
  );
  const action = source.indexOf('case "pm.wake_downstream"');
  const direct = source.indexOf("if (useDirectAiWake())", action);
  const reportPolicy = source.indexOf("const hasReport =", action);
  assert.ok(action >= 0 && direct > action, "direct governance wake missing");
  assert.ok(reportPolicy < 0 || direct < reportPolicy, "report policy ran before AI wake");
  const block = source.slice(direct, reportPolicy > direct ? reportPolicy : direct + 2200);
  assert.match(block, /await executor\(wakeReq\)/);
  assert.doesNotMatch(block, /evaluateWakeAllowance/);
  assert.doesNotMatch(block, /reviewCheck/);
});

test("ADMIN task list renders ADMIN-to-PM follow-ups under their root", () => {
  const html = readFileSync(
    resolve(import.meta.dirname, "..", "..", "..", "codeflowmu-desktop", "panel", "index.html"),
    "utf8",
  );
  const start = html.indexOf("function _renderAdminSection(");
  assert.ok(start >= 0, "_renderAdminSection missing");
  const body = html.slice(start, start + 2600);
  assert.match(body, /filter\(f=>isAdminMainlineTask\(f\.filename\|\|''\)\)/);
  assert.match(body, /buildTaskTree\(adminLineTasks,''\)/);
  assert.match(body, /flattenTaskTree\(adminTree\)/);
  assert.match(body, /const adminMainCount=adminRoots\.length/);
});

test("task relation UI explains continue versus child semantics", () => {
  const html = readFileSync(
    resolve(import.meta.dirname, "..", "..", "..", "codeflowmu-desktop", "panel", "index.html"),
    "utf8",
  );
  const modal = html.slice(html.indexOf('id="dd-modal-bg"'), html.indexOf('id="dd-modal-bg"') + 5000);
  assert.match(modal, /id="dd-task-relation"/);
  assert.match(modal, /id="dd-relation-help"/);
  const syncStart = html.indexOf("function syncDirectDispatchRelation()");
  const sync = html.slice(syncStart, syncStart + 2200);
  assert.match(sync, /添加子任务：在所选当前任务下增加新的工作/);
  assert.match(sync, /接着做：建立新的主任务/);
});

test("PM current child cannot wake or close an older sibling branch", () => {
  const shell = readFileSync(resolve(import.meta.dirname, "..", "web-panel.ts"), "utf8");
  assert.match(shell, /DOWNSTREAM_TASK_OUTSIDE_CURRENT_BRANCH/);
  assert.match(shell, /CURRENT_PM_TASK_NOT_SETTLED/);
  assert.match(shell, /请先创建 parent=\$\{currentTaskId\} 的新下游任务/);
});

test("formal blocked report exposes a real settle action instead of clear-failure", () => {
  const html = readFileSync(
    resolve(import.meta.dirname, "..", "..", "..", "codeflowmu-desktop", "panel", "index.html"),
    "utf8",
  );
  assert.match(html, /id="tdp-receipt-resolve-btn"/);
  assert.match(html, /resolve-blocked-report/);
  assert.match(html, /解除阻塞（确认收口）/);
});
