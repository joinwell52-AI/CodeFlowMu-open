import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  CONTROLLED_EXECUTOR_NAMES,
  evaluateUnifiedOperationPolicy,
  OperationApprovalError,
  OperationApprovalService,
  type CapabilityRequest,
} from "@codeflowmu/runtime";

import { createControlledExecutorRegistry } from "../controlled-executor-registry.ts";

function subject(root: string): CapabilityRequest["subject"] {
  return {
    actor: "PM-01",
    role: "PM",
    agent_id: "PM-01",
    session_id: "session-registry",
    task_id: "TASK-REGISTRY-1",
    project_id: root,
  };
}

function registry(root: string) {
  return createControlledExecutorRegistry({
    projectRoot: () => root,
    gitRoot: () => root,
    async buildReviewPolicyInput() {
      throw new Error("not used");
    },
    async saveReviewPolicy() {
      throw new Error("not used");
    },
  });
}

describe("controlled executor registry", () => {
  it("uses the same complete adapter set for prepare and execute", () => {
    const root = mkdtempSync(join(tmpdir(), "cf-executor-registry-"));
    try {
      const value = registry(root);
      assert.deepEqual(value.names(), [...CONTROLLED_EXECUTOR_NAMES].sort());
      for (const name of CONTROLLED_EXECUTOR_NAMES) {
        assert.equal(value.canPrepare(name), true, name);
        assert.equal(value.canExecute(name), true, name);
      }
      assert.equal(value.canPrepare("workspace.unknown"), false);
      assert.equal(value.canExecute("workspace.unknown"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes an approved exact workspace write once and rejects token replay", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf-executor-write-"));
    try {
      const value = registry(root);
      const service = new OperationApprovalService({
        projectRoot: root,
        idFactory: () => "APPROVAL-WORKSPACE-WRITE-1",
      });
      const input = await value.prepare("workspace.fs.write", {
        subject: subject(root),
        target: "src/result.txt",
        content: "approved content\n",
      });
      const prepared = service.prepare(input);
      assert.equal(prepared.decision, "REQUIRE_APPROVAL");
      if (prepared.decision !== "REQUIRE_APPROVAL") assert.fail("approval expected");
      assert.equal(existsSync(join(root, "src", "result.txt")), false);
      const approved = service.approve(
        prepared.approval.approval_id,
        "ADMIN",
        "approve exact bounded workspace write",
      );
      const record = service.get(prepared.approval.approval_id);
      const request = await value.recomputeRequest(record);
      const completed = await service.execute(
        record.approval_id,
        approved.execution_token,
        request,
        (current) => value.execute(current),
      );
      assert.equal(completed.status, "succeeded");
      assert.equal(readFileSync(join(root, "src", "result.txt"), "utf8"), "approved content\n");
      await assert.rejects(
        () => service.execute(
          record.approval_id,
          approved.execution_token,
          request,
          (current) => value.execute(current),
        ),
        (error: unknown) =>
          error instanceof OperationApprovalError &&
          error.code === "APPROVAL_ALREADY_CONSUMED",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes an approval prepared by the unified Cursor/Google policy without digest drift", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf-unified-executor-write-"));
    try {
      const value = registry(root);
      const service = new OperationApprovalService({
        projectRoot: root,
        idFactory: () => "APPROVAL-UNIFIED-WORKSPACE-WRITE-1",
      });
      const decision = evaluateUnifiedOperationPolicy({
        toolName: "workspace.fs.write",
        args: { path: "packages/codeflowmu-runtime/src/approval/unified.txt", content: "unified approved content\n" },
        projectRoot: root,
        projectId: root,
        agentId: "PM-01",
        sessionId: "session-registry",
        taskId: "TASK-REGISTRY-1",
      });
      assert.equal(decision.decision, "REQUIRE_APPROVAL");
      if (decision.decision !== "REQUIRE_APPROVAL") assert.fail("approval expected");
      const prepared = service.prepare(decision.input);
      if (prepared.decision !== "REQUIRE_APPROVAL") assert.fail("approval record expected");
      const approved = service.approve(prepared.approval.approval_id, "ADMIN", "approve unified write");
      const record = service.get(prepared.approval.approval_id);
      const completed = await service.execute(
        record.approval_id,
        approved.execution_token,
        await value.recomputeRequest(record),
        (current) => value.execute(current),
      );
      assert.equal(completed.status, "succeeded");
      assert.equal(readFileSync(join(root, "packages", "codeflowmu-runtime", "src", "approval", "unified.txt"), "utf8"), "unified approved content\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("invalidates approval when the bound target changes before execution", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf-executor-stale-"));
    try {
      const target = join(root, "result.txt");
      writeFileSync(target, "before\n", "utf8");
      const value = registry(root);
      const service = new OperationApprovalService({
        projectRoot: root,
        idFactory: () => "APPROVAL-WORKSPACE-STALE-1",
      });
      const prepared = service.prepare(await value.prepare("workspace.fs.write", {
        subject: subject(root),
        target: "result.txt",
        content: "after\n",
      }));
      if (prepared.decision !== "REQUIRE_APPROVAL") assert.fail("approval expected");
      const approved = service.approve(prepared.approval.approval_id, "ADMIN", "approve exact snapshot");
      writeFileSync(target, "changed outside approval\n", "utf8");
      const record = service.get(prepared.approval.approval_id);
      await assert.rejects(
        async () => service.execute(
          record.approval_id,
          approved.execution_token,
          await value.recomputeRequest(record),
          (current) => value.execute(current),
        ),
        (error: unknown) =>
          error instanceof OperationApprovalError && error.code === "APPROVAL_STALE",
      );
      assert.equal(readFileSync(target, "utf8"), "changed outside approval\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
