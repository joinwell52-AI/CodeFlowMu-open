import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { classifyFcopToolOutcome } from "../FcopToolOutcome.ts";

describe("classifyFcopToolOutcome", () => {
  it("treats File not found as failed", () => {
    const r = classifyFcopToolOutcome(
      "read_task",
      "File not found: ISSUE-20260529-001-OPS.md (no task matches 'ISSUE-20260529-001-OPS.md')",
    );
    assert.equal(r.outcome, "failed");
  });

  it("treats inspect FAIL as failed", () => {
    const r = classifyFcopToolOutcome(
      "inspect_task",
      "ISSUE-20260529-001-OPS.md\n\nFAIL — 1 error(s):\n- filename: no task matches",
    );
    assert.equal(r.outcome, "failed");
  });

  it("treats finish on done task as soft success", () => {
    const r = classifyFcopToolOutcome(
      "finish_task",
      "Cannot finish: task is in stage 'done', expected 'active'.",
    );
    assert.equal(r.outcome, "success");
    assert.match(r.label, /done/);
  });

  it("treats fcop_check drift report as success", () => {
    const r = classifyFcopToolOutcome(
      "fcop_check",
      "=== FCoP Check（audit_drift） ===\n\ngit: OK —— FCoP 账本外漂移 5 份",
    );
    assert.equal(r.outcome, "success");
  });

  it("treats structured fallback ok:false as failed", () => {
    const r = classifyFcopToolOutcome(
      "write_report",
      JSON.stringify({
        ok: false,
        fallback: "write_report",
        reason: "task_not_found",
        task_id: "TASK-20260711-999",
      }),
    );
    assert.equal(r.outcome, "failed");
  });

  it("keeps a real deduplicated retry with ok:true successful", () => {
    const r = classifyFcopToolOutcome(
      "write_report",
      JSON.stringify({
        ok: true,
        fallback: "write_report",
        deduplicated: true,
        filename: "REPORT-20260712-007-PM-to-ADMIN.md",
      }),
    );
    assert.equal(r.outcome, "success");
  });
});
