/**
 * PM 治理等待/限流状态：同一 thread/task 检查冷却 + missing_report wake 状态机。
 * 持久化于 `.codeflowmu/pm-governance/wait-state.json`（非 FCoP vendor）。
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { pmGovernanceDir } from "./PmGovernancePlanner.ts";

export const PM_CHECK_COOLDOWN_MS_DEFAULT = 45_000;
export const PM_WAKE_WAIT_MS_DEFAULT = 15 * 60 * 1000;
export const PM_CYCLE_REUSE_COOLDOWN_MS_DEFAULT = 45_000;
export const PM_STALL_INTAKE_WAKE_DEBOUNCE_MS_DEFAULT = 5 * 60 * 1000;

export type WakeAllowancePhase =
  | "allow_first_wake"
  | "waiting"
  | "allow_second_wake"
  | "escalate";

export interface WakeTrackEntry {
  task_id: string;
  thread_key: string;
  wake_count: number;
  first_wake_at: string | null;
  last_wake_at: string | null;
  last_check_at: string | null;
  escalated_at: string | null;
  /** Plan C: last PM report-intake wake for active_stalled_done_report. */
  last_stall_intake_wake_at?: string | null;
}

export interface PmGovernanceWaitStateFile {
  version: "1.0.0";
  updated_at: string;
  by_task: Record<string, WakeTrackEntry>;
  thread_last_check: Record<string, string>;
}

export interface WakeAllowanceResult {
  phase: WakeAllowancePhase;
  wake_count: number;
  reason: string;
  wait_remaining_ms?: number;
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function pmCheckCooldownMs(): number {
  return envMs("PM_GOVERNANCE_CHECK_COOLDOWN_MS", PM_CHECK_COOLDOWN_MS_DEFAULT);
}

export function pmWakeWaitMs(): number {
  return envMs("PM_GOVERNANCE_WAKE_WAIT_MS", PM_WAKE_WAIT_MS_DEFAULT);
}

export function pmCycleReuseCooldownMs(): number {
  return envMs("PM_GOVERNANCE_CYCLE_REUSE_COOLDOWN_MS", PM_CYCLE_REUSE_COOLDOWN_MS_DEFAULT);
}

export function pmStallIntakeWakeDebounceMs(): number {
  return envMs(
    "PM_STALL_INTAKE_WAKE_DEBOUNCE_MS",
    PM_STALL_INTAKE_WAKE_DEBOUNCE_MS_DEFAULT,
  );
}

export function pmGovernanceWaitStatePath(projectRoot: string): string {
  return join(pmGovernanceDir(projectRoot), "wait-state.json");
}

export function emptyWaitState(now = new Date().toISOString()): PmGovernanceWaitStateFile {
  return { version: "1.0.0", updated_at: now, by_task: {}, thread_last_check: {} };
}

export async function loadPmGovernanceWaitState(
  projectRoot: string,
): Promise<PmGovernanceWaitStateFile> {
  const path = pmGovernanceWaitStatePath(projectRoot);
  try {
    const raw = await fs.readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as PmGovernanceWaitStateFile;
    if (parsed?.version === "1.0.0" && parsed.by_task && parsed.thread_last_check) {
      return parsed;
    }
  } catch {
    /* fall through */
  }
  return emptyWaitState();
}

export async function savePmGovernanceWaitState(
  projectRoot: string,
  state: PmGovernanceWaitStateFile,
): Promise<void> {
  const dir = pmGovernanceDir(projectRoot);
  await fs.mkdir(dir, { recursive: true });
  state.updated_at = new Date().toISOString();
  await fs.writeFile(
    pmGovernanceWaitStatePath(projectRoot),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf-8",
  );
}

function getOrCreateTaskEntry(
  state: PmGovernanceWaitStateFile,
  taskId: string,
  threadKey: string,
): WakeTrackEntry {
  let entry = state.by_task[taskId];
  if (!entry) {
    entry = {
      task_id: taskId,
      thread_key: threadKey,
      wake_count: 0,
      first_wake_at: null,
      last_wake_at: null,
      last_check_at: null,
      escalated_at: null,
    };
    state.by_task[taskId] = entry;
  }
  if (threadKey && entry.thread_key !== threadKey) {
    entry.thread_key = threadKey;
  }
  return entry;
}

export function canRunThreadCheck(
  state: PmGovernanceWaitStateFile,
  threadKey: string,
  nowMs = Date.now(),
): { allowed: boolean; wait_remaining_ms?: number } {
  const key = threadKey.trim();
  if (!key) return { allowed: true };
  const last = state.thread_last_check[key];
  if (!last) return { allowed: true };
  const elapsed = nowMs - Date.parse(last);
  const cooldown = pmCheckCooldownMs();
  if (elapsed >= cooldown) return { allowed: true };
  return { allowed: false, wait_remaining_ms: cooldown - elapsed };
}

export function recordThreadCheck(
  state: PmGovernanceWaitStateFile,
  threadKey: string,
  nowMs = Date.now(),
): void {
  const key = threadKey.trim();
  if (!key) return;
  state.thread_last_check[key] = new Date(nowMs).toISOString();
}

export function evaluateWakeAllowance(
  state: PmGovernanceWaitStateFile,
  taskId: string,
  threadKey: string,
  nowMs = Date.now(),
): WakeAllowanceResult {
  const tid = taskId.trim();
  if (!tid) {
    return { phase: "allow_first_wake", wake_count: 0, reason: "无 task_id，按首次 wake 处理" };
  }

  const entry = state.by_task[tid];
  if (!entry || entry.wake_count === 0) {
    return {
      phase: "allow_first_wake",
      wake_count: 0,
      reason: "尚未 wake，允许首次 wake_downstream",
    };
  }

  if (entry.escalated_at) {
    return {
      phase: "escalate",
      wake_count: entry.wake_count,
      reason: "已升级 ISSUE/关单草稿，不再重复 wake",
    };
  }

  const lastWake = entry.last_wake_at ? Date.parse(entry.last_wake_at) : NaN;
  const waitMs = pmWakeWaitMs();
  const elapsed = Number.isFinite(lastWake) ? nowMs - lastWake : waitMs;

  if (elapsed < waitMs) {
    return {
      phase: "waiting",
      wake_count: entry.wake_count,
      reason: `wake 后等待窗口内（${Math.ceil((waitMs - elapsed) / 1000)}s 后可再检查）`,
      wait_remaining_ms: waitMs - elapsed,
    };
  }

  if (entry.wake_count === 1) {
    return {
      phase: "allow_second_wake",
      wake_count: entry.wake_count,
      reason: "首次 wake 等待窗口已超时，允许第二次 wake",
    };
  }

  return {
    phase: "escalate",
    wake_count: entry.wake_count,
    reason: "第二次 wake 后仍无 REPORT，应 write_issue 或 blocked report 给 ADMIN",
  };
}

export function recordWakeExecuted(
  state: PmGovernanceWaitStateFile,
  taskId: string,
  threadKey: string,
  nowMs = Date.now(),
): WakeTrackEntry {
  const entry = getOrCreateTaskEntry(state, taskId.trim(), threadKey.trim());
  const at = new Date(nowMs).toISOString();
  entry.wake_count += 1;
  if (!entry.first_wake_at) entry.first_wake_at = at;
  entry.last_wake_at = at;
  entry.last_check_at = at;
  recordThreadCheck(state, threadKey, nowMs);
  return entry;
}

export function recordWakeEscalated(
  state: PmGovernanceWaitStateFile,
  taskId: string,
  threadKey: string,
  nowMs = Date.now(),
): WakeTrackEntry {
  const entry = getOrCreateTaskEntry(state, taskId.trim(), threadKey.trim());
  entry.escalated_at = new Date(nowMs).toISOString();
  recordThreadCheck(state, threadKey, nowMs);
  return entry;
}

export function evaluateStallIntakeWakeAllowance(
  state: PmGovernanceWaitStateFile,
  taskId: string,
  nowMs = Date.now(),
): { allowed: boolean; reason: string; wait_remaining_ms?: number } {
  const tid = taskId.trim();
  if (!tid) {
    return { allowed: false, reason: "缺少 task_id" };
  }
  const entry = state.by_task[tid];
  const last = entry?.last_stall_intake_wake_at
    ? Date.parse(entry.last_stall_intake_wake_at)
    : NaN;
  const debounceMs = pmStallIntakeWakeDebounceMs();
  if (!Number.isFinite(last)) {
    return { allowed: true, reason: "首次 stall intake wake" };
  }
  const elapsed = nowMs - last;
  if (elapsed >= debounceMs) {
    return { allowed: true, reason: "debounce 窗口已过" };
  }
  return {
    allowed: false,
    reason: `stall intake wake 限流（${Math.ceil((debounceMs - elapsed) / 1000)}s 后可再试）`,
    wait_remaining_ms: debounceMs - elapsed,
  };
}

export function recordStallIntakeWakeExecuted(
  state: PmGovernanceWaitStateFile,
  taskId: string,
  threadKey: string,
  nowMs = Date.now(),
): WakeTrackEntry {
  const entry = getOrCreateTaskEntry(state, taskId.trim(), threadKey.trim());
  entry.last_stall_intake_wake_at = new Date(nowMs).toISOString();
  recordThreadCheck(state, threadKey, nowMs);
  return entry;
}
