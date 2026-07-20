import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectPrimaryDeadlock,
  detectDeadlocks,
} from "../DeadlockDetector.ts";
import { planRecovery } from "../RecoveryPlanner.ts";
import {
  AUTO_RECOVERY_MIN_RETRY_MS,
  FIRST_TURN_ABORT_RETRY_1_MS,
  SESSION_UNSETTLED_SUSPECT_MS,
  type DeadlockDetectContext,
} from "../deadlockTypes.ts";

function baseCtx(
  overrides: Partial<DeadlockDetectContext> = {},
): DeadlockDetectContext {
  return {
    projectRoot: "/tmp/test",
    trigger: "watchdog",
    taskId: "TASK-20260610-001-PM-to-DEV",
    role: "DEV",
    agentId: "DEV-01",
    ...overrides,
  };
}

describe("DeadlockDetector", () => {
  it("detects stale_failed_receipt when report on disk with failed guard", () => {
    const d = detectPrimaryDeadlock(
      baseCtx({
        workerFailedPersisted: true,
        hasReportOnDisk: true,
        displayStatusWaitingPm: true,
      }),
    );
    assert.equal(d?.kind, "stale_failed_receipt");
  });

  it("detects retry_loop_risk when session failed with zero retry delay", () => {
    const d = detectPrimaryDeadlock(
      baseCtx({
        sessionFailed: true,
        retryDelayMs: 0,
      }),
    );
    assert.equal(d?.kind, "retry_loop_risk");
  });

  it("detects sdk_cooldown with remaining ms", () => {
    const d = detectPrimaryDeadlock(
      baseCtx({
        sdkCooldownActive: true,
        sdkCooldownRemainingMs: 45_000,
      }),
    );
    assert.equal(d?.kind, "sdk_cooldown");
    assert.equal(d?.meta?.remainingMs, 45_000);
  });

  it("detects stale_busy_no_session from reason code", () => {
    const d = detectPrimaryDeadlock(
      baseCtx({
        reasonCode: "stale_busy_no_session",
      }),
    );
    assert.equal(d?.kind, "stale_busy_no_session");
  });

  it("detects first_turn_abort with no tools and short duration", () => {
    const d = detectPrimaryDeadlock(
      baseCtx({
        isFirstTurnAbort: true,
        failureCategory: "cursor_sdk_first_turn_abort",
        hasReportOnDisk: false,
        durationMs: 3000,
        toolCallCount: 0,
      }),
    );
    assert.equal(d?.kind, "first_turn_abort");
  });

  it("detects no-detail first_turn_abort before retry_loop_risk", () => {
    const d = detectPrimaryDeadlock(
      baseCtx({
        sessionFailed: true,
        retryDelayMs: 0,
        isFirstTurnAbort: true,
        failureCategory: "cursor_sdk_first_turn_abort",
        hasReportOnDisk: false,
        durationMs: 18377,
        toolCallCount: 0,
      }),
    );
    assert.equal(d?.kind, "first_turn_abort");
  });

  it("detects session_unsettled after suspect threshold", () => {
    const started = new Date(
      Date.now() - SESSION_UNSETTLED_SUSPECT_MS - 60_000,
    ).toISOString();
    const d = detectPrimaryDeadlock(
      baseCtx({
        sessionUnsettled: true,
        sessionStartedAt: started,
      }),
    );
    assert.equal(d?.kind, "session_unsettled");
    assert.ok(Number(d?.meta?.elapsedMs) >= SESSION_UNSETTLED_SUSPECT_MS);
  });

  it("priority: stale_failed_receipt wins over sdk_cooldown", () => {
    const all = detectDeadlocks(
      baseCtx({
        workerFailedPersisted: true,
        hasReportOnDisk: true,
        sdkCooldownActive: true,
        sdkCooldownRemainingMs: 30_000,
      }),
    );
    assert.ok(all.length >= 2);
    assert.equal(all[0]?.kind, "stale_failed_receipt");
    assert.equal(detectPrimaryDeadlock(
      baseCtx({
        workerFailedPersisted: true,
        hasReportOnDisk: true,
        sdkCooldownActive: true,
        sdkCooldownRemainingMs: 30_000,
      }),
    )?.kind, "stale_failed_receipt");
  });
});

describe("RecoveryPlanner", () => {
  it("plans clear_guard for stale_failed_receipt", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "auto-recovery-"));
    const detection = detectPrimaryDeadlock(
      baseCtx({
        projectRoot,
        workerFailedPersisted: true,
        hasReportOnDisk: true,
      }),
    );
    assert.ok(detection);
    const plan = planRecovery({ projectRoot, detection });
    assert.equal(plan?.action, "clear_guard");
    assert.equal(plan?.countsTowardLimit, false);
  });

  it("plans force_safe_delay at least AUTO_RECOVERY_MIN_RETRY_MS for retry_loop_risk", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "auto-recovery-"));
    const detection = detectPrimaryDeadlock(
      baseCtx({
        projectRoot,
        sessionFailed: true,
        retryDelayMs: 0,
      }),
    );
    assert.ok(detection);
    const plan = planRecovery({ projectRoot, detection });
    assert.equal(plan?.action, "force_safe_delay");
    assert.ok((plan?.delayMs ?? 0) >= AUTO_RECOVERY_MIN_RETRY_MS);
  });

  it("plans delayed_retry for first_turn_abort attempt 1", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "auto-recovery-"));
    const detection = detectPrimaryDeadlock(
      baseCtx({
        projectRoot,
        isFirstTurnAbort: true,
        hasReportOnDisk: false,
        durationMs: 2000,
        toolCallCount: 0,
      }),
    );
    assert.ok(detection);
    const plan = planRecovery({ projectRoot, detection });
    assert.equal(plan?.action, "delayed_retry");
    assert.equal(plan?.delayMs, FIRST_TURN_ABORT_RETRY_1_MS);
  });
});
