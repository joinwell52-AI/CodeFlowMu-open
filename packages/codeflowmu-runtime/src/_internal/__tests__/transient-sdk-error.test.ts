/**
 * transient-sdk-error unit tests.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  TRANSIENT_SDK_BACKOFF_MS,
  TRANSIENT_SDK_DELAYED,
  isTransientSdkError,
  withTransientSdkRetry,
} from "../transient-sdk-error.ts";

test("isTransientSdkError matches NGHTTP2 and Stream closed", () => {
  assert.equal(
    isTransientSdkError(new Error("NGHTTP2_ENHANCE_YOUR_CALM")),
    true,
  );
  assert.equal(isTransientSdkError("Stream closed"), true);
  assert.equal(isTransientSdkError("rate limited by upstream"), true);
  assert.equal(isTransientSdkError("request timeout"), true);
  assert.equal(isTransientSdkError(new Error("permission denied")), false);
});

test("isTransientSdkError matches nested ConnectError ECONNRESET", () => {
  const cause = Object.assign(
    new Error(
      "Client network socket disconnected before secure TLS connection was established",
    ),
    {
      code: "ECONNRESET",
      host: "api2.cursor.sh",
      port: "443",
    },
  );
  const err = Object.assign(new Error("[aborted] transport failed"), {
    rawMessage:
      "Client network socket disconnected before secure TLS connection was established",
    code: 10,
    cause,
  });

  assert.equal(isTransientSdkError(err), true);
});

test("withTransientSdkRetry succeeds on first try", async () => {
  let calls = 0;
  const result = await withTransientSdkRetry(async () => {
    calls += 1;
    return "ok";
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value, "ok");
  assert.equal(calls, 1);
});

test("withTransientSdkRetry retries transient then succeeds", async () => {
  let calls = 0;
  const delays: number[] = [];
  const result = await withTransientSdkRetry(
    async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error("NGHTTP2_ENHANCE_YOUR_CALM");
      }
      return 42;
    },
    {
      backoffMs: [1, 1, 1],
      onRetry: (_a, delayMs) => {
        delays.push(delayMs);
      },
    },
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value, 42);
  assert.equal(calls, 3);
  assert.equal(delays.length, 2);
});

test("withTransientSdkRetry returns delayed after backoff exhausted", async () => {
  let calls = 0;
  const result = await withTransientSdkRetry(
    async () => {
      calls += 1;
      throw new Error("Stream closed");
    },
    { backoffMs: [1, 1, 1] },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.delayed, true);
    assert.equal(isTransientSdkError(result.lastError), true);
  }
  assert.equal(calls, TRANSIENT_SDK_BACKOFF_MS.length + 1);
});

test("withTransientSdkRetry throws immediately on non-transient error", async () => {
  await assert.rejects(
    () =>
      withTransientSdkRetry(async () => {
        throw new Error("fatal auth failure");
      }),
    /fatal auth failure/,
  );
});

test("TRANSIENT_SDK_DELAYED constant is stable", () => {
  assert.equal(TRANSIENT_SDK_DELAYED, "TRANSIENT_SDK_DELAYED");
});
