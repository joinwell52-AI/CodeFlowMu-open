import { basename } from "node:path";

import { roleFromAgentId } from "@codeflowmu/runtime";

import type {
  MobileActivityEventType,
  MobileEvent,
  MobileEventKind,
  MobileEventStatus,
  RawEvent,
  RawEventType,
} from "./mobileActivityTypes.ts";
import { isChatActivityTaskId } from "./mobileActivityTypes.ts";

const MERGE_WINDOW_MS = 30_000;
const IMMEDIATE_KINDS = new Set<MobileEventKind>(["WARNING", "COMPLETED"]);

/** PWA live activity caps — field state only, not audit ledger. */
export const MOBILE_ACTIVITY_GLOBAL_CAP = 300;
export const MOBILE_ACTIVITY_TASK_CAP = 100;
export const MOBILE_ACTIVITY_DEFAULT_LIMIT = 100;
export const MOBILE_ACTIVITY_MAX_LIMIT = 150;
export const MOBILE_TASK_ACTIVITY_DEFAULT_LIMIT = 50;
export const MOBILE_TASK_ACTIVITY_MAX_LIMIT = 100;

let eventSeq = 0;

function nextMobileId(): string {
  eventSeq += 1;
  return `me-${Date.now()}-${eventSeq}`;
}

const SECRET_PATTERNS = [
  /api[_-]?key/i,
  /authorization/i,
  /bearer\s+/i,
  /token\s*=/i,
  /cookie/i,
  /system\s*prompt/i,
  /developer\s*prompt/i,
];

export function sanitizeBasename(pathOrName: string): string {
  const raw = String(pathOrName ?? "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return raw;
  if (parts.length >= 3 && /^[a-zA-Z]:$/.test(parts[0] ?? "")) {
    return parts[parts.length - 1] ?? raw;
  }
  if (parts.length > 2) {
    return `${parts[0]}/.../${parts[parts.length - 1]}`;
  }
  return basename(normalized);
}

const INTERNAL_ERROR_TOKENS = [
  "stale_busy_no_session",
  "session_unsettled",
  "sdk_circuit_open",
  "worker_failed_mark",
  "wake_throttled",
  "sdk_cooldown",
];

export function sanitizeReason(text: string): string {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (INTERNAL_ERROR_TOKENS.some((token) => lower.includes(token))) {
    return "执行异常";
  }
  if (SECRET_PATTERNS.some((re) => re.test(trimmed))) {
    return "需要关注";
  }
  const oneLine = trimmed.replace(/\s+/g, " ").slice(0, 120);
  return oneLine;
}

const THINKING_WHITELIST_PHRASES = [
  "任务已移入审查队列",
  "已提交验收",
  "回执已提交",
  "回执已写",
  "测试通过",
  "测试失败",
  "MCP 工具超时",
  "MCP 超时",
  "fcop_check 超时",
  "get_team_status 超时",
  "执行失败",
  "blocked",
  "需要 ADMIN",
  "需要 EVAL",
] as const;

/** Extract a short, safe phrase from agent thinking for immediate mobile display. */
export function extractSafeThinkingSummary(text: string): string | undefined {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return undefined;
  if (SECRET_PATTERNS.some((re) => re.test(trimmed))) return undefined;

  const lower = trimmed.toLowerCase();
  for (const phrase of THINKING_WHITELIST_PHRASES) {
    const phraseLower = phrase.toLowerCase();
    if (!lower.includes(phraseLower) && !trimmed.includes(phrase)) continue;
    const idx = lower.indexOf(phraseLower);
    const start = idx >= 0 ? idx : 0;
    let excerpt = trimmed.slice(start, start + 80).replace(/\s+/g, " ").trim();
    if (excerpt.length > 80) excerpt = excerpt.slice(0, 80);
    const safe = sanitizeReason(excerpt);
    if (!safe || safe === "需要关注") return undefined;
    return safe;
  }
  return undefined;
}

function classifyThinkingSummary(summary: string): { kind: MobileEventKind; immediate: boolean } {
  if (/验收|审查队列|回执/.test(summary)) {
    return { kind: "REPORTING", immediate: true };
  }
  if (/测试通过|测试失败/.test(summary)) {
    return { kind: "TESTING", immediate: true };
  }
  if (/超时|失败|blocked|需要\s*ADMIN|需要\s*EVAL/i.test(summary)) {
    return { kind: "WARNING", immediate: true };
  }
  return { kind: "ANALYZING", immediate: false };
}

const REPORT_ID_RE =
  /REPORT-\d{8}-\d{3,}-[A-Z0-9]+-to-[A-Z0-9]+(?:-[a-z0-9][-a-z0-9]*)?/i;

export function extractReportId(...sources: Array<string | undefined>): string | undefined {
  for (const src of sources) {
    const m = String(src ?? "").match(REPORT_ID_RE);
    if (m?.[0]) return m[0];
  }
  return undefined;
}

export function sanitizeCommand(cmd: string): string {
  let s = String(cmd ?? "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  s = s.replace(/[A-Za-z]:\\[^\s]+/g, (m) => sanitizeBasename(m));
  s = s.replace(/\/(?:Users|home|tmp|var|codeflowmu)[^\s]*/gi, (m) => sanitizeBasename(m));
  if (s.length > 120) s = `${s.slice(0, 117)}...`;
  return s;
}

function extractTestLabel(cmd: string): string {
  const normalized = cmd.replace(/\\/g, "/");
  const named = normalized.match(/([a-z0-9][-a-z0-9]*)\.test\.(?:ts|js|mjs|cjs)/i);
  if (named?.[1]) return named[1];
  const afterFlag = normalized.match(/--test\s+(\S+)/);
  if (afterFlag?.[1]) {
    const base = sanitizeBasename(afterFlag[1]);
    return base.replace(/\.test\.(ts|js|mjs|cjs)$/i, "") || "测试";
  }
  return "测试";
}

function agentRole(agent: string): string {
  return roleFromAgentId(agent).toUpperCase() || String(agent || "AGENT").split(/[-.]/)[0]!.toUpperCase();
}

export function makeSummary(
  agent: string,
  kind: MobileEventKind,
  count: number,
  fileCount: number,
  reportVariant?: "done" | "blocked" | "failed" | "other",
  waitHint?: string,
): string {
  const role = agentRole(agent);
  switch (kind) {
    case "TASK_RECEIVED":
      return `${role} 已接收任务`;
    case "ANALYZING": {
      const ctxCount = fileCount > 0 ? fileCount : count;
      if (fileCount > 0) {
        return ctxCount > 1 ? `${role} 读取上下文（${ctxCount}）` : `${role} 读取上下文`;
      }
      if (count > 1) return `${role} 正在处理任务（${count}）`;
      return `${role} 正在处理任务`;
    }
    case "IMPLEMENTING":
      if (fileCount > 0) {
        return `${role} 正在修改代码（${fileCount} 个文件）`;
      }
      return count > 1 ? `${role} 正在执行修改（${count}）` : `${role} 正在修改代码`;
    case "TESTING":
      if (role === "QA") return `${role} 正在验收`;
      if (role === "OPS") return `${role} 正在巡检`;
      return `${role} 正在运行验证`;
    case "REPORTING":
      if (reportVariant === "done") return `${role} 回执已提交`;
      if (reportVariant === "blocked") return `${role} 回执提交：blocked`;
      if (reportVariant === "failed") return `${role} 回执提交：failed`;
      return `${role} 已提交报告`;
    case "WAITING":
      if (waitHint) return waitHint;
      return `${role} 正在等待下游回执`;
    case "COMPLETED":
      if (role === "ADMIN") return `${role} 已审批通过`;
      return `${role} 已完成`;
    case "WARNING":
      return `发现异常：${role} 需要关注`;
    default:
      return `${role} 执行中`;
  }
}

function buildSummary(
  agent: string,
  kind: MobileEventKind,
  count: number,
  fileCount: number,
  opts?: {
    reportVariant?: "done" | "blocked" | "failed" | "other";
    waitHint?: string;
    summaryText?: string;
  },
): string {
  if (opts?.summaryText) {
    const role = agentRole(agent);
    const st = opts.summaryText.trim();
    if (st.toUpperCase().startsWith(`${role} `) || st.toUpperCase() === role) {
      return st.length > 120 ? st.slice(0, 120) : st;
    }
    return `${role} ${st}`;
  }
  return makeSummary(agent, kind, count, fileCount, opts?.reportVariant, opts?.waitHint);
}

type PendingBucket = {
  mobileId: string;
  taskId: string;
  agent: string;
  eventType: MobileActivityEventType;
  kind: MobileEventKind;
  startAt: string;
  lastAt: string;
  count: number;
  status: MobileEventStatus;
  detail: MobileEvent["detail"];
  reportVariant?: "done" | "blocked" | "failed" | "other";
  waitHint?: string;
};

function isTestShell(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    /\btest\b/.test(lower) ||
    /\bbuild\b/.test(lower) ||
    /\blint\b/.test(lower) ||
    /\bvitest\b/.test(lower) ||
    /\bjest\b/.test(lower) ||
    /\bpytest\b/.test(lower) ||
    /npm\s+test/.test(lower) ||
    /node\s+--import\s+tsx\s+--test/.test(lower)
  );
}

export function rawTypeToKind(raw: RawEvent): {
  kind: MobileEventKind;
  immediate: boolean;
  reportVariant?: "done" | "blocked" | "failed" | "other";
  waitHint?: string;
  summaryText?: string;
} | null {
  const tool = String(raw.tool ?? "").toLowerCase();
  const target = String(raw.target ?? raw.text ?? "").toLowerCase();

  switch (raw.type) {
    case "thinking": {
      const extracted = extractSafeThinkingSummary(String(raw.text ?? ""));
      if (extracted) {
        const classified = classifyThinkingSummary(extracted);
        return {
          kind: classified.kind,
          immediate: classified.immediate,
          summaryText: extracted,
        };
      }
      return { kind: "ANALYZING", immediate: false };
    }
    case "file_read":
    case "file_search":
      return { kind: "ANALYZING", immediate: false };
    case "file_write":
      return { kind: "IMPLEMENTING", immediate: false };
    case "shell": {
      const cmd = String(raw.target ?? raw.text ?? "");
      if (isTestShell(cmd || target || tool)) {
        const label = extractTestLabel(cmd);
        if (raw.status === "failed") {
          return { kind: "WARNING", immediate: true, summaryText: "测试失败" };
        }
        if (raw.status === "done") {
          return { kind: "TESTING", immediate: true, summaryText: `${label} 测试通过` };
        }
        return { kind: "TESTING", immediate: false };
      }
      return { kind: "IMPLEMENTING", immediate: false };
    }
    case "test":
      if (raw.status === "failed") {
        return { kind: "WARNING", immediate: true, summaryText: "测试失败" };
      }
      if (raw.status === "done") {
        return { kind: "TESTING", immediate: true, summaryText: "测试通过" };
      }
      return { kind: "TESTING", immediate: false };
    case "report": {
      const st = String(raw.status ?? raw.text ?? "").toLowerCase();
      let variant: "done" | "blocked" | "failed" | "other" = "other";
      if (st.includes("done") || st === "success") variant = "done";
      else if (st.includes("block")) variant = "blocked";
      else if (st.includes("fail") || st === "failed" || st === "error") variant = "failed";
      const summaryText =
        variant === "done"
          ? "回执已提交"
          : variant === "blocked"
            ? "回执提交：blocked"
            : variant === "failed"
              ? "回执提交：failed"
              : undefined;
      return { kind: "REPORTING", immediate: true, reportVariant: variant, summaryText };
    }
    case "task_move": {
      const action = String(raw.text ?? raw.target ?? "").toLowerCase();
      if (action.includes("claim")) return { kind: "TASK_RECEIVED", immediate: true };
      if (action.includes("submit_review") || action.includes("submit")) {
        return {
          kind: "REPORTING",
          immediate: true,
          reportVariant: "other",
          summaryText: "已提交验收",
        };
      }
      if (action.includes("approve")) {
        return { kind: "COMPLETED", immediate: true };
      }
      if (action.includes("reject")) {
        return { kind: "WARNING", immediate: true };
      }
      if (action.includes("done") || action.includes("archive")) {
        return { kind: "COMPLETED", immediate: true };
      }
      return { kind: "REPORTING", immediate: true, reportVariant: "other" };
    }
    case "wait": {
      const hint = String(raw.text ?? "").toLowerCase();
      if (
        hint.includes("wake_throttled") ||
        hint.includes("sdk_cooldown") ||
        hint.includes("circuit")
      ) {
        return {
          kind: "WARNING",
          immediate: true,
          waitHint: `${agentRole(raw.agent)} 正在冷却中`,
        };
      }
      const waitHint = raw.text ? sanitizeReason(raw.text) : undefined;
      return { kind: "WAITING", immediate: false, waitHint };
    }
    case "warning":
    case "error":
      return { kind: "WARNING", immediate: true };
    case "tool_call": {
      if (tool === "write_report" || tool === "write_report_file") {
        const st = String(raw.status ?? raw.text ?? "").toLowerCase();
        let variant: "done" | "blocked" | "failed" | "other" = "other";
        if (st.includes("done") || st === "success") variant = "done";
        else if (st.includes("block")) variant = "blocked";
        else if (st.includes("fail") || st === "failed") variant = "failed";
        const summaryText =
          variant === "done"
            ? "回执已提交"
            : variant === "blocked"
              ? "回执提交：blocked"
              : variant === "failed"
                ? "回执提交：failed"
                : undefined;
        return { kind: "REPORTING", immediate: true, reportVariant: variant, summaryText };
      }
      const mapped = mapToolToRawType(tool, target);
      if (!mapped) return null;
      return rawTypeToKind({ ...raw, type: mapped });
    }
    default:
      return null;
  }
}

/** Map compressor kind + raw source to explicit activity event type for clients. */
export function kindToActivityEventType(
  kind: MobileEventKind,
  raw?: Pick<RawEvent, "type" | "text" | "tool">,
): MobileActivityEventType {
  if (raw?.type === "task_move") {
    const action = String(raw.text ?? "").toLowerCase();
    if (action.includes("claim")) return "task_dispatched";
    if (action.includes("submit")) return "report_written";
  }
  if (raw?.type === "report") return "report_written";
  if (
    raw?.type === "tool_call" &&
    (raw.tool === "write_report" || raw.tool === "write_report_file")
  ) {
    return "report_written";
  }
  switch (kind) {
    case "TASK_RECEIVED":
      return "task_created";
    case "ANALYZING":
    case "IMPLEMENTING":
    case "TESTING":
    case "WAITING":
      return "agent_running";
    case "REPORTING":
      return "report_written";
    case "COMPLETED":
    case "WARNING":
      return "system_event";
    default:
      return "system_event";
  }
}

function isVisibleActivityEvent(event: MobileEvent): boolean {
  if (isChatActivityTaskId(event.taskId)) return false;
  if (event.eventType === "chat_message") return false;
  return true;
}

function mapToolToRawType(tool: string, target: string): RawEventType | null {
  const readTools = new Set([
    "read",
    "read_file",
    "grep",
    "grep_files",
    "glob",
    "glob_file_search",
    "list_dir",
    "semanticsearch",
    "codebase_search",
    "fetch",
  ]);
  if (readTools.has(tool)) return "file_read";

  const writeTools = new Set(["write", "write_file", "create_file"]);
  const editTools = new Set([
    "search_replace",
    "strreplace",
    "apply_patch",
    "edit_notebook",
    "delete",
    "delete_file",
    "edit",
  ]);
  if (writeTools.has(tool) || editTools.has(tool)) return "file_write";

  const commandTools = new Set([
    "shell",
    "run_terminal_cmd",
    "run_command",
    "execute_command",
    "bash",
  ]);
  if (commandTools.has(tool)) return "shell";

  return null;
}

function bucketKey(taskId: string, agent: string, kind: MobileEventKind): string {
  return `${taskId}::${agent}::${kind}`;
}

function mergeDetail(
  existing: MobileEvent["detail"] | undefined,
  raw: RawEvent,
): MobileEvent["detail"] {
  const detail = existing ?? { tools: [], files: [], rawTypes: [] };
  const tools = new Set(detail.tools ?? []);
  const files = new Set(detail.files ?? []);
  const rawTypes = new Set(detail.rawTypes ?? []);
  if (raw.tool) tools.add(raw.tool);
  if (raw.type) rawTypes.add(raw.type);
  const fileHint = raw.target || raw.text;
  if (fileHint && (raw.type === "file_read" || raw.type === "file_write" || raw.type === "file_search")) {
    const base = sanitizeBasename(fileHint);
    if (base) files.add(base);
  }
  const reportId = extractReportId(raw.text, raw.target) ?? detail.reportId;
  let command = detail.command;
  const shellHint = String(raw.target ?? raw.text ?? "");
  if (
    (raw.type === "shell" ||
      raw.tool === "shell" ||
      raw.tool === "run_terminal_cmd" ||
      raw.tool === "run_command" ||
      raw.tool === "execute_command" ||
      raw.tool === "bash") &&
    shellHint &&
    shellHint !== "shell"
  ) {
    command = sanitizeCommand(shellHint);
  }
  return {
    tools: [...tools].slice(0, 8),
    files: [...files].slice(0, 12),
    rawTypes: [...rawTypes].slice(0, 12),
    lastRawEventId: raw.id,
    reason: detail.reason,
    summaryText: detail.summaryText,
    reportId,
    command,
  };
}

function bucketToMobileEvent(bucket: PendingBucket, endAt?: string): MobileEvent {
  const fileCount = bucket.detail?.files?.length ?? 0;
  const startMs = Date.parse(bucket.startAt);
  const endMs = endAt ? Date.parse(endAt) : Date.now();
  const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : undefined;
  return {
    id: bucket.mobileId,
    taskId: bucket.taskId,
    agent: bucket.agent,
    eventType: bucket.eventType,
    kind: bucket.kind,
    summary: buildSummary(bucket.agent, bucket.kind, bucket.count, fileCount, {
      reportVariant: bucket.reportVariant,
      waitHint: bucket.waitHint,
      summaryText: bucket.detail?.summaryText,
    }),
    status: bucket.status,
    startAt: bucket.startAt,
    endAt,
    count: bucket.count,
    durationMs,
    detail: bucket.detail,
  };
}

export class OperationCompressor {
  private readonly globalCap: number;
  private readonly taskCap: number;
  private readonly flushed: MobileEvent[] = [];
  private readonly taskIndex = new Map<string, MobileEvent[]>();
  private readonly pending = new Map<string, PendingBucket>();

  constructor(opts?: { globalCap?: number; taskCap?: number }) {
    this.globalCap = opts?.globalCap ?? MOBILE_ACTIVITY_GLOBAL_CAP;
    this.taskCap = opts?.taskCap ?? MOBILE_ACTIVITY_TASK_CAP;
  }

  ingest(raw: RawEvent): MobileEvent | null {
    if (!raw.taskId || !raw.agent) return null;
    if (isChatActivityTaskId(raw.taskId)) return null;
    const mapped = rawTypeToKind(raw);
    if (!mapped) return null;

    this.flushStalePending(Date.parse(raw.at) || Date.now());

    const { kind, immediate, reportVariant, waitHint, summaryText } = mapped;
    this.flushOtherKindsForAgent(raw.taskId, raw.agent, kind, raw.at);

    if (immediate || IMMEDIATE_KINDS.has(kind) || kind === "REPORTING") {
      const status: MobileEventStatus =
        kind === "WARNING" || raw.type === "error"
          ? raw.status === "failed"
            ? "error"
            : "warning"
          : kind === "COMPLETED" || reportVariant === "done"
            ? "done"
            : reportVariant === "blocked" || reportVariant === "failed"
              ? "warning"
              : "done";
      const detail = mergeDetail(undefined, raw) ?? {};
      if (summaryText) detail.summaryText = summaryText;
      if (kind === "WARNING" && (raw.text || raw.target)) {
        detail.reason = sanitizeReason(String(raw.text ?? raw.target ?? ""));
        if (!summaryText && detail.reason && detail.reason !== "需要关注") {
          detail.summaryText = detail.reason;
        }
      }
      const event: MobileEvent = {
        id: nextMobileId(),
        taskId: raw.taskId,
        agent: raw.agent,
        eventType: kindToActivityEventType(kind, raw),
        kind,
        summary: buildSummary(raw.agent, kind, 1, detail.files?.length ?? 0, {
          reportVariant,
          waitHint,
          summaryText: summaryText ?? detail.summaryText,
        }),
        status,
        startAt: raw.at,
        endAt: raw.at,
        count: 1,
        durationMs: 0,
        detail,
      };
      this.pushFlushed(event);
      return event;
    }

    const key = bucketKey(raw.taskId, raw.agent, kind);
    const nowMs = Date.parse(raw.at) || Date.now();
    let bucket = this.pending.get(key);
    if (bucket) {
      const gap = nowMs - (Date.parse(bucket.lastAt) || nowMs);
      if (gap > MERGE_WINDOW_MS) {
        this.flushPendingKey(key, bucket.lastAt);
        bucket = undefined;
      }
    }

    if (!bucket) {
      bucket = {
        mobileId: nextMobileId(),
        taskId: raw.taskId,
        agent: raw.agent,
        eventType: kindToActivityEventType(kind, raw),
        kind,
        startAt: raw.at,
        lastAt: raw.at,
        count: 0,
        status: "running",
        detail: { tools: [], files: [], rawTypes: [] },
        reportVariant,
        waitHint,
      };
      this.pending.set(key, bucket);
    }

    bucket.count += 1;
    bucket.lastAt = raw.at;
    bucket.detail = mergeDetail(bucket.detail, raw);
    if (raw.status === "failed") bucket.status = "error";
    else if (raw.status === "done") bucket.status = "done";

    return bucketToMobileEvent(bucket);
  }

  private flushOtherKindsForAgent(taskId: string, agent: string, kind: MobileEventKind, at: string): void {
    for (const [key, bucket] of [...this.pending.entries()]) {
      if (bucket.taskId !== taskId || bucket.agent !== agent) continue;
      if (bucket.kind === kind) continue;
      this.flushPendingKey(key, at);
    }
  }

  private flushPendingKey(key: string, endAt: string): void {
    const bucket = this.pending.get(key);
    if (!bucket) return;
    this.pending.delete(key);
    const event = bucketToMobileEvent(bucket, endAt);
    if (bucket.status === "running" && bucket.kind !== "WAITING" && bucket.kind !== "ANALYZING") {
      event.status = "done";
    }
    this.pushFlushed(event);
  }

  flushStalePending(nowMs: number = Date.now()): void {
    for (const [key, bucket] of [...this.pending.entries()]) {
      const last = Date.parse(bucket.lastAt) || nowMs;
      if (nowMs - last >= MERGE_WINDOW_MS) {
        this.flushPendingKey(key, new Date(last + MERGE_WINDOW_MS).toISOString());
      }
    }
  }

  flushAllPending(): void {
    const now = new Date().toISOString();
    for (const key of [...this.pending.keys()]) {
      this.flushPendingKey(key, now);
    }
  }

  private pushFlushed(event: MobileEvent): void {
    this.flushed.push(event);
    while (this.flushed.length > this.globalCap) {
      const removed = this.flushed.shift();
      if (removed) this.removeFromTaskIndex(removed);
    }
    const list = this.taskIndex.get(event.taskId) ?? [];
    list.push(event);
    while (list.length > this.taskCap) {
      list.shift();
    }
    this.taskIndex.set(event.taskId, list);
  }

  private removeFromTaskIndex(event: MobileEvent): void {
    const list = this.taskIndex.get(event.taskId);
    if (!list) return;
    const idx = list.findIndex((e) => e.id === event.id);
    if (idx >= 0) list.splice(idx, 1);
  }

  getActiveEvents(limit = MOBILE_ACTIVITY_DEFAULT_LIMIT): MobileEvent[] {
    this.flushStalePending();
    const pendingEvents = [...this.pending.values()].map((b) => bucketToMobileEvent(b));
    const merged = [...this.flushed, ...pendingEvents];
    merged.sort((a, b) => Date.parse(b.startAt) - Date.parse(a.startAt));
    return merged.filter(isVisibleActivityEvent).slice(0, limit);
  }

  getTaskEvents(taskId: string, limit = MOBILE_TASK_ACTIVITY_DEFAULT_LIMIT): MobileEvent[] {
    if (isChatActivityTaskId(taskId)) return [];
    this.flushStalePending();
    const pending = [...this.pending.values()]
      .filter((b) => b.taskId === taskId)
      .map((b) => bucketToMobileEvent(b));
    const flushed = this.taskIndex.get(taskId) ?? [];
    const merged = [...flushed, ...pending];
    merged.sort((a, b) => Date.parse(b.startAt) - Date.parse(a.startAt));
    return merged.filter(isVisibleActivityEvent).slice(0, limit);
  }
}
