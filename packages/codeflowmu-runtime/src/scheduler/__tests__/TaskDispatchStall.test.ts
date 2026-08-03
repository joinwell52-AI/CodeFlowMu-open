import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyTaskDispatchStall } from "../TaskDispatchStall.ts";

describe("classifyTaskDispatchStall", () => {
  it("distinguishes dependency wait before offering recovery", () => {
    assert.deepEqual(
      classifyTaskDispatchStall({
        lifecycleBucket: "inbox",
        fmState: "inbox",
        dependencyAllowed: false,
      }),
      {
        state: "waiting_dependency",
        actionable: false,
        recommended_action: "wait_dependency",
        reason: "task dependencies are not settled",
      },
    );
  });

  it("classifies inbox/dispatched as a repairable lifecycle split", () => {
    const result = classifyTaskDispatchStall({
      lifecycleBucket: "inbox",
      fmState: "dispatched",
      dependencyAllowed: true,
    });
    assert.equal(result.state, "lifecycle_split");
    assert.equal(result.recommended_action, "repair_retry");
  });

  it("offers autonomous claim for an unclaimed recipient inbox task", () => {
    const result = classifyTaskDispatchStall({
      lifecycleBucket: "inbox",
      fmState: "inbox",
      dependencyAllowed: true,
    });
    assert.equal(result.state, "task_unclaimed");
    assert.equal(result.recommended_action, "claim_task");
  });

  it("separates a healthy running lease from a lost session", () => {
    const lease = {
      lease_id: "lease-1",
      task_id: "TASK-1",
      attempt_id: "attempt-1",
      agent_id: "DEV-01",
      session_id: "session-1",
      acquired_at: "2026-08-03T00:00:00.000Z",
      expires_at: "2026-08-03T01:00:00.000Z",
    };
    assert.equal(
      classifyTaskDispatchStall({
        lifecycleBucket: "active",
        activeLease: lease,
        hasLiveSession: true,
      }).state,
      "running",
    );
    const lost = classifyTaskDispatchStall({
      lifecycleBucket: "active",
      activeLease: lease,
      hasLiveSession: false,
    });
    assert.equal(lost.state, "session_lost");
    assert.equal(lost.recommended_action, "restart_session");
  });
});
