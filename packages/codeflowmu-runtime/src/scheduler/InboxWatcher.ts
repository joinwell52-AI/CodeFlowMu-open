/**
 * InboxWatcher — chokidar-backed file-add doorbell for the task inbox.
 *
 * Scope (TASK-20260509-018 §主交付 1):
 *
 * - Watch ONE directory (default `fcop/_lifecycle/inbox/`), depth=0 (no recurse).
 *   The repo currently lays Task files flat — the §2.4 reference impl in the
 *   design doc uses per-role subdirs, but adopting that is a v0.x+ migration
 *   (TASK-018 §不做 line 328 "保持现状平铺，不破坏").
 * - Only emit on `add`. `change` / `unlink` are ignored — Task files are
 *   append-only by codeflowmu-project rule, and a `change` event would just be
 *   the StateHistoryWriter's own `appendFile` reflecting back through chokidar.
 * - File-name regex matches the task signature only:
 *     /^TASK-\d{8}-\d{3,}-[A-Za-z]+-to-[A-Za-z]+\.md$/
 *   so REPORT-*.md / HANDOFF-*.md / generic markdown don't ring the doorbell.
 * - Handler errors are isolated: the watcher CANNOT die because one
 *   handler threw. We wrap each invocation in `Promise.resolve().catch(...)`
 *   and forward the error to the optional logger (default = console.error).
 *
 * Reference:
 * - design doc `docs/design/codeflowmu-v2-on-fcop-sdk.md` §2.4 (reference impl)
 * - TASK-20260509-018 §主交付 1 implementation points
 */

import { resolve as resolvePath } from "node:path";
import chokidar from "chokidar";
import type { FSWatcher } from "chokidar";

import {
  FcopClientError,
  type FcopProjectClient,
  type FcopValidationIssue,
} from "../_external/fcop-client.ts";
import { TaskParser, validateDurableTaskForDispatch } from "./TaskParser.ts";

/**
 * Default file-name regex — matches the mandatory prefix plus an optional
 * kebab-case slug suffix that PM agents (and fcop write_task) append.
 *
 * Accepted examples:
 *   TASK-20260513-016-PM-to-DEV.md
 *   TASK-20260513-016-PM-to-DEV-multiagent-flow-smoke.md
 */
const DEFAULT_TASK_FILE_REGEX =
  /^TASK-\d{8}-\d{3,}-[A-Za-z]+-to-[A-Za-z]+(-[A-Za-z0-9]+)*\.md$/;

/**
 * What to do when `fcopClient.inspectTask()` reports `severity === "error"`
 * issues for an incoming TASK file.
 *
 * P4 Day 4 (TASK-20260511-013 §2.1) introduces this policy. The v0.3
 * default is `dispatch_anyway` — same降级容错 spirit as Day 2 TaskParser's
 * `FcopClientError → yaml fallback`: when fcop is strict-er than v0.1
 * historical files, we'd rather emit a warning + still dispatch than
 * silently swallow tasks an operator dropped. Day 5/6 may upgrade the
 * default once we know the v0.3 false-positive rate.
 *
 * - `dispatch_anyway`: log a warning + still emit the task_added event.
 * - `reject`: drop the event entirely + log a warning (the file stays
 *   on disk; operator must fix + re-drop or PM re-issues).
 * - `needs_human_review`: surface label for v0.5 ack queue. For v0.3 it
 *   behaves like `reject` (we don't have a per-watcher review queue
 *   yet) but logs with a different prefix so operators can grep.
 */
export type InboxValidationFailPolicy =
  | "dispatch_anyway"
  | "reject"
  | "needs_human_review";

export interface InboxWatcherOpts {
  /** Directory to watch. Default behavior: caller passes the absolute path. */
  dir: string;
  /**
   * If true, the chokidar watcher fires `add` for every existing file at
   * startup. We default to `true` (= ignoreInitial) so a runtime restart
   * does not re-dispatch every existing task. Phase C E2E demo flips this
   * for a "drain inbox on startup" mode (deferred to Phase C+1).
   */
  ignoreInitial?: boolean;
  /** Override the default task-file regex. Mostly for tests. */
  fileNamePattern?: RegExp;
  /**
   * Optional logger; default = `console`. Tests inject a no-op logger to
   * silence handler-error warnings.
   */
  logger?: {
    warn: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
  };
  /**
   * P4 Day 4 (TASK-20260511-013) — optional fcop bridge for pre-dispatch
   * schema gating.
   *
   * When supplied: every incoming TASK file is first run through
   * `fcopClient.inspectTask(filename)`; the resulting `ValidationIssue[]`
   * decides whether to emit `task_added`:
   *   - 0 errors           → emit normally
   *   - `error`-severity   → `onValidationFail` policy
   *   - `FcopClientError`  → degrade to dispatch_anyway (same Day 2
   *                          TaskParser降级容错 idiom)
   *
   * When omitted: behavior is exactly Day 1 — no inspect call, all events
   * forwarded. Lets `CODEFLOW_SKIP_FCOP_PROBE=1` mode keep working.
   */
  fcopClient?: FcopProjectClient;
  /**
   * Policy for `severity === "error"` validation issues. Defaults to
   * `"dispatch_anyway"` (PM TASK-013 §2.1 recommended default; same
   * 容错 spirit as Day 2 TaskParser fallback — we'd rather emit a
   * warning + still dispatch than silently swallow operator drops).
   */
  onValidationFail?: InboxValidationFailPolicy;
}

/** Discriminated event passed to handlers. v0.1 only emits `task_added`. */
export interface InboxEvent {
  kind: "task_added";
  /** Absolute filesystem path to the task file. */
  filepath: string;
  /** Just the basename (e.g. `TASK-20260509-001-PM-to-DEV.md`). */
  filename: string;
  /** Sender role parsed from the filename (e.g. `PM`, `ADMIN`). */
  sender: string;
  /** Recipient role parsed from the filename (e.g. `DEV`, `OPS`). */
  recipient: string;
}

export type InboxEventHandler = (event: InboxEvent) => void | Promise<void>;

/** Parse `TASK-YYYYMMDD-NNN-XXX-to-YYY.md` → `{sender: XXX, recipient: YYY}`. */
function parseSenderRecipient(filename: string): {
  sender: string;
  recipient: string;
} | null {
  // Filename: TASK-YYYYMMDD-NNN-SENDER-to-RECIPIENT[-optional-slug].md
  // Split on "-" and look for the "to" keyword at its fixed index (4).
  const base = filename.replace(/\.md$/, "");
  const parts = base.split("-");
  // Minimum: ["TASK", "YYYYMMDD", "NNN", sender, "to", recipient] = 6 parts
  if (parts.length < 6) return null;
  if (parts[0] !== "TASK") return null;
  // "to" is always at index 4; sender at 3, recipient at 5.
  if (parts[4] !== "to") return null;
  const sender = parts[3];
  const recipient = parts[5];
  if (!sender || !recipient) return null;
  return { sender, recipient };
}

export class InboxWatcher {
  private readonly _dir: string;
  private readonly _ignoreInitial: boolean;
  private readonly _fileNamePattern: RegExp;
  private readonly _logger: NonNullable<InboxWatcherOpts["logger"]>;
  private readonly _fcopClient: FcopProjectClient | null;
  private readonly _onValidationFail: InboxValidationFailPolicy;

  private _watcher: FSWatcher | null = null;
  private _started = false;
  private readonly _handlers = new Set<InboxEventHandler>();

  constructor(opts: InboxWatcherOpts) {
    this._dir = resolvePath(opts.dir);
    this._ignoreInitial = opts.ignoreInitial ?? true;
    this._fileNamePattern = opts.fileNamePattern ?? DEFAULT_TASK_FILE_REGEX;
    this._logger = opts.logger ?? {
      warn: (msg, ...args) => console.warn(msg, ...args),
      error: (msg, ...args) => console.error(msg, ...args),
    };
    this._fcopClient = opts.fcopClient ?? null;
    this._onValidationFail = opts.onValidationFail ?? "dispatch_anyway";
  }

  /** Absolute watch directory (resolved at construction time). */
  get dir(): string {
    return this._dir;
  }

  /**
   * P4 Day 4 (TASK-20260511-013) — whether this watcher has an active
   * fcop bridge wired up. Runtime.start() / banner can log it for
   * transparency (same idiom as `TaskParser` / `ReviewWriter` flags).
   */
  get fcopClientWired(): boolean {
    return this._fcopClient !== null;
  }

  /** P4 Day 4 — current validation-fail policy (read-only). */
  get onValidationFail(): InboxValidationFailPolicy {
    return this._onValidationFail;
  }

  /**
   * Start watching. Resolves once chokidar's `ready` event fires (initial
   * scan complete). Calling twice is an error — the watcher is single-use
   * per construction.
   */
  async start(): Promise<void> {
    if (this._started) {
      throw new Error("InboxWatcher.start() already called");
    }
    this._started = true;

    this._watcher = chokidar.watch(this._dir, {
      ignoreInitial: this._ignoreInitial,
      depth: 0,
      // Persistent keeps Node's event loop alive while watching — desired
      // for a long-running runtime, but tests `await stop()` to release it.
      persistent: true,
      // Treat non-existent dir as "create lazily" — chokidar 4 emits ready
      // even if the dir doesn't exist yet, then fires `add` once it does.
      ignorePermissionErrors: true,
      // De-bounce double-`add` events. On Windows + NTFS, chokidar can
      // observe a file twice when the writer creates+populates in two
      // syscalls (open → write → close); awaitWriteFinish coalesces by
      // waiting until the file's size has been stable for stabilityThreshold.
      // 80ms covers fast Node writes; 30ms poll keeps perceived latency low.
      awaitWriteFinish: {
        stabilityThreshold: 80,
        pollInterval: 30,
      },
    });

    this._watcher.on("add", (filepath) => this._onAdd(filepath));
    this._watcher.on("error", (err) => {
      this._logger.error(
        `[InboxWatcher] chokidar error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });

    await new Promise<void>((resolve, reject) => {
      const w = this._watcher!;
      const onReady = (): void => {
        w.off("error", onError);
        resolve();
      };
      const onError = (err: unknown): void => {
        w.off("ready", onReady);
        reject(err);
      };
      w.once("ready", onReady);
      w.once("error", onError);
    });
  }

  /**
   * Subscribe to inbox events. Returns an unsubscribe function. Handlers
   * are called serially per event; a slow async handler delays nothing
   * (we don't await the handler before calling the next subscriber, so
   * one slow listener can't starve another).
   */
  onEvent(handler: InboxEventHandler): () => void {
    this._handlers.add(handler);
    return () => {
      this._handlers.delete(handler);
    };
  }

  /**
   * Gracefully close the underlying chokidar watcher (releases fd / OS
   * watch handles). Safe to call before `start()` (no-op) or twice
   * (second call no-op).
   */
  async stop(): Promise<void> {
    if (!this._watcher) return;
    const w = this._watcher;
    this._watcher = null;
    await w.close();
  }

  // ── private ──────────────────────────────────────────────────────────

  private _onAdd(filepath: string): void {
    const filename = filepath.split(/[\\/]/).pop() ?? filepath;
    if (!this._fileNamePattern.test(filename)) {
      // Strict regex match — non-task files (REPORT-*.md, HANDOFF-*.md,
      // hidden dotfiles) are silently dropped. This is the only correct
      // behavior; logging would spam during normal repo activity.
      return;
    }
    const parsed = parseSenderRecipient(filename);
    if (!parsed) {
      // The regex matched but the structural split failed — should never
      // happen if the regex is correct, but defend against custom patterns.
      this._logger.warn(
        `[InboxWatcher] filename matched regex but failed sender/recipient parse: ${filename}`,
      );
      return;
    }

    const event: InboxEvent = {
      kind: "task_added",
      filepath,
      filename,
      sender: parsed.sender,
      recipient: parsed.recipient,
    };

    // P4 Day 4 (TASK-20260511-013): pre-dispatch gating runs in an
    // isolated async chain. We do NOT block subsequent `add` events —
    // chokidar's emit loop can keep firing while one task awaits fcop.
    // Each gated dispatch still goes through the per-handler isolation
    // (one slow listener can't starve another, same as Day 1).
    Promise.resolve()
      .then(async () => {
        const shouldDispatch = await this._gate(event);
        if (!shouldDispatch) return;
        for (const handler of [...this._handlers]) {
          Promise.resolve()
            .then(() => handler(event))
            .catch((err) => {
              this._logger.error(
                `[InboxWatcher] handler threw on ${event.filename}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });
        }
      })
      .catch((err) => {
        // Gate itself should swallow expected failures and return a
        // bool; anything that bubbles is a runtime bug — log loudly so
        // it shows up in operator triage instead of silently dropping
        // the task.
        this._logger.error(
          `[InboxWatcher] gate threw on ${event.filename}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }

  /**
   * P4 Day 4 (TASK-20260511-013 §2.1) pre-dispatch fcop schema gate.
   *
   * Contract:
   *   - No fcopClient wired                → return true (Day 1 behavior).
   *   - fcopClient.inspectTask resolves [] → return true (happy path).
   *   - Has error-severity issues          → policy decides:
   *       · dispatch_anyway → warn + return true (default, Day 2 容错
   *         spirit — let downstream surface schema noise vs swallow
   *         operator drops)
   *       · reject          → warn + return false (drop the event)
   *       · needs_human_review → warn (with explicit prefix so the
   *         v0.5 ack queue can grep) + return false
   *   - inspectTask throws FcopClientError → degrade to dispatch_anyway
   *     + warn (same Day 2 TaskParser FcopClientError→yaml fallback
   *     idiom — fcop bridge being sad must NEVER eat tasks)
   *   - inspectTask throws anything else   → rethrow (lets the outer
   *     `_onAdd` catch log it as a real bug — we don't want a
   *     surprised RuntimeError pretending to be a fcop issue)
   */
  private async _gate(event: InboxEvent): Promise<boolean> {
    try {
      const parsed = await TaskParser.parse(event.filepath);
      const durabilityErrors = validateDurableTaskForDispatch(parsed, {
        expectedSender: event.sender,
        expectedRecipient: event.recipient,
      });
      if (durabilityErrors.length > 0) {
        this._logger.warn(
          `[InboxWatcher] ${event.filename} rejected before dispatch: ` +
            `task file is not durable/complete (${durabilityErrors.join(", ")})`,
        );
        return false;
      }
    } catch (err) {
      this._logger.warn(
        `[InboxWatcher] ${event.filename} rejected before dispatch: ` +
          `task file cannot be read/parsed (${err instanceof Error ? err.message : String(err)})`,
      );
      return false;
    }

    if (this._fcopClient === null) return true;

    let issues: FcopValidationIssue[];
    try {
      issues = await this._fcopClient.inspectTask(event.filename);
    } catch (err) {
      if (err instanceof FcopClientError) {
        // Degraded fcop bridge — never block a task drop on fcop being
        // sad. Day 2 TaskParser path A 改良 says the same.
        this._logger.warn(
          `[InboxWatcher] fcop inspectTask failed for ${event.filename}; ` +
            `degrading to dispatch_anyway. Original error: ${err.message}`,
        );
        return true;
      }
      throw err;
    }

    const errors = issues.filter((i) => i.severity === "error");
    if (errors.length === 0) return true;

    const summary = errors
      .map((i) => `[${i.field}] ${i.message}`)
      .join("; ");

    switch (this._onValidationFail) {
      case "dispatch_anyway":
        this._logger.warn(
          `[InboxWatcher] ${event.filename} has ${errors.length} fcop ` +
            `validation error(s) but onValidationFail="dispatch_anyway" — ` +
            `still dispatching. Errors: ${summary}`,
        );
        return true;
      case "reject":
        this._logger.warn(
          `[InboxWatcher] ${event.filename} rejected ` +
            `(${errors.length} fcop validation error(s), ` +
            `onValidationFail="reject"). Errors: ${summary}`,
        );
        return false;
      case "needs_human_review":
        this._logger.warn(
          `[InboxWatcher][needs_human_review] ${event.filename} blocked on ` +
            `${errors.length} fcop validation error(s); v0.3 has no per-` +
            `watcher review queue yet — v0.5 will pick this up. Errors: ` +
            `${summary}`,
        );
        return false;
    }
  }
}

