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

import { ROLE_TOOL_BLOCKED } from "../../registry/RoleToolPolicy.ts";
import {
  OperationApprovalService,
  OPERATION_APPROVAL_REQUIRED,
  OPERATION_BOUNDARY_DENIED,
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

test("SdkRunHandle: PM edit on product path triggers CODEFLOWMU_POLICY_BLOCKED and cancel", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "cfmu-sdk-gate-"));
  let cancelReason: string | undefined;
  const messages = [
    {
      type: "tool_call",
      call_id: "edit-1",
      name: "edit",
      status: "running",
      args: { path: "codeflowmu-shell/src/web-panel.ts" },
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
  });

  const settled = await handle.whenSettled();
  assert.equal(settled.status, "failed");
  assert.equal(settled.failure_code, ROLE_TOOL_BLOCKED);
  assert.match(
    (settled as typeof settled & { sdk_error?: string }).sdk_error ?? "",
    /CODEFLOWMU_POLICY_BLOCKED/,
  );
  assert.match(cancelReason ?? "", /role_tool_blocked:edit/);
});

test("SdkRunHandle: Open DEV edit of install code is cancelled before the run continues", async () => {
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
    });
    const settled = await handle.whenSettled();
    assert.equal(settled.status, "failed");
    assert.equal(settled.failure_code, ROLE_TOOL_BLOCKED);
    assert.match(cancelReason ?? "", /role_tool_blocked:edit/);
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
  });
  const settled = await handle.whenSettled();
  assert.equal(settled.status, "failed");
  assert.equal(settled.failure_code, OPERATION_APPROVAL_REQUIRED);
  assert.match(cancelReason ?? "", /operation_boundary:shell/);
  const approvals = new OperationApprovalService({ projectRoot: repo }).list();
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.status, "pending_approval");
  assert.equal(approvals[0]!.request.action.executor, "git.push");
  assert.equal(await git(repo, ["ls-remote", "origin", "refs/heads/main"]), "");
});

test("SdkRunHandle: force git push is denied without creating an unusable approval", async () => {
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
  });
  const settled = await handle.whenSettled();
  assert.equal(settled.status, "failed");
  assert.equal(settled.failure_code, OPERATION_BOUNDARY_DENIED);
  assert.equal(new OperationApprovalService({ projectRoot: repo }).list().length, 0);
});
