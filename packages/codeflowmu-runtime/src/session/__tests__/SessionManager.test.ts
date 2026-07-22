/**
 * SessionManager unit tests — TASK-20260509-013 §主交付 1
 * × QA test-strategy §3.4 TS-4.1 ~ TS-4.5.
 *
 * Coverage map:
 *   TS-4.1: startSession against unknown agent → AgentNotFoundError
 *   TS-4.1b: startSession on agent with status="running" → InvalidAgentStatusError
 *   TS-4.2: startSession success → SessionRecord persisted + transcript opened
 *           + runtime.session_started fires
 *   TS-4.3: 1000-event throughput sanity (planted events drained without loss)
 *   TS-4.4: cancelSession invariant order (SDK cancel BEFORE persist)
 *           + idempotency (second cancel = warn, no double-write)
 *   TS-4.5: cancelAllForEmergencyStop uses Promise.allSettled (one fail
 *           does NOT block peers)
 *   + onEvent fan-out + listener-throw isolation (peers continue)
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { Agent } from "@codeflowmu/protocol";

import { AgentRegistry } from "../../registry/AgentRegistry.ts";
import {
  InMemoryRunHandle,
  InMemorySdkAdapter,
} from "../../registry/AgentSdkAdapter.ts";
import {
  AgentNotFoundError,
  InvalidAgentStatusError,
  SessionNotFoundError,
} from "../../registry/errors.ts";
import type {
  RuntimeEvent,
  RuntimeEventType,
  SessionRecord,
} from "../../types/state.ts";
import { SessionManager } from "../SessionManager.ts";
import { SessionLeaseConflictError } from "../SessionLeaseStore.ts";
import { withTempSessionDir } from "./helpers.ts";

function validAgentSpec(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: "DEV-01",
    role: "developer",
    layer: "worker",
    node: "local",
    runtime: "local",
    workspace: "D:\\CodeFlowMu",
    skills: ["fcop", "git"],
    status: "idle",
    ...overrides,
  };
}

interface ManagerCtx {
  registry: AgentRegistry;
  sdk: InMemorySdkAdapter;
  manager: SessionManager;
  store: ReturnType<typeof Object>;
}

async function withManager<T>(
  fn: (ctx: {
    manager: SessionManager;
    sdk: InMemorySdkAdapter;
    registry: AgentRegistry;
    sessionStore: import("../SessionStore.ts").SessionStore;
    transcriptWriter: import("../TranscriptWriter.ts").TranscriptWriter;
  }) => Promise<T>,
): Promise<T> {
  return withTempSessionDir(
    async ({ sessionStore, transcriptWriter, agentStore }) => {
      const sdk = new InMemorySdkAdapter();
      const registry = new AgentRegistry({ store: agentStore, sdk });
      const manager = new SessionManager({
        registry,
        sdk,
        sessionStore,
        transcriptWriter,
      });
      try {
        return await fn({
          manager,
          sdk,
          registry,
          sessionStore,
          transcriptWriter,
        });
      } finally {
        await transcriptWriter.closeAll().catch(() => undefined);
      }
    },
  );
}
void {} as unknown as ManagerCtx; // suppress unused warning for the type doc

// ── TS-4.1 ──────────────────────────────────────────────────────────

test("TS-4.1: startSession on unknown agent → AgentNotFoundError", async () => {
  await withManager(async ({ manager, sdk }) => {
    await assert.rejects(
      () => manager.startSession("DEV-99", "TASK-x", { text: "hi" }),
      AgentNotFoundError,
    );
    // Critically: SDK was never called. Validation precedes side effects.
    assert.equal(sdk.calls.send.length, 0);
  });
});

test("TS-4.1b: startSession ignores stale status=running without an active session", async () => {
  await withManager(async ({ manager, registry, sdk }) => {
    await registry.register(validAgentSpec());
    const rec = (await registry.get("DEV-01"))!;
    const updated = {
      ...rec,
      protocol: { ...rec.protocol, status: "running" as const },
    };
    const agentStore = registry["_store"]; // same package, private seam
    await agentStore.upsert(updated);

    const handle = await manager.startSession("DEV-01", "TASK-x", { text: "hi" });
    assert.equal(handle.agent_id, "DEV-01");
    assert.equal(sdk.calls.send.length, 1);
    await manager.cancelSession(handle.session_id, "cleanup");
  });
});

test("TS-4.1c: startSession rejects status=running with a real active session", async () => {
  await withManager(async ({ manager, registry, sessionStore, sdk }) => {
    await registry.register(validAgentSpec());
    const rec = (await registry.get("DEV-01"))!;
    await registry["_store"].upsert({
      ...rec,
      protocol: { ...rec.protocol, status: "running" as const },
    });
    await sessionStore.save({
      protocol: {
        session_id: "session-busy",
        agent_id: "DEV-01",
        task_id: "TASK-busy",
        started_at: "2026-06-12T00:00:00.000Z",
        status: "running",
        runs: [],
      },
    });

    await assert.rejects(
      () => manager.startSession("DEV-01", "TASK-x", { text: "hi" }),
      InvalidAgentStatusError,
    );
    assert.equal(sdk.calls.send.length, 0, "SDK must not be called on bad status");
    await sessionStore.remove("session-busy");
  });
});

// ── TS-4.2 ──────────────────────────────────────────────────────────

test("TS-4.2a: resolveMcpServers receives the minted Runtime session id", async () => {
  await withTempSessionDir(
    async ({ sessionStore, transcriptWriter, agentStore }) => {
      const sdk = new InMemorySdkAdapter();
      const registry = new AgentRegistry({ store: agentStore, sdk });
      let resolved:
        | {
            agentId: string;
            layer: string;
            sessionId: string;
            currentTaskId: string;
          }
        | undefined;
      const manager = new SessionManager({
        registry,
        sdk,
        sessionStore,
        transcriptWriter,
        newSessionId: () => "session-pm-planning-001",
        resolveMcpServers: (params) => {
          resolved = params;
          return { fcop: { env: { CODEFLOWMU_SESSION_ID: params.sessionId } } };
        },
      });
      try {
        await registry.register(validAgentSpec());
        const handle = await manager.startSession("DEV-01", "TASK-20260712-002", {
          text: "go",
        });
        assert.equal(handle.session_id, "session-pm-planning-001");
        assert.deepEqual(resolved, {
          agentId: "DEV-01",
          layer: "worker",
          sessionId: "session-pm-planning-001",
          currentTaskId: "TASK-20260712-002",
        });
      } finally {
        await transcriptWriter.closeAll().catch(() => undefined);
      }
    },
  );
});

test("session lease rejects a duplicate before MCP resolution and SDK send", async () => {
  await withTempSessionDir(async ({ sessionStore, transcriptWriter, agentStore }) => {
    const sdk = new InMemorySdkAdapter();
    const registry = new AgentRegistry({ store: agentStore, sdk });
    let resolverCalls = 0;
    const first = new SessionManager({
      registry,
      sdk,
      sessionStore,
      transcriptWriter,
      newSessionId: () => "session-lease-owner",
      resolveMcpServers: () => {
        resolverCalls += 1;
        return {};
      },
    });
    const second = new SessionManager({
      registry,
      sdk,
      sessionStore,
      transcriptWriter,
      newSessionId: () => "session-lease-duplicate",
      resolveMcpServers: () => {
        resolverCalls += 1;
        return {};
      },
    });
    await registry.register(validAgentSpec());
    sdk.sendHandleFactory = (spec) =>
      new InMemoryRunHandle({
        sessionId: spec.sessionId,
        agentId: spec.agentId,
        manualSettle: true,
      });

    const owner = await first.startSession("DEV-01", "TASK-20260715-006", {
      text: "owner",
      context: { project_id: "mother", canonical_root_task_id: "TASK-20260715-006" },
    });
    await assert.rejects(
      () => second.startSession("DEV-01", "TASK-20260715-006", {
        text: "duplicate",
        context: { project_id: "mother", canonical_root_task_id: "TASK-20260715-006" },
      }),
      SessionLeaseConflictError,
    );
    assert.equal(resolverCalls, 1, "duplicate must be blocked before MCP subprocess config");
    assert.equal(sdk.calls.send.length, 1, "duplicate must be blocked before SDK send");
    await first.cancelSession(owner.session_id, "test cleanup");
  });
});

test("TS-4.2: startSession success → record persisted + session_started emitted", async () => {
  await withManager(async ({ manager, registry, sessionStore }) => {
    await registry.register(validAgentSpec());

    const events: RuntimeEvent[] = [];
    manager.onEvent((e) => events.push(e));

    const handle = await manager.startSession(
      "DEV-01",
      "TASK-20260712-003-PM-to-QA",
      {
      text: "go!",
      context: {
        trigger_chat_id: "CHAT-1783845104910",
        thread_key: "panel-task-001",
      },
      },
    );
    assert.match(handle.session_id, /^session-/);
    assert.equal(handle.agent_id, "DEV-01");
    assert.equal(handle.task_id, "TASK-20260712-003");
    assert.ok(handle.activeRun);

    // Persisted SessionRecord exists with status=running.
    const persisted = await sessionStore.load(handle.session_id);
    assert.ok(persisted);
    assert.equal(persisted!.protocol.status, "running");
    assert.equal(persisted!.protocol.agent_id, "DEV-01");
    assert.equal(persisted!.protocol.task_id, "TASK-20260712-003");
    assert.equal(persisted!.runtime_trigger_chat_id, "CHAT-1783845104910");
    assert.equal(persisted!.runtime_thread_key, "panel-task-001");
    assert.equal(persisted!.protocol.runs.length, 1);
    assert.equal(persisted!.protocol.runs[0]!.status, "running");

    // runtime.session_started was the FIRST event the listener saw.
    assert.ok(events.length >= 1);
    assert.equal(events[0]!.event_type, "runtime.session_started");
    assert.equal(events[0]!.session_id, handle.session_id);
    const startedPayload = events[0]!.payload as Record<string, unknown>;
    assert.equal(startedPayload.task_id, "TASK-20260712-003");
    assert.equal(startedPayload.trigger_chat_id, "CHAT-1783845104910");
    assert.equal(startedPayload.thread_key, "panel-task-001");

    // Settle the in-mem run so the natural-settle path persists status=completed.
    // The default InMemoryRunHandle auto-settles on setImmediate after construction;
    // we await the manager's settlement chain to deterministically observe end state.
    await manager.awaitSettled(handle.session_id);

    const after = await sessionStore.load(handle.session_id);
    assert.equal(after!.protocol.status, "completed");

    // session_ended fired too.
    const types = events.map((e) => e.event_type);
    assert.ok(
      types.includes("runtime.session_ended"),
      `expected runtime.session_ended in events; got: ${types.join(", ")}`,
    );
  });
});

test("startSession: agent_not_found rebuilds once and retries the original payload", async () => {
  await withManager(async ({ manager, registry, sdk }) => {
    const original = await registry.register(validAgentSpec());
    const oldId = original.protocol.sdk_agent_id!;
    sdk.forgetKnown(oldId);

    const handle = await manager.startSession("DEV-01", "TASK-recover", {
      text: "preserve this task payload",
    });
    const recovered = await registry.get("DEV-01");

    assert.notEqual(recovered?.protocol.sdk_agent_id, oldId);
    assert.equal(sdk.calls.send.length, 2);
    assert.equal(sdk.calls.send[0]?.spec.text, "preserve this task payload");
    assert.equal(sdk.calls.send[1]?.spec.text, "preserve this task payload");
    assert.equal(handle.task_id, "TASK-recover");
    await manager.awaitSettled(handle.session_id);
  });
});

test("TS-4.2b: startSession 透传 pinnedTaskId / taskFilepath 到 AgentSendSpec", async () => {
  await withManager(async ({ manager, registry, sdk }) => {
    await registry.register(validAgentSpec());

    const pinned = "TASK-20260607-029";
    const taskFilepath =
      "fcop/_lifecycle/active/TASK-20260607-029-ADMIN-to-PM.md";

    const handle = await manager.startSession("DEV-01", pinned, {
      text: "你是 PM，完成 Hot Path。",
      context: {
        task_filepath: taskFilepath,
        task_filename: "TASK-20260607-029-ADMIN-to-PM.md",
        frontmatter: { task_id: pinned },
      },
    });

    assert.equal(sdk.calls.send.length, 1);
    const spec = sdk.calls.send[0]!.spec;
    assert.equal(spec.pinnedTaskId, pinned);
    assert.equal(spec.taskFilepath, taskFilepath);
    assert.equal(spec.frontmatterTaskId, pinned);

    await manager.awaitSettled(handle.session_id);
  });
});

test("TS-4.2c: pm_self_report_only context 透传 runMode + pinnedTaskId", async () => {
  await withManager(async ({ manager, registry, sdk }) => {
    await registry.register(validAgentSpec());

    const pinned = "TASK-20260607-029";
    const taskFilepath =
      "fcop/_lifecycle/active/TASK-20260607-029-ADMIN-to-PM.md";

    const handle = await manager.startSession("DEV-01", pinned, {
      text: "你是 PM，pm_self_report_only 模式。",
      context: {
        task_filepath: taskFilepath,
        task_filename: "TASK-20260607-029-ADMIN-to-PM.md",
        pinned_task_id: pinned,
        pm_self_report_only: true,
        frontmatter: { task_id: pinned },
      },
    });

    assert.equal(sdk.calls.send.length, 1);
    const spec = sdk.calls.send[0]!.spec;
    assert.equal(spec.pinnedTaskId, pinned);
    assert.equal(spec.runMode, "pm_self_report_only");

    await manager.awaitSettled(handle.session_id);
  });
});

// ── TS-4.3 ──────────────────────────────────────────────────────────

test("TS-4.3: high-volume planted events drain without loss (throughput sanity)", async () => {
  await withManager(async ({ manager, registry, sdk }) => {
    await registry.register(validAgentSpec());

    // Plant a custom RunHandle factory that emits 200 events. We don't
    // run the spec's nominal 1000/s against a real SDK in unit tests;
    // 200 is plenty to expose any "drop on backpressure" or unsubscribe
    // bugs in the manager's fan-out path.
    const PLANTED_COUNT = 200;
    sdk.sendHandleFactory = (spec, _sdkAgentId) => {
      const events: RuntimeEvent[] = [];
      for (let i = 0; i < PLANTED_COUNT; i++) {
        const t: RuntimeEventType =
          i % 4 === 0
            ? "sdk.assistant"
            : i % 4 === 1
              ? "sdk.tool_call"
              : i % 4 === 2
                ? "sdk.thinking"
                : "sdk.status";
        events.push({
          event_id: `e-${i}`,
          at: new Date().toISOString(),
          event_type: t,
          session_id: spec.sessionId,
          run_id: "run-stress",
          agent_id: spec.agentId,
          payload: { i },
        });
      }
      return new InMemoryRunHandle({
        sessionId: spec.sessionId,
        agentId: spec.agentId,
        runId: "run-stress",
        emitEvents: events,
      });
    };

    let received = 0;
    manager.onEvent((e) => {
      if (e.event_type !== "runtime.session_started" &&
          e.event_type !== "runtime.session_ended") {
        received++;
      }
    });

    const handle = await manager.startSession("DEV-01", "TASK-stress", {
      text: "stress",
    });
    await manager.awaitSettled(handle.session_id);

    assert.equal(
      received,
      PLANTED_COUNT,
      `expected exactly ${PLANTED_COUNT} sdk events; got ${received}`,
    );
  });
});

// ── TS-4.4 ──────────────────────────────────────────────────────────

test("TS-4.4: cancelSession orders SDK-cancel before persist + emits runtime.session_cancelled", async () => {
  await withManager(async ({ manager, registry, sessionStore, sdk }) => {
    await registry.register(validAgentSpec());

    const events: RuntimeEvent[] = [];
    manager.onEvent((e) => events.push(e));

    // Plant a manual-settle handle so the run stays "running" until cancel.
    sdk.sendHandleFactory = (spec) =>
      new InMemoryRunHandle({
        sessionId: spec.sessionId,
        agentId: spec.agentId,
        runId: "run-cancel",
        manualSettle: true,
      });
    const handle = await manager.startSession("DEV-01", "TASK-cancel", {
      text: "go",
    });
    const run = handle.activeRun! as InMemoryRunHandle;

    // Hook to record the relative order: did cancel happen on the run
    // before the store wrote status=cancelled? The InMemoryRunHandle
    // synchronously flips its `_cancelled` flag on `.cancel()`, so we
    // peek at the store snapshot from inside a probe.
    let storeWroteCancelledAt: number | null = null;
    const originalSave = sessionStore.save.bind(sessionStore);
    sessionStore.save = async (rec: SessionRecord) => {
      if (rec.protocol.status === "cancelled") {
        storeWroteCancelledAt = Date.now();
      }
      return originalSave(rec);
    };

    let runCancelledAt: number | null = null;
    const originalCancel = run.cancel.bind(run);
    run.cancel = async (reason: string) => {
      runCancelledAt = Date.now();
      // Tiny delay so the ordering check is robust on fast machines.
      await new Promise((r) => setImmediate(r));
      return originalCancel(reason);
    };

    await manager.cancelSession(handle.session_id, "user_request");

    assert.ok(runCancelledAt !== null, "SDK cancel must fire");
    assert.ok(storeWroteCancelledAt !== null, "store write must fire");
    assert.ok(
      runCancelledAt! <= storeWroteCancelledAt!,
      `SDK cancel (${runCancelledAt}) must precede store cancel-persist (${storeWroteCancelledAt})`,
    );

    // Persisted record reflects cancelled.
    const persisted = await sessionStore.load(handle.session_id);
    assert.equal(persisted!.protocol.status, "cancelled");
    assert.equal(
      persisted!.protocol.runs[persisted!.protocol.runs.length - 1]!.status,
      "cancelled",
    );

    // runtime.session_cancelled was emitted.
    const cancelEvent = events.find(
      (e) => e.event_type === "runtime.session_cancelled",
    );
    assert.ok(cancelEvent);
    assert.equal((cancelEvent!.payload as { reason: string }).reason, "user_request");

    // Idempotency: second cancel = no-op, must not throw.
    await manager.cancelSession(handle.session_id, "user_request_second_attempt");
  });
});

test("TS-4.4b: cancelSession on unknown id → SessionNotFoundError", async () => {
  await withManager(async ({ manager }) => {
    await assert.rejects(
      () => manager.cancelSession("session-ghost", "x"),
      SessionNotFoundError,
    );
  });
});

// ── TS-4.5 ──────────────────────────────────────────────────────────

test("TS-4.5: cancelAllForEmergencyStop uses Promise.allSettled (one failure does not block peers)", async () => {
  await withManager(async ({ manager, registry, sdk }) => {
    await registry.register(validAgentSpec({ agent_id: "DEV-01" }));
    await registry.register(
      validAgentSpec({ agent_id: "DEV-02", workspace: undefined }),
    );

    // Plant manual-settle handles so both sessions stay in `running`
    // until cancelAllForEmergencyStop fires.
    let runSeq = 0;
    sdk.sendHandleFactory = (spec) =>
      new InMemoryRunHandle({
        sessionId: spec.sessionId,
        agentId: spec.agentId,
        runId: `run-em-${++runSeq}`,
        manualSettle: true,
      });

    // Two long-running sessions.
    const h1 = await manager.startSession("DEV-01", "TASK-em-1", { text: "a" });
    const h2 = await manager.startSession("DEV-02", "TASK-em-2", { text: "b" });
    void h2;

    // Plant a cancel-failure for the first session's RunHandle.
    const r1 = h1.activeRun! as InMemoryRunHandle;
    r1.cancel = async () => {
      throw new Error("simulated cancel-failure on r1");
    };

    const result = await manager.cancelAllForEmergencyStop();

    // The peer that succeeded must be in `cancelled`; the failing one in
    // `failed_to_cancel`. Crucially: BOTH paths ran (allSettled, not all).
    assert.equal(result.cancelled.length + result.failed_to_cancel.length, 2);
    assert.ok(
      result.cancelled.length >= 1,
      "at least one peer must cancel cleanly",
    );
    assert.ok(
      result.failed_to_cancel.length >= 1,
      "the planted-fail session must surface in failed_to_cancel",
    );
    void sdk;
  });
});

// ── extras ──────────────────────────────────────────────────────────

test("onEvent: throwing listener gets unsubscribed; peers keep receiving", async () => {
  await withManager(async ({ manager, registry, sdk }) => {
    await registry.register(validAgentSpec());

    let goodCount = 0;
    let badCount = 0;
    manager.onEvent(() => {
      badCount++;
      throw new Error("listener bug");
    });
    manager.onEvent(() => {
      goodCount++;
    });

    sdk.sendHandleFactory = (spec) =>
      new InMemoryRunHandle({
        sessionId: spec.sessionId,
        agentId: spec.agentId,
        runId: "run-throw",
        manualSettle: true,
      });

    // Suppress the expected console.error from the throwing listener so
    // node:test reports stay clean.
    const originalError = console.error;
    console.error = () => {};
    try {
      const handle = await manager.startSession("DEV-01", "TASK-x", { text: "x" });
      const run = handle.activeRun! as InMemoryRunHandle;
      run.settle({ status: "finished" });
      await manager.awaitSettled(handle.session_id);
    } finally {
      console.error = originalError;
    }

    // The good listener received at least session_started + session_ended.
    assert.ok(goodCount >= 2, `good listener must keep firing; got ${goodCount}`);
    // The bad listener fired ONCE (then got unsubbed) — exactly 1.
    assert.equal(
      badCount,
      1,
      `bad listener should fire exactly once before unsubscribe; got ${badCount}`,
    );
  });
});

test("session_ended includes completed-with-report when REPORT on disk", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { taskMarkdown } = await import("../../lifecycle/__tests__/helpers.ts");

  await withTempSessionDir(async ({ sessionStore, transcriptWriter, agentStore, rootDir }) => {
    const reportsDir = join(rootDir, "fcop", "reports");
    await mkdir(reportsDir, { recursive: true });
    await writeFile(
      join(reportsDir, "REPORT-20260531-001-DEV-to-PM.md"),
      taskMarkdown(
        {
          protocol: "fcop",
          version: 1,
          kind: "report",
          sender: "DEV",
          recipient: "PM",
          task_id: "TASK-x",
          status: "done",
        },
        "## done\n",
      ),
      "utf-8",
    );

    const sdk = new InMemorySdkAdapter();
    const registry = new AgentRegistry({ store: agentStore, sdk });
    const manager = new SessionManager({
      registry,
      sdk,
      sessionStore,
      transcriptWriter,
      projectRoot: rootDir,
    });

    await registry.register(validAgentSpec());

    let endedPayload: Record<string, unknown> | null = null;
    manager.onEvent((ev) => {
      if (ev.event_type === "runtime.session_ended") {
        endedPayload = ev.payload as Record<string, unknown>;
      }
    });

    const originalError = console.error;
    console.error = () => {};
    try {
      const handle = await manager.startSession("DEV-01", "TASK-x", { text: "x" });
      const run = handle.activeRun! as InMemoryRunHandle;
      run.settle({ status: "cancelled" });
      await manager.awaitSettled(handle.session_id);
    } finally {
      console.error = originalError;
    }

    assert.ok(endedPayload, "expected runtime.session_ended");
    const payload = endedPayload as unknown as Record<string, unknown>;
    assert.equal(payload.settlement_reason, "completed-with-report");
    assert.equal(payload.report_on_disk, true);
    assert.equal(payload.status, "completed");
  });
});

test("sdk_error takes precedence over an existing REPORT and marks session failed", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { taskMarkdown } = await import("../../lifecycle/__tests__/helpers.ts");

  await withTempSessionDir(async ({ sessionStore, transcriptWriter, agentStore, rootDir }) => {
    const reportsDir = join(rootDir, "fcop", "reports");
    await mkdir(reportsDir, { recursive: true });
    await writeFile(
      join(reportsDir, "REPORT-20260715-006-DEV-to-PM.md"),
      taskMarkdown(
        {
          protocol: "fcop",
          version: 1,
          kind: "report",
          sender: "DEV",
          recipient: "PM",
          task_id: "TASK-sdk-error",
          status: "done",
        },
        "## stale report\n",
      ),
      "utf-8",
    );

    const sdk = new InMemorySdkAdapter();
    sdk.sendHandleFactory = (spec) =>
      new InMemoryRunHandle({
        sessionId: spec.sessionId,
        agentId: spec.agentId,
        runId: "run-sdk-error",
        manualSettle: true,
      });
    const registry = new AgentRegistry({ store: agentStore, sdk });
    const manager = new SessionManager({
      registry,
      sdk,
      sessionStore,
      transcriptWriter,
      projectRoot: rootDir,
    });
    await registry.register(validAgentSpec());

    let endedPayload: Record<string, unknown> | null = null;
    manager.onEvent((event) => {
      if (event.event_type === "runtime.session_ended") {
        endedPayload = event.payload as Record<string, unknown>;
      }
    });
    const handle = await manager.startSession("DEV-01", "TASK-sdk-error", { text: "read only" });
    (handle.activeRun as InMemoryRunHandle).settle({
      status: "failed",
      sdkError: "governance_storage_boundary_violation",
      failureCode: "OPERATION_BOUNDARY_DENIED",
    });
    await manager.awaitSettled(handle.session_id);

    const persisted = await sessionStore.load(handle.session_id);
    assert.equal(persisted?.protocol.status, "failed");
    assert.ok(endedPayload);
    assert.equal((endedPayload as Record<string, unknown>)["status"], "failed");
    assert.equal((endedPayload as Record<string, unknown>)["settlement_reason"], "failed");
    assert.equal((endedPayload as Record<string, unknown>)["report_on_disk"], true);
  });
});

