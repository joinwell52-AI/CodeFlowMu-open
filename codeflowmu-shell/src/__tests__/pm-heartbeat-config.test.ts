import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PM_HEARTBEAT_CONFIG,
  decidePmHeartbeatPolicy,
  normalizePmHeartbeatConfig,
  pmHeartbeatConfigPath,
  readPmHeartbeatConfig,
  writePmHeartbeatConfig,
} from "../pm-heartbeat-config.ts";

describe("pm-heartbeat-config", () => {
  it("returns defaults when config file does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "cf-pmhb-default-"));
    assert.deepEqual(readPmHeartbeatConfig(root), DEFAULT_PM_HEARTBEAT_CONFIG);
  });

  it("normalizes invalid numeric values", () => {
    const cfg = normalizePmHeartbeatConfig({
      normalIntervalMin: 0,
      initialIntervalMin: 2.4,
      initialWindowMin: "x" as unknown as number,
      longTaskIntervalMin: 999,
    });
    assert.equal(cfg.normalIntervalMin, 1);
    assert.equal(cfg.initialIntervalMin, 2);
    assert.equal(cfg.initialWindowMin, DEFAULT_PM_HEARTBEAT_CONFIG.initialWindowMin);
    assert.equal(cfg.longTaskIntervalMin, 120);
  });

  it("writes and reads project config", () => {
    const root = mkdtempSync(join(tmpdir(), "cf-pmhb-write-"));
    const saved = writePmHeartbeatConfig(root, {
      enabled: false,
      normalIntervalMin: 4,
      downstreamNoReceiptNudgeMin: 12,
      onlyReportChanges: false,
    });
    assert.equal(saved.enabled, false);
    assert.equal(saved.normalIntervalMin, 4);
    assert.equal(saved.downstreamNoReceiptNudgeMin, 12);
    assert.equal(saved.onlyReportChanges, false);
    assert.deepEqual(readPmHeartbeatConfig(root), saved);
    const raw = JSON.parse(readFileSync(pmHeartbeatConfigPath(root), "utf8"));
    assert.equal(raw.normalIntervalMin, 4);
  });

  it("uses 2 min interval during the initial dispatch window", () => {
    const now = Date.UTC(2026, 6, 9, 10, 0, 0);
    const decision = decidePmHeartbeatPolicy({
      config: DEFAULT_PM_HEARTBEAT_CONFIG,
      nowMs: now,
      lastRunAtMs: now - 2 * 60_000,
      lastDigest: "",
      activeRootCount: 1,
      lastDispatchAtMs: now - 8 * 60_000,
      oldestRootAtMs: now - 8 * 60_000,
      digest: "a",
    });
    assert.equal(decision.shouldRun, true);
    assert.equal(decision.intervalMin, 2);
    assert.equal(decision.reason, "initial_dispatch_window");
  });

  it("does not run heartbeat while PM is busy", () => {
    const now = Date.UTC(2026, 6, 9, 10, 0, 0);
    const decision = decidePmHeartbeatPolicy({
      config: DEFAULT_PM_HEARTBEAT_CONFIG,
      nowMs: now,
      lastRunAtMs: now - 10 * 60_000,
      lastDigest: "",
      pmBusy: true,
      activeRootCount: 1,
      lastDispatchAtMs: now - 8 * 60_000,
      oldestRootAtMs: now - 8 * 60_000,
      digest: "a",
    });
    assert.equal(decision.shouldRun, false);
    assert.equal(decision.reason, "pm_busy");
  });

  it("uses normal 3 min interval before long task threshold", () => {
    const now = Date.UTC(2026, 6, 9, 10, 0, 0);
    const decision = decidePmHeartbeatPolicy({
      config: DEFAULT_PM_HEARTBEAT_CONFIG,
      nowMs: now,
      lastRunAtMs: now - 3 * 60_000,
      lastDigest: "",
      activeRootCount: 1,
      lastDispatchAtMs: 0,
      oldestRootAtMs: now - 12 * 60_000,
      digest: "a",
    });
    assert.equal(decision.shouldRun, true);
    assert.equal(decision.intervalMin, 3);
    assert.equal(decision.reason, "normal_interval");
  });

  it("uses 5 min interval for changed long tasks", () => {
    const now = Date.UTC(2026, 6, 9, 10, 0, 0);
    const decision = decidePmHeartbeatPolicy({
      config: DEFAULT_PM_HEARTBEAT_CONFIG,
      nowMs: now,
      lastRunAtMs: now - 5 * 60_000,
      lastDigest: "old",
      activeRootCount: 1,
      lastDispatchAtMs: 0,
      oldestRootAtMs: now - 20 * 60_000,
      digest: "new",
    });
    assert.equal(decision.shouldRun, true);
    assert.equal(decision.intervalMin, 5);
    assert.equal(decision.reason, "long_task_changed");
  });

  it("suppresses unchanged long task heartbeat when changes-only is enabled", () => {
    const now = Date.UTC(2026, 6, 9, 10, 0, 0);
    const decision = decidePmHeartbeatPolicy({
      config: DEFAULT_PM_HEARTBEAT_CONFIG,
      nowMs: now,
      lastRunAtMs: now - 5 * 60_000,
      lastDigest: "same",
      activeRootCount: 1,
      lastDispatchAtMs: 0,
      oldestRootAtMs: now - 20 * 60_000,
      digest: "same",
    });
    assert.equal(decision.shouldRun, false);
    assert.equal(decision.intervalMin, 5);
    assert.equal(decision.reason, "state_unchanged");
  });

  it("suppresses unchanged normal patrol state after the first report", () => {
    const now = Date.UTC(2026, 6, 9, 10, 0, 0);
    const decision = decidePmHeartbeatPolicy({
      config: DEFAULT_PM_HEARTBEAT_CONFIG,
      nowMs: now,
      lastRunAtMs: now - 10 * 60_000,
      lastDigest: "same",
      activeRootCount: 1,
      lastDispatchAtMs: 0,
      oldestRootAtMs: now - 5 * 60_000,
      digest: "same",
    });
    assert.equal(decision.shouldRun, false);
    assert.equal(decision.reason, "state_unchanged");
  });
});
