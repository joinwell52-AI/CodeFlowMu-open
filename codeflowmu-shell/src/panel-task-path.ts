/** Panel task detail: resolve fcop-relative paths (disk truth over stale ledger inbox). */

const LIFECYCLE_STAGE_RE =
  /[/\\]_lifecycle[/\\](inbox|active|review|done|archive)(?:[/\\]|$)/i;

export function fcopPathToRel(raw: string): string {
  const rawPath = String(raw ?? "").replace(/\\/g, "/");
  if (!rawPath) return "";
  const low = rawPath.toLowerCase();
  const i = low.indexOf("/fcop/");
  if (i >= 0) return rawPath.slice(i + 1);
  if (low.startsWith("fcop/")) return rawPath;
  return "";
}

export function stageFromRelPath(rel: string): string {
  const m = String(rel).match(/fcop\/_lifecycle\/(inbox|active|review|done|archive)\//i);
  return m?.[1]?.toLowerCase() ?? "";
}

export type TaskPathInput = {
  filename?: string;
  path?: string;
  absolute_path?: string;
  local_path?: string;
  physical_scope?: string;
  scope?: string;
  bucket?: string;
};

/** Disk stage from physical_scope or path (not ledger bucket alone). */
export function physicalScopeFromTaskInput(f: TaskPathInput): string {
  const ps = String(f.physical_scope ?? "").toLowerCase().trim();
  if (ps) return ps;
  const fromPath = String(f.path ?? "").match(LIFECYCLE_STAGE_RE)?.[1];
  if (fromPath) return String(fromPath).toLowerCase();
  return "";
}

function pathMatchesPhysical(rel: string, physical: string): boolean {
  if (!rel) return false;
  if (!physical) return true;
  const stage = stageFromRelPath(rel);
  if (!stage) return true;
  return stage === physical;
}

/**
 * Relative path under project root for /api/v2/files/read.
 * Never defaults to inbox when physical_scope disagrees with ledger path.
 */
export function resolveTaskRelPath(f: TaskPathInput): string {
  const fn = String(f.filename ?? "").trim();
  if (!fn) return "fcop/tasks/";

  const physical = physicalScopeFromTaskInput(f);

  for (const raw of [f.absolute_path, f.local_path]) {
    const rel = fcopPathToRel(String(raw ?? ""));
    if (rel && pathMatchesPhysical(rel, physical)) return rel;
  }

  const pathRel = fcopPathToRel(String(f.path ?? ""));
  if (pathRel && pathMatchesPhysical(pathRel, physical)) return pathRel;

  if (physical) return `fcop/_lifecycle/${physical}/${fn}`;

  if (pathRel) return pathRel;

  return `fcop/tasks/${fn}`;
}
