import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSdkFailurePayloadFields,
  classifySdkFailureCategory,
  extractSdkErrorDetails,
  isSdkResultNoDetail,
  rebuildSdkFailureForSessionEnd,
} from "../sdk-failure-classifier.ts";

test("isSdkResultNoDetail: raw only status error", () => {
  assert.equal(isSdkResultNoDetail({ status: "error" }), true);
  assert.equal(
    isSdkResultNoDetail({ status: "error", message: "quota exceeded" }),
    false,
  );
  assert.equal(
    isSdkResultNoDetail({ status: "error", errorCode: "RATE_LIMIT" }),
    false,
  );
});

test("classifySdkFailureCategory: first turn abort beats no_detail", () => {
  const cat = classifySdkFailureCategory({
    status: "error",
    tool_call_count: 0,
    duration_ms: 8000,
    raw: { status: "error" },
  });
  assert.equal(cat, "cursor_sdk_first_turn_abort");
});

test("classifySdkFailureCategory: rate_limited", () => {
  assert.equal(
    classifySdkFailureCategory({
      status: "error",
      raw: { status: "error", message: "HTTP 429 quota exceeded" },
    }),
    "rate_limited",
  );
  assert.equal(
    classifySdkFailureCategory({
      status: "error",
      error_message: "NGHTTP2_ENHANCE_YOUR_CALM",
    }),
    "rate_limited",
  );
});

test("classifySdkFailureCategory: transient_network", () => {
  assert.equal(
    classifySdkFailureCategory({
      status: "error",
      error_message: "fetch failed ECONNRESET",
    }),
    "transient_network",
  );
});

test("classifySdkFailureCategory: policy_blocked", () => {
  assert.equal(
    classifySdkFailureCategory({
      status: "error",
      error_message:
        "CODEFLOWMU_POLICY_BLOCKED: PM shell command not in read-only allowlist",
    }),
    "policy_blocked",
  );
});

test("classifySdkFailureCategory: no-detail zero-tool sessions are retryable first-turn aborts", () => {
  assert.equal(
    classifySdkFailureCategory({
      status: "error",
      tool_call_count: 0,
      duration_ms: 20000,
      raw: { status: "error" },
    }),
    "cursor_sdk_first_turn_abort",
  );
});

test("extractSdkErrorDetails: nested cursor fields", () => {
  const detail = extractSdkErrorDetails({
    status: "error",
    error: {
      message: "Internal server error",
      errorCode: "CURSOR_5XX",
      name: "CursorSdkError",
      cursor_request_id: "req-abc",
    },
    providerStatus: 503,
  });
  assert.equal(detail.sdk_error_message, "Internal server error");
  assert.equal(detail.sdk_error_code, "CURSOR_5XX");
  assert.equal(detail.sdk_error_name, "CursorSdkError");
  assert.equal(detail.cursor_request_id, "req-abc");
  assert.equal(detail.provider_status, "503");
});

test("buildSdkFailurePayloadFields: no detail note", () => {
  const fields = buildSdkFailurePayloadFields({
    status: "error",
    tool_call_count: 0,
    duration_ms: 9000,
    raw: { status: "error" },
    agent_id: "PM-01",
    role: "PM",
    session_id: "sess-1",
    task_id: "CHAT-001",
  });
  assert.equal(fields.failure_category, "cursor_sdk_first_turn_abort");
  assert.equal(fields.sdk_no_detail, true);
  assert.equal(fields.sdk_no_detail_note, "no detailed error exposed by SDK");
  assert.equal(fields.is_first_turn_abort, true);
  assert.ok(Array.isArray(fields.suggested_actions));
  assert.equal(fields.tool_call_count, 0);
  assert.equal(fields.duration_ms, 9000);
});

test("rebuildSdkFailureForSessionEnd: session duration triggers first_turn_abort", () => {
  const runDetail = extractSdkErrorDetails({ status: "error" });
  const rebuilt = rebuildSdkFailureForSessionEnd({
    runDetail,
    status: "error",
    tool_call_count: 0,
    duration_ms: 7500,
    agent_id: "PM-01",
    role: "PM",
    session_id: "sess-1",
    task_id: "CHAT-001",
  });
  assert.equal(rebuilt.failure_category, "cursor_sdk_first_turn_abort");
  assert.equal(rebuilt.duration_ms, 7500);
  assert.equal(rebuilt.is_first_turn_abort, true);
});

test("rebuildSdkFailureForSessionEnd: long no-detail zero-tool session is retryable", () => {
  const rebuilt = rebuildSdkFailureForSessionEnd({
    runDetail: extractSdkErrorDetails({ status: "error" }),
    status: "error",
    tool_call_count: 0,
    duration_ms: 20000,
    session_id: "sess-2",
  });
  assert.equal(rebuilt.failure_category, "cursor_sdk_first_turn_abort");
  assert.equal(rebuilt.is_first_turn_abort, true);
});
