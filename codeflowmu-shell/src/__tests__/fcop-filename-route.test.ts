import assert from "node:assert/strict";
import { test } from "node:test";

import { taskRouteFromFilename } from "../fcop-filename-route.ts";

test("taskRouteFromFilename: ADMIN→PM with trailing slug", () => {
  const r = taskRouteFromFilename(
    "TASK-20260607-017-ADMIN-to-PM-google-gemini-smoke.md",
  );
  assert.deepEqual(r, { sender: "ADMIN", recipient: "PM" });
});

test("taskRouteFromFilename: PM→OPS with trailing slug", () => {
  const r = taskRouteFromFilename(
    "TASK-20260512-025-PM-to-OPS-phase-a-fix-naming.md",
  );
  assert.deepEqual(r, { sender: "PM", recipient: "OPS" });
});

test("taskRouteFromFilename: no slug", () => {
  const r = taskRouteFromFilename("TASK-20260418-015-ADMIN-to-PM.md");
  assert.deepEqual(r, { sender: "ADMIN", recipient: "PM" });
});

test("taskRouteFromFilename: hyphenated sender role", () => {
  const r = taskRouteFromFilename("TASK-20260418-015-LEAD-QA-to-PM.md");
  assert.deepEqual(r, { sender: "LEAD-QA", recipient: "PM" });
});

test("taskRouteFromFilename: recipient with digit extension OPS-001", () => {
  const r = taskRouteFromFilename("TASK-20260512-025-PM-to-OPS-001-fix.md");
  assert.deepEqual(r, { sender: "PM", recipient: "OPS-001" });
});

test("taskRouteFromFilename: slot in recipient", () => {
  const r = taskRouteFromFilename(
    "TASK-20260418-201-MARKETER-to-assignee.D1.md",
  );
  assert.deepEqual(r, { sender: "MARKETER", recipient: "ASSIGNEE" });
});

test("taskRouteFromFilename: REPORT prefix", () => {
  const r = taskRouteFromFilename(
    "REPORT-20260512-009-OPS-to-PM-codeflow-json-rm.md",
  );
  assert.deepEqual(r, { sender: "OPS", recipient: "PM" });
});
