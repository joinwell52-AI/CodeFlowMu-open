import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { wpSummarizeTaskTransitionsForList } from "../web-panel.ts";

describe("GET /api/v2/tasks transition summary", () => {
  it("strips full transitions and returns count + latest only", () => {
    const transitions = Array.from({ length: 120 }, (_, i) => ({
      at: `2026-06-12T10:${String(i % 60).padStart(2, "0")}:00+08:00`,
      from: "active",
      to: "inbox",
      by: "CodeFlowMu",
      action: "runtime_restore_failed_dispatch",
    }));
    const { task, warnings } = wpSummarizeTaskTransitionsForList({
      task_id: "TASK-20260611-102",
      filename: "TASK-20260611-102-ADMIN-to-PM.md",
      transitions,
      yaml: { transitions },
    });

    assert.equal(task.transition_count, 120);
    assert.ok(task.latest_transition);
    assert.equal((task as { transitions?: unknown }).transitions, undefined);
    assert.ok(
      warnings.some((w) => w.includes("task_transitions_warning:TASK-20260611-102")),
    );
  });
});
