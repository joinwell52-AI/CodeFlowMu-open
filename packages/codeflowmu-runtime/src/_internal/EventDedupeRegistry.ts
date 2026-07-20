/**
 * EventDedupeRegistry — TTL dedupe for filesystem watcher events.
 *
 * event_key = `${type}|${filePath}|${mtimeMs}|${size}`
 */

export interface EventDedupeEntry {
  type: string;
  filePath: string;
  mtimeMs: number;
  size: number;
}

export interface EventDedupeRegistryOpts {
  /** Default 30_000 ms. */
  ttlMs?: number;
  now?: () => number;
}

export function buildEventKey(entry: EventDedupeEntry): string {
  return `${entry.type}|${entry.filePath}|${entry.mtimeMs}|${entry.size}`;
}

export class EventDedupeRegistry {
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #seen = new Map<string, number>();

  constructor(opts?: EventDedupeRegistryOpts) {
    this.#ttlMs = opts?.ttlMs ?? 30_000;
    this.#now = opts?.now ?? (() => Date.now());
  }

  /** Returns true if this event should be processed (first time in TTL window). */
  shouldProcess(entry: EventDedupeEntry): boolean {
    this.#prune();
    const key = buildEventKey(entry);
    if (this.#seen.has(key)) return false;
    this.#seen.set(key, this.#now());
    return true;
  }

  /** Drop a key so a retry can re-enter (e.g. handler failed). */
  forget(entry: EventDedupeEntry): void {
    this.#seen.delete(buildEventKey(entry));
  }

  /**
   * Merged filesystem watcher key — add/change/rename share one `type`
   * so the same file+stat is processed once per TTL window.
   */
  shouldProcessFileEvent(
    filePath: string,
    mtimeMs: number,
    size: number,
  ): boolean {
    return this.shouldProcess({
      type: "fs",
      filePath,
      mtimeMs,
      size,
    });
  }

  forgetFileEvent(filePath: string, mtimeMs: number, size: number): void {
    this.forget({ type: "fs", filePath, mtimeMs, size });
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

/** Process-wide dedupe for filesystem watcher events. */
export const eventDedupeRegistry = new EventDedupeRegistry();
