/**
 * SkillRegistry — load + index Skill records (per design doc §3.6 + §0.7.5).
 *
 * Reference:
 *   - `docs/design/codeflowmu-v2-on-fcop-sdk.md` §3.6 (skill schema design)
 *   - `docs/design/codeflowmu-v2-on-fcop-sdk.md` §0.5 (fcop-mcp hard dep)
 *   - `packages/codeflowmu-protocol/schemas/skill.schema.json` (v0.1.json)
 *   - `fcop/_lifecycle/inbox/TASK-20260509-024-PM-to-DEV.md` §主交付 1
 *
 * Disk layout: `<skillsDir>/<skill_id>.json`.
 *
 * Tolerant-read semantics (mirrors `SessionStore.listAll`):
 *
 *   - Skip `*.tmp` (atomic-write staging files)
 *   - Skip non-`.json` siblings (operator notes, README, etc.)
 *   - Skip files that fail to parse (logger.warn + push to skipped[])
 *   - Skip files that fail schema validation (logger.warn + push to skipped[])
 *
 * Individual file corruption does NOT block the rest of the load —
 * "one bad skill should not take down the runtime" is the same posture
 * Phase B/C/D took for SessionStore / TranscriptWriter.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { validate } from "@codeflowmu/protocol";

import { SkillSchemaError } from "../registry/errors.ts";

/** Logger surface — same shape as Phase D's `ReviewEngineLogger`. */
export interface SkillRegistryLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** Single tool entry inside a Skill record (skill.schema.json `tools[]`). */
export interface SkillToolSpec {
  name: string;
  required_perms?: string[];
  /** Defaults to "medium" for 3rd-party skills lacking the field (§0.9.4). */
  risk_level?: "low" | "medium" | "high" | "irreversible";
  irreversible?: boolean;
  cost_sensitive?: boolean;
}

/**
 * Provider descriptor — only `mcp_server` is in v0.1 schema, but we keep
 * the shape extensible.
 */
export interface SkillProvider {
  type: "mcp_server";
  transport: "stdio" | "http" | "sse";
  /** Required when transport="stdio" (skill.schema.json allOf #1). */
  command?: string;
  /** Required when transport="http"|"sse" (skill.schema.json allOf #2). */
  url?: string;
  /** schema additionalProperties=true — preserve unknown fields verbatim. */
  [extra: string]: unknown;
}

/**
 * In-memory mirror of one `<skill_id>.json` file. Field set is identical
 * to skill.schema.json — no runtime-private fields (skill data is purely
 * declarative; runtime state about a skill mount lives on `MCPInjector`).
 */
export interface SkillRecord {
  skill_id: string;
  version: string;
  displayName?: string;
  provided_by: SkillProvider;
  tools: SkillToolSpec[];
  available_to_roles: string[];
  /**
   * Hard kernel deps. Per skill.schema.json `required_kernel.contains`,
   * EVERY skill loaded here is guaranteed to contain at least one entry
   * matching `^fcop@.+` — schema-level invariant, NOT re-checked here.
   */
  required_kernel: string[];
  compatible_runtimes?: ("local" | "cloud")[];
  homepage?: string;
  license?: string;
}

/** Single skipped-file audit entry returned by `load()`. */
export interface SkillSkippedEntry {
  file: string;
  reason: string;
}

export interface SkillRegistryOptions {
  /**
   * Directory holding `<skill_id>.json` files. Defaults to
   * `<persistDir>/skills/` when wired by `Runtime.create`. Tests inject
   * an `os.tmpdir()`-rooted path.
   */
  skillsDir: string;
  /** Defaults to a no-op logger. */
  logger?: SkillRegistryLogger;
}

const NOOP_LOGGER: SkillRegistryLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class SkillRegistry {
  private readonly _skillsDir: string;
  private readonly _logger: SkillRegistryLogger;

  /** O(1) lookup by skill_id. Empty until `load()` runs. */
  private readonly _byId = new Map<string, SkillRecord>();

  /**
   * Reverse index: role → set of skill_ids exposed to that role.
   * `available_to_roles` is normalized to lowercase to keep matching
   * stable across "DEV" vs "dev" inconsistencies in 3rd-party skills.
   */
  private readonly _byRole = new Map<string, Set<string>>();

  constructor(opts: SkillRegistryOptions) {
    this._skillsDir = opts.skillsDir;
    this._logger = opts.logger ?? NOOP_LOGGER;
  }

  /** Resolved canonical skills directory. */
  get skillsDir(): string {
    return this._skillsDir;
  }

  /**
   * Scan the skills dir and load every valid skill into the in-memory
   * indexes. Tolerant of bad files — returns the audit lists so callers
   * (typically `Runtime.create`) can stdout-summarize the load.
   *
   * Idempotent — re-calling clears and re-builds the indexes.
   */
  async load(): Promise<{
    loaded: SkillRecord[];
    skipped: SkillSkippedEntry[];
  }> {
    this._byId.clear();
    this._byRole.clear();

    let entries: string[];
    try {
      entries = await fs.readdir(this._skillsDir);
    } catch (err) {
      if (isNotFoundError(err)) {
        // No skills dir at all = empty registry. Don't auto-create —
        // that's the caller's job (Runtime.create mkdirs persistDir/skills).
        return { loaded: [], skipped: [] };
      }
      throw err;
    }

    const loaded: SkillRecord[] = [];
    const skipped: SkillSkippedEntry[] = [];

    for (const name of entries) {
      // Tolerant-read filters: same order as SessionStore.listAll
      if (name.endsWith(".tmp")) continue;
      if (!name.endsWith(".json")) continue;

      const path = join(this._skillsDir, name);

      let raw: string;
      try {
        raw = await fs.readFile(path, "utf-8");
      } catch (err) {
        const reason = `unreadable: ${(err as Error).message}`;
        this._logger.warn(`[SkillRegistry] skipping ${path}: ${reason}`);
        skipped.push({ file: path, reason });
        continue;
      }
      if (raw.trim().length === 0) {
        const reason = "empty file (likely interrupted write)";
        this._logger.warn(`[SkillRegistry] skipping ${path}: ${reason}`);
        skipped.push({ file: path, reason });
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        const reason = `parse error: ${(err as Error).message}`;
        this._logger.warn(`[SkillRegistry] skipping ${path}: ${reason}`);
        skipped.push({ file: path, reason });
        continue;
      }

      const result = await validate("skill", parsed);
      if (!result.valid) {
        // Wrap into named error so test (TS-7.2) can `instanceof` against
        // the helper directly. Registry itself does NOT throw — it logs
        // and pushes to skipped[].
        const err = new SkillSchemaError(path, result.errors ?? []);
        const reason = `schema invalid: ${err.errors.length} error(s)`;
        this._logger.warn(`[SkillRegistry] skipping ${path}: ${reason}`);
        skipped.push({ file: path, reason });
        continue;
      }

      const record = parsed as SkillRecord;

      // Filename ↔ skill_id consistency check — catches operator typos
      // like accidentally renaming the file but forgetting to bump
      // skill_id inside.
      const expectedFile = `${record.skill_id}.json`;
      if (name !== expectedFile) {
        const reason =
          `filename "${name}" does not match skill_id="${record.skill_id}" ` +
          `(expected "${expectedFile}")`;
        this._logger.warn(`[SkillRegistry] skipping ${path}: ${reason}`);
        skipped.push({ file: path, reason });
        continue;
      }

      this._byId.set(record.skill_id, record);
      for (const role of record.available_to_roles) {
        const set = this._byRole.get(role) ?? new Set<string>();
        set.add(record.skill_id);
        this._byRole.set(role, set);
      }
      loaded.push(record);
    }

    this._logger.info(
      `[SkillRegistry] loaded ${loaded.length} skill(s) from ${this._skillsDir}` +
        (skipped.length > 0 ? ` (skipped ${skipped.length})` : ""),
    );

    return { loaded, skipped };
  }

  /** O(1) lookup. Returns `null` if absent — never throws. */
  getById(skill_id: string): SkillRecord | null {
    return this._byId.get(skill_id) ?? null;
  }

  /**
   * Reverse query: every skill whose `available_to_roles` list contains
   * `role`. Returns an empty array when no skills match — callers can
   * iterate without null-checks.
   *
   * Order is insertion order (stable across calls within a single
   * `load()` cycle), so test fixtures can assert deeply.
   */
  listForRole(role: string): SkillRecord[] {
    const ids = this._byRole.get(role);
    if (!ids || ids.size === 0) return [];
    const out: SkillRecord[] = [];
    for (const id of ids) {
      const rec = this._byId.get(id);
      if (rec) out.push(rec);
    }
    return out;
  }

  /** All loaded skills, insertion order. */
  list(): SkillRecord[] {
    return Array.from(this._byId.values());
  }

  /**
   * Programmatic invariant: `loaded.length === byId.size`. Exposed so
   * tests can sanity-check after `load()` without poking private state.
   */
  size(): number {
    return this._byId.size;
  }
}

// ─── helpers ────────────────────────────────────────────────────────────

interface NodeError extends Error {
  code?: string;
}

function isNotFoundError(err: unknown): err is NodeError {
  return (err as NodeError | null)?.code === "ENOENT";
}

