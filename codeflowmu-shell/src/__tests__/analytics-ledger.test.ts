import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AnalyticsLedger,
  extractModelsFromPayload,
} from "../analytics-ledger.ts";

function flushWrites(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

test("AnalyticsLedger resolves platform, role, model from agent meta", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-analytics-"));
  const ledger = new AnalyticsLedger(root, () => "google");

  ledger.noteAgentRecord("PM-01", "pm", "gemini-2.5-pro");
  const dims = ledger.resolveDimensions({ agent_id: "PM-01" });

  assert.equal(dims.platform, "google");
  assert.equal(dims.role, "pm");
  assert.equal(dims.model_id, "gemini-2.5-pro");

  rmSync(root, { recursive: true, force: true });
});

test("AnalyticsLedger appendFromRuntimeEvent writes enriched jsonl", async () => {
  const root = mkdtempSync(join(tmpdir(), "cf-analytics-"));
  const ledger = new AnalyticsLedger(root, () => "cursor");

  ledger.noteAgentRecord("DEV-01", "developer", "composer-2.5-fast");

  ledger.appendFromRuntimeEvent(
    {
      event_type: "runtime.session_started",
      agent_id: "DEV-01",
      session_id: "sess-1",
      payload: { task_id: "TASK-001", thread_key: "thread-a" },
    },
    { channel: "task" },
  );

  ledger.appendFromRuntimeEvent(
    {
      event_type: "sdk.result",
      agent_id: "DEV-01",
      session_id: "sess-1",
      payload: {
        raw: { modelUsage: { "claude-sonnet-4": { inputTokens: 10 } } },
      },
    },
    { channel: "task" },
  );

  await flushWrites();

  const dir = join(root, "fcop", "logs", "analytics");
  assert.ok(existsSync(dir));
  assert.ok(existsSync(join(dir, "README.md")));

  const jsonlFiles = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  assert.ok(jsonlFiles.length >= 1);

  const content = readFileSync(join(dir, jsonlFiles[0]!), "utf-8").trim();
  const lines = content.split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(lines.length, 2);

  const started = lines[0]!;
  assert.equal(started["event_type"], "runtime.session_started");
  assert.equal(started["platform"], "cursor");
  assert.equal(started["role"], "developer");
  assert.equal(started["agent_id"], "DEV-01");
  assert.equal(started["channel"], "task");

  const result = lines[1]!;
  assert.equal(result["event_type"], "sdk.result");
  assert.equal(result["model_id"], "claude-sonnet-4");
  assert.deepEqual(result["models_used"], ["claude-sonnet-4"]);

  const filtered = ledger.query({ role: "developer", limit: 10 });
  assert.ok(filtered.length >= 2);

  const summary = ledger.summarize(0);
  assert.ok(summary.total >= 2);
  assert.ok(summary.by_role["developer"]! >= 2);
  assert.ok(summary.by_platform["cursor"]! >= 2);

  rmSync(root, { recursive: true, force: true });
});

test("extractModelsFromPayload reads modelUsage from raw or top-level", () => {
  assert.deepEqual(
    extractModelsFromPayload({
      raw: { modelUsage: { "gpt-4": {}, "gpt-4-mini": {} } },
    }),
    ["gpt-4", "gpt-4-mini"],
  );
  assert.deepEqual(
    extractModelsFromPayload({ modelUsage: { composer: {} } }),
    ["composer"],
  );
  assert.deepEqual(extractModelsFromPayload({}), []);
});

test("AnalyticsLedger shouldRecord filters event types", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-analytics-"));
  const ledger = new AnalyticsLedger(root);

  assert.equal(ledger.shouldRecord("sdk.result"), true);
  assert.equal(ledger.shouldRecord("random.event"), false);

  rmSync(root, { recursive: true, force: true });
});
