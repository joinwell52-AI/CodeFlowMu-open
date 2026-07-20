import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { DoorbellBuffer } from "../doorbell-buffer.ts";
import { queryLogCenter } from "../log-center.ts";

const require = createRequire(import.meta.url);
const core = require("../../../codeflowmu-desktop/panel/log-center-core.js") as {
  aggregateFailures(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>>;
  calculateStats(rows: Array<Record<string, unknown>>, options?: Record<string, unknown>): Record<string, number>;
  filterRowsByRange(rows: Array<Record<string, unknown>>, range: string, now: number, timeZone?: string): Array<Record<string, unknown>>;
  isToday(row: Record<string, unknown>, now: number, timeZone?: string): boolean;
  normalizeLocalAlert(entry: Record<string, unknown>, index: number, options?: Record<string, unknown>): Record<string, unknown>;
  toLocalAlertRecord(level: string, agent: string, message: string, context: Record<string, unknown>, now: number, options?: Record<string, unknown>): Record<string, unknown>;
};

const HOUR = 60 * 60 * 1000;

test("log center local alert writes stable Unix milliseconds and full ISO offset", () => {
  const ts = Date.parse("2026-07-17T02:19:00.000Z");
  const record = core.toLocalAlertRecord(
    "ERROR",
    "PM-01",
    "policy blocked",
    {
      event_type: "sdk.error",
      session_id: "sess-1",
      call_id: "call-1",
      error_code: "CODEFLOWMU_POLICY_BLOCKED",
    },
    ts,
    { offsetMinutes: 480 },
  );

  assert.equal(record.ts, ts);
  assert.equal(record.at, "2026-07-17T10:19:00.000+08:00");
  assert.equal(record.session_id, "sess-1");
  assert.equal(record.call_id, "call-1");
  assert.equal("date" in record, false);
});

test("legacy local time recovers date when possible and never substitutes Date.now", () => {
  const recovered = core.normalizeLocalAlert(
    { date: "2026/7/16", ts: "23:30:00", level: "ERROR", agent: "DEV-01", msg: "old" },
    0,
    { offsetMinutes: 480 },
  );
  assert.equal(recovered.ts, Date.parse("2026-07-16T15:30:00.000Z"));
  assert.equal(recovered.at, "2026-07-16T23:30:00.000+08:00");
  assert.equal(recovered.legacy_time_unknown, false);

  const unknown = core.normalizeLocalAlert(
    { ts: "23:30:00", level: "WARN", agent: "DEV-01", msg: "date missing" },
    1,
    { offsetMinutes: 480 },
  );
  assert.equal(unknown.ts, undefined);
  assert.equal(unknown.legacy_time_unknown, true);
});

test("time filters apply equally to local rows and exclude legacy unknown times", () => {
  const now = Date.parse("2026-07-17T12:00:00.000Z");
  const rows = [
    { id: "recent", ts: now - 5 * HOUR },
    { id: "old", ts: now - 7 * HOUR },
    { id: "unknown", legacy_time_unknown: true },
  ];

  assert.deepEqual(core.filterRowsByRange(rows, "6", now).map((row) => row.id), ["recent"]);
  assert.deepEqual(core.filterRowsByRange(rows, "0", now).map((row) => row.id), ["recent", "old", "unknown"]);
});

test("UTC event is assigned to today using Asia/Shanghai rather than Cursor time", () => {
  const event = { ts: Date.parse("2026-07-16T16:30:00.000Z") };
  const now = Date.parse("2026-07-17T03:00:00.000Z");
  assert.equal(core.isToday(event, now, "Asia/Shanghai"), true);
  assert.equal(core.isToday(event, now, "UTC"), false);
});

test("startup statistics start at current Shell process time while today spans earlier events", () => {
  const now = Date.parse("2026-07-17T12:00:00.000Z");
  const processStartTs = now - 618_000;
  const rows = [
    { ts: now - 500_000, level: "WARN", event_type: "sdk.status" },
    { ts: now - 2 * HOUR, level: "ERROR", event_type: "sdk.error", session_id: "old-session" },
  ];
  const stats = core.calculateStats(rows, { now, processStartTs, timeZone: "Asia/Shanghai" });
  assert.equal(stats.todayEvents, 2);
  assert.equal(stats.startupEvents, 1);
  assert.equal(stats.rawEvents, 2);
});

test("same session and call failure chain folds once and preserves three raw events", () => {
  const base = Date.parse("2026-07-17T02:19:00.000Z");
  const common = {
    level: "ERROR",
    session_id: "sess-1",
    call_id: "call-1",
    status: "failed",
    normalized_error_code: "CODEFLOWMU_POLICY_BLOCKED",
  };
  const rows = [
    { ...common, ts: base, event_type: "sdk.status", message: "failed" },
    { ...common, ts: base + 10, event_type: "sdk.error", message: "tool failed" },
    { ...common, ts: base + 20, event_type: "codeflowmu.failure", message: "terminal summary" },
  ];
  const grouped = core.aggregateFailures(rows);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]?.raw_event_count, 3);
  assert.equal((grouped[0]?.raw_events as unknown[]).length, 3);
  const stats = core.calculateStats(rows, { now: base + 1000 });
  assert.equal(stats.independentFaults, 1);
  assert.equal(stats.rawEvents, 3);
});

test("same error in different sessions remains two independent faults", () => {
  const base = Date.parse("2026-07-17T02:19:00.000Z");
  const rows = ["sess-1", "sess-2"].map((session_id, index) => ({
    ts: base + index,
    level: "ERROR",
    session_id,
    call_id: "call-1",
    status: "failed",
    normalized_error_code: "CODEFLOWMU_POLICY_BLOCKED",
    event_type: "sdk.error",
  }));
  assert.equal(core.aggregateFailures(rows).length, 2);
});

test("missing call id uses session, agent, code and a short time window", () => {
  const base = Date.parse("2026-07-17T02:19:00.000Z");
  const make = (ts: number, session_id = "sess-1") => ({
    ts,
    level: "ERROR",
    session_id,
    agent_id: "DEV-01",
    status: "failed",
    normalized_error_code: "SDK_TIMEOUT",
    event_type: "sdk.error",
  });
  const grouped = core.aggregateFailures([
    make(base),
    make(base + 10_000),
    make(base + 45_000),
    make(base + 5_000, "sess-2"),
  ]);
  assert.equal(grouped.length, 3);
});

test("log-center API reads are deterministic and expose stable fault fields", () => {
  const doorbell = new DoorbellBuffer();
  doorbell.push("codeflowmu.failure", {
    agent_id: "DEV-01",
    session_id: "sess-1",
    call_id: "call-1",
    status: "failed",
    failure_code: "SDK_TIMEOUT",
    message: "timeout",
  });

  const first = queryLogCenter(doorbell, null, { tab: "alerts", limit: 20 });
  const second = queryLogCenter(doorbell, null, { tab: "alerts", limit: 20 });
  assert.equal(first.total, 1);
  assert.equal(second.total, 1);
  assert.equal(first.rows[0]?.call_id, "call-1");
  assert.equal(first.rows[0]?.normalized_error_code, "SDK_TIMEOUT");
});
