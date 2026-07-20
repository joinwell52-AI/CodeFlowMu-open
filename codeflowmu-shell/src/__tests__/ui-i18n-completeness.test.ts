import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

import { formatRuntimeActionSummary } from "../mobile/mobileRuntimeActionStream.ts";
import { buildAvailableTaskActions, buildFlowOverview } from "../mobile/mobileTaskDetail.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const PANEL_HTML = join(ROOT, "codeflowmu-desktop", "panel", "index.html");
const MOBILE_DIR = join(ROOT, "codeflowmu-desktop", "mobile");
const CJK = /[\u3400-\u9fff]/;

function readObjectLiteral(file: string, pattern: RegExp): Record<string, Record<string, string>> {
  const source = readFileSync(file, "utf8");
  const match = source.match(pattern);
  assert.ok(match?.[1], `dictionary object not found in ${file}`);
  return vm.runInNewContext(`(${match[1]})`) as Record<string, Record<string, string>>;
}

test("PC and PWA dictionaries keep complete English coverage", () => {
  const panel = readObjectLiteral(PANEL_HTML, /const LANGS=({[\s\S]*?});\s*let lang=/);
  const mobile = readObjectLiteral(join(MOBILE_DIR, "i18n.js"), /const dict = ({[\s\S]*?});\s*const STORAGE_KEY/);

  for (const [name, dict] of [["PC", panel], ["PWA", mobile]] as const) {
    const en = dict.en ?? {};
    const zh = dict.zh ?? {};
    assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), `${name} keys differ`);
    const leaking = Object.entries(en).filter(([, value]) => CJK.test(String(value)));
    assert.deepEqual(leaking, [], `${name} English dictionary contains Chinese text`);
  }

  assert.equal(panel.en?.["task.sec.smokeSub"], "Test artifact · excluded from primary KPIs");
  assert.equal(mobile.en?.appTitle, "CodeFlowMu");
  assert.equal(mobile.en?.langZh, "Chinese");

  const panelSource = readFileSync(PANEL_HTML, "utf8");
  const mobileSource = readFileSync(join(MOBILE_DIR, "index.html"), "utf8");
  const panelUsed = [...panelSource.matchAll(/data-i18n(?:-html|-ph|-title|-opt)?="([^"]+)"/g)].map((row) => row[1]!);
  const mobileUsed = [...mobileSource.matchAll(/data-i18n(?:-placeholder|-title|-aria-label|-alt)?="([^"]+)"/g)].map((row) => row[1]!);
  assert.deepEqual([...new Set(panelUsed)].filter((key) => !(key in (panel.en ?? {}))), []);
  assert.deepEqual([...new Set(mobileUsed)].filter((key) => !(key in (mobile.en ?? {}))), []);
});

test("PC residual UI localizer is wired into dynamic rendering", () => {
  const source = readFileSync(PANEL_HTML, "utf8");
  assert.match(source, /function translatePanelUiText\(/);
  assert.match(source, /new MutationObserver\(/);
  assert.match(source, /queueResidualPanelUi\(document\.body\)/);
  assert.match(source, /lang==='zh'\?'EN':'ZH'/);
  assert.doesNotMatch(source, /'settings\.langSwitch':'Switch to [^']*[\u3400-\u9fff]/);

  assert.match(source, /PANEL_UI_EN_OVERRIDES=new Map/);
  assert.match(source, /PANEL_UI_SOURCE_ATTRS=new WeakMap/);
});

test("clean init restores the selected language and refreshes the panel", () => {
  const source = readFileSync(PANEL_HTML, "utf8");
  const restartBranch = source.match(
    /if \(d\.autoRestartScheduled\) \{[\s\S]*?\n\s*\} else \{/,
  )?.[0] ?? "";

  assert.match(restartBranch, /const shellBack = await pollShellHealthAfterRestart\(90000\)/);
  assert.match(restartBranch, /if \(shellBack\) \{[\s\S]*?await syncPanelUiLang\(\)/);
  assert.match(
    restartBranch,
    /await syncPanelUiLang\(\);[\s\S]*?window\.location\.reload\(\);[\s\S]*?return;/,
  );
});

test("PWA language controls and API requests follow the selected locale", () => {
  const html = readFileSync(join(MOBILE_DIR, "index.html"), "utf8");
  const js = readFileSync(join(MOBILE_DIR, "mobile.js"), "utf8");
  assert.match(html, /id="langZhBtn"[^>]+data-i18n="langZh"/);
  assert.match(html, /id="langEnBtn"[^>]+data-i18n="langEn"/);
  assert.match(js, /"Accept-Language": uiLang === "en" \? "en" : "zh-CN"/);
  assert.match(js, /"X-CodeFlowMu-UI-Lang": uiLang/);
  assert.doesNotMatch(js, /showToast\("[^"]*[\u3400-\u9fff]/);
  assert.doesNotMatch(js, /window\.prompt\("[^"]*[\u3400-\u9fff]/);
});

test("PWA server-generated governance actions are English when requested", () => {
  const actions = buildAvailableTaskActions(
    { bucket: "active", status: "running" },
    { panelPort: 18766, lang: "en" },
  );
  assert.deepEqual(actions.map((row) => row.label), ["Nudge", "Resolve stuck state", "Back"]);
  assert.ok(actions.every((row) => !CJK.test(row.label + (row.disabled_reason ?? ""))));

  const flow = buildFlowOverview(
    { filename: "TASK-1.md", title: "Example", sender: "ADMIN", recipient: "PM" },
    [],
    null,
    "en",
  );
  assert.equal(flow[0]?.title, "Start");
  assert.ok(flow.every((row) => !CJK.test(row.title)));
});

test("PWA runtime action summaries localize system UI wording", () => {
  const rows = [
    { action: "approve", result: "ok", target_task: "TASK-1", at: "2026-01-01T00:00:00Z", operator: "ADMIN" },
    { action: "agent_read", result: "ok", object_short: "README.md", intent: "读取代码上下文", result_summary: "已读取", at: "2026-01-01T00:00:00Z", operator: "DEV" },
    { action: "wake", result: "delayed", target_agent: "QA", at: "2026-01-01T00:00:00Z", operator: "PM" },
  ];
  for (const row of rows) {
    const summary = formatRuntimeActionSummary(row as never, "en");
    assert.equal(CJK.test(summary), false, summary);
  }
});
