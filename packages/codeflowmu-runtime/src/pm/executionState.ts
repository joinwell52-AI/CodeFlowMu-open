/**
 * Internal runtime execution_state — active ≠ runnable.
 * Not written to FCoP; derived from DEV report, artifact, cancel, supersede.
 */

import { existsSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import {
  filterThreadTasks,
  type ExecutionGateContext,
  type ExecutionTaskMeta,
} from "./taskDispatchContext.ts";
import {
  isUpstreamWorkerSettled,
  normalizeWorkerRole,
  type DispatchGateReportRef,
  type DispatchGateTaskRef,
} from "./taskDispatchGate.ts";

export type ExecutionState =
  | "runnable"
  | "completed"
  | "blocked"
  | "waiting_dependency"
  | "superseded";

export function isTaskCompleted(task: DispatchGateTaskRef): boolean {
  const bucket = String(task.lifecycleBucket ?? "").trim().toLowerCase();
  const state = String(task.fmState ?? "").trim().toLowerCase();
  const display = String(task.displayStatus ?? "").trim().toLowerCase();
  return (
    bucket === "done" ||
    bucket === "archive" ||
    state === "done" ||
    state === "archive" ||
    display === "done" ||
    display === "archived"
  );
}

export function normalizeTaskIdPrefix(id: string): string {
  const raw = String(id ?? "").trim();
  if (!raw) return "";
  const token = raw.replace(/\.md$/i, "");
  return /^TASK-\d{8}-\d{3,}/i.exec(token)?.[0].toUpperCase() ?? token;
}

export function isTaskCancelled(
  task: DispatchGateTaskRef,
  meta: ExecutionTaskMeta | undefined,
): boolean {
  if (meta?.cancelled === true) return true;
  const ds = String(task.displayStatus ?? "").trim().toLowerCase();
  return ds === "cancelled";
}

export function isTaskSuperseded(
  task: DispatchGateTaskRef,
  ctx: ExecutionGateContext,
): boolean {
  const id = normalizeTaskIdPrefix(task.taskId);
  const meta = ctx.taskMeta.get(id) ?? ctx.taskMeta.get(task.taskId);
  return Boolean(meta?.supersededBy);
}

function sameThread(
  threadKey: string | undefined,
  other: string | undefined,
): boolean {
  const a = String(threadKey ?? "").trim();
  const b = String(other ?? "").trim();
  if (!a || !b) return true;
  return a === b;
}

export function resolveArtifactPathForThread(
  threadKey: string | undefined,
  threadTasks: DispatchGateTaskRef[],
  ctx: ExecutionGateContext,
): string | undefined {
  for (const role of ["QA", "DEV", "OPS"] as const) {
    const t = threadTasks.find(
      (row) => normalizeWorkerRole(row.recipient) === role,
    );
    if (!t) continue;
    const id = normalizeTaskIdPrefix(t.taskId);
    const path =
      ctx.taskMeta.get(id)?.artifactPath ??
      ctx.taskMeta.get(t.taskId)?.artifactPath;
    if (path) return path;
  }
  for (const t of threadTasks) {
    const id = normalizeTaskIdPrefix(t.taskId);
    const path =
      ctx.taskMeta.get(id)?.artifactPath ??
      ctx.taskMeta.get(t.taskId)?.artifactPath;
    if (path) return path;
  }
  return undefined;
}

export function artifactPathExists(
  ctx: ExecutionGateContext,
  relPath: string | undefined,
): boolean {
  const p = String(relPath ?? "").trim();
  if (!p) return false;
  const normalized = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const projectName = basename(resolve(ctx.projectRoot)).replace(/\\/g, "/");
  const relCandidates = new Set<string>([normalized]);

  const projectPrefix = `workspace/${projectName}/`;
  if (normalized.toLowerCase().startsWith(projectPrefix.toLowerCase())) {
    relCandidates.add(normalized.slice(projectPrefix.length));
  }

  const projectSegment = `/workspace/${projectName}/`;
  const segmentIndex = normalized.toLowerCase().indexOf(projectSegment.toLowerCase());
  if (segmentIndex >= 0) {
    relCandidates.add(normalized.slice(segmentIndex + projectSegment.length));
  }

  if (normalized.toLowerCase().startsWith(`${projectName.toLowerCase()}/`)) {
    relCandidates.add(normalized.slice(projectName.length + 1));
  }

  if (ctx.artifactExists) {
    for (const candidate of relCandidates) {
      if (ctx.artifactExists(candidate)) return true;
    }
  }

  const absoluteCandidates = new Set<string>();
  if (isAbsolute(p)) absoluteCandidates.add(resolve(p));
  for (const candidate of relCandidates) {
    absoluteCandidates.add(resolve(ctx.projectRoot, candidate));
  }

  for (const abs of absoluteCandidates) {
    if (existsSync(abs)) return true;
    if (!abs.replace(/\\/g, "/").endsWith("/index.html")) {
      if (existsSync(join(abs, "index.html"))) return true;
    }
  }

  if (isAbsolute(p)) {
    const rel = relative(resolve(ctx.projectRoot), resolve(p)).replace(/\\/g, "/");
    if (rel && !rel.startsWith("../") && rel !== ".." && ctx.artifactExists?.(rel)) {
      return true;
    }
  }
  return false;
}

function dependenciesSettled(
  target: DispatchGateTaskRef,
  threadTasks: DispatchGateTaskRef[],
  reports: DispatchGateReportRef[],
): boolean {
  return isUpstreamWorkerSettled(
    "",
    target.threadKey,
    threadTasks,
    reports,
    target,
  );
}

export function resolveExecutionState(
  target: DispatchGateTaskRef,
  ctx: ExecutionGateContext,
  threadTasks?: DispatchGateTaskRef[],
): ExecutionState {
  const scoped =
    threadTasks ?? filterThreadTasks(ctx.tasks, target.threadKey);
  const meta =
    ctx.taskMeta.get(normalizeTaskIdPrefix(target.taskId)) ??
    ctx.taskMeta.get(target.taskId);

  if (isTaskSuperseded(target, ctx)) return "superseded";
  if (isTaskCompleted(target)) return "completed";
  if (isTaskCancelled(target, meta)) return "blocked";

  if (!dependenciesSettled(target, scoped, ctx.reports)) {
    return "waiting_dependency";
  }

  const role = normalizeWorkerRole(target.recipient);
  if (role === "QA" || role === "OPS") {
    const artifact = resolveArtifactPathForThread(
      target.threadKey,
      scoped,
      ctx,
    );
    if (artifact && !artifactPathExists(ctx, artifact)) return "blocked";
  }

  return "runnable";
}
