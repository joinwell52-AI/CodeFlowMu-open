import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FactCheckDecisionError,
  FactCheckDecisionService,
} from "../FactCheckDecisionService.ts";

async function project(reviewState: string): Promise<{ root: string; taskId: string }> {
  const root = await mkdtemp(join(tmpdir(), "cfm-review-decision-"));
  const taskId = "TASK-20260805-001";
  const dir = join(root, "fcop", "reviews");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `REVIEW-20260805-001-REVIEW-GATE-on-${taskId}.md`),
    `---\nreview_id: REVIEW-20260805-001-REVIEW-GATE\ntask_id: ${taskId}\nreview_state: ${reviewState}\nfact_check_verdict: fail\n---\n# Review\n`,
  );
  return { root, taskId };
}

test("PM can overrule an erroneous needs_pm auto review idempotently", async () => {
  const { root, taskId } = await project("needs_pm");
  try {
    const service = new FactCheckDecisionService(root);
    const input = {
      taskId,
      action: "overrule_auto_review" as const,
      actor: "PM" as const,
      reason: "The contract does not require browser evidence.",
      idempotencyKey: "decision-1",
    };
    const first = await service.decide(input);
    const replay = await service.decide(input);
    assert.equal(first.idempotent, false);
    assert.equal(replay.idempotent, true);
    assert.equal(replay.record.actor, "PM");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PM cannot overrule a deterministic evidence failure", async () => {
  const { root, taskId } = await project("deterministic_fail");
  try {
    await assert.rejects(
      () => new FactCheckDecisionService(root).decide({
        taskId,
        action: "overrule_auto_review",
        actor: "PM",
        reason: "Ignore the failed command.",
        idempotencyKey: "decision-2",
      }),
      (error: unknown) =>
        error instanceof FactCheckDecisionError &&
        error.code === "FACT_CHECK_DETERMINISTIC_FAILURE_NOT_OVERRULABLE",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("overrule replay converges stale rework and blocking issue projections", async () => {
  const { root, taskId } = await project("needs_pm");
  const reportId = "REPORT-20260805-001-QA-to-PM";
  try {
    const reviewPath = join(
      root,
      "fcop",
      "reviews",
      `REVIEW-20260805-001-REVIEW-GATE-on-${taskId}.md`,
    );
    await writeFile(
      reviewPath,
      `---\nreview_id: REVIEW-20260805-001-REVIEW-GATE\ntask_id: ${taskId}\nreport_id: ${reportId}\nreview_state: needs_pm\n---\n# Review\n`,
    );
    const active = join(root, "fcop", "_lifecycle", "active");
    const inbox = join(root, "fcop", "_lifecycle", "inbox");
    const issues = join(root, "fcop", "issues");
    await Promise.all([mkdir(active, { recursive: true }), mkdir(inbox, { recursive: true }), mkdir(issues, { recursive: true })]);
    const rootPath = join(active, `${taskId}-ADMIN-to-PM.md`);
    const reworkPath = join(inbox, "TASK-20260805-002-PM-to-QA-rework-1.md");
    const issuePath = join(issues, "ISSUE-20260805-001-REPORT-action.md");
    await writeFile(rootPath, `---\ntask_id: ${taskId}\npm_attention_reason: stale\nissue_blocking: true\nblocking_issue_id: ISSUE-1\n---\n# root\n`);
    await writeFile(reworkPath, `---\ntask_id: TASK-20260805-002\nsource_report: ${reportId}\nrework_key: rework-1\ndispatch_state: ready\n---\n# rework\n`);
    await writeFile(issuePath, `---\nissue_id: ISSUE-20260805-001\nreport_id: ${reportId}\nblocking: true\n---\n# issue\n`);

    const service = new FactCheckDecisionService(root);
    const input = {
      taskId,
      action: "overrule_auto_review" as const,
      actor: "PM" as const,
      reason: "The auto-review added an acceptance requirement not present in the contract.",
      idempotencyKey: "decision-converge",
    };
    const first = await service.decide(input);
    const replay = await service.decide(input);
    assert.deepEqual(first.projection.rework_tasks_cancelled, ["TASK-20260805-002"]);
    assert.deepEqual(first.projection.blocking_issues_resolved, ["ISSUE-20260805-001"]);
    assert.equal(replay.idempotent, true);
    assert.match(await readFile(rootPath, "utf8"), /fact_check_exception: true/);
    assert.match(await readFile(reworkPath, "utf8"), /dispatch_state: cancelled/);
    assert.match(await readFile(issuePath, "utf8"), /resolution_status: resolved/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
