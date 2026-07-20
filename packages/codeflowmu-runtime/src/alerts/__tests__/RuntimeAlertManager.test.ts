import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { RuntimeAlertManager } from "../RuntimeAlertManager.ts";

describe("RuntimeAlertManager", () => {
  it("keeps expected policy blocks out of the failure banner and deduplicates them", () => {
    const manager = new RuntimeAlertManager();
    manager.ingestFromEvent({
      agent_id: "PM-01",
      failure_type: "tool_error",
      message: "CODEFLOWMU_POLICY_BLOCKED: Current role must dispatch implementation work through FCoP task files",
    });
    manager.ingestFromEvent({
      agent_id: "PM-01",
      failure_type: "session_failed",
      message: "[策略边界拦截] CODEFLOWMU_POLICY_BLOCKED",
    });

    const snapshot = manager.getSnapshot();
    assert.equal(snapshot.banner, null);
    assert.equal(snapshot.overall_status, "ok");
    assert.equal(snapshot.active.length, 1);
    assert.equal(snapshot.active[0]?.code, "POLICY_BLOCKED");
    assert.equal(snapshot.active[0]?.severity, "P3");
    assert.equal(snapshot.active[0]?.count, 2);
  });

  it("acknowledges one or all alerts without retaining them as active", () => {
    const manager = new RuntimeAlertManager();
    const first = manager.ingest({ code: "ONE", message: "one", severity: "P1" });
    manager.ingest({ code: "TWO", message: "two", severity: "P2" });
    assert.equal(manager.resolve(first.alert_key), true);
    assert.equal(manager.getSnapshot().active.length, 1);
    assert.equal(manager.resolveAll(), 1);
    assert.equal(manager.getSnapshot().active.length, 0);
    assert.equal(manager.getSnapshot().overall_status, "ok");
  });

  let mgr: RuntimeAlertManager;

  beforeEach(() => {
    mgr = new RuntimeAlertManager();
    mgr.resetForTests();
  });

  it("aggregates duplicate alert_key by incrementing count", () => {
    mgr.ingest({
      code: "SDK_RATE_LIMIT",
      category: "sdk_network",
      severity: "P0",
      message: "NGHTTP2_ENHANCE_YOUR_CALM",
      title: "SDK 限流",
      status: "cooldown",
    });
    mgr.ingest({
      code: "SDK_RATE_LIMIT",
      category: "sdk_network",
      severity: "P0",
      message: "NGHTTP2_ENHANCE_YOUR_CALM again",
      title: "SDK 限流",
      status: "cooldown",
    });
    const snap = mgr.getSnapshot();
    const row = snap.active.find((a) => a.code === "SDK_RATE_LIMIT");
    assert.equal(row?.count, 2);
  });

  it("classifies NGHTTP2 as P0 sdk_network", () => {
    mgr.ingestFromEvent({
      message: "NGHTTP2_ENHANCE_YOUR_CALM",
      failure_type: "transient_sdk_error",
    });
    const snap = mgr.getSnapshot();
    assert.equal(snap.overall_status, "critical");
    assert.equal(snap.active[0]?.code, "SDK_RATE_LIMIT");
    assert.equal(snap.active[0]?.category, "sdk_network");
  });

  it("wake throttled is P2 and not eligible for P0 toast", () => {
    mgr.ingestFromEvent({
      message: "wake_agent.skipped throttled",
      failure_type: "wake_throttled",
    });
    const row = mgr.getSnapshot().active[0];
    assert.equal(row?.severity, "P2");
    assert.equal(row?.code, "WAKE_THROTTLED");
    assert.ok(row);
    assert.equal(mgr.shouldShowP0Toast(row), false);
  });

  it("P0 toast only once per alert_key within TTL", () => {
    const row = mgr.ingest({
      code: "SQLITE_CONSTRAINT",
      category: "concurrency_lock",
      severity: "P0",
      message: "UNIQUE constraint failed",
      status: "active",
    });
    assert.equal(mgr.shouldShowP0Toast(row), true);
    assert.equal(mgr.shouldShowP0Toast(row), false);
  });

  it("setSdkCooldown and clearSdkCooldown update banner state", () => {
    const until = Date.now() + 60_000;
    mgr.setSdkCooldown(until, "rate limited");
    let snap = mgr.getSnapshot();
    assert.equal(snap.cooldown.active, true);
    assert.equal(snap.banner?.code, "SDK_RATE_LIMIT");
    mgr.clearSdkCooldown();
    snap = mgr.getSnapshot();
    assert.equal(snap.cooldown.active, false);
  });

  it("aggregates repeated wake throttled into WAKE_THROTTLED_STORM", () => {
    mgr.ingestFromEvent({
      message: "wake_agent.skipped throttled",
      failure_type: "wake_throttled",
    });
    mgr.ingestFromEvent({
      message: "pm.wake.skipped throttled again",
      failure_type: "wake_throttled",
    });
    const snap = mgr.getSnapshot();
    const storm = snap.active.find((a) => a.code === "WAKE_THROTTLED_STORM");
    assert.ok(storm, "second throttled wake should aggregate");
    assert.match(storm!.message, /聚合/);
  });

  it("waiting_report maps to REPORT_GATE_WAIT not REPORT_MISSING", () => {
    mgr.ingestFromEvent({
      event_type: "codeflowmu.report_gate.waiting_report",
      message: "waiting REPORT for TASK-20260531-003-PM-to-QA",
      task_id: "TASK-20260531-003-PM-to-QA",
    });
    const snap = mgr.getSnapshot();
    assert.ok(snap.active.some((a) => a.code === "REPORT_GATE_WAIT"));
    assert.equal(
      snap.active.filter((a) => a.code === "REPORT_MISSING").length,
      0,
    );
    const row = snap.active.find((a) => a.code === "REPORT_GATE_WAIT");
    assert.equal(row?.severity, "P3");
  });

  it("ingestFromEvent preserves Google governance codes from payload.sdk_error_code", () => {
    for (const code of [
      "AUTHORITY_DENIED",
      "MODEL_NOT_FOUND",
      "FUNCTION_RESPONSE_MISALIGNED",
    ] as const) {
      mgr.resetForTests();
      mgr.ingestFromEvent({
        event_type: "codeflowmu.failure",
        message: "session ended with failure",
        payload: { sdk_error_code: code, sdk_error_message: `${code} detail` },
      });
      const row = mgr.getSnapshot().active.find((a) => a.code === code);
      assert.ok(row, `expected ${code} alert`);
      assert.match(row!.message, /session ended|detail/i);
    }
  });

  it("classifyFromText maps Google governance tokens in message", () => {
    mgr.ingestFromEvent({
      message: "AUTHORITY_DENIED: PM attempted write_task",
      failure_type: "session_failed",
    });
    assert.equal(mgr.getSnapshot().active[0]?.code, "AUTHORITY_DENIED");
  });
});
