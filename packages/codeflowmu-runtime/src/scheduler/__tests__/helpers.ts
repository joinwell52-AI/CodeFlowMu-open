/**
 * Test helpers for the Scheduler-layer tests.
 *
 * Mirrors `registry/__tests__/helpers.ts` and `session/__tests__/helpers.ts`:
 *   - All paths live in `os.tmpdir()` (decision-D style)
 *   - `rm` is wrapped in a Windows EBUSY-retry loop (matching the
 *     `withTempStore` retry implementation); chokidar holds inotify/
 *     ReadDirectoryChangesW handles for a few microseconds after `close()`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SchedulerTestCtx {
  /** Root tempdir for the test (auto-cleaned). */
  rootDir: string;
  /** Inbox dir (`<rootDir>/inbox/`). */
  inboxDir: string;
  /** State dir for SessionStore / TranscriptWriter / agents.json. */
  stateDir: string;
}

export async function withTempScheduler<T>(
  fn: (ctx: SchedulerTestCtx) => Promise<T>,
): Promise<T> {
  const rootDir = await mkdtemp(join(tmpdir(), "codeflowmu-scheduler-test-"));
  const inboxDir = join(rootDir, "inbox");
  const stateDir = join(rootDir, "state");
  // Create both upfront — chokidar 4 will tolerate missing dirs but the
  // tests want deterministic existence to avoid first-write races.
  const { mkdir } = await import("node:fs/promises");
  await mkdir(inboxDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  try {
    return await fn({ rootDir, inboxDir, stateDir });
  } finally {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(rootDir, { recursive: true, force: true });
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 30 * (attempt + 1)));
      }
    }
    if (lastErr) {
      // eslint-disable-next-line no-console -- best-effort
      console.warn(
        `[withTempScheduler] failed to rm ${rootDir}: ${
          (lastErr as Error).message
        }`,
      );
    }
  }
}

/** Sleep helper for tests that need to wait for chokidar's debounce. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until `predicate()` returns a truthy value (synchronously OR via a
 * resolved promise) or the timeout elapses. Returns the truthy value
 * (NonNullable). Throws on timeout. Useful for chokidar-async assertions
 * where we want an upper bound on the wait without polluting tests with
 * fixed-`sleep` calls.
 */
export async function waitFor<T>(
  predicate: () =>
    | T
    | undefined
    | null
    | false
    | Promise<T | undefined | null | false>,
  opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<NonNullable<T>> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const v = await predicate();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) {
      throw new Error(
        `waitFor timed out after ${timeoutMs}ms${
          opts.what ? ` (waiting for: ${opts.what})` : ""
        }`,
      );
    }
    await sleep(intervalMs);
  }
}

/** Quiet logger compatible with `TaskDispatcherLogger` / InboxWatcher logger. */
export function quietLogger(): {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  logs: string[];
  warns: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    info: (...args) => logs.push(args.map(String).join(" ")),
    warn: (...args) => warns.push(args.map(String).join(" ")),
    error: (...args) => errors.push(args.map(String).join(" ")),
    logs,
    warns,
    errors,
  };
}

