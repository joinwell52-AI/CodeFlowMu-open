import { sdkCooldownRegistry } from "./SdkCooldownRegistry.ts";
import {
  normalizeDispatchFailure,
  type DispatchFailureCategory,
  type DispatchProvider,
  type NormalizeDispatchFailureOptions,
} from "./dispatch-failure.ts";

export const DEFAULT_BACKOFF_RANGES_MS = [
  [5_000, 15_000],
  [15_000, 30_000],
  [30_000, 50_000],
] as const;

export const DEFAULT_MAX_AUTO_FAILURES = 3;
export const DECISION_FAILURE_THRESHOLD = 4;

export type DispatchAdminDecision = "retry" | "force_archive";

export interface DispatchRetryRecord {
  filepath?: string;
  task_id?: string;

  provider: DispatchProvider;
  adapter: string;

  failureCount: number;
  retryRound: number;

  lastError: string;
  lastCategory: DispatchFailureCategory;
  retryable: boolean;

  nextRetryAt: number | null;

  decisionRequired: boolean;
  adminDecision?: DispatchAdminDecision;
  forceArchived: boolean;

  firstFailedAt: number;
  lastFailedAt: number;
  rawCode?: string;
  rawMessage?: string;

  /** @deprecated 使用 decisionRequired */
  blocked?: boolean;
}

export interface DispatchRetryRegistryOptions {
  now?: () => number;
  backoffRangesMs?: readonly (readonly [number, number])[];
  maxAutoFailures?: number;
  randomInt?: (min: number, max: number) => number;
}

function defaultRandomInt(min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function delayForAttempt(
  failureCount: number,
  ranges: readonly (readonly [number, number])[],
  randomInt: (min: number, max: number) => number,
): number {
  const idx = Math.min(Math.max(failureCount - 1, 0), ranges.length - 1);
  const range = ranges[idx] ?? ranges[ranges.length - 1]!;
  return randomInt(range[0], range[1]);
}

function withLegacyBlocked(rec: DispatchRetryRecord): DispatchRetryRecord {
  return { ...rec, blocked: rec.decisionRequired };
}

export class DispatchRetryRegistry {
  private readonly _records = new Map<string, DispatchRetryRecord>();
  private readonly _now: () => number;
  private readonly _backoffRangesMs: readonly (readonly [number, number])[];
  private readonly _maxAutoFailures: number;
  private readonly _randomInt: (min: number, max: number) => number;

  constructor(opts: DispatchRetryRegistryOptions = {}) {
    this._now = opts.now ?? (() => Date.now());
    this._backoffRangesMs = opts.backoffRangesMs ?? DEFAULT_BACKOFF_RANGES_MS;
    this._maxAutoFailures = opts.maxAutoFailures ?? DEFAULT_MAX_AUTO_FAILURES;
    this._randomInt = opts.randomInt ?? defaultRandomInt;
  }

  get(key: string): DispatchRetryRecord | undefined {
    const rec = this._records.get(key);
    return rec ? withLegacyBlocked(rec) : undefined;
  }

  list(): DispatchRetryRecord[] {
    return [...this._records.values()].map(withLegacyBlocked);
  }

  clear(key: string): void {
    this._records.delete(key);
  }

  isForceArchived(key: string): boolean {
    return this._records.get(key)?.forceArchived === true;
  }

  shouldDeferRestore(key: string): boolean {
    const rec = this._records.get(key);
    if (!rec) return sdkCooldownRegistry.active;
    if (rec.forceArchived) return true;
    if (rec.decisionRequired) return true;
    if (rec.nextRetryAt != null && this._now() < rec.nextRetryAt) return true;
    return sdkCooldownRegistry.active;
  }

  recordFailure(
    key: string,
    err: Error,
    meta: NormalizeDispatchFailureOptions & { filepath?: string; task_id?: string } = {},
  ): DispatchRetryRecord {
    const norm = normalizeDispatchFailure(err, meta);
    const prev = this._records.get(key);
    const now = this._now();
    const failureCount = (prev?.failureCount ?? 0) + 1;
    const retryRound = prev?.retryRound ?? 0;
    const firstFailedAt = prev?.firstFailedAt ?? now;

    const base: Omit<DispatchRetryRecord, "failureCount" | "nextRetryAt" | "decisionRequired"> = {
      filepath: meta.filepath ?? prev?.filepath,
      task_id: meta.task_id ?? prev?.task_id,
      provider: norm.provider,
      adapter: norm.adapter,
      retryRound,
      lastError: norm.message,
      lastCategory: norm.category,
      retryable: norm.retryable,
      adminDecision: prev?.adminDecision,
      forceArchived: prev?.forceArchived ?? false,
      firstFailedAt,
      lastFailedAt: now,
      rawCode: norm.rawCode,
      rawMessage: norm.rawMessage,
    };

    if (!norm.retryable) {
      const rec: DispatchRetryRecord = {
        ...base,
        failureCount,
        nextRetryAt: null,
        decisionRequired: true,
      };
      this._records.set(key, rec);
      return withLegacyBlocked(rec);
    }

    if (failureCount <= this._maxAutoFailures) {
      const delay = delayForAttempt(failureCount, this._backoffRangesMs, this._randomInt);
      const rec: DispatchRetryRecord = {
        ...base,
        failureCount,
        nextRetryAt: now + delay,
        decisionRequired: false,
      };
      this._records.set(key, rec);
      return withLegacyBlocked(rec);
    }

    const rec: DispatchRetryRecord = {
      ...base,
      failureCount,
      nextRetryAt: null,
      decisionRequired: true,
    };
    this._records.set(key, rec);
    return withLegacyBlocked(rec);
  }

  recordTransientFailure(
    key: string,
    err: Error,
    meta: NormalizeDispatchFailureOptions = {},
  ): DispatchRetryRecord {
    return this.recordFailure(key, err, { ...meta, retryable: true });
  }

  adminRetry(key: string): DispatchRetryRecord | undefined {
    const prev = this._records.get(key);
    if (!prev) return undefined;
    const now = this._now();
    const rec: DispatchRetryRecord = {
      ...prev,
      failureCount: 0,
      retryRound: prev.retryRound + 1,
      nextRetryAt: now,
      decisionRequired: false,
      forceArchived: false,
      adminDecision: "retry",
    };
    this._records.set(key, rec);
    return withLegacyBlocked(rec);
  }

  adminForceArchive(key: string): DispatchRetryRecord | undefined {
    const prev = this._records.get(key);
    if (!prev) return undefined;
    const rec: DispatchRetryRecord = {
      ...prev,
      nextRetryAt: null,
      decisionRequired: false,
      forceArchived: true,
      adminDecision: "force_archive",
    };
    this._records.set(key, rec);
    return withLegacyBlocked(rec);
  }
}

export const dispatchRetryRegistry = new DispatchRetryRegistry();
