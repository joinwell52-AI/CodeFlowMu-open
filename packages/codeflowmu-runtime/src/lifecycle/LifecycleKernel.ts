/**
 * LifecycleKernel — ADR-0002 exclusive authority for `_lifecycle/` MV.
 *
 * Agents and MCP tools must not rename/move lifecycle buckets directly;
 * all submit_review / approve_review / archive_task syscalls route here.
 */

import {
  LifecycleStateMachine,
  type LifecycleStateMachineOpts,
} from "../lifecycle/LifecycleStateMachine.ts";
import type { LifecycleTransitionResult } from "./types.ts";
import { projectRootFromLifecycleRoot } from "./childTaskArchiveGate.ts";
import { withProjectWriteLease } from "../project/ProjectWriteBarrier.ts";

export type { LifecycleStateMachineOpts as LifecycleKernelOpts };

export class LifecycleKernel {
  readonly #sm: LifecycleStateMachine;
  readonly #projectRoot: string;

  constructor(opts: LifecycleStateMachineOpts) {
    this.#sm = new LifecycleStateMachine(opts);
    this.#projectRoot = projectRootFromLifecycleRoot(opts.lifecycleRoot);
  }

  get stateMachine(): LifecycleStateMachine {
    return this.#sm;
  }

  async submitReview(input: {
    taskId: string;
    actor: string;
    reportId: string;
    reason?: string;
  }): Promise<LifecycleTransitionResult> {
    return withProjectWriteLease(this.#projectRoot, "lifecycle.submit-review", () =>
      this.#sm.submitReview(input));
  }

  async approveReview(input: {
    taskId: string;
    actor: string;
    note?: string;
    humanAcceptance?: import("./types.ts").HumanTaskAcceptance;
  }): Promise<LifecycleTransitionResult> {
    return withProjectWriteLease(this.#projectRoot, "lifecycle.approve-review", () =>
      this.#sm.approveReview(input));
  }

  async rejectReview(input: {
    taskId: string;
    actor: string;
    reason?: string;
  }): Promise<LifecycleTransitionResult> {
    return withProjectWriteLease(this.#projectRoot, "lifecycle.reject-review", () =>
      this.#sm.rejectReview({
        ...input,
        reason: input.reason ?? "LifecycleKernel.rejectReview",
      }));
  }

  async archiveTask(input: {
    taskId: string;
    actor: string;
    reason?: string;
    force?: boolean;
  }): Promise<LifecycleTransitionResult> {
    return withProjectWriteLease(this.#projectRoot, "lifecycle.archive-task", () =>
      this.#sm.archiveTask({
        ...input,
        reason: input.reason ?? "LifecycleKernel.archiveTask",
      }));
  }

  async reopenTask(input: {
    taskId: string;
    actor: string;
    reason?: string;
  }): Promise<LifecycleTransitionResult> {
    return withProjectWriteLease(this.#projectRoot, "lifecycle.reopen-task", () =>
      this.#sm.reopenTask({ ...input, reason: input.reason ?? "" }));
  }

  async finishTaskLegacy(input: {
    taskId: string;
    actor: string;
    note?: string;
  }): Promise<LifecycleTransitionResult> {
    return withProjectWriteLease(this.#projectRoot, "lifecycle.finish-task", () =>
      this.#sm.finishTaskLegacy(input));
  }

  async runtimeDispatchInboxToActive(
    taskFilePath: string,
    claim?: { attemptId?: string; leaseId?: string; agentId?: string },
  ): Promise<void> {
    return withProjectWriteLease(this.#projectRoot, "lifecycle.runtime-dispatch", () =>
      this.#sm.runtimeDispatchInboxToActive(taskFilePath, claim));
  }

  async runtimeRepairInboxSplit(taskFilePath: string, reason?: string): Promise<void> {
    return withProjectWriteLease(this.#projectRoot, "lifecycle.runtime-repair", () =>
      this.#sm.runtimeRepairInboxSplit(taskFilePath, reason));
  }

  async runtimeRestoreActiveToInbox(
    taskFilePath: string,
    reason?: string,
  ): Promise<void> {
    return withProjectWriteLease(this.#projectRoot, "lifecycle.runtime-restore", () =>
      this.#sm.runtimeRestoreActiveToInbox(taskFilePath, reason));
  }

  async runtimeSupersedeForRework(input: {
    taskId: string;
    supersededBy: string;
    reason: string;
  }): Promise<LifecycleTransitionResult> {
    return withProjectWriteLease(this.#projectRoot, "lifecycle.supersede-rework", () =>
      this.#sm.runtimeSupersedeForRework(input));
  }
}
