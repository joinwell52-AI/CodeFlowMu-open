import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import { sdkCooldownRegistry } from "../SdkCooldownRegistry.ts";
import { ZeroToolcallCircuitBreaker } from "../ZeroToolcallCircuitBreaker.ts";

describe("ZeroToolcallCircuitBreaker", () => {
  afterEach(() => {
    sdkCooldownRegistry.clear();
  });

  it("opens SDK circuit after 3 zero-toolcall failures within 60s", () => {
    let now = 5_000_000;
    let openedReason = "";
    const breaker = new ZeroToolcallCircuitBreaker({
      now: () => now,
      windowMs: 60_000,
      threshold: 3,
      cooldownMs: 5 * 60_000,
      onOpen: (_until, reason) => {
        openedReason = reason;
      },
    });

    assert.equal(breaker.recordFailedZeroToolcall(), false);
    now += 10_000;
    assert.equal(breaker.recordFailedZeroToolcall(), false);
    now += 10_000;
    assert.equal(breaker.recordFailedZeroToolcall(), true);
    assert.equal(openedReason, "SDK_CIRCUIT_OPEN");
    assert.equal(sdkCooldownRegistry.active, true);
    assert.equal(sdkCooldownRegistry.reason, "SDK_CIRCUIT_OPEN");
    assert.ok(sdkCooldownRegistry.untilMs > now);
  });
});
