/**
 * PM downstream worker receipt waiting — convergent display rules for
 * waiting_qa_receipt / waiting_worker_receipt (Panel + PmQueueGuard).
 */

import { isWorkerReportToPm } from "../fcop/governance.ts";
import {
  findAdminRootTask,
  isPmAdminFinalSummaryReport,
  taskIdMatchesPrefix,
} from "../ledger/reportParenting.ts";
import type { LedgerReportRecord, LedgerTaskRecord } from "../ledger/types.ts";
import { isPmToWorkerDispatch } from "../scheduler/PmQueueGuard.ts";
import {
  isRecoverableSessionFailure,
  type SessionReceiptQueueState,
} from "./sessionReceiptReconcile.ts";
import {
  isWorkerReceiptWaitingBucket,
  resolveTaskCurrentBucket,
} from "./taskCurrentBucket.ts";

export const MAX_DOWNSTREAM_AUTO_NUDGES = 3;

const SKIP_DISPLAY_STATUSES = new Set([
  "force_archived",
  "cancelled",
  "skipped",
  "admin_override",
]);

/** PM/ADMIN must decide — stop downstream auto-nudge. */
const PM_DECISION_DISPLAY_STATUSES = new Set([
  "waiting_pm_attention",
  "waiting_admin_decision",
]);

const PASS_REPORT_STATUSES = new Set(["done", "completed", "pass", "passed"]);

const FAIL_REPORT_STATUSES = new Set([
  "failed",
  "blocked",
  "cancelled",
  "force_archived",
]);

export type WorkerReceiptWaitingPhase =
  | "waiting_qa_receipt"
  | "waiting_worker_receipt"
  | "worker_receipt_failed"
  | "worker_report_needs_pm"
  | "session_recoverable"
  | "session_running"
  | "cleared"
  | "none";

export interface WorkerReceiptWaitingResult {
  phase: WorkerReceiptWaitingPhase;
  /** Panel bottom bar four-state classification. */
  queueState: SessionReceiptQueueState;
  /** Panel / queue bar should show "等待 QA 回执" style label. */
  shouldShowWaiting: boolean;
  /** PmQueueGuard waiting_downstream + auto-nudge should be cleared. */
  shouldClearGuard: boolean;
  role: string | null;
  workerTaskId: string | null;
  /** Latest worker REPORT filename/id driving failed/cleared decision. */
  receiptReportId: string | null;
  threadKey: string | null;
  reason: string;
  reasonCode: string | null;
  lastSessionId: string | null;
  suggestedAction: "wait" | "recover" | "review_report" | null;
}

export interface WorkerReceiptWaitingOpts {
  tasks: LedgerTaskRecord[];
  reports: LedgerReportRecord[];
  targetRole?: string | null;
  focusTaskId?: string | null;
  nudgeCount?: number;
  /** Last downstream wake session ended failed / blocked. */
  sessionFailed?: boolean;
  /** Task explicitly marked failed (e.g. session_ended hook). */
  workerFailed?: boolean;
  /** Disk truth: worker REPORT exists for task. */
  hasReportOnDisk?: boolean;
  agentRunning?: boolean;
  sessionUnsettled?: boolean;
  recoverable?: boolean;
  lastSessionId?: string | null;
  lastFailureCode?: string | null;
  lastFailureCategory?: string | null;
  isFirstTurnAbort?: boolean;
  lastSessionStatus?: string | null;
}

function normalizeRole(role?: string | null): string {
  return String(role ?? "").trim().toUpperCase();
}

function normalizeTaskId(taskId: string): string {
  return taskId.replace(/\.md$/i, "").trim();
}

function reportIdOf(report: LedgerReportRecord): string {
  return String(report.report_id ?? report.filename ?? "").replace(/\.md$/i, "");
}

function taskParentNorm(task: LedgerTaskRecord): string {
  const raw = String(task.parent ?? "").trim();
  if (!raw) return "";
  return raw.replace(/\.md$/i, "");
}

function isAdminMainlineTask(task: LedgerTaskRecord): boolean {
  return /-ADMIN-to-PM/i.test(task.filename ?? "");
}

function findAdminRootForWorker(
  worker: LedgerTaskRecord,
  tasks: LedgerTaskRecord[],
): LedgerTaskRecord | null {
  const byId = new Map<string, LedgerTaskRecord>();
  for (const t of tasks) {
    byId.set(normalizeTaskId(t.task_id), t);
  }
  let cur: LedgerTaskRecord | undefined = worker;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.task_id)) {
    seen.add(cur.task_id);
    if (isAdminMainlineTask(cur)) return cur;
    const parentId = taskParentNorm(cur);
    cur = parentId ? byId.get(normalizeTaskId(parentId)) : undefined;
  }
  const threadKey = String(worker.thread_key ?? "").trim();
  if (threadKey) {
    const hit = findAdminRootTask(tasks, { threadKey });
    if (hit) return hit;
  }
  return null;
}

function adminRootArchived(
  worker: LedgerTaskRecord,
  tasks: LedgerTaskRecord[],
): boolean {
  const root = findAdminRootForWorker(worker, tasks);
  if (!root) return false;
  return resolveTaskCurrentBucket(root) === "archive";
}

/** Root in done/review awaiting ADMIN — suppress stale downstream failed hints. */
function adminRootAwaitingAdmin(
  worker: LedgerTaskRecord,
  tasks: LedgerTaskRecord[],
): boolean {
  const root = findAdminRootForWorker(worker, tasks);
  if (!root) return false;
  const bucket = resolveTaskCurrentBucket(root);
  return bucket === "done" || bucket === "review";
}

function pmSummaryDoneForWorker(
  worker: LedgerTaskRecord,
  tasks: LedgerTaskRecord[],
  reports: LedgerReportRecord[],
): LedgerReportRecord | null {
  const root = findAdminRootForWorker(worker, tasks);
  if (!root) return null;
  const rootId = normalizeTaskId(root.task_id);
  for (const report of reports) {
    if (isPmAdminFinalSummaryReport(rootId, report)) {
      return report;
    }
  }
  return null;
}

function isActiveBucket(task: LedgerTaskRecord): boolean {
  return isWorkerReceiptWaitingBucket(resolveTaskCurrentBucket(task));
}

function reportReferencesTask(
  report: LedgerReportRecord,
  taskId: string,
): boolean {
  const norm = normalizeTaskId(taskId);
  const refs = new Set<string>();
  if (report.task_id) refs.add(normalizeTaskId(report.task_id));
  if (report.parent_task_id) refs.add(normalizeTaskId(report.parent_task_id));
  for (const id of report.linked_task_ids ?? []) {
    refs.add(normalizeTaskId(id));
  }
  for (const id of report.references ?? []) {
    if (typeof id === "string") refs.add(normalizeTaskId(id));
  }
  for (const id of refs) {
    if (taskIdMatchesPrefix(id, norm) || taskIdMatchesPrefix(norm, id)) {
      return true;
    }
  }
  return false;
}

function reportRecencyKey(report: LedgerReportRecord): number {
  const name = String(report.filename ?? report.report_id ?? "");
  const m = name.match(/\d{8}-(\d{3})/);
  if (m) return Number(m[1]);
  const ts = Date.parse(String(report.updated_at ?? report.created_at ?? ""));
  return Number.isFinite(ts) ? ts : 0;
}

function compareWorkerReports(
  a: LedgerReportRecord,
  b: LedgerReportRecord,
): number {
  const ta = Date.parse(String(a.updated_at ?? a.created_at ?? "")) || 0;
  const tb = Date.parse(String(b.updated_at ?? b.created_at ?? "")) || 0;
  if (tb !== ta) return tb - ta;
  const ka = reportRecencyKey(a);
  const kb = reportRecencyKey(b);
  if (kb !== ka) return kb - ka;
  return String(b.filename ?? b.report_id ?? "").localeCompare(
    String(a.filename ?? a.report_id ?? ""),
  );
}

function workerReportsForTask(
  reports: LedgerReportRecord[],
  role: string,
  taskId: string,
): LedgerReportRecord[] {
  return reports
    .filter(
      (r) =>
        normalizeRole(r.sender) === role &&
        normalizeRole(r.recipient) === "PM" &&
        isWorkerReportToPm(r.filename, r.sender, r.recipient) &&
        reportReferencesTask(r, taskId),
    )
    .sort(compareWorkerReports);
}

function latestWorkerReportStatus(
  reports: LedgerReportRecord[],
  role: string,
  taskId: string,
): { report: LedgerReportRecord | null; status: string } {
  const latest = workerReportsForTask(reports, role, taskId)[0] ?? null;
  if (!latest) return { report: null, status: "" };
  return {
    report: latest,
    status: String(latest.status ?? "").toLowerCase(),
  };
}

function findWorkerTasks(
  tasks: LedgerTaskRecord[],
  role: string,
): LedgerTaskRecord[] {
  return tasks.filter(
    (t) =>
      isPmToWorkerDispatch(t.sender, t.recipient, t.filename) &&
      normalizeRole(t.recipient) === role,
  );
}

function pickFocusWorkerTask(
  tasks: LedgerTaskRecord[],
  role: string,
  focusTaskId?: string | null,
): LedgerTaskRecord | null {
  const workers = findWorkerTasks(tasks, role);
  if (!workers.length) return null;
  if (focusTaskId) {
    const norm = normalizeTaskId(focusTaskId);
    const hit = workers.find((t) => taskIdMatchesPrefix(t.task_id, norm));
    if (hit) return hit;
  }
  return workers.find((t) => isActiveBucket(t)) ?? workers[0] ?? null;
}

function waitingPhaseForRole(role: string): WorkerReceiptWaitingPhase {
  return role === "QA" ? "waiting_qa_receipt" : "waiting_worker_receipt";
}

function cleared(
  role: string | null,
  workerTaskId: string | null,
  reason: string,
  extras?: {
    receiptReportId?: string | null;
    threadKey?: string | null;
    queueState?: SessionReceiptQueueState;
    reasonCode?: string | null;
    lastSessionId?: string | null;
  },
): WorkerReceiptWaitingResult {
  return {
    phase: "cleared",
    queueState: extras?.queueState ?? "none",
    shouldShowWaiting: false,
    shouldClearGuard: true,
    role,
    workerTaskId,
    receiptReportId: extras?.receiptReportId ?? null,
    threadKey: extras?.threadKey ?? null,
    reason,
    reasonCode: extras?.reasonCode ?? reason,
    lastSessionId: extras?.lastSessionId ?? null,
    suggestedAction: extras?.queueState === "none" ? null : "review_report",
  };
}

function failed(
  role: string,
  workerTaskId: string,
  reason: string,
  extras?: {
    receiptReportId?: string | null;
    threadKey?: string | null;
    reasonCode?: string | null;
    lastSessionId?: string | null;
  },
): WorkerReceiptWaitingResult {
  return {
    phase: "worker_receipt_failed",
    queueState: "failed",
    shouldShowWaiting: false,
    shouldClearGuard: true,
    role,
    workerTaskId,
    receiptReportId: extras?.receiptReportId ?? null,
    threadKey: extras?.threadKey ?? null,
    reason,
    reasonCode: extras?.reasonCode ?? reason,
    lastSessionId: extras?.lastSessionId ?? null,
    suggestedAction: null,
  };
}

function needsPmDecision(
  role: string,
  workerTaskId: string,
  reason: string,
  extras?: {
    receiptReportId?: string | null;
    threadKey?: string | null;
  },
): WorkerReceiptWaitingResult {
  return {
    phase: "worker_report_needs_pm",
    queueState: "none",
    shouldShowWaiting: false,
    shouldClearGuard: true,
    role,
    workerTaskId,
    receiptReportId: extras?.receiptReportId ?? null,
    threadKey: extras?.threadKey ?? null,
    reason,
    reasonCode: reason,
    lastSessionId: null,
    suggestedAction: "review_report",
  };
}

function recoverable(
  role: string,
  workerTaskId: string,
  reason: string,
  extras?: {
    threadKey?: string | null;
    reasonCode?: string | null;
    lastSessionId?: string | null;
  },
): WorkerReceiptWaitingResult {
  return {
    phase: "session_recoverable",
    queueState: "recoverable",
    shouldShowWaiting: true,
    shouldClearGuard: false,
    role,
    workerTaskId,
    receiptReportId: null,
    threadKey: extras?.threadKey ?? null,
    reason,
    reasonCode: extras?.reasonCode ?? "session_unsettled",
    lastSessionId: extras?.lastSessionId ?? null,
    suggestedAction: "recover",
  };
}

function running(
  role: string,
  workerTaskId: string,
  reason: string,
  extras?: {
    threadKey?: string | null;
    lastSessionId?: string | null;
  },
): WorkerReceiptWaitingResult {
  return {
    phase: "session_running",
    queueState: "running",
    shouldShowWaiting: false,
    shouldClearGuard: false,
    role,
    workerTaskId,
    receiptReportId: null,
    threadKey: extras?.threadKey ?? null,
    reason,
    reasonCode: "agent_running",
    lastSessionId: extras?.lastSessionId ?? null,
    suggestedAction: "wait",
  };
}

/**
 * Six AND conditions to show waiting; any OR clear rule stops waiting.
 * Latest worker REPORT per task_id+role wins (failed only if latest is terminal fail).
 */
export function evaluateWorkerReceiptWaiting(
  opts: WorkerReceiptWaitingOpts,
): WorkerReceiptWaitingResult {
  const role = normalizeRole(opts.targetRole);
  if (!role || !["QA", "DEV", "OPS"].includes(role)) {
    return {
      phase: "none",
      queueState: "none",
      shouldShowWaiting: false,
      shouldClearGuard: false,
      role: null,
      workerTaskId: null,
      receiptReportId: null,
      threadKey: null,
      reason: "no_worker_role",
      reasonCode: "no_worker_role",
      lastSessionId: null,
      suggestedAction: null,
    };
  }

  const worker = pickFocusWorkerTask(opts.tasks, role, opts.focusTaskId);
  if (!worker) {
    return cleared(role, null, "no_pm_worker_task");
  }

  const taskId = worker.task_id;
  const threadKey = String(worker.thread_key ?? "").trim() || null;

  if (!taskId) {
    return cleared(role, null, "missing_task_id");
  }

  if (adminRootArchived(worker, opts.tasks)) {
    return cleared(role, taskId, "admin_root_archived", { threadKey });
  }

  if (adminRootAwaitingAdmin(worker, opts.tasks)) {
    return cleared(role, taskId, "admin_root_awaiting_admin", { threadKey });
  }

  const pmSummary = pmSummaryDoneForWorker(worker, opts.tasks, opts.reports);
  if (pmSummary) {
    return cleared(role, taskId, "pm_summary_done", {
      threadKey,
      receiptReportId: reportIdOf(pmSummary),
    });
  }

  if (opts.hasReportOnDisk) {
    return cleared(role, taskId, "worker_report_on_disk", { threadKey });
  }

  const { report: latestReport, status: latestStatus } = latestWorkerReportStatus(
    opts.reports,
    role,
    taskId,
  );
  const latestReportId = latestReport ? reportIdOf(latestReport) : null;

  if (latestReport && PASS_REPORT_STATUSES.has(latestStatus)) {
    return cleared(role, taskId, "worker_report_done", {
      threadKey,
      receiptReportId: latestReportId,
    });
  }

  if (latestReport && FAIL_REPORT_STATUSES.has(latestStatus)) {
    return needsPmDecision(role, taskId, `worker_report_${latestStatus}`, {
      threadKey,
      receiptReportId: latestReportId,
    });
  }

  const displayStatus = String(worker.display_status ?? "").toLowerCase();
  if (SKIP_DISPLAY_STATUSES.has(displayStatus)) {
    return cleared(role, taskId, `display_status:${displayStatus}`, { threadKey });
  }
  const recoverableBeforeDisplay =
    opts.recoverable === true ||
    opts.sessionUnsettled === true ||
    (opts.sessionFailed === true &&
      isRecoverableSessionFailure(
        opts.lastFailureCode,
        opts.lastSessionStatus,
        {
          failureCategory: opts.lastFailureCategory,
          isFirstTurnAbort: opts.isFirstTurnAbort,
        },
      ));
  if (PM_DECISION_DISPLAY_STATUSES.has(displayStatus) && !recoverableBeforeDisplay) {
    return failed(role, taskId, `display_status:${displayStatus}`, { threadKey });
  }

  if (!isActiveBucket(worker)) {
    return cleared(role, taskId, `bucket:${resolveTaskCurrentBucket(worker) || "unknown"}`, {
      threadKey,
    });
  }

  const nudgeCount = opts.nudgeCount ?? 0;
  const lastSessionId = opts.lastSessionId ?? null;
  const sessionUnsettled = opts.sessionUnsettled === true;
  const recoverableFlag =
    opts.recoverable === true ||
    sessionUnsettled ||
    (opts.sessionFailed === true &&
      isRecoverableSessionFailure(
        opts.lastFailureCode,
        opts.lastSessionStatus,
        {
          failureCategory: opts.lastFailureCategory,
          isFirstTurnAbort: opts.isFirstTurnAbort,
        },
      ));

  if (opts.agentRunning) {
    return running(role, taskId, "agent_running", { threadKey, lastSessionId });
  }

  if (recoverableFlag && !latestReport) {
    return recoverable(role, taskId, "session_unsettled", {
      threadKey,
      reasonCode: opts.lastFailureCode ?? "session_unsettled",
      lastSessionId,
    });
  }

  if (opts.workerFailed && !recoverableFlag) {
    return failed(role, taskId, "worker_failed_mark", {
      threadKey,
      receiptReportId: latestReportId,
      reasonCode: "worker_failed_mark",
      lastSessionId,
    });
  }

  if (opts.sessionFailed && !recoverableFlag) {
    return failed(role, taskId, "session_failed", {
      threadKey,
      receiptReportId: latestReportId,
      reasonCode: opts.lastFailureCode ?? "session_failed",
      lastSessionId,
    });
  }

  if (nudgeCount >= MAX_DOWNSTREAM_AUTO_NUDGES) {
    return failed(role, taskId, "max_nudges_exceeded", {
      threadKey,
      reasonCode: "max_nudges_exceeded",
      lastSessionId,
    });
  }

  return {
    phase: waitingPhaseForRole(role),
    queueState: "waiting_report",
    shouldShowWaiting: true,
    shouldClearGuard: false,
    role,
    workerTaskId: taskId,
    receiptReportId: null,
    threadKey,
    reason: "pending_worker_report",
    reasonCode: "waiting_report",
    lastSessionId,
    suggestedAction: "wait",
  };
}

/** True when any open PM→worker task in role still warrants waiting display. */
export function anyWorkerReceiptStillWaiting(
  tasks: LedgerTaskRecord[],
  reports: LedgerReportRecord[],
  role: string,
  extras?: Omit<WorkerReceiptWaitingOpts, "tasks" | "reports" | "targetRole">,
): boolean {
  const workers = findWorkerTasks(tasks, role).filter((t) => isActiveBucket(t));
  for (const w of workers) {
    const ev = evaluateWorkerReceiptWaiting({
      tasks,
      reports,
      targetRole: role,
      focusTaskId: w.task_id,
      ...extras,
    });
    if (ev.shouldShowWaiting) return true;
  }
  return false;
}

/** Pick queue-visible receipt state across active worker tasks (recoverable beats waiting beats failed). */
export function pickQueueWorkerReceiptState(
  tasks: LedgerTaskRecord[],
  reports: LedgerReportRecord[],
  roles: string[],
  evalOne: (
    role: string,
    taskId: string,
  ) => Omit<
    WorkerReceiptWaitingOpts,
    "tasks" | "reports" | "targetRole" | "focusTaskId"
  >,
): WorkerReceiptWaitingResult {
  let waiting: WorkerReceiptWaitingResult | null = null;
  let recoverable: WorkerReceiptWaitingResult | null = null;
  let failed: WorkerReceiptWaitingResult | null = null;

  for (const roleRaw of roles) {
    const role = normalizeRole(roleRaw);
    if (!role) continue;
    const workers = findWorkerTasks(tasks, role).filter((t) => isActiveBucket(t));
    for (const w of workers) {
      const ev = evaluateWorkerReceiptWaiting({
        tasks,
        reports,
        targetRole: role,
        focusTaskId: w.task_id,
        ...evalOne(role, w.task_id),
      });
      if (ev.phase === "session_recoverable" && ev.workerTaskId && !recoverable) {
        recoverable = ev;
        continue;
      }
      if (ev.phase === "worker_receipt_failed" && ev.workerTaskId && !failed) {
        failed = ev;
        continue;
      }
      if (ev.shouldShowWaiting && !waiting) {
        waiting = ev;
      }
    }
  }

  return (
    recoverable ??
    waiting ??
    failed ?? {
      phase: "none",
      queueState: "none",
      shouldShowWaiting: false,
      shouldClearGuard: false,
      role: null,
      workerTaskId: null,
      receiptReportId: null,
      threadKey: null,
      reason: "no_pending_receipt",
      reasonCode: "no_pending_receipt",
      lastSessionId: null,
      suggestedAction: null,
    }
  );
}
