/**
 * Dispatch control plane — single entry `dispatchTaskFromControlPlane`,
 * external `dispatchTask()` blocked with `dispatch_bypass_blocked`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Agent } from "@codeflowmu/protocol";

import { InMemorySdkAdapter } from "../../registry/AgentSdkAdapter.ts";
import { AgentRegistry } from "../../registry/AgentRegistry.ts";
import { JsonFileStore } from "../../registry/PersistentStore.ts";
import { SessionManager } from "../../session/SessionManager.ts";
import { SessionStore } from "../../session/SessionStore.ts";
import { TranscriptWriter } from "../../session/TranscriptWriter.ts";
import { advanceAgentQueue } from "../../pm/agentTaskQueueControl.ts";
import { pmGovernanceCycleJournalPath } from "../../pm/PmGovernancePlanner.ts";
import { InboxWatcher } from "../InboxWatcher.ts";
import { StateHistoryWriter } from "../StateHistoryWriter.ts";
import { TaskDispatcher } from "../TaskDispatcher.ts";
import { DispatchRetryRegistry } from "../../_internal/DispatchRetryRegistry.ts";

import { quietLogger, withTempScheduler } from "./helpers.ts";

const PANEL_TASK_022 = "panel-task-022";
const DEV_007 = "TASK-20260618-007-PM-to-DEV";
const QA_008 = "TASK-20260618-008-PM-to-QA";
const PARENT_022 = "TASK-20260618-022-ADMIN-to-PM";

const TASK_BODY = (
  taskId: string,
  recipient: string,
  extra = "",
): string => `---
protocol: fcop
task_id: ${taskId}
sender: PM
recipient: ${recipient}
priority: P2
thread_key: ${PANEL_TASK_022}
status: pending
${extra}
---

# Body of ${taskId}
`;

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

async function buildPipeline(opts: {
  inboxDir: string;
  stateDir: string;
  projectRoot: string;
}) {
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
  const dispatchRetryRegistry = new DispatchRetryRegistry({
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
    projectRoot: opts.projectRoot,
  });

  return {
    dispatcher,
    registry,
    sessionManager,
    shutdown: async () => {
      await dispatcher.stop().catch(() => undefined);
      await transcriptWriter.closeAll().catch(() => undefined);
    },
  };
}

describe("dispatch control plane single entry", () => {
  it("throttles identical dependency-wait diagnostics", async () => {
    await withTempScheduler(async ({ rootDir, inboxDir, stateDir }) => {
      const pipeline = await buildPipeline({
        inboxDir,
        stateDir,
        projectRoot: rootDir,
      });
      try {
        const shouldEmit = (
          pipeline.dispatcher as unknown as {
            _shouldEmitDispatchWait: (key: string, intervalMs?: number) => boolean;
          }
        )._shouldEmitDispatchWait.bind(pipeline.dispatcher);
        assert.equal(shouldEmit("qa:task:waiting_dependency"), true);
        assert.equal(shouldEmit("qa:task:waiting_dependency"), false);
        assert.equal(shouldEmit("ops:task:waiting_dependency"), true);
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("external dispatchTask() always returns dispatch_bypass_blocked", async () => {
    await withTempScheduler(async ({ rootDir, inboxDir, stateDir }) => {
      const taskPath = join(inboxDir, `${DEV_007}.md`);
      await writeFile(taskPath, TASK_BODY(DEV_007, "DEV"));

      const pipeline = await buildPipeline({
        inboxDir,
        stateDir,
        projectRoot: rootDir,
      });
      try {
        const outcome = await pipeline.dispatcher.dispatchTask(
          taskPath,
          `${DEV_007}.md`,
          "DEV",
        );
        assert.equal(outcome.kind, "dispatch_bypass_blocked");
        assert.match(outcome.reason ?? "", /dispatchTaskFromControlPlane/);
        assert.equal(outcome.source, "external_dispatchTask");
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("DEV-E2E-TEST panel-task-022: QA-008 blocked until DEV-007 report then dependency_release", async () => {
    await withTempScheduler(async ({ rootDir, inboxDir, stateDir }) => {
      const qaPath = join(inboxDir, `${QA_008}.md`);
      const qaContent = TASK_BODY(
        QA_008,
        "QA",
        `state: inbox\nreferences:\n  - ${PARENT_022}\n  - ${DEV_007}`,
      );
      await writeFile(qaPath, qaContent);

      const pipeline = await buildPipeline({
        inboxDir,
        stateDir,
        projectRoot: rootDir,
      });
      try {
        await pipeline.registry.register(
          makeAgentSpec({ agent_id: "QA-01", role: "QA" }),
        );

        const blocked = await pipeline.dispatcher.dispatchTaskFromControlPlane(
          qaPath,
          `${QA_008}.md`,
          "QA",
          "inbox_watcher",
        );
        assert.equal(blocked.kind, "dependency_pending");
        assert.match(blocked.reason ?? "", /007/);

        const reportsDir = join(rootDir, "fcop", "reports");
        const doneDir = join(rootDir, "fcop", "_lifecycle", "done");
        await mkdir(reportsDir, { recursive: true });
        await mkdir(doneDir, { recursive: true });
        await writeFile(
          join(doneDir, `${DEV_007}.md`),
          TASK_BODY(
            DEV_007,
            "DEV",
            `state: done\nthread_key: ${PANEL_TASK_022}`,
          ),
        );
        await writeFile(
          join(reportsDir, "REPORT-20260618-007-DEV-to-PM.md"),
          `---\ntask_id: ${DEV_007}\nstatus: done\nsender: DEV\nrecipient: PM\nthread_key: ${PANEL_TASK_022}\n---\n`,
        );

        await pipeline.dispatcher.releasePendingDependencyTasks();

        const qaState = await readFile(qaPath, "utf-8");
        assert.match(qaState, /^state:\s*dispatched/m);

        const cycleRaw = await readFile(
          pmGovernanceCycleJournalPath(rootDir),
          "utf-8",
        );
        const last = JSON.parse(
          cycleRaw.trim().split("\n").pop() ?? "{}",
        ) as { event?: string; released?: Array<{ task_id?: string }> };
        assert.equal(last.event, "dependency_release");
        assert.ok(last.released?.some((r) => r.task_id === QA_008));
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("agent queue advance uses dispatchTaskFromControlPlane not dispatchTask", async () => {
    await withTempScheduler(async ({ rootDir, inboxDir, stateDir }) => {
      const taskPath = join(inboxDir, `${DEV_007}.md`);
      await writeFile(
        taskPath,
        TASK_BODY(DEV_007, "DEV", "state: inbox"),
      );

      const pipeline = await buildPipeline({
        inboxDir,
        stateDir,
        projectRoot: rootDir,
      });
      try {
        await pipeline.registry.register(makeAgentSpec());

        const bypass = await pipeline.dispatcher.dispatchTask(
          taskPath,
          `${DEV_007}.md`,
          "DEV",
        );
        assert.equal(bypass.kind, "dispatch_bypass_blocked");

        const advanced = await advanceAgentQueue({
          projectRoot: rootDir,
          agentId: "DEV-01",
          dispatcher: pipeline.dispatcher,
        });
        assert.equal(advanced, false);
      } finally {
        await pipeline.shutdown();
      }
    });
  });
});
