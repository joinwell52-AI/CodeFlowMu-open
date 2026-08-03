import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type PmHeartbeatWakeRecord = {
  wake_id: string;
  task_id: string;
  thread_key?: string;
  trigger_reason: string;
  input_digest: string;
  session_id: string;
  started_at: string;
  ended_at?: string;
  session_outcome?: string;
  failure_code?: string;
  approval_id?: string;
  operation_fingerprint?: string;
  business_progress_digest_before: string;
  business_progress_digest_after?: string;
  progress?: boolean;
};

export type PmHeartbeatFuse = {
  key: string;
  task_id: string;
  operation_fingerprint: string;
  last_input_digest: string;
  no_progress_count: number;
  cooldown_until?: string;
  open: boolean;
  alert_emitted: boolean;
};

export type PmHeartbeatTickRecord = {
  tick_id: string;
  observed_at: string;
  project_root: string;
  status: "accepted" | "skipped" | "failed";
  decision: "accepted" | "skipped" | "failed";
  skip_reason?: string;
  task_id?: string;
  input_digest?: string;
  wake_id?: string;
  active_session?: string;
  queue_guard?: Record<string, unknown>;
  wake_http_status?: string | number;
  session_id?: string;
  detail?: string;
};

export type PmHeartbeatState = {
  schema_version: 1;
  last_run_at_ms: number;
  last_digest: string;
  wakes: PmHeartbeatWakeRecord[];
  fuses: Record<string, PmHeartbeatFuse>;
  ticks: PmHeartbeatTickRecord[];
  recovered_policy_freezes: Record<string, string>;
};

export function pmHeartbeatStatePath(projectRoot: string): string {
  return join(projectRoot, ".codeflowmu", "pm-heartbeat-state.json");
}

export function emptyPmHeartbeatState(): PmHeartbeatState {
  return {
    schema_version: 1,
    last_run_at_ms: 0,
    last_digest: "",
    wakes: [],
    fuses: {},
    ticks: [],
    recovered_policy_freezes: {},
  };
}

export function readPmHeartbeatState(projectRoot: string): PmHeartbeatState {
  const path = pmHeartbeatStatePath(projectRoot);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PmHeartbeatState>;
    return {
      schema_version: 1,
      last_run_at_ms: Number(parsed.last_run_at_ms ?? 0) || 0,
      last_digest: String(parsed.last_digest ?? ""),
      wakes: Array.isArray(parsed.wakes) ? parsed.wakes.slice(-100) : [],
      fuses: parsed.fuses && typeof parsed.fuses === "object" ? parsed.fuses : {},
      ticks: Array.isArray(parsed.ticks)
        ? parsed.ticks.slice(-200).map((tick) => ({
            ...tick,
            decision: tick.decision ?? tick.status,
          }))
        : [],
      recovered_policy_freezes:
        parsed.recovered_policy_freezes && typeof parsed.recovered_policy_freezes === "object"
          ? parsed.recovered_policy_freezes
          : {},
    };
  } catch {
    return emptyPmHeartbeatState();
  }
}

export function writePmHeartbeatState(projectRoot: string, state: PmHeartbeatState): void {
  const path = pmHeartbeatStatePath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({
      ...state,
      wakes: state.wakes.slice(-100),
      ticks: state.ticks.slice(-200),
    }, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

export function newPmHeartbeatWakeId(now = new Date()): string {
  return `PM-WAKE-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 17)}-${randomBytes(5).toString("hex")}`;
}

export function registerPmHeartbeatTick(
  state: PmHeartbeatState,
  tick: PmHeartbeatTickRecord,
): void {
  state.ticks.push(tick);
  state.ticks = state.ticks.slice(-200);
}

export function registerAcceptedPmHeartbeatWake(
  state: PmHeartbeatState,
  wake: PmHeartbeatWakeRecord,
): void {
  state.last_run_at_ms = Date.parse(wake.started_at);
  state.last_digest = wake.input_digest;
  state.wakes.push(wake);
  state.wakes = state.wakes.slice(-100);
}

function fuseKey(taskId: string, operationFingerprint: string): string {
  return `${taskId.toUpperCase()}::${operationFingerprint || "no-operation"}`;
}

export function settlePmHeartbeatWake(input: {
  state: PmHeartbeatState;
  wakeId: string;
  endedAt: string;
  sessionOutcome: string;
  failureCode?: string;
  approvalId?: string;
  operationFingerprint?: string;
  businessProgressDigestAfter: string;
  cooldownMs?: number;
}): { settled: boolean; fuseOpened: boolean; alertRequired: boolean } {
  const wake = input.state.wakes.find((row) => row.wake_id === input.wakeId);
  if (!wake || wake.ended_at) return { settled: false, fuseOpened: false, alertRequired: false };
  wake.ended_at = input.endedAt;
  wake.session_outcome = input.sessionOutcome;
  wake.failure_code = input.failureCode;
  wake.approval_id = input.approvalId;
  wake.operation_fingerprint = input.operationFingerprint;
  wake.business_progress_digest_after = input.businessProgressDigestAfter;
  wake.progress = wake.business_progress_digest_before !== input.businessProgressDigestAfter;
  const fingerprint = input.operationFingerprint || input.failureCode || wake.input_digest;
  const key = fuseKey(wake.task_id, fingerprint);
  if (wake.progress) {
    delete input.state.fuses[key];
    return { settled: true, fuseOpened: false, alertRequired: false };
  }
  const prior = input.state.fuses[key];
  const count = prior?.last_input_digest === wake.input_digest
    ? prior.no_progress_count + 1
    : 1;
  const fuse: PmHeartbeatFuse = {
    key,
    task_id: wake.task_id,
    operation_fingerprint: fingerprint,
    last_input_digest: wake.input_digest,
    no_progress_count: count,
    ...(count >= 2 ? { cooldown_until: new Date(Date.parse(input.endedAt) + (input.cooldownMs ?? 15 * 60_000)).toISOString() } : {}),
    open: count >= 3,
    alert_emitted: prior?.alert_emitted ?? false,
  };
  const alertRequired = fuse.open && !fuse.alert_emitted;
  if (alertRequired) fuse.alert_emitted = true;
  input.state.fuses[key] = fuse;
  return { settled: true, fuseOpened: fuse.open, alertRequired };
}

export function evaluatePmHeartbeatFuse(input: {
  state: PmHeartbeatState;
  taskId: string;
  inputDigest: string;
  nowMs: number;
}): { allow: boolean; reason: "allow" | "wake_pending" | "cooldown" | "fuse_open" } {
  if (input.state.wakes.some((wake) => wake.task_id === input.taskId && !wake.ended_at)) {
    return { allow: false, reason: "wake_pending" };
  }
  const entries = Object.entries(input.state.fuses).filter(([, fuse]) => fuse.task_id === input.taskId);
  for (const [key, fuse] of entries) {
    if (fuse.last_input_digest !== input.inputDigest) {
      delete input.state.fuses[key];
      continue;
    }
    if (fuse.open) return { allow: false, reason: "fuse_open" };
    if (fuse.cooldown_until && Date.parse(fuse.cooldown_until) > input.nowMs) {
      return { allow: false, reason: "cooldown" };
    }
  }
  return { allow: true, reason: "allow" };
}

export function clearPmHeartbeatTaskFuses(
  state: PmHeartbeatState,
  taskId: string,
): void {
  for (const [key, fuse] of Object.entries(state.fuses)) {
    if (fuse.task_id.toUpperCase() === taskId.toUpperCase()) delete state.fuses[key];
  }
}
