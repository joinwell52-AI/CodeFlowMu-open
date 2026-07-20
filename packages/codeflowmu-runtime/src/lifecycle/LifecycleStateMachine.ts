import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";

import { resolveDoneAuthority } from "./authorityDefaults.ts";
import { ArchiveGuard } from "./ArchiveGuard.ts";
import { AuthorityError, AuthorityGuard } from "./AuthorityGuard.ts";
import {
  assertMainlineArchiveChildrenReady,
  autoArchiveAcceptedChildrenByParentMainline,
  ChildTasksNotAcceptedError,
  ChildTasksOpenError,
  collectRelatedChildTasks,
  projectRootFromLifecycleRoot,
  terminateOpenChildTasksByParentArchive,
} from "./childTaskArchiveGate.ts";
import { isAdminMainlineTaskFilename } from "./closedParentResidue.ts";
import { evaluateReworkSettlement } from "../ledger/reworkSettlement.ts";
import { parseMarkdownFrontmatter } from "../ledger/frontmatter.ts";
import { isTaskReopenedForReworkFromLedger } from "../ledger/taskReworkSemantics.ts";
import { TaskFrontmatterStore } from "./TaskFrontmatterStore.ts";
import { TransitionRecorder } from "./TransitionRecorder.ts";
import {
  findTaskPathById,
  lifecycleRelPath,
  normalizePath,
  stageFromPath,
} from "./taskPathUtils.ts";
import { assertYamlFallbackWriteAllowed } from "./yamlFallbackGuard.ts";
import type {
  AppendTransitionResult,
  LifecycleStage,
  LifecycleTransitionResult,
  TaskFm,
  TransitionInput,
} from "./types.ts";

export { AuthorityError, ChildTasksNotAcceptedError, ChildTasksOpenError };

export interface LifecycleStateMachineOpts {
  /** Absolute path to `fcop/_lifecycle/`. */
  lifecycleRoot: string;
  /** When true, automatic runtime governance must not write frontmatter. */
  yamlFallbackMode?: boolean;
}

const FORBIDDEN_TRANSITIONS: Array<[LifecycleStage, LifecycleStage]> = [
  ["active", "done"],
  ["active", "archive"],
  ["review", "archive"],
];

/** ADMIN 打回主任务（PM 返工） vs PM 打回下游任务。 */
function resolveRejectDisplayStatus(
  fm: Record<string, unknown>,
  actor: string,
): string {
  const actorUp = actor.trim().toUpperCase();
  if (actorUp !== "ADMIN") {
    return "waiting_rework";
  }
  const to = String(fm.to ?? fm.recipient ?? "")
    .trim()
    .toUpperCase();
  const driver = String(fm.driver ?? "")
    .trim()
    .toUpperCase();
  if (to === "PM" || driver === "PM") {
    return "waiting_pm_rework";
  }
  return "waiting_rework";
}

async function hasPendingHumanReview(
  lifecycleRoot: string,
  taskId: string,
): Promise<boolean> {
  const reviewsDir = join(lifecycleRoot, "..", "reviews");
  let names: string[] = [];
  try {
    names = await fs.readdir(reviewsDir);
  } catch {
    return false;
  }
  const canonical = /^TASK-\d{8}-\d{3,}/i.exec(taskId)?.[0].toUpperCase() ?? taskId.toUpperCase();
  for (const name of names) {
    if (!name.startsWith("REVIEW-") || !name.endsWith(".md")) continue;
    const raw = await fs.readFile(join(reviewsDir, name), "utf-8").catch(() => "");
    const review = parseMarkdownFrontmatter(raw) as Record<string, unknown>;
    if (String(review.decision ?? "").toLowerCase() !== "needs_human") continue;
    const reviewTask = String(review.task_id ?? review.subject_id ?? "");
    const reviewCanonical =
      /^TASK-\d{8}-\d{3,}/i.exec(reviewTask)?.[0].toUpperCase() ?? reviewTask.toUpperCase();
    if (reviewCanonical !== canonical) continue;
    const approval = review.human_approval;
    if (
      !approval ||
      typeof approval !== "object" ||
      !String((approval as Record<string, unknown>).approved_at ?? "").trim()
    ) {
      return true;
    }
  }
  return false;
}

export class LifecycleStateMachine {
  private readonly lifecycleRoot: string;
  private readonly store: TaskFrontmatterStore;
  private readonly recorder: TransitionRecorder;
  private readonly authority: AuthorityGuard;
  private readonly archiveGuard: ArchiveGuard;
  private readonly yamlFallbackMode: boolean;

  constructor(opts: LifecycleStateMachineOpts) {
    this.lifecycleRoot = normalizePath(opts.lifecycleRoot);
    this.yamlFallbackMode = opts.yamlFallbackMode === true;
    this.store = new TaskFrontmatterStore();
    this.recorder = new TransitionRecorder(this.store);
    this.authority = new AuthorityGuard();
    this.archiveGuard = new ArchiveGuard();
  }

  private guardAutomaticWrite(operation: string): void {
    assertYamlFallbackWriteAllowed(this.yamlFallbackMode, "automatic", operation);
  }

  private async appendTransition(
    taskPath: string,
    input: TransitionInput,
    opts?: import("./types.ts").LifecycleWriteOpts,
  ): Promise<AppendTransitionResult> {
    return this.recorder.append(taskPath, input, opts);
  }

  async locateTask(
    taskId: string,
  ): Promise<{ path: string; stage: LifecycleStage; filename: string }> {
    const found = await findTaskPathById(this.lifecycleRoot, taskId);
    if (!found) {
      throw new Error(`task not found: ${taskId}`);
    }
    return found;
  }

  resolveStage(taskPath: string, fm: TaskFm): LifecycleStage {
    const fromPath = stageFromPath(taskPath, this.lifecycleRoot);
    if (fromPath) return fromPath;
    if (fm.state && fm.state !== "dispatched") return fm.state;
    throw new Error(`cannot resolve lifecycle stage for ${taskPath}`);
  }

  async submitReview(input: {
    taskId: string;
    actor: string;
    reportId: string;
    reason?: string;
  }): Promise<LifecycleTransitionResult> {
    const { path, filename } = await this.locateTask(input.taskId);
    const { fm } = await this.store.read(path);
    const from = this.resolveStage(path, fm);
    this.archiveGuard.assertNotFrozen(fm, from);
    if (from !== "active") {
      throw new Error(`submit_review denied: expected state active, got ${from}`);
    }
    this.authority.assert(fm, input.actor, "submit_review");
    if (!input.reportId?.trim()) {
      throw new Error("submit_review denied: report_id is required");
    }

    const reworkFields = {
      display_status: fm.display_status,
      reopen_reason: fm.reopen_reason,
      review_status: fm.review_status,
      reopened_count: fm.reopened_count,
      review_note: fm.review_note,
      rework_completed_by_report: fm.rework_completed_by_report,
      scope: from,
      state: fm.state,
    };
    if (isTaskReopenedForReworkFromLedger(reworkFields)) {
      const fcopRoot = join(this.lifecycleRoot, "..");
      const settlement = await evaluateReworkSettlement({
        taskFm: { ...fm, transitions: fm.transitions },
        taskId: input.taskId,
        reportId: input.reportId,
        fcopRoot,
      });
      if (!settlement.settled) {
        throw new Error(
          "submit_review denied: task reopened for ADMIN rework; complete rework before resubmit",
        );
      }
      if (Object.keys(settlement.patch).length > 0) {
        await this.store.patch(path, settlement.patch);
      }
    }

    await this.appendTransition(path, {
      from,
      to: "review",
      by: input.actor,
      action: "submit_review",
      report: input.reportId,
      ...(input.reason ? { reason: input.reason } : {}),
    });

    await this.store.patch(path, {
      review_status: "pending",
      submitted_at: new Date().toISOString(),
      current_owner: fm.reviewer ?? fm.done_authority ?? fm.from ?? undefined,
    });

    return this.moveTask(path, filename, from, "review");
  }

  async approveReview(input: {
    taskId: string;
    actor: string;
    note?: string;
  }): Promise<LifecycleTransitionResult> {
    const { path, filename } = await this.locateTask(input.taskId);
    const { fm } = await this.store.read(path);
    const from = this.resolveStage(path, fm);
    this.archiveGuard.assertNotFrozen(fm, from);
    if (from !== "review") {
      throw new Error(`approve_review denied: expected state review, got ${from}`);
    }
    const actorIsAdmin = input.actor.trim().toUpperCase() === "ADMIN";
    const pendingHumanReview = await hasPendingHumanReview(
      this.lifecycleRoot,
      input.taskId,
    );
    // A needs_human decision is a risk boundary: only ADMIN may explicitly
    // accept it, even when the normal task done_authority is PM.
    if (!(actorIsAdmin && pendingHumanReview)) {
      this.authority.assert(fm, input.actor, "approve_review");
    }
    if (!actorIsAdmin && pendingHumanReview) {
      throw new Error(
        "approve_review denied: unresolved needs_human review requires explicit ADMIN risk acceptance",
      );
    }

    await this.appendTransition(path, {
      from,
      to: "done",
      by: input.actor,
      action: "approve_review",
      decision: "approved",
      ...(input.note ? { reason: input.note } : {}),
    });

    await this.store.patch(path, {
      review_status: "approved",
      approved_by: input.actor,
      approved_at: new Date().toISOString(),
      lifecycle_projection: "done",
      display_status: "done",
    });

    return this.moveTask(path, filename, from, "done");
  }

  async rejectReview(input: {
    taskId: string;
    actor: string;
    reason: string;
  }): Promise<LifecycleTransitionResult> {
    const { path, filename } = await this.locateTask(input.taskId);
    const { fm } = await this.store.read(path);
    const from = this.resolveStage(path, fm);
    this.archiveGuard.assertNotFrozen(fm, from);
    if (from !== "review") {
      throw new Error(`reject_review denied: expected state review, got ${from}`);
    }
    if (!input.reason?.trim()) {
      throw new Error("reject_review denied: reason is required");
    }
    if (input.actor.trim().toUpperCase() !== "ADMIN") {
      this.authority.assert(fm, input.actor, "reject_review");
    }

    const reopenedCount = (fm.reopened_count ?? 0) + 1;
    const displayStatus = resolveRejectDisplayStatus(fm, input.actor);

    await this.store.patch(path, {
      review_status: "rejected",
      reopen_reason: input.reason,
      reopened_count: reopenedCount,
      current_owner: fm.driver ?? fm.to ?? undefined,
      display_status: displayStatus,
    });

    await this.appendTransition(path, {
      from,
      to: "active",
      by: input.actor,
      action: "reject_review",
      decision: "rejected",
      reason: input.reason,
    });

    return this.moveTask(path, filename, from, "active");
  }

  async reopenTask(input: {
    taskId: string;
    actor: string;
    reason: string;
  }): Promise<LifecycleTransitionResult> {
    const { path, filename } = await this.locateTask(input.taskId);
    const { fm } = await this.store.read(path);
    const from = this.resolveStage(path, fm);
    this.archiveGuard.assertNotFrozen(fm, from);
    if (from === "archive") {
      throw new Error("reopen_task denied: archive tasks are frozen");
    }
    if (from !== "done") {
      throw new Error(`reopen_task denied: expected state done, got ${from}`);
    }
    if (!input.reason?.trim()) {
      throw new Error("reopen_task denied: reason is required");
    }
    this.authority.assert(fm, input.actor, "reopen_task");

    const reopenedCount = (fm.reopened_count ?? 0) + 1;

    await this.appendTransition(path, {
      from,
      to: "active",
      by: input.actor,
      action: "reopen_task",
      decision: "reopened",
      reason: input.reason,
    });

    await this.store.patch(path, {
      review_status: "reopened",
      reopen_reason: input.reason,
      reopened_count: reopenedCount,
      current_owner: fm.driver ?? fm.to ?? undefined,
      frozen: false,
    });

    return this.moveTask(path, filename, from, "active");
  }

  async archiveTask(input: {
    taskId: string;
    actor: string;
    reason: string;
    force?: boolean;
  }): Promise<LifecycleTransitionResult> {
    const { path, filename } = await this.locateTask(input.taskId);
    const { fm } = await this.store.read(path);
    const from = this.resolveStage(path, fm);
    this.archiveGuard.assertNotFrozen(fm, from);
    this.authority.assert(fm, input.actor, "archive_task");
    if (input.force) {
      this.archiveGuard.assertCanForceArchive(fm, input.reason, from);
    } else {
      this.archiveGuard.assertCanArchive(fm, input.reason, from);
    }

    const isMainline = isAdminMainlineTaskFilename(filename);
    const projectRoot = projectRootFromLifecycleRoot(this.lifecycleRoot);
    const mainTaskId = String(fm.task_id ?? input.taskId).replace(/\.md$/i, "");
    const mainThreadKey = String(fm.thread_key ?? "").trim() || undefined;

    if (isMainline && !input.force) {
      const autoArchiveChildren = await assertMainlineArchiveChildrenReady({
        lifecycleRoot: this.lifecycleRoot,
        projectRoot,
        mainTaskId,
        mainFilename: filename,
        mainThreadKey,
      });
      await autoArchiveAcceptedChildrenByParentMainline({
        lifecycleRoot: this.lifecycleRoot,
        projectRoot,
        children: autoArchiveChildren,
        actor: input.actor,
        reason: input.reason,
        parentTaskId: mainTaskId,
      });
    }

    // Move before metadata when force bypasses forbidden active/review→archive.
    // If rename fails, frontmatter must not claim archive while still on disk in active/.
    const moved = await this.moveTask(path, filename, from, "archive", {
      bypassForbidden: Boolean(input.force),
    });

    const destPath = join(this.lifecycleRoot, "archive", filename);
    await this.appendTransition(
      destPath,
      {
        from,
        to: "archive",
        by: input.actor,
        action: input.force ? "force_archive_task" : "archive_task",
        decision: "archived",
        reason: input.reason,
      },
      { allowFrozenWrite: true },
    );

    await this.store.patch(
      destPath,
      {
        frozen: true,
        archived_by: input.actor,
        archived_at: new Date().toISOString(),
        archive_reason: input.reason,
        lifecycle_projection: "archive",
        display_status: "archived",
        ...(input.force
          ? { archive_mode: "force", task_type: "force_archive" }
          : {}),
      },
      { allowFrozenWrite: true },
    );

    if (isMainline && input.force) {
      await terminateOpenChildTasksByParentArchive({
        lifecycleRoot: this.lifecycleRoot,
        projectRoot,
        mainTaskId,
        mainFilename: filename,
        mainThreadKey,
        actor: input.actor,
        reason: input.reason,
      });
    }

    return moved;
  }

  async finishTaskLegacy(input: {
    taskId: string;
    actor: string;
    note?: string;
  }): Promise<LifecycleTransitionResult> {
    const { path } = await this.locateTask(input.taskId);
    const { fm } = await this.store.read(path);
    const stage = this.resolveStage(path, fm);
    this.archiveGuard.assertNotFrozen(fm, stage);

    if (stage === "active") {
      throw new Error(
        "finish_task is legacy and cannot move active task to done. Use submit_review first. Done requires upstream approve_review.",
      );
    }

    if (stage === "review") {
      const authority = resolveDoneAuthority(fm);
      if (input.actor.toUpperCase() !== authority) {
        throw new AuthorityError(
          `finish_task denied: actor ${input.actor} is not done_authority ${authority}`,
        );
      }
      return this.approveReview({
        taskId: input.taskId,
        actor: input.actor,
        note: input.note,
      });
    }

    if (stage === "done") {
      throw new Error(
        "finish_task denied: task is done; use archive_task explicitly",
      );
    }

    if (stage === "archive") {
      throw new Error("finish_task denied: task is frozen/archive");
    }

    throw new Error(`finish_task denied: unsupported state ${stage}`);
  }

  /** Runtime dispatch: inbox → active with transition record (no authority check). */
  async runtimeDispatchInboxToActive(taskPath: string): Promise<void> {
    this.guardAutomaticWrite("runtimeDispatchInboxToActive");
    const from = stageFromPath(taskPath, this.lifecycleRoot);
    if (from !== "inbox") return;

    const filename = basename(taskPath);
    const dest = join(this.lifecycleRoot, "active", filename);
    try {
      await fs.access(dest);
      return;
    } catch {
      /* dest absent */
    }

    await this.appendTransition(taskPath, {
      from: "inbox",
      to: "active",
      by: "CodeFlowMu",
      action: "runtime_dispatch",
    });

    await fs.mkdir(dirname(dest), { recursive: true });
    await fs.rename(taskPath, dest);
  }

  /**
   * Runtime rollback: active → inbox when dispatch session failed without REPORT.
   * Symmetric to {@link runtimeDispatchInboxToActive}; no authority check.
   */
  async runtimeRestoreActiveToInbox(
    taskPath: string,
    reason = "runtime_dispatch_failed",
  ): Promise<void> {
    this.guardAutomaticWrite("runtimeRestoreActiveToInbox");
    const from = stageFromPath(taskPath, this.lifecycleRoot);
    if (from !== "active") return;

    const filename = basename(taskPath);
    const dest = join(this.lifecycleRoot, "inbox", filename);
    try {
      await fs.access(dest);
      return;
    } catch {
      /* inbox copy absent */
    }

    await this.appendTransition(taskPath, {
      from: "active",
      to: "inbox",
      by: "CodeFlowMu",
      action: "runtime_restore_failed_dispatch",
      reason,
    });

    // The dispatcher claim guard reads frontmatter.state, not only the
    // lifecycle directory. Leaving state=dispatched after moving back to
    // inbox makes every recovery look already_dispatched forever.
    await this.store.patch(taskPath, {
      state: "inbox",
      lifecycle_path: "fcop/_lifecycle/inbox",
    });

    await fs.mkdir(dirname(dest), { recursive: true });
    await fs.rename(taskPath, dest);
  }

  /**
   * REVIEW-GATE created a replacement task. The rejected source round is a
   * terminal outcome, not active work. Keep it in done for audit/history and
   * point at the replacement task.
   */
  async runtimeSupersedeForRework(input: {
    taskId: string;
    supersededBy: string;
    reason: string;
  }): Promise<LifecycleTransitionResult> {
    this.guardAutomaticWrite("runtimeSupersedeForRework");
    const { path, filename } = await this.locateTask(input.taskId);
    const { fm } = await this.store.read(path);
    const from = this.resolveStage(path, fm);
    if (from === "archive" || from === "done") {
      await this.store.patch(path, {
        review_status: "rejected",
        lifecycle_projection: from,
        display_status: "rejected_superseded",
        superseded_by: input.supersededBy,
        superseded_reason: input.reason,
      });
      return {
        ok: true,
        task_id: String(fm.task_id ?? input.taskId),
        from,
        to: from,
        path: lifecycleRelPath(from, filename),
      };
    }

    await this.appendTransition(path, {
      from,
      to: "done",
      by: "CodeFlowMu",
      action: "supersede_for_rework",
      decision: "rejected",
      reason: input.reason,
    });
    await this.store.patch(path, {
      review_status: "rejected",
      lifecycle_projection: "done",
      display_status: "rejected_superseded",
      superseded_by: input.supersededBy,
      superseded_reason: input.reason,
      superseded_at: new Date().toISOString(),
    });
    return this.moveTask(path, filename, from, "done", {
      bypassForbidden: true,
    });
  }

  private async moveTask(
    taskPath: string,
    filename: string,
    from: LifecycleStage,
    to: LifecycleStage,
    opts?: { bypassForbidden?: boolean },
  ): Promise<LifecycleTransitionResult> {
    if (!opts?.bypassForbidden) {
      for (const [f, t] of FORBIDDEN_TRANSITIONS) {
        if (from === f && to === t) {
          throw new Error(`transition denied: ${from} → ${to}`);
        }
      }
    }
    if (from === "archive") {
      throw new Error("transition denied: archive → any");
    }

    const dest = join(this.lifecycleRoot, to, filename);
    await fs.mkdir(dirname(dest), { recursive: true });
    await fs.rename(taskPath, dest);

    const taskId =
      (await this.store.read(dest)).fm.task_id ??
      filename.replace(/\.md$/i, "");

    if (to === "done" || to === "archive") {
      const projectRoot = projectRootFromLifecycleRoot(this.lifecycleRoot);
      try {
        const { removeTaskFromAgentQueue } = await import(
          "../pm/agentTaskQueue.ts"
        );
        await removeTaskFromAgentQueue(projectRoot, taskId);
      } catch {
        /* queue cleanup is best-effort */
      }
    }

    return {
      ok: true,
      task_id: taskId,
      from,
      to,
      path: lifecycleRelPath(to, filename),
    };
  }
}
