import type { TaskFm } from "./types.ts";

export const CLOSED_PARENT_RESIDUE_DISPLAY = "closed_parent_residue";

const OPEN_BUCKETS = new Set(["inbox", "active", "review"]);

export function isAdminMainlineTaskFilename(filename: string): boolean {
  return /-ADMIN-to-PM/i.test(filename || "");
}

export function hasExplicitParentInFm(
  fm: Record<string, unknown> | TaskFm,
): boolean {
  return !!String(fm.parent ?? fm.parent_task_id ?? "").trim();
}

/** ADMIN→PM root mainline (no explicit parent) — not an ADMIN→PM child subtask. */
export function isAdminMainlineRootTask(
  filename: string,
  fm?: Record<string, unknown> | TaskFm,
): boolean {
  if (!isAdminMainlineTaskFilename(filename)) return false;
  if (fm && hasExplicitParentInFm(fm)) return false;
  return true;
}

export function isArchivedByParentMainline(
  fm: Record<string, unknown> | TaskFm,
): boolean {
  return fm.archived_by_parent_mainline === true;
}

export function isClosedParentResidueMarked(
  fm: Record<string, unknown> | TaskFm,
): boolean {
  if (fm.terminated_by_parent_archive === true) return true;
  if (fm.closed_parent_residue === true) return true;
  const ds = String(fm.display_status ?? "").trim().toLowerCase();
  return ds === CLOSED_PARENT_RESIDUE_DISPLAY;
}

export function isOpenLifecycleBucket(bucket: string): boolean {
  return OPEN_BUCKETS.has(String(bucket ?? "").trim().toLowerCase());
}

export function isOpenLifecycleProjection(projection: string | undefined): boolean {
  const p = String(projection ?? "").trim().toLowerCase();
  return OPEN_BUCKETS.has(p);
}

export function isStateBucketMismatch(
  bucket: string,
  fm: Record<string, unknown> | TaskFm,
): boolean {
  const b = String(bucket ?? "").trim().toLowerCase();
  const state = String(fm.state ?? "").trim().toLowerCase();
  return b === "inbox" && state === "dispatched";
}

export function isParentTaskClosed(
  parentFm: Record<string, unknown> | TaskFm,
  parentBucket: string,
): boolean {
  const bucket = String(parentBucket ?? "").trim().toLowerCase();
  if (bucket === "archive" || bucket === "done") return true;
  if (parentFm.frozen === true) return true;
  const proj = String(parentFm.lifecycle_projection ?? "")
    .trim()
    .toLowerCase();
  if (proj === "archive" || proj === "done") return true;
  const ds = String(parentFm.display_status ?? "").trim().toLowerCase();
  if (ds === "archived") return true;
  return false;
}

export function isTaskOpenForArchiveGate(
  bucket: string,
  fm: Record<string, unknown> | TaskFm,
): boolean {
  if (isClosedParentResidueMarked(fm)) return false;
  const physical = String(bucket ?? "").trim().toLowerCase();
  // 物理落盘位置是事实源；done/archive 不能被陈旧 projection 重新判为 open。
  if (physical === "done" || physical === "archive") return false;
  if (isOpenLifecycleBucket(physical)) return true;
  const proj = String(fm.lifecycle_projection ?? "").trim().toLowerCase();
  return isOpenLifecycleProjection(proj);
}

export function isForceArchivedWithoutResidueMark(
  fm: Record<string, unknown> | TaskFm,
  bucket: string,
): boolean {
  if (isClosedParentResidueMarked(fm)) return false;
  const b = String(bucket ?? "").trim().toLowerCase();
  if (b !== "archive") return false;
  const archiveMode = String(fm.archive_mode ?? "").trim().toLowerCase();
  const taskType = String(fm.task_type ?? "").trim().toLowerCase();
  return archiveMode === "force" || taskType === "force_archive";
}

/** Historical or marked residue — exclude from worker todo / dispatch. */
export function isClosedParentResidueTask(
  fm: Record<string, unknown> | TaskFm,
  bucket: string,
  parentClosed?: boolean,
): boolean {
  if (isClosedParentResidueMarked(fm)) return true;
  if (!parentClosed) return false;
  if (isOpenLifecycleBucket(bucket)) return true;
  if (isForceArchivedWithoutResidueMark(fm, bucket)) return true;
  const proj = String(fm.lifecycle_projection ?? "").trim().toLowerCase();
  return parentClosed && isOpenLifecycleProjection(proj);
}
