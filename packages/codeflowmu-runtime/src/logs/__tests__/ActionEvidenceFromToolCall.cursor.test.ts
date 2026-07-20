import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  maybeRecordActionEvidenceFromToolCall,
  resetActionEvidenceToolCallDedupeForTests,
} from "../ActionEvidenceFromToolCall.ts";
import {
  readActionEvidenceLines,
  resetActionEventIdCounterForTests,
} from "../ActionEvidenceLogger.ts";

/** Cursor SdkRunHandle payload: { sdk_type, raw: SDK tool_call message } */
function cursorToolCallPayload(opts: {
  name: string;
  status: string;
  call_id: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    sdk_type: "tool_call",
    raw: {
      type: "tool_call",
      name: opts.name,
      status: opts.status,
      call_id: opts.call_id,
      ...(opts.args ? { args: opts.args } : {}),
      ...(opts.result ? { result: opts.result } : {}),
    },
  };
}

const baseInput = {
  agent_id: "OPS",
  session_id: "sess-cursor-ops",
  task_id: "TASK-20260608-001",
};

describe("ActionEvidenceFromToolCall (Cursor sdk.tool_call shape)", () => {
  beforeEach(() => {
    resetActionEvidenceToolCallDedupeForTests();
    resetActionEventIdCounterForTests();
  });
  afterEach(() => {
    resetActionEvidenceToolCallDedupeForTests();
    resetActionEventIdCounterForTests();
  });

  it("Cursor read_file → file.read", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-act-cursor-"));
    try {
      maybeRecordActionEvidenceFromToolCall({
        projectRoot: root,
        ...baseInput,
        payload: cursorToolCallPayload({
          name: "read_file",
          status: "completed",
          call_id: "cursor-read-1",
          args: { path: join(root, "fcop", "fcop.json") },
        }),
      });
      const records = readActionEvidenceLines(root);
      assert.equal(records.length, 1);
      assert.equal(records[0]!.event_type, "file.read");
      assert.equal(records[0]!.path, "fcop/fcop.json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Cursor apply_patch → file.edit", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-act-cursor-"));
    try {
      maybeRecordActionEvidenceFromToolCall({
        projectRoot: root,
        ...baseInput,
        payload: cursorToolCallPayload({
          name: "apply_patch",
          status: "completed",
          call_id: "cursor-edit-1",
          args: { path: "packages/codeflowmu-runtime/src/logs/ActionEvidenceLogger.ts" },
        }),
      });
      const records = readActionEvidenceLines(root);
      assert.equal(records.length, 1);
      assert.equal(records[0]!.event_type, "file.edit");
      assert.equal(
        records[0]!.path,
        "packages/codeflowmu-runtime/src/logs/ActionEvidenceLogger.ts",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Cursor run_terminal_cmd → command.run with exit_code", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-act-cursor-"));
    try {
      maybeRecordActionEvidenceFromToolCall({
        projectRoot: root,
        ...baseInput,
        payload: cursorToolCallPayload({
          name: "run_terminal_cmd",
          status: "completed",
          call_id: "cursor-cmd-1",
          args: { command: "npm test" },
          result: { exit_code: 0, stdout: "ok" },
        }),
      });
      const records = readActionEvidenceLines(root);
      assert.equal(records.length, 1);
      assert.equal(records[0]!.event_type, "command.run");
      const cmd = records[0] as { command?: string; exit_code?: number | null };
      assert.equal(cmd.command, "npm test");
      assert.equal(cmd.exit_code, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("failed run_terminal_cmd without exit_code → exit_code=1", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-act-cursor-"));
    try {
      maybeRecordActionEvidenceFromToolCall({
        projectRoot: root,
        ...baseInput,
        payload: cursorToolCallPayload({
          name: "run_terminal_cmd",
          status: "failed",
          call_id: "cursor-cmd-fail",
          args: { command: "false" },
          result: { stderr: "error" },
        }),
      });
      const records = readActionEvidenceLines(root);
      assert.equal(records.length, 1);
      const cmd = records[0] as { exit_code?: number | null; status?: string };
      assert.equal(cmd.exit_code, 1);
      assert.equal(cmd.status, "failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Cursor write_task → task.write with recipient and task_ref", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-act-cursor-"));
    try {
      maybeRecordActionEvidenceFromToolCall({
        projectRoot: root,
        ...baseInput,
        payload: cursorToolCallPayload({
          name: "write_task",
          status: "completed",
          call_id: "cursor-task-1",
          args: {
            recipient: "DEV",
            task_id: "TASK-20260608-002",
          },
        }),
      });
      const records = readActionEvidenceLines(root);
      assert.equal(records.length, 1);
      assert.equal(records[0]!.event_type, "task.write");
      const tw = records[0] as {
        recipient?: string;
        task_ref?: string;
        task_id?: string;
        session_id?: string;
        agent_id?: string;
        role?: string;
      };
      assert.equal(tw.recipient, "DEV");
      assert.equal(tw.task_ref, "TASK-20260608-002");
      assert.equal(tw.task_id, baseInput.task_id);
      assert.equal(tw.session_id, baseInput.session_id);
      assert.equal(tw.agent_id, baseInput.agent_id);
      assert.equal(tw.role, "OPS");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("write_report tool_call does not write report.write", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-act-cursor-"));
    try {
      maybeRecordActionEvidenceFromToolCall({
        projectRoot: root,
        ...baseInput,
        payload: cursorToolCallPayload({
          name: "write_report",
          status: "completed",
          call_id: "cursor-wr-1",
          args: { task_id: "TASK-20260608-001" },
        }),
      });
      assert.deepEqual(readActionEvidenceLines(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("running tool_call does not write action evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-act-cursor-"));
    try {
      maybeRecordActionEvidenceFromToolCall({
        projectRoot: root,
        ...baseInput,
        payload: cursorToolCallPayload({
          name: "read_file",
          status: "running",
          call_id: "cursor-run-1",
          args: { path: "README.md" },
        }),
      });
      assert.deepEqual(readActionEvidenceLines(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("duplicate call_id does not write twice", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-act-cursor-"));
    try {
      const input = {
        projectRoot: root,
        ...baseInput,
        payload: cursorToolCallPayload({
          name: "StrReplace",
          status: "completed",
          call_id: "cursor-dup-1",
          args: { path: "src/foo.ts" },
        }),
      };
      maybeRecordActionEvidenceFromToolCall(input);
      maybeRecordActionEvidenceFromToolCall(input);
      const records = readActionEvidenceLines(root);
      assert.equal(records.length, 1);
      assert.equal(records[0]!.event_type, "file.edit");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
