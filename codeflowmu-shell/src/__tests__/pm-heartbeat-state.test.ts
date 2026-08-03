import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  emptyPmHeartbeatState,
  evaluatePmHeartbeatFuse,
  readPmHeartbeatState,
  registerAcceptedPmHeartbeatWake,
  registerPmHeartbeatTick,
  settlePmHeartbeatWake,
  writePmHeartbeatState,
} from "../pm-heartbeat-state.ts";

describe("PM heartbeat result state", () => {
  it("persists every accepted, skipped, and failed scheduler tick", () => {
    const root = mkdtempSync(join(tmpdir(), "cf-pm-tick-state-"));
    try {
      const state = emptyPmHeartbeatState();
      registerPmHeartbeatTick(state, {
        tick_id: "TICK-1",
        observed_at: "2026-08-03T00:00:00.000Z",
        project_root: root,
        status: "skipped",
        decision: "skipped",
        skip_reason: "waiting_approval",
        task_id: "TASK-1",
      });
      registerPmHeartbeatTick(state, {
        tick_id: "TICK-2",
        observed_at: "2026-08-03T00:01:00.000Z",
        project_root: root,
        status: "failed",
        decision: "failed",
        skip_reason: "wake_http_failed",
        detail: "503",
      });
      writePmHeartbeatState(root, state);
      const restored = readPmHeartbeatState(root);
      assert.deepEqual(restored.ticks.map((tick) => [tick.tick_id, tick.status, tick.skip_reason]), [
        ["TICK-1", "skipped", "waiting_approval"],
        ["TICK-2", "failed", "wake_http_failed"],
      ]);
      assert.equal(restored.last_run_at_ms, 0);
      assert.equal(restored.last_digest, "");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists an accepted wake and blocks another wake while its session is pending", () => {
    const root = mkdtempSync(join(tmpdir(), "cf-pm-wake-state-"));
    try {
      const state = emptyPmHeartbeatState();
      registerAcceptedPmHeartbeatWake(state, {
        wake_id: "WAKE-1",
        task_id: "TASK-1",
        trigger_reason: "normal_interval",
        input_digest: "digest-1",
        session_id: "session-1",
        started_at: "2026-08-03T00:00:00.000Z",
        business_progress_digest_before: "digest-1",
      });
      writePmHeartbeatState(root, state);
      const restored = readPmHeartbeatState(root);
      assert.equal(restored.last_run_at_ms, Date.parse("2026-08-03T00:00:00.000Z"));
      assert.deepEqual(evaluatePmHeartbeatFuse({
        state: restored,
        taskId: "TASK-1",
        inputDigest: "digest-1",
        nowMs: Date.parse("2026-08-03T00:01:00.000Z"),
      }), { allow: false, reason: "wake_pending" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("backs off after two no-progress outcomes and opens one deduplicated fuse after three", () => {
    const state = emptyPmHeartbeatState();
    for (let index = 1; index <= 3; index += 1) {
      const wakeId = `WAKE-${index}`;
      registerAcceptedPmHeartbeatWake(state, {
        wake_id: wakeId,
        task_id: "TASK-1",
        trigger_reason: "normal_interval",
        input_digest: "same-digest",
        session_id: `session-${index}`,
        started_at: `2026-08-03T00:0${index}:00.000Z`,
        business_progress_digest_before: "same-digest",
      });
      const result = settlePmHeartbeatWake({
        state,
        wakeId,
        endedAt: `2026-08-03T00:0${index}:30.000Z`,
        sessionOutcome: "finished",
        failureCode: "OPERATION_BOUNDARY_DENIED",
        operationFingerprint: "operation-1",
        businessProgressDigestAfter: "same-digest",
      });
      assert.equal(result.alertRequired, index === 3);
    }
    assert.deepEqual(evaluatePmHeartbeatFuse({
      state,
      taskId: "TASK-1",
      inputDigest: "same-digest",
      nowMs: Date.parse("2026-08-03T01:00:00.000Z"),
    }), { allow: false, reason: "fuse_open" });
    const fuse = Object.values(state.fuses)[0]!;
    assert.equal(fuse.no_progress_count, 3);
    assert.equal(fuse.alert_emitted, true);
  });

  it("clears a task fuse only when the business digest materially changes", () => {
    const state = emptyPmHeartbeatState();
    state.fuses["TASK-1::operation-1"] = {
      key: "TASK-1::operation-1",
      task_id: "TASK-1",
      operation_fingerprint: "operation-1",
      last_input_digest: "old",
      no_progress_count: 3,
      open: true,
      alert_emitted: true,
    };
    assert.deepEqual(evaluatePmHeartbeatFuse({
      state,
      taskId: "TASK-1",
      inputDigest: "new",
      nowMs: Date.now(),
    }), { allow: true, reason: "allow" });
    assert.equal(Object.keys(state.fuses).length, 0);
  });
});
