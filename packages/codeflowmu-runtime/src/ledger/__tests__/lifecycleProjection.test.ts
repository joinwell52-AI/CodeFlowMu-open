import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  areAllChildrenSettledForRoot,
  isChildSettledForRoot,
} from "../lifecycleProjection.ts";
import type {
  LedgerReportRecord,
  LedgerTaskRecord,
  LedgerThreadRecord,
} from "../types.ts";

function childTask(overrides: Partial<LedgerTaskRecord>): LedgerTaskRecord {
  return {
    task_id: "TASK-20260531-002-OPS-to-PM",
    filename: "TASK-20260531-002-OPS-to-PM.md",
    sender: "OPS",
    recipient: "PM",
    bucket: "tasks",
    path: "/fake/tasks/TASK-002.md",
    parent: "TASK-20260531-001-ADMIN-to-PM",
    thread_key: "t1",
    created_at: "",
    updated_at: "",
    timezone: "UTC",
    created_at_utc: "",
    ...overrides,
  };
}

function thread(overrides: Partial<LedgerThreadRecord> = {}): LedgerThreadRecord {
  return {
    thread_key: "t1",
    root_task_id: "TASK-20260531-001-ADMIN-to-PM",
    task_ids: [],
    report_ids: [],
    pending_pm_review: [],
    waiting_pm_consolidation: false,
    ...overrides,
  };
}

describe("lifecycleProjection", () => {
  it("hot_path child with done REPORT→PM is unsettled until review approved", () => {
    const child = childTask({ bucket: "tasks" });
    const reports: LedgerReportRecord[] = [
      {
        report_id: "R1",
        task_id: child.task_id,
        filename: "REPORT-002-OPS-to-PM.md",
        sender: "OPS",
        recipient: "PM",
        status: "done",
        path: "/fake/reports/R1.md",
        created_at: "",
        updated_at: "",
        timezone: "UTC",
        created_at_utc: "",
      },
    ];
    const th = thread({ pending_pm_review: [child.task_id] });

    assert.equal(
      isChildSettledForRoot(child, th, reports, { reviewStatusApproved: false }),
      false,
    );
    assert.equal(
      isChildSettledForRoot(child, th, reports, { reviewStatusApproved: true }),
      true,
    );
  });

  it("areAllChildrenSettledForRoot true when all children approved", () => {
    const rootId = "TASK-20260531-001-ADMIN-to-PM";
    const c1 = childTask({ task_id: "TASK-20260531-002-OPS-to-PM" });
    const c2 = childTask({
      task_id: "TASK-20260531-003-DEV-to-PM",
      sender: "DEV",
    });
    const reports: LedgerReportRecord[] = [];
    const th = thread();
    const approved = new Map<string, boolean>([
      [c1.task_id, true],
      [c2.task_id, true],
    ]);

    assert.equal(
      areAllChildrenSettledForRoot(rootId, [c1, c2], th, reports, approved),
      true,
    );
  });

  it("areAllChildrenSettled matches child parent via canonical id from references", () => {
    const rootId = "TASK-20260601-001";
    const child = childTask({
      task_id: "TASK-20260601-002-PM-to-OPS",
      parent: "TASK-20260601-001",
      bucket: "tasks",
    });
    const approved = new Map<string, boolean>([[child.task_id, true]]);
    assert.equal(
      areAllChildrenSettledForRoot(rootId, [child], thread(), [], approved),
      true,
    );
  });

  it("lifecycle active child with done report but not approved stays unsettled", () => {
    const child = childTask({ bucket: "active" });
    const reports: LedgerReportRecord[] = [
      {
        report_id: "R1",
        task_id: child.task_id,
        filename: "REPORT-002-OPS-to-PM.md",
        sender: "OPS",
        recipient: "PM",
        status: "done",
        path: "/fake",
        created_at: "",
        updated_at: "",
        timezone: "UTC",
        created_at_utc: "",
      },
    ];
    assert.equal(
      isChildSettledForRoot(child, thread(), reports, { reviewStatusApproved: false }),
      false,
    );
  });

  it("active child with a formal blocked report is a settled original outcome", () => {
    const child = childTask({ bucket: "active" });
    const reports: LedgerReportRecord[] = [
      {
        report_id: "R-BLOCKED",
        task_id: child.task_id,
        filename: "REPORT-002-OPS-to-PM.md",
        sender: "OPS",
        recipient: "PM",
        status: "blocked",
        path: "/fake",
        created_at: "",
        updated_at: "",
        timezone: "UTC",
        created_at_utc: "",
      },
    ];
    assert.equal(isChildSettledForRoot(child, thread(), reports), true);
  });
});
