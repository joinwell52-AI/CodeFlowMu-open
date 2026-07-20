/**
 * TaskDispatcher tests — Phase C TS-5.10 / TS-5.11 / TS-5.12 + reject_busy.
 *
 * Scope (full pipeline integration with real chokidar + real SessionManager
 * + InMemorySdkAdapter):
 *   - TS-5.10: drop a TASK file → state_history contains `inbox → dispatched`
 *   - TS-5.11: recipient role has no registered agent → `agent_not_found`
 *   - TS-5.12: after session settles → `dispatched → ended` is appended
 *   - TS-5.13 (validation 5): second task while agent busy → `rejected_busy`
 */

import { mkdir, readFile, rename, writeFile, access } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  agentTaskQueuePath,
  loadAgentTaskQueue,
} from "../../pm/agentTaskQueue.ts";

import {
  InMemoryRunHandle,
  InMemorySdkAdapter,
} from "../../registry/AgentSdkAdapter.ts";
import { AgentRegistry } from "../../registry/AgentRegistry.ts";
import { JsonFileStore } from "../../registry/PersistentStore.ts";
import { SessionManager } from "../../session/SessionManager.ts";
import { SessionStore } from "../../session/SessionStore.ts";
import { TranscriptWriter } from "../../session/TranscriptWriter.ts";
import type { RuntimeEvent } from "../../types/state.ts";
import { InboxWatcher } from "../InboxWatcher.ts";
import { LifecycleGovernor } from "../LifecycleGovernor.ts";
import { PmQueueGuard } from "../PmQueueGuard.ts";
import { StateHistoryWriter } from "../StateHistoryWriter.ts";
import { TaskDispatcher } from "../TaskDispatcher.ts";
import type { ParsedTask } from "../TaskParser.ts";
import { DispatchRetryRegistry } from "../../_internal/DispatchRetryRegistry.ts";

import { quietLogger, sleep, waitFor, withTempScheduler } from "./helpers.ts";

import type { Agent } from "@codeflowmu/protocol";

const TASK_BODY = (taskId: string, recipient: string): string => `---
protocol: fcop
task_id: ${taskId}
sender: PM
recipient: ${recipient}
priority: P2
status: pending
---

# Body of ${taskId}
`;

/** Wait for inbox watcher to auto-dispatch trusted internal tasks. */
async function waitForInboxAutoDispatch(filepath: string): Promise<void> {
  await sleep(300);
  await waitFor(
    async () => {
      try {
        const text = await readFile(filepath, "utf-8");
        if (
          text.includes("`inbox` → `dispatched`") ||
          text.includes("`inbox` → `retry_waiting`") ||
          text.includes("`inbox` → `active`") ||
          text.includes("agent_not_found") ||
          text.includes("rejected_busy") ||
          text.includes("reason=untrusted_source")
        ) {
          return true;
        }
      } catch {
        // file may not exist yet
      }
      return null;
    },
    { what: "inbox auto-dispatch", timeoutMs: 5000 },
  );
}

function frontmatterState(raw: string): string | undefined {
  return raw.match(/^state:\s*(\S+)/m)?.[1];
}

function makeAgentSpec(overrides: Partial<Agent> = {}): Agent {
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

interface Pipeline {
  watcher: InboxWatcher;
  dispatcher: TaskDispatcher;
  registry: AgentRegistry;
  sessionManager: SessionManager;
  sdk: InMemorySdkAdapter;
  logger: ReturnType<typeof quietLogger>;
  /** Capture of every RuntimeEvent the SessionManager fans out. */
  events: RuntimeEvent[];
  shutdown: () => Promise<void>;
}

async function buildPipeline(opts: {
  inboxDir: string;
  stateDir: string;
  projectRoot?: string;
  parser?: { parse: (filepath: string) => Promise<ParsedTask> };
  lifecycleGovernor?: LifecycleGovernor;
  dispatchRetryRegistry?: DispatchRetryRegistry;
  pmQueueGuard?: PmQueueGuard;
}): Promise<Pipeline> {
  const sdk = new InMemorySdkAdapter();
  const agentStore = new JsonFileStore({
    path: join(opts.stateDir, "agents.json"),
  });
  const registry = new AgentRegistry({ store: agentStore, sdk });
  const sessionStore = new SessionStore({
    dir: join(opts.stateDir, "sessions"),
  });
  const transcriptWriter = new TranscriptWriter({
    dir: join(opts.stateDir, "transcripts"),
  });
  const sessionManager = new SessionManager({
    registry,
    sdk,
    sessionStore,
    transcriptWriter,
  });
  const logger = quietLogger();
  const watcher = new InboxWatcher({ dir: opts.inboxDir, logger });
  const historyWriter = new StateHistoryWriter();
  const dispatchRetryRegistry =
    opts.dispatchRetryRegistry ??
    new DispatchRetryRegistry({
      backoffRangesMs: [[0, 0], [0, 0], [0, 0]],
      randomInt: () => 0,
    });
  const dispatcher = new TaskDispatcher({
    watcher,
    historyWriter,
    registry,
    sessionManager,
    logger,
    dispatchRetryRegistry,
    ...(opts.lifecycleGovernor ? { lifecycleGovernor: opts.lifecycleGovernor } : {}),
    ...(opts.pmQueueGuard ? { pmQueueGuard: opts.pmQueueGuard } : {}),
    ...(opts.projectRoot ? { projectRoot: opts.projectRoot } : {}),
    ...(opts.parser ? { parser: opts.parser } : {}),
  });

  const events: RuntimeEvent[] = [];
  sessionManager.onEvent((evt) => events.push(evt));

  return {
    watcher,
    dispatcher,
    registry,
    sessionManager,
    sdk,
    logger,
    events,
    shutdown: async () => {
      await dispatcher.stop().catch(() => undefined);
      await transcriptWriter.closeAll().catch(() => undefined);
    },
  };
}

describe("TaskDispatcher", () => {
  it("does not dispatch a staged task", async () => {
    await withTempScheduler(async ({ rootDir, inboxDir, stateDir }) => {
      const pipeline = await buildPipeline({
        inboxDir,
        stateDir,
        projectRoot: rootDir,
      });
      try {
        await pipeline.registry.register(
          makeAgentSpec({ agent_id: "OPS-01", role: "OPS" }),
        );
        const taskId = "TASK-20260614-101-PM-to-OPS";
        const filepath = join(inboxDir, `${taskId}.md`);
        const content = TASK_BODY(taskId, "OPS").replace(
          "status: pending",
          "status: pending\nstate: staged",
        );
        await writeFile(filepath, content);

        const outcome = await pipeline.dispatcher.dispatchTaskFromControlPlane(
          filepath,
          `${taskId}.md`,
          "OPS",
        );

        assert.equal(outcome.kind, "dependency_pending");
        assert.equal(pipeline.events.length, 0);
        assert.equal(pipeline.dispatcher.getAdhocQueue().length, 0);
        assert.equal(await readFile(filepath, "utf-8"), content);
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("does not dispatch when depends_on has no done report", async () => {
    await withTempScheduler(async ({ rootDir, inboxDir, stateDir }) => {
      const pipeline = await buildPipeline({
        inboxDir,
        stateDir,
        projectRoot: rootDir,
      });
      try {
        await pipeline.registry.register(
          makeAgentSpec({ agent_id: "OPS-01", role: "OPS" }),
        );
        const taskId = "TASK-20260614-102-PM-to-OPS";
        const dependencyId = "TASK-20260614-005";
        const filepath = join(inboxDir, `${taskId}.md`);
        const content = TASK_BODY(taskId, "OPS").replace(
          "status: pending",
          `status: pending\nstate: inbox\ndepends_on:\n  - ${dependencyId}`,
        );
        await writeFile(filepath, content);

        const outcome = await pipeline.dispatcher.dispatchTaskFromControlPlane(
          filepath,
          `${taskId}.md`,
          "OPS",
        );

        assert.deepEqual(outcome, {
          kind: "dependency_pending",
          reason: `waiting for done report: ${dependencyId}`,
          dependency_task_ids: [dependencyId],
        });
        assert.equal(pipeline.events.length, 0);
        assert.equal(pipeline.dispatcher.getAdhocQueue().length, 0);
        assert.equal(await readFile(filepath, "utf-8"), content);
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("dispatches after every depends_on task has a done report", async () => {
    await withTempScheduler(async ({ rootDir, inboxDir, stateDir }) => {
      const reportsDir = join(rootDir, "fcop", "reports");
      await mkdir(reportsDir, { recursive: true });
      const dependencyId = "TASK-20260614-005";
      await writeFile(
        join(reportsDir, "REPORT-20260614-105-DEV-to-PM.md"),
        `---\ntask_id: ${dependencyId}\nstatus: done\nsender: DEV\nrecipient: PM\n---\n`,
      );

      const pipeline = await buildPipeline({
        inboxDir,
        stateDir,
        projectRoot: rootDir,
      });
      try {
        await pipeline.registry.register(
          makeAgentSpec({ agent_id: "OPS-01", role: "OPS" }),
        );
        const taskId = "TASK-20260614-103-PM-to-OPS";
        const filepath = join(inboxDir, `${taskId}.md`);
        await writeFile(
          filepath,
          TASK_BODY(taskId, "OPS").replace(
            "status: pending",
            `status: pending\nstate: inbox\ndepends_on:\n  - ${dependencyId}`,
          ),
        );

        const outcome = await pipeline.dispatcher.dispatchTaskFromControlPlane(
          filepath,
          `${taskId}.md`,
          "OPS",
        );

        assert.equal(outcome.kind, "dispatched");
        assert.equal(
          pipeline.events.filter(
            (event) => event.event_type === "runtime.session_started",
          ).length,
          1,
        );
        assert.equal(
          frontmatterState(await readFile(filepath, "utf-8")),
          "dispatched",
        );
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("deduplicates ADHOC queue entries by filepath and keeps highest priority", async () => {
    await withTempScheduler(async ({ inboxDir, stateDir }) => {
        const pipeline = await buildPipeline({ inboxDir, stateDir });
      try {
        const filepath = join(inboxDir, "TASK-20260509-000-PM-to-DEV.md");
        await writeFile(
          filepath,
          TASK_BODY("TASK-20260509-000-PM-to-DEV", "DEV").replace(
            "status: pending",
            "status: pending\nstate: inbox",
          ),
        );
        pipeline.dispatcher.enqueueAdhoc({
          filepath,
          filename: "TASK-20260509-000-PM-to-DEV.md",
          recipient: "DEV",
          priority: "P2",
          enqueuedAt: "2026-05-31T00:00:00.000Z",
        });
        pipeline.dispatcher.enqueueAdhoc({
          filepath: filepath.replace(/\\/g, "/").toUpperCase(),
          filename: "TASK-20260509-000-PM-to-DEV.md",
          recipient: "DEV",
          priority: "P0",
          enqueuedAt: "2026-05-31T00:01:00.000Z",
        });

        const queue = pipeline.dispatcher.getAdhocQueue();
        assert.equal(queue.length, 1);
        assert.equal(queue[0]!.filepath, filepath.replace(/\\/g, "/").toUpperCase());
        assert.equal(queue[0]!.priority, "P0");
        assert.equal(queue[0]!.enqueuedAt, "2026-05-31T00:00:00.000Z");
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("filters archived ADHOC items before reporting queue position", async () => {
    await withTempScheduler(async ({ rootDir, inboxDir, stateDir }) => {
      const pipeline = await buildPipeline({ inboxDir, stateDir });
      try {
        const filename = "TASK-20260612-010-ADMIN-to-PM.md";
        const filepath = join(inboxDir, filename);
        await writeFile(
          filepath,
          TASK_BODY(filename.replace(/\.md$/, ""), "PM").replace(
            "status: pending",
            "status: pending\nstate: inbox",
          ),
        );
        pipeline.dispatcher.enqueueAdhoc({
          filepath,
          filename,
          recipient: "PM",
          priority: "P2",
          enqueuedAt: "2026-06-12T00:00:00.000Z",
        });
        assert.equal(pipeline.dispatcher.getAdhocQueue().length, 1);

        const archiveDir = join(rootDir, "archive");
        await mkdir(archiveDir, { recursive: true });
        await rename(filepath, join(archiveDir, filename));

        assert.equal(pipeline.dispatcher.getAdhocQueue().length, 0);
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("drops stale ADHOC items and continues draining the next inbox task", async () => {
    await withTempScheduler(async ({ rootDir, inboxDir, stateDir }) => {
      const pipeline = await buildPipeline({ inboxDir, stateDir });
      try {
        await pipeline.registry.register(makeAgentSpec());
        const archiveDir = join(rootDir, "archive");
        await mkdir(archiveDir, { recursive: true });

        const staleFilename = "TASK-20260612-012-PM-to-DEV.md";
        const stalePath = join(archiveDir, staleFilename);
        await writeFile(
          stalePath,
          TASK_BODY(staleFilename.replace(/\.md$/, ""), "DEV").replace(
            "status: pending",
            "status: pending\nstate: inbox",
          ),
        );
        pipeline.dispatcher.enqueueAdhoc({
          filepath: stalePath,
          filename: staleFilename,
          recipient: "DEV",
          priority: "P0",
          enqueuedAt: "2026-06-12T00:00:00.000Z",
        });

        const liveFilename = "TASK-20260612-013-PM-to-DEV.md";
        const livePath = join(inboxDir, liveFilename);
        await writeFile(
          livePath,
          TASK_BODY(liveFilename.replace(/\.md$/, ""), "DEV").replace(
            "status: pending",
            "status: pending\nstate: inbox",
          ),
        );
        pipeline.dispatcher.enqueueAdhoc({
          filepath: livePath,
          filename: liveFilename,
          recipient: "DEV",
          priority: "P1",
          enqueuedAt: "2026-06-12T00:01:00.000Z",
        });

        await pipeline.dispatcher["_drainAdhocQueue"]();

        assert.equal(pipeline.sdk.calls.send.length, 1);
        assert.match(
          pipeline.sdk.calls.send[0]!.spec.text,
          new RegExp(liveFilename.replace(/\.md$/, "")),
        );
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("restores rejected_busy locally without LifecycleGovernor", async () => {
    await withTempScheduler(async ({ inboxDir, stateDir }) => {
      let lifecycleRestoreCalls = 0;
      const lifecycleGovernor = {
        awaitDispatchInboxToActive: async (taskPath: string) => taskPath,
        restoreToInboxAfterDispatchFailure: async () => {
          lifecycleRestoreCalls += 1;
        },
      } as unknown as LifecycleGovernor;
      const pipeline = await buildPipeline({
        inboxDir,
        stateDir,
        lifecycleGovernor,
      });
      try {
        await pipeline.registry.register(makeAgentSpec());
        pipeline.sdk.sendHandleFactory = (spec) =>
          new InMemoryRunHandle({
            sessionId: spec.sessionId,
            agentId: spec.agentId,
            manualSettle: true,
          });
        const running = await pipeline.sessionManager.startSession(
          "DEV-01",
          "TASK-running",
          { text: "busy" },
        );
        const agent = (await pipeline.registry.get("DEV-01"))!;
        await pipeline.registry["_store"].upsert({
          ...agent,
          protocol: { ...agent.protocol, status: "running" as const },
        });

        const filename = "TASK-20260612-011-PM-to-DEV.md";
        const filepath = join(inboxDir, filename);
        await writeFile(
          filepath,
          TASK_BODY(filename.replace(/\.md$/, ""), "DEV"),
        );

        const outcome = await pipeline.dispatcher.dispatchTaskFromControlPlane(
          filepath,
          filename,
          "DEV",
        );

        assert.equal(outcome.kind, "rejected_busy");
        assert.equal(lifecycleRestoreCalls, 0);
        assert.equal(frontmatterState(await readFile(filepath, "utf-8")), "inbox");
        await pipeline.sessionManager.cancelSession(running.session_id, "cleanup");
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("TS-5.10: drop TASK file → state_history `inbox → dispatched`", async () => {
    await withTempScheduler(async ({ inboxDir, stateDir }) => {
      const pipeline = await buildPipeline({ inboxDir, stateDir });
      try {
        await pipeline.registry.register(makeAgentSpec());
        await pipeline.dispatcher.start();

        const taskId = "TASK-20260509-001-PM-to-DEV";
        const filepath = join(inboxDir, `${taskId}.md`);
        await writeFile(filepath, TASK_BODY(taskId, "DEV"));
        await waitForInboxAutoDispatch(filepath);

        // Wait for state_history file content to include the dispatched entry.
        const fileText = await waitFor(
          async () => {
            try {
              const text = await readFile(filepath, "utf-8");
              return text.includes("inbox") && text.includes("dispatched")
                ? text
                : null;
            } catch {
              return null;
            }
          },
          { what: "state_history dispatched bullet", timeoutMs: 4000 },
        );

        assert.match(
          fileText,
          /## state_history \(auto-appended by runtime\)/,
        );
        assert.match(
          fileText,
          /by `runtime` \| `inbox` → `dispatched` session_id=session-/,
        );
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("TS-5.11: recipient with no registered agent → state_history `agent_not_found`", async () => {
    await withTempScheduler(async ({ inboxDir, stateDir }) => {
      const pipeline = await buildPipeline({ inboxDir, stateDir });
      try {
        // Note: no registry.register() call — the recipient role has no agent.
        await pipeline.dispatcher.start();

        const taskId = "TASK-20260509-002-PM-to-DEV";
        const filepath = join(inboxDir, `${taskId}.md`);
        await writeFile(filepath, TASK_BODY(taskId, "DEV"));
        await waitForInboxAutoDispatch(filepath);

        const fileText = await waitFor(
          async () => {
            try {
              const text = await readFile(filepath, "utf-8");
              // History append precedes _restoreDispatchedToInbox — wait for both.
              return text.includes("agent_not_found") &&
                frontmatterState(text) === "inbox"
                ? text
                : null;
            } catch {
              return null;
            }
          },
          {
            what: "state_history agent_not_found + frontmatter inbox",
            timeoutMs: 5000,
          },
        );

        assert.match(
          fileText,
          /by `runtime` \| `inbox` → `agent_not_found` recipient=DEV/,
        );
        assert.equal(frontmatterState(fileText), "inbox");
        // No SessionManager events should have been emitted (no session started).
        const startedEvents = pipeline.events.filter(
          (e) => e.event_type === "runtime.session_started",
        );
        assert.equal(startedEvents.length, 0);
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("TS-5.12: session_ended emits → state_history inbox→dispatched→running→ended", async () => {
    await withTempScheduler(async ({ inboxDir, stateDir }) => {
      const pipeline = await buildPipeline({ inboxDir, stateDir });
      try {
        await pipeline.registry.register(makeAgentSpec());
        await pipeline.dispatcher.start();

        const taskId = "TASK-20260509-003-PM-to-DEV";
        const filepath = join(inboxDir, `${taskId}.md`);
        await writeFile(filepath, TASK_BODY(taskId, "DEV"));
        await waitForInboxAutoDispatch(filepath);

        // Wait for the session_started → session_ended sequence (the in-memory
        // RunHandle auto-settles a microtask after creation).
        const startedEvent = await waitFor(
          () =>
            pipeline.events.find(
              (e) => e.event_type === "runtime.session_started",
            ),
          { what: "runtime.session_started", timeoutMs: 4000 },
        );
        const sessionId = startedEvent.session_id;
        await pipeline.sessionManager.awaitSettled(sessionId);
        // Wait for the dispatcher's state_history append to land (it runs
        // asynchronously after the session_ended event).
        const fileText = await waitFor(
          async () => {
            try {
              const text = await readFile(filepath, "utf-8");
              return text.includes("dispatched` → `ended") ? text : null;
            } catch {
              return null;
            }
          },
          {
            what: "state_history dispatched→ended bullet",
            timeoutMs: 10000,
          },
        );

        const bullets = fileText
          .split("\n")
          .filter((l) => l.startsWith("- **"))
          .filter((l) => !l.includes("`inbox` → `held`"));
        // task-report 热路径：inbox→dispatched → dispatched→running → dispatched→ended
        assert.equal(bullets.length, 3, `bullets:\n${bullets.join("\n")}`);
        assert.match(bullets[0]!, /`inbox` → `dispatched`/);
        assert.match(bullets[1]!, /`dispatched` → `running`/);
        assert.match(bullets[2]!, /`dispatched` → `ended`/);
        assert.notEqual(frontmatterState(fileText), "done");
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("TS-5.13 (validation #5): second task while agent busy → `rejected_busy`", async () => {
    await withTempScheduler(async ({ inboxDir, stateDir }) => {
      const pipeline = await buildPipeline({ inboxDir, stateDir });
      try {
        const sdkAgent = await pipeline.registry.register(makeAgentSpec());
        // Plant an InMemoryRunHandle that does NOT auto-settle so the
        // first session stays "running" while the second task arrives.
        pipeline.sdk.sendHandleFactory = (spec) =>
          new InMemoryRunHandle({
            sessionId: spec.sessionId,
            agentId: spec.agentId,
            manualSettle: true,
          });
        await pipeline.dispatcher.start();
        void sdkAgent;

        const firstTaskId = "TASK-20260509-004-PM-to-DEV";
        const firstPath = join(inboxDir, `${firstTaskId}.md`);
        await writeFile(firstPath, TASK_BODY(firstTaskId, "DEV"));
        await waitForInboxAutoDispatch(firstPath);

        // Wait for the first session to actually start (so the registry's
        // status is "running" before we drop the second task).
        await waitFor(
          () =>
            pipeline.events.find(
              (e) => e.event_type === "runtime.session_started",
            ),
          { what: "first session_started", timeoutMs: 4000 },
        );

        // ⚠️ SessionManager status check is on `record.protocol.status`.
        // After register(), status="idle"; after startSession completes,
        // SessionManager doesn't auto-flip the registry record to "running"
        // (the registry's protocol.status is per-Agent, not per-Session).
        // We need to mark the agent as "running" via markFailed-style update
        // or accept that the second task succeeds. To make `rejected_busy`
        // observable, we instead simulate the agent being "running" by
        // explicitly setting status via a markFailed-then-direct upsert.
        // Simpler: call sessionManager.startSession with the agent again
        // and confirm InvalidAgentStatusError surfaces.

        // First, manually mark the agent's status as "running" so the
        // second task hits the InvalidAgentStatusError branch. Phase C
        // doesn't yet auto-transition the registry record (it only
        // tracks session-level status) — Phase B serial-invariant relies
        // on the agent record status being non-idle. We mimic that by
        // doing a registry-side mutation as if S4 had transitioned us.
        const recordPath = join(stateDir, "agents.json");
        const raw = await readFile(recordPath, "utf-8");
        const records = JSON.parse(raw) as Array<{
          protocol: { status: string };
        }>;
        records[0]!.protocol.status = "running";
        await writeFile(recordPath, JSON.stringify(records, null, 2), "utf-8");

        const secondTaskId = "TASK-20260509-005-PM-to-DEV";
        const secondPath = join(inboxDir, `${secondTaskId}.md`);
        await writeFile(secondPath, TASK_BODY(secondTaskId, "DEV"));
        await waitForInboxAutoDispatch(secondPath);

        const fileText = await waitFor(
          async () => {
            try {
              const text = await readFile(secondPath, "utf-8");
              return text.includes("rejected_busy") &&
                frontmatterState(text) === "inbox"
                ? text
                : null;
            } catch {
              return null;
            }
          },
          { what: "rejected_busy bullet", timeoutMs: 4000 },
        );
        assert.match(
          fileText,
          /by `runtime` \| `inbox` → `rejected_busy` recipient=DEV, agent_status=running/,
        );
        assert.equal(frontmatterState(fileText), "inbox");

        // Best-effort cleanup: cancel any active sessions to free the watcher.
        await pipeline.sessionManager
          .cancelAllForEmergencyStop()
          .catch(() => undefined);
        // Drain microtasks so settlement listeners can detach before we shut down.
        await sleep(50);
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("keeps claimed TASK in retry_waiting when startSession fails", async () => {
    await withTempScheduler(async ({ inboxDir, stateDir }) => {
      const pipeline = await buildPipeline({
        inboxDir,
        stateDir,
        dispatchRetryRegistry: new DispatchRetryRegistry({
          backoffRangesMs: [[100, 100], [200, 200], [300, 300]],
          randomInt: (min) => min,
        }),
      });
      try {
        await pipeline.registry.register(makeAgentSpec());
        (
          pipeline.sessionManager as unknown as {
            startSession: SessionManager["startSession"];
          }
        ).startSession = async () => {
          throw new Error("boom");
        };
        await pipeline.dispatcher.start();

        const taskId = "TASK-20260509-006-PM-to-DEV";
        const filepath = join(inboxDir, `${taskId}.md`);
        await writeFile(filepath, TASK_BODY(taskId, "DEV"));
        await waitForInboxAutoDispatch(filepath);

        await waitFor(
          async () => {
            try {
              const text = await readFile(filepath, "utf-8");
              return text.includes("retry_waiting") ? text : null;
            } catch {
              return null;
            }
          },
          { what: "state_history retry_waiting", timeoutMs: 5000 },
        );

        const midText = await readFile(filepath, "utf-8");
        assert.notEqual(
          frontmatterState(midText),
          "inbox",
          "restore should wait for retry backoff",
        );
        assert.match(midText, /`inbox` → `retry_waiting` boom/);
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("infers canonical task_id from filename when frontmatter task_id is empty", async () => {
    await withTempScheduler(async ({ inboxDir, stateDir }) => {
      const parser = {
        parse: async (filepath: string): Promise<ParsedTask> => ({
          filepath,
          filename: "",
          frontmatter: { protocol: "fcop", sender: "PM", recipient: "DEV" },
          body: "# missing task id\n",
          task_id: "",
          sender: "PM",
          recipient: "DEV",
        }),
      };
      const pipeline = await buildPipeline({ inboxDir, stateDir, parser });
      try {
        await pipeline.registry.register(makeAgentSpec());
        await pipeline.dispatcher.start();

        const filepath = join(inboxDir, "TASK-20260509-007-PM-to-DEV.md");
        await writeFile(filepath, TASK_BODY("", "DEV"));
        await waitForInboxAutoDispatch(filepath);

        await waitFor(
          async () => {
            const started = pipeline.events.find(
              (e) => e.event_type === "runtime.session_started",
            );
            return started?.payload &&
              (started.payload as { task_id?: string }).task_id ===
                "TASK-20260509-007"
              ? started
              : null;
          },
          { what: "session started with canonical task_id", timeoutMs: 5000 },
        );
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("restores claimed TASK to inbox when session ends failed without REPORT", async () => {
    await withTempScheduler(async ({ inboxDir, stateDir }) => {
      const handles: InMemoryRunHandle[] = [];
      const pipeline = await buildPipeline({ inboxDir, stateDir });
      try {
        await pipeline.registry.register(makeAgentSpec());
        pipeline.sdk.sendHandleFactory = (spec) => {
          const h = new InMemoryRunHandle({
            sessionId: spec.sessionId,
            agentId: spec.agentId,
            manualSettle: true,
          });
          handles.push(h);
          return h;
        };
        await pipeline.dispatcher.start();

        const taskId = "TASK-20260509-008-PM-to-DEV";
        const filepath = join(inboxDir, `${taskId}.md`);
        await writeFile(filepath, TASK_BODY(taskId, "DEV"));
        await waitForInboxAutoDispatch(filepath);

        const startedEvent = await waitFor(
          () =>
            pipeline.events.find(
              e => e.event_type === "runtime.session_started",
            ),
          { what: "runtime.session_started", timeoutMs: 4000 },
        );
        const sessionId = startedEvent.session_id;
        const handle =
          handles.find((h) => h.session_id === sessionId) ?? handles[0]!;
        handle.settle({ status: "failed" });
        await pipeline.sessionManager.awaitSettled(sessionId);

        const fileText = await waitFor(
          async () => {
            try {
              const text = await readFile(filepath, "utf-8");
              return text.includes("restored after session failed") &&
                frontmatterState(text) === "inbox"
                ? text
                : null;
            } catch {
              return null;
            }
          },
          {
            what: "state_history failed restore + frontmatter inbox",
            timeoutMs: 5000,
          },
        );

        assert.match(fileText, /`dispatched` → `inbox`/);
        assert.match(fileText, /restored after session failed/);
        assert.equal(frontmatterState(fileText), "inbox");
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("moves inbox TASK to active before session and restores it after a failed session", async () => {
    await withTempScheduler(async ({ rootDir, stateDir }) => {
      const { mkdir } = await import("node:fs/promises");
      const lifecycleRoot = join(rootDir, "_lifecycle");
      const inboxDir = join(lifecycleRoot, "inbox");
      await mkdir(join(lifecycleRoot, "active"), { recursive: true });
      await mkdir(inboxDir, { recursive: true });

      const logger = quietLogger();
      const lifecycleGovernor = new LifecycleGovernor({
        lifecycleRoot,
        projectRoot: rootDir,
        logger,
        moveTimeoutMs: 10_000,
      });

      const handles: InMemoryRunHandle[] = [];
      const pipeline = await buildPipeline({
        inboxDir,
        stateDir,
        lifecycleGovernor,
      });
      try {
        await pipeline.registry.register(makeAgentSpec());
        pipeline.sdk.sendHandleFactory = (spec) => {
          const h = new InMemoryRunHandle({
            sessionId: spec.sessionId,
            agentId: spec.agentId,
            manualSettle: true,
          });
          handles.push(h);
          return h;
        };
        await pipeline.dispatcher.start();

        const taskId = "TASK-20260509-009-PM-to-DEV";
        const inboxPath = join(inboxDir, `${taskId}.md`);
        const activePath = join(lifecycleRoot, "active", `${taskId}.md`);
        await writeFile(inboxPath, TASK_BODY(taskId, "DEV"));

        const startedEvent = await waitFor(
          () =>
            pipeline.events.find(
              (e) => e.event_type === "runtime.session_started",
            ),
          { what: "runtime.session_started", timeoutMs: 4000 },
        );
        const sessionId = startedEvent.session_id;
        const handle =
          handles.find((h) => h.session_id === sessionId) ?? handles[0]!;
        handle.settle({ status: "failed" });
        await pipeline.sessionManager.awaitSettled(sessionId);

        await waitFor(
          async () => {
            try {
              await access(inboxPath);
              const text = await readFile(inboxPath, "utf-8");
              return frontmatterState(text) === "inbox" ? text : null;
            } catch {
              return null;
            }
          },
          {
            what: "inbox frontmatter restore after failed session",
            timeoutMs: 5000,
          },
        );

        await assert.rejects(() => access(activePath));
        const fileText = await readFile(inboxPath, "utf-8");
        assert.ok(
          /restored after session failed/.test(fileText) ||
            /runtime_restore_failed_dispatch/.test(fileText) ||
            /session_failed/.test(fileText),
          "expected inbox restore audit in markdown state_history or lifecycle transitions",
        );
        assert.equal(frontmatterState(fileText), "inbox");
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("keeps QA and OPS queued when references point to an unfinished sibling DEV task", async () => {
    await withTempScheduler(async ({ rootDir, inboxDir, stateDir }) => {
      const activeDir = join(rootDir, "fcop", "_lifecycle", "active");
      await mkdir(activeDir, { recursive: true });
      const rootId = "TASK-20260713-001";
      const devId = "TASK-20260713-002";
      await writeFile(
        join(activeDir, `${devId}-PM-to-DEV.md`),
        `---\ntask_id: ${devId}\nsender: PM\nrecipient: DEV\nparent: ${rootId}\nthread_key: panel-task-001\nstate: active\n---\n`,
      );

      const pipeline = await buildPipeline({
        inboxDir,
        stateDir,
        projectRoot: rootDir,
      });
      try {
        await pipeline.registry.register(
          makeAgentSpec({ agent_id: "QA-01", role: "QA" }),
        );
        await pipeline.registry.register(
          makeAgentSpec({ agent_id: "OPS-01", role: "OPS" }),
        );

        for (const recipient of ["QA", "OPS"] as const) {
          const taskId = `TASK-20260713-${recipient === "QA" ? "003" : "004"}-PM-to-${recipient}`;
          const filepath = join(inboxDir, `${taskId}.md`);
          const content = TASK_BODY(taskId, recipient).replace(
            "status: pending",
            `status: pending\nstate: inbox\nparent: ${rootId}\nthread_key: panel-task-001\nreferences: "['${rootId}', '${devId}']"\ndepends_on: "[]"`,
          );
          await writeFile(filepath, content);

          const outcome = await pipeline.dispatcher.dispatchTaskFromControlPlane(
            filepath,
            `${taskId}.md`,
            recipient,
          );

          assert.deepEqual(outcome, {
            kind: "dependency_pending",
            reason: `waiting for done report: ${devId}`,
            dependency_task_ids: [devId],
          });
          assert.equal(await readFile(filepath, "utf-8"), content);
        }
        assert.equal(pipeline.events.length, 0);
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("does not restore ADMIN root while PM is waiting downstream", async () => {
    await withTempScheduler(async ({ rootDir, stateDir }) => {
      const { mkdir } = await import("node:fs/promises");
      const lifecycleRoot = join(rootDir, "_lifecycle");
      const inboxDir = join(lifecycleRoot, "inbox");
      await mkdir(join(lifecycleRoot, "active"), { recursive: true });
      await mkdir(inboxDir, { recursive: true });

      const logger = quietLogger();
      const lifecycleGovernor = new LifecycleGovernor({
        lifecycleRoot,
        projectRoot: rootDir,
        logger,
        moveTimeoutMs: 10_000,
      });
      const pmQueueGuard = new PmQueueGuard({ logger });

      const handles: InMemoryRunHandle[] = [];
      const pipeline = await buildPipeline({
        inboxDir,
        stateDir,
        lifecycleGovernor,
        pmQueueGuard,
      });
      try {
        await pipeline.registry.register(
          makeAgentSpec({ agent_id: "PM-01", role: "PM" }),
        );
        pipeline.sdk.sendHandleFactory = (spec) => {
          const h = new InMemoryRunHandle({
            sessionId: spec.sessionId,
            agentId: spec.agentId,
            manualSettle: true,
          });
          handles.push(h);
          return h;
        };
        await pipeline.dispatcher.start();

        const taskId = "TASK-20260509-010-ADMIN-to-PM";
        const inboxPath = join(inboxDir, `${taskId}.md`);
        const activePath = join(lifecycleRoot, "active", `${taskId}.md`);
        await writeFile(
          inboxPath,
          `---
protocol: fcop
task_id: ${taskId}
sender: ADMIN
recipient: PM
priority: P2
status: pending
---

# Root task
`,
        );

        const startedEvent = await waitFor(
          () =>
            pipeline.events.find(
              (e) => e.event_type === "runtime.session_started",
            ),
          { what: "PM runtime.session_started", timeoutMs: 4000 },
        );
        await access(activePath);
        await assert.rejects(() => access(inboxPath));
        assert.equal(
          frontmatterState(await readFile(activePath, "utf-8")),
          "active",
        );
        const sessionId = startedEvent.session_id;
        pmQueueGuard.markWaitingDownstream("DEV", "test_downstream_dispatched");

        const handle =
          handles.find((h) => h.session_id === sessionId) ?? handles[0]!;
        handle.settle({ status: "failed" });
        await pipeline.sessionManager.awaitSettled(sessionId);
        await sleep(100);

        let activeExists = false;
        try {
          await access(activePath);
          activeExists = true;
        } catch {
          activeExists = false;
        }
        if (!activeExists) {
          const text = await readFile(inboxPath, "utf-8");
          assert.notEqual(frontmatterState(text), "inbox");
        }
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("enqueues second task in agent FIFO when agent queue slot is busy", async () => {
    await withTempScheduler(async ({ rootDir, inboxDir, stateDir }) => {
      await mkdir(join(rootDir, ".codeflowmu", "pm-governance"), {
        recursive: true,
      });
      const pipeline = await buildPipeline({
        inboxDir,
        stateDir,
        projectRoot: rootDir,
      });
      try {
        await pipeline.registry.register(makeAgentSpec());
        pipeline.sdk.sendHandleFactory = (spec) =>
          new InMemoryRunHandle({
            sessionId: spec.sessionId,
            agentId: spec.agentId,
            manualSettle: true,
          });
        await pipeline.dispatcher.start();

        const firstTaskId = "TASK-20260611-035-PM-to-DEV";
        const firstPath = join(inboxDir, `${firstTaskId}.md`);
        await writeFile(firstPath, TASK_BODY(firstTaskId, "DEV"));
        await waitForInboxAutoDispatch(firstPath);
        const agentId = (await pipeline.registry.list({ role: "DEV" }))[0]!
          .protocol.agent_id;
        await waitFor(
          async () => {
            const queueFile = await loadAgentTaskQueue(rootDir);
            return queueFile.agents[agentId]?.running ? queueFile : null;
          },
          { what: "first task running in agent queue", timeoutMs: 4000 },
        );

        const secondTaskId = "TASK-20260611-038-PM-to-DEV";
        const secondPath = join(inboxDir, `${secondTaskId}.md`);
        await writeFile(secondPath, TASK_BODY(secondTaskId, "DEV"));
        const outcome = await pipeline.dispatcher.dispatchTaskFromControlPlane(
          secondPath,
          `${secondTaskId}.md`,
          "DEV",
        );
        assert.equal(outcome.kind, "rejected_busy");

        const queueFile = await loadAgentTaskQueue(rootDir);
        const slot = queueFile.agents[agentId];
        assert.ok(slot?.running, "first task should be running in queue");
        assert.equal(
          slot?.running?.task_id,
          "TASK-20260611-035",
        );
        const queued = slot?.queue.find(
          (q) => q.task_id === "TASK-20260611-038",
        );
        assert.ok(queued, "second task should be FIFO-queued");
        assert.equal(
          pipeline.events.filter(
            (e) => e.event_type === "runtime.session_started",
          ).length,
          1,
          "must not open a second session while agent is busy",
        );

        const queuePath = agentTaskQueuePath(rootDir);
        await access(queuePath);
      } finally {
        await pipeline.shutdown();
      }
    });
  });
});

