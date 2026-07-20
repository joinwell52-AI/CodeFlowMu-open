import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  countReportThreadTasksForDisplay,
  shouldShowReportThreadInActive,
  shouldShowReportThreadInArchive,
} from "../reportPageThreads.ts";

const ROOT = "TASK-20260609-013-ADMIN-to-PM";
const QA = "TASK-20260609-010-PM-to-QA";

describe("reportPageThreads", () => {
  it("hides active thread when ledger task_ids exist but tasks archive and no reports", () => {
    const ok = shouldShowReportThreadInActive({
      rootId: ROOT,
      ledgerTaskIds: [ROOT, QA],
      visibleReports: [],
      tasks: [
        {
          filename: `${ROOT}.md`,
          physical_scope: "archive",
          path: `fcop/_lifecycle/archive/${ROOT}.md`,
        },
        {
          filename: `${QA}.md`,
          physical_scope: "archive",
          path: `fcop/_lifecycle/archive/${QA}.md`,
          bucket: "active",
        },
      ],
    });
    assert.equal(ok, false);
  });

  it("shows active thread when open task exists even without reports", () => {
    const ok = shouldShowReportThreadInActive({
      rootId: ROOT,
      ledgerTaskIds: [ROOT, QA],
      visibleReports: [],
      tasks: [
        {
          filename: `${ROOT}.md`,
          physical_scope: "active",
          path: `fcop/_lifecycle/active/${ROOT}.md`,
        },
      ],
    });
    assert.equal(ok, true);
  });

  it("hides active thread when root archived even with reports", () => {
    const ok = shouldShowReportThreadInActive({
      rootId: ROOT,
      ledgerTaskIds: [ROOT],
      visibleReports: [{ filename: "REPORT-x.md" }],
      tasks: [
        {
          filename: `${ROOT}.md`,
          physical_scope: "archive",
          path: `fcop/_lifecycle/archive/${ROOT}.md`,
        },
      ],
      rootTask: {
        filename: `${ROOT}.md`,
        physical_scope: "archive",
      },
    });
    assert.equal(ok, false);
  });

  it("archive tab shows sealed thread", () => {
    const ok = shouldShowReportThreadInArchive({
      rootId: ROOT,
      ledgerTaskIds: [ROOT],
      visibleReports: [],
      tasks: [
        {
          filename: `${ROOT}.md`,
          physical_scope: "archive",
        },
      ],
    });
    assert.equal(ok, true);
  });

  it("task count matches non-archived open tasks in active tab", () => {
    const members = [
      {
        filename: `${ROOT}.md`,
        physical_scope: "active",
      },
      {
        filename: `${QA}.md`,
        physical_scope: "archive",
        bucket: "active",
      },
    ];
    assert.equal(countReportThreadTasksForDisplay(members, "active"), 1);
  });

  it("non-empty task chips imply non-zero task count", () => {
    const members = [
      { filename: `${ROOT}.md`, physical_scope: "active" },
      { filename: `${QA}.md`, physical_scope: "review" },
    ];
    const n = countReportThreadTasksForDisplay(members, "active");
    assert.ok(n > 0);
    assert.equal(n, 2);
  });
});
