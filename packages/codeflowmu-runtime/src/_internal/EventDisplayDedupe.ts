/**
 * EventDisplayDedupe — Log Center / Alert display-layer dedupe.
 *
 * Semantic key priority:
 * 1. stable event_id;
 * 2. call_id + session_id + phase;
 * 3. timestamp bucket + actor + event_type + message hash (legacy fallback).
 */

export interface EventDisplayDedupeOpts {
  /** Default 1_000 ms bucket. */
  bucketMs?: number;
  /** Default 60_000 ms TTL for seen keys. */
  ttlMs?: number;
  now?: () => number;
}

function hashMessage(msg: string): string {
  let h = 0;
  const s = msg.slice(0, 200);
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return String(h >>> 0);
}

export function buildDisplayDedupeKey(parts: {
  ts: number;
  eventId?: string | null;
  callId?: string | null;
  sessionId?: string | null;
  phase?: string | null;
  actor?: string | null;
  eventType: string;
  message?: string | null;
  bucketMs?: number;
}): string {
  const eventId = String(parts.eventId ?? "").trim();
  if (eventId) return `event:${eventId}`;
  const callId = String(parts.callId ?? "").trim();
  const sessionId = String(parts.sessionId ?? "").trim();
  const phase = String(parts.phase ?? "").trim();
  if (callId && sessionId && phase) {
    return `call:${sessionId}|${callId}|${phase}`;
  }
  const bucket = Math.floor(parts.ts / (parts.bucketMs ?? 1_000));
  const actor = (parts.actor ?? "").trim();
  const eventType = parts.eventType.trim();
  const msgHash = hashMessage(String(parts.message ?? "").trim());
  return `${bucket}|${actor}|${eventType}|${msgHash}`;
}

export class EventDisplayDedupeRegistry {
  readonly #bucketMs: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #seen = new Map<string, number>();

  constructor(opts?: EventDisplayDedupeOpts) {
    this.#bucketMs = opts?.bucketMs ?? 1_000;
    this.#ttlMs = opts?.ttlMs ?? 60_000;
    this.#now = opts?.now ?? (() => Date.now());
  }

  /** Returns true if this row should be shown (first in TTL window). */
  shouldDisplay(parts: {
    ts: number;
    event_id?: string | null;
    call_id?: string | null;
    session_id?: string | null;
    phase?: string | null;
    actor?: string | null;
    event_type: string;
    message?: string | null;
  }): boolean {
    this.#prune();
    const key = buildDisplayDedupeKey({
      ts: parts.ts,
      eventId: parts.event_id,
      callId: parts.call_id,
      sessionId: parts.session_id,
      phase: parts.phase,
      actor: parts.actor,
      eventType: parts.event_type,
      message: parts.message,
      bucketMs: this.#bucketMs,
    });
    if (this.#seen.has(key)) return false;
    this.#seen.set(key, this.#now());
    return true;
  }

  clear(): void {
    this.#seen.clear();
  }

  #prune(): void {
    const cutoff = this.#now() - this.#ttlMs;
    for (const [key, at] of this.#seen) {
      if (at < cutoff) this.#seen.delete(key);
    }
  }
}

export const eventDisplayDedupeRegistry = new EventDisplayDedupeRegistry();
