/**
 * atomic-write.ts — shared atomic-write-JSON helper for the runtime.
 *
 * Implements `crash-recovery.md` decision 1 (atomic-write + fsync per write)
 * once, so both `JsonFileStore` (Phase A) and `SessionStore` (Phase B) can
 * use the same durability protocol without re-implementing it.
 *
 * Phase A's `JsonFileStore` predated this helper and is left untouched
 * (don't churn working code). Phase B opted into the helper from day one.
 *
 * Protocol:
 *
 *   1. write `${path}.tmp` (full body)
 *   2. fsync the temp file fd
 *   3. atomic `rename(${path}.tmp -> ${path})` with retry-on-EPERM
 *      (POSIX-rename + NTFS-rename are both atomic for same-device renames;
 *      the retry loop handles a Windows-specific race where a concurrent
 *      reader holds the destination open for a few ms — see MT-2 §note below)
 *   4. fsync the parent directory (Linux requires this; harmless on Windows
 *      where `fs.open(<dir>)` rejects, so we skip — the rename itself
 *      flushes NTFS journal metadata)
 *
 * Failure model (callers MUST handle the thrown error and surface as their
 * own error type — this helper is intentionally non-named-error so it can
 * be used by both AgentRegistry-side and Session-side):
 *
 *   - Step 1/2 fails → temp file may exist as a diagnostic; original
 *     `${path}` is untouched. Caller must `unlink(.tmp)` if it cares.
 *   - Step 3 fails → original `${path}` is still untouched (rename is
 *     atomic).
 *   - Step 4 fails → the rename completed; data is durable in the FS
 *     buffer cache and almost-certainly already in the journal. We log
 *     a warning but DO NOT throw — throwing here would suggest the write
 *     rolled back, which it did NOT.
 *
 * MT-2 note (rename retry-on-EPERM, v0.2.0-beta):
 *
 *   On Windows NTFS, `rename(tmp -> dst)` can fail with `EPERM` when
 *   another process has the destination open for read (anti-virus, file
 *   indexers, or — most commonly in our case — a concurrent
 *   `JsonFileStore.load()` racing an `AgentStatusReconciler.reconcile()`
 *   write). POSIX `rename` is atomic AND can clobber an open destination,
 *   but Windows can return `ERROR_ACCESS_DENIED` (mapped to `EPERM` by
 *   libuv) for a few microseconds. Empirically a single 50ms backoff is
 *   enough to clear this; we cap at 3 retries to bound the worst case.
 *   Tests TS-AW-1 / TS-AW-2 in `__tests__/atomic-write.test.ts` exercise
 *   the retry loop with planted EPERM via a `fs.rename` spy.
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Write `body` (a JSON-stringified payload) to `path` atomically.
 *
 * @param path absolute or runtime-relative target path; `path.tmp` is used
 *   as the staging file.
 * @param body the full file body to commit.
 * @throws on any non-fsync-parent failure. Callers wrap into their own
 *   named error class (e.g. `RegistryWriteError`) and decide whether to
 *   `_cleanupTmp`.
 */
export async function atomicWriteJson(
  path: string,
  body: string,
): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });

  const tmpPath = buildUniqueTmpPath(path);

  // Step 1+2: write temp + fsync.
  let tmpHandle: import("node:fs/promises").FileHandle | null = null;
  try {
    tmpHandle = await fs.open(tmpPath, "w");
    await tmpHandle.writeFile(body, "utf-8");
    await tmpHandle.sync();
  } catch (err) {
    await cleanupTmp(tmpPath);
    throw err;
  } finally {
    if (tmpHandle) {
      await tmpHandle.close().catch(() => undefined);
    }
  }

  // Step 3: atomic rename, with retry-on-EPERM / one ENOENT retry.
  try {
    await renameWithRetry(tmpPath, path);
  } catch (err) {
    await cleanupTmp(tmpPath);
    throw err;
  }

  // Step 4: fsync parent dir. Skipped on win32 (NTFS rename flushes journal).
  if (process.platform !== "win32") {
    let dirHandle: import("node:fs/promises").FileHandle | null = null;
    try {
      dirHandle = await fs.open(dirname(path), "r");
      await dirHandle.sync();
    } catch (err) {
      // eslint-disable-next-line no-console -- best-effort warn
      console.warn(
        `[atomic-write] parent dir fsync failed for ${dirname(path)}: ${
          (err as Error).message
        } — write completed but durability across crash is not guaranteed`,
      );
    } finally {
      if (dirHandle) {
        await dirHandle.close().catch(() => undefined);
      }
    }
  }
}

/** Best-effort cleanup of a stale tmp file after a failed write. */
export async function cleanupTmp(tmpPath: string): Promise<void> {
  try {
    await fs.unlink(tmpPath);
  } catch {
    // intentional: keeping the tmp on disk for diagnostics is fine
  }
}

/**
 * Internal: rename `tmp -> dst` with bounded retry.
 *
 * - EPERM (Windows NTFS reader-vs-rename race): retry up to `maxAttempts`.
 * - ENOENT (concurrent tmp removed): retry once before failing.
 */
export async function renameWithRetry(
  tmpPath: string,
  destPath: string,
  opts: { maxAttempts?: number; backoffMs?: number } = {},
): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoffMs = opts.backoffMs ?? 50;

  let lastErr: unknown = null;
  let enoentRetried = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fs.rename(tmpPath, destPath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EPERM" && attempt < maxAttempts) {
        lastErr = err;
        await sleep(backoffMs);
        continue;
      }
      if (code === "ENOENT" && !enoentRetried) {
        enoentRetried = true;
        lastErr = err;
        await sleep(backoffMs);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Unique staging path — avoids concurrent writers clobbering a shared `.tmp`. */
export function buildUniqueTmpPath(targetPath: string): string {
  const stamp = Date.now();
  const rand = randomBytes(4).toString("hex");
  return join(
    dirname(targetPath),
    `${basenameOnly(targetPath)}.${process.pid}.${stamp}.${rand}.tmp`,
  );
}

function basenameOnly(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

const reportWriteLocks = new Map<string, Promise<void>>();

/** Serialize writers per canonical report path (same REPORT, one writer at a time). */
export async function withReportWriteLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = resolve(targetPath);
  const prev = reportWriteLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const tail = prev.then(() => gate);
  reportWriteLocks.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (reportWriteLocks.get(key) === tail) {
      reportWriteLocks.delete(key);
    }
  }
}

function isStaleTmpForReport(name: string, reportBasename: string): boolean {
  if (name === `${reportBasename}.tmp`) return true;
  const prefix = `${reportBasename}.`;
  if (!name.startsWith(prefix) || !name.endsWith(".tmp")) return false;
  const suffix = name.slice(prefix.length, -4);
  const parts = suffix.split(".");
  if (parts.length !== 3) return false;
  const [pid = "", stamp = "", rand = ""] = parts;
  return /^\d+$/.test(pid) && /^\d+$/.test(stamp) && /^[a-f0-9]+$/i.test(rand);
}

/** Remove legacy and unique tmp siblings after a successful rename to `.md`. */
export async function cleanupStaleReportTmpsForTarget(
  targetPath: string,
): Promise<void> {
  const dir = dirname(targetPath);
  const base = basenameOnly(targetPath);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => isStaleTmpForReport(name, base))
      .map((name) => cleanupTmp(join(dir, name))),
  );
}

async function atomicWriteText(path: string, body: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });

  const tmpPath = buildUniqueTmpPath(path);

  let tmpHandle: import("node:fs/promises").FileHandle | null = null;
  try {
    tmpHandle = await fs.open(tmpPath, "w");
    await tmpHandle.writeFile(body, "utf-8");
    await tmpHandle.sync();
  } catch (err) {
    await cleanupTmp(tmpPath);
    throw err;
  } finally {
    if (tmpHandle) {
      await tmpHandle.close().catch(() => undefined);
    }
  }

  try {
    await renameWithRetry(tmpPath, path);
  } catch (err) {
    await cleanupTmp(tmpPath);
    throw err;
  }

  if (process.platform !== "win32") {
    let dirHandle: import("node:fs/promises").FileHandle | null = null;
    try {
      dirHandle = await fs.open(dirname(path), "r");
      await dirHandle.sync();
    } catch (err) {
      // eslint-disable-next-line no-console -- best-effort warn
      console.warn(
        `[atomic-write] parent dir fsync failed for ${dirname(path)}: ${
          (err as Error).message
        } — write completed but durability across crash is not guaranteed`,
      );
    } finally {
      if (dirHandle) {
        await dirHandle.close().catch(() => undefined);
      }
    }
  }
}

export type AtomicWriteFcopResult = "written" | "noop";

/**
 * Atomic FCoP markdown write with per-report lock.
 * When `skipIfExists` is true and the target `.md` already exists, returns `noop`.
 */
export async function atomicWriteFcopMarkdown(
  path: string,
  body: string,
  opts: { skipIfExists?: boolean } = {},
): Promise<AtomicWriteFcopResult> {
  return withReportWriteLock(path, async () => {
    if (opts.skipIfExists) {
      try {
        await fs.access(path);
        return "noop";
      } catch {
        // target missing — proceed
      }
    }
    await atomicWriteText(path, body);
    await cleanupStaleReportTmpsForTarget(path);
    return "written";
  });
}
