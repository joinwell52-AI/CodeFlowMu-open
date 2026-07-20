/**
 * Cursor Agent SDK error extraction + failure_category classification.
 * Used by SdkRunHandle, SessionManager, and web-panel doorbell/logging.
 */

export type SdkFailureCategory =
  | "cursor_sdk_first_turn_abort"
  | "cursor_sdk_error_no_detail"
  | "policy_blocked"
  | "transient_network"
  | "rate_limited"
  | "unknown_sdk_error";

export interface SdkFailureDetail {
  failure_category: SdkFailureCategory;
  sdk_error_message?: string;
  sdk_error_code?: string;
  sdk_error_name?: string;
  sdk_error_type?: string;
  sdk_error_stack_digest?: string;
  provider_status?: string | number;
  provider_code?: string;
  cursor_status?: string;
  cursor_request_id?: string;
  is_first_turn_abort?: boolean;
  sdk_no_detail?: boolean;
  sdk_no_detail_note?: string;
  raw_keys?: string[];
  raw_error_summary?: string;
  suggested_actions?: string[];
}

const RATE_LIMIT_PATTERNS = [
  "429",
  "quota",
  "rate limit",
  "rate limited",
  "too many requests",
  "nghttp2_enhance_your_calm",
  "enhance_your_calm",
] as const;

const TRANSIENT_NETWORK_PATTERNS = [
  "tls",
  "socket",
  "fetch failed",
  "econnreset",
  "econnrefused",
  "etimedout",
  "socket hang up",
  "socket disconnected",
  "network error",
  "stream closed",
] as const;

const DETAIL_MESSAGE_KEYS = [
  "message",
  "errorMessage",
  "error_message",
  "detail",
  "description",
] as const;

const DETAIL_CODE_KEYS = [
  "errorCode",
  "error_code",
  "code",
  "providerCode",
  "provider_code",
] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function collectObjects(root: unknown, maxDepth = 4): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number) => {
    if (depth > maxDepth || node == null || seen.has(node)) return;
    seen.add(node);
    if (isPlainObject(node)) {
      out.push(node);
      for (const value of Object.values(node)) {
        if (isPlainObject(value) || value instanceof Error) walk(value, depth + 1);
      }
    } else if (node instanceof Error) {
      out.push({
        name: node.name,
        message: node.message,
        ...(node.stack ? { stack: node.stack } : {}),
      });
      if (node.cause) walk(node.cause, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

function firstString(
  objects: Record<string, unknown>[],
  keys: readonly string[],
): string | undefined {
  for (const obj of objects) {
    for (const key of keys) {
      const v = obj[key];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number" && Number.isFinite(v)) return String(v);
    }
  }
  return undefined;
}

function stackDigest(stack: string | undefined): string | undefined {
  if (!stack?.trim()) return undefined;
  const line = stack.split("\n").find((l) => l.trim().length > 0)?.trim();
  if (!line) return undefined;
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

function rawErrorSummary(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "string") return raw.slice(0, 200);
  try {
    const s = JSON.stringify(raw);
    return s.length > 240 ? `${s.slice(0, 237)}…` : s;
  } catch {
    return String(raw).slice(0, 200);
  }
}

function searchText(raw: unknown, extraMessage?: string): string {
  const parts: string[] = [];
  if (extraMessage?.trim()) parts.push(extraMessage.trim());
  for (const obj of collectObjects(raw)) {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && v.trim()) parts.push(v);
      else if (
        typeof v === "number" &&
        ["code", "status", "provider_status", "providerStatus"].includes(k)
      ) {
        parts.push(String(v));
      }
    }
  }
  return parts.join(" ").toLowerCase();
}

/** True when SDK result exposes only `{ status: "error" }` without message/errorCode. */
export function isSdkResultNoDetail(raw: unknown): boolean {
  if (!isPlainObject(raw)) return false;
  const status = String(raw.status ?? "").toLowerCase();
  if (status !== "error" && status !== "failed") return false;

  const objects = collectObjects(raw);
  const hasMessage = Boolean(firstString(objects, DETAIL_MESSAGE_KEYS));
  const hasCode = Boolean(firstString(objects, DETAIL_CODE_KEYS));
  const errField = raw.error;
  const hasErrorField =
    (typeof errField === "string" && errField.trim().length > 0) ||
    (isPlainObject(errField) &&
      Boolean(
        firstString([errField], DETAIL_MESSAGE_KEYS) ||
          firstString([errField], DETAIL_CODE_KEYS),
      ));

  return !hasMessage && !hasCode && !hasErrorField;
}

export function extractSdkErrorDetails(raw: unknown): Omit<
  SdkFailureDetail,
  "failure_category" | "is_first_turn_abort" | "suggested_actions"
> {
  const objects = collectObjects(raw);
  const topKeys = isPlainObject(raw) ? Object.keys(raw) : [];

  const sdk_error_message =
    firstString(objects, DETAIL_MESSAGE_KEYS) ??
    (typeof (raw as Record<string, unknown>)?.error === "string"
      ? String((raw as Record<string, unknown>).error).trim()
      : undefined);

  const sdk_error_code = firstString(objects, DETAIL_CODE_KEYS);
  const sdk_error_name = firstString(objects, ["name", "error_name", "errorName"]);
  const sdk_error_type = firstString(objects, ["type", "error_type", "errorType"]);

  const stackRaw = firstString(objects, ["stack", "stackTrace", "stack_trace"]);
  const sdk_error_stack_digest = stackDigest(stackRaw);

  const provider_status =
    firstString(objects, ["provider_status", "providerStatus", "httpStatus"]) ??
    (() => {
      for (const obj of objects) {
        const v = obj.provider_status ?? obj.providerStatus ?? obj.httpStatus;
        if (typeof v === "number" && Number.isFinite(v)) return v;
      }
      return undefined;
    })();

  const provider_code = firstString(objects, [
    "provider_code",
    "providerCode",
    "providerError",
  ]);

  const cursor_status = firstString(objects, [
    "cursor_status",
    "cursorStatus",
    "cursorError",
    "cursor_error",
  ]);
  const cursor_request_id = firstString(objects, [
    "cursor_request_id",
    "cursorRequestId",
    "request_id",
    "requestId",
  ]);

  const sdk_no_detail = isSdkResultNoDetail(raw);
  const raw_keys = topKeys.length > 0 ? topKeys : undefined;
  const raw_error_summary = rawErrorSummary(raw);

  return {
    ...(sdk_error_message ? { sdk_error_message } : {}),
    ...(sdk_error_code ? { sdk_error_code } : {}),
    ...(sdk_error_name ? { sdk_error_name } : {}),
    ...(sdk_error_type ? { sdk_error_type } : {}),
    ...(sdk_error_stack_digest ? { sdk_error_stack_digest } : {}),
    ...(provider_status != null && provider_status !== ""
      ? { provider_status }
      : {}),
    ...(provider_code ? { provider_code } : {}),
    ...(cursor_status ? { cursor_status } : {}),
    ...(cursor_request_id ? { cursor_request_id } : {}),
    ...(sdk_no_detail
      ? {
          sdk_no_detail: true,
          sdk_no_detail_note: "no detailed error exposed by SDK",
        }
      : {}),
    ...(raw_keys ? { raw_keys } : {}),
    ...(raw_error_summary ? { raw_error_summary } : {}),
  };
}

export interface ClassifySdkFailureInput {
  status?: string;
  tool_call_count?: number;
  duration_ms?: number;
  raw?: unknown;
  error_message?: string;
}

export function classifySdkFailureCategory(
  input: ClassifySdkFailureInput,
): SdkFailureCategory {
  const status = String(input.status ?? "").toLowerCase();
  const isError = status === "error" || status === "failed";
  const text = searchText(input.raw, input.error_message);

  if (text.includes("codeflowmu_policy_blocked")) {
    return "policy_blocked";
  }
  if (RATE_LIMIT_PATTERNS.some((p) => text.includes(p))) {
    return "rate_limited";
  }
  if (TRANSIENT_NETWORK_PATTERNS.some((p) => text.includes(p))) {
    return "transient_network";
  }

  const toolCalls = input.tool_call_count ?? 0;
  const duration = input.duration_ms ?? 0;
  if (
    isError &&
    toolCalls === 0 &&
    duration > 0 &&
    (duration < 15000 || isSdkResultNoDetail(input.raw))
  ) {
    return "cursor_sdk_first_turn_abort";
  }
  if (isSdkResultNoDetail(input.raw)) {
    return "cursor_sdk_error_no_detail";
  }
  if (isError) {
    return "unknown_sdk_error";
  }
  return "unknown_sdk_error";
}

export function suggestedActionsForCategory(
  category: SdkFailureCategory,
): string[] {
  const common = [
    "查看 Cursor Agent Output",
    "查看 MCP 日志",
  ];
  switch (category) {
    case "cursor_sdk_first_turn_abort":
      return [
        ...common,
        "降低 wake 频率",
        "等待后重试",
      ];
    case "cursor_sdk_error_no_detail":
      return [
        ...common,
        "等待后重试",
      ];
    case "policy_blocked":
      return [
        "检查角色边界策略",
        "使用 FCoP task/report 工具或本机治理 API",
      ];
    case "transient_network":
      return [
        ...common,
        "等待后重试",
        "检查网络 / VPN",
      ];
    case "rate_limited":
      return [
        ...common,
        "降低 wake 频率",
        "等待配额恢复后重试",
      ];
    case "unknown_sdk_error":
    default:
      return [...common, "等待后重试"];
  }
}

export interface BuildSdkFailurePayloadContext {
  agent_id?: string;
  role?: string;
  session_id?: string;
  task_id?: string;
  chat_id?: string;
  tool_call_count?: number;
  duration_ms?: number;
  status?: string;
  raw?: unknown;
  error_message?: string;
}

/** Flat payload fields for runtime/usage jsonl + doorbell. */
export function buildSdkFailurePayloadFields(
  ctx: BuildSdkFailurePayloadContext,
): Record<string, unknown> {
  const extracted = extractSdkErrorDetails(ctx.raw);
  const category = classifySdkFailureCategory({
    status: ctx.status,
    tool_call_count: ctx.tool_call_count,
    duration_ms: ctx.duration_ms,
    raw: ctx.raw,
    error_message: ctx.error_message ?? extracted.sdk_error_message,
  });
  const is_first_turn_abort = category === "cursor_sdk_first_turn_abort";
  const suggested_actions = suggestedActionsForCategory(category);

  return {
    failure_category: category,
    ...extracted,
    ...(ctx.tool_call_count != null ? { tool_call_count: ctx.tool_call_count } : {}),
    ...(ctx.duration_ms != null ? { duration_ms: ctx.duration_ms } : {}),
    ...(ctx.agent_id ? { agent_id: ctx.agent_id } : {}),
    ...(ctx.role ? { role: ctx.role } : {}),
    ...(ctx.session_id ? { session_id: ctx.session_id } : {}),
    ...(ctx.task_id ? { task_id: ctx.task_id } : {}),
    ...(ctx.chat_id ? { chat_id: ctx.chat_id } : {}),
    is_first_turn_abort,
    suggested_actions,
  };
}

export type SdkFailurePayloadFields = ReturnType<typeof buildSdkFailurePayloadFields>;

/** Payload keys written to runtime/usage jsonl and doorbell failure events. */
export const SDK_FAILURE_PAYLOAD_KEYS = [
  "failure_category",
  "sdk_error_message",
  "sdk_error_code",
  "sdk_error_name",
  "sdk_error_type",
  "sdk_error_stack_digest",
  "provider_status",
  "provider_code",
  "cursor_status",
  "cursor_request_id",
  "is_first_turn_abort",
  "suggested_actions",
  "sdk_no_detail",
  "sdk_no_detail_note",
  "raw_keys",
  "raw_error_summary",
  "tool_call_count",
  "duration_ms",
  "agent_id",
  "role",
  "session_id",
  "task_id",
  "chat_id",
] as const;

export function pickSdkFailureFieldsFromPayload(
  pl: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of SDK_FAILURE_PAYLOAD_KEYS) {
    const v = pl[k];
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}

export interface RebuildSdkFailureForSessionEndInput {
  runDetail?: SdkFailurePayloadFields | Record<string, unknown>;
  duration_ms: number;
  tool_call_count: number;
  agent_id?: string;
  role?: string;
  session_id?: string;
  task_id?: string;
  error_message?: string;
  status?: string;
}

/** Re-classify SDK failure at session end (session duration drives first-turn abort). */
export function rebuildSdkFailureForSessionEnd(
  input: RebuildSdkFailureForSessionEndInput,
): Record<string, unknown> {
  const taskId = String(input.task_id ?? "");
  const runDetail = input.runDetail as Record<string, unknown> | undefined;
  const errMsg =
    input.error_message ??
    (typeof runDetail?.sdk_error_message === "string"
      ? runDetail.sdk_error_message
      : undefined);

  let raw: unknown = { status: "error" };
  if (runDetail?.sdk_no_detail === true) {
    raw = { status: "error" };
  } else if (errMsg || runDetail?.sdk_error_code) {
    raw = {
      status: "error",
      ...(errMsg ? { message: errMsg, error: errMsg } : {}),
      ...(runDetail?.sdk_error_code
        ? { errorCode: runDetail.sdk_error_code, code: runDetail.sdk_error_code }
        : {}),
      ...(runDetail?.provider_code ? { provider_code: runDetail.provider_code } : {}),
      ...(runDetail?.cursor_status ? { cursor_status: runDetail.cursor_status } : {}),
      ...(runDetail?.cursor_request_id
        ? { cursor_request_id: runDetail.cursor_request_id }
        : {}),
    };
  }

  return buildSdkFailurePayloadFields({
    status: input.status ?? "error",
    tool_call_count: input.tool_call_count,
    duration_ms: input.duration_ms,
    raw,
    error_message: errMsg,
    agent_id: input.agent_id,
    role: input.role,
    session_id: input.session_id,
    task_id: taskId || undefined,
    chat_id: taskId.startsWith("CHAT-") ? taskId : undefined,
  });
}

/** SessionRun extension stored locally (not in @codeflowmu/protocol schema). */
export type SessionRunWithSdkFailure = {
  sdk_failure_detail?: SdkFailurePayloadFields;
  sdk_error?: string;
};
