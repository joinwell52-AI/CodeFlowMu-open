import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  abandonTaskSubmission,
  checkTaskSubmission,
  createTaskSubmission,
  getTaskSubmission,
  listTaskSubmissions,
  reviseTaskSubmission,
  taskSubmissionPath,
} from "../task-submission-store.ts";

test("submission store allocates ten concurrent IDs without collision", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-submission-store-"));
  try {
    const rows = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        createTaskSubmission(root, {
          subject: `Task ${index}`,
          body: "Implement and verify a small change.",
        }),
      ),
    );
    assert.equal(new Set(rows.map((row) => row.submission_id)).size, 10);
    const listed = await listTaskSubmissions(root);
    assert.equal(listed.length, 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("submission idempotency key returns the same durable record", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-submission-store-"));
  try {
    const first = await createTaskSubmission(root, {
      subject: "Idempotent",
      body: "Implement and verify.",
      idempotency_key: "same-request",
    });
    const replay = await createTaskSubmission(root, {
      subject: "Ignored replay body",
      body: "This must not create another record.",
      idempotency_key: "same-request",
    });
    assert.equal(replay.submission_id, first.submission_id);
    assert.equal((await listTaskSubmissions(root)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("needs-revision submission persists structured findings and no formal identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-submission-store-"));
  try {
    const draft = await createTaskSubmission(root, {
      subject: "Conflict",
      body: "Implement it.\nthread_key: forged-thread",
      thread_key: "runtime-thread",
    });
    const checked = await checkTaskSubmission(root, draft.submission_id);
    assert.equal(checked.status, "needs_revision");
    assert.equal(checked.decision, "needs_revision");
    assert.equal(checked.formal_task_id, null);
    assert.ok(
      checked.blocking_findings.some(
        (finding) =>
          finding.id === "INTERNAL_INCONSISTENCY" &&
          finding.field === "thread_key" &&
          finding.expected &&
          finding.actual &&
          finding.suggested_fix,
      ),
    );
    const raw = JSON.parse(
      await readFile(taskSubmissionPath(root, draft.submission_id), "utf8"),
    );
    assert.equal(raw.status, "needs_revision");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("revision preserves needs-revision history and increments admission revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-submission-store-"));
  try {
    const draft = await createTaskSubmission(root, {
      subject: "Conflict",
      body: "Implement it.\nthread_key: forged-thread",
      thread_key: "runtime-thread",
    });
    await checkTaskSubmission(root, draft.submission_id);
    const revised = await reviseTaskSubmission(root, draft.submission_id, {
      subject: "Valid revision",
      body: "Implement and verify a small feature.",
    });
    assert.equal(revised.admission_revision, 2);
    assert.equal(revised.status, "draft");
    assert.ok(
      revised.history.some((entry) => entry.decision === "needs_revision"),
    );
    const accepted = await checkTaskSubmission(root, draft.submission_id);
    assert.equal(accepted.status, "accepted");
    assert.ok(
      accepted.history.some((entry) => entry.decision === "accepted"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("abandoned submission remains queryable and cannot masquerade as a task", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-submission-store-"));
  try {
    const draft = await createTaskSubmission(root, {
      subject: "Abandon",
      body: "Implement and verify.",
    });
    const abandoned = await abandonTaskSubmission(root, draft.submission_id);
    assert.equal(abandoned.status, "abandoned");
    assert.equal(abandoned.formal_task_id, null);
    assert.equal(
      (await getTaskSubmission(root, draft.submission_id))?.status,
      "abandoned",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy rejected formal task is exposed as an anomaly submission", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-submission-store-"));
  const taskId = "TASK-20260730-901";
  try {
    const inbox = join(root, "fcop", "_lifecycle", "inbox");
    const admission = join(root, ".codeflowmu", "task-spec-admission");
    await mkdir(inbox, { recursive: true });
    await mkdir(admission, { recursive: true });
    await writeFile(
      join(inbox, `${taskId}-ADMIN-to-PM.md`),
      [
        "---",
        "protocol: fcop",
        'version: "1.0"',
        "sender: ADMIN",
        "recipient: PM",
        "priority: P0",
        "thread_key: legacy-rejected",
        "---",
        "# Legacy rejected task",
        "",
        "thread_key: conflicting-body-value",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(admission, `${taskId}.json`),
      `${JSON.stringify({
        task_id: taskId,
        decision: "rejected",
        code: "TASK_SPEC_INVALID",
        content_digest: "legacy-digest",
        checked_at: "2026-07-30T10:00:00.000Z",
        blocking_findings: [
          {
            id: "INTERNAL_INCONSISTENCY",
            field: "thread_key",
            message: "conflict",
          },
        ],
      })}\n`,
      "utf8",
    );

    const rows = await listTaskSubmissions(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.submission_id, `LEGACY-${taskId}`);
    assert.equal(rows[0]?.legacy_anomaly, true);
    assert.equal(rows[0]?.formal_task_id, taskId);
    assert.ok(rows[0]?.migration_options?.length);
    assert.equal(
      (await getTaskSubmission(root, `LEGACY-${taskId}`))?.legacy_anomaly,
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
