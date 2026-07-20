/**
 * Report workflow chain helpers — mirrors panel/index.html rpBuildThreadChainNodes +
 * rpAssignReportsToTaskTree (keep in sync when changing rules).
 */

import {
  bareThreadKey,
  isAdminMainlineTask,
  taskIdFromFilename,
  taskParentId,
  type TaskLike,
  type ThreadRow,
} from "./panel-task-thread-visibility.ts";
import {
  reportFileKey,
  reportIdFromFilename,
  reportLinkedTaskIdPrefixes,
  resolveReportsFromLedgerIds,
} from "./panel-report-aggregation.ts";

export type ReportLike = {
  filename?: string;
  task_id?: string;
  parent_task_id?: string;
  linked_task_ids?: string[];
  parent?: string;
  references?: string | string[];
};

export type TaskTreeNode = {
  taskId: string;
  depth: number;
  stub?: boolean;
};

export function buildThreadChainOrderedTaskIds(
  ledgerRow: ThreadRow,
  taskList: TaskLike[],
): string[] {
  const rootId = taskIdFromFilename(ledgerRow.root_task_id ?? "") || String(ledgerRow.root_task_id ?? "");
  const threadKey = String(ledgerRow.thread_key ?? "").trim();
  const bare = bareThreadKey(threadKey);

  const byId: Record<string, TaskLike> = {};
  for (const t of taskList) {
    const id = taskIdFromFilename(t.filename ?? "");
    if (id) byId[id] = t;
  }

  const ordered: string[] = [];
  const seen = new Set<string>();

  for (const tid of ledgerRow.task_ids ?? []) {
    const raw = String(tid);
    const m = raw.match(/^(TASK-\d{8}-\d{3,})/i);
    const id = m ? m[1]!.toUpperCase() : taskIdFromFilename(raw) || raw;
    if (!id || seen.has(id)) continue;
    const t = byId[id];
    if (id !== rootId && t && isAdminMainlineTask(t.filename ?? "")) continue;
    seen.add(id);
    ordered.push(id);
  }

  for (const t of taskList) {
    const id = taskIdFromFilename(t.filename ?? "");
    if (!id || seen.has(id) || id === rootId) continue;
    if (isAdminMainlineTask(t.filename ?? "")) continue;
    const parent = taskParentId(t);
    const tk = bareThreadKey(String(t.thread_key ?? "").trim());
    const sameThread = Boolean(bare && tk && tk === bare);
    if (parent === rootId || sameThread) {
      seen.add(id);
      ordered.push(id);
    }
  }

  if (rootId && !seen.has(rootId)) ordered.unshift(rootId);
  return ordered;
}

export function reportPrimaryTaskIdForWorkflow(
  rep: ReportLike,
  rootId: string,
): string {
  if (rep.parent_task_id) {
    const p = taskIdFromFilename(String(rep.parent_task_id)) || String(rep.parent_task_id);
    if (p) return p;
  }
  const fn = String(rep.filename ?? "");
  const route = fn.match(/(?:TASK|REPORT)-\d{8}-\d{3}-([A-Za-z0-9]+)-to-([A-Za-z0-9]+)/i);
  if (route && route[1]!.toUpperCase() === "PM" && route[2]!.toUpperCase() === "ADMIN") {
    return rootId || taskIdFromFilename(String(rep.task_id ?? "")) || "";
  }
  const linked = new Set<string>();
  if (Array.isArray(rep.linked_task_ids)) {
    for (const id of rep.linked_task_ids) {
      const s = taskIdFromFilename(String(id)) || String(id);
      if (s) linked.add(s);
    }
  }
  for (const key of ["task_id", "parent", "references"] as const) {
    const v = rep[key];
    const s = taskIdFromFilename(String(v ?? "")) || "";
    if (s) linked.add(s);
  }
  if (route) {
    const sender = route[1]!.toUpperCase();
    const recipient = route[2]!.toUpperCase();
    if (/^(DEV|OPS|QA)$/.test(sender) && recipient === "PM") {
      const child = [...linked].find((id) => id && id !== rootId);
      if (child) return child;
    }
  }
  if (rootId && linked.has(rootId)) return rootId;
  return [...linked][0] || "";
}

export function assignReportsToWorkflowTree(
  reports: ReportLike[],
  taskTree: TaskTreeNode[],
  rootId: string,
): { byTask: Map<string, ReportLike[]>; orphans: ReportLike[] } {
  const treeIds = new Set(taskTree.map((n) => n.taskId));
  const byTask = new Map<string, ReportLike[]>(taskTree.map((n) => [n.taskId, []]));
  const orphans: ReportLike[] = [];

  for (const rep of reports) {
    const primary = reportPrimaryTaskIdForWorkflow(rep, rootId);
    if (primary && treeIds.has(primary) && byTask.has(primary)) {
      byTask.get(primary)!.push(rep);
    } else if (primary) {
      orphans.push(rep);
    } else {
      orphans.push(rep);
    }
  }

  return { byTask, orphans };
}

export function workflowReportNodeCount(
  reports: ReportLike[],
  taskTree: TaskTreeNode[],
  rootId: string,
): number {
  const assigned = assignReportsToWorkflowTree(reports, taskTree, rootId);
  const treeIds = new Set(taskTree.map((n) => n.taskId));
  let count = assigned.orphans.length;
  for (const [taskId, list] of assigned.byTask) {
    if (treeIds.has(taskId)) count += list.length;
  }
  return count;
}

export function isReportStatusDone(rep: ReportLike | null | undefined): boolean {
  const st = String((rep as { status?: string })?.status ?? "").trim().toLowerCase();
  return st === "done" || /pass|ok|complete|finished|success/.test(st);
}

export function allReportsDone(reports: ReportLike[]): boolean {
  return reports.length > 0 && reports.every((r) => isReportStatusDone(r));
}

/**
 * Thread group reports = ledger report_ids ∪ visibleReports for this thread
 * (fixes narrow whitelist dropping PM→ADMIN finals like REPORT-003).
 */
export function mergeThreadChainReports<T extends ReportLike>(
  ledgerRow: ThreadRow,
  visibleReports: T[],
  fullPool: T[],
  orderedTaskIds: string[],
): T[] {
  const rootId = taskIdFromFilename(ledgerRow.root_task_id ?? "") || "";
  const treeIdSet = new Set(orderedTaskIds);
  const seen = new Set<string>();
  const out: T[] = [];
  const push = (rep: T) => {
    const key = reportFileKey(rep.filename ?? "");
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(rep);
  };

  for (const rep of resolveReportsFromLedgerIds(ledgerRow.report_ids ?? [], fullPool)) {
    push(rep);
  }

  for (const rep of visibleReports) {
    const primary = reportPrimaryTaskIdForWorkflow(rep, rootId);
    if (!primary) {
      push(rep);
      continue;
    }
    if (!treeIdSet.size || treeIdSet.has(primary)) push(rep);
  }

  return out;
}

export type ReportArchiveTab = "active" | "archive" | "all";

export function shouldShowReportThreadInActiveTab(opts: {
  ledgerRow: ThreadRow;
  visibleReports: ReportLike[];
  membersInPool: TaskLike[];
  isDetached?: boolean;
  isRootSealed?: boolean;
  hasOpenMembers?: boolean;
}): boolean {
  if (opts.isDetached) return false;
  if (opts.isRootSealed) return false;
  const reportCount = opts.visibleReports.length;
  const hasOpen = opts.hasOpenMembers ?? false;
  if (reportCount <= 0 && !hasOpen) return false;
  if (!hasOpen && opts.membersInPool.length === 0) {
    if (reportCount > 0 && allReportsDone(opts.visibleReports)) return false;
    return false;
  }
  if (!hasOpen && opts.membersInPool.length > 0) return false;
  return true;
}

export function legacyReportGroupMatchesArchiveTab(
  tab: ReportArchiveTab,
  group: {
    fallbackId?: string;
    reports?: ReportLike[];
    task?: TaskLike | null;
  },
  opts?: {
    rootTaskSettled?: boolean;
    rootSealed?: boolean;
    ledgerHasOpenMembers?: boolean;
  },
): boolean {
  if (tab === "all") return true;
  const reps = group.reports ?? [];
  const allDone = allReportsDone(reps);
  const settled = opts?.rootTaskSettled ?? false;
  const sealed = opts?.rootSealed ?? false;
  const ledgerOpen = opts?.ledgerHasOpenMembers ?? false;

  if (tab === "archive") {
    if (reps.length === 0) return false;
    if (allDone || settled || sealed) return true;
    if (!ledgerOpen && reps.length > 0) return true;
    return reps.length > 0;
  }

  if (settled || sealed) return false;
  if (allDone && !ledgerOpen) return false;
  return true;
}
