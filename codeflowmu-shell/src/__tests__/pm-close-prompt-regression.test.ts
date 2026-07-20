import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const webPanelSource = readFileSync(join(here, "..", "web-panel.ts"), "utf8");

test("PM close prompt does not inject a historical task thread", () => {
  assert.equal(webPanelSource.includes("上下文（239 / panel-task-239）"), false);
  assert.equal(webPanelSource.includes("REPORT-20260531-008-OPS-to-PM.md"), false);
  assert.equal(webPanelSource.includes('task_id="TASK-20260531-239-ADMIN-to-PM"'), false);
});
