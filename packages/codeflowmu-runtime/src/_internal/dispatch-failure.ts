import { isTransientSdkError } from "./transient-sdk-error.ts";

export type DispatchFailureCategory =
  | "delivery_failed"
  | "transient_network"
  | "rate_limited"
  | "sdk_busy"
  | "model_unavailable"
  | "auth_failed"
  | "tool_timeout"
  | "tool_error"
  | "unknown_sdk_error";

export type DispatchProvider =
  | "cursor"
  | "google"
  | "claude"
  | "provider_api"
  | "codex"
  | "unknown";

export interface NormalizedDispatchFailure {
  provider: DispatchProvider;
  adapter: string;
  category: DispatchFailureCategory;
  retryable: boolean;
  message: string;
  rawCode?: string;
  rawMessage?: string;
}

export interface NormalizeDispatchFailureOptions {
  provider?: DispatchProvider;
  adapter?: string;
  category?: DispatchFailureCategory;
  retryable?: boolean;
  rawCode?: string;
}

function categoryFromMessage(message: string): DispatchFailureCategory {
  const lower = message.toLowerCase();
  if (lower.includes("429") || lower.includes("rate limit")) return "rate_limited";
  if (lower.includes("503") || lower.includes("timeout") || lower.includes("econnreset")) {
    return "transient_network";
  }
  if (lower.includes("auth") || lower.includes("401") || lower.includes("403")) {
    return "auth_failed";
  }
  if (lower.includes("model")) return "model_unavailable";
  return "delivery_failed";
}

/** P0 最小归一化；P2 将由 AdapterCapabilityProfile 接管。 */
export function normalizeDispatchFailure(
  err: Error,
  opts: NormalizeDispatchFailureOptions = {},
): NormalizedDispatchFailure {
  const message = err.message || String(err);
  const retryable = opts.retryable ?? isTransientSdkError(err);
  return {
    provider: opts.provider ?? "unknown",
    adapter: opts.adapter ?? "unknown",
    category: opts.category ?? categoryFromMessage(message),
    retryable,
    message,
    rawCode: opts.rawCode,
    rawMessage: message,
  };
}
