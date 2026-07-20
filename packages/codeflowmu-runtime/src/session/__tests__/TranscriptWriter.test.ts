/**
 * TranscriptWriter unit tests — TASK-20260509-013 §主交付 3 surface.
 *
 * Coverage:
 *   - attach + auto-emit + close → file ends with [session_ended] marker
 *   - append outside of stream (e.g. cancel reason) lands as a separate line
 *   - format: every line is single-line markdown, ISO timestamp prefix,
 *     event_type bracketed
 *   - SDK 8 sdk.* event types all map to a sdk.* `event_type` line
 *   - re-attach on the same runId is idempotent (no double-open)
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { InMemoryRunHandle } from "../../registry/AgentSdkAdapter.ts";
import type { RuntimeEvent, RuntimeEventType } from "../../types/state.ts";
import { __test } from "../TranscriptWriter.ts";
import { withTempSessionDir } from "./helpers.ts";

function planEvent(
  runId: string,
  type: RuntimeEventType,
  payload?: unknown,
): RuntimeEvent {
  return {
    event_id: `${runId}-${type}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    event_type: type,
    session_id: "session-tw-1",
    run_id: runId,
    agent_id: "DEV-01",
    payload,
  };
}

test("TranscriptWriter: attach + auto-emit + close writes session_started/ended markers", async () => {
  await withTempSessionDir(async ({ transcriptWriter, transcriptsDir }) => {
    const events: RuntimeEvent[] = [
      planEvent("run-tw-1", "sdk.assistant", { text: "hello" }),
      planEvent("run-tw-1", "sdk.tool_call", { tool: "read_file" }),
      planEvent("run-tw-1", "sdk.status", { state: "thinking" }),
    ];
    const handle = new InMemoryRunHandle({
      sessionId: "session-tw-1",
      agentId: "DEV-01",
      runId: "run-tw-1",
      emitEvents: events,
    });
    transcriptWriter.attach("run-tw-1", handle);
    await handle.whenSettled();
    // Give the auto-close (.finally on whenSettled) a tick to land.
    await new Promise((r) => setImmediate(r));
    await transcriptWriter.close("run-tw-1").catch(() => undefined);

    const content = await fs.readFile(
      join(transcriptsDir, "run-tw-1.md"),
      "utf-8",
    );
    assert.match(content, /\[session_started\] runId=run-tw-1/);
    assert.match(content, /\[sdk\.assistant\]/);
    assert.match(content, /\[sdk\.tool_call\]/);
    assert.match(content, /\[sdk\.status\]/);
    assert.match(content, /\[session_ended\] runId=run-tw-1/);
  });
});

test("TranscriptWriter: append writes a single-line entry with ISO + kind prefix", async () => {
  await withTempSessionDir(async ({ transcriptWriter, transcriptsDir }) => {
    await transcriptWriter.append("run-append-1", "audit_note", "manual note line");
    await transcriptWriter.close("run-append-1");
    const content = await fs.readFile(
      join(transcriptsDir, "run-append-1.md"),
      "utf-8",
    );
    assert.match(
      content,
      /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[audit_note\] manual note line/,
    );
  });
});

test("TranscriptWriter: append normalizes multi-line text to single line", async () => {
  await withTempSessionDir(async ({ transcriptWriter, transcriptsDir }) => {
    await transcriptWriter.append(
      "run-multi-1",
      "session_cancelled",
      "reason\nspans\nthree lines",
    );
    await transcriptWriter.close("run-multi-1");
    const content = await fs.readFile(
      join(transcriptsDir, "run-multi-1.md"),
      "utf-8",
    );
    // The full body must be one entry per line — the append entry plus
    // the auto session_started + session_ended markers — so 3 newlines.
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 3, `expected 3 lines (start + append + end); got ${lines.length}: ${content}`);
    const appendLine = lines.find((l) => l.includes("[session_cancelled]"))!;
    assert.match(appendLine, /reason spans three lines/);
    assert.ok(!appendLine.includes("\n"), "append line must be single-line");
  });
});

test("TranscriptWriter: re-attach on same runId returns same Unsubscribe (no double-open)", async () => {
  await withTempSessionDir(async ({ transcriptWriter }) => {
    const handle = new InMemoryRunHandle({
      sessionId: "session-tw-2",
      agentId: "DEV-01",
      runId: "run-reattach",
      manualSettle: true,
    });
    const u1 = transcriptWriter.attach("run-reattach", handle);
    const u2 = transcriptWriter.attach("run-reattach", handle);
    assert.equal(u1, u2, "re-attach must be idempotent (same Unsubscribe)");
    // Close BEFORE settling so the auto-close-on-settle path is a no-op.
    // (Closing after settle has a race against the test's tmpdir rm where
    // the auto-close fires its own close() against a deleted file.)
    await transcriptWriter.close("run-reattach");
    handle.settle({ status: "finished" });
    await handle.whenSettled();
    await new Promise((r) => setImmediate(r));
  });
});

test("TranscriptWriter: __test.formatEventLine renders one line per event", () => {
  const event: RuntimeEvent = {
    event_id: "e1",
    at: "2026-05-09T14:30:00.000Z",
    event_type: "sdk.assistant",
    session_id: "session-fmt",
    run_id: "run-fmt",
    agent_id: "DEV-01",
    payload: { text: "  embedded\nnewline\there  " },
  };
  const line = __test.formatEventLine(event);
  assert.equal(line.split("\n").length, 2, "exactly one trailing newline");
  assert.match(line, /\[sdk\.assistant\]/);
  assert.match(line, /\[run-fmt\]/);
  // The payload's embedded \n / \t got squashed into spaces.
  assert.ok(!line.slice(0, line.length - 1).includes("\n"));
});

test("TranscriptWriter: closeAll flushes every attached run", async () => {
  await withTempSessionDir(async ({ transcriptWriter, transcriptsDir }) => {
    const h1 = new InMemoryRunHandle({
      sessionId: "session-multi-1",
      agentId: "DEV-01",
      runId: "run-ca-1",
      manualSettle: true,
    });
    const h2 = new InMemoryRunHandle({
      sessionId: "session-multi-2",
      agentId: "DEV-01",
      runId: "run-ca-2",
      manualSettle: true,
    });
    transcriptWriter.attach("run-ca-1", h1);
    transcriptWriter.attach("run-ca-2", h2);
    await transcriptWriter.closeAll();

    const c1 = await fs.readFile(join(transcriptsDir, "run-ca-1.md"), "utf-8");
    const c2 = await fs.readFile(join(transcriptsDir, "run-ca-2.md"), "utf-8");
    assert.match(c1, /\[session_ended\] runId=run-ca-1/);
    assert.match(c2, /\[session_ended\] runId=run-ca-2/);

    // Settle the manual handles so the test's withTempSessionDir cleanup
    // doesn't trip on dangling promises.
    h1.settle({ status: "finished" });
    h2.settle({ status: "finished" });
  });
});
