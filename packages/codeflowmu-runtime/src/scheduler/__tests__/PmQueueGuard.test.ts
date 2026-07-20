import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PmQueueGuard,
  isPmToWorkerDispatch,
} from "../PmQueueGuard.ts";

describe("PmQueueGuard", () => {
  it("releases busy on finally after runGuarded success", async () => {
    let now = 1_000;
    const guard = new PmQueueGuard({ now: () => now });
    const out = await guard.runGuarded("test", async () => "ok");
    assert.equal(out, "ok");
    assert.equal(guard.snapshot().pm_busy, false);
    assert.equal(guard.snapshot().phase, "idle");
  });

  it("releases busy on runGuarded failure", async () => {
    const guard = new PmQueueGuard();
    await assert.rejects(
      () =>
        guard.runGuarded("test", async () => {
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.equal(guard.snapshot().pm_busy, false);
  });

  it("markWaitingDownstream clears pm_busy while keeping waiting flag", () => {
    const guard = new PmQueueGuard();
    guard.acquire("pm_session");
    guard.markWaitingDownstream("OPS");
    const snap = guard.snapshot();
    assert.equal(snap.pm_busy, false);
    assert.equal(snap.waiting_downstream, true);
    assert.equal(snap.phase, "waiting_downstream");
    assert.equal(snap.downstream_role, "OPS");
  });

  it("stale release fires after 90s without PM events", () => {
    let now = 0;
    const warnings: string[] = [];
    const guard = new PmQueueGuard({
      now: () => now,
      staleMs: 90_000,
      logger: { warn: (m) => warnings.push(m) },
    });
    guard.acquire("stuck");
    now += 91_000;
    assert.equal(guard.checkAndReleaseStale(), true);
    const snap = guard.snapshot();
    assert.equal(snap.pm_busy, false);
    assert.equal(snap.stale_released, true);
    assert.equal(snap.phase, "stale_released");
    assert.match(warnings.join("\n"), /PM_QUEUE_STALE_RELEASED/);
  });

  it("file_without_ledger path does not leave permanent busy after guarded work", async () => {
    const guard = new PmQueueGuard();
    await guard.runGuarded("ledger_rescan", async () => {
      // simulate diagnostics warning only — no throw
      return { warning: "file_without_ledger" };
    }, "diagnostics_warning");
    assert.equal(guard.snapshot().pm_busy, false);
  });

  it("isPmToWorkerDispatch detects PM→OPS filename", () => {
    assert.equal(
      isPmToWorkerDispatch(undefined, undefined, "TASK-20260531-001-PM-to-OPS.md"),
      true,
    );
    assert.equal(isPmToWorkerDispatch("PM", "OPS"), true);
    assert.equal(isPmToWorkerDispatch("ADMIN", "PM"), false);
  });

  it("recordAutoNudge and clearAutoNudge update downstream nudge snapshot", () => {
    const guard = new PmQueueGuard();
    guard.recordAutoNudge({
      task_id: "TASK-20260609-002-PM-to-OPS",
      role: "OPS",
      nudged_at: 1000,
      next_nudge_at: 2000,
      session_id: "sess-ops-1",
    });
    let snap = guard.snapshot();
    assert.equal(snap.downstream_auto_nudged_at, 1000);
    assert.equal(snap.downstream_next_nudge_at, 2000);
    assert.equal(snap.downstream_nudge_task_id, "TASK-20260609-002-PM-to-OPS");
    assert.equal(snap.downstream_last_wake_session_id, "sess-ops-1");
    assert.equal(snap.waiting_downstream, true);
    assert.equal(snap.downstream_role, "OPS");

    guard.clearAutoNudge();
    snap = guard.snapshot();
    assert.equal(snap.downstream_auto_nudged_at, null);
    assert.equal(snap.downstream_next_nudge_at, null);
    assert.equal(snap.downstream_nudge_task_id, null);
    assert.equal(snap.downstream_last_wake_session_id, null);
  });

  it("markDownstreamWorkerFailed clears waiting and auto nudge", () => {
    const guard = new PmQueueGuard();
    guard.markWaitingDownstream("QA");
    guard.recordAutoNudge({
      task_id: "TASK-20260609-010-PM-to-QA",
      role: "QA",
      nudged_at: 1000,
      next_nudge_at: 2000,
    });
    guard.markDownstreamWorkerFailed("TASK-20260609-010-PM-to-QA");
    const snap = guard.snapshot();
    assert.equal(snap.waiting_downstream, false);
    assert.equal(snap.downstream_auto_nudged_at, null);
    assert.equal(guard.isDownstreamWorkerFailed("TASK-20260609-010-PM-to-QA"), true);
  });

  it("bumpNudgeCount tracks per-task nudge attempts", () => {
    const guard = new PmQueueGuard();
    assert.equal(guard.bumpNudgeCount("TASK-A"), 1);
    assert.equal(guard.bumpNudgeCount("TASK-A"), 2);
    assert.equal(guard.nudgeCountForTask("TASK-A"), 2);
    guard.clearNudgeCount("TASK-A");
    assert.equal(guard.nudgeCountForTask("TASK-A"), 0);
  });
});
