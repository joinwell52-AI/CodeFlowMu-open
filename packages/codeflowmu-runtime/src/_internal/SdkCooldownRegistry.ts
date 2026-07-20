/**
 * SdkCooldownRegistry — global SDK rate-limit / NGHTTP2 cooldown gate.
 *
 * When NGHTTP2_ENHANCE_YOUR_CALM (or similar) fires, runtime pauses auto
 * wake, ReportGate compensating writes, and new PM consolidation sessions.
 */

import { isEnhanceYourCalmError } from "./transient-sdk-error.ts";

export interface SdkCooldownRegistryOpts {
  /** Default 5 minutes. */
  cooldownMs?: number;
  now?: () => number;
  onCooldown?: (untilMs: number, reason: string) => void;
}

export class SdkCooldownRegistry {
  readonly #cooldownMs: number;
  readonly #now: () => number;
  #onCooldown: ((untilMs: number, reason: string) => void) | undefined;
  #untilMs = 0;
  #reason = "";

  constructor(opts?: SdkCooldownRegistryOpts) {
    this.#cooldownMs = opts?.cooldownMs ?? 5 * 60 * 1000;
    this.#now = opts?.now ?? (() => Date.now());
    this.#onCooldown = opts?.onCooldown;
  }

  /** Wire panel / runtime hooks after module init (Runtime.create). */
  setOnCooldown(handler: (untilMs: number, reason: string) => void): void {
    this.#onCooldown = handler;
  }

  get active(): boolean {
    return this.#now() < this.#untilMs;
  }

  get untilMs(): number {
    return this.#untilMs;
  }

  /** Milliseconds until cooldown expires; 0 when inactive. */
  remainingMs(now = Date.now()): number {
    if (!this.active) return 0;
    return Math.max(0, this.#untilMs - now);
  }

  get reason(): string {
    return this.#reason;
  }

  /** Enter cooldown from an error (NGHTTP2 only triggers full cooldown). */
  recordFromError(err: unknown): boolean {
    if (!isEnhanceYourCalmError(err)) return false;
    this.enter("NGHTTP2_ENHANCE_YOUR_CALM");
    return true;
  }

  /** Enter the SDK circuit breaker from runtime policy, not a provider error. */
  openCircuit(reason: string, durationMs?: number): void {
    this.enter(reason, durationMs);
  }

  enter(reason: string, durationMs?: number): void {
    const ms = durationMs ?? this.#cooldownMs;
    const until = this.#now() + ms;
    if (until > this.#untilMs) {
      this.#untilMs = until;
      this.#reason = reason;
      this.#onCooldown?.(until, reason);
    }
  }

  clear(): void {
    this.#untilMs = 0;
    this.#reason = "";
  }

  /** Throws if cooldown active — use before SDK / auto-write paths. */
  assertNotPaused(label: string): void {
    if (!this.active) return;
    const remainSec = Math.ceil((this.#untilMs - this.#now()) / 1000);
    throw new SdkCooldownActiveError(
      `${label}: SDK cooldown active (${this.#reason}, ~${remainSec}s remaining)`,
      this.#untilMs,
      this.#reason,
    );
  }
}

export class SdkCooldownActiveError extends Error {
  constructor(
    message: string,
    readonly untilMs: number,
    readonly cooldownReason: string,
  ) {
    super(message);
    this.name = "SdkCooldownActiveError";
  }
}

/** Shared runtime singleton — wired from Runtime.ts on boot. */
export const sdkCooldownRegistry = new SdkCooldownRegistry();
