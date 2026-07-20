/**
 * EventDisplayDedupe — Log Center / Alert display-layer dedupe.
 *
 * Key: timestamp bucket + actor + event_type + message hash.
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
  actor?: string | null;
  eventType: string;
  message?: string | null;
  bucketMs?: number;
}): string {
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
    actor?: string | null;
    event_type: string;
    message?: string | null;
  }): boolean {
    this.#prune();
    const key = buildDisplayDedupeKey({
      ts: parts.ts,
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
