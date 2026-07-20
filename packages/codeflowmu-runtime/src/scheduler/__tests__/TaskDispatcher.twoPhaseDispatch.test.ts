/**
 * Two-phase dispatch tests — TASK-20260610-016 acceptance scenarios.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  InMemorySdkAdapter,
} from "../../registry/AgentSdkAdapter.ts";
import { AgentRegistry } from "../../registry/AgentRegistry.ts";
import { JsonFileStore } from "../../registry/PersistentStore.ts";
import { SessionManager } from "../../session/SessionManager.ts";
import { SessionStore } from "../../session/SessionStore.ts";
import { TranscriptWriter } from "../../session/TranscriptWriter.ts";
import type { RuntimeEvent } from "../../types/state.ts";
import { InboxWatcher } from "../InboxWatcher.ts";
import { StateHistoryWriter } from "../StateHistoryWriter.ts";
import { TaskDispatcher } from "../TaskDispatcher.ts";
import { quietLogger, sleep, waitFor, withTempScheduler } from "./helpers.ts";
import type { Agent } from "@codeflowmu/protocol";

function taskBody(
  taskId: string,
  recipient: string,
  threadKey: string,
  sender = "PM",
  dependsOn?: string,
): string {
  return `---
protocol: fcop
task_id: ${taskId}
sender: ${sender}
recipient: ${recipient}
thread_key: ${threadKey}
${dependsOn ? `depends_on: [${dependsOn}]\n` : ""}priority: P2
status: pending
---

# ${taskId}
`;
}

function makeAgent(role: string, id: string): Agent {
  return {
    agent_id: id,
    role,
    layer: "worker",
    node: "local",
    runtime: "local",
    skills: ["fcop"],
    status: "idle",
  };
}

describe("TaskDispatcher two-phase dispatch", () => {
  it("ADMIN→PM with empty parent: line does not false-hold as child_subtask", async () => {
    await withTempScheduler(async ({ inboxDir, stateDir }) => {
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
      const events: RuntimeEvent[] = [];
      sessionManager.onEvent((evt) => events.push(evt));
      const dispatcher = new TaskDispatcher({
        watcher: new InboxWatcher({ dir: inboxDir, logger: quietLogger() }),
        historyWriter: new StateHistoryWriter(),
        registry,
        sessionManager,
        logger: quietLogger(),
      });

      await registry.register(makeAgent("PM", "PM-01"));
      await dispatcher.start();

      const taskId = "TASK-20260618-100-ADMIN-to-PM";
      const filename = `${taskId}.md`;
      const filepath = join(inboxDir, filename);
      await writeFile(
        filepath,
        `---
protocol: fcop
version: "1.0"
sender: ADMIN
recipient: PM
thread_key: panel-task-100
parent: 
references: []
state: inbox
---

# Panel smoke — flat ADMIN mainline only

Body may mention \`parent: TASK-20260618-030\` without becoming a child hold.
`,
      );
      await sleep(300);

      await waitFor(
        () =>
          events.find((e) => e.event_type === "runtime.session_started") ?? null,
        { what: "PM session started (empty parent YAML)", timeoutMs: 4000 },
      );

      const raw = await readFile(filepath, "utf-8");
      assert.equal(raw.includes("reason=child_subtask"), false);
      assert.equal(raw.includes("`inbox` → `held`"), false);

      await dispatcher.stop();
    });
  });

  it("ADMIN→PM inbox auto-starts PM session (no held)", async () => {
    await withTempScheduler(async ({ inboxDir, stateDir }) => {
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
      const events: RuntimeEvent[] = [];
      sessionManager.onEvent((evt) => events.push(evt));
      const dispatcher = new TaskDispatcher({
        watcher: new InboxWatcher({ dir: inboxDir, logger: quietLogger() }),
        historyWriter: new StateHistoryWriter(),
        registry,
        sessionManager,
        logger: quietLogger(),
      });

      await registry.register(makeAgent("PM", "PM-01"));
      await dispatcher.start();

      const taskId = "TASK-20260610-110-ADMIN-to-PM";
      const filename = `${taskId}.md`;
      const filepath = join(inboxDir, filename);
      await writeFile(
        filepath,
        taskBody(taskId, "PM", "panel-task-115", "ADMIN"),
      );
      await sleep(300);

      await waitFor(
        () =>
          events.find((e) => e.event_type === "runtime.session_started") ?? null,
        { what: "PM session started", timeoutMs: 4000 },
      );

      const raw = await readFile(filepath, "utf-8");
      assert.equal(raw.includes("waiting_explicit_dispatch"), false);
      assert.equal(raw.includes("`inbox` → `held`"), false);

      await dispatcher.stop();
    });
  });

  it("PM→DEV inbox auto-dispatches session (trusted internal route)", async () => {
    await withTempScheduler(async ({ inboxDir, stateDir }) => {
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
      const events: RuntimeEvent[] = [];
      sessionManager.onEvent((evt) => events.push(evt));
      const dispatcher = new TaskDispatcher({
        watcher: new InboxWatcher({ dir: inboxDir, logger: quietLogger() }),
        historyWriter: new StateHistoryWriter(),
        registry,
        sessionManager,
        logger: quietLogger(),
      });

      await registry.register(makeAgent("DEV", "DEV-01"));
      await dispatcher.start();

      const taskId = "TASK-20260610-100-PM-to-DEV";
      const filename = `${taskId}.md`;
      const filepath = join(inboxDir, filename);
      await writeFile(filepath, taskBody(taskId, "DEV", "panel-task-111"));
      await sleep(300);

      await waitFor(
        () =>
          events.find((e) => e.event_type === "runtime.session_started") ?? null,
        { what: "DEV session started", timeoutMs: 4000 },
      );

      const raw = await readFile(filepath, "utf-8");
      assert.equal(raw.includes("awaiting explicit dispatch_task"), false);
      assert.equal(raw.includes("`inbox` → `held`"), false);
      assert.match(raw, /`inbox` → `dispatched`/);

      await dispatcher.stop();
    });
  });

  it("PM→OPS inbox auto-dispatches session", async () => {
    await withTempScheduler(async ({ inboxDir, stateDir }) => {
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
      const events: RuntimeEvent[] = [];
      sessionManager.onEvent((evt) => events.push(evt));
      const dispatcher = new TaskDispatcher({
        watcher: new InboxWatcher({ dir: inboxDir, logger: quietLogger() }),
        historyWriter: new StateHistoryWriter(),
        registry,
        sessionManager,
        logger: quietLogger(),
      });

      await registry.register(makeAgent("OPS", "OPS-01"));
      await dispatcher.start();

      const taskId = "TASK-20260610-103-PM-to-OPS";
      const filename = `${taskId}.md`;
      const filepath = join(inboxDir, filename);
      await writeFile(filepath, taskBody(taskId, "OPS", "panel-task-ops"));
      await sleep(300);

      await waitFor(
        () =>
          events.find((e) => e.event_type === "runtime.session_started") ?? null,
        { what: "OPS session started", timeoutMs: 4000 },
      );

      await dispatcher.stop();
    });
  });

  it("unknown external inbox file is held with reason=untrusted_source", async () => {
    await withTempScheduler(async ({ inboxDir, stateDir }) => {
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
      const events: RuntimeEvent[] = [];
      sessionManager.onEvent((evt) => events.push(evt));
      const dispatcher = new TaskDispatcher({
        watcher: new InboxWatcher({ dir: inboxDir, logger: quietLogger() }),
        historyWriter: new StateHistoryWriter(),
        registry,
        sessionManager,
        logger: quietLogger(),
      });

      await registry.register(makeAgent("DEV", "DEV-01"));
      await dispatcher.start();

      const taskId = "TASK-20260610-104-VENDOR-to-DEV";
      const filename = `${taskId}.md`;
      const filepath = join(inboxDir, filename);
      await writeFile(
        filepath,
        taskBody(taskId, "DEV", "external-import", "VENDOR"),
      );
      await sleep(300);

      await waitFor(
        async () => {
          const t = await readFile(filepath, "utf-8");
          return t.includes("reason=untrusted_source") ? true : null;
        },
        { what: "external held", timeoutMs: 4000 },
      );

      assert.equal((await sessionManager.listActive()).length, 0);

      // Watcher change events and periodic reconciliation must not append the
      // same held transition forever.
      await sleep(1_700);
      const heldRaw = await readFile(filepath, "utf-8");
      assert.equal(
        heldRaw.split("reason=untrusted_source; awaiting explicit dispatch_task")
          .length - 1,
        1,
      );

      await dispatcher.stop();
    });
  });

  it("PM prewrites DEV+QA+EVAL — QA dispatch blocked until DEV report", async () => {
    await withTempScheduler(async ({ rootDir, stateDir }) => {
      const projectRoot = rootDir;
      const fcopInbox = join(projectRoot, "fcop", "_lifecycle", "inbox");
      await mkdir(fcopInbox, { recursive: true });
      await mkdir(join(projectRoot, "fcop", "ledger"), { recursive: true });

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
      const dispatcher = new TaskDispatcher({
        watcher: new InboxWatcher({ dir: fcopInbox, logger: quietLogger() }),
        historyWriter: new StateHistoryWriter(),
        registry,
        sessionManager,
        projectRoot,
        logger: quietLogger(),
      });

      await registry.register(makeAgent("DEV", "DEV-01"));
      await registry.register(makeAgent("QA", "QA-01"));
      await dispatcher.start();

      const thread = "panel-task-111";
      const devId = "TASK-20260610-101-PM-to-DEV";
      const qaId = "TASK-20260610-102-PM-to-QA";
      const devPath = join(fcopInbox, `${devId}.md`);
      const qaPath = join(fcopInbox, `${qaId}.md`);
      await writeFile(devPath, taskBody(devId, "DEV", thread));
      await writeFile(qaPath, taskBody(qaId, "QA", thread, "PM", devId));
      await sleep(300);

      await waitFor(
        async () => {
          const t = await readFile(devPath, "utf-8");
          return t.includes("`inbox` → `dispatched`") ? true : null;
        },
        { what: "DEV auto-dispatched", timeoutMs: 4000 },
      );

      const qaSkip = await dispatcher.dispatchTaskFromControlPlane(
        qaPath,
        `${qaId}.md`,
        "QA",
      );
      assert.equal(qaSkip.kind, "dependency_pending", JSON.stringify(qaSkip));

      const explicitWake = await dispatcher.dispatchTaskFromControlPlane(
        qaPath,
        `${qaId}.md`,
        "QA",
        "pm_agent_tool",
        { bypassBusinessGates: true },
      );
      assert.equal(explicitWake.kind, "dispatched", JSON.stringify(explicitWake));

      await dispatcher.stop();
    });
  });

  it("undispatched wake path: inbox PM→EVAL returns task_not_dispatched via gate", async () => {
    const { isTaskRunnableForWake } = await import(
      "../../pm/taskDispatchGate.ts"
    );
    const held = {
      taskId: "TASK-20260610-105-PM-to-EVAL",
      filename: "TASK-20260610-105-PM-to-EVAL.md",
      recipient: "EVAL",
      sender: "PM",
      threadKey: "panel-task-111",
      lifecycleBucket: "inbox",
      fmState: "inbox",
    };
    const gate = isTaskRunnableForWake(held);
    assert.equal(gate.runnable, false);
    assert.equal(gate.reason, "task_not_dispatched");
  });
});
