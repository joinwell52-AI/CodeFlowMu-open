import { sdkCooldownRegistry } from "./SdkCooldownRegistry.ts";

export interface ZeroToolcallCircuitBreakerOpts {
  now?: () => number;
  windowMs?: number;
  threshold?: number;
  cooldownMs?: number;
  onOpen?: (untilMs: number, reason: string) => void;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 5 * 60_000;

export class ZeroToolcallCircuitBreaker {
  readonly #now: () => number;
  readonly #windowMs: number;
  readonly #threshold: number;
  readonly #cooldownMs: number;
  readonly #onOpen: ((untilMs: number, reason: string) => void) | undefined;
  readonly #hits: number[] = [];

  constructor(opts?: ZeroToolcallCircuitBreakerOpts) {
    this.#now = opts?.now ?? (() => Date.now());
    this.#windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
    this.#threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
    this.#cooldownMs = opts?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.#onOpen = opts?.onOpen;
  }

  recordFailedZeroToolcall(): boolean {
    const now = this.#now();
    this.#hits.push(now);
    while (this.#hits.length && now - this.#hits[0]! > this.#windowMs) {
      this.#hits.shift();
    }
    if (this.#hits.length < this.#threshold) return false;
    const until = now + this.#cooldownMs;
    sdkCooldownRegistry.openCircuit("SDK_CIRCUIT_OPEN", this.#cooldownMs);
    this.#hits.length = 0;
    this.#onOpen?.(until, "SDK_CIRCUIT_OPEN");
    return true;
  }

  reset(): void {
    this.#hits.length = 0;
  }
}

export const zeroToolcallCircuitBreaker = new ZeroToolcallCircuitBreaker();
