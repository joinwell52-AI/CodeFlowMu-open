import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isWorkerReceiptWaitingBucket,
  resolveTaskCurrentBucket,
  shouldShowThreadOnTeamDynamics,
} from "../taskCurrentBucket.ts";

describe("taskCurrentBucket", () => {
  it("prefers physical_scope over stale ledger bucket", () => {
    assert.equal(
      resolveTaskCurrentBucket({
        bucket: "active",
        physical_scope: "archive",
        path: "fcop/_lifecycle/active/TASK-20260609-010-PM-to-QA.md",
      }),
      "archive",
    );
  });

  it("falls back to _lifecycle path when physical_scope missing", () => {
    assert.equal(
      resolveTaskCurrentBucket({
        bucket: "active",
        path: "fcop/_lifecycle/archive/TASK-20260609-010-PM-to-QA.md",
      }),
      "archive",
    );
  });

  it("worker receipt waiting includes trusted inbox plus active/review", () => {
    assert.equal(isWorkerReceiptWaitingBucket("active"), true);
    assert.equal(isWorkerReceiptWaitingBucket("inbox"), true);
    assert.equal(isWorkerReceiptWaitingBucket("review"), true);
    assert.equal(isWorkerReceiptWaitingBucket("archive"), false);
  });

  it("hides archived admin thread from team dynamics", () => {
    const members = [
      {
        filename: "TASK-20260609-013-ADMIN-to-PM.md",
        path: "fcop/_lifecycle/archive/TASK-20260609-013-ADMIN-to-PM.md",
        bucket: "active",
      },
      {
        filename: "TASK-20260609-010-PM-to-QA.md",
        path: "fcop/_lifecycle/active/TASK-20260609-010-PM-to-QA.md",
        bucket: "active",
      },
    ];
    assert.equal(shouldShowThreadOnTeamDynamics(members), false);
  });

  it("shows active/review thread on team dynamics", () => {
    const members = [
      {
        filename: "TASK-20260609-019-ADMIN-to-PM.md",
        path: "fcop/_lifecycle/review/TASK-20260609-019-ADMIN-to-PM.md",
      },
    ];
    assert.equal(shouldShowThreadOnTeamDynamics(members), true);
  });
});
