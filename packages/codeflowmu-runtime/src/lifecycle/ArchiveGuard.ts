import type { OpenChildTaskRef } from "./childTaskArchiveGate.ts";
import type { LifecycleStage, TaskFm } from "./types.ts";

export class ArchiveGuard {
  assertNotFrozen(task: TaskFm, pathStage?: LifecycleStage | null): void {
    if (pathStage === "archive") {
      throw new Error("task is frozen/archive; modification denied");
    }
    if (task.frozen === true) {
      throw new Error("task is frozen/archive; modification denied");
    }
  }

  assertCanArchive(task: TaskFm, reason: string, pathStage: LifecycleStage): void {
    if (pathStage !== "done") {
      throw new Error(
        `archive_task denied: expected state done, got ${pathStage}`,
      );
    }

    if (!reason.trim()) {
      throw new Error("archive_task denied: archive_reason is required");
    }

    if (task.review_status && task.review_status !== "approved") {
      throw new Error(
        `archive_task denied: review_status must be approved, got ${task.review_status}`,
      );
    }
  }

  /** Skip done/review gate — archive_authority may withdraw inbox/active/review tasks. */
  assertCanForceArchive(
    task: TaskFm,
    reason: string,
    pathStage: LifecycleStage,
  ): void {
    if (pathStage === "archive") {
      throw new Error("force_archive_task denied: task already archived");
    }
    if (pathStage === "done") {
      throw new Error(
        "force_archive_task denied: task is done; use normal archive_task",
      );
    }
    if (!["inbox", "active", "review"].includes(pathStage)) {
      throw new Error(
        `force_archive_task denied: unsupported stage ${pathStage}`,
      );
    }
    if (!reason.trim()) {
      throw new Error("force_archive_task denied: archive_reason is required");
    }
  }

  /** ADMIN→PM mainline: block normal archive when child tasks remain open. */
  assertNoOpenChildTasks(openChildren: OpenChildTaskRef[]): void {
    if (openChildren.length > 0) {
      const summary = openChildren
        .map((c) => `${c.task_id}(${c.bucket})`)
        .join(", ");
      throw new Error(
        `CHILD_TASKS_OPEN: cannot archive mainline while child tasks are open: ${summary}`,
      );
    }
  }
}
