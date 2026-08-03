import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  acquireProjectWriteLease,
  acquireProjectWriteLeaseSync,
  projectInitializationLockPath,
  waitForProjectWriteLeasesToDrain,
  withProjectWriteLease,
} from "../ProjectWriteBarrier.ts";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("runtime writer waits while the FCoP initialization lock is held", async () => {
  const root = mkdtempSync(join(tmpdir(), "cfm-project-barrier-"));
  const lock = projectInitializationLockPath(root);
  const output = join(root, "fcop", "reports", "REPORT-CONCURRENT.md");
  try {
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, `${process.pid}\n`, "utf8");
    let entered = false;
    const pending = withProjectWriteLease(root, "report-watcher.dispatch", () => {
      entered = true;
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, "report\n", "utf8");
    });
    await delay(80);
    assert.equal(entered, false);
    assert.equal(existsSync(output), false);

    unlinkSync(lock);
    await pending;
    assert.equal(entered, true);
    assert.equal(existsSync(output), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-process synchronous writer fails fast instead of deadlocking initialization", () => {
  const root = mkdtempSync(join(tmpdir(), "cfm-project-sync-barrier-"));
  const lock = projectInitializationLockPath(root);
  try {
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, `${process.pid}\n`, "utf8");
    assert.throws(
      () => acquireProjectWriteLeaseSync(root, "operation-approval.record"),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as { code?: string }).code === "PROJECT_WRITE_BARRIER_ACTIVE",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("initialization waits for an already-running project writer to drain", async () => {
  const root = mkdtempSync(join(tmpdir(), "cfm-project-drain-"));
  try {
    const lease = await acquireProjectWriteLease(root, "ledger.rebuild");
    let drained = false;
    const pending = waitForProjectWriteLeasesToDrain(root, { timeoutMs: 2_000 })
      .then(() => { drained = true; });
    await delay(80);
    assert.equal(drained, false);
    lease.release();
    await pending;
    assert.equal(drained, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
