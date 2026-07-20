/**
 * Persisted auto-recovery counters / dedup (`.codeflowmu/pm-governance/recovery-attempts.json`).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  AUTO_RECOVERY_DEDUP_MS,
  AUTO_RECOVERY_MAX_PER_TASK_AGENT,
  type DeadlockKind,
} from "./deadlockTypes.ts";

interface RecoveryCounterEntry {
  count: number;
  lastAt: string;
}

interface AutoRecoveryStateFile {
  version: 1;
  recoveryCount: Record<string, RecoveryCounterEntry>;
  kindAttempts: Record<string, RecoveryCounterEntry>;
  lastActionAt: Record<string, number>;
}

function legacyStatePath(projectRoot: string): string {
  return join(projectRoot, ".codeflowmu", "auto-recovery-state.json");
}

function statePath(projectRoot: string): string {
  return join(projectRoot, ".codeflowmu", "pm-governance", "recovery-attempts.json");
}

function migrateLegacyStateIfNeeded(projectRoot: string): void {
  const legacy = legacyStatePath(projectRoot);
  const current = statePath(projectRoot);
  if (existsSync(current) || !existsSync(legacy)) return;
  try {
    mkdirSync(join(projectRoot, ".codeflowmu", "pm-governance"), { recursive: true });
    renameSync(legacy, current);
  } catch {
    /* best-effort */
  }
}

function emptyState(): AutoRecoveryStateFile {
  return {
    version: 1,
    recoveryCount: {},
    kindAttempts: {},
    lastActionAt: {},
  };
}

function loadState(projectRoot: string): AutoRecoveryStateFile {
  migrateLegacyStateIfNeeded(projectRoot);
  try {
    const raw = readFileSync(statePath(projectRoot), "utf-8");
    const parsed = JSON.parse(raw) as AutoRecoveryStateFile;
    if (parsed?.version === 1) return parsed;
  } catch {
    /* missing */
  }
  return emptyState();
}

function saveState(projectRoot: string, state: AutoRecoveryStateFile): void {
  const dir = join(projectRoot, ".codeflowmu", "pm-governance");
  mkdirSync(dir, { recursive: true });
  writeFileSync(statePath(projectRoot), `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function taskAgentKey(taskId: string, agentId: string): string {
  return `${taskId.replace(/\.md$/i, "")}:${agentId}`;
}

function dedupKey(taskId: string, agentId: string, reasonCode: string): string {
  return `${taskAgentKey(taskId, agentId)}:${reasonCode}`;
}

function kindKey(taskId: string, agentId: string, kind: DeadlockKind): string {
  return `${taskAgentKey(taskId, agentId)}:${kind}`;
}

export function getRecoveryCount(
  projectRoot: string,
  taskId: string,
  agentId: string,
): number {
  const state = loadState(projectRoot);
  return state.recoveryCount[taskAgentKey(taskId, agentId)]?.count ?? 0;
}

export function getKindAttemptCount(
  projectRoot: string,
  taskId: string,
  agentId: string,
  kind: DeadlockKind,
): number {
  const state = loadState(projectRoot);
  return state.kindAttempts[kindKey(taskId, agentId, kind)]?.count ?? 0;
}

export function isDedupBlocked(
  projectRoot: string,
  taskId: string,
  agentId: string,
  reasonCode: string,
  nowMs = Date.now(),
): boolean {
  const state = loadState(projectRoot);
  const last = state.lastActionAt[dedupKey(taskId, agentId, reasonCode)];
  return typeof last === "number" && nowMs - last < AUTO_RECOVERY_DEDUP_MS;
}

export function isRecoveryLimitReached(
  projectRoot: string,
  taskId: string,
  agentId: string,
): boolean {
  return getRecoveryCount(projectRoot, taskId, agentId) >= AUTO_RECOVERY_MAX_PER_TASK_AGENT;
}

export function recordRecoveryAction(opts: {
  projectRoot: string;
  taskId: string;
  agentId: string;
  kind: DeadlockKind;
  reasonCode: string;
  countsTowardLimit: boolean;
  nowMs?: number;
}): void {
  const nowMs = opts.nowMs ?? Date.now();
  const state = loadState(opts.projectRoot);
  const ta = taskAgentKey(opts.taskId, opts.agentId);
  const dk = dedupKey(opts.taskId, opts.agentId, opts.reasonCode);
  const kk = kindKey(opts.taskId, opts.agentId, opts.kind);

  state.lastActionAt[dk] = nowMs;

  const kindPrev = state.kindAttempts[kk]?.count ?? 0;
  state.kindAttempts[kk] = {
    count: kindPrev + 1,
    lastAt: new Date(nowMs).toISOString(),
  };

  if (opts.countsTowardLimit) {
    const prev = state.recoveryCount[ta]?.count ?? 0;
    state.recoveryCount[ta] = {
      count: prev + 1,
      lastAt: new Date(nowMs).toISOString(),
    };
  }

  saveState(opts.projectRoot, state);
}

/** Test-only reset. */
export function resetAutoRecoveryStateForTests(projectRoot: string): void {
  try {
    saveState(projectRoot, emptyState());
  } catch {
    /* ignore */
  }
}
