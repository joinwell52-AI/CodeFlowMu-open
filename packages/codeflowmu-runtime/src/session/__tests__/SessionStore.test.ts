/**
 * SessionStore unit tests — TASK-20260509-013 §主交付 2 + QA TS-4.x mapping.
 *
 * Coverage:
 *   - sanity: save → load round-trips
 *   - load returns null on absent (NOT throws)
 *   - listAll returns [] on missing dir
 *   - listAll skips .tmp / non-.json / unparseable files (tolerant read)
 *   - remove is idempotent
 *   - save uses atomic-rename (no half-written file)
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { Session } from "@codeflowmu/protocol";

import { RegistryWriteError } from "../../registry/errors.ts";
import type { SessionRecord } from "../../types/state.ts";
import { withTempSessionDir } from "./helpers.ts";

function makeRecord(
  overrides: Partial<Session> = {},
  runtimeOverrides: Partial<Omit<SessionRecord, "protocol">> = {},
): SessionRecord {
  return {
    protocol: {
      session_id: "session-test-001",
      agent_id: "DEV-01",
      task_id: "TASK-20260509-x",
      started_at: "2026-05-09T14:00:00.000Z",
      status: "running",
      runs: [
        {
          run_id: "run-test-001",
          started_at: "2026-05-09T14:00:00.000Z",
          status: "running",
          tool_calls_count: 0,
        },
      ],
      ...overrides,
    },
    ...runtimeOverrides,
  };
}

test("SessionStore: save → load round-trips", async () => {
  await withTempSessionDir(async ({ sessionStore }) => {
    const record = makeRecord();
    await sessionStore.save(record);
    const loaded = await sessionStore.load("session-test-001");
    assert.ok(loaded, "load must return the saved record");
    assert.equal(loaded!.protocol.session_id, "session-test-001");
    assert.equal(loaded!.protocol.agent_id, "DEV-01");
    assert.equal(loaded!.protocol.runs.length, 1);
  });
});

test("SessionStore: load returns null on absent (does NOT throw)", async () => {
  await withTempSessionDir(async ({ sessionStore }) => {
    const loaded = await sessionStore.load("session-never-saved");
    assert.equal(loaded, null);
  });
});

test("SessionStore: listAll returns [] on missing directory", async () => {
  await withTempSessionDir(async ({ sessionStore }) => {
    // Don't save anything → dir hasn't been created yet
    const all = await sessionStore.listAll();
    assert.deepEqual(all, []);
  });
});

test("SessionStore: listAll returns multiple records", async () => {
  await withTempSessionDir(async ({ sessionStore }) => {
    await sessionStore.save(makeRecord({ session_id: "session-a-1" }));
    await sessionStore.save(makeRecord({ session_id: "session-a-2" }));
    await sessionStore.save(makeRecord({ session_id: "session-a-3" }));
    const all = await sessionStore.listAll();
    assert.equal(all.length, 3);
    const ids = all.map((r) => r.protocol.session_id).sort();
    assert.deepEqual(ids, ["session-a-1", "session-a-2", "session-a-3"]);
  });
});

test("SessionStore: listAll skips .tmp + non-.json + corrupt files (tolerant)", async () => {
  await withTempSessionDir(async ({ sessionStore, sessionsDir }) => {
    await sessionStore.save(makeRecord({ session_id: "session-good-1" }));

    // Plant a sibling .tmp and a non-json + a corrupt .json. listAll must
    // skip all three and still return the good record.
    await fs.writeFile(join(sessionsDir, "leftover.json.tmp"), "stale", "utf-8");
    await fs.writeFile(join(sessionsDir, "README.md"), "operator note", "utf-8");
    await fs.writeFile(
      join(sessionsDir, "corrupt-session.json"),
      "{ not valid json,, ",
      "utf-8",
    );

    const all = await sessionStore.listAll();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.protocol.session_id, "session-good-1");
  });
});

test("SessionStore: remove is idempotent + load(null) afterwards", async () => {
  await withTempSessionDir(async ({ sessionStore }) => {
    await sessionStore.save(makeRecord({ session_id: "session-z" }));
    await sessionStore.remove("session-z");
    assert.equal(await sessionStore.load("session-z"), null);
    // second remove = no-op (does NOT throw).
    await sessionStore.remove("session-z");
    await sessionStore.remove("session-never-existed");
  });
});

test("SessionStore: corrupt JSON read throws RegistryWriteError (not silent null)", async () => {
  await withTempSessionDir(async ({ sessionStore, sessionsDir }) => {
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      join(sessionsDir, "session-bad.json"),
      "{ broken },",
      "utf-8",
    );
    await assert.rejects(
      () => sessionStore.load("session-bad"),
      RegistryWriteError,
    );
  });
});

test("SessionStore: save uses atomic-rename (no half-written file)", async () => {
  await withTempSessionDir(async ({ sessionStore, sessionsDir }) => {
    await sessionStore.save(makeRecord({ session_id: "session-atomic-1" }));
    const entries = await fs.readdir(sessionsDir);
    // The .tmp staging file MUST NOT survive a successful save.
    const tmpLeftover = entries.find((n) => n.endsWith(".tmp"));
    assert.equal(
      tmpLeftover,
      undefined,
      `no *.tmp should remain after a successful save; saw: ${tmpLeftover}`,
    );
    // The canonical file MUST exist as valid JSON.
    const path = join(sessionsDir, "session-atomic-1.json");
    const body = await fs.readFile(path, "utf-8");
    const parsed = JSON.parse(body) as SessionRecord;
    assert.equal(parsed.protocol.session_id, "session-atomic-1");
  });
});

