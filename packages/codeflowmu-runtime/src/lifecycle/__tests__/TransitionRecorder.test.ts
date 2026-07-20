import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TransitionRecorder } from "../TransitionRecorder.ts";
import { TaskFrontmatterStore } from "../TaskFrontmatterStore.ts";
import { withTempLifecycle, writeTaskAt } from "./helpers.ts";

describe("TransitionRecorder", () => {
  it("skips duplicate transition with same from/to/by/action/note", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskId = "TASK-20260612-001-ADMIN-to-PM";
      const path = await writeTaskAt(lifecycleRoot, "inbox", `${taskId}.md`, {
        task_id: taskId,
        state: "inbox",
      });
      const store = new TaskFrontmatterStore();
      await store.write(
        path,
        {
          task_id: taskId,
          state: "inbox",
          transitions: [
            {
              at: "2026-06-12T10:00:00+08:00",
              from: "inbox",
              to: "active",
              by: "CodeFlowMu",
              action: "runtime_dispatch",
            },
          ],
        },
        "# Task\n",
      );

      const recorder = new TransitionRecorder(new TaskFrontmatterStore());
      const first = await recorder.append(path, {
        from: "inbox",
        to: "active",
        by: "CodeFlowMu",
        action: "runtime_dispatch",
      });
      assert.equal(first.appended, false);
      assert.equal(first.skipped_duplicate_transition, true);

      const { fm } = await new TaskFrontmatterStore().read(path);
      assert.equal(fm.transitions?.length, 1);
    });
  });

  it("appends when note differs even if other fields match", async () => {
    await withTempLifecycle(async ({ lifecycleRoot }) => {
      const taskId = "TASK-20260612-002-ADMIN-to-PM";
      const path = await writeTaskAt(lifecycleRoot, "active", `${taskId}.md`, {
        task_id: taskId,
        state: "active",
      });
      const store = new TaskFrontmatterStore();
      await store.write(
        path,
        {
          task_id: taskId,
          state: "active",
          transitions: [
            {
              at: "2026-06-12T10:00:00+08:00",
              from: "active",
              to: "inbox",
              by: "CodeFlowMu",
              action: "runtime_restore_failed_dispatch",
              reason: "session_failed",
            },
          ],
        },
        "# Task\n",
      );

      const recorder = new TransitionRecorder(new TaskFrontmatterStore());
      const result = await recorder.append(path, {
        from: "active",
        to: "inbox",
        by: "CodeFlowMu",
        action: "runtime_restore_failed_dispatch",
        reason: "dispatch_retry",
      });
      assert.equal(result.appended, true);

      const { fm } = await new TaskFrontmatterStore().read(path);
      assert.equal(fm.transitions?.length, 2);
    });
  });
});
