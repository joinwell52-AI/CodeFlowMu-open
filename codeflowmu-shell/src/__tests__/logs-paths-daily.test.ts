import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  fcopChatLegacyMonolithPath,
  fcopChatPathForDate,
  listChatReadPaths,
} from "../chat-paths.ts";
import {
  fcopLogsRuntimeEventsLegacyMonolithPath,
  fcopLogsRuntimeEventsPath,
  listRuntimeEventsReadPaths,
  logsDateKey,
} from "../logs-paths.ts";
import { RuntimeEventFileLogger } from "../runtime-event-logger.ts";

test("fcopLogsRuntimeEventsPath uses daily filename", () => {
  const root = "/proj";
  const key = "20260601";
  assert.equal(
    fcopLogsRuntimeEventsPath(root, key),
    join(root, "fcop", "logs", "runtime", "runtime-events-20260601.jsonl"),
  );
});

test("RuntimeEventFileLogger writes daily and tailRecent merges legacy monolith", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-runtime-daily-"));
  try {
    const runtimeDir = join(root, "fcop", "logs", "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    const legacy = fcopLogsRuntimeEventsLegacyMonolithPath(root);
    appendFileSync(
      legacy,
      JSON.stringify({
        ts: 1000,
        at: "2020-01-01T00:00:00.000Z",
        event_type: "wake_agent.requested",
        task_id: "TASK-OLD",
        payload: { task_id: "TASK-OLD" },
      }) + "\n",
      "utf-8",
    );

    const logger = new RuntimeEventFileLogger(root);
    logger.append("wake_agent.accepted", { task_id: "TASK-NEW", agent_id: "PM" });

    const todayPath = fcopLogsRuntimeEventsPath(root, logsDateKey());
    assert.ok(existsSync(todayPath));
    assert.ok(logger.filePath.endsWith(`runtime-events-${logsDateKey()}.jsonl`));

    const tail = logger.tailRecent(50);
    assert.equal(tail.length, 2);
    assert.equal(tail[0]!.task_id, "TASK-OLD");
    assert.equal(tail[1]!.task_id, "TASK-NEW");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listRuntimeEventsReadPaths orders daily newest first then legacy", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-runtime-list-"));
  try {
    const runtimeDir = join(root, "fcop", "logs", "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    appendFileSync(join(runtimeDir, "runtime-events-20260101.jsonl"), "", "utf-8");
    appendFileSync(join(runtimeDir, "runtime-events-20260102.jsonl"), "", "utf-8");
    appendFileSync(fcopLogsRuntimeEventsLegacyMonolithPath(root), "", "utf-8");

    const paths = listRuntimeEventsReadPaths(root);
    assert.deepEqual(
      paths.map((p) => p.split(/[/\\]/).pop()),
      ["runtime-events-20260102.jsonl", "runtime-events-20260101.jsonl", "runtime-events.jsonl"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("chat daily path and listChatReadPaths compat legacy", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-chat-daily-"));
  try {
    const chatDir = join(root, "fcop", "chat");
    mkdirSync(chatDir, { recursive: true });
    const legacy = fcopChatLegacyMonolithPath(root);
    appendFileSync(legacy, '{"id":"1","ts":"2020-01-01T00:00:00.000Z"}\n', "utf-8");
    const daily = fcopChatPathForDate(root, "20260601");
    appendFileSync(daily, '{"id":"2","ts":"2026-06-01T12:00:00.000Z"}\n', "utf-8");

    const paths = listChatReadPaths(root);
    assert.equal(paths.length, 2);
    assert.ok(paths[0]!.includes("chat-20260601.jsonl"));
    assert.ok(paths[1]!.includes("chat.jsonl"));

    appendFileSync(fcopChatPathForDate(root), '{"id":"3","ts":"today"}\n', "utf-8");
    assert.ok(existsSync(fcopChatPathForDate(root)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
