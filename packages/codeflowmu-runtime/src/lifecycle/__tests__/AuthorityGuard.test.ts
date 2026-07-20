import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AuthorityError, AuthorityGuard } from "../AuthorityGuard.ts";
import type { TaskFm } from "../types.ts";

const guard = new AuthorityGuard();

function mainAdminPm(): TaskFm {
  return {
    task_id: "TASK-20260530-001-ADMIN-to-PM",
    from: "ADMIN",
    to: "PM",
    driver: "PM",
    done_authority: "ADMIN",
    archive_authority: "ADMIN",
    line: "main",
  };
}

function delegatedDoneMain(): TaskFm {
  return {
    ...mainAdminPm(),
    delegated_done: true,
    done_authority: "PM",
    archive_authority: "ADMIN",
  };
}

function branchPmOps(): TaskFm {
  return {
    task_id: "TASK-20260530-002-PM-to-OPS",
    from: "PM",
    to: "OPS",
    driver: "OPS",
    reviewer: "PM",
    done_authority: "PM",
    archive_authority: "PM",
    line: "branch",
  };
}

describe("AuthorityGuard", () => {
  it("1. PM 对 ADMIN→PM 主线 approve_review 被拒", () => {
    assert.throws(
      () => guard.assert(mainAdminPm(), "PM", "approve_review"),
      AuthorityError,
    );
  });

  it("2. ADMIN 对 ADMIN→PM 主线 approve_review 成功", () => {
    assert.doesNotThrow(() =>
      guard.assert(mainAdminPm(), "ADMIN", "approve_review"),
    );
  });

  it("3. delegated_done: true 时 PM approve_review 成功", () => {
    assert.doesNotThrow(() =>
      guard.assert(delegatedDoneMain(), "PM", "approve_review"),
    );
  });

  it("4. delegated_done: true 时 PM archive_task 仍被拒", () => {
    assert.throws(
      () => guard.assert(delegatedDoneMain(), "PM", "archive_task"),
      AuthorityError,
    );
  });

  it("5. OPS 对 PM→OPS 支线 approve_review 被拒", () => {
    assert.throws(
      () => guard.assert(branchPmOps(), "OPS", "approve_review"),
      AuthorityError,
    );
  });

  it("6. PM 对 PM→OPS 支线 approve_review 成功", () => {
    assert.doesNotThrow(() =>
      guard.assert(branchPmOps(), "PM", "approve_review"),
    );
  });

  it("7. OPS 对 PM→OPS 支线 archive_task 被拒", () => {
    assert.throws(
      () => guard.assert(branchPmOps(), "OPS", "archive_task"),
      AuthorityError,
    );
  });

  it("8. PM 对 PM→OPS 支线 archive_task 成功", () => {
    assert.doesNotThrow(() =>
      guard.assert(branchPmOps(), "PM", "archive_task"),
    );
  });

  it("9. 旧任务无 authority 字段：ADMIN→PM 主线 ADMIN 可 approve/archive", () => {
    const legacy: TaskFm = {
      task_id: "TASK-20260530-002-ADMIN-to-PM",
      sender: "ADMIN",
      recipient: "PM",
    };
    assert.doesNotThrow(() =>
      guard.assert(legacy, "ADMIN", "approve_review"),
    );
    assert.doesNotThrow(() => guard.assert(legacy, "ADMIN", "archive_task"));
    assert.throws(
      () => guard.assert(legacy, "PM", "approve_review"),
      AuthorityError,
    );
  });

  it("10. 旧任务无 authority 字段：PM→OPS 支线 PM 可 approve/archive", () => {
    const legacy: TaskFm = {
      task_id: "TASK-20260530-003-PM-to-OPS",
      sender: "PM",
      recipient: "OPS",
    };
    assert.doesNotThrow(() => guard.assert(legacy, "PM", "approve_review"));
    assert.doesNotThrow(() => guard.assert(legacy, "PM", "archive_task"));
    assert.throws(
      () => guard.assert(legacy, "OPS", "archive_task"),
      AuthorityError,
    );
  });
});
