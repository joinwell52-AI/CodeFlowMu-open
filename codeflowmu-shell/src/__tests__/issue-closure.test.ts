import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import { parseMarkdownFrontmatter } from "@codeflowmu/runtime";
import type { OperationApprovalRecord } from "@codeflowmu/runtime";

import {
  digestIssueClosureText,
  IssueClosureError,
  IssueClosureService,
} from "../issue-closure.ts";
import {
  buildIssueGithubApprovalInput,
  exportIssuePromotionBundle,
  generateIssuePromotionBundle,
  listIssuePromotions,
  loadIssuePromotionConfig,
  prepareIssueGithubApprovalInput,
  publishIssuePromotionWithExecutor,
  readIssuePromotion,
  inspectPublicIssueDraft,
  syncIssuePromotionApprovalStatus,
  validateGithubIssueTargetMetadata,
} from "../issue-promotion.ts";

const ISSUE_FILENAME = "ISSUE-20260804-001-PM.md";
const ISSUE_ID = "ISSUE-20260804-001-PM";
const TASK_ID = "TASK-20260804-001-PM-to-DEV";

function issueMarkdown(overrides: Record<string, unknown> = {}): string {
  const fm = {
    protocol: "fcop",
    kind: "issue",
    issue_id: ISSUE_ID,
    sender: "PM",
    recipient: "DEV",
    source_task: TASK_ID,
    status: "open",
    severity: "high",
    ...overrides,
  };
  return `---\n${Object.entries(fm).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n# Runtime lifecycle split\n\n## Problem\n\nThe session ended while the task remained blocked, so lifecycle state diverged.\n\n## Reproduction\n\nEnd the session while its linked task is blocked and run startup reconciliation.\n\n## Evidence\n\nThe session is closed but the linked task remains active and blocked.\n\n## Impact\n\nThe panel and runtime disagree and automatic approval cannot continue.\n\n## Suggested action\n\nCommit Session and TASK lifecycle transitions atomically and add a regression test.\n`;
}

function taskMarkdown(blocked = true): string {
  return `---
protocol: fcop
kind: task
task_id: ${TASK_ID}
state: active
issue_blocking: ${blocked}
blocking_issue_id: ${blocked ? ISSUE_ID : ""}
blocking_issue_reason: ${blocked ? "runtime lifecycle split" : ""}
---

# Task
`;
}

async function fixture(options: { blocked?: boolean; issue?: Record<string, unknown> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "cfm-issue-closure-"));
  const issues = join(root, "fcop", "issues");
  const active = join(root, "fcop", "_lifecycle", "active");
  mkdirSync(issues, { recursive: true });
  mkdirSync(active, { recursive: true });
  const issuePath = join(issues, ISSUE_FILENAME);
  const taskPath = join(active, `${TASK_ID}.md`);
  writeFileSync(issuePath, issueMarkdown(options.issue), "utf8");
  writeFileSync(taskPath, taskMarkdown(options.blocked ?? true), "utf8");
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ repository: { url: "https://github.com/joinwell52-AI/codeflowmu.git" } }, null, 2)}\n`, "utf8");
  mkdirSync(join(root, ".codeflowmu"), { recursive: true });
  writeFileSync(join(root, ".codeflowmu", "issue-promotion-target.json"), `${JSON.stringify({ target_repo: "joinwell52-AI/CodeFlowMu-open", visibility_policy: "public_issue", labels: [] }, null, 2)}\n`, "utf8");
  return {
    root,
    issuePath,
    taskPath,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function validDraft(issuePath: string, overrides: Record<string, unknown> = {}) {
  return {
    actor: "ADMIN",
    idempotency_key: "close-001",
    expected_issue_digest: digestIssueClosureText(readFileSync(issuePath, "utf8")),
    resolution_type: "mitigated",
    root_cause_status: "not_fixed",
    root_cause_category: "runtime.lifecycle_state_split",
    root_cause_summary: "Session and TASK lifecycle transitions were not committed together.",
    reason: "Runtime restart restored the current event, but the underlying race can recur.",
    recovery_action: "Restart Runtime and run startup reconciliation.",
    verification_summary: "The task returned to active state and the report was observed.",
    evidence: [{ type: "session", ref: "session-test-1" }],
    residual_risk: "The same lifecycle split may recur before the mother fix is delivered.",
    follow_up_required: true,
    follow_up_target: "CodeFlowMu",
    follow_up_reference: "mother runtime lifecycle fix",
    reopen_conditions: ["The lifecycle split recurs"],
    unblock_task: false,
    promote_to_mother: true,
    ...overrides,
  };
}

async function expectCode(action: () => unknown | Promise<unknown>, code: string) {
  await assert.rejects(Promise.resolve().then(action), (error: unknown) => error instanceof IssueClosureError && error.code === code);
}

test("legacy naked close is rejected with recoverable 422 contract", async () => {
  const f = await fixture();
  try {
    const service = new IssueClosureService({ projectRoot: f.root });
    await assert.rejects(
      () => service.close(ISSUE_FILENAME, { closed_by: "ADMIN" }),
      (error: unknown) => error instanceof IssueClosureError && error.code === "ISSUE_CLOSURE_DETAILS_REQUIRED" && error.httpStatus === 422,
    );
    assert.equal(parseMarkdownFrontmatter(readFileSync(f.issuePath, "utf8")).status, "open");
  } finally { await f.cleanup(); }
});

test("preview validates the decision and writes no files", async () => {
  const f = await fixture();
  try {
    const beforeIssue = readFileSync(f.issuePath, "utf8");
    const beforeTask = readFileSync(f.taskPath, "utf8");
    const preview = new IssueClosureService({ projectRoot: f.root }).preview(ISSUE_FILENAME, validDraft(f.issuePath));
    assert.match(preview.closure_digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(preview.task_unblock.requested, false);
    assert.equal(readFileSync(f.issuePath, "utf8"), beforeIssue);
    assert.equal(readFileSync(f.taskPath, "utf8"), beforeTask);
    assert.equal(existsSync(join(f.root, "fcop", "internal", "issue-closures")), false);
  } finally { await f.cleanup(); }
});

test("simple close accepts only type and any non-empty reason without touching TASK or Session state", async () => {
  const f = await fixture();
  try {
    const taskBefore = readFileSync(f.taskPath, "utf8");
    const service = new IssueClosureService({ projectRoot: f.root });
    const result = await service.close(ISSUE_FILENAME, {
      closure_mode: "simple",
      actor: "ADMIN",
      idempotency_key: "simple-close-001",
      expected_issue_digest: digestIssueClosureText(readFileSync(f.issuePath, "utf8")),
      resolution_type: "development_fix",
      reason: "修",
      unblock_task: true,
      recovery_action: "must be ignored in simple mode",
      promote_to_mother: false,
    });
    assert.equal(result.status, "closed");
    assert.equal(result.task_side_effect.status, "not_requested");
    assert.equal(readFileSync(f.taskPath, "utf8"), taskBefore);
    const closure = parseMarkdownFrontmatter(readFileSync(join(f.root, ...result.closure_record.split("/")), "utf8"));
    assert.equal(closure.closure_mode, "simple");
    assert.equal(closure.root_cause_status, "unknown");
    assert.equal(closure.unblock_task, false);
  } finally { await f.cleanup(); }
});

test("dynamic closure validation rejects incomplete fixed, mitigated and duplicate decisions", async () => {
  const f = await fixture();
  try {
    const service = new IssueClosureService({ projectRoot: f.root });
    await expectCode(() => service.close(ISSUE_FILENAME, validDraft(f.issuePath, {
      reason: "",
    })), "ISSUE_CLOSURE_DETAILS_REQUIRED");
    await expectCode(() => service.close(ISSUE_FILENAME, validDraft(f.issuePath, {
      resolution_type: "fixed",
      root_cause_status: "fixed",
      residual_risk: "",
      follow_up_required: false,
      promote_to_mother: false,
    })), "ISSUE_FIXED_EVIDENCE_REQUIRED");
    await expectCode(() => service.close(ISSUE_FILENAME, validDraft(f.issuePath, {
      residual_risk: "",
      follow_up_required: false,
      promote_to_mother: false,
    })), "ISSUE_RESIDUAL_RISK_FOLLOW_UP_REQUIRED");
    await expectCode(() => service.close(ISSUE_FILENAME, validDraft(f.issuePath, {
      resolution_type: "duplicate",
      residual_risk: "",
      follow_up_required: false,
      follow_up_reference: "",
      promote_to_mother: false,
    })), "ISSUE_REPLACEMENT_TARGET_REQUIRED");
  } finally { await f.cleanup(); }
});

test("missing file evidence is rejected instead of being treated as verified", async () => {
  const f = await fixture();
  try {
    await expectCode(
      () => new IssueClosureService({ projectRoot: f.root }).close(
        ISSUE_FILENAME,
        validDraft(f.issuePath, { evidence: [{ type: "path", ref: "evidence/missing.txt" }] }),
      ),
      "ISSUE_EVIDENCE_NOT_FOUND",
    );
  } finally { await f.cleanup(); }
});

test("close writes immutable closure and projection but does not implicitly unblock TASK", async () => {
  const f = await fixture();
  try {
    const taskBefore = readFileSync(f.taskPath, "utf8");
    const service = new IssueClosureService({ projectRoot: f.root });
    const preview = service.preview(ISSUE_FILENAME, validDraft(f.issuePath));
    const result = await service.close(ISSUE_FILENAME, validDraft(f.issuePath, { expected_closure_digest: preview.closure_digest }));
    assert.equal(result.idempotent, false);
    assert.equal(result.task_side_effect.status, "not_requested");
    assert.equal(readFileSync(f.taskPath, "utf8"), taskBefore);
    const issueFm = parseMarkdownFrontmatter(readFileSync(f.issuePath, "utf8"));
    assert.equal(issueFm.status, "closed");
    assert.equal(issueFm.root_cause_status, "not_fixed");
    assert.equal(issueFm.closure_digest, result.closure_digest);
    const closureRaw = readFileSync(join(f.root, ...result.closure_record.split("/")), "utf8");
    assert.match(closureRaw, /## Residual risk/);
    assert.match(closureRaw, /idempotency_key: close-001/);
  } finally { await f.cleanup(); }
});

test("same idempotency key replays one closure and conflicting body is rejected", async () => {
  const f = await fixture();
  try {
    const service = new IssueClosureService({ projectRoot: f.root });
    const draft = validDraft(f.issuePath);
    const first = await service.close(ISSUE_FILENAME, draft);
    const replay = await service.close(ISSUE_FILENAME, draft);
    assert.equal(replay.idempotent, true);
    assert.equal(replay.closure_id, first.closure_id);
    await expectCode(() => service.close(ISSUE_FILENAME, { ...draft, reason: "A different closure decision with the same key." }), "IDEMPOTENCY_CONFLICT");
    const files = readdirSync(join(f.root, ...first.closure_record.split("/").slice(0, -1)));
    assert.equal(files.filter((name) => name.endsWith(".md")).length, 1);
  } finally { await f.cleanup(); }
});

test("concurrent distinct closure decisions commit exactly one immutable attempt", async () => {
  const f = await fixture();
  try {
    const service = new IssueClosureService({ projectRoot: f.root });
    const first = validDraft(f.issuePath, { idempotency_key: "concurrent-a" });
    const second = validDraft(f.issuePath, {
      idempotency_key: "concurrent-b",
      reason: "A competing operator proposed a different closure decision.",
    });
    const outcomes = await Promise.allSettled([
      service.close(ISSUE_FILENAME, first),
      service.close(ISSUE_FILENAME, second),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
    const committed = outcomes.find(
      (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<IssueClosureService["close"]>>> =>
        outcome.status === "fulfilled",
    );
    assert.ok(committed);
    const closureDir = join(f.root, ...committed.value.closure_record.split("/").slice(0, -1));
    assert.equal(readdirSync(closureDir).filter((name) => name.endsWith(".md")).length, 1);
    assert.equal(parseMarkdownFrontmatter(readFileSync(f.issuePath, "utf8")).status, "closed");
    assert.equal(existsSync(join(f.root, ".codeflowmu", "issue-closure-locks", `${ISSUE_FILENAME}.lock`)), false);
  } finally { await f.cleanup(); }
});

test("issue change after preview returns digest conflict", async () => {
  const f = await fixture();
  try {
    const draft = validDraft(f.issuePath);
    writeFileSync(f.issuePath, `${readFileSync(f.issuePath, "utf8")}\nexternal change\n`, "utf8");
    await expectCode(() => new IssueClosureService({ projectRoot: f.root }).close(ISSUE_FILENAME, draft), "ISSUE_CHANGED_REVIEW_AGAIN");
  } finally { await f.cleanup(); }
});

test("explicit TASK unblock returns exact governance receipt without lifecycle migration", async () => {
  const f = await fixture();
  try {
    const service = new IssueClosureService({ projectRoot: f.root });
    const draft = validDraft(f.issuePath, {
      unblock_task: true,
      unblock_reason: "The task is active and the recovery report exists.",
      evidence: [{ type: "task", ref: TASK_ID }],
    });
    const preview = service.preview(ISSUE_FILENAME, draft);
    assert.equal(preview.task_unblock.lifecycle, "active");
    assert.equal(preview.task_unblock.will_write, true);
    assert.equal(preview.task_unblock.diff?.issue_blocking?.to, false);
    const result = await service.close(ISSUE_FILENAME, { ...draft, expected_closure_digest: preview.closure_digest });
    assert.equal(result.task_side_effect.executor, "task_governance.issue_blocker.clear");
    const taskFm = parseMarkdownFrontmatter(readFileSync(f.taskPath, "utf8"));
    assert.equal(taskFm.issue_blocking, false);
    assert.equal(taskFm.blocking_issue_id, "");
    assert.equal(taskFm.state, "active");
  } finally { await f.cleanup(); }
});

test("already recovered TASK is recorded without a redundant write", async () => {
  const f = await fixture({ blocked: false });
  try {
    const taskBefore = readFileSync(f.taskPath, "utf8");
    const result = await new IssueClosureService({ projectRoot: f.root }).close(ISSUE_FILENAME, validDraft(f.issuePath, {
      unblock_task: true,
      unblock_reason: "Runtime already reconciled the task.",
      evidence: [{ type: "task", ref: TASK_ID }],
    }));
    assert.equal(result.task_side_effect.status, "already_recovered");
    assert.equal(readFileSync(f.taskPath, "utf8"), taskBefore);
  } finally { await f.cleanup(); }
});

for (const fault of ["after_closure_record", "after_issue_projection", "before_task_unblock", "after_task_unblock"] as const) {
  test(`transaction rolls back all files on ${fault}`, async () => {
    const f = await fixture();
    try {
      const issueBefore = readFileSync(f.issuePath, "utf8");
      const taskBefore = readFileSync(f.taskPath, "utf8");
      const service = new IssueClosureService({
        projectRoot: f.root,
        now: () => new Date("2026-08-04T05:00:00.000Z"),
        faultInjector(point) { if (point === fault) throw new Error(`fault:${fault}`); },
      });
      const draft = validDraft(f.issuePath, {
        unblock_task: true,
        unblock_reason: "Recovery evidence allows explicit unblock.",
        evidence: [{ type: "task", ref: TASK_ID }],
      });
      await assert.rejects(() => service.close(ISSUE_FILENAME, draft), new RegExp(`fault:${fault}`));
      assert.equal(readFileSync(f.issuePath, "utf8"), issueBefore);
      assert.equal(readFileSync(f.taskPath, "utf8"), taskBefore);
      const closureDir = join(f.root, "fcop", "internal", "issue-closures", "20260804");
      assert.equal(existsSync(closureDir) ? readdirSync(closureDir).filter((name) => name.endsWith(".md")).length : 0, 0);
      assert.equal(existsSync(join(f.root, ".codeflowmu", "issue-closure-locks", `${ISSUE_FILENAME}.lock`)), false);
    } finally { await f.cleanup(); }
  });
}

test("reopen preserves attempt one and a second closure creates attempt two", async () => {
  const f = await fixture();
  try {
    const service = new IssueClosureService({ projectRoot: f.root, now: () => new Date("2026-08-04T05:00:00.000Z") });
    const first = await service.close(ISSUE_FILENAME, validDraft(f.issuePath));
    const issueAfterClose = readFileSync(f.issuePath, "utf8");
    await service.reopen(ISSUE_FILENAME, {
      actor: "ADMIN",
      reason: "The same lifecycle split occurred again.",
      expected_issue_digest: digestIssueClosureText(issueAfterClose),
      idempotency_key: "reopen-001",
    });
    const reopenedFm = parseMarkdownFrontmatter(readFileSync(f.issuePath, "utf8"));
    assert.equal(reopenedFm.status, "reopened");
    assert.equal(reopenedFm.closure_digest, first.closure_digest);
    const secondDraft = validDraft(f.issuePath, { idempotency_key: "close-002" });
    const second = await service.close(ISSUE_FILENAME, secondDraft);
    assert.equal(second.attempt, 2);
    const history = service.history(ISSUE_FILENAME) as { closures: Array<Record<string, unknown>>; events: Array<Record<string, unknown>> };
    assert.equal(history.closures.length, 2);
    assert.ok(history.events.some((event) => event.event === "issue.reopened"));
  } finally { await f.cleanup(); }
});

test("legacy closed issue is labeled without fabricating a closure", async () => {
  const f = await fixture({ issue: { status: "closed", closed_by: "ADMIN", closed_at: "2026-07-01" } });
  try {
    const detail = new IssueClosureService({ projectRoot: f.root }).detail(ISSUE_FILENAME);
    assert.equal(detail.legacy_simple_closure, true);
    assert.equal(detail.current_closure, null);
    assert.deepEqual(detail.closure_history, []);
  } finally { await f.cleanup(); }
});

test("local promotion produces a deduplicated redacted evidence bundle and no external write", async () => {
  const f = await fixture();
  try {
    const service = new IssueClosureService({ projectRoot: f.root });
    const closed = await service.close(ISSUE_FILENAME, validDraft(f.issuePath));
    const bundle = await generateIssuePromotionBundle({
      projectRoot: f.root,
      filename: ISSUE_FILENAME,
      actor: "ADMIN",
      expected_closure_digest: closed.closure_digest,
    });
    assert.equal(bundle.status, "draft_created");
    assert.equal(bundle.target_repo.toLowerCase(), "joinwell52-ai/codeflowmu-open");
    assert.equal((bundle as unknown as Record<string, unknown>).visibility_policy, "public_issue");
    assert.equal(existsSync(join(f.root, ...bundle.bundle_path.split("/"), "manifest.json")), true);
    assert.doesNotMatch(bundle.draft_body, /[A-Za-z]:\\/);
    const replay = await generateIssuePromotionBundle({ projectRoot: f.root, filename: ISSUE_FILENAME, actor: "ADMIN", expected_closure_digest: closed.closure_digest });
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.promotion_id, bundle.promotion_id);
    const approval = buildIssueGithubApprovalInput({ projectRoot: f.root, promotion_id: bundle.promotion_id, actor: "ADMIN" });
    assert.equal(approval.request.action.executor, "github.issue.create");
    assert.equal(approval.request.effect.external_write, true);
    assert.match(approval.reason, /joinwell52-AI\/CodeFlowMu-open/);
    assert.equal(approval.request.action.operation, "create_public_product_issue");
    assert.deepEqual(approval.request.resource.scope?.["labels"], []);
    assert.match(approval.effects[0] ?? "", /将在 GitHub 仓库 .* 新建 1 个 Issue，标题为/);
    assert.ok(approval.non_effects.some((item) => item.includes("不会完成、归档、解除或停止关联 TASK\/Session")));
    assert.equal(existsSync(join(f.root, ".codeflowmu", "operation-approvals")), false);
  } finally { await f.cleanup(); }
});

test("legacy promotion without quality classification is preserved and regenerated as quality v2", async () => {
  const f = await fixture();
  try {
    const service = new IssueClosureService({ projectRoot: f.root });
    const closed = await service.close(ISSUE_FILENAME, validDraft(f.issuePath));
    const first = await generateIssuePromotionBundle({
      projectRoot: f.root,
      filename: ISSUE_FILENAME,
      actor: "ADMIN",
      expected_closure_digest: closed.closure_digest,
    });
    for (const name of ["promotion.json", "manifest.json"]) {
      const path = join(f.root, ...first.bundle_path.split("/"), name);
      const row = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      delete row.classification;
      writeFileSync(path, `${JSON.stringify(row, null, 2)}\n`, "utf8");
    }
    const regenerated = await generateIssuePromotionBundle({
      projectRoot: f.root,
      filename: ISSUE_FILENAME,
      actor: "ADMIN",
      expected_closure_digest: closed.closure_digest,
    });
    assert.notEqual(regenerated.promotion_id, first.promotion_id);
    assert.match(regenerated.promotion_id, /-quality-v2$/);
    assert.equal(regenerated.classification.category, "codeflowmu_product");
    assert.equal(existsSync(join(f.root, ...first.bundle_path.split("/"), "promotion.json")), true);
  } finally { await f.cleanup(); }
});

test("promotion target never falls back to package.json repository", async () => {
  const f = await fixture();
  try {
    await rm(join(f.root, ".codeflowmu", "issue-promotion-target.json"));
    assert.throws(
      () => loadIssuePromotionConfig(f.root),
      (error: unknown) => error instanceof IssueClosureError
        && error.code === "GITHUB_TARGET_NOT_CONFIGURED"
        && String(error.message).includes(".codeflowmu/issue-promotion-target.json"),
    );
  } finally { await f.cleanup(); }
});

test("approved GitHub publication uses the controlled executor and persists a deduplicated receipt", async () => {
  const f = await fixture();
  try {
    const service = new IssueClosureService({ projectRoot: f.root });
    const closed = await service.close(ISSUE_FILENAME, validDraft(f.issuePath));
    const bundle = await generateIssuePromotionBundle({
      projectRoot: f.root,
      filename: ISSUE_FILENAME,
      actor: "ADMIN",
      expected_closure_digest: closed.closure_digest,
    });
    const prepared = buildIssueGithubApprovalInput({ projectRoot: f.root, promotion_id: bundle.promotion_id, actor: "ADMIN" });
    const approval = {
      project_root: f.root,
      request: prepared.request,
    } as OperationApprovalRecord;
    let preflights = 0;
    let creates = 0;
    const dependencies = {
      preflight(input: { targetRepo: string }) {
        preflights += 1;
        return { full_name: input.targetRepo, private: false, has_issues: true, permissions: { issue_submission: "authenticated_user" } };
      },
      createIssue() {
        creates += 1;
        return "https://github.com/joinwell52-AI/CodeFlowMu-open/issues/321";
      },
    };
    const published = await publishIssuePromotionWithExecutor(approval, dependencies);
    assert.equal(published.evidence[0]?.issue_number, 321);
    assert.equal(preflights, 1);
    assert.equal(creates, 1);
    const receipt = readIssuePromotion(f.root, bundle.promotion_id);
    assert.equal(receipt.status, "published");
    assert.equal(receipt.target_issue_url, "https://github.com/joinwell52-AI/CodeFlowMu-open/issues/321");
    const issueFm = parseMarkdownFrontmatter(readFileSync(f.issuePath, "utf8"));
    assert.equal(issueFm.promotion_status, "published");
    const detail = service.detail(ISSUE_FILENAME);
    assert.equal((detail.promotion as Record<string, unknown>).status, "published");

    const synchronized = await syncIssuePromotionApprovalStatus({
      ...approval,
      approval_id: "APPROVAL-PUBLIC-ISSUE-321",
      status: "succeeded",
      requested_at: "2026-08-07T09:00:00.000Z",
      authorization: { status: "consumed", issued_at: "2026-08-07T09:00:00.000Z", consumed_at: "2026-08-07T09:00:01.000Z" },
      decision: { outcome: "approved", actor: "ADMIN", at: "2026-08-07T09:00:01.000Z" },
      execution: {
        status: "succeeded",
        started_at: "2026-08-07T09:00:01.000Z",
        finished_at: "2026-08-07T09:00:02.000Z",
        evidence: published.evidence,
      },
    } as unknown as OperationApprovalRecord);
    assert.equal(synchronized?.status, "published");
    assert.equal(synchronized?.authorization_status, "consumed");
    assert.equal((synchronized?.approval_execution as Record<string, unknown>)?.status, "succeeded");

    const replay = await publishIssuePromotionWithExecutor(approval, dependencies);
    assert.equal(replay.evidence[0]?.deduplicated, true);
    assert.equal(preflights, 1);
    assert.equal(creates, 1);
  } finally { await f.cleanup(); }
});

test("promotion summary lists every bundle and explicit download marks the projection exported", async () => {
  const f = await fixture();
  try {
    const service = new IssueClosureService({ projectRoot: f.root });
    const closed = await service.close(ISSUE_FILENAME, validDraft(f.issuePath));
    const bundle = await generateIssuePromotionBundle({
      projectRoot: f.root,
      filename: ISSUE_FILENAME,
      actor: "ADMIN",
      expected_closure_digest: closed.closure_digest,
    });
    const rows = listIssuePromotions(f.root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.promotion_id, bundle.promotion_id);
    const exported = await exportIssuePromotionBundle({ projectRoot: f.root, promotion_id: bundle.promotion_id, actor: "ADMIN" });
    assert.equal(exported.status, "exported");
    assert.ok(exported.files.some((file) => file.path === "manifest.json"));
    assert.ok(exported.files.some((file) => file.path.startsWith("CODEFLOWMU-ISSUE-DRAFT-")));
    assert.equal(readIssuePromotion(f.root, bundle.promotion_id).status, "exported");
    assert.equal(parseMarkdownFrontmatter(readFileSync(f.issuePath, "utf8")).promotion_status, "exported");
  } finally { await f.cleanup(); }
});

test("GitHub publication preflight accepts ordinary authenticated users for public Issues", async () => {
  const publicTarget = validateGithubIssueTargetMetadata(
    "example/public",
    { private: false, has_issues: true, permissions: {} },
    { visibility_policy: "public_issue", requested_labels: [], available_labels: ["bug"] },
  );
  assert.equal(publicTarget.can_create_issue, true);
  assert.deepEqual(publicTarget.permissions, { issue_submission: "authenticated_user" });
  assert.throws(
    () => validateGithubIssueTargetMetadata("example/private", { private: true, has_issues: false, permissions: { push: true } }),
    (error: unknown) => error instanceof IssueClosureError && error.code === "GITHUB_ISSUES_DISABLED",
  );
  assert.throws(
    () => validateGithubIssueTargetMetadata("example/private", { private: true, has_issues: true, permissions: {} }),
    (error: unknown) => error instanceof IssueClosureError && error.code === "GITHUB_REPO_ACCESS_DENIED",
  );
  const accepted = validateGithubIssueTargetMetadata("example/private", { private: true, has_issues: true, permissions: { maintain: true } });
  assert.equal(accepted.private, true);
  assert.throws(
    () => validateGithubIssueTargetMetadata(
      "example/public",
      { private: false, has_issues: true, permissions: {} },
      { visibility_policy: "public_issue", requested_labels: ["missing"], available_labels: ["bug"] },
    ),
    (error: unknown) => error instanceof IssueClosureError && error.code === "GITHUB_LABELS_MISSING",
  );
});

test("GitHub authentication and target preflight run before an approval can be prepared", async () => {
  const f = await fixture();
  try {
    const service = new IssueClosureService({ projectRoot: f.root });
    const closed = await service.close(ISSUE_FILENAME, validDraft(f.issuePath));
    const bundle = await generateIssuePromotionBundle({
      projectRoot: f.root,
      filename: ISSUE_FILENAME,
      actor: "ADMIN",
      expected_closure_digest: closed.closure_digest,
    });
    await assert.rejects(
      () => prepareIssueGithubApprovalInput({
        projectRoot: f.root,
        promotion_id: bundle.promotion_id,
        actor: "ADMIN",
      }, {
        preflight() {
          throw new IssueClosureError("GITHUB_NOT_AUTHENTICATED", "尚未连接 GitHub", 401);
        },
      }),
      (error: unknown) => error instanceof IssueClosureError && error.code === "GITHUB_NOT_AUTHENTICATED",
    );
    assert.equal(existsSync(join(f.root, ".codeflowmu", "operation-approvals")), false);
  } finally { await f.cleanup(); }
});

test("controlled publication failure keeps the local closure and retryable promotion record", async () => {
  const f = await fixture();
  try {
    const service = new IssueClosureService({ projectRoot: f.root });
    const closed = await service.close(ISSUE_FILENAME, validDraft(f.issuePath));
    const bundle = await generateIssuePromotionBundle({ projectRoot: f.root, filename: ISSUE_FILENAME, actor: "ADMIN", expected_closure_digest: closed.closure_digest });
    const prepared = buildIssueGithubApprovalInput({ projectRoot: f.root, promotion_id: bundle.promotion_id, actor: "ADMIN" });
    const approval = { project_root: f.root, request: prepared.request } as OperationApprovalRecord;
    await assert.rejects(() => publishIssuePromotionWithExecutor(approval, {
      preflight: () => ({ private: true, has_issues: true, permissions: { push: true } }),
      createIssue: () => { throw new Error("simulated network failure"); },
    }), (error: unknown) => error instanceof IssueClosureError && error.code === "GITHUB_NETWORK_FAILED");
    assert.equal(parseMarkdownFrontmatter(readFileSync(f.issuePath, "utf8")).status, "closed");
    assert.equal(readIssuePromotion(f.root, bundle.promotion_id).status, "publish_failed_retryable");
  } finally { await f.cleanup(); }
});

test("public Issue safety scan rejects internal identifiers, local paths, empty backticks and broken sentences", () => {
  const findings = inspectPublicIssueDraft(
    "TASK-20260804-001 failed for user@example.com",
    "The source is D:\\private\\customer\\data.txt.\n\nThe result is `` and",
  );
  assert.ok(findings.includes("TASK-*"));
  assert.ok(findings.includes("Windows 绝对路径"));
  assert.ok(findings.includes("电子邮箱"));
  assert.ok(findings.includes("空反引号"));
  assert.ok(findings.includes("疑似残缺句子"));
  const generic = inspectPublicIssueDraft(
    "[CodeFlowMu Open] Runtime Issue",
    "During internal evaluation, a product or protocol gap was identified regarding this runtime issue.",
  );
  assert.ok(generic.includes("标题过于泛化"));
  assert.ok(generic.includes("公开内容缺少具体问题信息"));
});

test("project-specific regression gets a personalized local draft but is blocked from public promotion", async () => {
  const f = await fixture();
  try {
    writeFileSync(f.issuePath, issueMarkdown().replace(
      /# Runtime lifecycle split[\s\S]*$/,
      "# Runtime Issue\n\n## 问题摘要\n\nlive expansion 门禁未通过：住址 exact 相对 ROI=off 基线无增益。后续内部处置不应进入公开标题。",
    ), "utf8");
    const service = new IssueClosureService({ projectRoot: f.root });
    const closed = await service.close(ISSUE_FILENAME, validDraft(f.issuePath));
    const bundle = await generateIssuePromotionBundle({
      projectRoot: f.root,
      filename: ISSUE_FILENAME,
      actor: "ADMIN",
      expected_closure_digest: closed.closure_digest,
    });
    assert.equal(bundle.draft_title, "[CodeFlowMu Open] live expansion 门禁未通过：住址 exact 相对 ROI=off 基线无增益。");
    assert.equal(bundle.status, "draft_unsafe");
    assert.equal(bundle.redaction.public_safe, false);
    assert.equal((bundle as unknown as { classification: { category: string } }).classification.category, "project_product");
    assert.doesNotMatch(bundle.draft_body, /During internal evaluation, a product or protocol gap/i);
  } finally { await f.cleanup(); }
});

test("generic public fallback stays previewable but cannot be approved", async () => {
  const f = await fixture();
  try {
    writeFileSync(f.issuePath, issueMarkdown().replace(
      /# Runtime lifecycle split[\s\S]*$/,
      "# Runtime Issue\n\n确认转开发修复。",
    ), "utf8");
    const service = new IssueClosureService({ projectRoot: f.root });
    const closed = await service.close(ISSUE_FILENAME, validDraft(f.issuePath, {
      root_cause_summary: "",
      reason: "确认转交开发继续修复",
      recovery_action: "",
      verification_summary: "",
      residual_risk: "仍需处理",
    }));
    const bundle = await generateIssuePromotionBundle({
      projectRoot: f.root,
      filename: ISSUE_FILENAME,
      actor: "ADMIN",
      expected_closure_digest: closed.closure_digest,
    });
    assert.equal(bundle.status, "draft_unsafe");
    assert.equal(bundle.redaction.public_safe, false);
    assert.throws(
      () => buildIssueGithubApprovalInput({ projectRoot: f.root, promotion_id: bundle.promotion_id, actor: "ADMIN" }),
      (error: unknown) => error instanceof IssueClosureError && error.code === "ISSUE_PROMOTION_PUBLIC_DRAFT_UNSAFE",
    );
  } finally { await f.cleanup(); }
});

test("unsafe generated public draft remains locally previewable but cannot create an approval", async () => {
  const f = await fixture();
  try {
    const service = new IssueClosureService({ projectRoot: f.root });
    const closed = await service.close(ISSUE_FILENAME, validDraft(f.issuePath, {
      reason: "The visible result is `` and",
    }));
    const bundle = await generateIssuePromotionBundle({
      projectRoot: f.root,
      filename: ISSUE_FILENAME,
      actor: "ADMIN",
      expected_closure_digest: closed.closure_digest,
    });
    assert.equal(bundle.status, "draft_unsafe");
    assert.equal(bundle.redaction.public_safe, false);
    assert.throws(
      () => buildIssueGithubApprovalInput({ projectRoot: f.root, promotion_id: bundle.promotion_id, actor: "ADMIN" }),
      (error: unknown) => error instanceof IssueClosureError && error.code === "ISSUE_PROMOTION_PUBLIC_DRAFT_UNSAFE",
    );
  } finally { await f.cleanup(); }
});

test("secret in closure evidence blocks promotion without losing local closure", async () => {
  const f = await fixture();
  try {
    const service = new IssueClosureService({ projectRoot: f.root });
    const closed = await service.close(ISSUE_FILENAME, validDraft(f.issuePath, {
      reason: "Recovered locally; leaked-looking credential sk-abcdefghijklmnopqrstuvwxyz123456 must never leave the evidence boundary.",
    }));
    await assert.rejects(
      () => generateIssuePromotionBundle({ projectRoot: f.root, filename: ISSUE_FILENAME, actor: "ADMIN", expected_closure_digest: closed.closure_digest }),
      (error: unknown) => error instanceof IssueClosureError
        && error.code === "ISSUE_PROMOTION_SECRET_DETECTED"
        && Array.isArray((error.details as { files?: unknown[] } | undefined)?.files)
        && String((error.details as { files: unknown[] }).files[0]).includes("issue-closures"),
    );
    assert.equal(parseMarkdownFrontmatter(readFileSync(f.issuePath, "utf8")).status, "closed");
  } finally { await f.cleanup(); }
});
