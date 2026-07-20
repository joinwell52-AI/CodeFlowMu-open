/**
 * Team dynamics SoT — _lifecycle physical bucket wins over ledger projection.
 */

import { resolveTaskCurrentBucket, type TaskBucketInput } from "./taskCurrentBucket.ts";

export type TeamDynamicsTask = TaskBucketInput & {
  filename?: string;
  task_id?: string;
  display_status?: string;
  recipient?: string;
  sender?: string;
};

const OPEN_BUCKETS = new Set(["inbox", "active", "review"]);
const PM_BRANCH_RE = /-PM-to-(DEV|OPS|QA)/i;
const ADMIN_MAINLINE_RE = /-ADMIN-to-PM/i;
const PM_TO_ADMIN_RE = /-PM-to-ADMIN/i;

export function isAdminMainlineTask(filename: string): boolean {
  return ADMIN_MAINLINE_RE.test(filename || "");
}

export function isPmBranchTask(filename: string): boolean {
  return PM_BRANCH_RE.test(filename || "");
}

export function taskIdFromFilename(fn: string): string {
  const m = String(fn || "").match(/^(TASK-\d{8}-\d{3,})/i);
  return m?.[1] ?? "";
}

export function findAdminRoot(members: TeamDynamicsTask[]): TeamDynamicsTask | null {
  return (
    members.find((m) => isAdminMainlineTask(String(m.filename ?? ""))) ??
    members[0] ??
    null
  );
}

/** Current open task on disk (inbox|active|review). */
export function hasOpenCurrentBucketTask(members: TeamDynamicsTask[]): boolean {
  return (members ?? []).some((m) => {
    if (!String(m.filename ?? "").startsWith("TASK-")) return false;
    return OPEN_BUCKETS.has(resolveTaskCurrentBucket(m));
  });
}

export function allPmBranchTasksSettled(members: TeamDynamicsTask[]): boolean {
  const branches = (members ?? []).filter((m) =>
    isPmBranchTask(String(m.filename ?? "")),
  );
  if (!branches.length) return true;
  return branches.every((m) => {
    const b = resolveTaskCurrentBucket(m);
    return b === "done" || b === "archive";
  });
}

export function isAdminAwaitingReviewScenario(
  members: TeamDynamicsTask[],
): boolean {
  const root = findAdminRoot(members);
  if (!root) return false;
  const rootBucket = resolveTaskCurrentBucket(root);
  const branches = (members ?? []).filter((m) =>
    isPmBranchTask(String(m.filename ?? "")),
  );
  if (!branches.length) return false;
  return rootBucket === "review" && allPmBranchTasksSettled(members);
}

export interface ShouldShowThreadOpts {
  /** PM-to-ADMIN final summary exists for this root. */
  hasPmFinalReport?: boolean;
}

/**
 * Thread Bus visibility — physical bucket SoT; ledger receipt cache must not alone qualify.
 */
export function shouldShowThreadOnTeamDynamics(
  members: TeamDynamicsTask[],
  opts?: ShouldShowThreadOpts,
): boolean {
  if (!members?.length) return false;
  const root = findAdminRoot(members);
  if (!root) return false;

  const rootBucket = resolveTaskCurrentBucket(root);
  if (rootBucket === "archive") return false;

  if (!hasOpenCurrentBucketTask(members)) return false;

  if (isAdminAwaitingReviewScenario(members)) {
    return false;
  }

  if (opts?.hasPmFinalReport && rootBucket === "review") {
    return false;
  }

  return true;
}

export type LifecycleCountKey =
  | "inbox"
  | "active"
  | "review"
  | "done"
  | "archive";

export function aggregateLifecycleCountsFromPhysical(
  tasks: TeamDynamicsTask[],
): Record<LifecycleCountKey, number> {
  const counts: Record<LifecycleCountKey, number> = {
    inbox: 0,
    active: 0,
    review: 0,
    done: 0,
    archive: 0,
  };
  for (const t of tasks ?? []) {
    if (!String(t.filename ?? "").startsWith("TASK-")) continue;
    const bucket = resolveTaskCurrentBucket(t);
    if (bucket in counts) {
      counts[bucket as LifecycleCountKey] += 1;
    }
  }
  return counts;
}

export interface ExecutingEvidence {
  task_id: string;
  bucket: string;
  role: string;
}

/** 「执行中」须能列出 task_id + bucket + role；无当前 open task 则空。 */
export function listExecutingEvidence(
  members: TeamDynamicsTask[],
): ExecutingEvidence[] {
  const out: ExecutingEvidence[] = [];
  for (const m of members ?? []) {
    const fn = String(m.filename ?? "");
    if (!fn.startsWith("TASK-")) continue;
    const bucket = resolveTaskCurrentBucket(m);
    if (bucket !== "active" && bucket !== "review") continue;
    const taskId = taskIdFromFilename(fn) || String(m.task_id ?? "").trim();
    if (!taskId) continue;
    const route = fn.match(/-to-([A-Z0-9]+)/i);
    const role = String(m.recipient ?? route?.[1] ?? "").trim().toUpperCase();
    out.push({ task_id: taskId, bucket, role: role || "?" });
  }
  return out;
}

export function hasPmFinalReportForRoot(
  rootId: string,
  reports: { filename?: string; status?: string; task_id?: string }[],
): boolean {
  const norm = rootId.replace(/\.md$/i, "").trim();
  if (!norm) return false;
  return (reports ?? []).some((r) => {
    const fn = String(r.filename ?? "");
    if (!PM_TO_ADMIN_RE.test(fn)) return false;
    const st = String(r.status ?? "").toLowerCase();
    if (st !== "done" && st !== "completed" && st !== "pass") return false;
    const tid = String(r.task_id ?? "").replace(/\.md$/i, "");
    return (
      tid === norm ||
      fn.includes(norm) ||
      norm.includes(taskIdFromFilename(fn))
    );
  });
}

/** PM 待办：仅当前需 PM 处理的 ADMIN→PM inbox|active；不含 root review（ADMIN 验收）。 */
export function collectPmOpenMainlineTasks(
  tasks: TeamDynamicsTask[],
  reports: { filename?: string; status?: string; task_id?: string }[] = [],
): TeamDynamicsTask[] {
  return (tasks ?? []).filter((t) => {
    const fn = String(t.filename ?? "");
    if (!fn.startsWith("TASK-") || !isAdminMainlineTask(fn)) return false;
    const bucket = resolveTaskCurrentBucket(t);
    if (bucket === "review" || bucket === "done" || bucket === "archive") {
      return false;
    }
    if (!OPEN_BUCKETS.has(bucket)) return false;
    const rootId = taskIdFromFilename(fn);
    if (rootId && hasPmFinalReportForRoot(rootId, reports)) return false;
    return true;
  });
}
