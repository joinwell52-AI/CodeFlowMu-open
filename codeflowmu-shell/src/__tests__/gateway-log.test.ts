/**
 * Gateway JSONL log — unit tests
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  appendGatewayLog,
  fcopLogsGatewayPath,
  gatewayLogToLogCenterRow,
  levelToGatewaySource,
  readRecentGatewayLogs,
  redactGatewayText,
} from "../gateway-log.ts";

test("levelToGatewaySource maps levels to source prefixes", () => {
  assert.equal(levelToGatewaySource("info"), "mobile-gateway");
  assert.equal(levelToGatewaySource("slow"), "mobile-gateway:slow");
  assert.equal(levelToGatewaySource("timeout"), "mobile-gateway:timeout");
  assert.equal(levelToGatewaySource("error"), "mobile-gateway:error");
  assert.equal(levelToGatewaySource("info", "pwa"), "pwa");
});

test("redactGatewayText strips secrets and sensitive keys", () => {
  const raw =
    'token=abc123 instance_secret=secret_xyz authorization: Bearer bad cookie=session';
  const out = redactGatewayText(raw);
  assert.equal(out.includes("abc123"), false);
  assert.equal(out.includes("secret_xyz"), false);
  assert.equal(out.includes("Bearer"), false);
  assert.ok(out.includes("***"));
});

test("appendGatewayLog writes JSONL and readRecentGatewayLogs returns rows", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-gw-log-"));
  appendGatewayLog(root, {
    level: "info",
    message: "connected instance_id=pc_1",
    method: "GET",
    path: "/api/v2/mobile/bootstrap",
    status: 200,
    durationMs: 50,
    request_id: "req-1",
  });
  appendGatewayLog(root, {
    level: "slow",
    message: "slow request 900ms",
    method: "POST",
    path: "/api/v2/mobile/chat/send",
    status: 200,
    durationMs: 900,
    request_id: "req-2",
  });

  const filePath = fcopLogsGatewayPath(root);
  const text = readFileSync(filePath, "utf-8");
  assert.equal(text.split("\n").filter(Boolean).length, 2);
  assert.equal(text.includes("instance_secret"), false);

  const rows = readRecentGatewayLogs(root, 100);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.level, "slow");
  assert.equal(rows[0]!.source, "mobile-gateway:slow");

  const lcRow = gatewayLogToLogCenterRow(rows[0]!, 0);
  assert.equal(lcRow.tab, "gateway");
  assert.equal(lcRow.tool_name, "POST");
  assert.equal(lcRow.reason, "req-2");
  assert.equal(
    (lcRow.payload as { gateway_level?: string } | undefined)?.gateway_level,
    "slow",
  );
});

test("readRecentGatewayLogs caps at 300", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-gw-log-cap-"));
  for (let i = 0; i < 5; i += 1) {
    appendGatewayLog(root, { level: "info", message: `line ${i}` });
  }
  const rows = readRecentGatewayLogs(root, 500);
  assert.equal(rows.length, 5);
});
