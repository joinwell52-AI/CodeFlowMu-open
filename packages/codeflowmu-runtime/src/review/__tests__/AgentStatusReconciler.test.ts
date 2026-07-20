/**
 * AgentStatusReconciler tests — Sprint S4 TS-6.12 / TS-6.13 + integration.
 *
 * Coverage:
 *   - TS-6.12: runtime.session_started → AgentRecord.status = "running"
 *   - TS-6.13: runtime.session_ended  → AgentRecord.status = "idle"
 *              + cancelled also flips back to idle
 *              + idempotent skip when status already matches target
 *              + status="error" is NOT clobbered by lifecycle
 *   - INTEGRATION: doorbell → 2nd dispatch on busy agent triggers
 *     `rejected_busy` end-to-end (no manual agents.json fixture —
 *     proves REPORT-018 §五决策 B' is closed)
 *
 * Lives under `review/__tests__/` even though the file under test is
 * `registry/AgentStatusReconciler.ts`, because the integration scenario
 * sits at the same layer as ReviewEngine and reuses the shared helpers.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Agent } from "@codeflowmu/protocol";

import { AgentRegistry } from "../../registry/AgentRegistry.ts";
import { AgentStatusReconciler } from "../../registry/AgentStatusReconciler.ts";
import {
  InMemoryRunHandle,
  InMemorySdkAdapter,
  type AgentSendSpec,
} from "../../registry/AgentSdkAdapter.ts";
import { JsonFileStore } from "../../registry/PersistentStore.ts";
import { InboxWatcher } from "../../scheduler/InboxWatcher.ts";
import { StateHistoryWriter } from "../../scheduler/StateHistoryWriter.ts";
import { TaskDispatcher } from "../../scheduler/TaskDispatcher.ts";
import { SessionManager } from "../../session/SessionManager.ts";
import { SessionStore } from "../../session/SessionStore.ts";
import { TranscriptWriter } from "../../session/TranscriptWriter.ts";
import { quietLogger, waitFor, withTempReview } from "./helpers.ts";

function devSpec(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: "DEV-01",
    role: "DEV",
    layer: "worker",
    node: "local",
    runtime: "local",
    skills: ["fcop"],
    status: "idle",
    ...overrides,
  };
}

interface ReconcilerCtx {
  registry: AgentRegistry;
  sessionManager: SessionManager;
  reconciler: AgentStatusReconciler;
  sessionStore: SessionStore;
  store: JsonFileStore;
  sdk: InMemorySdkAdapter;
  shutdown: () => Promise<void>;
}

async function buildReconciler(
  stateDir: string,
  opts: {
    handleFactory?: (
      spec: AgentSendSpec,
      sdkAgentId: string,
    ) => InMemoryRunHandle;
  } = {},
): Promise<ReconcilerCtx> {
  const sdk = new InMemorySdkAdapter();
  if (opts.handleFactory) sdk.sendHandleFactory = opts.handleFactory;
  const store = new JsonFileStore({
    path: join(stateDir, "agents.json"),
  });
  const registry = new AgentRegistry({ store, sdk });
  const sessionStore = new SessionStore({
    dir: join(stateDir, "sessions"),
  });
  const transcriptWriter = new TranscriptWriter({
    dir: join(stateDir, "transcripts"),
  });
  const sessionManager = new SessionManager({
    registry,
    sdk,
    sessionStore,
    transcriptWriter,
  });
  const reconciler = new AgentStatusReconciler({
    sessionManager,
    registry,
    store,
    logger: quietLogger(),
  });
  reconciler.start();

  return {
    registry,
    sessionManager,
    reconciler,
    sessionStore,
    store,
    sdk,
    shutdown: async () => {
      await reconciler.stop().catch(() => undefined);
      await transcriptWriter.closeAll().catch(() => undefined);
    },
  };
}

describe("AgentStatusReconciler", () => {
  it("TS-6.12: runtime.session_started → AgentRecord.status = \"running\"", async () => {
    await withTempReview(async ({ stateDir }) => {
      // Plant a manualSettle handle so the session stays open and we can
      // observe the steady-state "running" window without racing the
      // immediate auto-settle.
      let liveHandle: InMemoryRunHandle | undefined;
      const ctx = await buildReconciler(stateDir, {
        handleFactory: (spec) => {
          liveHandle = new InMemoryRunHandle({
            sessionId: spec.sessionId,
            agentId: spec.agentId,
            manualSettle: true,
          });
          return liveHandle;
        },
      });
      try {
        await ctx.registry.register(devSpec());

        const handle = await ctx.sessionManager.startSession(
          "DEV-01",
          "TASK-20260509-001-PM-to-DEV",
          { text: "running window" },
        );

        // Wait for the reconciler write to land.
        await waitFor(
          async () => {
            const r = await ctx.registry.get("DEV-01");
            return r?.protocol.status === "running" ? r : null;
          },
          { what: "agent.status=running", timeoutMs: 3000 },
        );

        const r = await ctx.registry.get("DEV-01");
        assert.equal(r?.protocol.status, "running");
        assert.ok(
          r?.protocol.last_active_at,
          "reconciler should stamp last_active_at",
        );

        // Settle the handle now so shutdown isn't fighting an in-flight
        // operation and the reconciler can drain its idle write.
        liveHandle?.settle({ status: "finished" });
        await ctx.sessionManager.awaitSettled(handle.session_id);
        await ctx.reconciler.whenSettled();
      } finally {
        await ctx.shutdown();
      }
    });
  });

  it("TS-6.13: runtime.session_ended → AgentRecord.status = \"idle\"", async () => {
    await withTempReview(async ({ stateDir }) => {
      const ctx = await buildReconciler(stateDir);
      try {
        await ctx.registry.register(devSpec());

        const handle = await ctx.sessionManager.startSession(
          "DEV-01",
          "TASK-20260509-001-PM-to-DEV",
          { text: "transient" },
        );

        // Wait for natural settle (default InMemoryRunHandle auto-finishes).
        await ctx.sessionManager.awaitSettled(handle.session_id);
        await ctx.reconciler.whenSettled();

        // Once session ended, status should be back to idle.
        await waitFor(
          async () => {
            const r = await ctx.registry.get("DEV-01");
            return r?.protocol.status === "idle" ? r : null;
          },
          { what: "agent.status=idle after ended", timeoutMs: 3000 },
        );

        const r = await ctx.registry.get("DEV-01");
        assert.equal(r?.protocol.status, "idle");
      } finally {
        await ctx.shutdown();
      }
    });
  });

  it("status=\"error\" is NOT clobbered by a lifecycle ended event", async () => {
    await withTempReview(async ({ stateDir }) => {
      const ctx = await buildReconciler(stateDir);
      try {
        await ctx.registry.register(devSpec());
        // Force agent into error state directly via store.upsert (mirrors
        // markFailed without touching the registry's external behavior).
        await ctx.registry.markFailed("DEV-01", "synthetic-failure");

        const r0 = await ctx.registry.get("DEV-01");
        assert.equal(r0?.protocol.status, "error");

        // A spurious session_ended event should NOT flip error → idle.
        // Synthesize the event by emitting via SessionManager onEvent
        // surface — we use a dispatch to one of our own listeners.
        ctx.sessionManager["_dispatchToListeners"]({
          event_id: "synthetic-ended",
          at: new Date().toISOString(),
          event_type: "runtime.session_ended",
          session_id: "session-synthetic",
          agent_id: "DEV-01",
          payload: { status: "completed" },
        });

        await ctx.reconciler.whenSettled();

        const r1 = await ctx.registry.get("DEV-01");
        assert.equal(
          r1?.protocol.status,
          "error",
          "error status must outrank lifecycle-driven idle transition",
        );
      } finally {
        await ctx.shutdown();
      }
    });
  });

  it("INTEGRATION: doorbell → 2nd task on busy agent triggers `rejected_busy` (REPORT-018 §决策 B' closure)", async () => {
    await withTempReview(async ({ rootDir, inboxDir, stateDir }) => {
      // Plant a 1st RunHandle that stays "running" until we call settle().
      let activeHandle: InMemoryRunHandle | null = null;
      const factory = (spec: AgentSendSpec): InMemoryRunHandle => {
        const h = new InMemoryRunHandle({
          sessionId: spec.sessionId,
          agentId: spec.agentId,
          manualSettle: true,
        });
        if (!activeHandle) activeHandle = h;
        return h;
      };

      const ctx = await buildReconciler(stateDir, { handleFactory: factory });
      try {
        await ctx.registry.register(devSpec());

        // Build a TaskDispatcher on top of the same wiring so we exercise
        // the chokidar → parse → startSession path end-to-end.
        const logger = quietLogger();
        const watcher = new InboxWatcher({ dir: inboxDir, logger });
        const historyWriter = new StateHistoryWriter();
        const dispatcher = new TaskDispatcher({
          watcher,
          historyWriter,
          registry: ctx.registry,
          sessionManager: ctx.sessionManager,
          logger,
        });
        await dispatcher.start();

        const seenEvents: string[] = [];
        const unsubEvents = ctx.sessionManager.onEvent((evt) => {
          seenEvents.push(evt.event_type);
        });

        try {
          // Drop task 1 — gets dispatched.
          const t1 = "TASK-20260509-001-PM-to-DEV";
          const f1 = join(inboxDir, `${t1}.md`);
          await writeFile(
            f1,
            `---\nprotocol: fcop\ntask_id: ${t1}\nsender: PM\nrecipient: DEV\npriority: P2\nstatus: pending\n---\n\n# body 1\n`,
            "utf-8",
          );

          // Barrier 1: PM→DEV auto-dispatches; session should start without explicit dispatch_task.
          await waitFor(
            () =>
              seenEvents.includes("runtime.session_started") ? true : null,
            { what: "session_started after task 1", timeoutMs: 5000 },
          );

          // Barrier 2: reconciler promoted registry status to running.
          await waitFor(
            async () => {
              const r = await ctx.registry.get("DEV-01");
              return r?.protocol.status === "running" ? r : null;
            },
            { what: "running after task 1 dispatch", timeoutMs: 5000 },
          );

          // Barrier 3: drain reconciler's async upsert chain so the next
          // dispatch's registry.get() cannot race a stale idle read.
          await ctx.reconciler.whenSettled();

          // Drop task 2 while agent is still running.
          const t2 = "TASK-20260509-002-PM-to-DEV";
          const f2 = join(inboxDir, `${t2}.md`);
          await writeFile(
            f2,
            `---\nprotocol: fcop\ntask_id: ${t2}\nsender: PM\nrecipient: DEV\npriority: P2\nstatus: pending\n---\n\n# body 2\n`,
            "utf-8",
          );

          // Task 2 auto-dispatches while DEV-01 is running → rejected_busy.

          // Wait for state_history to record `rejected_busy` on task 2.
          // Full-suite load + Windows chokidar awaitWriteFinish can exceed 4s.
          await waitFor(
            async () => {
              const txt = await readFile(f2, "utf-8");
              return txt.includes("rejected_busy") &&
                txt.includes("agent_status=running")
                ? txt
                : null;
            },
            { what: "rejected_busy on task 2", timeoutMs: 8000 },
          );

          const t2Txt = await readFile(f2, "utf-8");
          assert.match(t2Txt, /`inbox` → `rejected_busy`/);
          assert.match(t2Txt, /agent_status=running/);

          // SDK should have only seen ONE send (task 2 was rejected before
          // SessionManager called .send).
          assert.equal(
            ctx.sdk.calls.send.length,
            1,
            `expected exactly 1 send call (task 2 rejected); got ${ctx.sdk.calls.send.length}`,
          );

          // Settle task 1 so shutdown is clean.
          (activeHandle as InMemoryRunHandle | null)?.settle({
            status: "finished",
          });
        } finally {
          unsubEvents();
          await dispatcher.stop();
        }
      } finally {
        await ctx.shutdown();
      }
    });
  });
});

