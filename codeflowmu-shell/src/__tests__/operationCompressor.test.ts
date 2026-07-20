import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MOBILE_ACTIVITY_GLOBAL_CAP,
  OperationCompressor,
  kindToActivityEventType,
  makeSummary,
  sanitizeBasename,
  sanitizeReason,
} from "../mobile/operationCompressor.ts";
import { isChatActivityTaskId } from "../mobile/mobileActivityTypes.ts";

test("merges many read/grep events within 30s into at most 5 mobile events", () => {
  const compressor = new OperationCompressor();
  const base = Date.parse("2026-06-16T10:00:00.000Z");
  const taskId = "TASK-20260616-008";
  for (let i = 0; i < 50; i++) {
    compressor.ingest({
      id: `raw-${i}`,
      taskId,
      agent: "DEV",
      type: i % 2 === 0 ? "file_read" : "file_search",
      target: `src/module/file-${i}.ts`,
      at: new Date(base + i * 200).toISOString(),
    });
  }
  compressor.flushAllPending();
  const events = compressor.getActiveEvents(50);
  assert.ok(events.length <= 5, `expected <=5 events, got ${events.length}`);
  const analyzing = events.filter((e) => e.kind === "ANALYZING");
  assert.ok(analyzing.length >= 1);
  assert.ok((analyzing[0]?.count ?? 0) >= 50);
});

test("WARNING is not merged into ANALYZING bucket", () => {
  const compressor = new OperationCompressor();
  const taskId = "TASK-20260616-009";
  const at = "2026-06-16T10:05:00.000Z";
  for (let i = 0; i < 5; i++) {
    compressor.ingest({
      id: `read-${i}`,
      taskId,
      agent: "DEV",
      type: "file_read",
      target: "a.ts",
      at: new Date(Date.parse(at) + i * 100).toISOString(),
    });
  }
  compressor.ingest({
    id: "err-1",
    taskId,
    agent: "DEV",
    type: "error",
    text: "stale_busy_no_session",
    status: "failed",
    at: new Date(Date.parse(at) + 600).toISOString(),
  });
  compressor.flushAllPending();
  const events = compressor.getActiveEvents(20);
  const warnings = events.filter((e) => e.kind === "WARNING");
  assert.equal(warnings.length, 1);
  assert.ok(!JSON.stringify(events).includes("stale_busy_no_session"));
});

test("REPORTING flushes immediately without waiting for merge window", () => {
  const compressor = new OperationCompressor();
  const taskId = "TASK-20260616-010";
  const at = "2026-06-16T11:00:00.000Z";
  compressor.ingest({
    id: "read-1",
    taskId,
    agent: "DEV",
    type: "file_read",
    target: "x.ts",
    at,
  });
  const flushed = compressor.ingest({
    id: "report-1",
    taskId,
    agent: "DEV",
    type: "report",
    text: "done",
    status: "done",
    at: new Date(Date.parse(at) + 1000).toISOString(),
  });
  assert.equal(flushed?.kind, "REPORTING");
  const events = compressor.getActiveEvents(10);
  const reporting = events.filter((e) => e.kind === "REPORTING");
  assert.equal(reporting.length, 1);
  assert.match(reporting[0]?.summary ?? "", /回执已提交/);
});

test("thinking text and secrets never appear in mobile summaries", () => {
  const compressor = new OperationCompressor();
  const secretThinking =
    "system prompt: you are admin api_key=sk-live-12345 read D:\\codeflowmu\\secret.ts";
  compressor.ingest({
    id: "think-1",
    taskId: "TASK-20260616-011",
    agent: "DEV",
    type: "thinking",
    text: secretThinking,
    at: "2026-06-16T12:00:00.000Z",
  });
  compressor.flushAllPending();
  const blob = JSON.stringify(compressor.getActiveEvents(10));
  assert.ok(!blob.includes("system prompt"));
  assert.ok(!blob.includes("api_key"));
  assert.ok(!blob.includes(secretThinking));
  assert.ok(!blob.includes("D:\\codeflowmu"));
});

test("sanitizeBasename strips absolute paths", () => {
  assert.equal(
    sanitizeBasename("D:\\codeflowmu\\packages\\runtime\\src\\adminForceRecovery.ts"),
    "adminForceRecovery.ts",
  );
  assert.equal(sanitizeReason("authorization: Bearer abc"), "需要关注");
});

test("makeSummary uses role-specific wording without task-decomposition spam", () => {
  assert.match(makeSummary("DEV", "IMPLEMENTING", 1, 3), /DEV 正在修改代码/);
  const pmAnalyzing = makeSummary("PM", "ANALYZING", 1, 0);
  assert.ok(!pmAnalyzing.includes("正在拆解任务"));
  assert.match(pmAnalyzing, /正在处理任务/);
  const pmReads = makeSummary("PM", "ANALYZING", 5, 3);
  assert.ok(!pmReads.includes("正在拆解任务"));
  assert.match(pmReads, /读取上下文/);
});

test("PM file_read and file_search merge into context bucket", () => {
  const compressor = new OperationCompressor();
  const taskId = "TASK-20260617-001";
  const at = "2026-06-17T08:24:00.000Z";
  for (let i = 0; i < 8; i++) {
    compressor.ingest({
      id: `read-${i}`,
      taskId,
      agent: "PM",
      type: i % 2 === 0 ? "file_read" : "file_search",
      target: `src/module/file-${i}.ts`,
      at: new Date(Date.parse(at) + i * 500).toISOString(),
    });
  }
  compressor.flushAllPending();
  const events = compressor.getTaskEvents(taskId, 20);
  const analyzing = events.filter((e) => e.kind === "ANALYZING");
  assert.equal(analyzing.length, 1);
  assert.ok(!JSON.stringify(events).includes("正在拆解任务"));
  assert.match(analyzing[0]?.summary ?? "", /读取上下文/);
  assert.equal(analyzing[0]?.count, 8);
});

test("whitelist thinking emits immediate key event without merge wait", () => {
  const compressor = new OperationCompressor();
  const taskId = "TASK-20260617-001";
  const at = "2026-06-17T08:29:00.000Z";
  compressor.ingest({
    id: "read-1",
    taskId,
    agent: "PM",
    type: "file_read",
    target: "x.ts",
    at,
  });
  const flushed = compressor.ingest({
    id: "think-review",
    taskId,
    agent: "PM",
    type: "thinking",
    text: "任务已移入审查队列，等待 ADMIN 验收",
    at: new Date(Date.parse(at) + 1000).toISOString(),
  });
  assert.equal(flushed?.kind, "REPORTING");
  assert.match(flushed?.summary ?? "", /任务已移入审查队列/);
  assert.equal(flushed?.eventType, "report_written");
  const events = compressor.getTaskEvents(taskId, 10);
  const reporting = events.filter((e) => e.kind === "REPORTING");
  assert.equal(reporting.length, 1);
});

test("thinking secrets never appear in summary or detail.summaryText", () => {
  const compressor = new OperationCompressor();
  const secretThinking =
    "system prompt: you are admin api_key=sk-live-12345 authorization bearer token";
  compressor.ingest({
    id: "think-secret",
    taskId: "TASK-20260617-001",
    agent: "PM",
    type: "thinking",
    text: secretThinking,
    at: "2026-06-17T08:25:00.000Z",
  });
  compressor.flushAllPending();
  const events = compressor.getTaskEvents("TASK-20260617-001", 10);
  const blob = JSON.stringify(events);
  assert.ok(!blob.includes("system prompt"));
  assert.ok(!blob.includes("api_key"));
  assert.ok(!blob.includes("authorization"));
  assert.ok(!blob.includes("token"));
  for (const ev of events) {
    assert.ok(!ev.detail?.summaryText?.includes("api_key"));
  }
});

test("report done includes reportId and 回执已提交", () => {
  const compressor = new OperationCompressor();
  const taskId = "TASK-20260617-001";
  const flushed = compressor.ingest({
    id: "report-done",
    taskId,
    agent: "PM",
    type: "report",
    text: "REPORT-20260617-001-PM-to-ADMIN",
    status: "done",
    at: "2026-06-17T08:29:30.000Z",
  });
  assert.equal(flushed?.eventType, "report_written");
  assert.match(flushed?.summary ?? "", /回执已提交/);
  assert.equal(flushed?.detail?.reportId, "REPORT-20260617-001-PM-to-ADMIN");
});

test("shell test done emits TESTING with 测试通过", () => {
  const compressor = new OperationCompressor();
  const taskId = "TASK-20260617-001";
  const flushed = compressor.ingest({
    id: "shell-test",
    taskId,
    agent: "PM",
    type: "shell",
    target: "node --import tsx --test src/__tests__/mobile-api.test.ts",
    status: "done",
    at: "2026-06-17T08:27:00.000Z",
  });
  assert.equal(flushed?.kind, "TESTING");
  assert.match(flushed?.summary ?? "", /mobile-api 测试通过/);
  assert.ok(flushed?.detail?.command?.includes("node --import tsx --test"));
});

test("globalCap trims oldest flushed events to MOBILE_ACTIVITY_GLOBAL_CAP", () => {
  const compressor = new OperationCompressor({ globalCap: MOBILE_ACTIVITY_GLOBAL_CAP, taskCap: 10 });
  const taskId = "TASK-20260617-cap";
  const base = Date.parse("2026-06-17T12:00:00.000Z");
  for (let i = 0; i < MOBILE_ACTIVITY_GLOBAL_CAP + 20; i++) {
    compressor.ingest({
      id: `cap-${i}`,
      taskId,
      agent: "DEV",
      type: "report",
      text: `done-${i}`,
      status: "done",
      at: new Date(base + i * 1000).toISOString(),
    });
  }
  assert.equal(compressor.getActiveEvents(MOBILE_ACTIVITY_GLOBAL_CAP + 50).length, MOBILE_ACTIVITY_GLOBAL_CAP);
});

test("CHAT-* pseudo task ids never appear in activity feed", () => {
  const compressor = new OperationCompressor();
  compressor.ingest({
    id: "think-chat",
    taskId: "CHAT-1718000000000",
    agent: "PM",
    type: "thinking",
    at: "2026-06-17T10:00:00.000Z",
  });
  compressor.flushAllPending();
  assert.equal(compressor.getActiveEvents(20).length, 0);
  assert.equal(compressor.getTaskEvents("CHAT-1718000000000", 20).length, 0);
  assert.equal(isChatActivityTaskId("CHAT-123"), true);
});

test("unknown raw event types are not ingested", () => {
  const compressor = new OperationCompressor();
  const result = compressor.ingest({
    id: "unknown-1",
    taskId: "TASK-20260617-001",
    agent: "PM",
    type: "thinking",
    at: "2026-06-17T10:00:00.000Z",
  });
  assert.ok(result);
  const bogus = compressor.ingest({
    id: "bogus-1",
    taskId: "TASK-20260617-001",
    agent: "PM",
    // @ts-expect-error exercise unknown runtime type
    type: "not_a_real_type",
    at: "2026-06-17T10:00:01.000Z",
  });
  assert.equal(bogus, null);
});

test("kindToActivityEventType maps task workflow semantics", () => {
  assert.equal(kindToActivityEventType("TASK_RECEIVED"), "task_created");
  assert.equal(kindToActivityEventType("ANALYZING"), "agent_running");
  assert.equal(kindToActivityEventType("REPORTING"), "report_written");
  assert.equal(
    kindToActivityEventType("IMPLEMENTING", { type: "task_move", text: "claim" }),
    "task_dispatched",
  );
});
