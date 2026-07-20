/**
 * AnalyticsLedger — 统一数据资产账本
 *
 * 写入 `fcop/logs/analytics/events-YYYYMMDD.jsonl`，供分析时按
 * platform / role / model_id / agent_id / session_id 等维度筛选。
 *
 * 与门铃缓冲、fcop/logs/runtime/runtime-events.jsonl、thinking/usage 并存：
 * 本模块是**分析用**的统一 enriched 视图，不替代运维实时链路。
 * 旧路径 `.codeflowmu/analytics/` 仅只读回退。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { AgentRegistry } from "@codeflowmu/runtime";

import {
  fcopLogsAnalyticsDir,
  legacyAnalyticsDir,
} from "./logs-paths.ts";

/** 分析维度：平台、协议角色、模型 */
export interface AnalyticsDimensions {
  platform: string;
  role: string;
  model_id: string;
  /** sdk.result 中观测到的实际模型（可多模型） */
  models_used?: string[];
  task_id?: string;
  thread_key?: string;
}

export interface AnalyticsRecord {
  ts: number;
  at: string;
  event_type: string;
  platform?: string;
  role?: string;
  model_id?: string;
  models_used?: string[];
  agent_id?: string;
  session_id?: string;
  task_id?: string;
  thread_key?: string;
  channel?: "chat" | "task";
  payload?: Record<string, unknown>;
}

export interface AnalyticsQueryParams {
  platform?: string;
  role?: string;
  model_id?: string;
  agent_id?: string;
  session_id?: string;
  task_id?: string;
  event_type?: string;
  since?: number;
  limit?: number;
}

export interface AnalyticsSummary {
  since: number;
  total: number;
  by_platform: Record<string, number>;
  by_role: Record<string, number>;
  by_model_id: Record<string, number>;
  by_event_type: Record<string, number>;
}

const ANALYTICS_EVENT_TYPES = new Set([
  "sdk.thinking",
  "sdk.tool_call",
  "sdk.assistant",
  "sdk.result",
  "sdk.status",
  "runtime.session_started",
  "runtime.session_ended",
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
  "codeflowmu.failure",
  "codeflowmu.failure_recorded",
]);

const README = `# Codeflowmu Analytics Ledger

统一分析数据资产目录（位于 \`fcop/logs/analytics/\`）。每日一个 JSONL 文件：

\`\`\`
fcop/logs/analytics/events-YYYYMMDD.jsonl
\`\`\`

## 每行字段

| 字段 | 含义 |
|------|------|
| \`platform\` | LLM 平台：\`cursor\` / \`google\`（来自 CODEFLOW_PROVIDER） |
| \`role\` | FCoP 协议角色（如 \`pm\`、\`developer\`），来自 Agent 注册表 |
| \`model_id\` | 配置或观测到的主模型 ID |
| \`models_used\` | \`sdk.result\` 时实际计费模型列表（可选） |
| \`agent_id\` | 数字员工 ID（如 PM-01） |
| \`session_id\` / \`task_id\` / \`thread_key\` | 会话与任务链路 |
| \`channel\` | \`chat\`（面板聊天）或 \`task\`（派单/唤醒） |
| \`event_type\` / \`payload\` | 事件类型与载荷 |

## 查询 API

- \`GET /api/v2/analytics/query?platform=&role=&model_id=&since=\`
- \`GET /api/v2/analytics/summary?since=\`

运维实时视图仍见：门铃缓冲、\`fcop/logs/runtime/runtime-events.jsonl\`、
\`fcop/logs/thinking/\`、\`fcop/logs/usage/\`。
`;

interface SessionOverlay {
  agent_id?: string;
  task_id?: string;
  thread_key?: string;
  channel?: "chat" | "task";
  model_id?: string;
  models_used?: string[];
}

interface AgentMeta {
  role: string;
  model_id: string;
  platform: string;
}

export class AnalyticsLedger {
  private readonly _projectRoot: string;
  private readonly _dir: string;
  private readonly _getPlatform: () => string;
  private _currentDate = "";
  private _currentPath = "";
  private readonly _agentMeta = new Map<string, AgentMeta>();
  private readonly _sessions = new Map<string, SessionOverlay>();

  constructor(projectRoot: string, getPlatform: () => string = defaultPlatform) {
    this._projectRoot = projectRoot;
    this._dir = fcopLogsAnalyticsDir(projectRoot);
    this._getPlatform = getPlatform;
    try {
      mkdirSync(this._dir, { recursive: true });
      const readmePath = join(this._dir, "README.md");
      if (!existsSync(readmePath)) {
        writeFileSync(readmePath, README, "utf-8");
      }
    } catch {
      /* best-effort */
    }
  }

  get dir(): string {
    return this._dir;
  }

  shouldRecord(eventType: string): boolean {
    return ANALYTICS_EVENT_TYPES.has(eventType);
  }

  /** 从注册表预热 agent → role/model 缓存 */
  async bootstrapFromRegistry(registry: AgentRegistry): Promise<void> {
    try {
      const all = await registry.list();
      for (const rec of all) {
        this.noteAgentRecord(rec.protocol.agent_id, rec.protocol.role, rec.protocol.model?.id);
      }
    } catch {
      /* best-effort */
    }
  }

  noteAgentRecord(agentId: string, role: string, modelId?: string | null): void {
    const id = String(agentId ?? "").trim();
    if (!id) return;
    const platform = this._getPlatform();
    const prev = this._agentMeta.get(id);
    this._agentMeta.set(id, {
      role: String(role ?? prev?.role ?? "").trim() || "unknown",
      model_id: String(modelId ?? prev?.model_id ?? "").trim() || "default",
      platform,
    });
  }

  async ensureAgentMeta(agentId: string, registry: AgentRegistry): Promise<void> {
    const id = String(agentId ?? "").trim();
    if (!id || this._agentMeta.has(id)) return;
    try {
      const rec = await registry.get(id);
      if (rec) {
        this.noteAgentRecord(
          rec.protocol.agent_id,
          rec.protocol.role,
          rec.protocol.model?.id,
        );
      }
    } catch {
      /* best-effort */
    }
  }

  noteSession(overlay: SessionOverlay & { session_id: string }): void {
    const sid = String(overlay.session_id ?? "").trim();
    if (!sid) return;
    const { session_id: _sid, ...rest } = overlay;
    const prev = this._sessions.get(sid) ?? {};
    this._sessions.set(sid, { ...prev, ...rest });
  }

  clearSession(sessionId: string | undefined): void {
    const sid = String(sessionId ?? "").trim();
    if (sid) this._sessions.delete(sid);
  }

  /** 同步解析当前事件应携带的分析维度（供 thinking/usage 等复用） */
  resolveDimensions(input: {
    agent_id?: string;
    session_id?: string;
    payload?: unknown;
    channel?: "chat" | "task";
  }): AnalyticsDimensions {
    const agentId = String(input.agent_id ?? "").trim();
    const sessionId = String(input.session_id ?? "").trim();
    const platform = this._getPlatform();
    const agent = agentId ? this._agentMeta.get(agentId) : undefined;
    const session = sessionId ? this._sessions.get(sessionId) : undefined;

    let model_id =
      session?.model_id ||
      agent?.model_id ||
      "default";
    const models_used = extractModelsFromPayload(
      (input.payload ?? {}) as Record<string, unknown>,
    );
    if (models_used.length > 0) {
      model_id = models_used[0]!;
    }

    const payload = (input.payload ?? {}) as Record<string, unknown>;
    const task_id =
      String(session?.task_id ?? payload["task_id"] ?? "").trim() || undefined;
    const thread_key =
      String(session?.thread_key ?? payload["thread_key"] ?? "").trim() ||
      undefined;

    return {
      platform: agent?.platform || platform,
      role: agent?.role || "unknown",
      model_id,
      ...(models_used.length > 0 ? { models_used } : {}),
      ...(task_id ? { task_id } : {}),
      ...(thread_key ? { thread_key } : {}),
      ...(input.channel ? {} : {}),
    };
  }

  appendFromRuntimeEvent(
    event: {
      event_type: string;
      agent_id?: string;
      session_id?: string;
      payload?: unknown;
    },
    extras?: { channel?: "chat" | "task"; task_id?: string; thread_key?: string },
  ): void {
    if (!this.shouldRecord(event.event_type)) return;

    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const sessionId = String(event.session_id ?? payload["session_id"] ?? "").trim();
    const agentId = String(event.agent_id ?? payload["agent_id"] ?? "").trim();

    if (event.event_type === "runtime.session_started" && sessionId) {
      const taskId = String(payload["task_id"] ?? extras?.task_id ?? "").trim();
      const threadKey = String(payload["thread_key"] ?? extras?.thread_key ?? "").trim();
      this.noteSession({
        session_id: sessionId,
        agent_id: agentId || undefined,
        task_id: taskId || undefined,
        thread_key: threadKey || undefined,
        channel: extras?.channel,
      });
    }

    if (event.event_type === "sdk.result" && sessionId) {
      const models = extractModelsFromPayload(payload);
      if (models.length > 0) {
        const prev = this._sessions.get(sessionId) ?? {};
        this._sessions.set(sessionId, {
          ...prev,
          model_id: models[0],
          models_used: models,
        });
      }
    }

    if (
      event.event_type === "runtime.session_ended" ||
      event.event_type === "runtime.session_cancelled"
    ) {
      this.clearSession(sessionId);
    }

    const dims = this.resolveDimensions({
      agent_id: agentId,
      session_id: sessionId,
      payload,
      channel: extras?.channel,
    });

    const session = sessionId ? this._sessions.get(sessionId) : undefined;
    const taskId =
      String(payload["task_id"] ?? extras?.task_id ?? session?.task_id ?? "").trim() ||
      undefined;
    const threadKey =
      String(payload["thread_key"] ?? extras?.thread_key ?? session?.thread_key ?? "").trim() ||
      undefined;
    const channel = extras?.channel ?? session?.channel;

    const record: AnalyticsRecord = {
      ts: Date.now(),
      at: new Date().toISOString(),
      event_type: event.event_type,
      platform: dims.platform,
      role: dims.role,
      model_id: dims.model_id,
      ...(dims.models_used?.length ? { models_used: dims.models_used } : {}),
      ...(agentId ? { agent_id: agentId } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(taskId ? { task_id: taskId } : {}),
      ...(threadKey ? { thread_key: threadKey } : {}),
      ...(channel ? { channel } : {}),
      payload: trimPayloadForAnalytics(event.event_type, payload),
    };

    this._writeLine(record);
  }

  query(params: AnalyticsQueryParams = {}): AnalyticsRecord[] {
    const since = params.since ?? 0;
    const limit = Math.min(Math.max(params.limit ?? 200, 1), 2000);
    const files = this._listJsonlFiles();
    const out: AnalyticsRecord[] = [];

    for (const file of files) {
      if (out.length >= limit) break;
      let raw: string;
      try {
        raw = readFileSync(file, "utf-8");
      } catch {
        continue;
      }
      const lines = raw.split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        const line = lines[i]!;
        let rec: AnalyticsRecord;
        try {
          rec = JSON.parse(line) as AnalyticsRecord;
        } catch {
          continue;
        }
        if (rec.ts < since) continue;
        if (params.platform && rec.platform !== params.platform) continue;
        if (params.role && rec.role !== params.role) continue;
        if (params.model_id && rec.model_id !== params.model_id) continue;
        if (params.agent_id && rec.agent_id !== params.agent_id) continue;
        if (params.session_id && rec.session_id !== params.session_id) continue;
        if (params.task_id && rec.task_id !== params.task_id) continue;
        if (params.event_type && rec.event_type !== params.event_type) continue;
        out.push(rec);
      }
    }

    return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  summarize(since?: number): AnalyticsSummary {
    const sinceTs = since ?? startOfTodayMs();
    const rows = this.query({ since: sinceTs, limit: 2000 });
    const summary: AnalyticsSummary = {
      since: sinceTs,
      total: rows.length,
      by_platform: {},
      by_role: {},
      by_model_id: {},
      by_event_type: {},
    };
    for (const row of rows) {
      inc(summary.by_platform, row.platform ?? "unknown");
      inc(summary.by_role, row.role ?? "unknown");
      inc(summary.by_model_id, row.model_id ?? "unknown");
      inc(summary.by_event_type, row.event_type);
    }
    return summary;
  }

  private _writeLine(record: AnalyticsRecord): void {
    try {
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      if (today !== this._currentDate) {
        this._currentDate = today;
        this._currentPath = join(this._dir, `events-${today}.jsonl`);
      }
      const path = this._currentPath;
      const line = JSON.stringify(record);
      setImmediate(() => {
        try {
          appendFileSync(path, line + "\n", "utf-8");
        } catch {
          /* best-effort */
        }
      });
    } catch {
      /* never crash runtime */
    }
  }

  private _listJsonlFiles(): string[] {
    const seen = new Set<string>();
    const files: string[] = [];

    const scanDir = (dir: string) => {
      try {
        for (const f of readdirSync(dir)) {
          if (!f.startsWith("events-") || !f.endsWith(".jsonl")) continue;
          if (seen.has(f)) continue;
          seen.add(f);
          files.push(join(dir, f));
        }
      } catch {
        /* skip */
      }
    };

    scanDir(this._dir);
    const legacy = legacyAnalyticsDir(this._projectRoot);
    if (legacy !== this._dir) scanDir(legacy);

    return files.sort((a, b) => {
      try {
        return statSync(b).mtimeMs - statSync(a).mtimeMs;
      } catch {
        return b.localeCompare(a);
      }
    });
  }
}

export function analyticsFieldsFromDimensions(
  dims: AnalyticsDimensions,
): Record<string, string | string[] | undefined> {
  return {
    platform: dims.platform,
    role: dims.role,
    model_id: dims.model_id,
    ...(dims.models_used?.length ? { models_used: dims.models_used } : {}),
  };
}

function defaultPlatform(): string {
  return process.env["CODEFLOW_PROVIDER"]?.trim() || "cursor";
}

function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function inc(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export function extractModelsFromPayload(
  payload: Record<string, unknown>,
): string[] {
  const raw = payload["raw"] as Record<string, unknown> | undefined;
  const modelUsage = raw?.["modelUsage"] as Record<string, unknown> | undefined;
  if (modelUsage && typeof modelUsage === "object") {
    return Object.keys(modelUsage).filter(Boolean);
  }
  const direct = payload["modelUsage"] as Record<string, unknown> | undefined;
  if (direct && typeof direct === "object") {
    return Object.keys(direct).filter(Boolean);
  }
  return [];
}

function trimPayloadForAnalytics(
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (eventType !== "sdk.thinking") return payload;
  const copy = { ...payload };
  const raw = copy["raw"] as Record<string, unknown> | undefined;
  if (raw && typeof raw === "object") {
    const text = String(raw["text"] ?? raw["thinking"] ?? "");
    if (text.length > 800) {
      copy["raw"] = { ...raw, text: text.slice(0, 800) + "…" };
    }
  }
  const direct = String(copy["text"] ?? "");
  if (direct.length > 800) {
    copy["text"] = direct.slice(0, 800) + "…";
  }
  return copy;
}
