import assert from "node:assert/strict";
import test from "node:test";
import {
  flushPanelApiSlowSummary,
  logPanelApiTiming,
  resetPanelApiTimingForTests,
} from "../panel-api-timing.ts";

test("slow panel polling logs one notice and one aggregated summary", () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    resetPanelApiTimingForTests();
    logPanelApiTiming("GET /api/v2/tasks?limit=200", performance.now() - 500);
    logPanelApiTiming("GET /api/v2/tasks?limit=200", performance.now() - 700);
    logPanelApiTiming("GET /api/v2/reports?limit=200", performance.now() - 900);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /subsequent requests are summarized once per minute/);

    flushPanelApiSlowSummary();
    assert.equal(warnings.length, 2);
    assert.match(warnings[1]!, /\[panel-api:slow-summary\] requests=3 routes=2/);
    assert.match(warnings[1]!, /tasks\?limit=200: 2x/);
    assert.match(warnings[1]!, /reports\?limit=200: 1x/);
  } finally {
    console.warn = originalWarn;
    resetPanelApiTimingForTests();
  }
});
