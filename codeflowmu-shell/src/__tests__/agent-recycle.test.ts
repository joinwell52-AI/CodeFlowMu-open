import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  shouldAutoRecycleAgent,
  sessionsSinceLastRecycle,
  parseEnvBool,
  mergeAgentRecycleConfig,
  DEFAULT_AGENT_RECYCLE_CONFIG,
  getAgentSessionStats,
} from "../agent-recycle.ts";

describe("agent-recycle", () => {
  it("parseEnvBool", () => {
    assert.equal(parseEnvBool("1"), true);
    assert.equal(parseEnvBool("false"), false);
    assert.equal(parseEnvBool(undefined), undefined);
  });

  it("sessionsSinceLastRecycle", () => {
    assert.equal(sessionsSinceLastRecycle(12, undefined), 12);
    assert.equal(
      sessionsSinceLastRecycle(12, { recycled_at: "x", sessions_at_recycle: 10 }),
      2,
    );
  });

  it("shouldAutoRecycle when idle and threshold met", () => {
    const ok = shouldAutoRecycleAgent({
      enabled: true,
      sessionsToday: 10,
      threshold: 10,
      agentStatus: "idle",
      hasRunningSession: false,
      currentTask: null,
    });
    assert.equal(ok.should, true);
  });

  it("shouldAutoRecycle rejects when running session", () => {
    const r = shouldAutoRecycleAgent({
      enabled: true,
      sessionsToday: 15,
      threshold: 10,
      agentStatus: "idle",
      hasRunningSession: true,
    });
    assert.equal(r.should, false);
    assert.equal(r.reason, "running_session_active");
  });

  it("shouldAutoRecycle rejects when agent status running", () => {
    const r = shouldAutoRecycleAgent({
      enabled: true,
      sessionsToday: 15,
      threshold: 10,
      agentStatus: "running",
      hasRunningSession: false,
    });
    assert.equal(r.should, false);
    assert.equal(r.reason, "agent_status_running");
  });

  it("shouldAutoRecycle rejects when current_task set", () => {
    const r = shouldAutoRecycleAgent({
      enabled: true,
      sessionsToday: 15,
      threshold: 10,
      agentStatus: "idle",
      hasRunningSession: false,
      currentTask: "TASK-20260525-001-PM-to-DEV",
    });
    assert.equal(r.should, false);
    assert.equal(r.reason, "current_task_set");
  });

  it("shouldAutoRecycle requires sessions since last recycle", () => {
    const r = shouldAutoRecycleAgent({
      enabled: true,
      sessionsToday: 12,
      threshold: 10,
      agentStatus: "idle",
      hasRunningSession: false,
      lastRecycle: { recycled_at: "t", sessions_at_recycle: 10 },
    });
    assert.equal(r.should, false);
    assert.equal(r.reason, "below_session_threshold");
  });

  it("shouldAutoRecycle after another 10 sessions since recycle", () => {
    const r = shouldAutoRecycleAgent({
      enabled: true,
      sessionsToday: 20,
      threshold: 10,
      agentStatus: "idle",
      hasRunningSession: false,
      lastRecycle: { recycled_at: "t", sessions_at_recycle: 10 },
    });
    assert.equal(r.should, true);
  });

  it("disabled by default in merge", () => {
    const c = mergeAgentRecycleConfig(DEFAULT_AGENT_RECYCLE_CONFIG, {});
    assert.equal(c.enabled, false);
  });

  it("getAgentSessionStats merges chat and task thinking logs", () => {
    const root = mkdtempSync(join(tmpdir(), "cf-recycle-stats-"));
    const day = "20260601";
    const thinkingRoot = join(root, "fcop", "logs", "thinking");
    mkdirSync(join(thinkingRoot, "chat"), { recursive: true });
    mkdirSync(join(thinkingRoot, "task"), { recursive: true });
    writeFileSync(
      join(thinkingRoot, "chat", `thinking-${day}.jsonl`),
      JSON.stringify({ agent_id: "DEV-01", session_id: "s-chat-1" }) + "\n",
      "utf8",
    );
    writeFileSync(
      join(thinkingRoot, "task", `thinking-${day}.jsonl`),
      [
        JSON.stringify({ agent_id: "DEV-01", session_id: "s-task-1" }),
        JSON.stringify({ agent_id: "DEV-01", session_id: "s-task-2" }),
        JSON.stringify({ agent_id: "PM-01", session_id: "s-task-3" }),
      ].join("\n") + "\n",
      "utf8",
    );
    const stats = getAgentSessionStats(root, day);
    assert.equal(stats["DEV-01"], 3);
    assert.equal(stats["PM-01"], 1);
  });

  it("getAgentSessionStats also counts runtime session_started events", () => {
    const root = mkdtempSync(join(tmpdir(), "cf-recycle-runtime-stats-"));
    const day = "20260601";
    const runtimeRoot = join(root, "fcop", "logs", "runtime");
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(
      join(runtimeRoot, `runtime-events-${day}.jsonl`),
      [
        JSON.stringify({
          ts: Date.parse("2026-06-01T00:00:01.000Z"),
          at: "2026-06-01T00:00:01.000Z",
          event_type: "runtime.session_started",
          agent_id: "PM-01",
          session_id: "s-runtime-1",
          payload: {},
        }),
        JSON.stringify({
          ts: Date.parse("2026-06-01T00:00:02.000Z"),
          at: "2026-06-01T00:00:02.000Z",
          event_type: "runtime.session_started",
          payload: { agent_id: "DEV-01", session_id: "s-runtime-2" },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    const stats = getAgentSessionStats(root, day);
    assert.equal(stats["PM-01"], 1);
    assert.equal(stats["DEV-01"], 1);
  });
});
