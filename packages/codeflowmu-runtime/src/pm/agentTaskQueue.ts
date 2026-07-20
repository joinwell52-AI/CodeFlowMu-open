/**
 * Per-agent FIFO task queue with pause/resume state.
 * Persisted at `.codeflowmu/pm-governance/agent-task-queue.json`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { pmGovernanceDir } from "./PmGovernancePlanner.ts";

export type DispatchStatus = "running" | "queued" | "paused";

export interface AgentQueueRunningEntry {
  task_id: string;
  session_id: string;
  started_at: string;
}

export interface AgentQueuePendingEntry {
  task_id: string;
  agent_id: string;
  queued_at: string;
  reason: string;
  filepath?: string;
  role?: string;
}

/** Queue item with dispatch metadata (TaskDispatcher / API). */
export interface AgentQueueItem extends AgentQueuePendingEntry {
  filename?: string;
  recipient?: string;
  resume_dispatch?: boolean;
}

export interface AgentQueueSlot {
  running: AgentQueueRunningEntry | null;
  queue: AgentQueueItem[];
}

export interface PausedTaskEntry {
  task_id: string;
  agent_id: string;
  dispatch_status: "paused";
  paused_at: string;
  paused_by: string;
  pause_reason: string;
}

export interface PausedTaskRecord extends PausedTaskEntry {
  filepath?: string;
  filename?: string;
}

export interface AgentTaskQueueFile {
  version: "1.0.0";
  updated_at: string;
  agents: Record<string, AgentQueueSlot>;
  paused: Record<string, PausedTaskEntry>;
}

export const RESUME_EXECUTION_PROMPT_ZH =
  "[恢复执行] 本任务曾被暂停，现由 ADMIN/PM 恢复。请优先沿用已有证据与上下文，必要时直接 write_report；禁止重复从零探查。";

export function agentTaskQueuePath(projectRoot: string): string {
  return join(pmGovernanceDir(projectRoot), "agent-task-queue.json");
}

export function normQueueTaskId(taskId: string): string {
  return String(taskId ?? "")
    .replace(/\.md$/i, "")
    .trim()
    .toUpperCase();
}

export const normalizeQueueTaskId = normQueueTaskId;

export function emptyAgentTaskQueue(now = new Date().toISOString()): AgentTaskQueueFile {
  return {
    version: "1.0.0",
    updated_at: now,
    agents: {},
    paused: {},
  };
}

export async function loadAgentTaskQueue(
  projectRoot: string,
): Promise<AgentTaskQueueFile> {
  const path = agentTaskQueuePath(projectRoot);
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as AgentTaskQueueFile;
    if (parsed?.version === "1.0.0") {
      parsed.agents ??= {};
      parsed.paused ??= {};
      return parsed;
    }
  } catch {
    /* fall through */
  }
  return emptyAgentTaskQueue();
}

export async function saveAgentTaskQueue(
  projectRoot: string,
  state: AgentTaskQueueFile,
): Promise<void> {
  state.updated_at = new Date().toISOString();
  const dir = pmGovernanceDir(projectRoot);
  await mkdir(dir, { recursive: true });
  await writeFile(
    agentTaskQueuePath(projectRoot),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf-8",
  );
}

export async function withAgentTaskQueue(
  projectRoot: string,
  mutate: (state: AgentTaskQueueFile) => void,
): Promise<AgentTaskQueueFile> {
  const state = await loadAgentTaskQueue(projectRoot);
  mutate(state);
  await saveAgentTaskQueue(projectRoot, state);
  return state;
}

function ensureAgentSlot(
  state: AgentTaskQueueFile,
  agentId: string,
): AgentQueueSlot {
  const id = String(agentId).trim();
  if (!state.agents[id]) {
    state.agents[id] = { running: null, queue: [] };
  }
  return state.agents[id]!;
}

type QueueEntryInput = Omit<AgentQueueItem, "queued_at"> & { queued_at?: string };

function enqueueAgentTaskInState(
  state: AgentTaskQueueFile,
  entry: QueueEntryInput,
  opts?: { atFront?: boolean },
): void {
  const taskId = normQueueTaskId(entry.task_id);
  const agentId = String(entry.agent_id).trim();
  if (!taskId || !agentId) return;

  delete state.paused[taskId];

  const slot = ensureAgentSlot(state, agentId);
  const item: AgentQueueItem = {
    ...entry,
    task_id: taskId,
    agent_id: agentId,
    queued_at: entry.queued_at ?? new Date().toISOString(),
  };

  slot.queue = slot.queue.filter((q) => normQueueTaskId(q.task_id) !== taskId);
  if (opts?.atFront) {
    slot.queue.unshift(item);
  } else {
    slot.queue.push(item);
  }
  slot.queue.sort((a, b) => a.queued_at.localeCompare(b.queued_at));
  if (opts?.atFront) {
    const idx = slot.queue.findIndex((q) => normQueueTaskId(q.task_id) === taskId);
    if (idx > 0) {
      const [picked] = slot.queue.splice(idx, 1);
      slot.queue.unshift(picked!);
    }
  }
}

export function enqueueAgentTask(
  state: AgentTaskQueueFile,
  entry: QueueEntryInput,
  opts?: { atFront?: boolean },
): void;
export function enqueueAgentTask(
  projectRoot: string,
  entry: QueueEntryInput,
  opts?: { atFront?: boolean },
): Promise<AgentTaskQueueFile>;
export function enqueueAgentTask(
  stateOrRoot: AgentTaskQueueFile | string,
  entry: QueueEntryInput,
  opts?: { atFront?: boolean },
): void | Promise<AgentTaskQueueFile> {
  if (typeof stateOrRoot === "string") {
    return (async () => {
      const state = await loadAgentTaskQueue(stateOrRoot);
      enqueueAgentTaskInState(state, entry, opts);
      await saveAgentTaskQueue(stateOrRoot, state);
      return state;
    })();
  }
  enqueueAgentTaskInState(stateOrRoot, entry, opts);
}

export function setAgentRunning(
  state: AgentTaskQueueFile,
  agentId: string,
  running: AgentQueueRunningEntry,
): void;
export function setAgentRunning(
  projectRoot: string,
  agentId: string,
  taskId: string,
  sessionId: string,
): Promise<void>;
export function setAgentRunning(
  stateOrRoot: AgentTaskQueueFile | string,
  agentId: string,
  runningOrTaskId: AgentQueueRunningEntry | string,
  sessionId?: string,
): void | Promise<void> {
  if (typeof stateOrRoot === "string") {
    return (async () => {
      const state = await loadAgentTaskQueue(stateOrRoot);
      const normId = normQueueTaskId(runningOrTaskId as string);
      const slot = ensureAgentSlot(state, agentId);
      slot.running = {
        task_id: normId,
        session_id: String(sessionId ?? ""),
        started_at: new Date().toISOString(),
      };
      slot.queue = slot.queue.filter(
        (q) => normQueueTaskId(q.task_id) !== normId,
      );
      delete state.paused[normId];
      await saveAgentTaskQueue(stateOrRoot, state);
    })();
  }
  const running = runningOrTaskId as AgentQueueRunningEntry;
  const normId = normQueueTaskId(running.task_id);
  const slot = ensureAgentSlot(stateOrRoot, agentId);
  slot.running = {
    ...running,
    task_id: normId,
  };
  slot.queue = slot.queue.filter((q) => normQueueTaskId(q.task_id) !== normId);
  delete stateOrRoot.paused[normId];
}

export function clearAgentRunning(
  state: AgentTaskQueueFile,
  agentId: string,
  taskId?: string,
): void;
export function clearAgentRunning(
  projectRoot: string,
  agentId: string,
  taskId?: string,
): Promise<void>;
export function clearAgentRunning(
  stateOrRoot: AgentTaskQueueFile | string,
  agentId: string,
  taskId?: string,
): void | Promise<void> {
  if (typeof stateOrRoot === "string") {
    return (async () => {
      const state = await loadAgentTaskQueue(stateOrRoot);
      clearAgentRunningInState(state, agentId, taskId);
      await saveAgentTaskQueue(stateOrRoot, state);
    })();
  }
  clearAgentRunningInState(stateOrRoot, agentId, taskId);
}

function clearAgentRunningInState(
  state: AgentTaskQueueFile,
  agentId: string,
  taskId?: string,
): void {
  const slot = state.agents[String(agentId).trim()];
  if (!slot?.running) return;
  if (taskId && normQueueTaskId(taskId) !== normQueueTaskId(slot.running.task_id)) {
    return;
  }
  slot.running = null;
}

export function pauseAgentTask(
  state: AgentTaskQueueFile,
  record: PausedTaskRecord,
): void {
  const normId = normQueueTaskId(record.task_id);
  const agentId = String(record.agent_id).trim();
  const slot = ensureAgentSlot(state, agentId);
  slot.queue = slot.queue.filter((q) => normQueueTaskId(q.task_id) !== normId);
  if (slot.running && normQueueTaskId(slot.running.task_id) === normId) {
    slot.running = null;
  }
  state.paused[normId] = {
    task_id: normId,
    agent_id: agentId,
    dispatch_status: "paused",
    paused_at: record.paused_at,
    paused_by: record.paused_by,
    pause_reason: record.pause_reason,
  };
}

export function resumePausedTask(
  state: AgentTaskQueueFile,
  taskId: string,
  opts?: { priority?: boolean },
): boolean {
  const normId = normQueueTaskId(taskId);
  const paused = state.paused[normId];
  if (!paused) return false;
  delete state.paused[normId];
  enqueueAgentTaskInState(
    state,
    {
      task_id: normId,
      agent_id: paused.agent_id,
      reason: opts?.priority ? "resume_priority" : "resume_fifo",
      resume_dispatch: true,
      filepath: (paused as PausedTaskRecord).filepath,
      filename: (paused as PausedTaskRecord).filename,
    },
    { atFront: opts?.priority === true },
  );
  return true;
}

export function dequeueNextAgentTask(
  state: AgentTaskQueueFile,
  agentId: string,
): AgentQueueItem | null {
  const slot = state.agents[String(agentId).trim()];
  if (!slot || slot.running) return null;
  return slot.queue.shift() ?? null;
}

export async function removeTaskFromAgentQueue(
  projectRoot: string,
  taskId: string,
): Promise<void> {
  const normId = normQueueTaskId(taskId);
  const state = await loadAgentTaskQueue(projectRoot);
  let changed = false;
  for (const slot of Object.values(state.agents)) {
    const before = slot.queue.length;
    slot.queue = slot.queue.filter((q) => normQueueTaskId(q.task_id) !== normId);
    if (slot.queue.length !== before) changed = true;
    if (slot.running && normQueueTaskId(slot.running.task_id) === normId) {
      slot.running = null;
      changed = true;
    }
  }
  if (state.paused[normId]) {
    delete state.paused[normId];
    changed = true;
  }
  if (changed) await saveAgentTaskQueue(projectRoot, state);
}

export async function pauseTaskInQueue(
  projectRoot: string,
  taskId: string,
  agentId: string,
  pausedBy: string,
  pauseReason: string,
): Promise<PausedTaskEntry> {
  const state = await loadAgentTaskQueue(projectRoot);
  const entry: PausedTaskRecord = {
    task_id: taskId,
    agent_id: agentId,
    dispatch_status: "paused",
    paused_at: new Date().toISOString(),
    paused_by: pausedBy,
    pause_reason: pauseReason,
  };
  pauseAgentTask(state, entry);
  await saveAgentTaskQueue(projectRoot, state);
  return state.paused[normQueueTaskId(taskId)]!;
}

export async function clearPausedTask(
  projectRoot: string,
  taskId: string,
): Promise<boolean> {
  const normId = normQueueTaskId(taskId);
  const state = await loadAgentTaskQueue(projectRoot);
  if (!state.paused[normId]) return false;
  delete state.paused[normId];
  await saveAgentTaskQueue(projectRoot, state);
  return true;
}

export async function dequeueNextForAgent(
  projectRoot: string,
  agentId: string,
): Promise<AgentQueueItem | null> {
  const state = await loadAgentTaskQueue(projectRoot);
  const next = dequeueNextAgentTask(state, agentId);
  if (next) await saveAgentTaskQueue(projectRoot, state);
  return next;
}

export async function peekAgentQueue(
  projectRoot: string,
): Promise<AgentTaskQueueFile> {
  return loadAgentTaskQueue(projectRoot);
}

export function isTaskPausedInState(
  state: AgentTaskQueueFile,
  taskId: string,
): boolean {
  return Boolean(state.paused[normQueueTaskId(taskId)]);
}

export const isTaskPaused = isTaskPausedInState;

export function isTaskQueuedInState(
  state: AgentTaskQueueFile,
  taskId: string,
): boolean {
  const normId = normQueueTaskId(taskId);
  for (const slot of Object.values(state.agents)) {
    if (slot.queue.some((q) => normQueueTaskId(q.task_id) === normId)) return true;
  }
  return false;
}

export const isTaskQueued = isTaskQueuedInState;

export function isTaskRunningInState(
  state: AgentTaskQueueFile,
  taskId: string,
): boolean {
  const normId = normQueueTaskId(taskId);
  for (const slot of Object.values(state.agents)) {
    if (
      slot.running &&
      normQueueTaskId(slot.running.task_id) === normId
    ) {
      return true;
    }
  }
  return false;
}

export function getTaskDispatchStatusFromState(
  state: AgentTaskQueueFile,
  taskId: string,
): DispatchStatus | null {
  const normId = normQueueTaskId(taskId);
  if (state.paused[normId]) return "paused";
  if (isTaskRunningInState(state, normId)) return "running";
  if (isTaskQueuedInState(state, normId)) return "queued";
  return null;
}

export function getTaskDispatchStatus(
  state: AgentTaskQueueFile,
  taskId: string,
): DispatchStatus | null;
export function getTaskDispatchStatus(
  projectRoot: string,
  taskId: string,
): Promise<DispatchStatus | null>;
export function getTaskDispatchStatus(
  stateOrRoot: AgentTaskQueueFile | string,
  taskId: string,
): DispatchStatus | null | Promise<DispatchStatus | null> {
  if (typeof stateOrRoot === "string") {
    return loadAgentTaskQueue(stateOrRoot).then((state) =>
      getTaskDispatchStatusFromState(state, taskId),
    );
  }
  return getTaskDispatchStatusFromState(stateOrRoot, taskId);
}

export function getQueuePositionFromState(
  state: AgentTaskQueueFile,
  taskId: string,
): number | null {
  const normId = normQueueTaskId(taskId);
  for (const slot of Object.values(state.agents)) {
    const idx = slot.queue.findIndex((q) => normQueueTaskId(q.task_id) === normId);
    if (idx >= 0) return idx + 1;
  }
  return null;
}

export function isAgentIdleInState(
  state: AgentTaskQueueFile,
  agentId: string,
): boolean {
  const slot = state.agents[String(agentId).trim()];
  return !slot?.running;
}

export function snapshotAgentQueues(state: AgentTaskQueueFile): {
  agents: AgentTaskQueueFile["agents"];
  paused: AgentTaskQueueFile["paused"];
  tasks: Array<{
    task_id: string;
    agent_id: string;
    dispatch_status: DispatchStatus;
    queue_position?: number;
  }>;
} {
  const tasks: Array<{
    task_id: string;
    agent_id: string;
    dispatch_status: DispatchStatus;
    queue_position?: number;
  }> = [];

  for (const [agentId, slot] of Object.entries(state.agents)) {
    if (slot.running) {
      tasks.push({
        task_id: slot.running.task_id,
        agent_id: agentId,
        dispatch_status: "running",
      });
    }
    slot.queue.forEach((q, idx) => {
      tasks.push({
        task_id: q.task_id,
        agent_id: agentId,
        dispatch_status: "queued",
        queue_position: idx + 1,
      });
    });
  }
  for (const p of Object.values(state.paused)) {
    tasks.push({
      task_id: p.task_id,
      agent_id: p.agent_id,
      dispatch_status: "paused",
    });
  }

  return {
    agents: state.agents,
    paused: state.paused,
    tasks,
  };
}
