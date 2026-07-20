/**
 * Simple in-memory throttle: at most one `shouldRun(key)` per interval.
 * Used to cap PM governance / status-check frequency per task or thread.
 */

export class CheckThrottle {
  private readonly _lastRun = new Map<string, number>();

  constructor(private readonly intervalMs: number = 45_000) {}

  /** Default 45s — within the 30–60s band requested for status checks. */
  static forStatusChecks(): CheckThrottle {
    return new CheckThrottle(45_000);
  }

  /** Default 45s — within the 30–60s band requested for wake / startSession. */
  static forWakes(): CheckThrottle {
    return new CheckThrottle(45_000);
  }

  /**
   * Returns true the first time (or after interval elapsed) for `key`.
   * Updates the last-run timestamp when returning true.
   */
  shouldRun(key: string): boolean {
    const now = Date.now();
    const last = this._lastRun.get(key);
    if (last != null && now - last < this.intervalMs) {
      return false;
    }
    this._lastRun.set(key, now);
    return true;
  }

  /** Milliseconds until `key` may run again; 0 if allowed now. */
  msUntilReady(key: string): number {
    const last = this._lastRun.get(key);
    if (last == null) return 0;
    const elapsed = Date.now() - last;
    return elapsed >= this.intervalMs ? 0 : this.intervalMs - elapsed;
  }
}
