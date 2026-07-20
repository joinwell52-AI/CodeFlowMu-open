import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isReworkResubmitUnblocked,
  isTaskReopenedForReworkFromLedger,
  isTaskSettledClosed,
} from "../taskReworkSemantics.ts";

describe("taskReworkSemantics", () => {
  it("approved done task is settled closed despite historical reopen fields", () => {
    const fields = {
      review_status: "approved",
      reopen_reason: "色彩灰暗，游戏无道具",
      reopened_count: 2,
      display_status: "admin_rejected",
      bucket: "done",
      scope: "done",
    };
    assert.equal(isTaskSettledClosed(fields), true);
    assert.equal(isTaskReopenedForReworkFromLedger(fields), false);
  });

  it("waiting_pm_rework display_status is rework", () => {
    const fields = {
      display_status: "waiting_pm_rework",
      scope: "active",
    };
    assert.equal(isTaskReopenedForReworkFromLedger(fields), true);
  });

  it("rejected task with reopen_reason is rework", () => {
    const fields = {
      review_status: "rejected",
      reopen_reason: "重做",
      reopened_count: 1,
      scope: "active",
    };
    assert.equal(isTaskReopenedForReworkFromLedger(fields), true);
  });

  it("approved task in done bucket is not rework even with reopen_reason", () => {
    const fields = {
      review_status: "approved",
      reopen_reason: "历史打回",
      reopened_count: 3,
      scope: "done",
    };
    assert.equal(isTaskReopenedForReworkFromLedger(fields), false);
  });

  it("rework_done clears rework gate while retaining reopen audit fields", () => {
    const fields = {
      display_status: "ready_for_review",
      review_status: "rework_done",
      reopen_reason: "有问题，最好重做",
      reopened_count: 1,
      scope: "active",
    };
    assert.equal(isReworkResubmitUnblocked(fields), true);
    assert.equal(isTaskReopenedForReworkFromLedger(fields), false);
  });

  it("approved task with ledger archive bucket but physical review scope is not settled", () => {
    const fields = {
      review_status: "approved",
      reopen_reason: "历史打回",
      reopened_count: 2,
      bucket: "archive",
      scope: "review",
    };
    assert.equal(isTaskSettledClosed(fields), false);
    assert.equal(isTaskReopenedForReworkFromLedger(fields), false);
  });
});
