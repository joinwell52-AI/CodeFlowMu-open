import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateReworkSettlement } from "../reworkSettlement.ts";

describe("reworkSettlement", () => {
  it("accepts projected child review state as settled rework", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-rework-"));
    try {
      const fcopRoot = join(root, "fcop");
      await mkdir(join(fcopRoot, "reports"), { recursive: true });
      const reportId = "REPORT-20260709-005-PM-to-ADMIN";
      await writeFile(
        join(fcopRoot, "reports", `${reportId}.md`),
        [
          "---",
          "sender: PM",
          "recipient: ADMIN",
          "status: done",
          "created_at: 2026-07-09T11:43:34+08:00",
          "---",
          "# PM final",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await evaluateReworkSettlement({
        fcopRoot,
        taskId: "TASK-20260709-001",
        reportId,
        taskFm: {
          recipient: "PM",
          thread_key: "panel-task-001",
          review_status: "rejected",
          reopened_count: 1,
          reopen_reason: "需要补 QA 独立验收",
          transitions: [
            {
              at: "2026-07-09T10:37:20+08:00",
              action: "reject_review",
            },
          ],
        },
        allTasks: [
          {
            task_id: "TASK-20260709-003",
            thread_key: "panel-task-001",
            recipient: "DEV",
            parent: "TASK-20260709-001",
            bucket: "active",
            lifecycle_projection: "review",
            display_status: "waiting_pm_review",
            created_at: "2026-07-09T10:45:33+08:00",
          },
          {
            task_id: "TASK-20260709-004",
            thread_key: "panel-task-001",
            recipient: "QA",
            parent: "TASK-20260709-001",
            bucket: "done",
            created_at: "2026-07-09T10:45:40+08:00",
          },
        ],
      });

      assert.equal(result.settled, true);
      if (result.settled) {
        assert.equal(result.patch.review_status, "rework_done");
        assert.equal(result.patch.display_status, "ready_for_review");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
