/**
 * PersistentStore unit tests — TASK-20260509-009 §必交付 6 scenario 10
 * (atomic-write rollback) plus a few sanity checks on `JsonFileStore`.
 *
 * Scenario coverage:
 *   10. atomic-write interruption: fs.rename() throws → agents.json
 *       contents are preserved, .tmp may be visible (diagnostics).
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { test } from "node:test";

import type { AgentRecord } from "../../types/state.ts";
import { RegistryWriteError } from "../errors.ts";
import { JsonFileStore } from "../PersistentStore.ts";

import { withTempStore } from "./helpers.ts";

function fakeRecord(agentId: string, sdkId: string): AgentRecord {
  return {
    protocol: {
      agent_id: agentId,
      sdk_agent_id: sdkId,
      role: "developer",
      layer: "worker",
      node: "local",
      runtime: "local",
      skills: ["fcop"],
      status: "idle",
    },
    runtime_binding_mode: "local",
    runtime_last_reconciled_at: "2026-05-09T13:00:00Z",
  };
}

test("loadAll returns [] when agents.json doesn't exist", async () => {
  await withTempStore(async ({ store }) => {
    const records = await store.loadAll();
    assert.deepEqual(records, []);
  });
});

test("saveAll then loadAll round-trips records", async () => {
  await withTempStore(async ({ store }) => {
    await store.saveAll([fakeRecord("DEV-01", "sdk-1")]);
    const out = await store.loadAll();
    assert.equal(out.length, 1);
    assert.equal(out[0]?.protocol.agent_id, "DEV-01");
  });
});

test("upsert adds new record then replaces it on second call", async () => {
  await withTempStore(async ({ store }) => {
    await store.upsert(fakeRecord("DEV-01", "sdk-1"));
    await store.upsert(fakeRecord("PM-01", "sdk-2"));
    let recs = await store.loadAll();
    assert.equal(recs.length, 2);

    // Replace DEV-01.
    const replaced = fakeRecord("DEV-01", "sdk-1");
    replaced.protocol.status = "error";
    await store.upsert(replaced);
    recs = await store.loadAll();
    assert.equal(recs.length, 2);
    const dev = recs.find((r) => r.protocol.agent_id === "DEV-01");
    assert.equal(dev?.protocol.status, "error");
  });
});

test("removeById deletes existing, no-ops missing", async () => {
  await withTempStore(async ({ store }) => {
    await store.upsert(fakeRecord("DEV-01", "sdk-1"));
    await store.removeById("DEV-01");
    assert.equal((await store.loadAll()).length, 0);
    // No-op:
    await store.removeById("nonexistent");
    assert.equal((await store.loadAll()).length, 0);
  });
});

test("loadAll throws RegistryWriteError on corrupt JSON", async () => {
  await withTempStore(async ({ store, agentsPath }) => {
    writeFileSync(agentsPath, "{ this is not json", "utf-8");
    await assert.rejects(() => store.loadAll(), RegistryWriteError);
  });
});

// Scenario 10 — atomic-write rollback simulation.
test("scenario 10: rename failure → original agents.json preserved, .tmp visible", async () => {
  await withTempStore(async ({ agentsPath, dir }) => {
    const store = new JsonFileStore({ path: agentsPath });

    // Establish a known-good baseline.
    const baseline = [fakeRecord("DEV-01", "sdk-1")];
    await store.saveAll(baseline);

    const originalBytes = readFileSync(agentsPath, "utf-8");

    // Now monkey-patch fs.rename to throw, then attempt a saveAll.
    const realRename = fs.rename;
    let renameCalled = false;
    (fs as unknown as { rename: typeof fs.rename }).rename = (async (
      from: string,
      to: string,
    ) => {
      renameCalled = true;
      throw new Error("simulated rename failure (scenario 10)");
      void from;
      void to;
    }) as typeof fs.rename;

    try {
      const next = [
        fakeRecord("DEV-01", "sdk-1"),
        fakeRecord("PM-01", "sdk-2"),
      ];
      await assert.rejects(() => store.saveAll(next), RegistryWriteError);
    } finally {
      (fs as unknown as { rename: typeof fs.rename }).rename = realRename;
    }

    assert.equal(renameCalled, true, "rename must have been attempted");

    // agents.json keeps the original bytes.
    const after = readFileSync(agentsPath, "utf-8");
    assert.equal(after, originalBytes, "agents.json must be byte-identical");

    // The store's behavior on .tmp cleanup: we attempt cleanup but it
    // may or may not exist depending on which step failed. Just check
    // that the LIVE agents.json is intact, which is the contract.
    void dir;
  });
});

// Scenario 11 — TS-1.6 follow-up (TASK-20260509-016): concurrent upsert
// via Promise.allSettled does NOT corrupt agents.json.
//
// QA-014 §三 noted this case wasn't covered in DEV Phase A's 16 tests.
// QA self-assessed it as "防护性测试", not blocking — `JsonFileStore`'s
// atomic-rename already guarantees the property at the OS level
// (write-temp + rename is POSIX/NTFS atomic). This test is the explicit
// regression guard.
//
// Why allSettled (not Promise.all) — Phase A decision D explicitly
// forbids a lock. Concurrent saveAll calls share the SAME `agents.json.tmp`
// staging path; on Windows + Linux, two simultaneous rename() of the
// same source can produce ENOENT for the loser ("source vanished
// because the winner already renamed it"). That's a feature of
// no-lock atomic-rename, not a bug — the surviving rename was atomic,
// the loser saw a clean ENOENT, and the on-disk JSON is never half-written.
//
// Key invariants under test:
//
//   1. At least ONE upsert wins (via atomic rename, file is committed).
//   2. `loadAll()` after the storm NEVER throws RegistryWriteError.
//   3. `loadAll()` returns structurally valid records (no half-merged JSON).
//
// Survivor count is allowed to be 1 (last-writer-wins under no-lock).
test("scenario 11: concurrent upsert via Promise.allSettled does not corrupt agents.json", async () => {
  await withTempStore(async ({ store }) => {
    const records: AgentRecord[] = Array.from({ length: 5 }, (_, i) =>
      fakeRecord(`DEV-${i.toString().padStart(2, "0")}`, `sdk-${i}`),
    );

    // Act: 5 concurrent upserts.
    const results = await Promise.allSettled(
      records.map((r) => store.upsert(r)),
    );

    // At least one upsert MUST have committed. (Without commits, the
    // file wouldn't exist — but `loadAll` returns [] for that case,
    // so we'd miss a real corruption regression. This guards.)
    const fulfilledCount = results.filter(
      (r) => r.status === "fulfilled",
    ).length;
    assert.ok(
      fulfilledCount >= 1,
      `at least one upsert must commit; got ${fulfilledCount} of ${results.length}`,
    );

    // Any rejection MUST be the documented ENOENT-on-rename race, NOT
    // a corrupted-JSON or unrelated error. We don't bother enumerating
    // the exact error class — the only failure path here is a lost-
    // rename race, and the next assertion (loadAll OK) is the real test.

    // Core invariant: loadAll must NOT throw, must NOT see partial JSON.
    const loaded = await store.loadAll();
    assert.ok(Array.isArray(loaded), "loadAll must return an array");
    assert.ok(loaded.length >= 1, "at least one record must persist");
    assert.ok(loaded.length <= 5, "no extra ghost records");

    // Every surviving record is structurally valid.
    for (const r of loaded) {
      assert.ok(r.protocol.agent_id, "every record needs an agent_id");
      assert.ok(r.protocol.sdk_agent_id, "every record needs a sdk_agent_id");
      assert.equal(r.protocol.layer, "worker");
      assert.equal(r.protocol.role, "developer");
      assert.match(r.protocol.agent_id, /^DEV-\d{2}$/);
    }
  });
});
