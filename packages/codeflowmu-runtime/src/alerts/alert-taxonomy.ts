/**
 * Runtime Alert Center taxonomy (CodeFlowMu design 2026-06-05).
 * Distinct from FCoP GAL (`fcop/alerts/`).
 */

export type AlertSeverity = "P0" | "P1" | "P2" | "P3";

export type AlertCategory =
  | "sdk_network"
  | "concurrency_lock"
  | "lifecycle"
  | "report_gate"
  | "wake_dispatch"
  | "persistence"
  | "panel_perf"
  | "role_boundary"
  | "shell_tool";

export type AlertStatus = "active" | "cooldown" | "waiting" | "resolved";

export type RuntimeAlert = {
  alert_key: string;
  severity: AlertSeverity;
  category: AlertCategory;
  code: string;
  title: string;
  message: string;
  affected_agent?: string;
  affected_task?: string;
  affected_report?: string;
  count: number;
  first_seen: number;
  last_seen: number;
  next_retry_at?: number;
  cooldown_until?: number;
  current_action?: string;
  status: AlertStatus;
};

export type RuntimeAlertsSnapshot = {
  generated_at: number;
  overall_status: "ok" | "degraded" | "critical";
  active: RuntimeAlert[];
  grouped_by_category: Record<string, RuntimeAlert[]>;
  cooldown: {
    active: boolean;
    until_ms: number;
    reason: string;
  };
  banner: RuntimeAlert | null;
};

/** P2/P3: aggregate only, no toast (design §4). */
export const NO_TOAST_CODES = new Set([
  "WAKE_THROTTLED",
  "WAKE_THROTTLED_STORM",
  "REPORT_MISSING",
  "REPORT_GATE_WAIT",
  "PANEL_PERF_SLOW",
  "PM_QUEUE_STALE_RELEASED",
]);

export const CATEGORY_LABELS: Record<AlertCategory, string> = {
  sdk_network: "SDK / 网络",
  concurrency_lock: "并发 / 锁",
  lifecycle: "生命周期",
  report_gate: "Report Gate",
  wake_dispatch: "Wake / 派发",
  persistence: "持久化",
  panel_perf: "Panel 性能",
  role_boundary: "角色边界",
  shell_tool: "Shell / 工具",
};
