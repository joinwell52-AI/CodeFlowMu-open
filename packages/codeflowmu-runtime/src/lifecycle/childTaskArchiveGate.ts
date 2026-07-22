import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";

import { reviewCheck } from "../pm/PmGovernanceActions.ts";
import { TaskFrontmatterStore } from "./TaskFrontmatterStore.ts";
import { TransitionRecorder } from "./TransitionRecorder.ts";
import {
  isAdminMainlineRootTask,
  isArchivedByParentMainline,
  isClosedParentResidueMarked,
  isOpenLifecycleBucket,
  isTaskOpenForArchiveGate,
  CLOSED_PARENT_RESIDUE_DISPLAY,
} from "./closedParentResidue.ts";
import {
  findTaskPathById,
  stageFromPath,
  type LifecycleStage,
} from "./taskPathUtils.ts";
import type { TaskFm } from "./types.ts";

const SCAN_STAGES: readonly LifecycleStage[] = [
  "inbox",
  "active",
  "review",
  "done",
  "archive",
];

const DONE_BLOCKING_DISPLAY = new Set([
  "blocked",
  "failed",
  "waiting_rework",
  "waiting_pm_rework",
]);

export type OpenChildTaskRef = {
  task_id: string;
  filename: string;
  bucket: string;
  display_status?: string;
  reason?: string;
};

export class ChildTasksOpenError extends Error {
  readonly code = "CHILD_TASKS_OPEN" as const;
  readonly openChildren: OpenChildTaskRef[];
  readonly children: OpenChildTaskRef[];

  constructor(openChildren: OpenChildTaskRef[]) {
    const ids = openChildren.map((child) => child.task_id).join(", ");
    super(
      `CHILD_TASKS_OPEN: ${openChildren.length} child task(s) still open${ids ? `: ${ids}` : ""}`,
    );
    this.name = "ChildTasksOpenError";
    this.openChildren = openChildren;
    this.children = openChildren;
  }
}

export type NotAcceptedChildRef = OpenChildTaskRef & {
  reasons: string[];
};

export class ChildTasksNotAcceptedError extends Error {
  readonly code = "CHILD_TASKS_NOT_ACCEPTED" as const;
  readonly notAcceptedChildren: NotAcceptedChildRef[];

  constructor(notAcceptedChildren: NotAcceptedChildRef[]) {
    super(
      `CHILD_TASKS_NOT_ACCEPTED: ${notAcceptedChildren.length} child task(s) done but not accepted`,
    );
    this.name = "ChildTasksNotAcceptedError";
    this.notAcceptedChildren = notAcceptedChildren;
  }
}

function normalizeTaskId(raw: string): string {
  const s = String(raw ?? "").replace(/\.md$/i, "").trim();
  const m = /^TASK-\d{8}-\d{3,}/i.exec(s);
  return m ? m[0].toUpperCase() : s.toUpperCase();
}

function parentMatchesMain(
  fm: Record<string, unknown>,
  mainTaskId: string,
  _mainFilename: string,
): boolean {
  const mainId = normalizeTaskId(mainTaskId);
  const parentRaw = String(fm.parent ?? fm.parent_task_id ?? "").trim();
  if (parentRaw) {
    const pid = normalizeTaskId(parentRaw);
    if (pid === mainId) return true;
  }
  return false;
}

function taskDescendsFromMain(
  task: ScannedChild,
  byId: Map<string, ScannedChild>,
  mainTaskId: string,
): boolean {
  const mainId = normalizeTaskId(mainTaskId);
  let parentId = normalizeTaskId(
    String(task.fm.parent ?? task.fm.parent_task_id ?? ""),
  );
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    if (parentId === mainId) return true;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) return false;
    parentId = normalizeTaskId(
      String(parent.fm.parent ?? parent.fm.parent_task_id ?? ""),
    );
  }
  return false;
}

function openReason(task: ScannedChild): string {
  if (isOpenLifecycleBucket(task.bucket)) {
    return `physical_bucket=${task.bucket}`;
  }
  const projection = String(task.fm.lifecycle_projection ?? "").trim();
  return projection
    ? `lifecycle_projection=${projection}`
    : "lifecycle_state_open";
}

function doneDisplayBlocksArchive(fm: TaskFm): string | null {
  const ds = String(fm.display_status ?? "").trim().toLowerCase();
  if (DONE_BLOCKING_DISPLAY.has(ds)) return `display_status=${ds}`;
  return null;
}

async function evaluateDoneChildAcceptance(
  projectRoot: string,
  taskId: string,
  fm: TaskFm,
): Promise<{ accepted: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  const displayBlock = doneDisplayBlocksArchive(fm);
  if (displayBlock) reasons.push(displayBlock);

  const rs = String(fm.review_status ?? "").trim().toLowerCase();
  if (rs && rs !== "approved") {
    reasons.push(`review_status=${rs}`);
  }

  const check = await reviewCheck(projectRoot, { task_id: taskId });
  if (!check) {
    reasons.push("review_check_unavailable");
    return { accepted: false, reasons: [...new Set(reasons)] };
  }
  if (!check.ok) {
    for (const f of check.findings) {
      if (f.severity === "error") reasons.push(f.message);
    }
    if (!check.findings.some((f) => f.severity === "error")) {
      reasons.push("pm.review_check failed");
    }
    return { accepted: false, reasons: [...new Set(reasons)] };
  }

  const reportStatus = String(check.report?.status ?? "").trim().toLowerCase();
  if (reportStatus && !["done", "completed"].includes(reportStatus)) {
    reasons.push(`report status=${reportStatus}`);
    return { accepted: false, reasons: [...new Set(reasons)] };
  }

  if (displayBlock) {
    return { accepted: false, reasons: [...new Set(reasons)] };
  }

  return { accepted: true, reasons: [] };
}

type ScannedChild = {
  task_id: string;
  filename: string;
  path: string;
  bucket: string;
  fm: TaskFm;
};

async function scanLifecycleTasks(
  lifecycleRoot: string,
): Promise<ScannedChild[]> {
  const store = new TaskFrontmatterStore();
  const out: ScannedChild[] = [];
  const seen = new Set<string>();

  for (const stage of SCAN_STAGES) {
    const dir = join(lifecycleRoot, stage);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^TASK-/.test(name) || !name.endsWith(".md")) continue;
      const path = join(dir, name);
      const dedupe = `${name}:${stage}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      try {
        const { fm } = await store.read(path);
        const task_id = normalizeTaskId(
          String(fm.task_id ?? name.replace(/\.md$/i, "")),
        );
        out.push({
          task_id,
          filename: name,
          path,
          bucket: stage,
          fm,
        });
      } catch {
        /* skip unreadable */
      }
    }
  }
  return out;
}

export async function collectRelatedChildTasks(
  opts: {
    lifecycleRoot: string;
    projectRoot: string;
    mainTaskId: string;
    mainFilename: string;
    mainThreadKey?: string;
    openOnly?: boolean;
  },
): Promise<OpenChildTaskRef[]> {
  const mainId = normalizeTaskId(opts.mainTaskId);
  const scanned = await scanLifecycleTasks(opts.lifecycleRoot);
  const byId = new Map(scanned.map((task) => [task.task_id, task] as const));
  const openChildren: OpenChildTaskRef[] = [];
  const seenIds = new Set<string>();

  for (const t of scanned) {
    if (t.task_id === mainId) continue;
    if (isAdminMainlineRootTask(t.filename, t.fm as Record<string, unknown>))
      continue;

    const parentMatch =
      parentMatchesMain(
        t.fm as Record<string, unknown>,
        mainId,
        opts.mainFilename,
      ) || taskDescendsFromMain(t, byId, mainId);
    if (!parentMatch) continue;

    const isOpen = isTaskOpenForArchiveGate(t.bucket, t.fm);
    if (opts.openOnly !== false && !isOpen) continue;

    if (seenIds.has(t.task_id)) continue;
    seenIds.add(t.task_id);
    openChildren.push({
      task_id: t.task_id,
      filename: t.filename,
      bucket: t.bucket,
      display_status: String(t.fm.display_status ?? "").trim() || undefined,
      reason: openReason(t),
    });
  }

  return openChildren;
}

export async function assertNoOpenChildTasksForMainline(
  opts: {
    lifecycleRoot: string;
    projectRoot: string;
    mainTaskId: string;
    mainFilename: string;
    mainThreadKey?: string;
  },
): Promise<void> {
  await assertMainlineArchiveChildrenReady(opts);
}

export async function classifyRelatedChildTasksForMainlineArchive(
  opts: {
    lifecycleRoot: string;
    projectRoot: string;
    mainTaskId: string;
    mainFilename: string;
    mainThreadKey?: string;
  },
): Promise<{
  blockingOpen: OpenChildTaskRef[];
  blockingNotAccepted: NotAcceptedChildRef[];
  autoArchive: OpenChildTaskRef[];
}> {
  const mainId = normalizeTaskId(opts.mainTaskId);
  const scanned = await scanLifecycleTasks(opts.lifecycleRoot);
  const byId = new Map(scanned.map((task) => [task.task_id, task] as const));
  const blockingOpen: OpenChildTaskRef[] = [];
  const blockingNotAccepted: NotAcceptedChildRef[] = [];
  const autoArchive: OpenChildTaskRef[] = [];
  const seenIds = new Set<string>();

  for (const t of scanned) {
    if (t.task_id === mainId) continue;
    if (isAdminMainlineRootTask(t.filename, t.fm as Record<string, unknown>))
      continue;

    const parentMatch =
      parentMatchesMain(
        t.fm as Record<string, unknown>,
        mainId,
        opts.mainFilename,
      ) || taskDescendsFromMain(t, byId, mainId);
    if (!parentMatch) continue;

    if (seenIds.has(t.task_id)) continue;
    seenIds.add(t.task_id);

    const ref: OpenChildTaskRef = {
      task_id: t.task_id,
      filename: t.filename,
      bucket: t.bucket,
      display_status: String(t.fm.display_status ?? "").trim() || undefined,
      reason: openReason(t),
    };

    if (isClosedParentResidueMarked(t.fm)) continue;
    if (t.bucket === "archive") {
      if (isArchivedByParentMainline(t.fm)) continue;
      continue;
    }

    if (isOpenLifecycleBucket(t.bucket) || isTaskOpenForArchiveGate(t.bucket, t.fm)) {
      blockingOpen.push(ref);
      continue;
    }

    // A child task in done/ is already out of the parent closeout critical path.
    // Review warnings on it are quality signals, not archive blockers for the
    // parent. Each child should be archived explicitly by its own owner.
    if (t.bucket === "done") continue;
  }

  return { blockingOpen, blockingNotAccepted, autoArchive };
}

/** Validates child tasks before ADMIN mainline normal archive; returns auto-archive list. */
export async function assertMainlineArchiveChildrenReady(
  opts: {
    lifecycleRoot: string;
    projectRoot: string;
    mainTaskId: string;
    mainFilename: string;
    mainThreadKey?: string;
  },
): Promise<OpenChildTaskRef[]> {
  const classified = await classifyRelatedChildTasksForMainlineArchive(opts);
  if (classified.blockingOpen.length > 0) {
    throw new ChildTasksOpenError(classified.blockingOpen);
  }
  if (classified.blockingNotAccepted.length > 0) {
    throw new ChildTasksNotAcceptedError(classified.blockingNotAccepted);
  }
  return classified.autoArchive;
}

export async function autoArchiveAcceptedChildrenByParentMainline(opts: {
  lifecycleRoot: string;
  projectRoot: string;
  children: OpenChildTaskRef[];
  actor: string;
  reason: string;
  parentTaskId: string;
}): Promise<OpenChildTaskRef[]> {
  if (!opts.children.length) return [];

  const store = new TaskFrontmatterStore();
  const recorder = new TransitionRecorder(store);
  const now = new Date().toISOString();
  const archived: OpenChildTaskRef[] = [];

  for (const child of opts.children) {
    const located = await findTaskPathById(opts.lifecycleRoot, child.task_id);
    if (!located || located.stage === "archive") continue;

    let taskPath = located.path;
    let bucket: LifecycleStage = located.stage as LifecycleStage;
    const filename = basename(taskPath);

    if (bucket !== "archive") {
      const dest = join(opts.lifecycleRoot, "archive", filename);
      await fs.mkdir(dirname(dest), { recursive: true });
      await recorder.append(
        taskPath,
        {
          from: bucket,
          to: "archive",
          by: opts.actor,
          action: "archive_by_parent_mainline",
          decision: "archived",
          reason: opts.reason,
          parent: opts.parentTaskId,
        },
        { allowFrozenWrite: true },
      );
      await fs.rename(taskPath, dest);
      taskPath = dest;
      bucket = "archive";
    }

    await store.patch(
      taskPath,
      {
        frozen: true,
        archived_by_parent_mainline: true,
        archived_by: opts.actor,
        archived_at: now,
        archive_reason: opts.reason,
        lifecycle_projection: "archive",
        state: "archive",
        display_status: "archived",
      },
      { allowFrozenWrite: true },
    );

    archived.push({
      task_id: child.task_id,
      filename,
      bucket: "archive",
      display_status: "archived",
    });
  }

  return archived;
}

export async function terminateOpenChildTasksByParentArchive(opts: {
  lifecycleRoot: string;
  projectRoot: string;
  mainTaskId: string;
  mainFilename: string;
  mainThreadKey?: string;
  actor: string;
  reason: string;
}): Promise<OpenChildTaskRef[]> {
  const open = await collectRelatedChildTasks({
    lifecycleRoot: opts.lifecycleRoot,
    projectRoot: opts.projectRoot,
    mainTaskId: opts.mainTaskId,
    mainFilename: opts.mainFilename,
    mainThreadKey: opts.mainThreadKey,
    openOnly: true,
  });
  if (!open.length) return [];

  const store = new TaskFrontmatterStore();
  const recorder = new TransitionRecorder(store);
  const now = new Date().toISOString();

  for (const child of open) {
    const located = await findTaskPathById(
      opts.lifecycleRoot,
      child.task_id,
    );
    if (!located) continue;

    let taskPath = located.path;
    let bucket = located.stage;

    if (bucket !== "archive") {
      const filename = basename(taskPath);
      const dest = join(opts.lifecycleRoot, "archive", filename);
      await fs.mkdir(dirname(dest), { recursive: true });
      await recorder.append(
        taskPath,
        {
          from: bucket,
          to: "archive",
          by: opts.actor,
          action: "terminate_by_parent_archive",
          decision: "terminated",
          reason: opts.reason,
        },
        { allowFrozenWrite: true },
      );
      await fs.rename(taskPath, dest);
      taskPath = dest;
      bucket = "archive";
    } else {
      await recorder.append(
        taskPath,
        {
          from: bucket,
          to: "archive",
          by: opts.actor,
          action: "terminate_by_parent_archive",
          decision: "terminated",
          reason: opts.reason,
        },
        { allowFrozenWrite: true },
      );
    }

    await store.patch(
      taskPath,
      {
        frozen: true,
        terminated_by_parent_archive: true,
        closed_parent_residue: true,
        display_status: CLOSED_PARENT_RESIDUE_DISPLAY,
        lifecycle_projection: "archive",
        state: "archive",
        archived_by: opts.actor,
        archived_at: now,
        archive_reason: opts.reason,
      },
      { allowFrozenWrite: true },
    );
  }

  return open;
}

export async function terminateSingleChildAsParentResidue(opts: {
  lifecycleRoot: string;
  taskId: string;
  actor: string;
  reason: string;
}): Promise<OpenChildTaskRef | null> {
  const located = await findTaskPathById(opts.lifecycleRoot, opts.taskId);
  if (!located) return null;

  const store = new TaskFrontmatterStore();
  const recorder = new TransitionRecorder(store);
  const now = new Date().toISOString();
  let taskPath = located.path;
  let bucket = located.stage;
  const filename = basename(taskPath);

  if (bucket !== "archive") {
    const dest = join(opts.lifecycleRoot, "archive", filename);
    await fs.mkdir(dirname(dest), { recursive: true });
    await recorder.append(
      taskPath,
      {
        from: bucket,
        to: "archive",
        by: opts.actor,
        action: "terminate_by_parent_archive",
        decision: "terminated",
        reason: opts.reason,
      },
      { allowFrozenWrite: true },
    );
    await fs.rename(taskPath, dest);
    taskPath = dest;
    bucket = "archive";
  } else {
    await recorder.append(
      taskPath,
      {
        from: bucket,
        to: "archive",
        by: opts.actor,
        action: "terminate_by_parent_archive",
        decision: "terminated",
        reason: opts.reason,
      },
      { allowFrozenWrite: true },
    );
  }

  await store.patch(
    taskPath,
    {
      frozen: true,
      terminated_by_parent_archive: true,
      closed_parent_residue: true,
      display_status: CLOSED_PARENT_RESIDUE_DISPLAY,
      lifecycle_projection: "archive",
      state: "archive",
      archived_by: opts.actor,
      archived_at: now,
      archive_reason: opts.reason,
    },
    { allowFrozenWrite: true },
  );

  const { fm } = await store.read(taskPath);
  return {
    task_id: normalizeTaskId(String(fm.task_id ?? opts.taskId)),
    filename,
    bucket: "archive",
    display_status: CLOSED_PARENT_RESIDUE_DISPLAY,
  };
}

export function projectRootFromLifecycleRoot(lifecycleRoot: string): string {
  const norm = lifecycleRoot.replace(/\\/g, "/").replace(/\/$/, "");
  const idx = norm.lastIndexOf("/fcop/_lifecycle");
  if (idx >= 0) return norm.slice(0, idx);
  return dirname(dirname(norm));
}
