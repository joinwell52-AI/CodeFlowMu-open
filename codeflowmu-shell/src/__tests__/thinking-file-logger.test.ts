import assert from "node:assert/strict";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ThinkingFileLogger,
  type ThinkingChannel,
} from "../thinking-file-logger.ts";

test("ThinkingFileLogger writes chat and task to separate dirs", async () => {
  const root = mkdtempSync(join(tmpdir(), "cf-thinking-log-"));
  const logger = new ThinkingFileLogger(root);

  logger.append(
    "chat",
    {
      event_type: "sdk.thinking",
      agent_id: "PM",
      session_id: "sess-chat-1",
      payload: { text: "chat thought" },
    },
    { platform: "cursor", role: "pm", model_id: "composer-2.5-fast" },
  );
  logger.append("task", {
    event_type: "sdk.thinking",
    agent_id: "DEV-01",
    session_id: "sess-task-1",
    payload: { text: "task thought" },
  });

  await new Promise((r) => setImmediate(r));

  const chatDir = join(root, "fcop", "logs", "thinking", "chat");
  const taskDir = join(root, "fcop", "logs", "thinking", "task");
  assert.ok(existsSync(chatDir));
  assert.ok(existsSync(taskDir));

  const byChannel = logger.listByChannel();
  assert.equal(byChannel.chat.length, 1);
  assert.equal(byChannel.task.length, 1);

  const chatLine = readFileSync(byChannel.chat[0]!.path, "utf-8").trim();
  const taskLine = readFileSync(byChannel.task[0]!.path, "utf-8").trim();
  const chatRec = JSON.parse(chatLine) as {
    channel: ThinkingChannel;
    session_id: string;
    platform?: string;
    role?: string;
    model_id?: string;
  };
  const taskRec = JSON.parse(taskLine) as { channel: ThinkingChannel; session_id: string };
  assert.equal(chatRec.channel, "chat");
  assert.equal(chatRec.session_id, "sess-chat-1");
  assert.equal(chatRec.platform, "cursor");
  assert.equal(chatRec.role, "pm");
  assert.equal(chatRec.model_id, "composer-2.5-fast");
  assert.equal(taskRec.channel, "task");
  assert.equal(taskRec.session_id, "sess-task-1");

  rmSync(root, { recursive: true, force: true });
});
