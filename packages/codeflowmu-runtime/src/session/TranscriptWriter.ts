/**
 * TranscriptWriter — append-only event-stream writer for sessions.
 *
 * Implements `crash-recovery.md` decision 4 right-half ("事件流 markdown
 * append-only"): one `<run_id>.md` file per Run, every observed event
 * (8 sdk.* + 4 runtime.* — see `RuntimeEventType` decision M) is
 * append-rendered as one markdown line. Append-only intentionally:
 *
 *   - Atomic-write is unnecessary because partial writes lose only the
 *     in-flight event; the next runtime boot recovers the rest from SDK.
 *   - High frequency (TS-4.3 target = 1000 events/s) makes write-tmp +
 *     rename + fsync per event unaffordable.
 *
 * Design notes (TASK-20260509-013 §主交付 3):
 *
 *   - `attach(runId, handle)` subscribes to the handle's `onEvent` and
 *     returns an `Unsubscribe`. The writer keeps one `WriteStream` per
 *     run open (lazily) and closes it via `close(runId)` or when the
 *     attached handle settles (whichever fires first).
 *   - `append(runId, kind, text)` is the manual ingress used by
 *     `SessionManager.cancelSession` to write the cancel reason without
 *     going through an SDK event.
 *   - `close(runId)` flushes + drains the stream and writes a final
 *     `[ISO] [session_ended]` marker. Idempotent.
 *
 * Performance contract (TS-4.3): `createWriteStream({ flags: "a" })` is
 * used to keep one fd open per run; Node's stream layer handles buffer
 * coalescence so 1000 events/s is comfortable on commodity SSDs without
 * losing data on graceful shutdown. We intentionally do NOT call `fsync`
 * per event — append-only data is allowed to lose the trailing window
 * on `kill -9`, by design (decision 4).
 */

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";

import type { RunHandle, RuntimeEvent, Unsubscribe } from "../types/state.ts";

/** Categorical label for `append` entries written outside the SDK stream. */
export type TranscriptEntryKind =
  | "session_started"
  | "session_ended"
  | "session_cancelled"
  | "audit_note"
  | "warning";

/** Construction options for `TranscriptWriter`. */
export interface TranscriptWriterOptions {
  /**
   * Directory holding `<run_id>.md` files. Default
   * `.codeflowmu/state/transcripts/`.
   *
   * REQUIRED — same configurability discipline as SessionStore.dir.
   */
  dir: string;
}

/**
 * Per-run state held by the writer. One entry per attached run; cleared
 * on `close(runId)`.
 */
interface RunState {
  stream: WriteStream;
  unsubscribe: Unsubscribe;
  closed: boolean;
}

export class TranscriptWriter {
  private readonly _dir: string;
  private readonly _runs = new Map<string, RunState>();
  /**
   * In-flight `close(runId)` promises. Concurrent close calls (e.g. the
   * explicit one from `cancelSession` racing the auto-close-on-settle
   * triggered inside `attach`) all resolve when the same underlying
   * `stream.end()` completes — without this, the second caller would
   * see `state.closed === true` and return synchronously, while the
   * first caller's `stream.end()` was still flushing in the background.
   * That race surfaced as a "generated async activity after test ended"
   * failure on Windows in early Phase B testing.
   */
  private readonly _closing = new Map<string, Promise<void>>();
  private _dirEnsured = false;

  constructor(opts: TranscriptWriterOptions) {
    this._dir = opts.dir;
  }

  /** Resolved directory the writer writes under. */
  get dir(): string {
    return this._dir;
  }

  /**
   * Attach to a `RunHandle` and start writing every emitted event.
   *
   * Multiple `attach` calls on the same `runId` are idempotent — second
   * call returns the same `Unsubscribe` and does NOT re-open the file.
   * (Phase B cancel path appends an explicit `cancel_reason` after attach,
   * we don't want a 2nd `attach` to double-open the fd.)
   *
   * @returns an `Unsubscribe` that detaches the listener but does NOT
   *   close the file — `close(runId)` is the explicit lifecycle method.
   */
  attach(runId: string, handle: RunHandle): Unsubscribe {
    const existing = this._runs.get(runId);
    if (existing && !existing.closed) {
      return existing.unsubscribe;
    }

    const stream = this._openStream(runId);
    const unsubscribe = handle.onEvent((event) => {
      this._writeEvent(stream, event);
    });
    const state: RunState = { stream, unsubscribe, closed: false };
    this._runs.set(runId, state);

    // Auto-close on settle so callers don't have to thread the close()
    // through every error path.
    handle
      .whenSettled()
      .catch(() => undefined)
      .finally(() => {
        // Best-effort: only close if no one closed it manually first.
        if (!state.closed) {
          this.close(runId).catch(() => undefined);
        }
      });

    return unsubscribe;
  }

  /**
   * Manually append a single line to a run's transcript. Used by
   * `SessionManager.cancelSession` to record the cancel reason.
   *
   * If `runId` is not currently attached, the file is opened on demand;
   * this lets cancellation work even if the session was attached and
   * closed before cancel was issued (rare but legal).
   */
  async append(
    runId: string,
    kind: TranscriptEntryKind,
    text: string,
  ): Promise<void> {
    const stream = this._ensureStream(runId);
    const at = new Date().toISOString();
    const line = `[${at}] [${kind}] ${oneLineify(text)}\n`;
    await new Promise<void>((resolve, reject) => {
      stream.write(line, (err) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * Flush + close the stream for `runId`. Writes a final
   * `[ISO] [session_ended]` marker (decision 4 line 9). Idempotent —
   * concurrent callers receive the same in-flight promise.
   */
  async close(runId: string): Promise<void> {
    const inflight = this._closing.get(runId);
    if (inflight) return inflight;
    const state = this._runs.get(runId);
    if (!state || state.closed) return;
    state.closed = true;
    state.unsubscribe();

    const promise = this._performClose(runId, state);
    this._closing.set(runId, promise);
    return promise;
  }

  private async _performClose(runId: string, state: RunState): Promise<void> {
    try {
      const at = new Date().toISOString();
      const footer = `[${at}] [session_ended] runId=${runId}\n`;
      await new Promise<void>((resolve) => {
        state.stream.write(footer, () => resolve());
      });
      await new Promise<void>((resolve) => {
        state.stream.end(() => resolve());
      });
    } finally {
      this._runs.delete(runId);
      this._closing.delete(runId);
    }
  }

  /**
   * Force-close every attached run. Used at runtime shutdown; tests use
   * it for cleanup. Idempotent — closes that error are swallowed (caller
   * is shutting down anyway).
   */
  async closeAll(): Promise<void> {
    const ids = [...this._runs.keys()];
    await Promise.allSettled(ids.map((id) => this.close(id)));
  }

  private _ensureStream(runId: string): WriteStream {
    const existing = this._runs.get(runId);
    if (existing && !existing.closed) return existing.stream;
    const stream = this._openStream(runId);
    this._runs.set(runId, {
      stream,
      unsubscribe: () => undefined,
      closed: false,
    });
    return stream;
  }

  private _openStream(runId: string): WriteStream {
    if (!this._dirEnsured) {
      // Synchronous mkdir is intentional: `attach` is a sync method
      // (`createWriteStream` is itself sync), and switching to async would
      // force the whole surface to be async — which would force every
      // `SessionManager` callsite to be async. Sync once-per-writer-init
      // is the standard idiom here.
      mkdirSync(this._dir, { recursive: true });
      this._dirEnsured = true;
    }
    const path = join(this._dir, `${runId}.md`);
    const stream = createWriteStream(path, { flags: "a", encoding: "utf-8" });
    // Write a header marker on first open. Same `flags: "a"` semantics
    // so re-attaching a run (e.g. crash + recover in Phase C) appends a
    // fresh header instead of clobbering.
    const at = new Date().toISOString();
    stream.write(`[${at}] [session_started] runId=${runId}\n`);
    return stream;
  }

  private _writeEvent(stream: WriteStream, event: RuntimeEvent): void {
    // Synchronous best-effort write; per stream contract any backpressure
    // is applied at the OS layer. We don't await — TS-4.3 target needs
    // ~1000 events/s through here, which means awaiting per-event would
    // kill throughput.
    const line = formatEventLine(event);
    stream.write(line);
  }
}

/**
 * Strip newlines + control characters so a single `RuntimeEvent` always
 * lands on a single transcript line. Called by both `append` and
 * `_writeEvent` so the resulting `.md` is always greppable.
 */
function oneLineify(s: string): string {
  return s.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Standard one-line markdown rendering of a `RuntimeEvent`. Format:
 *
 *   `[ISO] [event_type] [run_id] payload_summary`
 */
function formatEventLine(event: RuntimeEvent): string {
  const summary = summarizePayload(event.payload);
  return `[${event.at}] [${event.event_type}] [${event.run_id ?? "-"}] ${summary}\n`;
}

function summarizePayload(payload: unknown): string {
  if (payload === undefined || payload === null) return "(no payload)";
  if (typeof payload === "string") return oneLineify(payload);
  try {
    const json = JSON.stringify(payload);
    if (json.length <= 400) return oneLineify(json);
    return oneLineify(json.slice(0, 400)) + ` … (+${json.length - 400} chars)`;
  } catch {
    return "[unserializable]";
  }
}

// Test hook — re-export for tests that want to make assertions on
// the format. Internal API; not part of the package's public surface.
export const __test = { oneLineify, formatEventLine, summarizePayload };

