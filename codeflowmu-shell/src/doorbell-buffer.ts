/**
 * DoorbellBuffer — in-memory ring buffer for Web Panel event persistence.
 *
 * Captures a subset of SSE events (sdk.tool_call, sdk.thinking, sdk.status,
 * codeflowmu.failure) into a fixed-size circular buffer (default 1000 entries).
 * Provides query helpers for the /api/v2/doorbell/* REST endpoints.
 *
 * Design notes:
 *   - In-memory ring buffer for fast Panel queries; on startup, replays
 *     recent entries from `fcop/logs/runtime/runtime-events.jsonl`（旧路径
 *     `.codeflowmu/events/` 仅只读回退）via `hydrateFromDisk()`.
 *   - Ring eviction: oldest entry is dropped once capacity is exceeded.
 *   - No external deps: ID generation uses Node's built-in crypto.randomUUID().
 *
 * Added in v0.3 (TASK-20260514-001 — Lane B doorbell persistence).
 */

import { randomUUID } from "node:crypto";

/** Event types that are persisted to the ring buffer. */
export const DOORBELL_BUFFERED_TYPES = new Set([
  "sdk.tool_call",
  "sdk.thinking",
  "sdk.status",
  "sdk.result",
  "codeflowmu.failure",
  // Sprint-B: system events for Tab-3
  "runtime.session_started",
  "runtime.session_ended",
  "runtime.session_completed",
  "runtime.session_cancelled",
  "wake_agent.requested",
  "wake_agent.accepted",
  "wake_agent.failed",
  "wake_agent.skipped",
  "wake_agent.delayed",
  "transient_sdk_error",
  "transient_sdk_retry",
  // codeflowmu.heartbeat — SSE 保活 only; 不写入 ring buffer（避免淹没「最近流转」）
  "codeflowmu.failure_recorded",
  "codeflowmu.task_dispatched",
  "codeflowmu.report_detected",
  "codeflowmu.lifecycle.inbox_to_active",
  "codeflowmu.lifecycle.task_to_review",
  "codeflowmu.lifecycle.root_review_blocked",
  "codeflowmu.lifecycle.pending_pm_review",
  "codeflowmu.lifecycle.review_to_done",
  "codeflowmu.lifecycle.done_to_archive",
  "codeflowmu.lifecycle.review_to_active",
  "codeflowmu.lifecycle.done_to_active",
  "codeflowmu.report_gate.missing_report",
  "codeflowmu.report_gate.waiting_report",
]);

/** Categorisation buckets for the three doorbell tab endpoints. */
export const DOORBELL_BUCKET_TOOLS = ["sdk.tool_call"];
export const DOORBELL_BUCKET_FAILURES = ["codeflowmu.failure", "codeflowmu.failure_recorded"];
export const DOORBELL_BUCKET_SYSTEM = [
  "sdk.thinking",
  "sdk.status",
  "sdk.result",
  "runtime.session_started",
  "runtime.session_ended",
  "runtime.session_completed",
  "runtime.session_cancelled",
  "wake_agent.requested",
  "wake_agent.accepted",
  "wake_agent.failed",
  "wake_agent.skipped",
  "wake_agent.delayed",
  "transient_sdk_error",
  "transient_sdk_retry",
  "codeflowmu.task_dispatched",
  "codeflowmu.report_detected",
  "codeflowmu.lifecycle.inbox_to_active",
  "codeflowmu.lifecycle.task_to_review",
  "codeflowmu.lifecycle.root_review_blocked",
  "codeflowmu.lifecycle.pending_pm_review",
  "codeflowmu.lifecycle.review_to_done",
  "codeflowmu.lifecycle.done_to_archive",
  "codeflowmu.lifecycle.review_to_active",
  "codeflowmu.lifecycle.done_to_active",
  "codeflowmu.report_gate.missing_report",
  "codeflowmu.report_gate.waiting_report",
];

export interface DoorbellEvent {
  /** nanoid-style unique ID (crypto.randomUUID). */
  id: string;
  /** Unix milliseconds at capture time. */
  ts: number;
  /** ISO timestamp at capture time. */
  at: string;
  /** Original event type string (e.g. "sdk.tool_call"). */
  event_type: string;
  /** Agent that produced the event, if identifiable from payload. */
  agent_id?: string;
  /** Session id when present on payload. */
  session_id?: string;
  /** Task id when present on payload. */
  task_id?: string;
  /** Tool name for sdk.tool_call events. */
  tool_name?: string;
  /** Short preview of tool arguments (first 120 chars). */
  args_preview?: string;
  /** Execution status, when available. */
  status?: "success" | "error" | "running";
  /** Elapsed time in milliseconds, when available. */
  duration_ms?: number;
  /** Full original payload (pass-through, opaque). */
  payload: unknown;
}

export interface DoorbellQueryOpts {
  /** Filter by agent_id. */
  agent?: string;
  /** Filter by session_id (exact). */
  session_id?: string;
  /** Filter by task_id (substring, case-insensitive). */
  task_id?: string;
  /** Filter by exact event_type. */
  type?: string;
  /** Whitelist of event_types (OR). Takes precedence over `type` if both set. */
  types?: string[];
  /** Only return events with ts > since. */
  since?: number;
  /** Maximum number of results (newest-first, default 50, max 500). */
  limit?: number;
}

export interface DoorbellQueryResult {
  /** Total matching events (before limit). */
  total: number;
  /** Matching events, newest-first, up to `limit`. */
  events: DoorbellEvent[];
}

export class DoorbellBuffer {
  private readonly _buf: DoorbellEvent[] = [];
  private readonly _max: number;

  constructor(max = 1000) {
    this._max = max;
  }

  /** Current number of buffered events. */
  get size(): number {
    return this._buf.length;
  }

  /**
   * Push a raw SSE event into the buffer.
   *
   * Silently ignores event types not in `DOORBELL_BUFFERED_TYPES` so the
   * caller can unconditionally forward every `sseEmit` call here.
   */
  push(event_type: string, payload: unknown): void {
    if (!DOORBELL_BUFFERED_TYPES.has(event_type)) return;
    const p = (payload ?? {}) as Record<string, unknown>;
    if (
      event_type === "codeflowmu.failure" ||
      event_type === "codeflowmu.failure_recorded"
    ) {
      const key = this._failureDedupeKey(p);
      if (key && this._hasFailureKey(key)) return;
    }
    const entry = this._extract(event_type, payload);
    this._buf.push(entry);
    if (this._buf.length > this._max) {
      this._buf.shift();
    }
  }

  /**
   * Replay a persisted runtime event (from runtime-events.jsonl) into the buffer.
   * Uses the original timestamp when provided.
   */
  hydrateFromDisk(
    event_type: string,
    payload: unknown,
    ts?: number,
  ): void {
    if (!DOORBELL_BUFFERED_TYPES.has(event_type)) return;
    const entry = this._extract(event_type, payload);
    if (ts != null && Number.isFinite(ts)) {
      entry.ts = ts;
      entry.at = new Date(ts).toISOString();
    }
    this._buf.push(entry);
    if (this._buf.length > this._max) {
      this._buf.shift();
    }
  }

  /**
   * Query buffered events with optional filters.
   *
   * Results are returned newest-first (reverse chronological).
   */
  query(opts: DoorbellQueryOpts = {}): DoorbellQueryResult {
    let results = this._buf as readonly DoorbellEvent[];

    // Type filter — `types` (whitelist) takes precedence over `type` (exact).
    if (opts.types && opts.types.length > 0) {
      const set = new Set(opts.types);
      results = results.filter((e) => set.has(e.event_type));
    } else if (opts.type) {
      results = results.filter((e) => e.event_type === opts.type);
    }

    if (opts.agent) {
      results = results.filter((e) => e.agent_id === opts.agent);
    }

    if (opts.session_id) {
      results = results.filter((e) => e.session_id === opts.session_id);
    }

    if (opts.task_id) {
      const norm = opts.task_id.replace(/\.md$/i, "").toUpperCase();
      results = results.filter((e) => {
        const tid = (e.task_id ?? "").replace(/\.md$/i, "").toUpperCase();
        return tid && (tid.includes(norm) || norm.includes(tid));
      });
    }

    if (opts.since !== undefined) {
      const since = opts.since;
      results = results.filter((e) => e.ts > since);
    }

    const total = results.length;
    const limit = Math.min(opts.limit ?? 50, 500);

    // Newest-first: slice from the end, then reverse.
    const events = (results as DoorbellEvent[]).slice(-limit).reverse();

    return { total, events };
  }

  // ── private ──────────────────────────────────────────────────────────

  private _failureDedupeKey(p: Record<string, unknown>): string | null {
    const sid =
      (typeof p["session_id"] === "string" && p["session_id"]) ||
      (typeof p["sessionId"] === "string" && p["sessionId"]) ||
      undefined;
    const ft =
      (typeof p["failure_type"] === "string" && p["failure_type"]) ||
      "failure";
    return sid ? `${sid}|${ft}` : null;
  }

  private _hasFailureKey(key: string): boolean {
    for (let i = this._buf.length - 1; i >= 0; i--) {
      const e = this._buf[i]!;
      if (
        e.event_type !== "codeflowmu.failure" &&
        e.event_type !== "codeflowmu.failure_recorded"
      ) {
        continue;
      }
      const ep = (e.payload ?? {}) as Record<string, unknown>;
      const ek = this._failureDedupeKey({
        ...ep,
        session_id: e.session_id ?? ep["session_id"],
        failure_type: ep["failure_type"],
      });
      if (ek === key) return true;
    }
    return false;
  }

  private _extract(event_type: string, payload: unknown): DoorbellEvent {
    const p = (payload ?? {}) as Record<string, unknown>;

    const agentId =
      typeof p["agent_id"] === "string" ? p["agent_id"] : undefined;

    // 🚨 深度兼容与多级降级：从 RuntimeEvent.payload 内部提取 tool_name
    let toolName: string | undefined;
    const innerPayload = p["payload"] as Record<string, unknown> | undefined;
    
    if (innerPayload && typeof innerPayload === "object") {
      if (typeof innerPayload["tool_name"] === "string") {
        toolName = innerPayload["tool_name"];
      } else if (typeof innerPayload["tool"] === "string") {
        toolName = innerPayload["tool"];
      }
      
      const raw = innerPayload["raw"] as Record<string, unknown> | undefined;
      if (raw && typeof raw === "object") {
        if (typeof raw["name"] === "string") {
          toolName = raw["name"];
        } else if (typeof raw["tool_name"] === "string") {
          toolName = raw["tool_name"];
        } else if (typeof raw["tool"] === "string") {
          toolName = raw["tool"];
        }
      }
    }

    if (!toolName && typeof p["tool_name"] === "string") {
      toolName = p["tool_name"];
    }

    // Best-effort args preview
    let argsPreview: string | undefined;
    if (typeof p["args_preview"] === "string") {
      argsPreview = p["args_preview"].slice(0, 120);
    } else {
      let rawArgs: unknown;
      if (innerPayload && typeof innerPayload === "object") {
        if (innerPayload["args"] !== undefined) {
          rawArgs = innerPayload["args"];
        } else if (innerPayload["arguments"] !== undefined) {
          rawArgs = innerPayload["arguments"];
        } else if (innerPayload["input"] !== undefined) {
          rawArgs = innerPayload["input"];
        } else {
          const raw = innerPayload["raw"] as Record<string, unknown> | undefined;
          if (raw && typeof raw === "object") {
            rawArgs = raw["args"] ?? raw["arguments"] ?? raw["input"] ?? raw["name"];
          }
        }
      }

      if (rawArgs === undefined && p["args"] !== undefined) {
        rawArgs = p["args"];
      }

      if (rawArgs !== undefined) {
        const rawStr =
          typeof rawArgs === "string"
            ? rawArgs
            : JSON.stringify(rawArgs);
        argsPreview = rawStr.slice(0, 120);
      }
    }

    const status =
      p["status"] === "success" ||
      p["status"] === "error" ||
      p["status"] === "running"
        ? (p["status"] as "success" | "error" | "running")
        : undefined;

    const durationMs =
      typeof p["duration_ms"] === "number" ? p["duration_ms"] : undefined;

    const pickStr = (obj: Record<string, unknown>, ...keys: string[]): string | undefined => {
      for (const k of keys) {
        const v = obj[k];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      return undefined;
    };

    const sessionId =
      pickStr(p, "session_id", "sessionId") ??
      (innerPayload && typeof innerPayload === "object"
        ? pickStr(innerPayload, "session_id", "sessionId")
        : undefined);

    let taskId =
      pickStr(p, "task_id", "taskId", "root_task_id", "subject_id") ??
      (innerPayload && typeof innerPayload === "object"
        ? pickStr(innerPayload, "task_id", "taskId", "root_task_id", "subject_id")
        : undefined);
    if (!taskId && typeof p["filename"] === "string") {
      const m = p["filename"].match(/TASK-\d{8}-\d{3,}/);
      if (m) taskId = m[0];
    }

    return {
      id: randomUUID(),
      ts: Date.now(),
      at: new Date().toISOString(),
      event_type,
      ...(agentId !== undefined ? { agent_id: agentId } : {}),
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
      ...(taskId !== undefined ? { task_id: taskId } : {}),
      ...(toolName !== undefined ? { tool_name: toolName } : {}),
      ...(argsPreview !== undefined ? { args_preview: argsPreview } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
      payload,
    };
  }
}

