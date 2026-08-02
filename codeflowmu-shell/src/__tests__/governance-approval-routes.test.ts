import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import express from "express";
import request from "supertest";

import { fcopChatPathForDate } from "../chat-paths.ts";
import { registerGovernanceApprovalRoutes } from "../governance-approval-routes.ts";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "cfm-governance-routes-"));
  const taskDir = join(root, "fcop", "_lifecycle", "active");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, "TASK-20260731-100-ADMIN-to-PM.md"),
    "---\ntask_id: TASK-20260731-100-ADMIN-to-PM\nthread_key: route-test\n---\n# Task\n",
    "utf-8",
  );
  const chatPath = fcopChatPathForDate(root);
  mkdirSync(join(root, "fcop", "chat"), { recursive: true });
  appendFileSync(
    chatPath,
    `${JSON.stringify({
      id: "CHAT-ROUTE-1",
      role: "admin",
      agentId: "PM-01",
      text: "允许在指定范围执行一次外部写入",
      ts: "2026-07-31T00:00:00.000Z",
      session_id: "CHAT-ROUTE-1",
      project_id: "project-route-test",
      task_ids: ["TASK-20260731-100-ADMIN-to-PM"],
    })}\n`,
    "utf-8",
  );
  return root;
}

function recordBody() {
  return {
    actor: "PM-01",
    type: "AUTHORIZATION",
    recipient: "DEV",
    target_task_id: "TASK-20260731-100-ADMIN-to-PM",
    thread_key: "route-test",
    project_id: "project-route-test",
    source_kind: "admin_chat",
    source_message_id: "CHAT-ROUTE-1",
    source_session_id: "CHAT-ROUTE-1",
    intent_summary: "允许执行一次指定范围内的外部写入",
    boundary_summary: "仅限指定任务和目标",
    allowed_actions: ["git.remote.push"],
    prohibited_actions: ["release.publish"],
    targets: ["origin/codex/governance"],
    effective_conditions: ["scope and hash match"],
    usage_limit: 1,
    risk_and_rollback: "失败时停止并保留证据",
    revocation_conditions: ["ADMIN revokes"],
    evidence_requirements: ["remote ref"],
    blocks_task: true,
  };
}

function appFor(root: string) {
  const app = express();
  app.use(express.json());
  registerGovernanceApprovalRoutes(app, {
    projectRoot: () => root,
    projectId: () => "project-route-test",
  });
  return app;
}

test("PM formalization and ADMIN decision share one durable approval source", async () => {
  const root = fixture();
  try {
    const app = appFor(root);
    const drafted = await request(app)
      .post("/api/v2/pm/governance/records")
      .send({ ...recordBody(), idempotency_key: "route-draft-1" })
      .expect(201);
    const record = drafted.body.record as {
      governance_id: string;
      revision: number;
      status: string;
    };
    assert.equal(record.status, "draft");

    const submitted = await request(app)
      .post(
        `/api/v2/pm/governance/records/${record.governance_id}/1/submit`,
      )
      .send({ actor: "PM-01", idempotency_key: "route-submit-1" })
      .expect(202);
    assert.equal(submitted.body.governance.status, "pending_approval");
    assert.equal(submitted.body.approval_card.can_decide, true);

    const pendingAfterRestart = await request(appFor(root))
      .get("/api/v2/governance/records?status=pending_approval")
      .expect(200);
    assert.equal(pendingAfterRestart.body.records.length, 1);

    const ordinaryChatAttempt = await request(app)
      .post(
        `/api/v2/admin/governance/approvals/${record.governance_id}/1/decide`,
      )
      .send({
        actor: "ADMIN",
        approval_id: submitted.body.governance.approval_id,
        decision: "approved",
        reason: "可以",
        source_ui_action_id: "",
        idempotency_key: "route-chat-attempt",
      })
      .expect(400);
    assert.equal(
      ordinaryChatAttempt.body.code,
      "GOVERNANCE_SCHEMA_INVALID",
    );

    const decided = await request(app)
      .post(
        `/api/v2/admin/governance/approvals/${record.governance_id}/1/decide`,
      )
      .send({
        actor: "ADMIN",
        approval_id: submitted.body.governance.approval_id,
        decision: "approved",
        reason: "范围和回滚条件已确认",
        source_ui_action_id: "desktop-approval-click-1",
        idempotency_key: "route-decision-1",
      })
      .expect(200);
    assert.equal(decided.body.governance.status, "effective");
    assert.equal(decided.body.decision.decision, "approved");
    assert.equal(decided.body.approval_card.can_decide, false);

    assert.equal(
      existsSync(
        join(
          root,
          "fcop",
          "governance",
          "decisions",
          `${decided.body.decision.decision_id}.md`,
        ),
      ),
      true,
    );
    const detail = await request(appFor(root))
      .get(`/api/v2/governance/records/${record.governance_id}/1`)
      .expect(200);
    assert.equal(detail.body.record.status, "effective");
    assert.equal(detail.body.decisions.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-ADMIN chat source cannot enter pending approval", async () => {
  const root = fixture();
  try {
    const chatPath = fcopChatPathForDate(root);
    appendFileSync(
      chatPath,
      `${JSON.stringify({
        id: "CHAT-FORGED",
        role: "agent",
        session_id: "CHAT-FORGED",
        project_id: "project-route-test",
        task_ids: ["TASK-20260731-100-ADMIN-to-PM"],
      })}\n`,
      "utf-8",
    );
    const app = appFor(root);
    const drafted = await request(app)
      .post("/api/v2/pm/governance/records")
      .send({
        ...recordBody(),
        source_message_id: "CHAT-FORGED",
        source_session_id: "CHAT-FORGED",
      })
      .expect(201);
    const response = await request(app)
      .post(
        `/api/v2/pm/governance/records/${drafted.body.record.governance_id}/1/submit`,
      )
      .send({ actor: "PM-01" })
      .expect(403);
    assert.equal(response.body.code, "ABSOLUTELY_PROHIBITED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
