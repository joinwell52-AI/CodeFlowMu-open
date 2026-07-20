export type RawEventType =
  | "thinking"
  | "tool_call"
  | "file_read"
  | "file_search"
  | "file_write"
  | "shell"
  | "test"
  | "report"
  | "task_move"
  | "wait"
  | "warning"
  | "error";

export type RawEventStatus = "start" | "running" | "done" | "failed";

export type RawEvent = {
  id: string;
  taskId: string;
  agent: string;
  type: RawEventType;
  tool?: string;
  target?: string;
  text?: string;
  status?: RawEventStatus;
  at: string;
};

/** Semantic activity channel — distinct from MobileEventKind UI bucket. */
export type MobileActivityEventType =
  | "chat_message"
  | "task_created"
  | "task_dispatched"
  | "agent_running"
  | "report_written"
  | "system_event";

/** Pseudo task ids used for direct chat sessions — must never appear on the dynamic feed. */
export function isChatActivityTaskId(taskId: string): boolean {
  return /^CHAT-/i.test(String(taskId ?? "").trim());
}

export type MobileEventKind =
  | "TASK_RECEIVED"
  | "ANALYZING"
  | "IMPLEMENTING"
  | "TESTING"
  | "REPORTING"
  | "WAITING"
  | "COMPLETED"
  | "WARNING";

export type MobileEventStatus = "running" | "done" | "warning" | "error";

export type MobileEventDetail = {
  tools?: string[];
  files?: string[];
  rawTypes?: string[];
  lastRawEventId?: string;
  reason?: string;
  /** Whitelist-extracted short phrase from thinking / workflow signals. */
  summaryText?: string;
  /** Sanitized short test/shell command (no absolute paths). */
  command?: string;
  /** REPORT-* filename when present on report / task_move events. */
  reportId?: string;
};

export type MobileEvent = {
  id: string;
  taskId: string;
  agent: string;
  /** Explicit semantic type for clients; never infer PM workflow from kind alone. */
  eventType: MobileActivityEventType;
  kind: MobileEventKind;
  summary: string;
  status: MobileEventStatus;
  startAt: string;
  endAt?: string;
  count: number;
  durationMs?: number;
  detail?: MobileEventDetail;
};
