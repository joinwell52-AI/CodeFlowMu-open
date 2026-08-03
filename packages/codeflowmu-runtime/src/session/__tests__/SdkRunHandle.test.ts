/**
 * SdkRunHandle — tool round counting with Cursor running/completed pairs.
 */

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import type { Agent } from "@codeflowmu/protocol";

import {
  OperationApprovalService,
  OPERATION_APPROVAL_REQUIRED,
  isPendingApprovalStatus,
} from "../../approval/index.ts";
import { SdkRunHandle } from "../SdkRunHandle.ts";

const execFile = promisify(execFileCallback);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd });
  return String(result.stdout ?? "").trim();
}

async function createPushFixture(): Promise<{ repo: string; remote: string }> {
  const root = await mkdtemp(join(tmpdir(), "cfmu-sdk-push-gate-"));
  const remote = join(root, "remote.git");
  const repo = join(root, "work");
  await execFile("git", ["init", "--bare", remote]);
  await execFile("git", ["init", "-b", "main", repo]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  await writeFile(join(repo, "README.md"), "approval gate fixture\n", "utf-8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "fixture"]);
  await git(repo, ["remote", "add", "origin", remote]);
  return { repo, remote };
}

function mockAgent(): Agent {
  return {
    agent_id: "PM-01",
    role: "pm",
    layer: "governance",
    node: "local",
    runtime: "local",
    workspace: "D:\\test",
    skills: [],
    status: "running",
  };
}

test("SdkRunHandle: running+completed share one tool round (max 5 allows 5 tools)", async () => {
  const messages = [
    { type: "tool_call", call_id: "t1", name: "mcp", status: "running", args: {} },
    { type: "tool_call", call_id: "t1", name: "mcp", status: "completed", args: {} },
    { type: "tool_call", call_id: "t2", name: "mcp", status: "running", args: {} },
    { type: "tool_call", call_id: "t2", name: "mcp", status: "completed", args: {} },
    { type: "tool_call", call_id: "t3", name: "mcp", status: "running", args: {} },
    { type: "tool_call", call_id: "t3", name: "mcp", status: "completed", args: {} },
    { type: "tool_call", call_id: "t4", name: "mcp", status: "running", args: {} },
    { type: "tool_call", call_id: "t4", name: "mcp", status: "completed", args: {} },
    { type: "tool_call", call_id: "t5", name: "mcp", status: "running", args: {} },
    { type: "tool_call", call_id: "t5", name: "mcp", status: "completed", args: {} },
  ];

  const run = {
    id: "run-1",
    supports: (cap: string) => cap === "stream" || cap === "cancel",
    stream: async function* () {
      for (const m of messages) {
        yield m;
      }
    },
    wait: async () => ({ status: "success" }),
    cancel: async () => {},
  };

  const handle = new SdkRunHandle({
    agent: mockAgent() as unknown as import("@cursor/sdk").Agent,
    run: run as never,
    sessionId: "sess-1",
    agentId: "PM-01",
    maxToolRounds: 5,
  });

  const settled = await handle.whenSettled();
  assert.equal(settled.tool_calls_count, 5);
  assert.equal(settled.status, "finished");
  assert.equal(settled.failure_code, undefined);
});

test("SdkRunHandle: 6th unique call_id triggers TURN_LIMIT", async () => {
  const messages = [
    { type: "tool_call", call_id: "t1", name: "mcp", status: "running", args: {} },
    { type: "tool_call", call_id: "t1", name: "mcp", status: "completed", args: {} },
    { type: "tool_call", call_id: "t2", name: "mcp", status: "running", args: {} },
    { type: "tool_call", call_id: "t2", name: "mcp", status: "completed", args: {} },
    { type: "tool_call", call_id: "t3", name: "mcp", status: "running", args: {} },
    { type: "tool_call", call_id: "t3", name: "mcp", status: "completed", args: {} },
    { type: "tool_call", call_id: "t4", name: "mcp", status: "running", args: {} },
    { type: "tool_call", call_id: "t4", name: "mcp", status: "completed", args: {} },
    { type: "tool_call", call_id: "t5", name: "mcp", status: "running", args: {} },
    { type: "tool_call", call_id: "t5", name: "mcp", status: "completed", args: {} },
    { type: "tool_call", call_id: "t6", name: "mcp", status: "running", args: {} },
    { type: "tool_call", call_id: "t6", name: "mcp", status: "completed", args: {} },
  ];

  const run = {
    id: "run-2",
    supports: (cap: string) => cap === "stream" || cap === "cancel",
    stream: async function* () {
      for (const m of messages) {
        yield m;
      }
    },
    wait: async () => ({ status: "success" }),
    cancel: async () => {},
  };

  const handle = new SdkRunHandle({
    agent: mockAgent() as unknown as import("@cursor/sdk").Agent,
    run: run as never,
    sessionId: "sess-2",
    agentId: "PM-01",
    maxToolRounds: 5,
  });

  const settled = await handle.whenSettled();
  assert.equal(settled.tool_calls_count, 5);
  assert.equal(settled.status, "failed");
  assert.equal(settled.failure_code, "TURN_LIMIT");
});

test("SdkRunHandle: PM edit on protected product code waits for approval without cancelling the Session", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "cfmu-sdk-gate-"));
  let cancelReason: string | undefined;
  const messages = [
    {
      type: "tool_call",
      call_id: "edit-1",
      name: "edit",
      status: "running",
      args: { path: "packages/codeflowmu-runtime/src/approval/UnifiedOperationPolicy.ts" },
    },
  ];

  const run = {
    id: "run-role-gate",
    supports: (cap: string) => cap === "stream" || cap === "cancel",
    stream: async function* () {
      for (const m of messages) {
        yield m;
      }
    },
    wait: async () => ({ status: "success" }),
    cancel: async (reason?: string) => {
      cancelReason = reason;
    },
  };

  const handle = new SdkRunHandle({
    agent: mockAgent() as unknown as import("@cursor/sdk").Agent,
    run: run as never,
    sessionId: "sess-role-gate",
    agentId: "PM-01",
    projectRoot,
    taskId: "TASK-20260803-001-ADMIN-to-PM",
    threadKey: "thread-sdk-protected-edit",
  });

  const settled = await handle.whenSettled();
  assert.equal(settled.status, "finished");
  assert.equal(settled.failure_code, OPERATION_APPROVAL_REQUIRED);
  assert.equal(cancelReason, undefined);
  assert.equal(new OperationApprovalService({ projectRoot }).list().length, 1);
});

test("SdkRunHandle: Open DEV edit of install code waits for approval without cancelling", async () => {
  let cancelReason: string | undefined;
  const run = {
    id: "run-open-install-gate",
    supports: (cap: string) => cap === "stream" || cap === "cancel",
    stream: async function* () {
      yield {
        type: "tool_call",
        call_id: "edit-install-1",
        name: "edit",
        status: "running",
        args: { path: "D:/CodeFlowMu-open/codeflowmu-shell/src/main.ts" },
      };
    },
    wait: async () => ({ status: "success" }),
    cancel: async (reason?: string) => { cancelReason = reason; },
  };
  const previous = process.env.CODEFLOW_OPEN_EDITION;
  process.env.CODEFLOW_OPEN_EDITION = "1";
  try {
    const handle = new SdkRunHandle({
      agent: mockAgent() as unknown as import("@cursor/sdk").Agent,
      run: run as never,
      sessionId: "sess-open-install-gate",
      agentId: "DEV-01",
      projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
      taskId: "TASK-20260803-002-PM-to-DEV",
      threadKey: "thread-sdk-open-install",
    });
    const settled = await handle.whenSettled();
    assert.equal(settled.status, "finished");
    assert.equal(settled.failure_code, OPERATION_APPROVAL_REQUIRED);
    assert.equal(cancelReason, undefined);
  } finally {
    if (previous === undefined) delete process.env.CODEFLOW_OPEN_EDITION;
    else process.env.CODEFLOW_OPEN_EDITION = previous;
  }
});

test("SdkRunHandle: Open DEV edit inside the active project remains writable", async () => {
  let cancelled = false;
  const run = {
    id: "run-open-project-write",
    supports: (cap: string) => cap === "stream" || cap === "cancel",
    stream: async function* () {
      yield {
        type: "tool_call",
        call_id: "edit-project-1",
        name: "edit",
        status: "running",
        args: { path: "D:/CodeFlowMu-open/workspace/newproject/src/app.ts" },
      };
    },
    wait: async () => ({ status: "success" }),
    cancel: async () => { cancelled = true; },
  };
  const previous = process.env.CODEFLOW_OPEN_EDITION;
  process.env.CODEFLOW_OPEN_EDITION = "1";
  try {
    const handle = new SdkRunHandle({
      agent: mockAgent() as unknown as import("@cursor/sdk").Agent,
      run: run as never,
      sessionId: "sess-open-project-write",
      agentId: "DEV-01",
      projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
    });
    const settled = await handle.whenSettled();
    assert.equal(settled.status, "finished");
    assert.equal(cancelled, false);
  } finally {
    if (previous === undefined) delete process.env.CODEFLOW_OPEN_EDITION;
    else process.env.CODEFLOW_OPEN_EDITION = previous;
  }
});

test("SdkRunHandle: exact git push creates a pre-action approval and leaves remote unchanged", async () => {
  const { repo } = await createPushFixture();
  let cancelReason: string | undefined;
  const run = {
    id: "run-native-push-gate",
    supports: (cap: string) => cap === "stream" || cap === "cancel",
    stream: async function* () {
      yield {
        type: "tool_call",
        call_id: "push-1",
        name: "shell",
        status: "running",
        args: { command: "git push -u origin main", cwd: repo },
      };
    },
    wait: async () => ({ status: "success" }),
    cancel: async (reason?: string) => { cancelReason = reason; },
  };

  const handle = new SdkRunHandle({
    agent: mockAgent() as unknown as import("@cursor/sdk").Agent,
    run: run as never,
    sessionId: "sess-native-push-gate",
    agentId: "DEV-01",
    projectRoot: repo,
    taskId: "TASK-20260803-003-PM-to-DEV",
    threadKey: "thread-sdk-push",
  });
  const settled = await handle.whenSettled();
  assert.equal(settled.status, "finished");
  assert.equal(settled.failure_code, OPERATION_APPROVAL_REQUIRED);
  assert.equal(cancelReason, undefined);
  const approvals = new OperationApprovalService({ projectRoot: repo }).list();
  assert.equal(approvals.length, 1);
  assert.equal(isPendingApprovalStatus(approvals[0]!.status), true);
  assert.equal(approvals[0]!.request.action.executor, "agent.retry");
  assert.equal(await git(repo, ["ls-remote", "origin", "refs/heads/main"]), "");
});

test("SdkRunHandle: force git push creates a real approval and does not terminate the Session", async () => {
  const { repo } = await createPushFixture();
  const run = {
    id: "run-native-force-push-gate",
    supports: (cap: string) => cap === "stream" || cap === "cancel",
    stream: async function* () {
      yield {
        type: "tool_call",
        call_id: "push-force-1",
        name: "shell",
        status: "running",
        args: { command: "git push --force origin main", cwd: repo },
      };
    },
    wait: async () => ({ status: "success" }),
    cancel: async () => {},
  };

  const handle = new SdkRunHandle({
    agent: mockAgent() as unknown as import("@cursor/sdk").Agent,
    run: run as never,
    sessionId: "sess-native-force-push-gate",
    agentId: "DEV-01",
    projectRoot: repo,
    taskId: "TASK-20260803-004-PM-to-DEV",
    threadKey: "thread-sdk-force-push",
  });
  const settled = await handle.whenSettled();
  assert.equal(settled.status, "finished");
  assert.equal(settled.failure_code, OPERATION_APPROVAL_REQUIRED);
  assert.equal(
    (settled as typeof settled & { operation_classification?: string })
      .operation_classification,
    "approval_required",
  );
  assert.equal(
    (settled as typeof settled & { retry_policy?: string }).retry_policy,
    "none",
  );
  const approvals = new OperationApprovalService({ projectRoot: repo }).list();
  assert.equal(approvals.length, 1);
  assert.equal(isPendingApprovalStatus(approvals[0]!.status), true);
});

test("SdkRunHandle: deleting an already absent exact target is a successful no-op", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "cfmu-sdk-absent-cleanup-"));
  const missingPath = join(
    projectRoot,
    "workspace",
    "qa-run",
    "_qa_wp00_spotcheck.py",
  );
  const run = {
    id: "run-native-absent-cleanup",
    supports: (cap: string) => cap === "stream" || cap === "cancel",
    stream: async function* () {
      yield {
        type: "tool_call",
        call_id: "delete-absent-1",
        name: "delete_file",
        status: "running",
        args: { path: missingPath },
      };
    },
    // Some native providers still report their own missing-file error. The
    // operation boundary has already proved this exact cleanup is idempotent.
    wait: async () => ({ status: "failed", error: "file not found" }),
    cancel: async () => {},
  };

  const handle = new SdkRunHandle({
    agent: mockAgent() as unknown as import("@cursor/sdk").Agent,
    run: run as never,
    sessionId: "sess-native-absent-cleanup",
    agentId: "QA-01",
    projectRoot,
  });
  const settled = await handle.whenSettled();
  assert.equal(settled.status, "finished");
  assert.equal(settled.failure_code, undefined);
  assert.equal(
    (settled as typeof settled & { operation_classification?: string })
      .operation_classification,
    "already_absent",
  );
  assert.deepEqual(
    (settled as typeof settled & { operation_outcome?: unknown })
      .operation_outcome,
    {
      ok: true,
      changed: false,
      reason: "already_absent",
      targets: [missingPath],
      classification: "already_absent",
    },
  );
});
