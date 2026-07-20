import assert from "node:assert/strict";
import type { LedgerReportRecord } from "../../ledger/types.ts";
import { describe, it } from "node:test";

import {
  classifyPendingReviewGate,
  filterReviewsForThread,
  isPendingHumanReviewRow,
  isReviewGateReviewer,
  reviewsForPmSummaryCoverage,
  splitFormalAndHumanGateReviews,
  type EvalReviewRow,
} from "../evalReviewScope.ts";
import {
  isReviewPendingHuman,
  reviewMatchesScope,
} from "../../review/reviewHumanApproval.ts";

const THREAD = "closeout-thread-006";

function row(partial: Partial<EvalReviewRow> & { id: string }): EvalReviewRow {
  return {
    id: partial.id,
    reviewer: partial.reviewer ?? "SYSTEM",
    decision: partial.decision ?? "needs_human",
    taskId: partial.taskId ?? "",
    subjectId: partial.subjectId ?? "",
    threadKey: partial.threadKey ?? THREAD,
    humanApprovalApprovedAt: partial.humanApprovalApprovedAt ?? null,
  };
}

describe("filterReviewsForThread", () => {
  const reviews: EvalReviewRow[] = [
    row({ id: "REVIEW-010", taskId: "TASK-20260608-005", threadKey: THREAD }),
    row({ id: "REVIEW-011", taskId: "TASK-20260608-006", threadKey: THREAD }),
    row({
      id: "REVIEW-GATE",
      reviewer: "REVIEW-GATE",
      taskId: "TASK-20260608-006",
      decision: "approved",
    }),
  ];

  it("includes only root and child task reviews, not sibling mainline on same thread", () => {
    const scoped = filterReviewsForThread(reviews, {
      rootId: "TASK-20260608-006",
      children: [],
      threadKey: THREAD,
      reports: [],
    });
    assert.deepEqual(
      scoped.map((r) => r.id),
      ["REVIEW-011", "REVIEW-GATE"],
    );
  });

  it("matches reviews by report subject when task_id absent", () => {
    const byReport = filterReviewsForThread(
      [
        row({
          id: "REVIEW-R",
          taskId: "",
          subjectId: "REPORT-20260609-003-PM-to-ADMIN",
        }),
      ],
      {
        rootId: "TASK-20260608-006",
        children: [],
        threadKey: THREAD,
        reports: [
          {
            report_id: "REPORT-20260609-003-PM-to-ADMIN",
            filename: "REPORT-20260609-003-PM-to-ADMIN.md",
            path: "",
            sender: "PM",
            recipient: "ADMIN",
            status: "done",
          },
        ] as unknown as LedgerReportRecord[],
      },
    );
    assert.equal(byReport.length, 1);
  });
});

describe("reviewsForPmSummaryCoverage", () => {
  it("excludes REVIEW-GATE from PM summary mention set", () => {
    const reviews: EvalReviewRow[] = [
      row({ id: "REVIEW-011", taskId: "TASK-20260608-006" }),
      row({
        id: "REVIEW-GATE",
        reviewer: "REVIEW-GATE",
        taskId: "TASK-20260608-006",
        decision: "approved",
      }),
    ];
    const cov = reviewsForPmSummaryCoverage(reviews);
    assert.deepEqual(cov.map((r) => r.id), ["REVIEW-011"]);
    assert.equal(isReviewGateReviewer("REVIEW-GATE"), true);
  });
});

describe("isPendingHumanReviewRow", () => {
  it("treats needs_human without approved_at as pending", () => {
    assert.equal(
      isPendingHumanReviewRow(row({ id: "R1", decision: "needs_human" })),
      true,
    );
  });

  it("excludes needs_human after human_approval.approved_at", () => {
    assert.equal(
      isPendingHumanReviewRow(
        row({
          id: "R2",
          decision: "needs_human",
          humanApprovalApprovedAt: "2026-06-09T08:00:00Z",
        }),
      ),
      false,
    );
  });
});

describe("classifyPendingReviewGate", () => {
  const rootId = "TASK-20260610-215";
  const children = [
    {
      task_id: "TASK-20260610-035",
      filename: "TASK-20260610-035-PM-to-OPS.md",
      sender: "PM",
      recipient: "OPS",
      parent: rootId,
      thread_key: "panel-task-215",
    },
  ] as import("../../ledger/types.ts").LedgerTaskRecord[];

  it("TASK-215 root REVIEW-GATE → main_admin_approval_pending", () => {
    const gate = row({
      id: "REVIEW-20260610-034-REVIEW-GATE-on-TASK-20260610-215",
      reviewer: "REVIEW-GATE",
      taskId: rootId,
      decision: "needs_human",
    });
    assert.equal(
      classifyPendingReviewGate(gate, rootId, children),
      "main_admin_approval_pending",
    );
  });

  it("child task needs_human → child_review_pending", () => {
    const childRev = row({
      id: "REVIEW-child",
      reviewer: "QA",
      taskId: "TASK-20260610-035",
      decision: "needs_human",
    });
    assert.equal(
      classifyPendingReviewGate(childRev, rootId, children),
      "child_review_pending",
    );
  });
});

describe("splitFormalAndHumanGateReviews", () => {
  it("separates REVIEW-GATE from formal REVIEW rows", () => {
    const reviews: EvalReviewRow[] = [
      row({ id: "REVIEW-011", reviewer: "QA", taskId: "TASK-20260610-035" }),
      row({
        id: "REVIEW-GATE",
        reviewer: "REVIEW-GATE",
        taskId: "TASK-20260610-215",
      }),
    ];
    const { formal, humanGate } = splitFormalAndHumanGateReviews(reviews);
    assert.deepEqual(formal.map((r) => r.id), ["REVIEW-011"]);
    assert.deepEqual(humanGate.map((r) => r.id), ["REVIEW-GATE"]);
  });
});

describe("reviewMatchesScope", () => {
  it("task_id scope does not match sibling mainline on same thread_key", () => {
    const fm005 = {
      task_id: "TASK-20260608-005",
      thread_key: THREAD,
      decision: "needs_human",
    };
    const fm006 = {
      task_id: "TASK-20260608-006",
      thread_key: THREAD,
      decision: "needs_human",
    };
    const scope = { taskId: "TASK-20260608-006", threadKey: THREAD };
    assert.equal(reviewMatchesScope(fm005, scope), false);
    assert.equal(reviewMatchesScope(fm006, scope), true);
  });

  it("thread_key-only scope matches all reviews on thread", () => {
    const fm005 = { task_id: "TASK-20260608-005", thread_key: THREAD };
    assert.equal(reviewMatchesScope(fm005, { threadKey: THREAD }), true);
  });

  it("isReviewPendingHuman respects nested human_approval", () => {
    assert.equal(
      isReviewPendingHuman({
        decision: "needs_human",
        human_approval: { approved_at: "2026-06-09T08:00:00Z" },
      }),
      false,
    );
    assert.equal(isReviewPendingHuman({ decision: "needs_human" }), true);
  });
});
