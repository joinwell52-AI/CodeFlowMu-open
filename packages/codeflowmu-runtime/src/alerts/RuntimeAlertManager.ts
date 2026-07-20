import {
  type AlertCategory,
  type AlertSeverity,
  type AlertStatus,
  type RuntimeAlert,
  type RuntimeAlertsSnapshot,
  NO_TOAST_CODES,
} from "./alert-taxonomy.ts";

export type IngestRuntimeAlertInput = {
  code: string;
  severity?: AlertSeverity;
  category?: AlertCategory;
  title?: string;
  message: string;
  affected_agent?: string;
  affected_task?: string;
  affected_report?: string;
  cooldown_until?: number;
  next_retry_at?: number;
  current_action?: string;
  status?: AlertStatus;
};

export type IngestFromEventInput = {
  event_type?: string;
  agent_id?: string;
  message?: string;
  description?: string;
  error?: string;
  task_id?: string;
  failure_type?: string;
  severity?: string;
  reason?: string;
  transient_sdk_error?: boolean;
  payload?: Record<string, unknown>;
};

const MAX_ALERTS = 200;
const P0_TOAST_TTL_MS = 5 * 60 * 1000;

function nowMs(): number {
  return Date.now();
}

function buildAlertKey(parts: {
  severity: AlertSeverity;
  category: AlertCategory;
  code: string;
  affected_agent?: string;
  affected_task?: string;
}): string {
  return [
    parts.severity,
    parts.category,
    parts.code,
    parts.affected_agent ?? "",
    parts.affected_task ?? "",
  ].join(":");
}

function severityRank(s: AlertSeverity): number {
  if (s === "P0") return 0;
  if (s === "P1") return 1;
  if (s === "P2") return 2;
  return 3;
}

function overallFromAlerts(alerts: RuntimeAlert[]): "ok" | "degraded" | "critical" {
  if (alerts.some((a) => a.severity === "P0" && a.status !== "resolved")) return "critical";
  if (alerts.some((a) => (a.severity === "P1" || a.severity === "P2") && a.status !== "resolved"))
    return "degraded";
  return "ok";
}

function classifyFromText(
  text: string,
  ctx: {
    failure_type?: string;
    event_type?: string;
    payload?: Record<string, unknown>;
  },
): Pick<
  IngestRuntimeAlertInput,
  "code" | "category" | "severity" | "title" | "status" | "current_action"
> | null {
  const lower = text.toLowerCase();
  const ft = (ctx.failure_type ?? "").toLowerCase();

  // A policy rejection means the governance guard worked as designed. Keep it
  // observable, but do not promote it to a runtime failure/banner or let the
  // matching sdk.status + session_ended events create separate P1 incidents.
  if (
    lower.includes("codeflowmu_policy_blocked") ||
    lower.includes("策略边界拦截") ||
    ft === "policy_blocked"
  ) {
    return {
      code: "POLICY_BLOCKED",
      category: "role_boundary",
      severity: "P3",
      title: "策略边界已拦截（非系统故障）",
      status: "waiting",
    };
  }

  if (
    lower.includes("nghttp2") ||
    lower.includes("enhance your calm") ||
    lower.includes("rate limit") ||
    lower.includes("429")
  ) {
    return {
      code: "SDK_RATE_LIMIT",
      category: "sdk_network",
      severity: "P0",
      title: "SDK 全局限流",
      status: "cooldown",
      current_action: "暂停自动 wake / 新 session / ReportGate 自动写",
    };
  }

  if (
    lower.includes("sqlite_constraint") ||
    lower.includes("unique constraint") ||
    lower.includes("database is locked")
  ) {
    return {
      code: "SQLITE_CONSTRAINT",
      category: "concurrency_lock",
      severity: "P0",
      title: "并发写入冲突",
      status: "active",
    };
  }

  if (
    ctx.event_type === "codeflowmu.report_gate.waiting_report" ||
    lower.includes("waiting_report") ||
    lower.includes("waiting report")
  ) {
    return {
      code: "REPORT_GATE_WAIT",
      category: "report_gate",
      severity: "P3",
      title: "ReportGate 等待中",
      status: "waiting",
    };
  }

  if (
    ctx.event_type === "codeflowmu.report_gate.missing_report" ||
    lower.includes("missing report")
  ) {
    return {
      code: "REPORT_MISSING",
      category: "report_gate",
      severity: "P2",
      title: "Report 缺失",
      status: "waiting",
    };
  }

  if (lower.includes("root_review_blocked")) {
    const childSettled =
      ctx.payload?.child_tasks_settled === true ||
      String(ctx.payload?.reason ?? "").includes("waiting_pm_to_admin");
    return {
      code: childSettled ? "ADMIN_PENDING_REVIEW" : "LIFECYCLE_BLOCKED",
      category: "lifecycle",
      severity: childSettled ? "P2" : "P1",
      title: childSettled ? "待 ADMIN 验收" : "生命周期阻塞",
      status: "active",
    };
  }

  if (lower.includes("lifecycle")) {
    return {
      code: "LIFECYCLE_BLOCKED",
      category: "lifecycle",
      severity: "P1",
      title: "生命周期阻塞",
      status: "active",
    };
  }

  if (lower.includes("role_boundary") || (lower.includes("eval") && lower.includes("dispatch"))) {
    return {
      code: "ROLE_BOUNDARY",
      category: "role_boundary",
      severity: "P0",
      title: "角色边界违规",
      status: "active",
    };
  }

  if (lower.includes("agents.json") || lower.includes("persist") || lower.includes("write failed")) {
    return {
      code: "PERSISTENCE_ERROR",
      category: "persistence",
      severity: "P0",
      title: "持久化失败",
      status: "active",
    };
  }

  if (ctx.event_type === "codeflowmu.sdk.cooldown") {
    return {
      code: "SDK_RATE_LIMIT",
      category: "sdk_network",
      severity: "P0",
      title: "SDK 冷却中",
      status: "cooldown",
    };
  }

  if (
    lower.includes("authority_denied") ||
    lower.includes("权限拒绝")
  ) {
    return classifyGoogleGovernanceCode("AUTHORITY_DENIED");
  }

  if (lower.includes("model_not_found")) {
    return classifyGoogleGovernanceCode("MODEL_NOT_FOUND");
  }

  if (
    lower.includes("function_response_misaligned") ||
    lower.includes("functionresponse alignment")
  ) {
    return classifyGoogleGovernanceCode("FUNCTION_RESPONSE_MISALIGNED");
  }

  return null;
}

function classifyGoogleGovernanceCode(
  code: string,
): Pick<
  IngestRuntimeAlertInput,
  "code" | "category" | "severity" | "title" | "status"
> | null {
  switch (code.trim().toUpperCase()) {
    case "AUTHORITY_DENIED":
      return {
        code: "AUTHORITY_DENIED",
        category: "role_boundary",
        severity: "P1",
        title: "Google 工具权限拒绝",
        status: "active",
      };
    case "MODEL_NOT_FOUND":
      return {
        code: "MODEL_NOT_FOUND",
        category: "sdk_network",
        severity: "P0",
        title: "Gemini 模型不可用",
        status: "active",
      };
    case "FUNCTION_RESPONSE_MISALIGNED":
      return {
        code: "FUNCTION_RESPONSE_MISALIGNED",
        category: "shell_tool",
        severity: "P0",
        title: "Gemini FunctionResponse 错位",
        status: "active",
      };
    default:
      return null;
  }
}

export class RuntimeAlertManager {
  static readonly WAKE_STORM_WINDOW_MS = 60_000;

  private alerts = new Map<string, RuntimeAlert>();
  private p0ToastSeen = new Map<string, number>();
  private cooldownState = { active: false, until_ms: 0, reason: "" };
  private wakeStormWindowStart = 0;
  private wakeStormCount = 0;

  setSdkCooldown(untilMs: number, reason: string): void {
    this.cooldownState = {
      active: untilMs > nowMs(),
      until_ms: untilMs,
      reason,
    };
    this.ingest({
      code: "SDK_RATE_LIMIT",
      category: "sdk_network",
      severity: "P0",
      title: "SDK 全局限流",
      message: reason || "SDK cooldown active",
      cooldown_until: untilMs,
      current_action: "暂停自动 wake / 新 session / ReportGate 自动写",
      status: "cooldown",
    });
  }

  clearSdkCooldown(): void {
    this.cooldownState = { active: false, until_ms: 0, reason: "" };
    const key = buildAlertKey({
      severity: "P0",
      category: "sdk_network",
      code: "SDK_RATE_LIMIT",
    });
    const existing = this.alerts.get(key);
    if (existing) {
      existing.status = "resolved";
      existing.last_seen = nowMs();
    }
  }

  ingest(input: IngestRuntimeAlertInput): RuntimeAlert {
    const severity = input.severity ?? "P1";
    const category = input.category ?? "shell_tool";
    const alert_key = buildAlertKey({
      severity,
      category,
      code: input.code,
      affected_agent: input.affected_agent,
      affected_task: input.affected_task,
    });
    const ts = nowMs();
    const prev = this.alerts.get(alert_key);
    if (prev) {
      prev.count += 1;
      prev.last_seen = ts;
      prev.message = input.message;
      if (input.cooldown_until != null) prev.cooldown_until = input.cooldown_until;
      if (input.next_retry_at != null) prev.next_retry_at = input.next_retry_at;
      if (input.current_action) prev.current_action = input.current_action;
      if (input.status) prev.status = input.status;
      return prev;
    }
    const row: RuntimeAlert = {
      alert_key,
      severity,
      category,
      code: input.code,
      title: input.title ?? input.code,
      message: input.message,
      affected_agent: input.affected_agent,
      affected_task: input.affected_task,
      affected_report: input.affected_report,
      count: 1,
      first_seen: ts,
      last_seen: ts,
      next_retry_at: input.next_retry_at,
      cooldown_until: input.cooldown_until,
      current_action: input.current_action,
      status: input.status ?? "active",
    };
    this.alerts.set(alert_key, row);
    this.trim();
    return row;
  }

  ingestFromEvent(ev: IngestFromEventInput): RuntimeAlert | null {
    if (ev.transient_sdk_error === true) return null;
    const msg = String(
      ev.message ?? ev.description ?? ev.error ?? "",
    ).trim();
    if (!msg && !ev.failure_type) return null;

    const ft = (ev.failure_type ?? "").toLowerCase();
    if (this.isWakeThrottled(ev, msg, ft)) {
      return this.handleWakeThrottled(ev, msg);
    }

    const payloadSdkCode = String(ev.payload?.sdk_error_code ?? "").trim();
    const fromPayloadCode = classifyGoogleGovernanceCode(payloadSdkCode);
    if (fromPayloadCode) {
      return this.ingest({
        ...fromPayloadCode,
        message: msg || fromPayloadCode.title || fromPayloadCode.code,
        affected_agent: ev.agent_id,
        affected_task: ev.task_id,
      });
    }

    const classified = classifyFromText(msg, {
      failure_type: ev.failure_type,
      event_type: ev.event_type,
    });
    if (!classified) {
      const sevRaw = String(ev.severity ?? "").toUpperCase();
      const severity: AlertSeverity =
        sevRaw === "ERROR" ? "P1" : sevRaw === "WARN" ? "P2" : "P1";
      return this.ingest({
        code: ev.failure_type ?? "RUNTIME_FAILURE",
        category: "shell_tool",
        severity,
        title: "运行时故障",
        message: msg || ev.failure_type || "unknown",
        affected_agent: ev.agent_id,
        affected_task: ev.task_id,
        status: "active",
      });
    }

    return this.ingest({
      ...classified,
      message: msg || (classified.title ?? classified.code),
      affected_agent: ev.agent_id,
      affected_task: ev.task_id,
      current_action: classified.current_action,
      cooldown_until:
        classified.status === "cooldown" ? this.cooldownState.until_ms : undefined,
    });
  }

  /** Acknowledge one active alert without deleting its durable runtime event. */
  resolve(alertKey: string): boolean {
    const alert = this.alerts.get(String(alertKey ?? ""));
    if (!alert || alert.status === "resolved") return false;
    alert.status = "resolved";
    alert.last_seen = nowMs();
    return true;
  }

  /** Acknowledge every active alert; durable JSONL audit records are untouched. */
  resolveAll(): number {
    let resolved = 0;
    for (const alert of this.alerts.values()) {
      if (alert.status === "resolved") continue;
      alert.status = "resolved";
      alert.last_seen = nowMs();
      resolved += 1;
    }
    return resolved;
  }

  /** Whether Panel should show a one-shot P0 toast for this alert_key. */
  shouldShowP0Toast(alert: RuntimeAlert): boolean {
    if (alert.severity !== "P0") return false;
    if (NO_TOAST_CODES.has(alert.code)) return false;
    const last = this.p0ToastSeen.get(alert.alert_key) ?? 0;
    if (nowMs() - last < P0_TOAST_TTL_MS) return false;
    this.p0ToastSeen.set(alert.alert_key, nowMs());
    return true;
  }

  getSnapshot(opts?: { groupByCategory?: boolean }): RuntimeAlertsSnapshot {
    const active = [...this.alerts.values()]
      .filter((a) => a.status !== "resolved")
      .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.last_seen - a.last_seen);

    const grouped_by_category: Record<string, RuntimeAlert[]> = {};
    if (opts?.groupByCategory !== false) {
      for (const a of active) {
        const bucket =
          grouped_by_category[a.category] ?? (grouped_by_category[a.category] = []);
        bucket.push(a);
      }
    }

    const banner =
      active.find((a) => a.severity === "P0") ??
      active.find((a) => a.severity === "P1") ??
      null;

    if (this.cooldownState.until_ms > 0 && this.cooldownState.until_ms <= nowMs()) {
      this.clearSdkCooldown();
    }

    return {
      generated_at: nowMs(),
      overall_status: overallFromAlerts(active),
      active,
      grouped_by_category,
      cooldown: { ...this.cooldownState },
      banner,
    };
  }

  resetForTests(): void {
    this.alerts.clear();
    this.p0ToastSeen.clear();
    this.cooldownState = { active: false, until_ms: 0, reason: "" };
    this.wakeStormWindowStart = 0;
    this.wakeStormCount = 0;
  }

  private isWakeThrottled(
    ev: IngestFromEventInput,
    msg: string,
    ft: string,
  ): boolean {
    const lower = msg.toLowerCase();
    if (ev.event_type === "wake_agent.skipped") return true;
    if (ft === "wake_throttled" || ft === "pm.wake.skipped") return true;
    return (
      ft.includes("wake") &&
      (lower.includes("throttl") || lower.includes("skipped"))
    );
  }

  private handleWakeThrottled(
    ev: IngestFromEventInput,
    msg: string,
  ): RuntimeAlert {
    const ts = nowMs();
    if (
      this.wakeStormWindowStart === 0 ||
      ts - this.wakeStormWindowStart > RuntimeAlertManager.WAKE_STORM_WINDOW_MS
    ) {
      this.wakeStormWindowStart = ts;
      this.wakeStormCount = 1;
      return this.ingest({
        code: "WAKE_THROTTLED",
        category: "wake_dispatch",
        severity: "P2",
        title: "Wake 已节流",
        message: msg || "wake throttled",
        affected_agent: ev.agent_id,
        affected_task: ev.task_id,
        status: "waiting",
      });
    }

    this.wakeStormCount += 1;
    return this.ingest({
      code: "WAKE_THROTTLED_STORM",
      category: "wake_dispatch",
      severity: "P2",
      title: "Wake 节流风暴",
      message: `Wake 节流聚合 (${this.wakeStormCount} 次/分钟窗口)`,
      affected_agent: ev.agent_id,
      affected_task: ev.task_id,
      status: "waiting",
    });
  }

  private trim(): void {
    if (this.alerts.size <= MAX_ALERTS) return;
    const sorted = [...this.alerts.entries()].sort((a, b) => a[1].last_seen - b[1].last_seen);
    const drop = sorted.length - MAX_ALERTS;
    for (let i = 0; i < drop; i++) {
      const key = sorted[i]?.[0];
      if (key) this.alerts.delete(key);
    }
  }
}

export const runtimeAlertManager = new RuntimeAlertManager();
