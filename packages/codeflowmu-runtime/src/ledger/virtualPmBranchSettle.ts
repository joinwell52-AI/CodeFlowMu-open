/**
 * Virtual PM auto review + archive for hot-path branch sub-tasks.
 * Governance runs as PM (not DEV/QA self-review); review_check must pass first.
 */

import { join } from "node:path";
import { promises as fs } from "node:fs";

import {
  inferTaskLine,
  resolveArchiveAuthority,
  resolveDoneAuthority,
  taskRouteRoles,
} from "../lifecycle/authorityDefaults.ts";
import { AuthorityGuard } from "../lifecycle/AuthorityGuard.ts";
import { TaskFrontmatterStore } from "../lifecycle/TaskFrontmatterStore.ts";
import type { TaskFm } from "../lifecycle/types.ts";
import { LifecycleKernel } from "../lifecycle/LifecycleKernel.ts";
import { findTaskPathById } from "../lifecycle/taskPathUtils.ts";
import { reviewCheck } from "../pm/PmGovernanceActions.ts";
import { LedgerBuilder } from "./LedgerBuilder.ts";
import { resolveLedgerLayout } from "./paths.ts";
import {
  approveHotPathTaskReview,
  archiveHotPathTask,
  locateHotPathTask,
} from "./hotPathTaskLifecycle.ts";

export const VIRTUAL_PM_ACTOR = "PM";
export const VIRTUAL_PM_AUTO_REVIEW_NOTE =
  "虚拟 PM 自动审核（支线子任务，review_check 通过）";
export const VIRTUAL_PM_AUTO_ARCHIVE_REASON =
  "虚拟 PM 自动归档（支线 PM 审核完成后）";

export interface VirtualPmBranchSettleResult {
  task_id: string;
  review_check_ok: boolean;
  reviewed: boolean;
  archived: boolean;
  skipped_reason?: string;
}

function isLowRiskBranchTask(fm: TaskFm): boolean {
  const rl = String(fm.risk_level ?? "low").trim().toLowerCase();
  return rl === "low" || rl === "";
}

function isPmDownstreamWorkerTask(fm: TaskFm): boolean {
  const { from, to } = taskRouteRoles(fm);
  if (from === "ADMIN" && to === "PM") return false;
  if (from !== "PM") return false;
  return /^(DEV|QA|OPS)(-\d+)?$/i.test(to);
}

function isPmDownstreamAutoReviewEligible(fm: TaskFm): boolean {
  if (!isPmDownstreamWorkerTask(fm)) return false;
  if (!isLowRiskBranchTask(fm)) return false;
  if (resolveDoneAuthority(fm) !== VIRTUAL_PM_ACTOR) return false;
  return true;
}

function isBranchPmArchivable(fm: TaskFm): boolean {
  if (inferTaskLine(fm) !== "branch") return false;
  if (!isLowRiskBranchTask(fm)) return false;
  if (resolveArchiveAuthority(fm) !== VIRTUAL_PM_ACTOR) return false;
  if (resolveDoneAuthority(fm) !== VIRTUAL_PM_ACTOR) return false;
  return true;
}

export async function settleVirtualPmBranchHotPathTask(
  projectRoot: string,
  taskId: string,
  opts?: { report_id?: string; skipReviewCheck?: boolean },
): Promise<VirtualPmBranchSettleResult | null> {
  const located = await locateHotPathTask(projectRoot, taskId);
  if (!located) return null;

  const store = new TaskFrontmatterStore();
  const { fm } = await store.read(located.path);
  if (!isBranchPmArchivable(fm)) {
    return {
      task_id: String(fm.task_id ?? taskId).replace(/\.md$/i, ""),
      review_check_ok: false,
      reviewed: false,
      archived: false,
      skipped_reason: "not branch PM-archivable hot_path task",
    };
  }

  const normalizedId = String(fm.task_id ?? taskId).replace(/\.md$/i, "");
  const guard = new AuthorityGuard();

  let reviewCheckOk = opts?.skipReviewCheck ?? false;
  if (!opts?.skipReviewCheck) {
    const check = await reviewCheck(projectRoot, {
      task_id: normalizedId,
      ...(opts?.report_id ? { report_id: opts.report_id } : {}),
    });
    reviewCheckOk = check?.ok ?? false;
    if (!reviewCheckOk) {
      return {
        task_id: normalizedId,
        review_check_ok: false,
        reviewed: false,
        archived: false,
        skipped_reason: "review_check failed",
      };
    }
  } else {
    reviewCheckOk = true;
  }

  const reviewStatus = String(fm.review_status ?? "").trim().toLowerCase();
  let reviewed = reviewStatus === "approved";

  if (reviewStatus !== "approved") {
    guard.assert(fm, VIRTUAL_PM_ACTOR, "approve_review");
    await approveHotPathTaskReview({
      projectRoot,
      taskId: normalizedId,
      actor: VIRTUAL_PM_ACTOR,
      note: VIRTUAL_PM_AUTO_REVIEW_NOTE,
    });
    reviewed = true;
  }

  const stillHot = await locateHotPathTask(projectRoot, normalizedId);
  if (!stillHot) {
    return {
      task_id: normalizedId,
      review_check_ok: reviewCheckOk,
      reviewed,
      archived: false,
      skipped_reason: "already not on hot path after review",
    };
  }

  await archiveHotPathTask({
    projectRoot,
    taskId: normalizedId,
    actor: VIRTUAL_PM_ACTOR,
    reason: VIRTUAL_PM_AUTO_ARCHIVE_REASON,
  });

  return {
    task_id: normalizedId,
    review_check_ok: reviewCheckOk,
    reviewed,
    archived: true,
  };
}

/** Auto PM review for `fcop/_lifecycle/review/TASK-*` PM→DEV/OPS/QA sub-tasks. */
export async function settleVirtualPmLifecycleReviewTask(
  projectRoot: string,
  taskId: string,
  opts?: { report_id?: string; skipReviewCheck?: boolean; autoArchive?: boolean },
): Promise<VirtualPmBranchSettleResult | null> {
  const layout = resolveLedgerLayout(projectRoot);
  const located = await findTaskPathById(layout.lifecycleRoot, taskId);
  if (!located) return null;

  const store = new TaskFrontmatterStore();
  const { fm } = await store.read(located.path);
  const normalizedId = String(fm.task_id ?? taskId).replace(/\.md$/i, "");

  if (!isPmDownstreamAutoReviewEligible(fm)) {
    return {
      task_id: normalizedId,
      review_check_ok: false,
      reviewed: false,
      archived: false,
      skipped_reason: "not PM downstream auto-review eligible lifecycle task",
    };
  }

  if (located.stage !== "review") {
    return {
      task_id: normalizedId,
      review_check_ok: false,
      reviewed: false,
      archived: false,
      skipped_reason: `expected review, got ${located.stage}`,
    };
  }

  let reviewCheckOk = opts?.skipReviewCheck ?? false;
  if (!opts?.skipReviewCheck) {
    const check = await reviewCheck(projectRoot, {
      task_id: normalizedId,
      ...(opts?.report_id ? { report_id: opts.report_id } : {}),
    });
    reviewCheckOk = check?.ok ?? false;
    if (!reviewCheckOk) {
      return {
        task_id: normalizedId,
        review_check_ok: false,
        reviewed: false,
        archived: false,
        skipped_reason: "review_check failed",
      };
    }
  }

  const guard = new AuthorityGuard();
  guard.assert(fm, VIRTUAL_PM_ACTOR, "approve_review");

  const kernel = new LifecycleKernel({ lifecycleRoot: layout.lifecycleRoot });
  await kernel.approveReview({
    taskId: normalizedId,
    actor: VIRTUAL_PM_ACTOR,
    note: VIRTUAL_PM_AUTO_REVIEW_NOTE,
  });

  let archived = false;
  const shouldArchive =
    opts?.autoArchive === true &&
    inferTaskLine(fm) === "branch" &&
    resolveArchiveAuthority(fm) === VIRTUAL_PM_ACTOR;
  if (shouldArchive) {
    const afterDone = await findTaskPathById(layout.lifecycleRoot, normalizedId);
    if (afterDone?.stage === "done") {
      await kernel.archiveTask({
        taskId: normalizedId,
        actor: VIRTUAL_PM_ACTOR,
        reason: VIRTUAL_PM_AUTO_ARCHIVE_REASON,
      });
      archived = true;
    }
  }

  await new LedgerBuilder({ projectRoot }).rebuild();

  return {
    task_id: normalizedId,
    review_check_ok: true,
    reviewed: true,
    archived,
  };
}

/** Backfill: approved branch tasks still sitting in `fcop/tasks/`. */
export async function reconcileVirtualPmBranchArchives(
  projectRoot: string,
): Promise<VirtualPmBranchSettleResult[]> {
  const layout = resolveLedgerLayout(projectRoot);
  const results: VirtualPmBranchSettleResult[] = [];
  let names: string[];
  try {
    names = await fs.readdir(layout.tasksDir);
  } catch {
    return results;
  }

  for (const name of names) {
    if (!/^TASK-/i.test(name) || !name.endsWith(".md")) continue;
    const path = join(layout.tasksDir, name);
    const store = new TaskFrontmatterStore();
    let fm: TaskFm;
    try {
      ({ fm } = await store.read(path));
    } catch {
      continue;
    }
    const reviewStatus = String(fm.review_status ?? "").trim().toLowerCase();
    if (reviewStatus !== "approved") continue;
    if (!isBranchPmArchivable(fm)) continue;

    const taskId = String(fm.task_id ?? name.replace(/\.md$/i, "")).replace(
      /\.md$/i,
      "",
    );
    try {
      const r = await settleVirtualPmBranchHotPathTask(projectRoot, taskId, {
        skipReviewCheck: true,
      });
      if (r) results.push(r);
    } catch {
      /* best-effort backfill */
    }
  }
  return results;
}
