import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

test("PM wake routes canonical TASK work through TaskDispatcher and reserves direct session for pure chat", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "web-panel.ts"), "utf8");
  const action = source.indexOf("const executePmWakeDownstreamRaw");
  const direct = source.indexOf("if (!canonicalTaskPath)", action);
  const dispatch = source.indexOf("runtime.dispatcher.dispatchTaskFromControlPlane", direct);
  assert.ok(action >= 0 && direct > action && dispatch > direct);
  assert.match(source.slice(direct, dispatch), /sessionManager\.startSession/);
  assert.match(source.slice(dispatch, dispatch + 900), /pm_wake/);
  assert.doesNotMatch(source.slice(action, dispatch + 900), /useDirectAiWake/);
});

test("worker REPORT intake is explicitly separated from TASK dispatch", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "web-panel.ts"), "utf8");
  const action = source.indexOf("const executePmWakeDownstreamRaw");
  const reportBranch = source.indexOf('if (wakeKind === "report_intake")', action);
  const canonicalLookup = source.indexOf("let canonicalTaskPath", reportBranch);
  const dispatch = source.indexOf("runtime.dispatcher.dispatchTaskFromControlPlane", canonicalLookup);
  assert.ok(action >= 0 && reportBranch > action && canonicalLookup > reportBranch && dispatch > canonicalLookup);
  const intakeBody = source.slice(reportBranch, canonicalLookup);
  assert.match(intakeBody, /runtime\.reportDispatcher\.handle/);
  assert.match(intakeBody, /wake_kind: wakeKind/);
  assert.doesNotMatch(intakeBody, /dispatchTaskFromControlPlane|dispatch_skipped/);
  assert.match(source.slice(canonicalLookup, dispatch + 500), /actualTaskRecipient/);
  assert.doesNotMatch(source.slice(dispatch, dispatch + 220), /plan\.role,\s*\n\s*"pm_wake"/);
});

test("governance planner no longer hard-codes task-bound direct wake", () => {
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
  const direct = source.indexOf("const pureChatWake = !plan.task_id", action);
  const reportPolicy = source.indexOf("const hasReport =", action);
  assert.ok(action >= 0 && direct > action && reportPolicy > direct);
  assert.doesNotMatch(source.slice(action, reportPolicy), /useDirectAiWake/);
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

test("Panel and Mobile expose the shared attempt, lease and same-TASK recovery API", () => {
  const html = readFileSync(
    resolve(import.meta.dirname, "..", "..", "..", "codeflowmu-desktop", "panel", "index.html"),
    "utf8",
  );
  const mobile = readFileSync(
    resolve(import.meta.dirname, "..", "..", "..", "codeflowmu-desktop", "mobile", "mobile.js"),
    "utf8",
  );
  const routes = readFileSync(resolve(import.meta.dirname, "..", "mobile", "mobileRoutes.ts"), "utf8");
  assert.match(html, /id="tdp-dispatch-state"/);
  assert.match(html, /\/dispatch-state/);
  assert.match(html, /repair_retry/);
  assert.match(mobile, /active_lease/);
  assert.match(mobile, /attempt_id/);
  assert.match(routes, /\/redispatch/);
  assert.match(routes, /\/dispatch-state/);
});
