import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GovernanceApprovalError,
  GovernanceApprovalService,
  type GovernanceAuthorizationReference,
  type GovernanceRecordInput,
} from "../GovernanceApprovalService.ts";

let governanceSequence = 0;
let approvalSequence = 0;
let decisionSequence = 0;

function tempRoot(): string {
  const root = join(
    tmpdir(),
    `cfm-governance-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(join(root, "fcop", "_lifecycle", "active"), {
    recursive: true,
  });
  writeFileSync(
    join(
      root,
      "fcop",
      "_lifecycle",
      "active",
      "TASK-20260731-001-ADMIN-to-PM.md",
    ),
    "---\ntask_id: TASK-20260731-001-ADMIN-to-PM\n---\n# Test task\n",
    "utf-8",
  );
  return root;
}

function input(
  overrides: Partial<GovernanceRecordInput> = {},
): GovernanceRecordInput {
  return {
    type: "AUTHORIZATION",
    issued_by: "ADMIN",
    authored_by: "PM",
    recipient: "DEV",
    target_task_id: "TASK-20260731-001-ADMIN-to-PM",
    thread_key: "governance-approval-test",
    project_id: "project-test",
    source_kind: "admin_chat",
    source_message_id: "message-admin-1",
    source_session_id: "session-admin-1",
    intent_summary: "允许执行一次指定范围内的外部写入",
    boundary_summary: "仅限测试项目、指定任务和指定目标",
    allowed_actions: ["git.remote.push"],
    prohibited_actions: ["release.publish", "scope.expand"],
    targets: ["origin/codex/governance-test"],
    effective_conditions: ["hash and scope match"],
    usage_limit: 1,
    retry_semantics: "explicit_new_approval",
    risk_and_rollback: "失败时停止并保留审计证据，不自动重试",
    revocation_conditions: ["ADMIN revokes", "scope changes"],
    evidence_requirements: ["command result", "remote ref"],
    references: ["message-admin-1"],
    blocks_task: true,
    ...overrides,
  };
}

function service(
  root: string,
  options: {
    now?: () => Date;
    sender?: string;
    immutable?: boolean;
  } = {},
): GovernanceApprovalService {
  return new GovernanceApprovalService({
    projectRoot: root,
    now: options.now,
    governanceIdFactory: () => `GOV-TEST-${++governanceSequence}`,
    approvalIdFactory: () => `APPROVAL-TEST-${++approvalSequence}`,
    decisionIdFactory: () => `DECISION-TEST-${++decisionSequence}`,
    verifySourceMessage: ({ project_id, target_task_id }) => ({
      exists: true,
      sender: options.sender ?? "ADMIN",
      project_id,
      task_ids: [target_task_id],
      immutable: options.immutable ?? true,
    }),
  });
}

function approve(
  approvalService: GovernanceApprovalService,
  recordInput = input(),
  suffix = "1",
) {
  const draft = approvalService.writeDraft(recordInput, {
    idempotencyKey: `draft-${suffix}`,
  });
  const pending = approvalService.submit(
    draft.governance_id,
    draft.revision,
    "PM",
    `submit-${suffix}`,
  );
  const result = approvalService.decide({
    governanceId: pending.governance_id,
    revision: pending.revision,
    approvalId: pending.approval_id!,
    actor: "ADMIN",
    decision: "approved",
    reason: "范围、风险和回滚条件已确认",
    conditions: ["不得扩大目标范围"],
    sourceUiActionId: `ui-action-approve-${suffix}`,
    idempotencyKey: `decision-${suffix}`,
  });
  const reference: GovernanceAuthorizationReference = {
    governance_id: result.governance.governance_id,
    revision: result.governance.revision,
    approval_id: result.governance.approval_id!,
    decision_id: result.decision.decision_id,
    scope_digest: result.governance.scope_digest,
    content_hash: result.governance.content_hash,
    lease_id: result.decision.lease_id!,
    idempotency_key: `consume-${suffix}`,
  };
  return { ...result, reference };
}

function assertCode(error: unknown, code: string): boolean {
  assert.ok(error instanceof GovernanceApprovalError);
  assert.equal(error.code, code);
  return true;
}

test("PM draft and submit remain pending until an immutable ADMIN decision exists", () => {
  const root = tempRoot();
  try {
    const approvalService = service(root);
    const draft = approvalService.writeDraft(input());
    assert.equal(draft.status, "draft");
    assert.equal(draft.source_verified, false);

    const pending = approvalService.submit(
      draft.governance_id,
      draft.revision,
      "PM",
    );
    assert.equal(pending.status, "pending_approval");
    assert.equal(pending.source_verified, true);
    assert.ok(pending.approval_id);
    assert.equal(approvalService.listDecisions().length, 0);
    assert.equal(
      approvalService.list({ status: "effective" }).length,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("forged ADMIN chat evidence is absolutely prohibited", () => {
  const root = tempRoot();
  try {
    const approvalService = service(root, { sender: "PM" });
    const draft = approvalService.writeDraft(input());
    assert.throws(
      () =>
        approvalService.submit(
          draft.governance_id,
          draft.revision,
          "PM",
        ),
      (error) => assertCode(error, "ABSOLUTELY_PROHIBITED"),
    );
    assert.equal(
      approvalService.get(draft.governance_id, draft.revision).status,
      "draft",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary chat text cannot replace a formal ADMIN UI decision", () => {
  const root = tempRoot();
  try {
    const approvalService = service(root);
    const draft = approvalService.writeDraft(input());
    const pending = approvalService.submit(
      draft.governance_id,
      1,
      "PM",
    );
    assert.throws(
      () =>
        approvalService.decide({
          governanceId: pending.governance_id,
          revision: 1,
          approvalId: pending.approval_id!,
          actor: "ADMIN",
          decision: "approved",
          reason: "聊天里说同意",
          sourceUiActionId: "",
          idempotencyKey: "chat-is-not-approval",
        }),
      (error) => assertCode(error, "FORMAL_UI_ACTION_REQUIRED"),
    );
    assert.equal(approvalService.get(pending.governance_id, 1).status, "pending_approval");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ADMIN approval is atomic, immutable and idempotent", () => {
  const root = tempRoot();
  try {
    const approvalService = service(root);
    const result = approve(approvalService);
    assert.equal(result.governance.status, "effective");
    assert.equal(result.decision.decision, "approved");
    assert.ok(existsSync(result.decision.path));

    const duplicate = approvalService.decide({
      governanceId: result.governance.governance_id,
      revision: result.governance.revision,
      approvalId: result.governance.approval_id!,
      actor: "ADMIN",
      decision: "approved",
      reason: "范围、风险和回滚条件已确认",
      sourceUiActionId: "ui-action-approve-1",
      idempotencyKey: "decision-1",
    });
    assert.equal(duplicate.decision.decision_id, result.decision.decision_id);
    assert.equal(
      approvalService.listDecisions(result.governance.governance_id).length,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changes requested creates a new revision without rewriting the prior record", () => {
  const root = tempRoot();
  try {
    const approvalService = service(root);
    const draft = approvalService.writeDraft(input());
    const pending = approvalService.submit(draft.governance_id, 1, "PM");
    const changes = approvalService.decide({
      governanceId: pending.governance_id,
      revision: 1,
      approvalId: pending.approval_id!,
      actor: "ADMIN",
      decision: "changes_requested",
      reason: "补充明确的恢复证据",
      sourceUiActionId: "ui-action-changes-1",
      idempotencyKey: "changes-1",
    });
    const oldPath = changes.governance.path;
    const oldContent = readFileSync(oldPath, "utf-8");
    const revision = approvalService.revise(
      pending.governance_id,
      1,
      input({
        evidence_requirements: [
          "command result",
          "remote ref",
          "rollback verification",
        ],
      }),
      "PM",
    );
    assert.equal(revision.revision, 2);
    assert.equal(revision.status, "draft");
    assert.equal(readFileSync(oldPath, "utf-8"), oldContent);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scope mismatch, expiry, revocation and single-use consumption have precise codes", () => {
  const root = tempRoot();
  let now = new Date("2026-07-31T00:00:00.000Z");
  try {
    const approvalService = service(root, { now: () => now });
    const approved = approve(
      approvalService,
      input({ expires_at: "2026-07-31T01:00:00.000Z" }),
    );
    const expected = {
      project_id: approved.governance.project_id,
      target_task_id: approved.governance.target_task_id,
      scope_digest: approved.governance.scope_digest,
      content_hash: approved.governance.content_hash,
    };
    assert.throws(
      () =>
        approvalService.validateAuthorization(approved.reference, {
          ...expected,
          scope_digest: "sha256:not-the-approved-scope",
        }),
      (error) => assertCode(error, "APPROVAL_SCOPE_MISMATCH"),
    );
    assert.throws(
      () =>
        approvalService.authorizeAction(
          approved.reference,
          {
            project_id: expected.project_id,
            target_task_id: expected.target_task_id,
            action: "release.publish",
            targets: ["origin/codex/governance-test"],
          },
          {},
        ),
      (error) => assertCode(error, "APPROVAL_SCOPE_MISMATCH"),
    );

    const consumed = approvalService.authorizeAction(
      approved.reference,
      {
        project_id: expected.project_id,
        target_task_id: expected.target_task_id,
        action: "git.remote.push",
        targets: ["origin/codex/governance-test"],
      },
      { command: "git push" },
    );
    assert.equal(consumed.status, "consumed");
    assert.equal(consumed.usage_count, 1);
    const duplicate = approvalService.consume(
      approved.reference,
      expected,
      { command: "git push" },
    );
    assert.equal(duplicate.usage_count, 1);
    assert.throws(
      () =>
        approvalService.validateAuthorization(
          { ...approved.reference, idempotency_key: "consume-2" },
          expected,
        ),
      (error) => assertCode(error, "APPROVAL_ALREADY_CONSUMED"),
    );

    const second = approve(
      service(root, { now: () => now }),
      input({
        source_message_id: "message-admin-2",
        expires_at: "2026-07-31T00:30:00.000Z",
      }),
      "2",
    );
    now = new Date("2026-07-31T02:00:00.000Z");
    assert.throws(
      () =>
        service(root, { now: () => now }).validateAuthorization(
          second.reference,
          {
            project_id: second.governance.project_id,
            target_task_id: second.governance.target_task_id,
            scope_digest: second.governance.scope_digest,
            content_hash: second.governance.content_hash,
          },
        ),
      (error) => assertCode(error, "APPROVAL_EXPIRED"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejection and revocation remain explicit terminal authorization states", () => {
  const root = tempRoot();
  try {
    const approvalService = service(root);
    const rejectedDraft = approvalService.writeDraft(
      input({ source_message_id: "message-reject" }),
      { idempotencyKey: "draft-reject" },
    );
    const rejectedPending = approvalService.submit(
      rejectedDraft.governance_id,
      1,
      "PM",
      "submit-reject",
    );
    const rejected = approvalService.decide({
      governanceId: rejectedPending.governance_id,
      revision: 1,
      approvalId: rejectedPending.approval_id!,
      actor: "ADMIN",
      decision: "rejected",
      reason: "范围过宽",
      sourceUiActionId: "ui-action-reject",
      idempotencyKey: "decision-reject",
    });
    assert.equal(rejected.governance.status, "rejected");
    assert.throws(
      () =>
        approvalService.validateAuthorization(
          {
            governance_id: rejected.governance.governance_id,
            revision: rejected.governance.revision,
            approval_id: rejected.governance.approval_id!,
            decision_id: rejected.decision.decision_id,
            lease_id: "LEASE-NOT-ISSUED-FOR-REJECTION",
            scope_digest: rejected.governance.scope_digest,
            content_hash: rejected.governance.content_hash,
            idempotency_key: "consume-rejected",
          },
          {
            project_id: rejected.governance.project_id,
            target_task_id: rejected.governance.target_task_id,
            scope_digest: rejected.governance.scope_digest,
          },
        ),
      (error) => assertCode(error, "APPROVAL_REJECTED"),
    );

    const approved = approve(
      approvalService,
      input({ source_message_id: "message-revoke" }),
      "revoke",
    );
    const revoked = approvalService.revoke({
      governanceId: approved.governance.governance_id,
      revision: 1,
      actor: "ADMIN",
      reason: "外部环境发生变化",
      sourceUiActionId: "ui-action-revoke",
      idempotencyKey: "revoke-action",
    });
    assert.equal(revoked.governance.status, "revoked");
    assert.throws(
      () =>
        approvalService.validateAuthorization(approved.reference, {
          project_id: approved.governance.project_id,
          target_task_id: approved.governance.target_task_id,
          scope_digest: approved.governance.scope_digest,
        }),
      (error) => assertCode(error, "APPROVAL_REVOKED"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tampering after approval is detected and the runtime index can be rebuilt", () => {
  const root = tempRoot();
  try {
    const approvalService = service(root);
    const approved = approve(approvalService);
    const tampered = readFileSync(approved.governance.path, "utf-8").replace(
      "git.remote.push",
      "release.publish",
    );
    writeFileSync(approved.governance.path, tampered, "utf-8");
    assert.throws(
      () =>
        approvalService.validateAuthorization(approved.reference, {
          project_id: approved.governance.project_id,
          target_task_id: approved.governance.target_task_id,
          scope_digest: approved.governance.scope_digest,
          content_hash: approved.governance.content_hash,
        }),
      (error) => assertCode(error, "APPROVAL_SCOPE_MISMATCH"),
    );

    const rebuilt = approvalService.rebuildIndex();
    assert.equal(rebuilt.count, 1);
    assert.match(
      readFileSync(rebuilt.path, "utf-8"),
      new RegExp(approved.governance.governance_id),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
