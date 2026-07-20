import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  OperationApprovalError,
  OperationApprovalService,
  classifyCapabilityRequest,
  computeOperationDigest,
  type CapabilityRequest,
} from "../OperationApprovalService.ts";

type RequestOverrides = Partial<
  Omit<CapabilityRequest, "subject" | "action" | "resource" | "context" | "effect" | "snapshot">
> & {
  subject?: Partial<CapabilityRequest["subject"]>;
  action?: Partial<CapabilityRequest["action"]>;
  resource?: Partial<CapabilityRequest["resource"]>;
  context?: Partial<CapabilityRequest["context"]>;
  effect?: Partial<CapabilityRequest["effect"]>;
  snapshot?: Record<string, unknown>;
};

function request(overrides: RequestOverrides = {}): CapabilityRequest {
  const base: CapabilityRequest = {
    subject: {
      actor: "DEV-01",
      role: "DEV",
      project_id: "project-1",
      agent_id: "DEV-01",
      session_id: "session-1",
      task_id: "TASK-1",
    },
    action: {
      capability: "git.remote.push",
      operation: "push_branch",
      executor: "git.push",
    },
    resource: {
      type: "git_branch",
      targets: ["origin/codex/approval"],
      scope: { before_sha: "abc", after_sha: "def" },
    },
    context: {
      workspace: "D:\\project",
      environment: "development",
      initiated_by: "agent",
      authorization_source: "none",
      human_confirmation_id: null,
    },
    effect: { external_write: true },
    snapshot: { before_sha: "abc", after_sha: "def" },
  };
  return {
    ...base,
    ...overrides,
    subject: { ...base.subject, ...(overrides.subject ?? {}) },
    action: { ...base.action, ...(overrides.action ?? {}) },
    resource: { ...base.resource, ...(overrides.resource ?? {}) },
    context: { ...base.context, ...(overrides.context ?? {}) },
    effect: { ...base.effect, ...(overrides.effect ?? {}) },
    snapshot: { ...base.snapshot, ...(overrides.snapshot ?? {}) },
  };
}

function prepare(service: OperationApprovalService, req = request()) {
  return service.prepare({
    request: req,
    reason: "需要推送已验证的分支",
    effects: ["远端分支将更新"],
    non_effects: ["不会合并，也不会发布"],
    recovery: "可由后续反向提交恢复",
  });
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "cfm-operation-approval-"));
}

test("classifier only requires approval for the five deterministic effect classes", () => {
  const mapping = [
    ["destructive", "destructive_operation"],
    ["external_write", "external_write"],
    ["production", "production_release"],
    ["security_change", "security_authority_change"],
    ["governance_change", "governance_boundary_change"],
  ] as const;
  for (const [effect, kind] of mapping) {
    const result = classifyCapabilityRequest(request({ effect: { external_write: false, [effect]: true } }));
    assert.equal(result.decision, "REQUIRE_APPROVAL");
    assert.ok(result.risk_tags.includes(kind));
  }

  const localEdit = classifyCapabilityRequest(request({
    action: { capability: "filesystem.patch", operation: "apply_patch", executor: "workspace.patch" },
    resource: { type: "tracked_file", targets: ["src/app.ts"] },
    effect: { external_write: false },
  }));
  assert.equal(localEdit.decision, "ALLOW");

  assert.equal(
    classifyCapabilityRequest(request({ effect: { external_write: false, high_cost: true } })).decision,
    "ALLOW",
    "high-cost metadata is observation-only until a formal quota model exists",
  );
  assert.equal(classifyCapabilityRequest(request({ effect: { external_write: false, unknown: true } })).decision, "DENY");
});

test("prepare is side-effect free and approval can execute the exact digest only once", async () => {
  const root = tempRoot();
  try {
    let now = new Date("2026-07-14T08:00:00.000Z");
    const service = new OperationApprovalService({
      projectRoot: root,
      now: () => now,
      idFactory: () => "APPROVAL-EXACT-1",
    });
    let targetChanged = false;
    const prepared = prepare(service);
    assert.equal(prepared.decision, "REQUIRE_APPROVAL");
    assert.equal(prepared.executed, false);
    assert.equal(targetChanged, false);
    if (prepared.decision !== "REQUIRE_APPROVAL") assert.fail("approval expected");

    assert.throws(
      () => service.approve(prepared.approval.approval_id, "DEV", "self approval"),
      (error: unknown) => error instanceof OperationApprovalError && error.code === "APPROVER_NOT_AUTHORIZED",
    );
    assert.throws(
      () => service.approve(prepared.approval.approval_id, "ADMIN", ""),
      (error: unknown) => error instanceof OperationApprovalError && error.code === "APPROVAL_REASON_REQUIRED",
    );

    now = new Date("2026-07-14T08:01:00.000Z");
    const approved = service.approve(prepared.approval.approval_id, "ADMIN", "同意推送该摘要绑定分支");
    assert.equal("token_hash" in service.get(prepared.approval.approval_id), false);
    assert.equal("token_hash" in service.list()[0]!, false);
    const completed = await service.execute(
      prepared.approval.approval_id,
      approved.execution_token,
      request(),
      async () => {
        targetChanged = true;
        return { evidence: [{ remote: "origin", branch: "codex/approval" }] };
      },
    );
    assert.equal(completed.status, "succeeded");
    assert.equal(targetChanged, true);
    assert.equal(completed.execution.evidence.length, 1);

    await assert.rejects(
      () => service.execute(prepared.approval.approval_id, approved.execution_token, request(), async () => ({})),
      (error: unknown) => error instanceof OperationApprovalError && error.code === "APPROVAL_ALREADY_CONSUMED",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a changed target makes an approved operation stale before executor invocation", async () => {
  const root = tempRoot();
  try {
    const service = new OperationApprovalService({ projectRoot: root, idFactory: () => "APPROVAL-STALE-1" });
    const prepared = prepare(service);
    if (prepared.decision !== "REQUIRE_APPROVAL") assert.fail("approval expected");
    const approved = service.approve(prepared.approval.approval_id, "ADMIN", "同意原摘要");
    let invoked = false;
    await assert.rejects(
      () => service.execute(
        prepared.approval.approval_id,
        approved.execution_token,
        request({ snapshot: { after_sha: "changed" } }),
        async () => {
          invoked = true;
          return {};
        },
      ),
      (error: unknown) => error instanceof OperationApprovalError && error.code === "APPROVAL_STALE",
    );
    assert.equal(invoked, false);
    assert.equal(service.get(prepared.approval.approval_id).status, "stale");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejecting an operation does not rewrite task or report artifacts", () => {
  const root = tempRoot();
  try {
    const taskPath = join(root, "TASK-1.md");
    const taskBody = "task remains in review\nreport remains valid\n";
    writeFileSync(taskPath, taskBody, "utf8");
    const service = new OperationApprovalService({ projectRoot: root, idFactory: () => "APPROVAL-REJECT-1" });
    const prepared = prepare(service);
    if (prepared.decision !== "REQUIRE_APPROVAL") assert.fail("approval expected");
    assert.throws(
      () => service.reject(prepared.approval.approval_id, "DEV-01", "self reject"),
      (error: unknown) => error instanceof OperationApprovalError && error.code === "APPROVER_NOT_AUTHORIZED",
    );
    assert.throws(
      () => service.reject(prepared.approval.approval_id, "ADMIN", ""),
      (error: unknown) => error instanceof OperationApprovalError && error.code === "REJECTION_REASON_REQUIRED",
    );
    const rejected = service.reject(prepared.approval.approval_id, "ADMIN", "保留远端现状");
    assert.equal(rejected.status, "rejected");
    assert.equal(readFileSync(taskPath, "utf8"), taskBody);
    assert.throws(
      () => service.approve(prepared.approval.approval_id, "ADMIN", "change mind"),
      (error: unknown) => error instanceof OperationApprovalError && error.code === "APPROVAL_NOT_PENDING",
    );
    assert.throws(
      () => prepare(service),
      (error: unknown) => error instanceof OperationApprovalError && error.code === "APPROVAL_REJECTED_REPLAY",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare deduplicates the same pending digest instead of creating approval spam", () => {
  const root = tempRoot();
  try {
    let sequence = 0;
    const service = new OperationApprovalService({
      projectRoot: root,
      idFactory: () => `APPROVAL-DEDUPE-${++sequence}`,
    });
    const first = prepare(service);
    const second = prepare(service);
    if (first.decision !== "REQUIRE_APPROVAL" || second.decision !== "REQUIRE_APPROVAL") {
      assert.fail("approval expected");
    }
    assert.equal(first.approval.approval_id, second.approval.approval_id);
    assert.equal(service.list().length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted foreground confirmation is accepted only through the injected verifier", () => {
  const root = tempRoot();
  try {
    const req = request({
      context: {
        initiated_by: "user",
        authorization_source: "trusted_ui_confirmation",
        human_confirmation_id: "confirmation-1",
      },
    });
    const digest = computeOperationDigest(req);
    const service = new OperationApprovalService({
      projectRoot: root,
      verifyHumanConfirmation: ({ confirmation_id, operation_digest }) =>
        confirmation_id === "confirmation-1" && operation_digest === digest,
    });
    const result = prepare(service, req);
    assert.equal(result.decision, "ALLOW");
    assert.equal(result.executed, false);
    assert.equal(service.list().length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expired approval and invalid token both fail before executor invocation", async () => {
  const root = tempRoot();
  try {
    let now = new Date("2026-07-14T08:00:00.000Z");
    const service = new OperationApprovalService({
      projectRoot: root,
      now: () => now,
      idFactory: () => "APPROVAL-EXPIRY-1",
    });
    const prepared = service.prepare({
      request: request(),
      reason: "需要推送已验证的分支",
      effects: ["远端分支将更新"],
      non_effects: ["不会合并，也不会发布"],
      recovery: "可由后续反向提交恢复",
      expires_in_seconds: 30,
    });
    if (prepared.decision !== "REQUIRE_APPROVAL") assert.fail("approval expected");
    const approved = service.approve(prepared.approval.approval_id, "ADMIN", "同意该精确摘要");
    let invoked = false;
    await assert.rejects(
      () => service.execute(prepared.approval.approval_id, "wrong-token", request(), async () => {
        invoked = true;
        return {};
      }),
      (error: unknown) => error instanceof OperationApprovalError && error.code === "APPROVAL_TOKEN_INVALID",
    );
    assert.equal(invoked, false);

    now = new Date("2026-07-14T08:00:31.000Z");
    await assert.rejects(
      () => service.execute(prepared.approval.approval_id, approved.execution_token, request(), async () => {
        invoked = true;
        return {};
      }),
      (error: unknown) => error instanceof OperationApprovalError && error.code === "PRE_APPROVAL_REQUIRED",
    );
    assert.equal(invoked, false);
    assert.equal(service.get(prepared.approval.approval_id).status, "expired");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent consumption invokes the controlled executor only once", async () => {
  const root = tempRoot();
  try {
    const service = new OperationApprovalService({ projectRoot: root, idFactory: () => "APPROVAL-CONCURRENT-1" });
    const prepared = prepare(service);
    if (prepared.decision !== "REQUIRE_APPROVAL") assert.fail("approval expected");
    const approved = service.approve(prepared.approval.approval_id, "ADMIN", "同意单次执行");
    let invocationCount = 0;
    let releaseExecutor!: () => void;
    const hold = new Promise<void>((resolve) => { releaseExecutor = resolve; });
    const first = service.execute(prepared.approval.approval_id, approved.execution_token, request(), async () => {
      invocationCount += 1;
      await hold;
      return { evidence: [{ invocation: invocationCount }] };
    });

    await assert.rejects(
      () => service.execute(prepared.approval.approval_id, approved.execution_token, request(), async () => {
        invocationCount += 1;
        return {};
      }),
      (error: unknown) => error instanceof OperationApprovalError && error.code === "APPROVAL_ALREADY_CONSUMED",
    );
    releaseExecutor();
    const completed = await first;
    assert.equal(completed.status, "succeeded");
    assert.equal(invocationCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an execution owned by a previous process is recovered as partial_failed without a replay token", () => {
  const root = tempRoot();
  try {
    const approvalId = "APPROVAL-INTERRUPTED-1";
    const service = new OperationApprovalService({ projectRoot: root, idFactory: () => approvalId });
    const prepared = prepare(service);
    if (prepared.decision !== "REQUIRE_APPROVAL") assert.fail("approval expected");
    service.approve(approvalId, "ADMIN", "approve exact operation");

    const recordPath = join(root, ".codeflowmu", "operation-approvals", "records", `${approvalId}.json`);
    const raw = JSON.parse(readFileSync(recordPath, "utf-8")) as Record<string, unknown>;
    raw["status"] = "executing";
    const execution = raw["execution"] as Record<string, unknown>;
    execution["status"] = "executing";
    execution["started_at"] = "2026-07-14T08:00:00.000Z";
    execution["executor_pid"] = process.pid + 100_000;
    writeFileSync(recordPath, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");

    const recovered = new OperationApprovalService({ projectRoot: root }).get(approvalId);
    assert.equal(recovered.status, "partial_failed");
    assert.equal(recovered.execution.status, "partial_failed");
    assert.match(recovered.execution.error ?? "", /requires inspection/);
    assert.equal("token_hash" in recovered, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
