import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { DispatchAttemptStore } from "../DispatchAttemptStore.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dispatch-attempt-"));
  roots.push(root);
  return { root, store: new DispatchAttemptStore({ projectRoot: root }) };
}

describe("DispatchAttemptStore", () => {
  it("persists attempts and leases across Runtime restart", async () => {
    const { root, store } = await fixture();
    const offered = await store.offer({
      task_id: "TASK-20260803-003",
      task_path: join(root, "fcop", "_lifecycle", "inbox", "TASK.md"),
      target_role: "DEV",
      source: "test",
      mode: "initial",
      idempotency_key: "dispatch:003:1",
    });
    const claimed = await store.claim({ taskId: "TASK-20260803-003", attemptId: offered.attempt.attempt_id, agentId: "DEV-01", sessionId: "sess-1" });
    assert.equal(claimed.ok, true);
    const state = await new DispatchAttemptStore({ projectRoot: root }).getTaskState("TASK-20260803-003");
    assert.equal(state.attempts.length, 1);
    assert.equal(state.active_lease?.session_id, "sess-1");
  });

  it("allows only one active execution lease under concurrent claims", async () => {
    const { store } = await fixture();
    const first = await store.offer({ task_id: "TASK-1", task_path: "x", target_role: "DEV", source: "test", mode: "initial" });
    const second = await store.offer({ task_id: "TASK-1", task_path: "x", target_role: "DEV", source: "test", mode: "retry" });
    const outcomes = await Promise.all([
      store.claim({ taskId: "TASK-1", attemptId: first.attempt.attempt_id, agentId: "DEV-01", sessionId: "s1" }),
      store.claim({ taskId: "TASK-1", attemptId: second.attempt.attempt_id, agentId: "DEV-02", sessionId: "s2" }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
    assert.equal(outcomes.filter((outcome) => !outcome.ok && outcome.code === "LEASE_CONFLICT").length, 1);
  });

  it("keeps retry on the same task id while appending a new attempt", async () => {
    const { store } = await fixture();
    const first = await store.offer({ task_id: "TASK-1", task_path: "x", target_role: "DEV", source: "test", mode: "initial" });
    const lease = await store.claim({ taskId: "TASK-1", attemptId: first.attempt.attempt_id, agentId: "DEV-01", sessionId: "s1" });
    assert.equal(lease.ok, true);
    await store.finish(first.attempt.attempt_id, "session_failed", "fault injection");
    const retry = await store.offer({ task_id: "TASK-1", task_path: "x", target_role: "DEV", source: "test", mode: "repair_retry" });
    assert.notEqual(retry.attempt.attempt_id, first.attempt.attempt_id);
    const state = await store.getTaskState("TASK-1");
    assert.deepEqual(state.attempts.map((attempt) => attempt.status), ["session_failed", "offered"]);
    assert.equal(state.active_lease, undefined);
  });

  it("stores one immutable decision per operation/task/input digest", async () => {
    const { store } = await fixture();
    const input = {
      operation_id: "operation-1",
      task_id: "TASK-1",
      input_digest: "digest-1",
      decision: "WAIT" as const,
      reason: "dependency_pending",
      source: "test",
    };
    const first = await store.recordDecision(input);
    const replay = await store.recordDecision(input);
    assert.equal(first.decision_id, replay.decision_id);
    await assert.rejects(
      () => store.recordDecision({ ...input, decision: "ALLOW", reason: "all_dispatch_gates_passed" }),
      /STATE_DECISION_CONFLICT/,
    );
  });
});
