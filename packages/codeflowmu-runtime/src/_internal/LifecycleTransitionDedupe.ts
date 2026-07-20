/**
 * LifecycleTransitionDedupe — suppress duplicate lifecycle SSE / log emissions
 * for the same task transition within a TTL window.
 */

export interface LifecycleTransitionDedupeOpts {
  /** Default 120_000 ms. */
  ttlMs?: number;
  now?: () => number;
}

export function buildLifecycleTransitionKey(parts: {
  taskId: string;
  eventType: string;
  fromStage?: string;
  toStage?: string;
}): string {
  return [
    parts.taskId.trim(),
    parts.eventType.trim(),
    parts.fromStage ?? "",
    parts.toStage ?? "",
  ].join(":");
}

export class LifecycleTransitionDedupe {
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #seen = new Map<string, number>();

  constructor(opts?: LifecycleTransitionDedupeOpts) {
    this.#ttlMs = opts?.ttlMs ?? 120_000;
    this.#now = opts?.now ?? (() => Date.now());
  }

  /** Returns true if this transition should be emitted (first in TTL window). */
  shouldEmit(key: string): boolean {
    this.#prune();
    const k = key.trim();
    if (!k) return true;
    if (this.#seen.has(k)) return false;
    this.#seen.set(k, this.#now());
    return true;
  }

  forget(key: string): void {
    this.#seen.delete(key.trim());
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

export const lifecycleTransitionDedupe = new LifecycleTransitionDedupe();
