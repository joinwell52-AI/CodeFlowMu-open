/**
 * Gateway client log — fcop/logs/runtime/gateway-YYYYMMDD.jsonl
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

import { fcopLogsRuntimeDir, logsDateKey } from "./logs-paths.ts";
import type { LogCenterRow } from "./log-center.ts";

export type GatewayLogLevel = "info" | "slow" | "timeout" | "error";

export interface GatewayLogEntry {
  ts: number;
  at: string;
  source: string;
  level: GatewayLogLevel;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  request_id?: string;
  message: string;
  detail?: string;
}

export type GatewayLogWriteInput = {
  level: GatewayLogLevel;
  message: string;
  source?: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  request_id?: string;
  detail?: string;
};

const SENSITIVE_KEY_RE =
  /^(authorization|cookie|token|secret|mobile_session_token|instance_secret)$/i;
const SENSITIVE_INLINE_RE =
  /\b(authorization|cookie|token|secret|mobile_session_token|instance_secret)\b\s*[:=]\s*["']?[^\s"',}&]+/gi;
const SECRET_INLINE_RE = /secret_[a-zA-Z0-9_-]+/g;

export function levelToGatewaySource(
  level: GatewayLogLevel,
  override?: string,
): string {
  if (override) return override;
  switch (level) {
    case "slow":
      return "mobile-gateway:slow";
    case "timeout":
      return "mobile-gateway:timeout";
    case "error":
      return "mobile-gateway:error";
    default:
      return "mobile-gateway";
  }
}

export function redactGatewayText(text: string): string {
  return text
    .replace(SENSITIVE_INLINE_RE, (m) => m.split(/[:=]/)[0] + "=***")
    .replace(SECRET_INLINE_RE, "secret_***");
}

function sanitizeDetail(detail: unknown): string | undefined {
  if (detail == null) return undefined;
  if (typeof detail === "string") {
    return redactGatewayText(detail);
  }
  try {
    const redacted = JSON.stringify(detail, (key, value) => {
      if (SENSITIVE_KEY_RE.test(key)) return "***";
      if (typeof value === "string") return redactGatewayText(value);
      return value;
    });
    return redactGatewayText(redacted);
  } catch {
    return redactGatewayText(String(detail));
  }
}

export function fcopLogsGatewayPath(
  projectRoot: string,
  dateKey?: string,
): string {
  const key = dateKey ?? logsDateKey();
  return join(fcopLogsRuntimeDir(projectRoot), `gateway-${key}.jsonl`);
}

export function listGatewayReadPaths(projectRoot: string): string[] {
  const dir = fcopLogsRuntimeDir(projectRoot);
  const paths: string[] = [];
  try {
    readdirSync(dir)
      .filter((f) => /^gateway-\d{8}\.jsonl$/.test(f))
      .sort((a, b) => b.localeCompare(a))
      .forEach((f) => paths.push(join(dir, f)));
  } catch {
    /* dir may not exist */
  }
  return paths;
}

export function appendGatewayLog(
  projectRoot: string,
  input: GatewayLogWriteInput,
): GatewayLogEntry {
  const dir = fcopLogsRuntimeDir(projectRoot);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  const ts = Date.now();
  const entry: GatewayLogEntry = {
    ts,
    at: new Date(ts).toISOString(),
    source: levelToGatewaySource(input.level, input.source),
    level: input.level,
    message: redactGatewayText(input.message),
    method: input.method,
    path: input.path,
    status: input.status,
    durationMs: input.durationMs,
    request_id: input.request_id,
    detail: sanitizeDetail(input.detail),
  };
  const line = `${JSON.stringify(entry)}\n`;
  appendFileSync(fcopLogsGatewayPath(projectRoot), line, "utf-8");
  return entry;
}

function parseGatewayLine(line: string): GatewayLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const raw = JSON.parse(trimmed) as GatewayLogEntry;
    if (!raw || typeof raw.ts !== "number" || typeof raw.message !== "string") {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export function readRecentGatewayLogs(
  projectRoot: string,
  limit = 100,
  since?: number,
): GatewayLogEntry[] {
  const cap = Math.min(Math.max(limit, 1), 300);
  const paths = listGatewayReadPaths(projectRoot);
  const entries: GatewayLogEntry[] = [];
  for (const filePath of paths) {
    if (!existsSync(filePath)) continue;
    let text = "";
    try {
      text = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const entry = parseGatewayLine(line);
      if (!entry) continue;
      if (since != null && entry.ts <= since) continue;
      entries.push(entry);
    }
    if (entries.length >= cap * 3) break;
  }
  entries.sort((a, b) => b.ts - a.ts);
  return entries.slice(0, cap);
}

export function gatewayLogToLogCenterRow(
  entry: GatewayLogEntry,
  index: number,
): LogCenterRow {
  const levelMap: Record<GatewayLogLevel, LogCenterRow["level"]> = {
    info: "INFO",
    slow: "WARN",
    timeout: "WARN",
    error: "ERROR",
  };
  return {
    id: `gateway-${entry.ts}-${index}`,
    ts: entry.ts,
    at: entry.at,
    tab: "gateway",
    event_type: entry.source,
    level: levelMap[entry.level],
    message: entry.message,
    tool_name: entry.method,
    status: entry.status != null ? String(entry.status) : undefined,
    reason: entry.request_id,
    duration_ms: entry.durationMs,
    payload: {
      path: entry.path,
      source: entry.source,
      gateway_level: entry.level,
      detail: entry.detail,
    },
  };
}
