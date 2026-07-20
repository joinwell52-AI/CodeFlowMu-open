/**
 * Hot-path (`fcop/tasks/`) review approve/reject without `_lifecycle/` mv.
 * Updates task frontmatter + writes REVIEW-*.md under `fcop/reviews/`.
 */

import { basename, join } from "node:path";
import { promises as fs } from "node:fs";

import { toLocalIsoString } from "../_internal/local-iso.ts";
import { ArchiveGuard } from "../lifecycle/ArchiveGuard.ts";
import { AuthorityGuard } from "../lifecycle/AuthorityGuard.ts";
import { TaskFrontmatterStore } from "../lifecycle/TaskFrontmatterStore.ts";
import { TransitionRecorder } from "../lifecycle/TransitionRecorder.ts";
import { findTaskLocationById, lifecycleRelPath } from "../lifecycle/taskPathUtils.ts";
import type {
  LifecycleStage,
  LifecycleTransitionResult,
  TaskFm,
} from "../lifecycle/types.ts";
import { LedgerBuilder } from "./LedgerBuilder.ts";
import { ReportResolver } from "./ReportResolver.ts";
import { resolveLedgerLayout } from "./paths.ts";

function normalizeTaskId(taskId: string): string {
  return taskId.replace(/\.md$/i, "").trim();
}

function taskMarkdown(
  fm: Record<string, unknown>,
  body = "# Review\n",
): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined || v === null) continue;
    lines.push(`${k}: ${v}`);
  }
  lines.push("---", body);
  return lines.join("\n") + "\n";
}

async function nextReviewSeq(reviewsDir: string, date: string): Promise<string> {
  let max = 0;
  try {
    const names = await fs.readdir(reviewsDir);
    const re = new RegExp(`^REVIEW-${date}-(\\d{3})`, "i");
    for (const name of names) {
      const m = re.exec(name);
      if (m) max = Math.max(max, parseInt(m[1]!, 10));
    }
  } catch {
    /* empty dir */
  }
  return String(max + 1).padStart(3, "0");
}

export interface HotPathReviewOpts {
  projectRoot: string;
  taskId: string;
  actor: string;
  note?: string;
  reason?: string;
  force?: boolean;
}

function resolveHotPathLogicalStage(fm: TaskFm): LifecycleStage {
  const projection = String(fm.lifecycle_projection ?? "")
    .trim()
    .toLowerCase();
  if (projection === "done" || fm.review_status === "approved") {
    return "done";
  }
  const state = String(fm.state ?? "")
    .trim()
    .toLowerCase();
  if (
    state === "inbox" ||
    state === "active" ||
    state === "review" ||
    state === "done" ||
    state === "archive"
  ) {
    return state;
  }
  return "active";
}

export async function locateHotPathTask(
  projectRoot: string,
  taskId: string,
): Promise<{ path: string; filename: string } | null> {
  const layout = resolveLedgerLayout(projectRoot);
  const located = await findTaskLocationById(layout.lifecycleRoot, taskId, {
    hotTasksDir: layout.tasksDir,
  });
  if (!located || located.storage !== "hot_path") return null;
  return { path: located.path, filename: located.filename };
}

export async function approveHotPathTaskReview(
  opts: HotPathReviewOpts,
): Promise<LifecycleTransitionResult> {
  const located = await locateHotPathTask(opts.projectRoot, opts.taskId);
  if (!located) {
    throw new Error(`hot_path task not found: ${opts.taskId}`);
  }

  const actor = (opts.actor || "PM").trim().toUpperCase();
  const store = new TaskFrontmatterStore();
  const { fm, body } = await store.read(located.path);
  const authority = new AuthorityGuard();
  authority.assert(fm, actor, "approve_review");
  const now = toLocalIsoString(new Date());
  const taskId = normalizeTaskId(String(fm.task_id ?? opts.taskId));

  fm.review_status = "approved";
  fm.lifecycle_projection = "done";
  fm.display_status = "done";
  fm.reviewed_at = now;
  fm.reviewed_by = actor;
  if (opts.note) fm.review_note = opts.note;

  await store.write(located.path, fm, body);

  const layout = resolveLedgerLayout(opts.projectRoot);
  await fs.mkdir(layout.reviewsDir, { recursive: true });
  const date = now.slice(0, 10).replace(/-/g, "");
  const seq = await nextReviewSeq(layout.reviewsDir, date);
  const reviewFilename = `REVIEW-${date}-${seq}-${actor}-on-${taskId}.md`;
  const reviewPath = join(layout.reviewsDir, reviewFilename);

  const reviewFm: Record<string, unknown> = {
    protocol: "fcop",
    version: 1,
    kind: "review",
    review_id: basename(reviewFilename, ".md"),
    subject_id: taskId,
    subject_type: "task",
    decision: "approved",
    reviewer: actor,
    reviewed_at: now,
    task_id: taskId,
    sender: actor,
    recipient: "PM",
  };
  if (opts.note) reviewFm.note = opts.note;

  await fs.writeFile(
    reviewPath,
    taskMarkdown(reviewFm, `# PM review · ${taskId}\n\n${opts.note ?? "approved"}\n`),
    "utf-8",
  );

  const builder = new LedgerBuilder({ projectRoot: opts.projectRoot });
  await builder.rebuild();

  const resolver = new ReportResolver({
    projectRoot: opts.projectRoot,
    lifecycleRoot: layout.lifecycleRoot,
  });
  await resolver.reconcileThreadSettlement(taskId);

  return {
    ok: true,
    task_id: taskId,
    from: "active",
    to: "done",
    path: located.path,
  };
}

export async function rejectHotPathTaskReview(
  opts: HotPathReviewOpts,
): Promise<LifecycleTransitionResult> {
  const located = await locateHotPathTask(opts.projectRoot, opts.taskId);
  if (!located) {
    throw new Error(`hot_path task not found: ${opts.taskId}`);
  }

  const actor = (opts.actor || "PM").trim().toUpperCase();
  const reason = opts.reason ?? opts.note ?? "rejected";
  const store = new TaskFrontmatterStore();
  const { fm, body } = await store.read(located.path);
  const now = toLocalIsoString(new Date());
  const taskId = normalizeTaskId(String(fm.task_id ?? opts.taskId));

  fm.review_status = "rejected";
  fm.lifecycle_projection = "active";
  fm.display_status = "waiting_rework";
  fm.reviewed_at = now;
  fm.reviewed_by = actor;
  fm.review_note = reason;

  await store.write(located.path, fm, body);

  const layout = resolveLedgerLayout(opts.projectRoot);
  await fs.mkdir(layout.reviewsDir, { recursive: true });
  const date = now.slice(0, 10).replace(/-/g, "");
  const seq = await nextReviewSeq(layout.reviewsDir, date);
  const reviewFilename = `REVIEW-${date}-${seq}-${actor}-on-${taskId}.md`;
  const reviewPath = join(layout.reviewsDir, reviewFilename);

  const reviewFm: Record<string, unknown> = {
    protocol: "fcop",
    version: 1,
    kind: "review",
    review_id: basename(reviewFilename, ".md"),
    subject_id: taskId,
    subject_type: "task",
    decision: "rejected",
    reviewer: actor,
    reviewed_at: now,
    task_id: taskId,
    sender: actor,
    recipient: String(fm.driver ?? fm.to ?? "PM"),
    reason,
  };

  await fs.writeFile(
    reviewPath,
    taskMarkdown(reviewFm, `# PM review · ${taskId}\n\n${reason}\n`),
    "utf-8",
  );

  const builder = new LedgerBuilder({ projectRoot: opts.projectRoot });
  await builder.rebuild();

  return {
    ok: true,
    task_id: taskId,
    from: "review",
    to: "active",
    path: located.path,
  };
}

/**
 * J5 hot-path archive: approved TASK in `fcop/tasks/` → `_lifecycle/archive/` + frozen.
 * Shell bridge runs J1 (`reconcileLedgerAfterJoin`) after success — do not rebuild here.
 */
export async function archiveHotPathTask(
  opts: HotPathReviewOpts,
): Promise<LifecycleTransitionResult> {
  const located = await locateHotPathTask(opts.projectRoot, opts.taskId);
  if (!located) {
    throw new Error(`hot_path task not found: ${opts.taskId}`);
  }

  const actor = (opts.actor || "PM").trim().toUpperCase();
  const reason = (opts.reason ?? opts.note ?? "Hot-path archive_task").trim();
  if (!reason) {
    throw new Error("archive_task denied: archive_reason is required");
  }

  const store = new TaskFrontmatterStore();
  const authority = new AuthorityGuard();
  const archiveGuard = new ArchiveGuard();
  const { fm } = await store.read(located.path);
  const taskId = normalizeTaskId(String(fm.task_id ?? opts.taskId));
  const logicalStage = resolveHotPathLogicalStage(fm);
  const force = Boolean(opts.force);

  archiveGuard.assertNotFrozen(fm);
  authority.assert(fm, actor, "archive_task");

  if (force) {
    archiveGuard.assertCanForceArchive(fm, reason, logicalStage);
  } else {
    const reviewStatus = String(fm.review_status ?? "").trim().toLowerCase();
    const projection = String(fm.lifecycle_projection ?? "")
      .trim()
      .toLowerCase();
    if (reviewStatus !== "approved" && projection !== "done") {
      throw new Error(
        `archive_task denied: review_status must be approved or lifecycle_projection done (got review_status=${reviewStatus || "missing"}, lifecycle_projection=${projection || "missing"})`,
      );
    }
  }

  const transitionFrom: LifecycleStage = force ? logicalStage : "done";

  const recorder = new TransitionRecorder(store);
  await recorder.append(
    located.path,
    {
      from: transitionFrom,
      to: "archive",
      by: actor,
      action: force ? "force_archive_task" : "archive_task",
      decision: "archived",
      reason,
    },
    { allowFrozenWrite: true },
  );

  const now = toLocalIsoString(new Date());
  await store.patch(
    located.path,
    {
      frozen: true,
      archived_by: actor,
      archived_at: now,
      archive_reason: reason,
      lifecycle_projection: "archive",
      display_status: "archived",
      ...(force ? { archive_mode: "force", task_type: "force_archive" } : {}),
    },
    { allowFrozenWrite: true },
  );

  const layout = resolveLedgerLayout(opts.projectRoot);
  const archiveDir = join(layout.lifecycleRoot, "archive");
  await fs.mkdir(archiveDir, { recursive: true });
  const destPath = join(archiveDir, located.filename);
  if (located.path !== destPath) {
    await fs.rename(located.path, destPath);
  }

  return {
    ok: true,
    task_id: taskId,
    from: transitionFrom,
    to: "archive",
    path: lifecycleRelPath("archive", located.filename),
  };
}
