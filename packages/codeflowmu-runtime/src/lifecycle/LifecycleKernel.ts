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

export type { LifecycleStateMachineOpts as LifecycleKernelOpts };

export class LifecycleKernel {
  readonly #sm: LifecycleStateMachine;

  constructor(opts: LifecycleStateMachineOpts) {
    this.#sm = new LifecycleStateMachine(opts);
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
    return this.#sm.submitReview(input);
  }

  async approveReview(input: {
    taskId: string;
    actor: string;
    note?: string;
  }): Promise<LifecycleTransitionResult> {
    return this.#sm.approveReview(input);
  }

  async rejectReview(input: {
    taskId: string;
    actor: string;
    reason?: string;
  }): Promise<LifecycleTransitionResult> {
    return this.#sm.rejectReview({
      ...input,
      reason: input.reason ?? "LifecycleKernel.rejectReview",
    });
  }

  async archiveTask(input: {
    taskId: string;
    actor: string;
    reason?: string;
  }): Promise<LifecycleTransitionResult> {
    return this.#sm.archiveTask({
      ...input,
      reason: input.reason ?? "LifecycleKernel.archiveTask",
    });
  }

  async runtimeDispatchInboxToActive(taskFilePath: string): Promise<void> {
    return this.#sm.runtimeDispatchInboxToActive(taskFilePath);
  }

  async runtimeRestoreActiveToInbox(
    taskFilePath: string,
    reason?: string,
  ): Promise<void> {
    return this.#sm.runtimeRestoreActiveToInbox(taskFilePath, reason);
  }
}
