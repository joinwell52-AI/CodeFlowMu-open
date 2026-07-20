/**
 * Uniform timing logs for panel home-screen API routes.
 */
import type { Request } from "express";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const PANEL_API_SLOW_MS = 300;
const PANEL_API_SLOW_SUMMARY_MS = 60_000;
const PANEL_API_DEBUG = parseEnvFlag(process.env["CODEFLOWMU_PANEL_API_DEBUG"]);
const PANEL_API_JSONL = parseEnvFlag(process.env["CODEFLOWMU_PANEL_API_TIMING_JSONL"]);

type PanelApiTimingMeta = {
  projectRoot?: string;
};

type PanelApiTimingRecord = {
  ts: string;
  label: string;
  duration_ms: number;
  slow: boolean;
};

type SlowRouteStats = {
  count: number;
  totalMs: number;
  maxMs: number;
};

const slowRouteStats = new Map<string, SlowRouteStats>();
let slowWindowStartedAt = Date.now();
let slowNoticePrinted = false;

function recordSlowRoute(label: string, ms: number): void {
  const current = slowRouteStats.get(label) ?? { count: 0, totalMs: 0, maxMs: 0 };
  current.count += 1;
  current.totalMs += ms;
  current.maxMs = Math.max(current.maxMs, ms);
  slowRouteStats.set(label, current);

  if (!slowNoticePrinted) {
    slowNoticePrinted = true;
    console.warn(
      `[panel-api:slow] detected (>${PANEL_API_SLOW_MS}ms); subsequent requests are summarized once per minute`,
    );
  }

  if (Date.now() - slowWindowStartedAt >= PANEL_API_SLOW_SUMMARY_MS) {
    flushPanelApiSlowSummary();
  }
}

export function flushPanelApiSlowSummary(): void {
  if (slowRouteStats.size === 0) {
    slowWindowStartedAt = Date.now();
    return;
  }
  let requestCount = 0;
  let totalMs = 0;
  let maxMs = 0;
  const routes = [...slowRouteStats.entries()]
    .sort((a, b) => b[1].totalMs - a[1].totalMs)
    .map(([label, stats]) => {
      requestCount += stats.count;
      totalMs += stats.totalMs;
      maxMs = Math.max(maxMs, stats.maxMs);
      return `${label}: ${stats.count}x avg=${Math.round(stats.totalMs / stats.count)}ms max=${stats.maxMs}ms`;
    });
  console.warn(
    `[panel-api:slow-summary] requests=${requestCount} routes=${routes.length} avg=${Math.round(totalMs / requestCount)}ms max=${maxMs}ms | ${routes.join(" | ")}`,
  );
  slowRouteStats.clear();
  slowWindowStartedAt = Date.now();
}

export function resetPanelApiTimingForTests(): void {
  slowRouteStats.clear();
  slowWindowStartedAt = Date.now();
  slowNoticePrinted = false;
}

function parseEnvFlag(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function panelApiLogFilePath(projectRoot?: string): string {
  const root = projectRoot && projectRoot.trim() ? projectRoot : process.cwd();
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return join(root, "fcop", "logs", "panel-api", `panel-api-${ymd}.jsonl`);
}

async function appendPanelApiTimingJsonl(
  record: PanelApiTimingRecord,
  projectRoot?: string,
): Promise<void> {
  if (!PANEL_API_JSONL) return;
  const file = panelApiLogFilePath(projectRoot);
  const dir = dirname(file);
  try {
    await mkdir(dir, { recursive: true });
    await appendFile(file, `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    console.error("[panel-api] jsonl_write_failed:", String(err));
  }
}

export function panelApiPathLabel(req: Request): string {
  const q = req.query ?? {};
  const parts: string[] = [];
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === "") continue;
    parts.push(`${k}=${String(v)}`);
  }
  const qs = parts.length ? `?${parts.join("&")}` : "";
  return `${req.method} ${req.path}${qs}`;
}

export function logPanelApiTiming(label: string, startedAt: number, meta?: PanelApiTimingMeta): void {
  const ms = Math.round(performance.now() - startedAt);
  const isSlow = ms > PANEL_API_SLOW_MS;
  if (PANEL_API_DEBUG) {
    console.log(`[panel-api] ${label} ${ms}ms`);
  } else if (isSlow) {
    recordSlowRoute(label, ms);
  }

  const record: PanelApiTimingRecord = {
    ts: new Date().toISOString(),
    label,
    duration_ms: ms,
    slow: isSlow,
  };
  void appendPanelApiTimingJsonl(record, meta?.projectRoot);
}

export async function withPanelApiTiming<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    logPanelApiTiming(label, t0);
  }
}
