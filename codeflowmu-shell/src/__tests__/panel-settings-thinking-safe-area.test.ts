import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const panelHtml = readFileSync(
  join(here, "..", "..", "..", "codeflowmu-desktop", "panel", "index.html"),
  "utf8",
);

test("所有设置滚动 Tab 为实时思考流和队列栏预留动态底部空间", () => {
  const safeAreaRule = panelHtml.match(
    /#page-settings>\.page-list-wrap\s*\{([\s\S]*?)\}/,
  );

  assert.ok(safeAreaRule, "应为设置页全部直接子滚动区定义统一安全区");
  assert.match(safeAreaRule[1]!, /padding-bottom:[^;]*var\(--think-console-h,28px\)/);
  assert.match(safeAreaRule[1]!, /padding-bottom:[^;]*var\(--queue-bar-h,0px\)/);
  assert.match(safeAreaRule[1]!, /scroll-padding-bottom:[^;]*var\(--think-console-h,28px\)/);
  assert.doesNotMatch(safeAreaRule[0], /#st-projects/);

  const templatesRule = panelHtml.match(
    /#page-settings>#st-templates\s*\{([\s\S]*?)\}/,
  );
  assert.ok(templatesRule, "任务模板分栏也应避开固定思考流");
  assert.match(templatesRule[1]!, /padding-bottom:[^;]*var\(--think-console-h,28px\)/);
  assert.match(templatesRule[1]!, /padding-bottom:[^;]*var\(--queue-bar-h,0px\)/);

  assert.match(panelHtml, /function syncSettingsThinkingInset\(\)/);
  assert.match(panelHtml, /\['st-windowsuse','st-browseruse'\]\.forEach/);
  assert.match(
    panelHtml,
    /style\.setProperty\('padding-bottom',safeBottom\+'px','important'\)/,
  );
  assert.match(panelHtml, /const available=Math\.max\(180,consoleTop-pageTop\)/);
  assert.match(panelHtml, /page\.style\.height=available\+'px'/);
  assert.match(panelHtml, /page\.style\.maxHeight=available\+'px'/);
  assert.match(panelHtml, /page\.style\.overflowY='auto'/);
  assert.match(
    panelHtml,
    /if\(typeof syncSettingsThinkingInset==='function'\)syncSettingsThinkingInset\(\)/,
  );
});

test("Product Brief 文件预览浮层避让实时思考流并由正文区独立滚动", () => {
  assert.match(panelHtml, /\.cf-preview-overlay\{[^}]*bottom:var\(--cf-preview-bottom-safe,28px\)/);
  assert.match(panelHtml, /\.cf-preview-card\{[^}]*max-height:100%[^}]*display:flex[^}]*flex-direction:column/);
  assert.match(panelHtml, /\.cf-preview-body\{[^}]*overflow-y:auto[^}]*min-height:0/);
  assert.match(panelHtml, /function syncChatFilePreviewInset\(\)/);
  assert.match(panelHtml, /syncChatFilePreviewInset\(\);/);
});

test("任务主线筛选在 thread 模型缺失时由 ADMIN 主任务补齐", () => {
  assert.match(panelHtml, /const represented=new Set\(models\.map/);
  assert.match(panelHtml, /fullList\.filter\(isAdminMainlineRootTask\)\.forEach\(root=>/);
  assert.match(panelHtml, /models\.push\(\{[\s\S]*?members:\[root\]/);
});

test("顶栏搜索、刷新与问题图标均连接真实功能", () => {
  assert.match(panelHtml, /id="gs-input"[\s\S]*?oninput="gsOnInput\(this\.value\)"/);
  assert.match(panelHtml, /api\/v2\/search\?q=/);
  assert.match(panelHtml, /id="hdr-refresh" onclick="refreshCurrentPanelView\(this\)"/);
  assert.match(panelHtml, /async function refreshCurrentPanelView\(btn\)/);
  assert.match(panelHtml, /issues:\s*`<svg/);
  assert.match(panelHtml, /NAV_ICONS=\{[^}]*issues:'issues'/);
});
