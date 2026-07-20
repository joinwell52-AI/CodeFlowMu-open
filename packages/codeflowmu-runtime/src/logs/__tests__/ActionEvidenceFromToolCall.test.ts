import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  maybeRecordActionEvidenceFromToolCall,
  resetActionEvidenceToolCallDedupeForTests,
} from "../ActionEvidenceFromToolCall.ts";
import { readActionEvidenceLines } from "../ActionEvidenceLogger.ts";
import { resetActionEventIdCounterForTests } from "../ActionEvidenceLogger.ts";
describe("ActionEvidenceFromToolCall", () => {
  beforeEach(() => {
    resetActionEvidenceToolCallDedupeForTests();
    resetActionEventIdCounterForTests();
  });
  afterEach(() => {
    resetActionEvidenceToolCallDedupeForTests();
    resetActionEventIdCounterForTests();
  });

  it("records file.read for completed read_file tool_call", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-act-tc-"));
    try {
      maybeRecordActionEvidenceFromToolCall({
        projectRoot: root,
        agent_id: "DEV",
        session_id: "sess-dev-1",
        task_id: "TASK-20260607-001",
        payload: {
          tool: "read_file",
          status: "completed",
          call_id: "call-1",
          raw: {
            args: { path: join(root, "src", "foo.ts") },
          },
        },
      });
      const records = readActionEvidenceLines(root);
      assert.equal(records.length, 1);
      assert.equal(records[0]!.event_type, "file.read");
      assert.equal(records[0]!.path, "src/foo.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips write_report tool_call", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-act-tc-"));
    try {
      maybeRecordActionEvidenceFromToolCall({
        projectRoot: root,
        agent_id: "DEV",
        session_id: "sess-dev-2",
        payload: {
          tool: "write_report",
          status: "completed",
          call_id: "call-wr",
        },
      });
      assert.deepEqual(readActionEvidenceLines(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deduplicates by session_id + call_id", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-act-tc-"));
    try {
      const input = {
        projectRoot: root,
        agent_id: "DEV",
        session_id: "sess-dedupe",
        payload: {
          tool: "grep",
          status: "completed",
          call_id: "call-dup",
          raw: { args: { path: "README.md" } },
        },
      };
      maybeRecordActionEvidenceFromToolCall(input);
      maybeRecordActionEvidenceFromToolCall(input);
      assert.equal(readActionEvidenceLines(root).length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("command.run stores stdout_ref when output exceeds threshold", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-act-tc-"));
    try {
      const big = "y".repeat(5000);
      maybeRecordActionEvidenceFromToolCall({
        projectRoot: root,
        agent_id: "DEV",
        session_id: "sess-cmd",
        payload: {
          tool: "Shell",
          status: "completed",
          call_id: "call-cmd",
          raw: {
            args: { command: "npm test" },
            result: { stdout: big, exit_code: 0 },
          },
        },
      });
      const records = readActionEvidenceLines(root);
      assert.equal(records.length, 1);
      assert.equal(records[0]!.event_type, "command.run");
      const rec = records[0] as { stdout_ref?: string };
      assert.ok(rec.stdout_ref?.includes("fcop/logs/runtime/commands/"));
      const abs = join(root, rec.stdout_ref!);
      const content = await readFile(abs, "utf-8");
      assert.equal(content.length, 5000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recognizes exec_command and preserves run_id", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-act-tc-"));
    try {
      maybeRecordActionEvidenceFromToolCall({
        projectRoot: root,
        agent_id: "QA-01",
        session_id: "session-d-mrhjbg2a",
        run_id: "run-qa-2",
        task_id: "TASK-20260712-003-PM-to-QA",
        payload: {
          tool: "exec_command",
          status: "completed",
          call_id: "call-exec",
          raw: {
            args: { cmd: "npm test" },
            result: { exit_code: 0 },
          },
        },
      });
      const [record] = readActionEvidenceLines(root);
      assert.equal(record?.event_type, "command.run");
      assert.equal(record?.task_id, "TASK-20260712-003");
      assert.equal(record?.run_id, "run-qa-2");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records Playwright operations as browser evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-act-tc-"));
    try {
      maybeRecordActionEvidenceFromToolCall({
        projectRoot: root,
        agent_id: "QA-01",
        session_id: "sess-browser",
        task_id: "TASK-20260712-003",
        payload: {
          tool: "playwright.screenshot",
          status: "completed",
          call_id: "call-browser",
          raw: {
            args: { url: "http://localhost:3000" },
            result: { path: "qa-evidence/TASK-20260712-003/screenshots/home.png" },
          },
        },
      });
      const [record] = readActionEvidenceLines(root);
      assert.equal(record?.event_type, "browser.action");
      assert.equal(
        record && "screenshot_ref" in record ? record.screenshot_ref : undefined,
        "qa-evidence/TASK-20260712-003/screenshots/home.png",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
