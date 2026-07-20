/**
 * TaskDispatcher + agent FIFO queue — busy agent enqueues without startSession.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  InMemoryRunHandle,
  InMemorySdkAdapter,
} from "../../registry/AgentSdkAdapter.ts";
import { AgentRegistry } from "../../registry/AgentRegistry.ts";
import { JsonFileStore } from "../../registry/PersistentStore.ts";
import { SessionManager } from "../../session/SessionManager.ts";
import { SessionStore } from "../../session/SessionStore.ts";
import { TranscriptWriter } from "../../session/TranscriptWriter.ts";
import { StateHistoryWriter } from "../StateHistoryWriter.ts";
import { TaskDispatcher } from "../TaskDispatcher.ts";
import { InboxWatcher } from "../InboxWatcher.ts";
import { agentTaskQueuePath, loadAgentTaskQueue } from "../../pm/agentTaskQueue.ts";
import { quietLogger, withTempScheduler } from "./helpers.ts";

import type { Agent } from "@codeflowmu/protocol";

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

describe("TaskDispatcher agent FIFO queue", () => {
  it("stale persisted busy state is cleared when no active session exists", async () => {
    await withTempScheduler(async ({ rootDir, inboxDir, stateDir }) => {
      const govDir = join(rootDir, ".codeflowmu", "pm-governance");
      await mkdir(govDir, { recursive: true });

      const runningTaskId = "TASK-20260611-035";
      const queuedTaskId = "TASK-20260611-038";
      await writeFile(
        agentTaskQueuePath(rootDir),
        `${JSON.stringify(
          {
            version: "1.0.0",
            updated_at: new Date().toISOString(),
            agents: {
              "DEV-01": {
                running: {
                  task_id: runningTaskId,
                  session_id: "session-busy",
                  started_at: new Date().toISOString(),
                },
                queue: [
                  {
                    task_id: "TASK-20260611-034",
                    agent_id: "DEV-01",
                    reason: "agent_busy",
                    filepath: join(rootDir, "archive", "TASK-20260611-034.md"),
                    queued_at: new Date().toISOString(),
                  },
                ],
              },
            },
            paused: {},
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const sdk = new InMemorySdkAdapter();
      const registry = new AgentRegistry({
        store: new JsonFileStore({ path: join(stateDir, "agents.json") }),
        sdk,
      });
      const sessionManager = new SessionManager({
        registry,
        sdk,
        sessionStore: new SessionStore({ dir: join(stateDir, "sessions") }),
        transcriptWriter: new TranscriptWriter({
          dir: join(stateDir, "transcripts"),
        }),
      });
      const logger = quietLogger();
      const dispatcher = new TaskDispatcher({
        watcher: new InboxWatcher({ dir: inboxDir, logger }),
        historyWriter: new StateHistoryWriter(),
        registry,
        sessionManager,
        logger,
        projectRoot: rootDir,
      });
      await registry.register(makeAgentSpec());
      sdk.sendHandleFactory = (spec) =>
        new InMemoryRunHandle({
          sessionId: spec.sessionId,
          agentId: spec.agentId,
          manualSettle: true,
        });

      const filepath = join(inboxDir, `${queuedTaskId}-PM-to-DEV.md`);
      await writeFile(
        filepath,
        `---
protocol: fcop
task_id: ${queuedTaskId}
sender: PM
recipient: DEV
priority: P2
state: inbox
---

# Queue when busy
`,
        "utf-8",
      );

      const outcome = await dispatcher.dispatchTaskFromControlPlane(
        filepath,
        `${queuedTaskId}-PM-to-DEV.md`,
        "DEV",
      );

      assert.equal(outcome.kind, "dispatched");

      const queue = await loadAgentTaskQueue(rootDir);
      const slot = queue.agents["DEV-01"];
      assert.ok(slot);
      assert.equal(slot!.running?.task_id, queuedTaskId);
      assert.equal(slot!.queue.length, 0);

      const events = await sessionManager.listActive();
      assert.equal(events.length, 1);

      const fileText = await readFile(filepath, "utf-8");
      assert.doesNotMatch(fileText, /rejected_busy/);
    });
  });

  it("live session with desynced queue enqueues without second startSession", async () => {
    await withTempScheduler(async ({ rootDir, inboxDir, stateDir }) => {
      const govDir = join(rootDir, ".codeflowmu", "pm-governance");
      await mkdir(govDir, { recursive: true });
      await writeFile(
        agentTaskQueuePath(rootDir),
        `${JSON.stringify(
          {
            version: "1.0.0",
            updated_at: new Date().toISOString(),
            agents: { "DEV-01": { running: null, queue: [] } },
            paused: {},
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const runningTaskId = "TASK-20260611-035";
      const queuedTaskId = "TASK-20260611-038";
      const sdk = new InMemorySdkAdapter();
      const registry = new AgentRegistry({
        store: new JsonFileStore({ path: join(stateDir, "agents.json") }),
        sdk,
      });
      const sessionManager = new SessionManager({
        registry,
        sdk,
        sessionStore: new SessionStore({ dir: join(stateDir, "sessions") }),
        transcriptWriter: new TranscriptWriter({
          dir: join(stateDir, "transcripts"),
        }),
      });
      const logger = quietLogger();
      const dispatcher = new TaskDispatcher({
        watcher: new InboxWatcher({ dir: inboxDir, logger }),
        historyWriter: new StateHistoryWriter(),
        registry,
        sessionManager,
        logger,
        projectRoot: rootDir,
      });
      await registry.register(makeAgentSpec({ status: "running" }));

      const firstPath = join(inboxDir, `${runningTaskId}-PM-to-DEV.md`);
      await writeFile(
        firstPath,
        `---
protocol: fcop
task_id: ${runningTaskId}
sender: PM
recipient: DEV
priority: P0
state: inbox
---

# Running
`,
        "utf-8",
      );
      sdk.sendHandleFactory = (spec) =>
        new InMemoryRunHandle({
          sessionId: spec.sessionId,
          agentId: spec.agentId,
          manualSettle: true,
        });
      const firstOutcome = await dispatcher.dispatchTaskFromControlPlane(
        firstPath,
        `${runningTaskId}-PM-to-DEV.md`,
        "DEV",
      );
      assert.equal(firstOutcome.kind, "dispatched");

      const queueAfterFirst = await loadAgentTaskQueue(rootDir);
      queueAfterFirst.agents["DEV-01"]!.running = null;
      const { saveAgentTaskQueue } = await import("../../pm/agentTaskQueue.ts");
      await saveAgentTaskQueue(rootDir, queueAfterFirst);

      const secondPath = join(inboxDir, `${queuedTaskId}-PM-to-DEV.md`);
      await writeFile(
        secondPath,
        `---
protocol: fcop
task_id: ${queuedTaskId}
sender: PM
recipient: DEV
priority: P2
state: inbox
---

# Queued
`,
        "utf-8",
      );
      const secondOutcome = await dispatcher.dispatchTaskFromControlPlane(
        secondPath,
        `${queuedTaskId}-PM-to-DEV.md`,
        "DEV",
      );
      assert.equal(secondOutcome.kind, "rejected_busy");
      await dispatcher["_enqueueRejectedBusy"](
        secondPath,
        `${queuedTaskId}-PM-to-DEV.md`,
        "DEV",
      );

      const queue = await loadAgentTaskQueue(rootDir);
      const slot = queue.agents["DEV-01"];
      assert.equal(slot?.running?.task_id, runningTaskId);
      assert.equal(slot?.queue[0]?.task_id, queuedTaskId);
      assert.equal((await sessionManager.listActive()).length, 1);
      assert.equal(
        logger.logs.filter((line) => line.includes("agent FIFO queued")).length,
        0,
      );

      const duplicateOutcome = await dispatcher.dispatchTaskFromControlPlane(
        firstPath,
        `${runningTaskId}-PM-to-DEV.md`,
        "DEV",
      );
      assert.equal(duplicateOutcome.kind, "already_dispatched");
      const queueAfterDuplicate = await loadAgentTaskQueue(rootDir);
      assert.equal(queueAfterDuplicate.agents["DEV-01"]?.queue.length, 1);
    });
  });
});
