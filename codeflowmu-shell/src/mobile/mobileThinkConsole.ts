import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { extractSdkThinkingText } from "../chat-thinking-align.ts";
import { ThinkingFileLogger } from "../thinking-file-logger.ts";

export type ThinkConsoleKind = "think" | "runtime";

export type ThinkConsoleEventSource = "think_console" | "runtime_action";

export type ThinkConsoleEvent = {
  id: string;
  at: string;
  agent: string;
  taskId: string;
  source: ThinkConsoleEventSource;
  consoleKind: ThinkConsoleKind;
  kind: "THINKING" | "RUNTIME";
  status: "done" | "running" | "error";
  summary: string;
};

const THINK_MERGE_WINDOW_MS = 15_000;
const THINK_MAX_CHARS = 4000;

type ParsedLine = {
  filePath: string;
  lineIndex: number;
  ts: number;
  at: string;
  eventType: string;
  agent: string;
  taskId: string;
  payload: Record<string, unknown>;
};

function normalizedTaskId(value: unknown): string {
  return String(value ?? "")
    .replace(/\.md$/i, "")
    .replace(/-(?:ADMIN|PM|DEV|QA|OPS)-to-(?:ADMIN|PM|DEV|QA|OPS)$/i, "")
    .trim();
}

function normalizeThinkText(text: string): string {
  return String(text ?? "")
    .replace(/^\s*(?:💭|\[思\])\s*/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function appendThinkText(base: string, next: string): string {
  const a = normalizeThinkText(base);
  const b = normalizeThinkText(next);
  if (!a) return b;
  if (!b) return a;
  if (a.endsWith(b)) return a;
  const glue =
    /[\s([{`"']$/.test(a) || /^[\s.,;:!?)}\]'"`]/.test(b) ? "" : " ";
  return a + glue + b;
}

function trimThinkText(text: string): string {
  const s = String(text ?? "");
  return s.length > THINK_MAX_CHARS ? `…${s.slice(-THINK_MAX_CHARS)}` : s;
}

function stableEventId(
  filePath: string,
  lineIndex: number,
  eventType: string,
  at: string,
  agent: string,
): string {
  const key = `${filePath}:${lineIndex}:${eventType}:${at}:${agent}`;
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 20);
  return `think-console-${hash}`;
}

function parseJsonlLine(
  line: string,
  filePath: string,
  lineIndex: number,
): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const row = JSON.parse(trimmed) as Record<string, unknown>;
    const eventType = String(row.event_type ?? "");
    if (eventType !== "sdk.thinking") return null;
    const ts = Number(row.ts ?? 0);
    const at = String(row.at ?? (ts ? new Date(ts).toISOString() : ""));
    const agent = String(row.agent_id ?? row.agent ?? "unknown");
    const taskId = normalizedTaskId(row.task_id);
    const payload =
      row.payload && typeof row.payload === "object"
        ? (row.payload as Record<string, unknown>)
        : {};
    return {
      filePath,
      lineIndex,
      ts: Number.isFinite(ts) ? ts : Date.parse(at) || 0,
      at,
      eventType,
      agent,
      taskId,
      payload,
    };
  } catch {
    return null;
  }
}

function parsedToEvent(parsed: ParsedLine): ThinkConsoleEvent | null {
  const raw =
    parsed.payload.raw && typeof parsed.payload.raw === "object"
      ? (parsed.payload.raw as Record<string, unknown>)
      : parsed.payload;
  let text = extractSdkThinkingText(parsed.payload);
  if (!text && raw) {
    text = String(raw.text ?? raw.thinking ?? raw.content ?? "");
  }
  text = normalizeThinkText(text);
  if (!text) return null;
  return {
    id: stableEventId(
      parsed.filePath,
      parsed.lineIndex,
      parsed.eventType,
      parsed.at,
      parsed.agent,
    ),
    at: parsed.at,
    agent: parsed.agent,
    taskId: parsed.taskId,
    source: "think_console",
    consoleKind: "think",
    kind: "THINKING",
    status: "done",
    summary: text,
  };
}

function mergeConsecutiveThinkEvents(
  events: ThinkConsoleEvent[],
): ThinkConsoleEvent[] {
  if (events.length === 0) return events;
  const sorted = [...events].sort(
    (a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0),
  );
  const merged: ThinkConsoleEvent[] = [];
  for (const ev of sorted) {
    const last = merged[merged.length - 1];
    const evTs = Date.parse(ev.at) || 0;
    if (
      last &&
      last.consoleKind === "think" &&
      last.agent === ev.agent &&
      evTs - (Date.parse(last.at) || 0) <= THINK_MERGE_WINDOW_MS
    ) {
      last.summary = trimThinkText(appendThinkText(last.summary, ev.summary));
      last.at = ev.at;
      if (ev.taskId && !last.taskId) last.taskId = ev.taskId;
      continue;
    }
    merged.push({ ...ev });
  }
  return merged;
}

function listThinkingJsonlFiles(projectRoot: string): string[] {
  const logger = new ThinkingFileLogger(projectRoot);
  const files = logger.listFiles();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of files) {
    const abs = path.resolve(f.path);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (fs.existsSync(abs)) out.push(abs);
  }
  return out.sort((a, b) => b.localeCompare(a));
}

function readFileTailLines(filePath: string, maxLines: number): string[] {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    if (lines.length <= maxLines) return lines;
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

/**
 * Read sdk.thinking from thinking JSONL (chat + task + legacy).
 * Merges consecutive same-agent thoughts within 15s (PC thinkConsole parity).
 * Returns newest-first console lines — think only, no tool_call rows.
 */
export function readThinkConsoleEvents(
  projectRoot: string,
  limit = 100,
  maxFiles = 8,
  maxLinesPerFile = 2000,
): ThinkConsoleEvent[] {
  const files = listThinkingJsonlFiles(projectRoot).slice(0, maxFiles);
  const parsed: ParsedLine[] = [];

  for (const filePath of files) {
    const lines = readFileTailLines(filePath, maxLinesPerFile);
    for (let i = 0; i < lines.length; i++) {
      const p = parseJsonlLine(lines[i]!, filePath, i);
      if (p) parsed.push(p);
    }
  }

  const rawEvents: ThinkConsoleEvent[] = [];
  const seenIds = new Set<string>();
  for (const p of parsed) {
    const ev = parsedToEvent(p);
    if (!ev || seenIds.has(ev.id)) continue;
    seenIds.add(ev.id);
    rawEvents.push(ev);
  }

  const merged = mergeConsecutiveThinkEvents(rawEvents);
  merged.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return merged.slice(0, limit);
}
