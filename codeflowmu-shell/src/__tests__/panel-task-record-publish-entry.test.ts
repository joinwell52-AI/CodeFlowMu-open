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

test("任务记录页只保留发布按钮，并复用带任务关系的发布弹窗", () => {
  const row = panelHtml.match(
    /<div class="tk-inp-wrap" id="taskInputRow"[^>]*>([\s\S]*?)<\/div>/,
  );

  assert.ok(row, "应存在任务记录页底部发布入口");
  assert.match(row[1]!, /onclick="showDirectDispatchModal\(\)"/);
  assert.match(row[1]!, /data-i18n="btn\.post"/);
  assert.doesNotMatch(row[1]!, /<(?:input|textarea|select)\b/);

  assert.match(panelHtml, /id="dd-task-relation"/);
  assert.match(panelHtml, /id="dd-reference-wrap"/);
});
