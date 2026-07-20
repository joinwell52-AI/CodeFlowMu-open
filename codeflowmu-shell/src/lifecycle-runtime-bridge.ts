import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, resolve as pathResolve } from "node:path";

import {
  AuthorityError,
  ChildTasksNotAcceptedError,
  ChildTasksOpenError,
  LifecycleStateMachine,
  approveHotPathTaskReview,
  approveProjectedLifecycleTaskReview,
  archiveHotPathTask,
  buildLifecycleTransitionKey,
  lifecycleTransitionDedupe,
  locateHotPathTask,
  locateProjectedPmReviewLifecycleTask,
  rejectHotPathTaskReview,
  rejectProjectedLifecycleTaskReview,
  findTaskPathByIdSync,
  type LifecycleTransitionResult,
} from "@codeflowmu/runtime";

import {
  isLedgerTaskIdOrphan,
  reconcileLedgerAfterJoin,
} from "./ledger-api-helpers.ts";
import { fcopLogsRuntimeEventsPath } from "./logs-paths.ts";

export type LifecycleRuntimeAction =
  | "submit_review"
  | "approve_review"
  | "reject_review"
  | "reopen_task"
  | "archive_task"
  | "finish_task";

export function resolveLifecycleProjectRoot(): string {
  const fromEnv = process.env["FCOP_PROJECT_DIR"]?.trim();
  if (fromEnv) return pathResolve(fromEnv);
  return process.cwd();
}

export function lifecycleRootFromProject(projectRoot: string): string {
  return join(projectRoot, "fcop", "_lifecycle");
}

function pickStr(args: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function taskIdFromArgs(args: Record<string, unknown>): string {
  let id = pickStr(args, "task_id", "taskId", "id", "filename");
  if (id.endsWith(".md")) id = id.replace(/\.md$/i, "");
  return id;
}

function normalizeTaskRef(value: string): string {
  return value.trim().replace(/\.md$/i, "");
}

const REVIEWABLE_TERMINAL_REPORT_STATUSES = new Set([
  "done",
  "completed",
  "blocked",
  "failed",
  "aborted",
]);

function frontmatterValue(raw: string, key: string): string {
  const match = raw.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "im"));
  return match?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
}

function frontmatterListContains(raw: string, key: string, value: string): boolean {
  const start = raw.match(new RegExp(`^${key}:\\s*$`, "im"));
  if (start?.index === undefined) return false;
  const rest = raw.slice(start.index + start[0].length);
  for (const line of rest.split(/\r?\n/)) {
    if (/^\S/.test(line)) break;
    const item = line.match(/^\s*-\s*(.+?)\s*$/);
    if (item && normalizeTaskRef(item[1] ?? "") === value) return true;
  }
  return false;
}

function findLatestReportIdForSubmit(
  projectRoot: string,
  taskId: string,
  actor: string,
): string {
  const reportsDir = join(projectRoot, "fcop", "reports");
  if (!existsSync(reportsDir)) return "";
  const normalizedTaskId = normalizeTaskRef(taskId);
  const normalizedActor = actor.trim().toUpperCase();
  const candidates: Array<{ id: string; mtime: number }> = [];
  for (const entry of readdirSync(reportsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^REPORT-.*\.md$/i.test(entry.name)) continue;
    const path = join(reportsDir, entry.name);
    let raw = "";
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    const reporter = (
      frontmatterValue(raw, "reporter") || frontmatterValue(raw, "sender")
    ).toUpperCase();
    if (normalizedActor && reporter && reporter !== normalizedActor) continue;
    const status = frontmatterValue(raw, "status").toLowerCase();
    if (status && !REVIEWABLE_TERMINAL_REPORT_STATUSES.has(status)) continue;
    const directTask = normalizeTaskRef(frontmatterValue(raw, "task_id"));
    const sourceTask = normalizeTaskRef(frontmatterValue(raw, "source_task_id"));
    const linked =
      directTask === normalizedTaskId ||
      sourceTask === normalizedTaskId ||
      frontmatterListContains(raw, "references", normalizedTaskId);
    if (!linked) continue;
    const id = entry.name.replace(/\.md$/i, "");
    let mtime = 0;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      /* keep zero */
    }
    candidates.push({ id, mtime });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.id ?? "";
}

export function createLifecycleStateMachine(projectRoot?: string): LifecycleStateMachine {
  const root = projectRoot ?? resolveLifecycleProjectRoot();
  return new LifecycleStateMachine({
    lifecycleRoot: lifecycleRootFromProject(root),
  });
}

export type LifecycleRuntimeResult =
  | (LifecycleTransitionResult & { ok: true })
  | {
      ok: false;
      error: string;
      authority?: boolean;
      code?:
        | "ledger_orphan"
        | "file_missing"
        | "CHILD_TASKS_OPEN"
        | "CHILD_TASKS_NOT_ACCEPTED";
      child_tasks?: Array<{
        task_id: string;
        filename: string;
        bucket: string;
        display_status?: string;
        reasons?: string[];
      }>;
    };

export type LifecyclePanelSink = (
  type: string,
  payload: Record<string, unknown>,
) => void;

let lifecyclePanelSink: LifecyclePanelSink | null = null;

/** Web Panel wires sseEmit so approve/archive transitions appear in doorbell + replay. */
export function setLifecyclePanelSink(sink: LifecyclePanelSink | null): void {
  lifecyclePanelSink = sink;
}

const LIFECYCLE_EMIT_TYPES = new Set([
  "codeflowmu.lifecycle.task_to_review",
  "codeflowmu.lifecycle.review_to_done",
  "codeflowmu.lifecycle.done_to_archive",
  "codeflowmu.lifecycle.review_to_active",
  "codeflowmu.lifecycle.done_to_active",
]);

/** J3/J4/J5 — lifecycle syscall must trigger J1 ledger rebuild (并轨). */
const LIFECYCLE_JOIN_ACTIONS = new Set<LifecycleRuntimeAction>([
  "submit_review",
  "approve_review",
  "reject_review",
  "reopen_task",
  "archive_task",
  "finish_task",
]);

function appendLifecycleEventToDisk(
  type: string,
  payload: Record<string, unknown>,
): void {
  try {
    const root = resolveLifecycleProjectRoot();
    const path = fcopLogsRuntimeEventsPath(root);
    const dir = join(root, "fcop", "logs", "runtime");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      ts: Date.now(),
      at: new Date().toISOString(),
      event_type: type,
      ...(payload.task_id ? { task_id: String(payload.task_id) } : {}),
      ...(payload.actor ? { agent_id: String(payload.actor) } : {}),
      payload,
    });
    appendFileSync(path, `${line}\n`, "utf-8");
  } catch {
    /* best-effort — MCP filter subprocess has no in-memory doorbell */
  }
}

function emitLifecycleTransition(
  action: LifecycleRuntimeAction,
  taskId: string,
  actor: string,
  extras?: Record<string, unknown>,
): void {
  let type: string | null = null;
  let from_stage = "";
  let to_stage = "";
  let event = "";

  switch (action) {
    case "submit_review":
      type = "codeflowmu.lifecycle.task_to_review";
      event = "lifecycle_task_to_review";
      from_stage = "active";
      to_stage = "review";
      break;
    case "approve_review":
    case "finish_task":
      type = "codeflowmu.lifecycle.review_to_done";
      event = "lifecycle_review_to_done";
      from_stage = "review";
      to_stage = "done";
      break;
    case "archive_task":
      type = "codeflowmu.lifecycle.done_to_archive";
      event = "lifecycle_done_to_archive";
      from_stage = "done";
      to_stage = "archive";
      break;
    case "reject_review":
      type = "codeflowmu.lifecycle.review_to_active";
      event = "lifecycle_review_to_active";
      from_stage = "review";
      to_stage = "active";
      break;
    case "reopen_task":
      type = "codeflowmu.lifecycle.done_to_active";
      event = "lifecycle_done_to_active";
      from_stage = "done";
      to_stage = "active";
      break;
    default:
      return;
  }

  if (!type || !LIFECYCLE_EMIT_TYPES.has(type)) return;

  const effectiveFrom =
    typeof extras?.from_stage === "string" && extras.from_stage
      ? extras.from_stage
      : from_stage;
  const effectiveTo =
    typeof extras?.to_stage === "string" && extras.to_stage
      ? extras.to_stage
      : to_stage;

  const dedupeKey = buildLifecycleTransitionKey({
    taskId,
    eventType: type,
    fromStage: effectiveFrom,
    toStage: effectiveTo,
  });
  if (!lifecycleTransitionDedupe.shouldEmit(dedupeKey)) return;

  const payload: Record<string, unknown> = {
    event,
    task_id: taskId,
    actor,
    from_stage: effectiveFrom,
    to_stage: effectiveTo,
    ...(extras ?? {}),
  };

  if (lifecyclePanelSink) {
    lifecyclePanelSink(type, payload);
  } else {
    appendLifecycleEventToDisk(type, payload);
  }
}

async function finalizeLifecycleResult(
  action: LifecycleRuntimeAction,
  taskId: string,
  actor: string,
  result: LifecycleTransitionResult,
  projectRoot: string,
  emitExtras?: Record<string, unknown>,
): Promise<LifecycleRuntimeResult> {
  emitLifecycleTransition(action, taskId, actor, {
    ...(emitExtras ?? {}),
    ...(result.from ? { from_stage: result.from } : {}),
    ...(result.to ? { to_stage: result.to } : {}),
  });
  if (LIFECYCLE_JOIN_ACTIONS.has(action)) {
    try {
      await reconcileLedgerAfterJoin(projectRoot);
    } catch {
      /* best-effort J1 after join */
    }
  }
  return result;
}

function lifecycleError(err: unknown): LifecycleRuntimeResult {
  if (err instanceof AuthorityError) {
    return { ok: false, error: err.message, authority: true };
  }
  if (err instanceof ChildTasksOpenError) {
    return {
      ok: false,
      error: err.message,
      code: "CHILD_TASKS_OPEN",
      child_tasks: err.openChildren,
    };
  }
  if (err instanceof ChildTasksNotAcceptedError) {
    return {
      ok: false,
      error: err.message,
      code: "CHILD_TASKS_NOT_ACCEPTED",
      child_tasks: err.notAcceptedChildren,
    };
  }
  return {
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  };
}

/** Refuse SM transitions when _lifecycle has no TASK file (disk is source of truth). */
function assertLifecycleTaskFileOnDisk(
  root: string,
  taskId: string,
): LifecycleRuntimeResult | null {
  const lifecycleRoot = lifecycleRootFromProject(root);
  if (findTaskPathByIdSync(lifecycleRoot, taskId)) return null;
  if (isLedgerTaskIdOrphan(root, taskId)) {
    return {
      ok: false,
      error: `Task ${taskId} is ledger_orphan (ledger row exists but _lifecycle file missing)`,
      code: "ledger_orphan",
    };
  }
  return {
    ok: false,
    error: `Task file missing for ${taskId}`,
    code: "file_missing",
  };
}

export async function executeLifecycleRuntimeAction(
  action: LifecycleRuntimeAction,
  args: Record<string, unknown>,
  projectRoot?: string,
): Promise<LifecycleRuntimeResult> {
  const root = projectRoot ?? resolveLifecycleProjectRoot();
  const taskId = taskIdFromArgs(args);
  if (!taskId) {
    return { ok: false, error: "task_id is required" };
  }
  const actor = pickStr(args, "actor", "sender", "role", "reviewer") || "PM";

  if (action === "approve_review" || action === "reject_review") {
    const hot = await locateHotPathTask(root, taskId);
    if (hot) {
      try {
        const note = pickStr(args, "note", "reason");
        const reason = pickStr(args, "reason", "note");
        if (action === "approve_review") {
          const hotResult = await approveHotPathTaskReview({
            projectRoot: root,
            taskId,
            actor,
            ...(note ? { note } : {}),
          });
          return finalizeLifecycleResult(action, taskId, actor, hotResult, root);
        }
        const hotResult = await rejectHotPathTaskReview({
          projectRoot: root,
          taskId,
          actor,
          reason: reason || "rejected",
        });
        return finalizeLifecycleResult(action, taskId, actor, hotResult, root, {
          reason: reason || "rejected",
          reopen_reason: reason || "rejected",
          review_status: "rejected",
        });
      } catch (err) {
        return lifecycleError(err);
      }
    }

    const projected = await locateProjectedPmReviewLifecycleTask(root, taskId);
    if (projected) {
      try {
        const note = pickStr(args, "note", "reason");
        const reason = pickStr(args, "reason", "note");
        if (action === "approve_review") {
          const projectedResult = await approveProjectedLifecycleTaskReview({
            projectRoot: root,
            taskId,
            actor,
            ...(note ? { note } : {}),
          });
          return finalizeLifecycleResult(action, taskId, actor, projectedResult, root);
        }
        const projectedResult = await rejectProjectedLifecycleTaskReview({
          projectRoot: root,
          taskId,
          actor,
          reason: reason || "rejected",
        });
        return finalizeLifecycleResult(action, taskId, actor, projectedResult, root, {
          reason: reason || "rejected",
          reopen_reason: reason || "rejected",
          review_status: "rejected",
        });
      } catch (err) {
        return lifecycleError(err);
      }
    }
  }

  if (action === "archive_task") {
    const hot = await locateHotPathTask(root, taskId);
    if (hot) {
      try {
        const reason = pickStr(args, "reason", "note") || "手动归档（archive_task）";
        const force = args["force"] === true || args["force"] === "true";
        const hotResult = await archiveHotPathTask({
          projectRoot: root,
          taskId,
          actor,
          reason,
          force,
        });
        return finalizeLifecycleResult(action, taskId, actor, hotResult, root);
      } catch (err) {
        return lifecycleError(err);
      }
    }
  }

  const hotForGate = await locateHotPathTask(root, taskId);
  if (!hotForGate) {
    const fileGate = assertLifecycleTaskFileOnDisk(root, taskId);
    if (fileGate) return fileGate;
  }

  const sm = createLifecycleStateMachine(root);
  try {
    switch (action) {
      case "submit_review": {
        const reportId =
          pickStr(args, "report_id", "reportId", "report") ||
          findLatestReportIdForSubmit(root, taskId, actor);
        const reason = pickStr(args, "reason", "note");
        const result = await sm.submitReview({
          taskId,
          actor,
          reportId,
          ...(reason ? { reason } : {}),
        });
        return finalizeLifecycleResult(action, taskId, actor, result, root);
      }
      case "approve_review": {
        const note = pickStr(args, "note", "reason");
        const result = await sm.approveReview({
          taskId,
          actor,
          ...(note ? { note } : {}),
        });
        return finalizeLifecycleResult(action, taskId, actor, result, root);
      }
      case "reject_review": {
        const reason = pickStr(args, "reason", "note");
        const result = await sm.rejectReview({ taskId, actor, reason });
        return finalizeLifecycleResult(action, taskId, actor, result, root, {
          ...(reason ? { reason, reopen_reason: reason } : {}),
          review_status: "rejected",
        });
      }
      case "reopen_task": {
        const reason = pickStr(args, "reason", "note");
        const result = await sm.reopenTask({ taskId, actor, reason });
        return finalizeLifecycleResult(action, taskId, actor, result, root, {
          ...(reason ? { reason, reopen_reason: reason } : {}),
        });
      }
      case "archive_task": {
        const reason = pickStr(args, "reason", "note") || "手动归档（archive_task）";
        const force = args["force"] === true || args["force"] === "true";
        const result = await sm.archiveTask({ taskId, actor, reason, force });
        return finalizeLifecycleResult(action, taskId, actor, result, root);
      }
      case "finish_task": {
        const note = pickStr(args, "note", "reason");
        const result = await sm.finishTaskLegacy({
          taskId,
          actor,
          ...(note ? { note } : {}),
        });
        return finalizeLifecycleResult(action, taskId, actor, result, root);
      }
      default:
        return { ok: false, error: `unknown action: ${action as string}` };
    }
  } catch (err) {
    return lifecycleError(err);
  }
}
