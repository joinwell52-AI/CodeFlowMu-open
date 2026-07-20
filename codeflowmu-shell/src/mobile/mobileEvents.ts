/** Map internal SSE event types to mobile-safe event names. */

const MOBILE_BLOCKED_EVENT_PREFIXES = [
  "codeflowmu.agents_snapshot",
  "sdk.",
  "codeflowmu.chat_delta",
  "codeflowmu.tool_",
  "codeflowmu.thinking",
] as const;

const MOBILE_EVENT_MAP: Record<string, string> = {
  "codeflowmu.task_dispatched": "task_changed",
  "codeflowmu.task_created": "task_changed",
  "codeflowmu.task_updated": "task_changed",
  "codeflowmu.report_created": "report_ready",
  "codeflowmu.issue_created": "issue_created",
  "codeflowmu.approval_acked": "approval_pending",
  "codeflowmu.review_approved": "approval_pending",
  "codeflowmu.review_rejected": "approval_pending",
  "codeflowmu.doorbell": "alert_created",
  "codeflowmu.alert": "alert_created",
  "codeflowmu.chat_message": "chat_message",
  "codeflowmu.heartbeat": "pc_offline",
  "codeflowmu.failure": "alert_created",
};

export function isMobileBlockedSseType(type: string): boolean {
  if (!type) return true;
  return MOBILE_BLOCKED_EVENT_PREFIXES.some(
    (prefix) => type === prefix || type.startsWith(prefix),
  );
}

export function mapSseTypeForMobile(type: string): string | null {
  if (isMobileBlockedSseType(type)) return null;
  if (MOBILE_EVENT_MAP[type]) return MOBILE_EVENT_MAP[type]!;
  if (type.startsWith("codeflowmu.task_")) return "task_changed";
  if (type.startsWith("codeflowmu.report_")) return "report_ready";
  if (type.startsWith("codeflowmu.issue_")) return "issue_created";
  if (type.includes("approval") || type.includes("review")) return "approval_pending";
  if (type.includes("doorbell") || type.includes("alert")) return "alert_created";
  if (type.includes("chat")) return "chat_message";
  return null;
}

export function formatMobileSseEvent(
  type: string,
  payload: Record<string, unknown>,
): { event: string; data: Record<string, unknown> } | null {
  const mapped = mapSseTypeForMobile(type);
  if (!mapped) return null;
  return { event: mapped, data: sanitizeMobileEventPayload(mapped, payload) };
}

export function sanitizeMobileEventPayload(
  mobileType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const safe: Record<string, unknown> = { type: mobileType };
  const allowKeys = [
    "filename",
    "task_id",
    "thread_key",
    "decision",
    "approved_at",
    "message",
    "agent_id",
    "severity",
    "summary",
    "title",
    "status",
  ];
  for (const key of allowKeys) {
    if (key in payload && payload[key] !== undefined) {
      safe[key] = payload[key];
    }
  }
  return safe;
}
