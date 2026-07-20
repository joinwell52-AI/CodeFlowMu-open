/**
 * Transient Cursor SDK / HTTP2 error detection and bounded backoff retry.
 *
 * Typical signals: NGHTTP2_ENHANCE_YOUR_CALM, Stream closed, transient network.
 * These are non-fatal — callers should retry, then mark `delayed` rather than
 * treating the task chain as hard-failed.
 */

import { sdkCooldownRegistry } from "./SdkCooldownRegistry.ts";

export const TRANSIENT_SDK_BACKOFF_MS = [2000, 5000, 15000] as const;

export const TRANSIENT_SDK_DELAYED = "TRANSIENT_SDK_DELAYED" as const;

const TRANSIENT_PATTERNS = [
  "nghttp2_enhance_your_calm",
  "stream closed",
  "aborted",
  "rate limited",
  "rate limit",
  "too many requests",
  "timeout",
  "timed out",
  "econnrefused",
  "etimedout",
  "econnreset",
  "socket hang up",
  "socket disconnected",
  "network error",
  "fetch failed",
  "tls connection",
  "enhance_your_calm",
] as const;

function errorSearchText(err: unknown, seen = new Set<unknown>()): string {
  if (err == null || seen.has(err)) return "";
  seen.add(err);
  if (err instanceof Error) {
    const parts = [err.name, err.message];
    const record = err as Error & {
      code?: unknown;
      rawMessage?: unknown;
      cause?: unknown;
    };
    if (record.code != null) parts.push(String(record.code));
    if (record.rawMessage != null) parts.push(String(record.rawMessage));
    if (record.cause != null) parts.push(errorSearchText(record.cause, seen));
    return parts.join(" ");
  }
  if (typeof err === "object") {
    const record = err as Record<string, unknown>;
    const parts = Object.entries(record)
      .filter(([key]) => ["name", "message", "code", "rawMessage"].includes(key))
      .map(([, value]) => String(value));
    if ("cause" in record) parts.push(errorSearchText(record.cause, seen));
    return parts.join(" ");
  }
  return String(err);
}

/** Returns true when `err` looks like a recoverable SDK / transport glitch. */
export function isTransientSdkError(err: unknown): boolean {
  const lower = errorSearchText(err).toLowerCase();
  return TRANSIENT_PATTERNS.some((p) => lower.includes(p));
}

/** NGHTTP2 rate-limit — triggers global SDK cooldown (5 min default). */
export function isEnhanceYourCalmError(err: unknown): boolean {
  const lower = errorSearchText(err).toLowerCase();
  return (
    lower.includes("nghttp2_enhance_your_calm") ||
    lower.includes("enhance_your_calm")
  );
}

export class TransientSdkDelayedError extends Error {
  readonly code = TRANSIENT_SDK_DELAYED;

  constructor(message: string, readonly cause?: Error) {
    super(message);
    this.name = "TransientSdkDelayedError";
  }
}

export interface TransientSdkRetryOptions {
  /** Called before each backoff wait (1-based attempt index). */
  onRetry?: (attempt: number, delayMs: number, error: Error) => void;
  backoffMs?: readonly number[];
}

export type TransientSdkRetryResult<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; delayed: true; lastError: Error; attempts: number };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry `fn` on transient errors with 2s → 5s → 15s backoff.
 * Non-transient errors throw immediately. After retries are exhausted,
 * returns `{ ok: false, delayed: true }` instead of throwing.
 */
export async function withTransientSdkRetry<T>(
  fn: () => Promise<T>,
  opts?: TransientSdkRetryOptions,
): Promise<TransientSdkRetryResult<T>> {
  const backoff = opts?.backoffMs ?? TRANSIENT_SDK_BACKOFF_MS;
  let lastError = new Error("transient SDK retry: unknown error");

  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    try {
      const value = await fn();
      return { ok: true, value, attempts: attempt + 1 };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (!isTransientSdkError(lastError)) {
        throw lastError;
      }
      if (isEnhanceYourCalmError(lastError)) {
        sdkCooldownRegistry.recordFromError(lastError);
      }
      if (attempt >= backoff.length) {
        return {
          ok: false,
          delayed: true,
          lastError,
          attempts: attempt + 1,
        };
      }
      const delayMs = backoff[attempt]!;
      opts?.onRetry?.(attempt + 1, delayMs, lastError);
      await sleep(delayMs);
    }
  }

  return {
    ok: false,
    delayed: true,
    lastError,
    attempts: backoff.length + 1,
  };
}
