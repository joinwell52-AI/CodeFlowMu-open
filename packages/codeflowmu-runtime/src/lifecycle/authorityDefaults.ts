import type { TaskFm } from "./types.ts";

const LIFECYCLE_BUCKET_NAMES = new Set([
  "inbox",
  "active",
  "review",
  "done",
  "archive",
]);

function isLifecycleBucketToken(value: unknown): boolean {
  const s = String(value ?? "").trim().toLowerCase();
  return s.length > 0 && LIFECYCLE_BUCKET_NAMES.has(s);
}

/** Resolve sender / recipient from frontmatter or task_id filename tail. */
export function taskRouteRoles(task: TaskFm): { from: string; to: string } {
  let fromRaw = task.from ?? task.sender ?? "";
  let toRaw = task.to ?? task.recipient ?? "";
  if (isLifecycleBucketToken(fromRaw)) fromRaw = task.sender ?? "";
  if (isLifecycleBucketToken(toRaw)) toRaw = task.recipient ?? "";
  let from = String(fromRaw).toUpperCase();
  let to = String(toRaw).toUpperCase();
  if (from && to) return { from, to };

  const id = String(task.task_id ?? "");
  const m = id.match(/TASK-\d{8}-\d{3,}-(.+)-to-(.+)$/i);
  if (m) {
    from = from || m[1]!.toUpperCase();
    to = to || m[2]!.toUpperCase();
  }
  return { from, to };
}

/** FCoP-PENDING-0001: ADMIN↔PM main line vs PM↔DEV/QA/OPS branch. */
export function inferTaskLine(task: TaskFm): "main" | "branch" {
  if (task.line === "main" || task.line === "branch") return task.line;
  const { from, to } = taskRouteRoles(task);
  if (from === "ADMIN" && to === "PM") return "main";
  if (from === "PM" && /^(DEV|QA|OPS)(-\d+)?$/i.test(to)) return "branch";
  return "branch";
}

export function resolveDriver(task: TaskFm): string {
  const explicit = String(task.driver ?? "").trim();
  if (explicit) return explicit.toUpperCase();
  return taskRouteRoles(task).to;
}

export function resolveReviewer(task: TaskFm): string {
  const explicit = String(task.reviewer ?? "").trim();
  if (explicit) return explicit.toUpperCase();
  return inferTaskLine(task) === "main" ? "ADMIN" : "PM";
}

export function resolveDoneAuthority(task: TaskFm): string {
  const explicit = String(task.done_authority ?? "").trim();
  if (explicit) return explicit.toUpperCase();
  if (task.delegated_done === true) return "PM";
  return inferTaskLine(task) === "main" ? "ADMIN" : "PM";
}

export function resolveArchiveAuthority(task: TaskFm): string {
  const explicit = String(task.archive_authority ?? "").trim();
  if (explicit) return explicit.toUpperCase();
  return inferTaskLine(task) === "main" ? "ADMIN" : "PM";
}
