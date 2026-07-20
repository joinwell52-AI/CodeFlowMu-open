/**
 * PersistentStore — durability contract for AgentRegistry.
 *
 * Sprint S2 shipped the interface only. Sprint S3 Phase A (this file)
 * adds:
 *
 *   1. The `upsert` / `removeById` methods that TASK-20260509-009
 *      §必交付 1 specifies.
 *   2. `JsonFileStore` — the concrete v0.1 backend, implementing
 *      `crash-recovery.md` decision 1 (atomic-write + fsync per write).
 *
 * Reference:
 *   - design doc `docs/design/codeflowmu-v2-on-fcop-sdk.md` §2.1 subsystem 6
 *     (State Store), §10.2 sprint S3
 *   - `docs/crash-recovery.md` decision 1 (atomic-write + fsync per write)
 *   - `fcop/_lifecycle/inbox/TASK-20260509-009-PM-to-DEV.md` §必交付 1
 */

import { promises as fs } from "node:fs";

import {
  atomicWriteJson,
} from "../_internal/atomic-write.ts";
import { globalFileWriteMutex } from "../_internal/KeyedMutex.ts";
import type { AgentRecord } from "../types/state.ts";
import { RegistryWriteError } from "./errors.ts";

/**
 * Atomic key/value store for AgentRecord. One implementation = one storage
 * backend. The default v0.1 backend (`JsonFileStore`) writes `agents.json`
 * under `.codeflowmu/state/`.
 *
 * Implementations MUST guarantee:
 *
 * - **Atomicity**: a partial `saveAll` MUST NOT leave the store in a
 *   half-written state. (FS impl: write-temp + rename. SQLite: TX.)
 * - **Durability**: after `saveAll` resolves, the data MUST survive a
 *   `kill -9` of the runtime. (FS impl: fsync. SQLite: WAL flushed.)
 * - **Concurrency**: only ONE runtime process owns the store at a time.
 *   Multi-process is out of scope for v0.1.
 */
export interface PersistentStore {
  /**
   * Load every AgentRecord. Used at startup and during full-table dumps.
   *
   * - Missing file (first boot): resolve with `[]`.
   * - Corrupt JSON / partial write: throw — `RuntimeBootstrap` translates
   *   this into a `RuntimeBootstrapError` HARD FAIL per decision 2.
   */
  loadAll(): Promise<AgentRecord[]>;

  /**
   * Persist every AgentRecord. Replaces the on-disk content atomically.
   * @param records full set of records (NOT a delta).
   * @throws `RegistryWriteError` if the write cannot be made durable;
   *   the on-disk file is unchanged in that case.
   */
  saveAll(records: AgentRecord[]): Promise<void>;

  /**
   * Read-modify-write a single record by `record.protocol.agent_id`.
   * Replaces the matching record if one exists, otherwise appends.
   *
   * Built on top of `loadAll` + `saveAll` — pays the full re-write cost
   * per call. v0.1 quantities (< 1000 writes/day) make that fine; if
   * v0.2+ ever needs sub-millisecond latency we'd add a delta journal
   * (see crash-recovery.md decision 1 论证).
   */
  upsert(record: AgentRecord): Promise<void>;

  /**
   * Read-modify-write removing a record by `agent_id`. No-op (silent) if
   * the record does not exist — symmetric with the "register-resume-or-noop"
   * idempotency in the registry surface.
   */
  removeById(agentId: string): Promise<void>;
}

/** Constructor options for `JsonFileStore`. */
export interface JsonFileStoreOptions {
  /**
   * Path to `agents.json`. Default `.codeflowmu/state/agents.json`.
   * Tests pass an `os.tmpdir()`-rooted path to keep production state clean.
   *
   * REQUIRED to be configurable per TASK-009 §不做 — hard-coding rejected.
   */
  path: string;
}

/**
 * v0.1 reference implementation of `PersistentStore`.
 *
 * Write protocol (decision 1):
 *
 *   1. write `${path}.tmp` (full JSON dump, pretty)
 *   2. fsync the temp file
 *   3. atomic `rename(${path}.tmp -> ${path})`
 *      (POSIX-rename + NTFS-rename are both atomic for same-device renames)
 *   4. fsync the parent directory (Linux requires this; harmless on Windows)
 *
 * Failure model:
 *
 *   - Step 1/2 fails → `${path}.tmp` exists as a diagnostic; original
 *     `${path}` is untouched. We attempt a best-effort `unlink` of the
 *     stale `.tmp` and surface `RegistryWriteError`.
 *   - Step 3 fails → original `${path}` is still untouched (rename is
 *     atomic). Same surface as step 1/2.
 *   - Step 4 fails → the rename completed; the data is durable in the
 *     filesystem buffer cache and almost-certainly already in the
 *     journal. We log a warning but DO NOT throw — throwing here would
 *     give the caller the wrong impression that the write rolled back.
 *
 * Reads:
 *   - Missing file → `[]` (first boot).
 *   - Empty file or whitespace-only → throw (file exists but content
 *     was lost; we don't silently treat that as "no records").
 *   - Malformed JSON → throw, with the parse error as `cause`.
 */
export class JsonFileStore implements PersistentStore {
  private readonly _path: string;

  constructor(opts: JsonFileStoreOptions) {
    this._path = opts.path;
  }

  /** Resolved canonical path the store writes to. */
  get path(): string {
    return this._path;
  }

  async loadAll(): Promise<AgentRecord[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this._path, "utf-8");
    } catch (err) {
      if (isNotFoundError(err)) return [];
      throw new RegistryWriteError(
        `failed to read ${this._path}: ${(err as Error).message}`,
        { cause: err },
      );
    }
    if (raw.trim().length === 0) {
      throw new RegistryWriteError(
        `${this._path} exists but is empty (likely interrupted write); ` +
          "manual recovery required (see crash-recovery.md decision 2 HARD FAIL).",
      );
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error(
          `expected top-level array, got ${typeof parsed === "object" && parsed !== null ? "object" : typeof parsed}`,
        );
      }
      return parsed as AgentRecord[];
    } catch (err) {
      throw new RegistryWriteError(
        `failed to parse ${this._path}: ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  async saveAll(records: AgentRecord[]): Promise<void> {
    const body = JSON.stringify(records, null, 2);
    try {
      await globalFileWriteMutex.run(this._path, () =>
        atomicWriteJson(this._path, body),
      );
    } catch (err) {
      throw new RegistryWriteError(
        `failed to write ${this._path}: ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  async upsert(record: AgentRecord): Promise<void> {
    const records = await this.loadAll();
    const idx = records.findIndex(
      (r) => r.protocol.agent_id === record.protocol.agent_id,
    );
    if (idx >= 0) {
      records[idx] = record;
    } else {
      records.push(record);
    }
    await this.saveAll(records);
  }

  async removeById(agentId: string): Promise<void> {
    const records = await this.loadAll();
    const next = records.filter((r) => r.protocol.agent_id !== agentId);
    if (next.length === records.length) return; // no-op
    await this.saveAll(next);
  }
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "ENOENT"
  );
}

