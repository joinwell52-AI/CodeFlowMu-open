import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import {
  DECISION_FAILURE_THRESHOLD,
  DEFAULT_BACKOFF_RANGES_MS,
  DispatchRetryRegistry,
} from "../DispatchRetryRegistry.ts";
import { sdkCooldownRegistry } from "../SdkCooldownRegistry.ts";

describe("DispatchRetryRegistry", () => {
  afterEach(() => {
    sdkCooldownRegistry.clear();
  });

  it("第 1–3 次退避落在对应区间，第 4 次 decisionRequired", () => {
    let now = 1_000_000;
    const reg = new DispatchRetryRegistry({
      now: () => now,
      backoffRangesMs: DEFAULT_BACKOFF_RANGES_MS,
      randomInt: (min, max) => (min === max ? min : min),
    });
    const key = "agent-a:TASK-20260605-001";

    const r1 = reg.recordFailure(key, new Error("fail-1"), { retryable: true });
    assert.equal(r1.failureCount, 1);
    assert.equal(r1.decisionRequired, false);
    assert.equal(r1.nextRetryAt, now + DEFAULT_BACKOFF_RANGES_MS[0]![0]);
    assert.equal(reg.shouldDeferRestore(key), true);

    now += DEFAULT_BACKOFF_RANGES_MS[0]![0];
    const r2 = reg.recordFailure(key, new Error("fail-2"), { retryable: true });
    assert.equal(r2.failureCount, 2);
    assert.equal(r2.decisionRequired, false);
    assert.equal(r2.nextRetryAt, now + DEFAULT_BACKOFF_RANGES_MS[1]![0]);

    now += DEFAULT_BACKOFF_RANGES_MS[1]![0];
    const r3 = reg.recordFailure(key, new Error("fail-3"), { retryable: true });
    assert.equal(r3.failureCount, 3);
    assert.equal(r3.decisionRequired, false);
    assert.equal(r3.nextRetryAt, now + DEFAULT_BACKOFF_RANGES_MS[2]![0]);

    now += DEFAULT_BACKOFF_RANGES_MS[2]![0];
    const r4 = reg.recordFailure(key, new Error("fail-4"), { retryable: true });
    assert.equal(r4.failureCount, DECISION_FAILURE_THRESHOLD);
    assert.equal(r4.decisionRequired, true);
    assert.equal(r4.nextRetryAt, null);
    assert.equal(reg.shouldDeferRestore(key), true);
  });

  it("非 retryable 错误首次即 decisionRequired", () => {
    const reg = new DispatchRetryRegistry({
      now: () => 1_000,
      randomInt: () => 0,
    });
    const key = "agent-b:TASK-1";
    const rec = reg.recordFailure(key, new Error("auth"), { retryable: false });
    assert.equal(rec.failureCount, 1);
    assert.equal(rec.decisionRequired, true);
    assert.equal(rec.nextRetryAt, null);
  });

  it("adminRetry 清零 failureCount 并立即可重试", () => {
    let now = 5_000;
    const reg = new DispatchRetryRegistry({
      now: () => now,
      backoffRangesMs: [[1, 1]],
      randomInt: () => 1,
    });
    const key = "agent-c:TASK-2";
    for (let i = 0; i < 4; i++) {
      reg.recordFailure(key, new Error(`f${i + 1}`), { retryable: true });
    }
    const before = reg.get(key)!;
    assert.equal(before.decisionRequired, true);

    const after = reg.adminRetry(key)!;
    assert.equal(after.failureCount, 0);
    assert.equal(after.retryRound, 1);
    assert.equal(after.decisionRequired, false);
    assert.equal(after.nextRetryAt, now);
    assert.equal(reg.shouldDeferRestore(key), false);
  });

  it("adminForceArchive 永久阻断自动投递", () => {
    const reg = new DispatchRetryRegistry({ now: () => 9_000 });
    const key = "agent-d:TASK-3";
    reg.recordFailure(key, new Error("x"), { retryable: true });
    reg.recordFailure(key, new Error("y"), { retryable: true });
    reg.recordFailure(key, new Error("z"), { retryable: true });
    reg.recordFailure(key, new Error("w"), { retryable: true });

    const archived = reg.adminForceArchive(key)!;
    assert.equal(archived.forceArchived, true);
    assert.equal(archived.adminDecision, "force_archive");
    assert.equal(archived.decisionRequired, false);
    assert.equal(reg.isForceArchived(key), true);
    assert.equal(reg.shouldDeferRestore(key), true);
  });

  it("clear 移除记录", () => {
    const reg = new DispatchRetryRegistry();
    const key = "k";
    reg.recordFailure(key, new Error("e"));
    reg.clear(key);
    assert.equal(reg.get(key), undefined);
  });
});
