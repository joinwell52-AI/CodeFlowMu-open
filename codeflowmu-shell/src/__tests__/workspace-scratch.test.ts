import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { executeWorkspaceScratch } from "../workspace-scratch.ts";

describe("workspace scratch", () => {
  it("provides a task-bound create/write/read/list/cleanup lifecycle", () => {
    const root = mkdtempSync(join(tmpdir(), "cf-scratch-"));
    try {
      const common = {
        projectRoot: root,
        taskId: "TASK-20260803-001",
        currentTaskId: "TASK-20260803-001",
        actor: "PM-01",
        sessionId: "session-scratch-1",
      };
      executeWorkspaceScratch({ ...common, operation: "create", path: "notes" });
      executeWorkspaceScratch({ ...common, operation: "write", path: "notes/plan.md", content: "draft\n" });
      const read = executeWorkspaceScratch({ ...common, operation: "read", path: "notes/plan.md" });
      assert.equal(read["content"], "draft\n");
      const listed = executeWorkspaceScratch({ ...common, operation: "list" });
      assert.deepEqual(
        (listed["entries"] as Array<Record<string, unknown>>).map((row) => row["path"]),
        ["notes", "notes/plan.md"],
      );
      const metadata = JSON.parse(readFileSync(join(
        root,
        ".codeflowmu",
        "scratch",
        common.taskId,
        ".codeflowmu-scratch.json",
      ), "utf8")) as Record<string, unknown>;
      assert.equal(metadata["created_by"], "PM-01");
      assert.equal(metadata["session_id"], "session-scratch-1");
      executeWorkspaceScratch({ ...common, operation: "cleanup" });
      assert.equal(existsSync(join(root, ".codeflowmu", "scratch", common.taskId)), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects task mismatch and path traversal", () => {
    const root = mkdtempSync(join(tmpdir(), "cf-scratch-boundary-"));
    try {
      assert.throws(
        () => executeWorkspaceScratch({
          projectRoot: root,
          operation: "write",
          taskId: "TASK-ONE",
          currentTaskId: "TASK-TWO",
          path: "file.txt",
          content: "x",
        }),
        /SCRATCH_TASK_SCOPE_MISMATCH/,
      );
      assert.throws(
        () => executeWorkspaceScratch({
          projectRoot: root,
          operation: "write",
          taskId: "TASK-ONE",
          currentTaskId: "TASK-ONE",
          path: "../../outside.txt",
          content: "x",
        }),
        /SCRATCH_PATH_OUT_OF_SCOPE/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
