/**
 * taskDispatchGate — internal trusted auto-dispatch vs explicit dispatch_task hold.
 *
 * Trusted internal routes (ADMIN→PM, PM→DEV|QA|OPS) auto-dispatch on inbox arrival.
 * External/unknown/manual-import tasks stay in inbox until explicit dispatch_task.
 * Thread dependency chain (DEV → QA/OPS → EVAL) is evaluated inside dispatchTask.
 */

export type DispatchGateReason =
  | "allowed"
  | "waiting_dependency"
  | "task_not_dispatched"
  | "already_active"
  | "already_done";

export type ExplicitDispatchHoldReason =
  | "untrusted_source"
  | "missing_provenance"
  | "manual_import"
  | "child_subtask";

export interface DispatchGateTaskRef {
  protocol?: string;
  taskId: string;
  filename: string;
  recipient: string;
  sender?: string;
  threadKey?: string;
  lifecycleBucket: string;
  fmState?: string;
  displayStatus?: string;
  terminatedByParentArchive?: boolean;
  closedParentResidue?: boolean;
  parent?: string;
  parentTaskId?: string;
  reworkOf?: string;
  /** Canonical TASK frontmatter dependency edges (`depends_on`). */
  dependsOn?: string[];
}

export interface DispatchGateReportRef {
  taskId: string;
  reporter: string;
  status: string;
  threadKey?: string;
}

export const WORKER_DISPATCH_CHAIN = ["DEV", "OPS", "QA", "EVAL"] as const;

/** Routes that auto-dispatch on inbox arrival (no explicit dispatch_task hold). */
export const TRUSTED_INTERNAL_DISPATCH_PAIRS = [
  { sender: "ADMIN", recipient: "PM" },
  { sender: "PM", recipient: "DEV" },
  { sender: "PM", recipient: "QA" },
  { sender: "PM", recipient: "OPS" },
] as const;

export interface ExplicitDispatchGateInput {
  sender?: string;
  recipient?: string;
  filename?: string;
  protocol?: string;
  fmSender?: string;
  parent?: string;
  parentTaskId?: string;
  reworkOf?: string;
}

export function readExplicitParentId(
  task: Pick<ExplicitDispatchGateInput, "parent" | "parentTaskId">,
): string {
  return String(task.parent ?? task.parentTaskId ?? "").trim();
}

/** ADMIN→PM child subtasks stay in inbox until explicit dispatch (rework exempt). */
export function isAdminPmChildSubtaskHold(
  task: ExplicitDispatchGateInput,
): boolean {
  if (String(task.reworkOf ?? "").trim()) return false;
  if (!readExplicitParentId(task)) return false;
  const sender = normalizeDispatchRole(
    task.sender ?? task.fmSender ?? extractSenderFromFilename(task.filename ?? ""),
  );
  const recipient = normalizeDispatchRole(
    task.recipient ?? extractRecipientFromFilename(task.filename ?? ""),
  );
  return sender === "ADMIN" && recipient === "PM";
}

export function normalizeDispatchRole(role: string): string {
  const raw = String(role ?? "").trim().toUpperCase();
  if (!raw) return "";
  return raw.split("-")[0] ?? raw;
}

/** Alias for worker dependency chain normalization. */
export function normalizeWorkerRole(recipient: string): string {
  const raw = String(recipient ?? "").trim().toUpperCase();
  if (!raw) return "";
  return raw.split("-")[0] ?? raw;
}

export function isTrustedInternalDispatch(
  sender: string,
  recipient: string,
): boolean {
  const s = normalizeDispatchRole(sender);
  const r = normalizeDispatchRole(recipient);
  return TRUSTED_INTERNAL_DISPATCH_PAIRS.some(
    (p) => p.sender === s && p.recipient === r,
  );
}

/** Roles that must complete (valid REPORT) before `recipient` may dispatch. */
export function prerequisiteWorkerRoles(recipient: string): readonly string[] {
  // Dependency order belongs to a concrete task (`depends_on`), never to a
  // role.  Keep this export for callers compiled against the old API, but do
  // not manufacture DEV→QA/OPS or QA→EVAL edges here.
  void recipient;
  return [];
}

export function isDoneReportStatus(status: string | undefined): boolean {
  const s = String(status ?? "").trim().toLowerCase();
  return s === "done" || s === "pass" || s === "passed" || s === "completed";
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

function normalizeDependencyTaskId(value: string | undefined): string {
  const raw = String(value ?? "").trim().replace(/\.md$/i, "");
  const canonical = /^TASK-\d{8}-\d{3,}/i.exec(raw)?.[0];
  return (canonical ?? raw).toUpperCase();
}

function hasValidDoneReportForTask(
  task: DispatchGateTaskRef,
  reports: DispatchGateReportRef[],
): boolean {
  const taskId = normalizeDependencyTaskId(task.taskId);
  if (!taskId) return false;
  const expectedReporter = normalizeWorkerRole(task.recipient);
  return reports.some(
    (report) =>
      normalizeDependencyTaskId(report.taskId) === taskId &&
      normalizeWorkerRole(report.reporter) === expectedReporter &&
      isDoneReportStatus(report.status),
  );
}

function newestTask(tasks: DispatchGateTaskRef[]): DispatchGateTaskRef | undefined {
  return [...tasks].sort((a, b) =>
    normalizeDependencyTaskId(b.taskId).localeCompare(
      normalizeDependencyTaskId(a.taskId),
      "en",
      { numeric: true },
    ),
  )[0];
}

export interface UpstreamSettlementResult {
  settled: boolean;
  waitingOn?: string;
  mode: "explicit" | "fallback" | "not_required";
}

/**
 * Resolve the concrete upstream task(s) for a worker gate.
 *
 * Explicit `depends_on` edges are authoritative and require both an existing
 * task and a done REPORT owned by that task's recipient. Tasks without an
 * explicit edge have no dependency gate. This is intentionally task-based:
 * two QA rounds can depend on two different DEV rounds in the same thread.
 */
export function evaluateUpstreamWorkerSettlement(
  reqRole: string,
  threadKey: string | undefined,
  threadTasks: DispatchGateTaskRef[],
  reports: DispatchGateReportRef[],
  target?: DispatchGateTaskRef,
): UpstreamSettlementResult {
  const explicitIds = [...new Map(
    (target?.dependsOn ?? [])
      .map((value) => ({
        key: normalizeDependencyTaskId(value),
        display: String(value).trim().replace(/\.md$/i, ""),
      }))
      .filter((value) => value.key)
      .map((value) => [value.key, value] as const),
  ).values()];
  if (explicitIds.length > 0) {
    for (const dependencyId of explicitIds) {
      const dependency = threadTasks.find(
        (task) => normalizeDependencyTaskId(task.taskId) === dependencyId.key,
      );
      if (!dependency || !hasValidDoneReportForTask(dependency, reports)) {
        return {
          settled: false,
          waitingOn: dependencyId.key,
          mode: "explicit",
        };
      }
    }
    return { settled: true, mode: "explicit" };
  }

  void reqRole;
  void threadKey;
  void threadTasks;
  void reports;
  return { settled: true, mode: "not_required" };
}

/** Exported for QA execution gate / execution_state. */
export function isUpstreamWorkerSettled(
  reqRole: string,
  threadKey: string | undefined,
  threadTasks: DispatchGateTaskRef[],
  reports: DispatchGateReportRef[],
  target?: DispatchGateTaskRef,
): boolean {
  return evaluateUpstreamWorkerSettlement(
    reqRole,
    threadKey,
    threadTasks,
    reports,
    target,
  ).settled;
}

export function isClosedParentResidueDispatchTask(
  task: DispatchGateTaskRef,
): boolean {
  if (task.terminatedByParentArchive === true) return true;
  if (task.closedParentResidue === true) return true;
  const ds = String(task.displayStatus ?? "").trim().toLowerCase();
  return ds === "closed_parent_residue";
}

export function evaluateDispatchEligibility(
  target: DispatchGateTaskRef,
  threadTasks: DispatchGateTaskRef[],
  reports: DispatchGateReportRef[],
): {
  allowed: boolean;
  reason: DispatchGateReason;
  detail?: string;
  waitingOn?: string;
} {
  if (isClosedParentResidueDispatchTask(target)) {
    return {
      allowed: false,
      reason: "already_done",
      detail: "closed_parent_residue",
    };
  }
  const bucket = target.lifecycleBucket.toLowerCase();
  if (bucket === "done" || bucket === "archive") {
    return { allowed: false, reason: "already_done", detail: "task completed" };
  }
  if (bucket === "active" || bucket === "review") {
    return {
      allowed: false,
      reason: "already_active",
      detail: "task already dispatched",
    };
  }
  const fm = String(target.fmState ?? "inbox").toLowerCase();
  if (fm === "dispatched" || fm === "running") {
    return {
      allowed: false,
      reason: "already_active",
      detail: `frontmatter state=${fm}`,
    };
  }

  const settlement = evaluateUpstreamWorkerSettlement(
    "",
    target.threadKey?.trim() || undefined,
    threadTasks,
    reports,
    target,
  );
  if (!settlement.settled) {
    return {
      allowed: false,
      reason: "waiting_dependency",
      detail: `waiting for ${settlement.waitingOn ?? "dependency"} done report`,
      waitingOn: settlement.waitingOn ?? "dependency",
    };
  }

  return { allowed: true, reason: "allowed" };
}

export function isTaskRunnableForWake(task: DispatchGateTaskRef): {
  runnable: boolean;
  reason?: "task_not_dispatched" | "already_done";
  detail?: string;
} {
  if (isClosedParentResidueDispatchTask(task)) {
    return {
      runnable: false,
      reason: "already_done",
      detail: "closed_parent_residue",
    };
  }
  const bucket = task.lifecycleBucket.toLowerCase();
  if (bucket === "done" || bucket === "archive") {
    return { runnable: false, reason: "already_done", detail: bucket };
  }
  if (bucket === "inbox") {
    if (
      !requiresExplicitDispatch({
        sender: task.sender,
        recipient: task.recipient,
        filename: task.filename,
        parent: task.parent,
        parentTaskId: task.parentTaskId,
        reworkOf: task.reworkOf,
      })
    ) {
      return { runnable: true };
    }
    return {
      runnable: false,
      reason: "task_not_dispatched",
      detail: "task held in inbox; explicit dispatch required",
    };
  }
  return { runnable: true };
}

export function extractRecipientFromFilename(filename: string): string {
  const m = filename.match(/-to-([A-Za-z0-9]+)(?:-|\.)/i);
  return m?.[1]?.toUpperCase() ?? "";
}

export function extractSenderFromFilename(filename: string): string {
  const m = filename.match(/^TASK-\d{8}-\d{3,}-([A-Za-z0-9]+)-to-/i);
  return m?.[1]?.toUpperCase() ?? "";
}

/** REPORT-*-{sender}-to-{recipient}.md — aligns with TaskDependencyGate disk reads. */
export function extractReporterFromReportFilename(filename: string): string {
  const routed = filename.match(/^REPORT-\d{8}-\d{3,}-([A-Za-z0-9]+)-to-/i);
  if (routed?.[1]) return routed[1].toUpperCase();
  const legacy = filename.match(/^REPORT-\d{8}-\d{3,}-([A-Za-z0-9]+)(?:-|\.)/i);
  return legacy?.[1]?.toUpperCase() ?? "";
}

/**
 * Classify why a task must stay in inbox until explicit dispatch_task.
 * Returns null when the route is trusted internal (auto-dispatch on inbox).
 */
export function resolveExplicitDispatchHoldReason(
  task: ExplicitDispatchGateInput,
): ExplicitDispatchHoldReason | null {
  const filenameSender = extractSenderFromFilename(task.filename ?? "");
  const filenameRecipient = extractRecipientFromFilename(task.filename ?? "");
  const sender = normalizeDispatchRole(
    task.sender ?? task.fmSender ?? filenameSender,
  );
  const recipient = normalizeDispatchRole(
    task.recipient ?? filenameRecipient,
  );

  if (!recipient) {
    return "untrusted_source";
  }

  const fmSender = task.fmSender
    ? normalizeDispatchRole(task.fmSender)
    : "";
  const fnSender = filenameSender
    ? normalizeDispatchRole(filenameSender)
    : "";

  if (fmSender && fnSender && fmSender !== fnSender) {
    return "missing_provenance";
  }

  if (isAdminPmChildSubtaskHold(task)) {
    return "child_subtask";
  }

  // Trusted internal routes (ADMIN→PM root, PM→DEV|QA|OPS) auto-dispatch on inbox.
  if (isTrustedInternalDispatch(sender, recipient)) {
    return null;
  }

  const proto = String(task.protocol ?? "").trim().toLowerCase();
  if (!proto) {
    return "manual_import";
  }
  if (proto !== "fcop" && proto !== "agent_bridge") {
    return "manual_import";
  }

  return "untrusted_source";
}

/**
 * True when inbox arrival must NOT auto-dispatch (explicit dispatch_task required).
 * Trusted internal routes (ADMIN→PM, PM→DEV|QA|OPS) return false.
 */
export function requiresExplicitDispatch(
  task: ExplicitDispatchGateInput,
): boolean {
  return resolveExplicitDispatchHoldReason(task) !== null;
}
