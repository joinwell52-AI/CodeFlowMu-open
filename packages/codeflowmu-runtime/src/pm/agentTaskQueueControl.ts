/**
 * High-level pause / resume / queue advance for Runtime + Panel API.
 */

import { promises as fs } from "node:fs";

import type { AgentRegistry } from "../registry/AgentRegistry.ts";
import type { SessionManager } from "../session/SessionManager.ts";
import type { TaskDispatcher } from "../scheduler/TaskDispatcher.ts";
import {
  findTaskPathByIdSync,
  stageFromPath,
} from "../lifecycle/taskPathUtils.ts";
import { join } from "node:path";
import {
  clearAgentRunning,
  dequeueNextAgentTask,
  enqueueAgentTask,
  getTaskDispatchStatusFromState,
  isTaskRunningInState,
  loadAgentTaskQueue,
  normalizeQueueTaskId,
  pauseAgentTask,
  resumePausedTask,
  saveAgentTaskQueue,
  setAgentRunning,
  snapshotAgentQueues,
  withAgentTaskQueue,
  type DispatchStatus,
  type PausedTaskRecord,
} from "./agentTaskQueue.ts";

const ENQUEUE_ALLOWED_STAGES = new Set(["inbox", "active", "review"]);

export function isTaskPathEnqueueAllowed(
  projectRoot: string,
  filepath?: string,
): boolean {
  if (!filepath) return true;
  const lifecycleRoot = join(projectRoot, "fcop", "_lifecycle");
  const stage = stageFromPath(filepath, lifecycleRoot);
  if (!stage) return true;
  return ENQUEUE_ALLOWED_STAGES.has(stage);
}

export interface PauseTaskExecutionOpts {
  projectRoot: string;
  taskId: string;
  agentId: string;
  pausedBy?: string;
  pauseReason?: string;
  sessionManager: SessionManager;
  forceReleaseAgent: (agentId: string, reason: string) => Promise<{ ok: boolean }>;
  dispatcher: TaskDispatcher;
}

export interface PauseTaskExecutionResult {
  ok: boolean;
  task_id: string;
  agent_id: string;
  dispatch_status?: DispatchStatus;
  error?: string;
  detail?: string;
}

export interface ResumeTaskExecutionOpts {
  projectRoot: string;
  taskId: string;
  priority?: boolean;
  dispatcher: TaskDispatcher;
  registry: AgentRegistry;
}

export interface ResumeTaskExecutionResult {
  ok: boolean;
  task_id: string;
  agent_id?: string;
  dispatch_status?: DispatchStatus;
  error?: string;
  detail?: string;
}

function locateTaskFile(projectRoot: string, taskId: string): {
  path: string;
  filename: string;
} | null {
  const lifecycleRoot = join(projectRoot, "fcop", "_lifecycle");
  const located = findTaskPathByIdSync(lifecycleRoot, taskId);
  if (!located) return null;
  const filename = located.path.split(/[/\\]/).pop() ?? `${taskId}.md`;
  return { path: located.path, filename };
}

async function patchDisplayStatusPaused(
  filepath: string,
  pauseReason: string,
): Promise<void> {
  try {
    const raw = await fs.readFile(filepath, "utf-8");
    const re = /^(---\r?\n)([\s\S]*?)(\r?\n---)/;
    const m = raw.match(re);
    if (!m) return;
    const yamlBody = m[2] ?? "";
    const lines = yamlBody.split(/\r?\n/).filter((l) => {
      const t = l.trim();
      return (
        !t.startsWith("display_status:") &&
        !t.startsWith("pause_reason:")
      );
    });
    lines.push("display_status: paused_by_admin");
    lines.push(`pause_reason: "${pauseReason.replace(/"/g, '\\"')}"`);
    const patched = raw.replace(re, `${m[1]}${lines.join("\n")}${m[3]}`);
    await fs.writeFile(filepath, patched, "utf-8");
  } catch {
    /* best-effort display only */
  }
}

export async function pauseTaskExecution(
  opts: PauseTaskExecutionOpts,
): Promise<PauseTaskExecutionResult> {
  const taskId = normalizeQueueTaskId(opts.taskId);
  const agentId = opts.agentId.trim();
  if (!taskId || !agentId) {
    return { ok: false, task_id: taskId, agent_id: agentId, error: "missing_params" };
  }

  const file = await loadAgentTaskQueue(opts.projectRoot);
  const status = getTaskDispatchStatusFromState(file, taskId);
  const active = await opts.sessionManager.listActive();
  const liveSession = active.find(
    (s) =>
      s.protocol.agent_id === agentId &&
      normalizeQueueTaskId(s.protocol.task_id ?? "") === taskId,
  );
  const liveTaskId = normalizeQueueTaskId(liveSession?.protocol.task_id ?? "");
  if (status === "paused" && !liveSession) {
    return {
      ok: true,
      task_id: taskId,
      agent_id: agentId,
      dispatch_status: "paused",
    };
  }
  if (status === "queued") {
    if (liveSession && liveTaskId === taskId) {
      await withAgentTaskQueue(opts.projectRoot, (state) => {
        setAgentRunning(state, agentId, {
          task_id: taskId,
          session_id: liveSession.protocol.session_id,
          started_at: new Date().toISOString(),
        });
      });
    } else {
      return {
        ok: false,
        task_id: taskId,
        agent_id: agentId,
        error: "not_running",
        detail: "cannot pause a queued task",
      };
    }
  } else if (
    status !== "running" &&
    liveSession &&
    liveTaskId === taskId
  ) {
    await withAgentTaskQueue(opts.projectRoot, (state) => {
      setAgentRunning(state, agentId, {
        task_id: taskId,
        session_id: liveSession.protocol.session_id,
        started_at: new Date().toISOString(),
      });
    });
  } else if (
    status !== "running" &&
    !isTaskRunningInState(file, taskId) &&
    !liveSession
  ) {
    return {
      ok: false,
      task_id: taskId,
      agent_id: agentId,
      error: "not_running",
      detail: "task is not running",
    };
  }

  const located = locateTaskFile(opts.projectRoot, taskId);
  const pauseReason = opts.pauseReason ?? "ADMIN interrupted current execution";
  const pausedBy = opts.pausedBy ?? "ADMIN";

  const session = liveSession;
  if (session) {
    try {
      await opts.sessionManager.cancelSession(
        session.protocol.session_id,
        pauseReason,
      );
    } catch (err) {
      return {
        ok: false,
        task_id: taskId,
        agent_id: agentId,
        error: "session_cancel_failed",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const release = await opts.forceReleaseAgent(agentId, pauseReason);
  if (!release.ok) {
    return {
      ok: false,
      task_id: taskId,
      agent_id: agentId,
      error: "release_failed",
      detail: "forceReleaseAgent failed",
    };
  }

  const stillRunning = (await opts.sessionManager.listActive()).some(
    (s) =>
      s.protocol.agent_id === agentId &&
      normalizeQueueTaskId(s.protocol.task_id ?? "") === taskId,
  );
  if (stillRunning) {
    return {
      ok: false,
      task_id: taskId,
      agent_id: agentId,
      error: "session_still_running",
      detail: "session cancellation did not reach a terminal state",
    };
  }

  const record: PausedTaskRecord = {
    task_id: taskId,
    agent_id: agentId,
    dispatch_status: "paused",
    paused_at: new Date().toISOString(),
    paused_by: pausedBy,
    pause_reason: pauseReason,
    filepath: located?.path,
    filename: located?.filename,
  };
  pauseAgentTask(file, record);
  await saveAgentTaskQueue(opts.projectRoot, file);

  if (located?.path) {
    await patchDisplayStatusPaused(located.path, pauseReason);
  }

  await advanceAgentQueue({
    projectRoot: opts.projectRoot,
    agentId,
    dispatcher: opts.dispatcher,
  });

  return {
    ok: true,
    task_id: taskId,
    agent_id: agentId,
    dispatch_status: "paused",
  };
}

export async function resumeTaskExecution(
  opts: ResumeTaskExecutionOpts,
): Promise<ResumeTaskExecutionResult> {
  const taskId = normalizeQueueTaskId(opts.taskId);
  if (!taskId) {
    return { ok: false, task_id: taskId, error: "missing_params" };
  }

  const file = await loadAgentTaskQueue(opts.projectRoot);
  const paused = file.paused[taskId];
  if (!paused) {
    return {
      ok: false,
      task_id: taskId,
      error: "not_paused",
      detail: "task is not in paused state",
    };
  }

  resumePausedTask(file, taskId, { priority: opts.priority === true });
  await saveAgentTaskQueue(opts.projectRoot, file);

  const dispatched = await advanceAgentQueue({
    projectRoot: opts.projectRoot,
    agentId: paused.agent_id,
    dispatcher: opts.dispatcher,
  });

  const after = await loadAgentTaskQueue(opts.projectRoot);
  const status = getTaskDispatchStatusFromState(after, taskId);

  return {
    ok: true,
    task_id: taskId,
    agent_id: paused.agent_id,
    dispatch_status: status ?? (dispatched ? "running" : "queued"),
  };
}

export async function advanceAgentQueue(opts: {
  projectRoot: string;
  agentId: string;
  completedTaskId?: string;
  clearStaleRunning?: boolean;
  dispatcher: TaskDispatcher;
}): Promise<boolean> {
  const agentId = opts.agentId.trim();
  if (!agentId) return false;

  const file = await loadAgentTaskQueue(opts.projectRoot);
  if (opts.completedTaskId) {
    clearAgentRunning(file, agentId, opts.completedTaskId);
  } else if (opts.clearStaleRunning) {
    clearAgentRunning(file, agentId);
  }

  const nextItem = dequeueNextAgentTask(file, agentId);
  await saveAgentTaskQueue(opts.projectRoot, file);

  if (!nextItem?.filepath || !nextItem?.filename) return false;

  const outcome = await opts.dispatcher.dispatchTaskFromControlPlane(
    nextItem.filepath,
    nextItem.filename,
    nextItem.recipient,
    "agent_queue",
  );
  return outcome.kind === "dispatched";
}

export async function completeAgentTaskAndAdvance(opts: {
  projectRoot: string;
  agentId: string;
  taskId: string;
  sessionId?: string;
  dispatcher: TaskDispatcher;
}): Promise<void> {
  const file = await loadAgentTaskQueue(opts.projectRoot);
  const slot = file.agents[opts.agentId];
  let cleared = false;
  if (slot?.running) {
    if (opts.sessionId && slot.running.session_id !== opts.sessionId) {
      return;
    }
    clearAgentRunning(file, opts.agentId, opts.taskId);
    await saveAgentTaskQueue(opts.projectRoot, file);
    cleared = true;
  }
  if (!cleared) return;
  await advanceAgentQueue({
    projectRoot: opts.projectRoot,
    agentId: opts.agentId,
    dispatcher: opts.dispatcher,
  });
}

/** Bind a live runtime session to the persistent agent FIFO running slot. */
export async function syncQueueOnSessionStarted(opts: {
  projectRoot: string;
  agentId: string;
  taskId: string;
  sessionId: string;
}): Promise<void> {
  const agentId = opts.agentId.trim();
  const taskId = normalizeQueueTaskId(opts.taskId);
  const sessionId = String(opts.sessionId ?? "").trim();
  if (!agentId || !taskId || !sessionId) return;
  await withAgentTaskQueue(opts.projectRoot, (file) => {
    setAgentRunning(file, agentId, {
      task_id: taskId,
      session_id: sessionId,
      started_at: new Date().toISOString(),
    });
  });
}

export async function getAgentQueueApiSnapshot(projectRoot: string): Promise<{
  updated_at: string;
  agents: ReturnType<typeof snapshotAgentQueues>;
}> {
  const file = await loadAgentTaskQueue(projectRoot);
  return {
    updated_at: file.updated_at,
    agents: snapshotAgentQueues(file),
  };
}

/** Enqueue a task when the target agent already has a running session. */
export async function enqueueTaskWhenAgentBusy(opts: {
  projectRoot: string;
  taskId: string;
  agentId: string;
  reason: string;
  filepath?: string;
  filename?: string;
  recipient?: string;
}): Promise<{ ok: boolean; skipped?: boolean; reason?: string }> {
  if (!isTaskPathEnqueueAllowed(opts.projectRoot, opts.filepath)) {
    return { ok: false, skipped: true, reason: "task_not_enqueueable" };
  }
  await withAgentTaskQueue(opts.projectRoot, (file) => {
    enqueueAgentTask(file, {
      task_id: opts.taskId,
      agent_id: opts.agentId,
      reason: opts.reason,
      filepath: opts.filepath,
      filename: opts.filename,
      recipient: opts.recipient,
    });
  });
  return { ok: true };
}
