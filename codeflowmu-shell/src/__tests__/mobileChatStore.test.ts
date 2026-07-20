import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  MOBILE_CHAT_DEFAULT_LIMIT,
  MOBILE_CHAT_DISK_CAP,
  MOBILE_CHAT_MAX_LIMIT,
  MobileChatStore,
} from "../mobile/mobileChatStore.ts";

test("MobileChatStore trims messages.jsonl to MOBILE_CHAT_DISK_CAP", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cf-mobile-chat-cap-"));
  const store = new MobileChatStore(dataDir);
  const filePath = join(dataDir, "mobile-chat", "messages.jsonl");

  for (let i = 0; i < MOBILE_CHAT_DISK_CAP + 25; i++) {
    store.appendUserMessage(`msg-${i}`);
  }

  const diskLines = readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((line) => line.trim());
  assert.equal(diskLines.length, MOBILE_CHAT_DISK_CAP);

  const last = JSON.parse(diskLines[diskLines.length - 1]!) as { content: string };
  assert.equal(last.content, `msg-${MOBILE_CHAT_DISK_CAP + 24}`);

  const first = JSON.parse(diskLines[0]!) as { content: string };
  assert.equal(first.content, `msg-25`);
});

test("MobileChatStore listMessages respects default and max limits", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cf-mobile-chat-limit-"));
  const store = new MobileChatStore(dataDir);

  for (let i = 0; i < 150; i++) {
    store.appendUserMessage(`line-${i}`);
  }

  assert.equal(store.listMessages().length, MOBILE_CHAT_DEFAULT_LIMIT);
  assert.equal(store.listMessages(MOBILE_CHAT_MAX_LIMIT).length, 150);
  assert.equal(store.listMessages(999).length, 150);
});

test("MobileChatStore preserves attachments when trimming disk", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cf-mobile-chat-attach-"));
  const store = new MobileChatStore(dataDir);

  for (let i = 0; i < MOBILE_CHAT_DISK_CAP; i++) {
    store.appendUserMessage(`fill-${i}`);
  }

  store.appendUserMessage("with attachment", [
    {
      type: "image",
      url: "/api/v2/mobile/files/attachment?path=foo.png",
      local_path: "foo.png",
      mime: "image/png",
      original_name: "foo.png",
      size: 42,
    },
  ]);

  const listed = store.listMessages(1);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.content, "with attachment");
  assert.ok(Array.isArray(listed[0]?.attachments));
  assert.equal(listed[0]?.attachments?.[0]?.original_name, "foo.png");
});
