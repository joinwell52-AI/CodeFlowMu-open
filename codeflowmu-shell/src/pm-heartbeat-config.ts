import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PmHeartbeatConfig {
  enabled: boolean;
  normalIntervalMin: number;
  initialIntervalMin: number;
  initialWindowMin: number;
  longTaskAfterMin: number;
  longTaskIntervalMin: number;
  downstreamNoReceiptNudgeMin: number;
  onlyReportChanges: boolean;
}

export interface PmHeartbeatPolicyInput {
  config: PmHeartbeatConfig;
  nowMs: number;
  lastRunAtMs: number;
  lastDigest: string;
  pmBusy?: boolean;
  activeRootCount: number;
  lastDispatchAtMs: number;
  oldestRootAtMs: number;
  digest: string;
}

export interface PmHeartbeatPolicyDecision {
  shouldRun: boolean;
  intervalMin: number;
  reason:
    | "disabled"
    | "pm_busy"
    | "no_active_root"
    | "initial_dispatch_window"
    | "long_task_changed"
    | "state_unchanged"
    | "normal_interval"
    | "interval_not_elapsed";
}

export const DEFAULT_PM_HEARTBEAT_CONFIG: PmHeartbeatConfig = {
  enabled: true,
  normalIntervalMin: 3,
  initialIntervalMin: 2,
  initialWindowMin: 10,
  longTaskAfterMin: 15,
  longTaskIntervalMin: 5,
  downstreamNoReceiptNudgeMin: 10,
  onlyReportChanges: true,
};

export function pmHeartbeatConfigPath(projectRoot: string): string {
  return join(projectRoot, ".codeflowmu", "pm-heartbeat.json");
}

function clampMin(value: unknown, fallback: number, min = 1, max = 120): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizePmHeartbeatConfig(
  raw?: Partial<PmHeartbeatConfig> | null,
): PmHeartbeatConfig {
  const base = DEFAULT_PM_HEARTBEAT_CONFIG;
  return {
    enabled: raw?.enabled ?? base.enabled,
    normalIntervalMin: clampMin(raw?.normalIntervalMin, base.normalIntervalMin),
    initialIntervalMin: clampMin(raw?.initialIntervalMin, base.initialIntervalMin),
    initialWindowMin: clampMin(raw?.initialWindowMin, base.initialWindowMin),
    longTaskAfterMin: clampMin(raw?.longTaskAfterMin, base.longTaskAfterMin),
    longTaskIntervalMin: clampMin(raw?.longTaskIntervalMin, base.longTaskIntervalMin),
    downstreamNoReceiptNudgeMin: clampMin(
      raw?.downstreamNoReceiptNudgeMin,
      base.downstreamNoReceiptNudgeMin,
    ),
    onlyReportChanges: raw?.onlyReportChanges ?? base.onlyReportChanges,
  };
}

export function readPmHeartbeatConfig(projectRoot: string): PmHeartbeatConfig {
  const path = pmHeartbeatConfigPath(projectRoot);
  if (!existsSync(path)) return { ...DEFAULT_PM_HEARTBEAT_CONFIG };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PmHeartbeatConfig>;
    return normalizePmHeartbeatConfig(raw);
  } catch {
    return { ...DEFAULT_PM_HEARTBEAT_CONFIG };
  }
}

export function writePmHeartbeatConfig(
  projectRoot: string,
  patch: Partial<PmHeartbeatConfig>,
): PmHeartbeatConfig {
  const next = normalizePmHeartbeatConfig({
    ...readPmHeartbeatConfig(projectRoot),
    ...patch,
  });
  const path = pmHeartbeatConfigPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

export function decidePmHeartbeatPolicy(
  input: PmHeartbeatPolicyInput,
): PmHeartbeatPolicyDecision {
  const cfg = input.config;
  if (!cfg.enabled) {
    return { shouldRun: false, intervalMin: cfg.normalIntervalMin, reason: "disabled" };
  }
  if (input.pmBusy) {
    return { shouldRun: false, intervalMin: cfg.normalIntervalMin, reason: "pm_busy" };
  }
  if (input.activeRootCount <= 0) {
    return { shouldRun: false, intervalMin: cfg.normalIntervalMin, reason: "no_active_root" };
  }

  const sinceDispatchMin =
    input.lastDispatchAtMs > 0
      ? (input.nowMs - input.lastDispatchAtMs) / 60_000
      : Number.POSITIVE_INFINITY;
  const oldestRootMin =
    input.oldestRootAtMs > 0 ? (input.nowMs - input.oldestRootAtMs) / 60_000 : 0;

  const inInitialWindow = sinceDispatchMin <= cfg.initialWindowMin;
  const isLongTask = oldestRootMin >= cfg.longTaskAfterMin;
  const intervalMin = inInitialWindow
    ? cfg.initialIntervalMin
    : isLongTask
      ? cfg.longTaskIntervalMin
      : cfg.normalIntervalMin;

  if (input.nowMs - input.lastRunAtMs < intervalMin * 60_000) {
    return { shouldRun: false, intervalMin, reason: "interval_not_elapsed" };
  }

  if (
    cfg.onlyReportChanges &&
    Boolean(input.lastDigest) &&
    input.lastDigest === input.digest
  ) {
    return { shouldRun: false, intervalMin, reason: "state_unchanged" };
  }

  return {
    shouldRun: true,
    intervalMin,
    reason: inInitialWindow
      ? "initial_dispatch_window"
      : isLongTask
        ? "long_task_changed"
        : "normal_interval",
  };
}
