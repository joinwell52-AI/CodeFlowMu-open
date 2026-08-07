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
import { isTaskReopenedForReworkFromLedger } from "../ledger/taskReworkSemantics.ts";
import {
  assertTrustedHumanTaskAcceptance,
  findPendingHumanReview,
  humanDecisionTaskPatch,
} from "./humanTaskAcceptance.ts";
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
    if (fm.state && fm.state !== "dispatched" && fm.state !== "running") return fm.state;
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
    humanAcceptance?: import("./types.ts").HumanTaskAcceptance;
  }): Promise<LifecycleTransitionResult> {
    const { path, filename } = await this.locateTask(input.taskId);
    const { fm } = await this.store.read(path);
    const from = this.resolveStage(path, fm);
    this.archiveGuard.assertNotFrozen(fm, from);
    if (from !== "review") {
      throw new Error(`approve_review denied: expected state review, got ${from}`);
    }
    if (
      fm.issue_blocking === true &&
      String(fm.blocking_issue_id ?? "").trim()
    ) {
      throw new Error(
        `approve_review denied: unresolved blocking ISSUE ${fm.blocking_issue_id}`,
      );
    }
    const pendingHumanReview = await findPendingHumanReview(
      this.lifecycleRoot,
      input.taskId,
    );
    // needs_human means a trusted human must decide; it does not imply ADMIN.
    // The selected role must still satisfy the task's ordinary done_authority.
    this.authority.assert(fm, input.actor, "approve_review");
    const acceptance = pendingHumanReview
      ? assertTrustedHumanTaskAcceptance({
          task: fm,
          actor: input.actor,
          pending: pendingHumanReview,
          acceptance: input.humanAcceptance,
        })
      : undefined;
    const basedOn = acceptance
      ? [acceptance.decisionId, acceptance.reviewId, acceptance.reportId]
      : undefined;

    await this.appendTransition(path, {
      from,
      to: "done",
      by: input.actor,
      action: "approve_review",
      decision: "approved",
      ...(basedOn ? { based_on: basedOn } : {}),
      ...(input.note ? { reason: input.note } : {}),
    });

    const approvedAt = new Date().toISOString();
    await this.store.patch(path, {
      review_status: "approved",
      approved_by: input.actor,
      approved_at: approvedAt,
      lifecycle_projection: "done",
      display_status: "done",
      ...(acceptance ? humanDecisionTaskPatch(acceptance, input.actor, approvedAt, input.note) : {}),
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
  async runtimeDispatchInboxToActive(
    taskPath: string,
    claim?: { attemptId?: string; leaseId?: string; agentId?: string },
  ): Promise<void> {
    this.guardAutomaticWrite("runtimeDispatchInboxToActive");
    const from = stageFromPath(taskPath, this.lifecycleRoot);
    if (from !== "inbox") return;

    const filename = basename(taskPath);
    const dest = join(this.lifecycleRoot, "active", filename);
    try {
      await fs.access(dest);
      throw new Error(`runtime dispatch found ambiguous duplicate task paths: ${taskPath} and ${dest}`);
    } catch {
      /* dest absent unless the explicit ambiguity error was thrown */
      try {
        await fs.access(dest);
        throw new Error(`runtime dispatch found ambiguous duplicate task paths: ${taskPath} and ${dest}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    await this.appendTransition(taskPath, {
      from: "inbox",
      to: "active",
      by: "CodeFlowMu",
      action: "runtime_dispatch",
    });

    await this.store.patch(taskPath, {
      state: "active",
      lifecycle_path: "fcop/_lifecycle/active",
      ...(claim?.attemptId ? { dispatch_attempt_id: claim.attemptId } : {}),
      ...(claim?.leaseId ? { execution_lease_id: claim.leaseId } : {}),
      ...(claim?.agentId ? { dispatch_agent_id: claim.agentId } : {}),
    });

    await fs.mkdir(dirname(dest), { recursive: true });
    await fs.rename(taskPath, dest);
    const persisted = await this.store.read(dest);
    if (stageFromPath(dest, this.lifecycleRoot) !== "active" || String(persisted.fm.state ?? "") !== "active") {
      await fs.rename(dest, taskPath).catch(() => undefined);
      throw new Error(`runtime dispatch read-back failed for ${filename}`);
    }
  }

  async runtimeRepairInboxSplit(
    taskPath: string,
    reason = "lifecycle_split_repair",
  ): Promise<void> {
    this.guardAutomaticWrite("runtimeRepairInboxSplit");
    if (stageFromPath(taskPath, this.lifecycleRoot) !== "inbox") return;
    await this.appendTransition(taskPath, {
      from: "inbox",
      to: "inbox",
      by: "CodeFlowMu",
      action: "runtime_repair_lifecycle_split",
      reason,
    });
    await this.store.patch(taskPath, {
      state: "inbox",
      lifecycle_path: "fcop/_lifecycle/inbox",
      dispatch_attempt_id: undefined,
      execution_lease_id: undefined,
      dispatch_agent_id: undefined,
    });
    const persisted = await this.store.read(taskPath);
    if (stageFromPath(taskPath, this.lifecycleRoot) !== "inbox" || String(persisted.fm.state ?? "") !== "inbox") {
      throw new Error(`runtime inbox repair read-back failed for ${basename(taskPath)}`);
    }
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
      throw new Error(`runtime restore found ambiguous duplicate task paths: ${taskPath} and ${dest}`);
    } catch {
      try {
        await fs.access(dest);
        throw new Error(`runtime restore found ambiguous duplicate task paths: ${taskPath} and ${dest}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
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
    const persisted = await this.store.read(dest);
    if (stageFromPath(dest, this.lifecycleRoot) !== "inbox" || String(persisted.fm.state ?? "") !== "inbox") {
      await fs.rename(dest, taskPath).catch(() => undefined);
      throw new Error(`runtime restore read-back failed for ${filename}`);
    }
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
