/**
 * CursorUsageSyncer — pulls real billing data from the Cursor Admin API
 * and caches it locally so the Panel can display true token costs.
 *
 * API: POST https://api.cursor.com/teams/filtered-usage-events
 * Auth: Basic Auth (username = CURSOR_API_KEY, password = "")
 * Body: JSON { startDate, endDate, page, pageSize } (epoch ms). Team is implied by the key.
 * Cache: <projectRoot>/fcop/cache/cursor-usage.json
 *
 * The cache is considered fresh for CACHE_TTL_MS (30 minutes by default).
 * Panel reads the cache; this syncer runs in the background on a timer.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

// ─── public types ─────────────────────────────────────────────────────────────

export interface AgentUsage {
  agentId: string;
  totalCost: number;
  totalTokens: number;
  runCount: number;
}

export interface ModelUsage {
  model: string;
  totalCost: number;
  totalTokens: number;
  runCount: number;
}

export interface UsageSummary {
  totalCost: number;
  totalTokens: number;
  totalRuns: number;
}

export interface CursorUsageCache {
  syncedAt: string;
  teamId: string;
  period: { startDate: string; endDate: string };
  agents: AgentUsage[];
  models: ModelUsage[];
  summary: UsageSummary;
}

export interface CursorUsageSyncerLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface CursorUsageSyncerOptions {
  projectRoot: string;
  apiKey?: string;
  teamId?: string;
  /** How long the cached result is considered fresh (ms). Default 30 min. */
  cacheTtlMs?: number;
  logger?: CursorUsageSyncerLogger;
}

// ─── class ───────────────────────────────────────────────────────────────────

const CURSOR_API_BASE = "https://api.cursor.com";
const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1_000;

export class CursorUsageSyncer {
  private readonly _projectRoot: string;
  private readonly _apiKey: string;
  private readonly _teamId: string;
  private readonly _cacheTtlMs: number;
  private readonly _cacheFile: string;
  private readonly _logger: CursorUsageSyncerLogger;
  private _timer: ReturnType<typeof setInterval> | null = null;
  /** Suppress repeated 401/403 spam (same process); reset on successful sync. */
  private _authErrorMutedUntil = 0;

  constructor(opts: CursorUsageSyncerOptions) {
    this._projectRoot = opts.projectRoot;
    this._apiKey = opts.apiKey ?? process.env["CURSOR_API_KEY"] ?? "";
    this._teamId = opts.teamId ?? process.env["CURSOR_TEAM_ID"] ?? "";
    this._cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this._cacheFile = join(this._projectRoot, "fcop", "cache", "cursor-usage.json");
    this._logger = opts.logger ?? {
      info: (msg) => console.log(msg),
      warn: (msg) => console.warn(msg),
    };
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /**
   * Pull from Cursor API and write cache. Falls back gracefully on errors.
   * Returns the freshly-written cache, or null on failure.
   */
  async sync(): Promise<CursorUsageCache | null> {
    if (!this._apiKey) {
      this._logger.warn("[UsageSync] CURSOR_API_KEY not set — skipping sync");
      return null;
    }

    const now = new Date();
    const startDate = new Date(now);
    startDate.setUTCHours(0, 0, 0, 0);

    const credentials = Buffer.from(`${this._apiKey}:`).toString("base64");
    const startMs = startDate.getTime();
    const endMs = now.getTime();
    const endpoint = `${CURSOR_API_BASE}/teams/filtered-usage-events`;

    let rows: Array<Record<string, unknown>> = [];
    try {
      const pageSize = 250;
      let page = 1;
      let hasNext = true;

      while (hasNext && page <= 200) {
        const resp = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Basic ${credentials}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            startDate: startMs,
            endDate: endMs,
            page,
            pageSize,
          }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!resp.ok) {
          const status = resp.status;
          if (status === 401 || status === 403) {
            const now = Date.now();
            if (now >= this._authErrorMutedUntil) {
              this._authErrorMutedUntil = now + 60 * 60 * 1_000;
              this._logger.warn(
                `[UsageSync] API returned ${status} ${resp.statusText} — key rejected or lacks Admin API access. ` +
                  `Use the **team Admin API key** from Cursor Dashboard → Team → Settings (not a personal/session token). ` +
                  `Enterprise team required per Cursor docs. Further ${status} logs suppressed for 1h — using stale cache.`,
              );
            }
          } else {
            this._logger.warn(
              `[UsageSync] API returned ${status} ${resp.statusText} — using stale cache`,
            );
          }
          return await this._readCache();
        }

        const json = (await resp.json()) as Record<string, unknown>;
        const batch = json["usageEvents"];
        if (!Array.isArray(batch)) {
          this._logger.warn(
            "[UsageSync] response missing usageEvents[] — using stale cache",
          );
          return await this._readCache();
        }
        rows.push(...(batch as Array<Record<string, unknown>>));

        const pag = json["pagination"] as Record<string, unknown> | undefined;
        hasNext = Boolean(pag?.["hasNextPage"]);
        page += 1;
      }
    } catch (err) {
      this._logger.warn(
        `[UsageSync] network error: ${err instanceof Error ? err.message : String(err)} — using stale cache`,
      );
      return await this._readCache();
    }

    const cache = this._aggregate(rows, startDate, now);
    await this._writeCache(cache);
    this._authErrorMutedUntil = 0;
    this._logger.info(
      `[UsageSync] synced — totalCost=$${cache.summary.totalCost.toFixed(4)},` +
        ` tokens=${cache.summary.totalTokens}, runs=${cache.summary.totalRuns}`,
    );
    return cache;
  }

  /**
   * Read cache from disk. Returns null if the cache file does not exist
   * or cannot be parsed.
   */
  async readCache(): Promise<CursorUsageCache | null> {
    return this._readCache();
  }

  /**
   * Return true if a cache exists and is younger than cacheTtlMs.
   */
  async isCacheFresh(): Promise<boolean> {
    const cache = await this._readCache();
    if (!cache) return false;
    const age = Date.now() - new Date(cache.syncedAt).getTime();
    return age < this._cacheTtlMs;
  }

  /**
   * Ensure cache is fresh, syncing if necessary. Used by GET /usage/today.
   */
  async ensureFreshCache(): Promise<CursorUsageCache | null> {
    if (await this.isCacheFresh()) {
      return this._readCache();
    }
    return this.sync();
  }

  /** Start periodic background sync. Idempotent. */
  startAutoSync(intervalMs = DEFAULT_CACHE_TTL_MS): void {
    if (this._timer !== null) return;
    // Run once immediately (fire-and-forget), then on interval.
    void this.sync();
    this._timer = setInterval(() => {
      void this.sync();
    }, intervalMs);
    this._timer.unref();
    this._logger.info(
      `[UsageSync] auto-sync started (interval=${intervalMs / 60_000} min)`,
    );
  }

  /** Stop periodic background sync. Idempotent. */
  stopAutoSync(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
      this._logger.info("[UsageSync] auto-sync stopped");
    }
  }

  // ── private ────────────────────────────────────────────────────────────────

  /**
   * Aggregate Cursor `filtered-usage-events` rows (`usageEvents[]`) into our cache schema.
   * Docs: each row may include `chargedCents` (reconcile with billing), nested `tokenUsage`
   * for token-based calls, and `userEmail` / `model`.
   */
  private _aggregate(
    events: Array<Record<string, unknown>>,
    startDate: Date,
    endDate: Date,
  ): CursorUsageCache {
    const agentMap = new Map<string, AgentUsage>();
    const modelMap = new Map<string, ModelUsage>();
    let totalCost = 0;
    let totalTokens = 0;
    let totalRuns = 0;

    for (const ev of events) {
      const tu = ev["tokenUsage"] as Record<string, unknown> | undefined;
      const hasCharged =
        ev["chargedCents"] !== undefined && ev["chargedCents"] !== null;
      const chargedCents = hasCharged ? Number(ev["chargedCents"]) : NaN;
      const cost = Number.isFinite(chargedCents)
        ? chargedCents / 100
        : Number(ev["cost"] ?? ev["totalCost"] ?? ev["total_cost"] ?? 0);

      const inputTok = tu
        ? Number(tu["inputTokens"] ?? 0)
        : Number(
            ev["inputTokens"] ??
              ev["input_tokens"] ??
              ev["promptTokens"] ??
              0,
          );
      const outputTok = tu
        ? Number(tu["outputTokens"] ?? 0)
        : Number(
            ev["outputTokens"] ??
              ev["output_tokens"] ??
              ev["completionTokens"] ??
              0,
          );
      const tokens = inputTok + outputTok;

      const rawModel = String(ev["model"] ?? ev["modelId"] ?? "unknown");
      const agentId = String(
        ev["userEmail"] ??
          ev["agentId"] ??
          ev["agent_id"] ??
          ev["userId"] ??
          ev["email"] ??
          "unknown",
      );

      totalCost += cost;
      totalTokens += tokens;
      totalRuns += 1;

      // per-agent
      const a = agentMap.get(agentId) ?? {
        agentId,
        totalCost: 0,
        totalTokens: 0,
        runCount: 0,
      };
      a.totalCost += cost;
      a.totalTokens += tokens;
      a.runCount += 1;
      agentMap.set(agentId, a);

      // per-model
      const m = modelMap.get(rawModel) ?? {
        model: rawModel,
        totalCost: 0,
        totalTokens: 0,
        runCount: 0,
      };
      m.totalCost += cost;
      m.totalTokens += tokens;
      m.runCount += 1;
      modelMap.set(rawModel, m);
    }

    return {
      syncedAt: new Date().toISOString(),
      teamId: this._teamId,
      period: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      },
      agents: Array.from(agentMap.values()).sort((a, b) => b.totalCost - a.totalCost),
      models: Array.from(modelMap.values()).sort((a, b) => b.totalCost - a.totalCost),
      summary: { totalCost, totalTokens, totalRuns },
    };
  }

  private async _readCache(): Promise<CursorUsageCache | null> {
    try {
      const raw = await fs.readFile(this._cacheFile, "utf-8");
      return JSON.parse(raw) as CursorUsageCache;
    } catch {
      return null;
    }
  }

  private async _writeCache(cache: CursorUsageCache): Promise<void> {
    try {
      const dir = join(this._projectRoot, "fcop", "cache");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this._cacheFile, JSON.stringify(cache, null, 2), "utf-8");
    } catch (err) {
      this._logger.warn(
        `[UsageSync] failed to write cache: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
