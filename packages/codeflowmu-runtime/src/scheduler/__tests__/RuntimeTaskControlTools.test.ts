import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  RUNTIME_TASK_CONTROL_TOOL_DEFINITIONS,
  invokeRuntimeTaskControlTool,
} from "../RuntimeTaskControlTools.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("RuntimeTaskControlTools", () => {
  it("publishes the complete executor recovery tool set", () => {
    assert.deepEqual(
      RUNTIME_TASK_CONTROL_TOOL_DEFINITIONS.map((tool) => tool.name),
      ["list_my_tasks", "read_my_task", "claim_task"],
    );
  });

  it("routes claim_task to the shared Panel control plane with identity", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      request = { url: String(input), init };
      return new Response(JSON.stringify({ ok: true, lease_id: "lease-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await invokeRuntimeTaskControlTool({
      toolName: "claim_task",
      args: { task_id: "TASK-20260803-001", idempotency_key: "claim-1" },
      agentId: "DEV-01",
      sessionId: "sess-1",
      panelUrl: "http://127.0.0.1:18768",
    });

    assert.equal(result.ok, true);
    assert.equal(request?.url, "http://127.0.0.1:18768/api/v2/runtime/tasks/TASK-20260803-001/claim");
    assert.equal(request?.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(request?.init?.body)), {
      agent_id: "DEV-01",
      session_id: "sess-1",
      role: "DEV",
      idempotency_key: "claim-1",
    });
  });

  it("rejects identities outside DEV/QA/OPS before network access", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("must not call");
    }) as typeof fetch;
    const result = await invokeRuntimeTaskControlTool({
      toolName: "list_my_tasks",
      args: {},
      agentId: "PM-01",
      sessionId: "sess-1",
      panelUrl: "http://127.0.0.1:18768",
    });
    assert.equal(result.code, "EXECUTOR_IDENTITY_REQUIRED");
    assert.equal(called, false);
  });
});
