import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveReviewLinkedTaskId } from "../resolveReviewLinkedTaskId.ts";

const TASK = "TASK-20260608-003-ADMIN-to-PM";
const REPORT = "REPORT-20260608-005-OPS-to-PM";

describe("resolveReviewLinkedTaskId", () => {
  it("prefers task_id over subject_id REPORT (REVIEW-GATE shape)", () => {
    const linked = resolveReviewLinkedTaskId({
      subject_id: REPORT,
      task_id: TASK,
      report_id: REPORT,
      reviewer: "REVIEW-GATE",
      decision: "approved",
    });
    assert.equal(linked, TASK);
  });

  it("uses subject_task when task_id absent", () => {
    assert.equal(
      resolveReviewLinkedTaskId({ subject_task: TASK, subject_id: REPORT }),
      TASK,
    );
  });

  it("uses subject_ref when higher-priority fields absent", () => {
    assert.equal(
      resolveReviewLinkedTaskId({ subject_ref: TASK, subject_id: REPORT }),
      TASK,
    );
  });

  it("uses subject_id only when it is TASK-*", () => {
    assert.equal(resolveReviewLinkedTaskId({ subject_id: TASK }), TASK);
    assert.equal(
      resolveReviewLinkedTaskId({ subject_id: REPORT }),
      null,
    );
  });

  it("resolves via report_id → REPORT frontmatter", () => {
    const linked = resolveReviewLinkedTaskId(
      { report_id: REPORT },
      {
        resolveReport: (id) =>
          id === REPORT ? { task_id: TASK } : null,
      },
    );
    assert.equal(linked, TASK);
  });

  it("resolves via report_id → REPORT references", () => {
    const linked = resolveReviewLinkedTaskId(
      { report_id: REPORT },
      {
        resolveReport: () => ({ references: [TASK] }),
      },
    );
    assert.equal(linked, TASK);
  });

  it("falls back to filename -on-TASK-*.md", () => {
    const linked = resolveReviewLinkedTaskId(
      { subject_id: REPORT, reviewer: "REVIEW-GATE" },
      {
        filename: `REVIEW-20260608-001-REVIEW-GATE-on-${TASK}.md`,
      },
    );
    assert.equal(linked, TASK);
  });

  it("strips .md suffix from task refs", () => {
    assert.equal(
      resolveReviewLinkedTaskId({ task_id: `${TASK}.md` }),
      TASK,
    );
  });
});
