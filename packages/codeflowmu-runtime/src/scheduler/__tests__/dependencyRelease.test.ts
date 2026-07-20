/**
 * Dependency release — pending_dependency tasks auto-dispatch after upstream
 * done reports land (DEV report → QA release → TaskDispatcher).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Agent } from "@codeflowmu/protocol";

import {
  InMemorySdkAdapter,
} from "../../registry/AgentSdkAdapter.ts";
import { AgentRegistry } from "../../registry/AgentRegistry.ts";
import { JsonFileStore } from "../../registry/PersistentStore.ts";
import { SessionManager } from "../../session/SessionManager.ts";
import { SessionStore } from "../../session/SessionStore.ts";
import { TranscriptWriter } from "../../session/TranscriptWriter.ts";
import type { RuntimeEvent } from "../../types/state.ts";
import { DispatchRetryRegistry } from "../../_internal/DispatchRetryRegistry.ts";
import { patchTaskDependencyReleaseFrontmatter } from "../DependencyReleaseRunner.ts";
import { pmGovernanceCycleJournalPath } from "../../pm/PmGovernancePlanner.ts";
import {
  evaluateTaskDependencyGate,
  isDispatchDependencyTaskRef,
} from "../TaskDependencyGate.ts";
import { InboxWatcher } from "../InboxWatcher.ts";
import { StateHistoryWriter } from "../StateHistoryWriter.ts";
import { TaskDispatcher } from "../TaskDispatcher.ts";

import { quietLogger, waitFor, withTempScheduler } from "./helpers.ts";

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

  const events: RuntimeEvent[] = [];
  sessionManager.onEvent((evt) => events.push(evt));

  return {
    dispatcher,
    registry,
    sessionManager,
    events,
    shutdown: async () => {
      await dispatcher.stop().catch(() => undefined);
      await transcriptWriter.closeAll().catch(() => undefined);
    },
  };
}

describe("TaskDependencyGate pending_dependency", () => {
  it("allows when depends_on has a done report", async () => {
    await withTempScheduler(async ({ rootDir }) => {
      const reportsDir = join(rootDir, "fcop", "reports");
      await mkdir(reportsDir, { recursive: true });
      const devId = "TASK-20260618-001-PM-to-DEV";
      await writeFile(
        join(reportsDir, "REPORT-20260618-001-DEV-to-PM.md"),
        `---\ntask_id: ${devId}\nstatus: done\n---\n`,
      );

      const gate = await evaluateTaskDependencyGate(
        {
          filepath: "x",
          filename: "TASK-qa.md",
          frontmatter: {},
          body: "",
          state: "pending_dependency",
          depends_on: [devId],
          recipient: "QA",
        },
        rootDir,
      );
      assert.equal(gate.allowed, true);
    });
  });

  it("blocks when depends_on report is missing or not done", async () => {
    await withTempScheduler(async ({ rootDir }) => {
      const devId = "TASK-20260618-001-PM-to-DEV";
      const gateMissing = await evaluateTaskDependencyGate(
        {
          filepath: "x",
          filename: "TASK-qa.md",
          frontmatter: {},
          body: "",
          state: "pending_dependency",
          depends_on: [devId],
          recipient: "QA",
        },
        rootDir,
      );
      assert.equal(gateMissing.allowed, false);
      assert.match(gateMissing.reason ?? "", /waiting for done report/);

      const reportsDir = join(rootDir, "fcop", "reports");
      await mkdir(reportsDir, { recursive: true });
      await writeFile(
        join(reportsDir, "REPORT-20260618-001-DEV-to-PM.md"),
        `---\ntask_id: ${devId}\nstatus: in_progress\n---\n`,
      );
      const gateNotDone = await evaluateTaskDependencyGate(
        {
          filepath: "x",
          filename: "TASK-qa.md",
          frontmatter: {},
          body: "",
          state: "pending_dependency",
          depends_on: [devId],
          recipient: "QA",
        },
        rootDir,
      );
      assert.equal(gateNotDone.allowed, false);
    });
  });

  it("still blocks staged tasks without evaluating depends_on", async () => {
    const gate = await evaluateTaskDependencyGate(
      {
        filepath: "x",
        filename: "TASK-staged.md",
        frontmatter: {},
        body: "",
        state: "staged",
        depends_on: ["TASK-20260618-001-PM-to-DEV"],
        recipient: "OPS",
      },
      "/tmp/unused",
    );
    assert.equal(gate.allowed, false);
    assert.match(gate.reason ?? "", /staged/);
  });

  it("blocks QA when references PM-to-DEV without done report (TRACK-002)", async () => {
    await withTempScheduler(async ({ rootDir }) => {
      const devId = "TASK-20260618-003-PM-to-DEV";
      const adminId = "TASK-20260618-016-ADMIN-to-PM";
      const gate = await evaluateTaskDependencyGate(
        {
          filepath: "x",
          filename: "TASK-20260618-004-PM-to-QA.md",
          frontmatter: {
            references: [adminId, devId],
          },
          body: "",
          state: "inbox",
          recipient: "QA",
        },
        rootDir,
      );
      assert.equal(gate.allowed, false);
      assert.deepEqual(gate.dependencyTaskIds, [devId]);
      assert.match(gate.reason ?? "", /TASK-20260618-003-PM-to-DEV/);
    });
  });

  it("does not treat ADMIN-to-PM references as dispatch dependencies", () => {
    assert.equal(
      isDispatchDependencyTaskRef("TASK-20260618-016-ADMIN-to-PM"),
      false,
    );
    assert.equal(
      isDispatchDependencyTaskRef("TASK-20260618-003-PM-to-DEV"),
      true,
    );
  });
});

describe("patchTaskDependencyReleaseFrontmatter", () => {
  it("sets state inbox and dispatch_state ready", () => {
    const raw = TASK_BODY("TASK-20260618-002-PM-to-QA", "QA").replace(
      "status: pending",
      "status: pending\nstate: pending_dependency\ndispatch_state: pending_dependency",
    );
    const patched = patchTaskDependencyReleaseFrontmatter(raw);
    assert.equal(frontmatterState(patched), "inbox");
    assert.match(patched, /^dispatch_state:\s*ready/m);
    assert.match(patched, /^dependency_release_state:\s*released/m);
  });
});

describe("releasePendingDependencyTasks integration", () => {
  it("emits at most one release signal for the same dependency resolution", async () => {
    await withTempScheduler(async ({ rootDir, inboxDir, stateDir }) => {
      const devTaskId = "TASK-20260715-005-PM-to-DEV";
      const qaTaskId = "TASK-20260715-006-PM-to-QA";
      const reportsDir = join(rootDir, "fcop", "reports");
      const doneDir = join(rootDir, "fcop", "_lifecycle", "done");
      await mkdir(reportsDir, { recursive: true });
      await mkdir(doneDir, { recursive: true });
      await writeFile(
        join(doneDir, `${devTaskId}.md`),
        TASK_BODY(devTaskId, "DEV").replace("status: pending", "status: done\nstate: done"),
      );
      await writeFile(
        join(reportsDir, "REPORT-20260715-005-DEV-to-PM.md"),
        `---\ntask_id: ${devTaskId}\nstatus: done\nsender: DEV\nrecipient: PM\n---\n`,
      );
      const qaPath = join(inboxDir, `${qaTaskId}.md`);
      await writeFile(
        qaPath,
        TASK_BODY(qaTaskId, "QA").replace(
          "status: pending",
          `status: pending\nstate: pending_dependency\ndispatch_state: pending_dependency\ndepends_on:\n  - ${devTaskId}`,
        ),
      );

      const pipeline = await buildPipeline({ inboxDir, stateDir, projectRoot: rootDir });
      try {
        await pipeline.registry.register(makeAgentSpec({ agent_id: "QA-01", role: "QA" }));
        await pipeline.dispatcher.releasePendingDependencyTasks();
        await pipeline.dispatcher.releasePendingDependencyTasks();
        await pipeline.dispatcher.releasePendingDependencyTasks();
        await pipeline.dispatcher.releasePendingDependencyTasks();
        assert.equal(
          pipeline.events.filter((event) => event.event_type === "runtime.session_started").length,
          1,
        );
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("releases QA from pending_dependency and dispatches after DEV done report", async () => {
    await withTempScheduler(async ({ rootDir, inboxDir, stateDir }) => {
      const devTaskId = "TASK-20260618-010-PM-to-DEV";
      const qaTaskId = "TASK-20260618-011-PM-to-QA";
      const reportsDir = join(rootDir, "fcop", "reports");
      const doneDir = join(rootDir, "fcop", "_lifecycle", "done");
      await mkdir(reportsDir, { recursive: true });
      await mkdir(doneDir, { recursive: true });
      await writeFile(
        join(doneDir, `${devTaskId}-dependency-record.md`),
        TASK_BODY(devTaskId, "DEV").replace(
          "status: pending",
          "status: done\nstate: done",
        ),
      );
      await writeFile(
        join(reportsDir, "REPORT-20260618-010-DEV-to-PM.md"),
        `---\ntask_id: ${devTaskId}\nstatus: done\nsender: DEV\nrecipient: PM\n---\n`,
      );

      const qaPath = join(inboxDir, `${qaTaskId}.md`);
      await writeFile(
        qaPath,
        TASK_BODY(qaTaskId, "QA").replace(
          "status: pending",
          `status: pending\nstate: pending_dependency\ndispatch_state: pending_dependency\ndepends_on:\n  - ${devTaskId}`,
        ),
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

        await pipeline.dispatcher.releasePendingDependencyTasks();

        assert.equal(
          pipeline.events.filter(
            (e) => e.event_type === "runtime.session_started",
          ).length,
          1,
        );
        assert.equal(frontmatterState(await readFile(qaPath, "utf-8")), "dispatched");

        const cycleRaw = await readFile(
          pmGovernanceCycleJournalPath(rootDir),
          "utf-8",
        );
        const cycleLines = cycleRaw.trim().split("\n");
        assert.ok(cycleLines.length >= 1);
        const last = JSON.parse(cycleLines[cycleLines.length - 1]!) as {
          event?: string;
          released?: Array<{ task_id?: string }>;
        };
        assert.equal(last.event, "dependency_release");
        assert.ok(
          last.released?.some((r) => r.task_id === qaTaskId),
          "cycle.jsonl must record QA release",
        );
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("keeps QA pending_dependency when DEV done report is absent", async () => {
    await withTempScheduler(async ({ rootDir, inboxDir, stateDir }) => {
      const devTaskId = "TASK-20260618-012-PM-to-DEV";
      const qaTaskId = "TASK-20260618-013-PM-to-QA";
      const qaPath = join(inboxDir, `${qaTaskId}.md`);
      const qaContent = TASK_BODY(qaTaskId, "QA").replace(
        "status: pending",
        `status: pending\nstate: pending_dependency\ndispatch_state: pending_dependency\ndepends_on:\n  - ${devTaskId}`,
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

        await pipeline.dispatcher.releasePendingDependencyTasks();

        assert.equal(pipeline.events.length, 0);
        assert.equal(await readFile(qaPath, "utf-8"), qaContent);
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("real rework flow: old DEV report cannot release QA; current DEV report releases it", async () => {
    await withTempScheduler(async ({ rootDir, inboxDir, stateDir }) => {
      const threadKey = "panel-task-rework-gate";
      const oldDevId = "TASK-20260712-001-PM-to-DEV";
      const currentDevId = "TASK-20260712-003-PM-to-DEV";
      const qaTaskId = "TASK-20260712-004-PM-to-QA";
      const reportsDir = join(rootDir, "fcop", "reports");
      const doneDir = join(rootDir, "fcop", "_lifecycle", "done");
      const activeDir = join(rootDir, "fcop", "_lifecycle", "active");
      await mkdir(reportsDir, { recursive: true });
      await mkdir(doneDir, { recursive: true });
      await mkdir(activeDir, { recursive: true });
      await writeFile(
        join(doneDir, `${oldDevId}.md`),
        TASK_BODY(oldDevId, "DEV").replace(
          "status: pending",
          `status: done\nstate: done\nthread_key: ${threadKey}`,
        ),
      );
      await writeFile(
        join(activeDir, `${currentDevId}.md`),
        TASK_BODY(currentDevId, "DEV").replace(
          "status: pending",
          `status: pending\nstate: active\nthread_key: ${threadKey}`,
        ),
      );
      await writeFile(
        join(reportsDir, "REPORT-20260712-001-DEV-to-PM.md"),
        `---\ntask_id: ${oldDevId}\nthread_key: ${threadKey}\nstatus: done\nsender: DEV\nrecipient: PM\n---\n`,
      );

      const qaPath = join(inboxDir, `${qaTaskId}.md`);
      const qaContent = TASK_BODY(qaTaskId, "QA").replace(
        "status: pending",
        `status: pending\nstate: pending_dependency\ndispatch_state: pending_dependency\nthread_key: ${threadKey}\nreferences:\n  - TASK-20260712-000-ADMIN-to-PM\n  - ${currentDevId}`,
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

        await pipeline.dispatcher.releasePendingDependencyTasks();
        assert.equal(pipeline.events.length, 0);
        assert.equal(await readFile(qaPath, "utf-8"), qaContent);

        await writeFile(
          join(reportsDir, "REPORT-20260712-003-DEV-to-PM.md"),
          `---\ntask_id: ${currentDevId}\nthread_key: ${threadKey}\nstatus: done\nsender: DEV\nrecipient: PM\n---\n`,
        );
        await pipeline.dispatcher.releasePendingDependencyTasks();

        assert.equal(
          pipeline.events.filter(
            (event) => event.event_type === "runtime.session_started",
          ).length,
          1,
        );
        assert.equal(frontmatterState(await readFile(qaPath, "utf-8")), "dispatched");
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("blocks external dispatchTask() with dispatch_bypass_blocked", async () => {
    await withTempScheduler(async ({ rootDir, inboxDir, stateDir }) => {
      const taskId = "TASK-20260618-099-PM-to-DEV";
      const taskPath = join(inboxDir, `${taskId}.md`);
      await writeFile(taskPath, TASK_BODY(taskId, "DEV"));

      const pipeline = await buildPipeline({
        inboxDir,
        stateDir,
        projectRoot: rootDir,
      });
      try {
        await pipeline.registry.register(
          makeAgentSpec({ agent_id: "DEV-01", role: "DEV" }),
        );

        const outcome = await pipeline.dispatcher.dispatchTask(
          taskPath,
          `${taskId}.md`,
          "DEV",
        );

        assert.equal(outcome.kind, "dispatch_bypass_blocked");
        assert.equal(pipeline.events.length, 0);
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("control plane blocks QA with references-only dependency before DEV done report", async () => {
    await withTempScheduler(async ({ rootDir, inboxDir, stateDir }) => {
      const devTaskId = "TASK-20260618-003-PM-to-DEV";
      const qaTaskId = "TASK-20260618-004-PM-to-QA";
      const qaPath = join(inboxDir, `${qaTaskId}.md`);
      const qaContent = TASK_BODY(qaTaskId, "QA").replace(
        "status: pending",
        `status: pending\nstate: inbox\nreferences:\n  - TASK-20260618-016-ADMIN-to-PM\n  - ${devTaskId}`,
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

        const outcome = await pipeline.dispatcher.dispatchTaskFromControlPlane(
          qaPath,
          `${qaTaskId}.md`,
          "QA",
        );

        assert.equal(outcome.kind, "dependency_pending");
        assert.match(
          outcome.reason ?? "",
          new RegExp(devTaskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );
        assert.equal(pipeline.events.length, 0);
        assert.equal(await readFile(qaPath, "utf-8"), qaContent);
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("releases QA on session_ended even when adhoc queue is empty", async () => {
    await withTempScheduler(async ({ rootDir, inboxDir, stateDir }) => {
      const devTaskId = "TASK-20260618-020-PM-to-DEV";
      const qaTaskId = "TASK-20260618-021-PM-to-QA";
      const reportsDir = join(rootDir, "fcop", "reports");
      const doneDir = join(rootDir, "fcop", "_lifecycle", "done");
      await mkdir(reportsDir, { recursive: true });
      await mkdir(doneDir, { recursive: true });
      await writeFile(
        join(doneDir, `${devTaskId}-dependency-record.md`),
        TASK_BODY(devTaskId, "DEV").replace(
          "status: pending",
          "status: done\nstate: done",
        ),
      );
      await writeFile(
        join(reportsDir, "REPORT-20260618-020-DEV-to-PM.md"),
        `---\ntask_id: ${devTaskId}\nstatus: done\n---\n`,
      );

      const qaPath = join(inboxDir, `${qaTaskId}.md`);
      await writeFile(
        qaPath,
        TASK_BODY(qaTaskId, "QA").replace(
          "status: pending",
          `status: pending\nstate: pending_dependency\ndispatch_state: pending_dependency\ndepends_on:\n  - ${devTaskId}`,
        ),
      );

      const devPath = join(inboxDir, `${devTaskId}.md`);
      await writeFile(
        devPath,
        TASK_BODY(devTaskId, "DEV").replace(
          "status: pending",
          "status: pending\nstate: inbox",
        ),
      );

      const pipeline = await buildPipeline({
        inboxDir,
        stateDir,
        projectRoot: rootDir,
      });
      try {
        await pipeline.registry.register(makeAgentSpec());
        await pipeline.registry.register(
          makeAgentSpec({ agent_id: "QA-01", role: "QA" }),
        );
        await pipeline.dispatcher.start();

        const devOutcome = await pipeline.dispatcher.dispatchTaskFromControlPlane(
          devPath,
          `${devTaskId}.md`,
          "DEV",
        );
        assert.ok(
          devOutcome.kind === "dispatched" ||
            devOutcome.kind === "already_dispatched",
        );

        await waitFor(
          () =>
            pipeline.events.some((e) => e.event_type === "runtime.session_ended")
              ? true
              : null,
          { what: "DEV session_ended", timeoutMs: 5000 },
        );

        await waitFor(
          async () => {
            const state = frontmatterState(await readFile(qaPath, "utf-8"));
            return state === "dispatched" ? state : null;
          },
          { what: "QA auto-dispatch after DEV session end", timeoutMs: 5000 },
        );

        assert.ok(
          pipeline.events.some((e) => e.event_type === "runtime.session_started"),
        );
      } finally {
        await pipeline.shutdown();
      }
    });
  });
});
