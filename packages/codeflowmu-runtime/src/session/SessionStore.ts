/**
 * SessionStore — durable per-session metadata layer.
 *
 * Implements `crash-recovery.md` decision 4 ("元数据 JSON + 事件流 markdown
 * 拆分"): SessionRecord (small, structured) lives here as one JSON file
 * per session, while the high-frequency event stream goes to
 * `TranscriptWriter` (separate file, append-only).
 *
 * Why one-record-per-file (vs. PersistentStore's all-records-one-file):
 *
 *   - Sessions count is order-of-magnitude larger than Agents
 *     (one Agent can host hundreds of Sessions across its lifetime)
 *   - Single big `sessions.json` would grow unbounded + every save
 *     would have to rewrite the whole array
 *   - One file per session lets us delete settled sessions (Phase C+
 *     "garbage collection") without rewriting peer records
 *
 * Reference:
 *   - `docs/crash-recovery.md` decision 4 design discussion
 *   - TASK-20260509-013 §主交付 2 surface contract
 *   - TASK-20260509-002 §必交付 4 (SessionRecord shape — runtime-private
 *     fields are namespaced `runtime_*`)
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { atomicWriteJson, cleanupTmp } from "../_internal/atomic-write.ts";
import { RegistryWriteError } from "../registry/errors.ts";
import type { SessionRecord } from "../types/state.ts";

/** Construction options for `SessionStore`. */
export interface SessionStoreOptions {
  /**
   * Directory holding `<session_id>.json` files. Default
   * `.codeflowmu/state/sessions/`.
   *
   * REQUIRED to be configurable (same discipline as `JsonFileStore.path`):
   * tests pass an `os.tmpdir()`-rooted path so production state is never
   * polluted by test runs.
   */
  dir: string;
}

/**
 * Per-session durability backend. Methods are async-safe but the runtime
 * is single-process, so callers do not need to worry about cross-process
 * locking (same constraint as `PersistentStore`).
 */
export class SessionStore {
  private readonly _dir: string;

  constructor(opts: SessionStoreOptions) {
    this._dir = opts.dir;
  }

  /** Resolved canonical directory the store writes under. */
  get dir(): string {
    return this._dir;
  }

  /**
   * Persist a `SessionRecord`. Replaces the on-disk content for this
   * `session_id` atomically (write-tmp + rename + fsync per
   * `crash-recovery.md` decision 1).
   *
   * @throws `RegistryWriteError` if the write cannot be made durable;
   *   the on-disk file (if any) is unchanged in that case.
   */
  async save(record: SessionRecord): Promise<void> {
    const sessionId = record.protocol.session_id;
    const path = this._pathFor(sessionId);
    const body = JSON.stringify(record, null, 2);
    try {
      await atomicWriteJson(path, body);
    } catch (err) {
      await cleanupTmp(path);
      throw new RegistryWriteError(
        `failed to save SessionRecord for session_id="${sessionId}": ` +
          `${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  /**
   * Load a single `SessionRecord` by `session_id`.
   *
   * @returns the record, or `null` if absent. Does NOT throw on missing —
   *   "is this session known?" is a probe, not a contract violation.
   * @throws `RegistryWriteError` if the file exists but is unreadable /
   *   unparseable. (TASK-013 §主交付 2 line 76-77 — single-record loads
   *   distinguish "absent" from "corrupt"; corrupt is operator-actionable.)
   */
  async load(sessionId: string): Promise<SessionRecord | null> {
    const path = this._pathFor(sessionId);
    let raw: string;
    try {
      raw = await fs.readFile(path, "utf-8");
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw new RegistryWriteError(
        `failed to read SessionRecord for session_id="${sessionId}" at ${path}: ` +
          `${(err as Error).message}`,
        { cause: err },
      );
    }
    if (raw.trim().length === 0) {
      throw new RegistryWriteError(
        `SessionRecord file ${path} exists but is empty (likely interrupted ` +
          "write); manual recovery required.",
      );
    }
    try {
      return JSON.parse(raw) as SessionRecord;
    } catch (err) {
      throw new RegistryWriteError(
        `failed to parse SessionRecord for session_id="${sessionId}" at ${path}: ` +
          `${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  /**
   * Enumerate every `SessionRecord` on disk. Used by `SessionManager.listActive`
   * and by future Phase C reconciliation.
   *
   * Robustness contract (TASK-013 §主交付 2 line 78):
   *
   *   - Skip `*.tmp` (atomic-write staging files)
   *   - Skip non-`.json` siblings (operator notes, README, etc.)
   *   - Skip files that fail to parse, with a `console.warn` —
   *     individual file corruption does NOT block the rest of the listing
   *     (this is the "tolerant read" the design doc calls out)
   *
   * @returns array, possibly empty.
   */
  async listAll(): Promise<SessionRecord[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this._dir);
    } catch (err) {
      if (isNotFoundError(err)) return [];
      throw new RegistryWriteError(
        `failed to enumerate SessionStore dir ${this._dir}: ${
          (err as Error).message
        }`,
        { cause: err },
      );
    }

    const records: SessionRecord[] = [];
    for (const name of entries) {
      if (!name.endsWith(".json") || name.endsWith(".tmp")) continue;
      const path = join(this._dir, name);
      let raw: string;
      try {
        raw = await fs.readFile(path, "utf-8");
      } catch (err) {
        // eslint-disable-next-line no-console -- tolerant-read warn
        console.warn(
          `[SessionStore] skipping unreadable file ${path}: ${
            (err as Error).message
          }`,
        );
        continue;
      }
      if (raw.trim().length === 0) {
        // eslint-disable-next-line no-console -- tolerant-read warn
        console.warn(
          `[SessionStore] skipping empty file ${path} (likely interrupted write)`,
        );
        continue;
      }
      try {
        records.push(JSON.parse(raw) as SessionRecord);
      } catch (err) {
        // eslint-disable-next-line no-console -- tolerant-read warn
        console.warn(
          `[SessionStore] skipping unparseable file ${path}: ${
            (err as Error).message
          }`,
        );
        continue;
      }
    }
    return records;
  }

  /**
   * Delete a `SessionRecord` by `session_id`. No-op if absent (idempotent).
   *
   * Phase B exposes this for Phase C garbage collection but does NOT
   * use it itself — sessions are kept around past `ended_at` so audit
   * tools can inspect them. Tests use this for tear-down.
   */
  async remove(sessionId: string): Promise<void> {
    const path = this._pathFor(sessionId);
    try {
      await fs.unlink(path);
    } catch (err) {
      if (isNotFoundError(err)) return;
      throw new RegistryWriteError(
        `failed to remove SessionRecord for session_id="${sessionId}" at ${path}: ` +
          `${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  private _pathFor(sessionId: string): string {
    return join(this._dir, `${sessionId}.json`);
  }
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "ENOENT"
  );
}

