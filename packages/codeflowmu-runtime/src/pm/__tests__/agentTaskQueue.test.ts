import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dequeueNextAgentTask,
  emptyAgentTaskQueue,
  enqueueAgentTask,
  getTaskDispatchStatusFromState,
  isTaskPaused,
  isTaskQueued,
  loadAgentTaskQueue,
  pauseAgentTask,
  saveAgentTaskQueue,
  removeTaskFromAgentQueue,
  resumePausedTask,
  setAgentRunning,
  snapshotAgentQueues,
  withAgentTaskQueue,
} from "../agentTaskQueue.ts";
import {
  enqueueTaskWhenAgentBusy,
  isTaskPathEnqueueAllowed,
  pauseTaskExecution,
} from "../agentTaskQueueControl.ts";
import { detectPrimaryDeadlock } from "../autoRecovery/DeadlockDetector.ts";
import type { DeadlockDetectContext } from "../autoRecovery/deadlockTypes.ts";

describe("agentTaskQueue", () => {
  it("FIFO enqueue and dequeue by queued_at", () => {
    const state = emptyAgentTaskQueue();
    enqueueAgentTask(state, {
      task_id: "TASK-20260611-001",
      agent_id: "QA-01",
      reason: "agent_busy",
      queued_at: "2026-06-11T10:00:00.000Z",
    });
    enqueueAgentTask(state, {
      task_id: "TASK-20260611-002",
      agent_id: "QA-01",
      reason: "agent_busy",
      queued_at: "2026-06-11T10:01:00.000Z",
    });
    const first = dequeueNextAgentTask(state, "QA-01");
    assert.equal(first?.task_id, "TASK-20260611-001");
    const second = dequeueNextAgentTask(state, "QA-01");
    assert.equal(second?.task_id, "TASK-20260611-002");
  });

  it("paused task is not stale_busy candidate", () => {
    const ctx: DeadlockDetectContext = {
      projectRoot: mkdtempSync(join(tmpdir(), "queue-")),
      trigger: "watchdog",
      taskId: "TASK-20260611-028",
      role: "DEV",
      agentId: "DEV-01",
      dispatchStatusPaused: true,
      reasonCode: "stale_busy_no_session",
      agentRunning: true,
      hasActiveSession: false,
      agentStatus: "running",
    };
    assert.equal(detectPrimaryDeadlock(ctx), null);
  });

  it("queued task is not stale_busy candidate", () => {
    const ctx: DeadlockDetectContext = {
      projectRoot: mkdtempSync(join(tmpdir(), "queue-")),
      trigger: "watchdog",
      taskId: "TASK-20260611-029",
      role: "QA",
      agentId: "QA-01",
      dispatchStatusQueued: true,
      reasonCode: "stale_busy_no_session",
      agentRunning: true,
      hasActiveSession: false,
      agentStatus: "running",
    };
    assert.equal(detectPrimaryDeadlock(ctx), null);
  });

  it("pause marks dispatch_status paused; resume re-queues with resume_dispatch", () => {
    const state = emptyAgentTaskQueue();
    setAgentRunning(state, "DEV-01", {
      task_id: "TASK-20260611-028",
      session_id: "session-x",
      started_at: new Date().toISOString(),
    });
    pauseAgentTask(state, {
      task_id: "TASK-20260611-028",
      agent_id: "DEV-01",
      dispatch_status: "paused",
      paused_at: new Date().toISOString(),
      paused_by: "ADMIN",
      pause_reason: "test pause",
    });
    assert.equal(
      getTaskDispatchStatusFromState(state, "TASK-20260611-028"),
      "paused",
    );
    assert.ok(isTaskPaused(state, "TASK-20260611-028"));

    resumePausedTask(state, "TASK-20260611-028", { priority: true });
    assert.equal(
      getTaskDispatchStatusFromState(state, "TASK-20260611-028"),
      "queued",
    );
    assert.ok(isTaskQueued(state, "TASK-20260611-028"));
    const snap = snapshotAgentQueues(state);
    const item = snap.tasks.find((t) => t.task_id === "TASK-20260611-028");
    assert.equal(item?.dispatch_status, "queued");
    assert.equal(item?.queue_position, 1);
    const slot = state.agents["DEV-01"];
    assert.equal(slot?.queue[0]?.resume_dispatch, true);
  });

  it("pause retries cancellation when queue already says paused but session is still live", async () => {
    const root = mkdtempSync(join(tmpdir(), "queue-pause-live-"));
    const taskId = "TASK-20260611-030";
    const activeDir = join(root, "fcop", "_lifecycle", "active");
    mkdirSync(activeDir, { recursive: true });
    writeFileSync(
      join(activeDir, `${taskId}-PM-to-DEV.md`),
      "---\nprotocol: fcop\nsender: PM\nrecipient: DEV\n---\n# task\n",
      "utf-8",
    );
    const state = emptyAgentTaskQueue();
    pauseAgentTask(state, {
      task_id: taskId,
      agent_id: "DEV-01",
      dispatch_status: "paused",
      paused_at: new Date().toISOString(),
      paused_by: "ADMIN",
      pause_reason: "first click",
    });
    await saveAgentTaskQueue(root, state);

    const sessions = [
      {
        protocol: {
          session_id: "session-live",
          agent_id: "DEV-01",
          task_id: taskId,
        },
      },
    ];
    const cancelled: string[] = [];
    try {
      const result = await pauseTaskExecution({
        projectRoot: root,
        taskId,
        agentId: "DEV-01",
        sessionManager: {
          listActive: async () => sessions,
          cancelSession: async (sessionId: string) => {
            cancelled.push(sessionId);
            sessions.splice(0, sessions.length);
          },
        } as never,
        forceReleaseAgent: async () => ({ ok: true }),
        dispatcher: {
          dispatchTaskFromControlPlane: async () => ({ kind: "already_dispatched" }),
        } as never,
      });
      assert.equal(result.ok, true);
      assert.deepEqual(cancelled, ["session-live"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects enqueue for archive lifecycle path", () => {
    const root = mkdtempSync(join(tmpdir(), "queue-archive-"));
    const archivePath = join(
      root,
      "fcop",
      "_lifecycle",
      "archive",
      "TASK-20260611-038-PM-to-QA.md",
    );
    assert.equal(isTaskPathEnqueueAllowed(root, archivePath), false);
  });

  it("removeTaskFromAgentQueue clears running, queued, and paused slots", async () => {
    const root = mkdtempSync(join(tmpdir(), "queue-rm-"));
    await withAgentTaskQueue(root, (state) => {
      setAgentRunning(state, "QA-01", {
        task_id: "TASK-20260611-035",
        session_id: "session-a",
        started_at: new Date().toISOString(),
      });
      enqueueAgentTask(state, {
        task_id: "TASK-20260611-038",
        agent_id: "QA-01",
        reason: "agent_busy",
      });
      pauseAgentTask(state, {
        task_id: "TASK-20260611-040",
        agent_id: "QA-01",
        dispatch_status: "paused",
        paused_at: new Date().toISOString(),
        paused_by: "ADMIN",
        pause_reason: "test",
      });
    });

    await removeTaskFromAgentQueue(root, "TASK-20260611-035");
    let file = await loadAgentTaskQueue(root);
    assert.equal(file.agents["QA-01"]?.running, null);

    await removeTaskFromAgentQueue(root, "TASK-20260611-038");
    file = await loadAgentTaskQueue(root);
    assert.equal(file.agents["QA-01"]?.queue.length, 0);

    await removeTaskFromAgentQueue(root, "TASK-20260611-040");
    file = await loadAgentTaskQueue(root);
    assert.equal(file.paused["TASK-20260611-040"], undefined);
  });

  it("enqueueTaskWhenAgentBusy skips archive fixture paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "queue-enq-"));
    const archivePath = join(
      root,
      "fcop",
      "_lifecycle",
      "archive",
      "TASK-20260611-038-PM-to-QA.md",
    );
    const result = await enqueueTaskWhenAgentBusy({
      projectRoot: root,
      taskId: "TASK-20260611-038",
      agentId: "QA-01",
      reason: "wake_while_agent_busy",
      filepath: archivePath,
      filename: "TASK-20260611-038-PM-to-QA.md",
      recipient: "QA",
    });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "task_not_enqueueable");
  });
});
