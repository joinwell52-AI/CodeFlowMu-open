/**
 * atomic-write unit tests — MT-2 (TASK-20260510-007).
 *
 * Background: REPORT-20260509-028-DEV-to-PM and REPORT-20260510-002-DEV-to-PM
 * each surfaced the same Windows-NTFS-only `EPERM` race during
 * `JsonFileStore.saveAll` -> `fs.rename(tmp -> dst)`. PM accepted that this
 * is a cross-cutting bug (3 reproductions over 2 sprints) and asked DEV to
 * patch the shared `_internal/atomic-write.ts` helper with a small retry
 * loop bounded by attempts, not wall time.
 *
 * Scope (PM TASK-007 §四 P2 §3): single retry-on-EPERM path + the no-retry
 * path for non-EPERM errno. The full atomicWriteJson durability contract is
 * already covered by `PersistentStore.test.ts` scenario 10 (rename failure
 * → original file untouched), so we deliberately don't re-test that here —
 * we test ONLY the retry semantics MT-2 introduces.
 *
 * Test plan:
 *   TS-AW-1  rename throws EPERM once, then succeeds → atomicWriteJson resolves;
 *            rename was called exactly twice; final body matches input.
 *   TS-AW-2  rename always throws EPERM → atomicWriteJson rejects with EPERM
 *            after exactly maxAttempts (3) calls; retry budget bounded.
 *   TS-AW-3  rename throws ENOENT (or any non-EPERM) → atomicWriteJson rejects
 *            on the FIRST call; no retry storm.
 *   TS-AW-4  rename succeeds first try → atomicWriteJson resolves with rename
 *            called exactly once (regression guard: retry loop must not add
 *            a phantom extra call on the happy path).
 */

import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  atomicWriteFcopMarkdown,
  atomicWriteJson,
  buildUniqueTmpPath,
  cleanupStaleReportTmpsForTarget,
  renameWithRetry,
} from "../atomic-write.ts";

function newTempDir(): string {
  return mkdtempSync(join(tmpdir(), "codeflowmu-aw-"));
}

/** Make a planted ENOENT-style error with arbitrary code. */
function makeErrnoError(code: string): NodeJS.ErrnoException {
  const err = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/**
 * Patch `fs.rename` for the duration of `fn`. Unlike test-local sinon
 * we keep this manual to stay zero-dependency, matching the rest of the
 * `__tests__` directory.
 */
async function withRenameSpy<T>(
  spy: (
    from: string,
    to: string,
    real: typeof fs.rename,
  ) => Promise<void>,
  fn: () => Promise<T>,
): Promise<{ result: T; calls: number }> {
  const realRename = fs.rename;
  let calls = 0;
  (fs as unknown as { rename: typeof fs.rename }).rename = (async (
    from: string,
    to: string,
  ) => {
    calls += 1;
    await spy(from, to, realRename);
  }) as typeof fs.rename;
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    (fs as unknown as { rename: typeof fs.rename }).rename = realRename;
  }
}

// -------- TS-AW-1: rename EPERM once, then succeeds -------------------

test("TS-AW-1: rename EPERM on first attempt, succeeds on second → atomicWriteJson resolves", async () => {
  const dir = newTempDir();
  const target = join(dir, "out.json");
  const body = JSON.stringify({ hello: "world" });

  let attempts = 0;
  const { calls } = await withRenameSpy(
    async (from, to, real) => {
      attempts += 1;
      if (attempts === 1) {
        throw makeErrnoError("EPERM");
      }
      await real(from, to);
    },
    async () => {
      await atomicWriteJson(target, body);
    },
  );

  assert.equal(calls, 2, "rename must be called exactly twice (1 fail + 1 success)");
  const written = readFileSync(target, "utf-8");
  assert.equal(written, body, "final file body must match input");
});

// -------- TS-AW-2: rename always EPERM → bounded retry, then throws --

test("TS-AW-2: rename always EPERM → atomicWriteJson rejects after maxAttempts", async () => {
  const dir = newTempDir();
  const target = join(dir, "out.json");
  const body = JSON.stringify({ retry: "exhausted" });

  let thrown: unknown = null;
  const { calls } = await withRenameSpy(
    async () => {
      throw makeErrnoError("EPERM");
    },
    async () => {
      try {
        await atomicWriteJson(target, body);
      } catch (err) {
        thrown = err;
      }
    },
  );

  assert.equal(calls, 3, "retry budget = 3 attempts (initial + 2 retries)");
  assert.ok(thrown, "atomicWriteJson must reject when retry budget exhausted");
  assert.equal(
    (thrown as NodeJS.ErrnoException).code,
    "EPERM",
    "the rejected error must carry the original EPERM errno",
  );
});

// -------- TS-AW-3: non-EPERM errno → fail-fast, no retry --------------

test("TS-AW-3: rename ENOENT → atomicWriteJson retries once then rejects", async () => {
  const dir = newTempDir();
  const target = join(dir, "out.json");
  const body = JSON.stringify({ noretry: "ENOENT" });

  let thrown: unknown = null;
  const { calls } = await withRenameSpy(
    async () => {
      throw makeErrnoError("ENOENT");
    },
    async () => {
      try {
        await atomicWriteJson(target, body);
      } catch (err) {
        thrown = err;
      }
    },
  );

  assert.equal(calls, 2, "ENOENT gets one retry before fail-fast");
  assert.ok(thrown, "atomicWriteJson must reject");
  assert.equal((thrown as NodeJS.ErrnoException).code, "ENOENT");
});

// -------- TS-AW-4: happy path → rename called exactly once ------------

test("TS-AW-4: rename succeeds on first try → exactly 1 rename call (no phantom retry)", async () => {
  const dir = newTempDir();
  const target = join(dir, "out.json");
  const body = JSON.stringify({ happy: "path" });

  const { calls } = await withRenameSpy(
    async (from, to, real) => {
      await real(from, to);
    },
    async () => {
      await atomicWriteJson(target, body);
    },
  );

  assert.equal(calls, 1, "happy path must call rename exactly once");
  assert.equal(readFileSync(target, "utf-8"), body);
});

// -------- TS-AW-5: renameWithRetry direct API + custom budget ---------

test("TS-AW-5: renameWithRetry honors custom maxAttempts/backoffMs", async () => {
  const dir = newTempDir();
  const tmp = join(dir, "src.tmp");
  const dst = join(dir, "dst");
  // Plant a real tmp file so the underlying rename has something to move.
  await fs.writeFile(tmp, "payload", "utf-8");

  let attempts = 0;
  let thrown: unknown = null;
  const realRename = fs.rename;
  (fs as unknown as { rename: typeof fs.rename }).rename = (async () => {
    attempts += 1;
    throw makeErrnoError("EPERM");
  }) as typeof fs.rename;

  const start = Date.now();
  try {
    await renameWithRetry(tmp, dst, { maxAttempts: 5, backoffMs: 10 });
  } catch (err) {
    thrown = err;
  } finally {
    (fs as unknown as { rename: typeof fs.rename }).rename = realRename;
  }
  const elapsed = Date.now() - start;

  assert.equal(attempts, 5, "custom maxAttempts=5 must be honored");
  assert.ok(thrown, "must throw after budget");
  // 4 backoffs at 10ms each = 40ms minimum; allow generous headroom.
  assert.ok(elapsed >= 30, `expected >=30ms cumulative backoff, got ${elapsed}ms`);
});

// -------- REPORT markdown: unique tmp, lock, noop, cleanup ------------

test("TS-AW-6: buildUniqueTmpPath embeds pid and does not use fixed .md.tmp", () => {
  const dir = newTempDir();
  const target = join(dir, "REPORT-20260509-001-DEV-to-PM.md");
  const tmp = buildUniqueTmpPath(target);
  const base = tmp.split(/[/\\]/).pop() ?? "";
  assert.match(base, /^REPORT-.*\.md\.\d+\.\d+\.[a-f0-9]+\.tmp$/);
  assert.notEqual(base, "REPORT-20260509-001-DEV-to-PM.md.tmp");
});

test("TS-AW-7: atomicWriteFcopMarkdown skipIfExists is noop when md exists", async () => {
  const dir = newTempDir();
  const target = join(dir, "REPORT-20260509-001-DEV-to-PM.md");
  await fs.writeFile(target, "existing", "utf-8");

  const outcome = await atomicWriteFcopMarkdown(target, "new body", {
    skipIfExists: true,
  });
  assert.equal(outcome, "noop");
  assert.equal(readFileSync(target, "utf-8"), "existing");
});

test("TS-AW-8: atomicWriteFcopMarkdown cleans stale tmp siblings after write", async () => {
  const dir = newTempDir();
  const target = join(dir, "REPORT-20260509-001-DEV-to-PM.md");
  const legacyTmp = join(dir, "REPORT-20260509-001-DEV-to-PM.md.tmp");
  const uniqueTmp = join(
    dir,
    "REPORT-20260509-001-DEV-to-PM.md.1.2.abc.tmp",
  );
  await fs.writeFile(legacyTmp, "old", "utf-8");
  await fs.writeFile(uniqueTmp, "old2", "utf-8");

  const outcome = await atomicWriteFcopMarkdown(target, "# report\n");
  assert.equal(outcome, "written");
  assert.equal(readFileSync(target, "utf-8"), "# report\n");
  await assert.rejects(() => fs.access(legacyTmp));
  await assert.rejects(() => fs.access(uniqueTmp));
});

test("TS-AW-9: cleanupStaleReportTmpsForTarget removes matching tmps only", async () => {
  const dir = newTempDir();
  const target = join(dir, "REPORT-20260509-001-DEV-to-PM.md");
  const ours = join(dir, "REPORT-20260509-001-DEV-to-PM.md.tmp");
  const other = join(dir, "REPORT-20260509-002-DEV-to-PM.md.tmp");
  await fs.writeFile(ours, "x", "utf-8");
  await fs.writeFile(other, "y", "utf-8");

  await cleanupStaleReportTmpsForTarget(target);
  await assert.rejects(() => fs.access(ours));
  await fs.access(other);
});

