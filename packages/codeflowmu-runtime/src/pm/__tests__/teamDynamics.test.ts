import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  aggregateLifecycleCountsFromPhysical,
  collectPmOpenMainlineTasks,
  hasPmFinalReportForRoot,
  isAdminAwaitingReviewScenario,
  listExecutingEvidence,
  shouldShowThreadOnTeamDynamics,
} from "../teamDynamics.ts";

const ROOT = "TASK-20260609-013-ADMIN-to-PM";
const QA = "TASK-20260609-010-PM-to-QA";

describe("teamDynamics SoT", () => {
  it("hides thread when ledger active but file is archive", () => {
    const members = [
      {
        filename: `${ROOT}.md`,
        path: "fcop/_lifecycle/review/TASK-20260609-013-ADMIN-to-PM.md",
        bucket: "active",
      },
      {
        filename: `${QA}.md`,
        path: "fcop/_lifecycle/archive/TASK-20260609-010-PM-to-QA.md",
        bucket: "active",
      },
    ];
    assert.equal(shouldShowThreadOnTeamDynamics(members), false);
  });

  it("hides thread when only stale ledger would qualify (all archive on disk)", () => {
    const members = [
      {
        filename: `${QA}.md`,
        physical_scope: "archive",
        path: "fcop/_lifecycle/archive/TASK-20260609-010-PM-to-QA.md",
        bucket: "active",
      },
    ];
    assert.equal(shouldShowThreadOnTeamDynamics(members), false);
  });

  it("hides root review + all children done (ADMIN awaiting)", () => {
    const members = [
      {
        filename: `${ROOT}.md`,
        physical_scope: "review",
        path: `fcop/_lifecycle/review/${ROOT}.md`,
      },
      {
        filename: `${QA}.md`,
        physical_scope: "done",
        path: `fcop/_lifecycle/done/${QA}.md`,
      },
    ];
    assert.equal(isAdminAwaitingReviewScenario(members), true);
    assert.equal(shouldShowThreadOnTeamDynamics(members), false);
  });

  it("PM todo excludes root review and cleared after PM final report", () => {
    const tasks = [
      {
        filename: `${ROOT}.md`,
        physical_scope: "review",
        path: `fcop/_lifecycle/review/${ROOT}.md`,
      },
      {
        filename: "TASK-20260609-020-ADMIN-to-PM.md",
        physical_scope: "active",
        path: "fcop/_lifecycle/active/TASK-20260609-020-ADMIN-to-PM.md",
      },
    ];
    const open = collectPmOpenMainlineTasks(tasks, []);
    assert.equal(open.length, 1);
    assert.equal(open[0]!.filename, "TASK-20260609-020-ADMIN-to-PM.md");

    const withFinal = collectPmOpenMainlineTasks(tasks, [
      {
        filename: "REPORT-20260609-020-PM-to-ADMIN.md",
        status: "done",
        task_id: "TASK-20260609-020",
      },
    ]);
    assert.equal(withFinal.length, 0);
  });

  it("shows real active thread with executing evidence", () => {
    const members = [
      {
        filename: `${ROOT}.md`,
        physical_scope: "active",
        path: `fcop/_lifecycle/active/${ROOT}.md`,
      },
      {
        filename: `${QA}.md`,
        physical_scope: "active",
        recipient: "QA",
        path: `fcop/_lifecycle/active/${QA}.md`,
      },
    ];
    assert.equal(shouldShowThreadOnTeamDynamics(members), true);
    const ev = listExecutingEvidence(members);
    assert.equal(ev.length, 2);
    assert.equal(ev[1]!.task_id, "TASK-20260609-010");
    assert.equal(ev[1]!.bucket, "active");
    assert.equal(ev[1]!.role, "QA");
  });

  it("aggregateLifecycleCountsFromPhysical prefers physical_scope", () => {
    const counts = aggregateLifecycleCountsFromPhysical([
      {
        filename: `${QA}.md`,
        bucket: "active",
        physical_scope: "archive",
      },
    ]);
    assert.equal(counts.archive, 1);
    assert.equal(counts.active, 0);
  });

  it("hasPmFinalReportForRoot detects PM-to-ADMIN done", () => {
    assert.equal(
      hasPmFinalReportForRoot("TASK-20260609-020", [
        {
          filename: "REPORT-20260609-020-PM-to-ADMIN.md",
          status: "done",
        },
      ]),
      true,
    );
  });
});
