/**
 * Schedule a single delayed PM downstream wake retry (cooldown / throttle / gate).
 */

import type { WakeDownstreamRequest } from "./PmGovernanceActions.ts";
import type { WakeDownstreamExecutor } from "./PmGovernancePlanner.ts";

const pendingKeys = new Set<string>();

function wakeRetryKey(req: WakeDownstreamRequest): string {
  const taskId = String(req.task_id ?? "").replace(/\.md$/i, "");
  const role = String(req.role ?? "").trim().toUpperCase();
  return `${taskId}:${role}`;
}

export function scheduleDelayedPmWakeRetry(opts: {
  remainingMs: number;
  reason: string;
  request: WakeDownstreamRequest;
  wake: WakeDownstreamExecutor;
  onScheduled?: (info: { key: string; remainingMs: number; reason: string }) => void;
}): boolean {
  const remainingMs = Math.max(0, Math.floor(opts.remainingMs));
  if (remainingMs <= 0) return false;

  const key = wakeRetryKey(opts.request);
  if (pendingKeys.has(key)) return false;
  pendingKeys.add(key);

  opts.onScheduled?.({ key, remainingMs, reason: opts.reason });

  setTimeout(() => {
    pendingKeys.delete(key);
    void opts.wake(opts.request).catch((err) => {
      console.warn(
        `[scheduleDelayedPmWakeRetry] retry failed for ${key}:`,
        err instanceof Error ? err.message : String(err),
      );
    });
  }, remainingMs);

  return true;
}

export function hasPendingDelayedWakeRetry(taskId: string, role: string): boolean {
  const key = `${String(taskId).replace(/\.md$/i, "")}:${String(role).trim().toUpperCase()}`;
  return pendingKeys.has(key);
}

/** Test-only — clear pending retry keys. */
export function resetDelayedPmWakeRetryForTests(): void {
  pendingKeys.clear();
}
