import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  SessionLeaseConflictError,
  SessionLeaseStore,
} from "../SessionLeaseStore.ts";

const key = {
  project_id: "mother",
  agent_id: "DEV-01",
  canonical_root_task_id: "TASK-20260715-006",
};

test("only one process-store instance acquires a live session lease", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codeflowmu-lease-"));
  try {
    const first = new SessionLeaseStore({ dir });
    const second = new SessionLeaseStore({ dir });
    await first.acquire(key, "session-owner");
    await assert.rejects(
      () => second.acquire(key, "session-duplicate"),
      (error: unknown) =>
        error instanceof SessionLeaseConflictError &&
        error.active.owner_session_id === "session-owner",
    );
    await first.release("session-owner");
    const acquired = await second.acquire(key, "session-after-release");
    assert.equal(acquired.owner_session_id, "session-after-release");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("expired lease is recovered after a crashed owner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codeflowmu-lease-stale-"));
  let now = new Date("2026-07-15T00:00:00.000Z");
  try {
    const crashed = new SessionLeaseStore({ dir, ttlMs: 5_000, now: () => now });
    await crashed.acquire(key, "session-crashed");
    now = new Date("2026-07-15T00:00:06.000Z");
    const recovered = new SessionLeaseStore({ dir, ttlMs: 5_000, now: () => now });
    const record = await recovered.acquire(key, "session-recovered");
    assert.equal(record.owner_session_id, "session-recovered");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
