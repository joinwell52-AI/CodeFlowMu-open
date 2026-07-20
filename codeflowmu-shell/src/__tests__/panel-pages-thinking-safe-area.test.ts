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

test("七个工具页面统一避让实时思考流和队列栏", () => {
  const safeAreaRule = panelHtml.match(
    /#page-eval,\s*#page-skills,\s*#page-files,\s*#page-errorlog,\s*#page-mobile,\s*#page-env,\s*#page-team\s*\{([\s\S]*?)\}/,
  );

  assert.ok(safeAreaRule, "七个页面应共享同一外层底部安全区规则");
  assert.match(safeAreaRule[1]!, /padding-bottom:[^;]*var\(--think-console-h,28px\)/);
  assert.match(safeAreaRule[1]!, /padding-bottom:[^;]*var\(--queue-bar-h,0px\)/);
  assert.match(safeAreaRule[1]!, /scroll-padding-bottom:[^;]*var\(--think-console-h,28px\)/);
  assert.match(safeAreaRule[1]!, /box-sizing:border-box/);
});
