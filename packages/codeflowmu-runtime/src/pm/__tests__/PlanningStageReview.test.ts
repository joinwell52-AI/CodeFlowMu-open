import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { LedgerReportRecord, LedgerTaskRecord } from "../../ledger/types.ts";
import type { PlanningReviewSnapshot } from "../LongHorizonPlanning.ts";
import {
  currentPlanningGrants,
  issuePlanningGrant,
  planningGrantsAllow,
  revokePlanningGrants,
} from "../PlanningGrantStore.ts";
import { evaluatePlanningStageReview } from "../PlanningStageReview.ts";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

function task(wpId: string, bucket: "active" | "done"): LedgerTaskRecord {
  return {
    task_id: `TASK-${wpId}`,
    filename: `TASK-${wpId}.md`,
    sender: "PM",
    recipient: "DEV",
    bucket,
    path: `fcop/${bucket}/TASK-${wpId}.md`,
    created_at: "2026-08-07T10:00:00+08:00",
    updated_at: "2026-08-07T10:00:00+08:00",
    timezone: "Asia/Shanghai",
    created_at_utc: "2026-08-07T02:00:00Z",
    yaml: { wp_id: wpId },
  };
}

function report(wpId: string): LedgerReportRecord {
  return {
    report_id: `REPORT-${wpId}`,
    task_id: `TASK-${wpId}`,
    filename: `REPORT-${wpId}.md`,
    sender: "DEV",
    recipient: "PM",
    status: "done",
    valid: true,
    path: `fcop/reports/REPORT-${wpId}.md`,
    created_at: "2026-08-07T10:00:00+08:00",
    updated_at: "2026-08-07T10:00:00+08:00",
    timezone: "Asia/Shanghai",
    created_at_utc: "2026-08-07T02:00:00Z",
  };
}

const snapshot: PlanningReviewSnapshot = {
  task_id: "TASK-ROOT",
  thread_key: "thread-root",
  body_digest: DIGEST_A,
  validation_digest: DIGEST_B,
  captured_at: "2026-08-07T10:00:00+08:00",
  work_packages: [
    { id: "WP-00", title: "契约冻结", dependencies: [] },
    { id: "WP-01", title: "运行时", dependencies: ["WP-00"], recommended_next: true },
    { id: "WP-02", title: "面板", dependencies: ["WP-00"] },
    { id: "WP-04", title: "条件实验", dependencies: ["WP-00"], conditional: true, trigger_condition: "线上指标下降" },
  ],
  gates: [],
};

test("stage review exposes only dependency/evidence eligible WPs and does not default-select all", () => {
  const grant = {
    record_type: "planning_grant" as const,
    grant_id: "GRANT-00",
    root_task_id: "TASK-ROOT",
    brief_revision: 1,
    brief_digest: DIGEST_A,
    validation_digest: DIGEST_B,
    approved_wp_scope: ["WP-00"],
    child_contract_digest: DIGEST_B,
    decision_id: "DECISION-00",
    approved_at: "2026-08-07T10:00:00+08:00",
    approver: "ADMIN" as const,
    status: "active" as const,
  };
  const stage = evaluatePlanningStageReview({
    snapshot,
    tasks: [task("WP-00", "done")],
    reports: [report("WP-00")],
    grants: [grant],
  });
  assert.equal(stage.review_mode, "stage");
  assert.equal(stage.pending_label, "待阶段审批");
  assert.equal(stage.stage_pending, true);
  assert.deepEqual(stage.selectable_wp_scope, ["WP-01", "WP-02"]);
  assert.deepEqual(stage.recommended_wp_scope, ["WP-01"]);
  assert.equal(stage.work_packages.find((wp) => wp.wp_id === "WP-04")?.status, "condition_unmet");
  assert.deepEqual(stage.prerequisite_evidence, ["REPORT-WP-00"]);
});

test("Planning Grants are append-only, cumulative, revision-bound, revocable, and reject wildcard scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-planning-grants-"));
  try {
    const first = await issuePlanningGrant({
      projectRoot: root, rootTaskId: "TASK-ROOT", briefRevision: 1, briefDigest: DIGEST_A,
      validationDigest: DIGEST_B, approvedWpScope: ["WP-00"], childContractDigest: DIGEST_B,
      decisionId: "D-1", approvedAt: "2026-08-07T10:00:00Z", grantKind: "initial_wp00",
    });
    const second = await issuePlanningGrant({
      projectRoot: root, rootTaskId: "TASK-ROOT", briefRevision: 1, briefDigest: DIGEST_A,
      validationDigest: DIGEST_B, approvedWpScope: ["WP-01", "WP-02"], childContractDigest: DIGEST_B,
      decisionId: "D-2", approvedAt: "2026-08-07T11:00:00Z", grantKind: "stage",
      prerequisiteEvidence: ["REPORT-WP-00"],
    });
    const current = await currentPlanningGrants(root, "TASK-ROOT", { briefRevision: 1, briefDigest: DIGEST_A, validationDigest: DIGEST_B });
    assert.equal(planningGrantsAllow(current, "WP-00"), true);
    assert.equal(planningGrantsAllow(current, "WP-02"), true);
    assert.equal(planningGrantsAllow(current, "WP-04"), false);
    const stale = await currentPlanningGrants(root, "TASK-ROOT", { briefRevision: 2, briefDigest: DIGEST_A, validationDigest: DIGEST_B });
    assert.equal(stale.every((grant) => grant.status === "stale"), true);
    await revokePlanningGrants({ projectRoot: root, rootTaskId: "TASK-ROOT", grantIds: [second.grant_id], reason: "暂停未执行阶段" });
    const afterRevoke = await currentPlanningGrants(root, "TASK-ROOT");
    assert.deepEqual(afterRevoke.map((grant) => grant.grant_id), [first.grant_id]);
    await assert.rejects(() => issuePlanningGrant({
      projectRoot: root, rootTaskId: "TASK-ROOT", briefRevision: 1, briefDigest: DIGEST_A,
      validationDigest: DIGEST_B, approvedWpScope: ["*"], childContractDigest: DIGEST_B,
      decisionId: "D-3", approvedAt: "2026-08-07T12:00:00Z",
    }), /non-wildcard/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
