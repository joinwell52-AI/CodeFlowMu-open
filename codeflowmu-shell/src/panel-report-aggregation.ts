/**
 * Report enrichment + ledger/report membership helpers (tests + web-panel enrichment).
 * Panel UI filters reports by thread member ids + ledger fallback — not computeRelatedTaskIds.
 */

import {
  reportBelongsToLedgerTask,
  type LedgerReportRecord,
  type LedgerTaskRecord,
} from "@codeflowmu/runtime";

import {
  bareThreadKey,
  taskIdFromFilename,
  taskParentId,
  type TaskLike,
  type ThreadRow,
} from "./panel-task-thread-visibility.ts";

export type ReportLike = {
  filename?: string;
  task_id?: string;
  linked_task_ids?: string[];
  parent?: string;
  references?: string | string[];
  subject_id?: string;
  thread_key?: string;
};

const TASK_ID_LONG_RE = /TASK-\d{8}-\d{3,}(?:-[A-Z0-9]+(?:-to-[A-Z0-9]+(?:\.[A-Za-z0-9]+)?)?)?/gi;
const TASK_ID_SHORT_RE = /TASK-\d{8}-\d{3,}/gi;

function scanTaskIdsIntoSet(text: unknown, ids: Set<string>): void {
  const s = String(text ?? "");
  for (const m of s.matchAll(TASK_ID_LONG_RE)) ids.add(m[0]);
  for (const m of s.matchAll(TASK_ID_SHORT_RE)) {
    const short = m[0].match(/^(TASK-\d{8}-\d{3,})/i);
    if (short?.[1]) ids.add(short[1].toUpperCase());
  }
}

/** Mirror panel inline `reportLinkedTaskIds` → normalized TASK-YYYYMMDD-NNN prefixes. */
export function reportLinkedTaskIdPrefixes(rep: ReportLike | null | undefined): string[] {
  if (!rep) return [];
  const ids = new Set<string>();
  if (Array.isArray(rep.linked_task_ids)) {
    for (const id of rep.linked_task_ids) scanTaskIdsIntoSet(id, ids);
  }
  for (const v of [rep.task_id, rep.parent, rep.references, rep.subject_id]) {
    if (Array.isArray(v)) {
      for (const item of v) scanTaskIdsIntoSet(item, ids);
    } else {
      scanTaskIdsIntoSet(v, ids);
    }
  }
  return [...ids].map((id) => taskIdFromFilename(id) || id).filter(Boolean);
}

export type ComputeRelatedTaskIdsOpts = {
  ledgerRow?: ThreadRow | null;
  rootThreadKey?: string;
};

/**
 * When viewing a root ADMIN task, collect all task ids whose reports belong on the same page.
 */
export function computeRelatedTaskIds(
  rootTaskId: string,
  taskList: TaskLike[],
  reports: ReportLike[],
  opts: ComputeRelatedTaskIdsOpts = {},
): Set<string> {
  const related = new Set<string>();
  const rootId = taskIdFromFilename(rootTaskId) || rootTaskId;
  if (!rootId) return related;

  related.add(rootId);

  const rootTask =
    taskList.find((t) => taskIdFromFilename(t.filename ?? "") === rootId) ?? null;
  const ledger = opts.ledgerRow ?? null;
  const threadKey = String(
    opts.rootThreadKey ?? rootTask?.thread_key ?? ledger?.thread_key ?? "",
  ).trim();
  const bareKey = bareThreadKey(threadKey);

  for (const tid of ledger?.task_ids ?? []) {
    const id = taskIdFromFilename(String(tid)) || String(tid).trim();
    if (id) related.add(id);
  }

  for (const t of taskList) {
    const id = taskIdFromFilename(t.filename ?? "");
    if (!id || id === rootId) continue;
    if (bareKey) {
      const tk = bareThreadKey(String(t.thread_key ?? "").trim());
      if (tk && tk === bareKey) related.add(id);
    }
    if (taskParentId(t) === rootId) related.add(id);
  }

  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const t of taskList) {
      const id = taskIdFromFilename(t.filename ?? "");
      if (!id || related.has(id)) continue;
      const parent = taskParentId(t);
      if (parent && related.has(parent)) {
        related.add(id);
        expanded = true;
      }
    }
  }

  const poolReports = reports ?? [];
  let reportExpanded = true;
  while (reportExpanded) {
    reportExpanded = false;
    for (const rep of poolReports) {
      const linked = reportLinkedTaskIdPrefixes(rep);
      const repBare = bareThreadKey(String(rep.thread_key ?? "").trim());
      const threadHit = Boolean(bareKey && repBare && repBare === bareKey);
      const linksRelated = linked.some((id) => related.has(id));
      if (!threadHit && !linksRelated) continue;
      for (const id of linked) {
        if (id && !related.has(id)) {
          related.add(id);
          reportExpanded = true;
        }
      }
    }
  }

  return related;
}

/** Whether a report belongs to the root thread's related task set. */
export function reportBelongsToRelatedThread(
  report: ReportLike,
  relatedIds: Set<string>,
  rootThreadKey?: string,
): boolean {
  const linked = reportLinkedTaskIdPrefixes(report);
  if (linked.some((id) => relatedIds.has(id))) return true;
  const bareRoot = bareThreadKey(String(rootThreadKey ?? "").trim());
  if (!bareRoot) return false;
  const repBare = bareThreadKey(String(report.thread_key ?? "").trim());
  return Boolean(repBare && repBare === bareRoot);
}

/** Resolve ledger row for a root task id (merged by root). */
export function findLedgerRowForRoot(
  rootTaskId: string,
  ledgerRows: ThreadRow[],
): ThreadRow | null {
  const rootId = taskIdFromFilename(rootTaskId) || rootTaskId;
  if (!rootId) return null;
  for (const row of ledgerRows ?? []) {
    if (taskIdFromFilename(row.root_task_id ?? "") === rootId) return row;
    if ((row.task_ids ?? []).some((tid) => taskIdFromFilename(String(tid)) === rootId)) {
      return row;
    }
  }
  return null;
}

export function reportFileKey(fn: string): string {
  return String(fn ?? "").replace(/\.md$/i, "");
}

export function reportIdFromFilename(fn: string): string {
  const m = String(fn ?? "").match(/^(REPORT-\d{8}-\d{3,})/i);
  return m ? m[1]!.toUpperCase() : "";
}

function addStructuredTaskIdFields(ids: Set<string>, rep: Record<string, unknown>): void {
  if (Array.isArray(rep.linked_task_ids)) {
    for (const id of rep.linked_task_ids) scanTaskIdsIntoSet(id, ids);
  }
  for (const key of ["task_id", "parent", "parent_task_id", "references", "subject_id"]) {
    const v = rep[key];
    if (Array.isArray(v)) {
      for (const item of v) scanTaskIdsIntoSet(item, ids);
    } else {
      scanTaskIdsIntoSet(v, ids);
    }
  }
}

/** Structured TASK ids only — ledger + frontmatter; never report body. */
export function structuredLinkedTaskIdsFromReport(
  rep: Record<string, unknown>,
  fm?: Record<string, unknown> | null,
): string[] {
  const ids = new Set<string>();
  addStructuredTaskIdFields(ids, rep);
  if (fm) addStructuredTaskIdFields(ids, fm);
  return [...ids];
}

/** Body TASK-* mentions for debug display; must not feed grouping linked_task_ids. */
export function inferredBodyTaskMentionsFromMarkdown(raw: string): string[] {
  const fmClose = raw.indexOf("\n---", 3);
  const body = fmClose >= 0 ? raw.slice(fmClose + 4) : raw;
  const ids = new Set<string>();
  scanTaskIdsIntoSet(body, ids);
  return [...ids];
}

/**
 * Resolve which ledger collaboration thread owns a report.
 * Priority: report_ids exact match (full scan) → task_ids/root → thread_key.
 */
export function ledgerThreadForReport(
  rep: ReportLike & { filename?: string; parent_task_id?: string },
  ledgerRows: ThreadRow[],
): ThreadRow | null {
  const rows = ledgerRows ?? [];
  if (!rows.length || !rep) return null;

  const rf = reportFileKey(rep.filename ?? "");
  const rid = reportIdFromFilename(rep.filename ?? "");

  for (const row of rows) {
    if (!row || row.thread_key === "_orphan_") continue;
    const repKeys = (row.report_ids ?? []).map((x) => {
      const k = reportFileKey(String(x));
      return k || String(x);
    });
    if (rf && repKeys.some((k) => k === rf || (rid && reportIdFromFilename(k) === rid))) {
      return row;
    }
  }

  const linkedShort = new Set(reportLinkedTaskIdPrefixes(rep));

  for (const row of rows) {
    if (!row || row.thread_key === "_orphan_") continue;
    const taskShorts = (row.task_ids ?? []).map((t) => {
      const s = String(t);
      return /^TASK-\d{8}-\d{3,}$/i.test(s)
        ? s.toUpperCase()
        : taskIdFromFilename(s) || s;
    });
    for (const id of linkedShort) {
      if (taskShorts.includes(id)) return row;
    }
    const root = taskIdFromFilename(row.root_task_id ?? "");
    if (root && linkedShort.has(root)) return row;
  }

  const repBare = bareThreadKey(String(rep.thread_key ?? "").trim());
  const fn = String(rep.filename ?? "");
  const route = fn.match(/(?:TASK|REPORT)-\d{8}-\d{3}-([A-Za-z0-9]+)-to-([A-Za-z0-9]+)/i);
  if (route && route[1]!.toUpperCase() === "PM" && route[2]!.toUpperCase() === "ADMIN") {
    const tid =
      taskIdFromFilename(String(rep.task_id ?? "")) ||
      taskIdFromFilename(String(rep.parent_task_id ?? ""));
    if (tid) {
      for (const row of rows) {
        if (!row || row.thread_key === "_orphan_") continue;
        if (taskIdFromFilename(row.root_task_id ?? "") === tid) return row;
      }
    }
  }
  if (repBare) {
    for (const row of rows) {
      if (!row || row.thread_key === "_orphan_") continue;
      const rowBare = bareThreadKey(String(row.thread_key ?? "").trim());
      if (rowBare && rowBare === repBare) return row;
    }
  }

  return null;
}

/** Resolve ledger report_ids → report rows from pool (filename or report_id match). */
export function resolveReportsFromLedgerIds<T extends ReportLike>(
  reportIds: string[],
  pool: T[],
): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const raw of reportIds ?? []) {
    const key = reportFileKey(String(raw));
    const rid = reportIdFromFilename(String(raw));
    const hit =
      pool.find((r) => reportFileKey(r.filename ?? "") === key) ??
      pool.find((r) => reportIdFromFilename(r.filename ?? "") === rid) ??
      pool.find(
        (r) =>
          String((r as { report_id?: string }).report_id ?? "") === rid ||
          String((r as { report_id?: string }).report_id ?? "") === key,
      );
    if (!hit) continue;
    const dedupe = reportFileKey(hit.filename ?? "");
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(hit);
  }
  return out;
}

export type TaskReportScopes<T extends ReportLike = ReportLike> = {
  direct_reports: T[];
  thread_reports: T[];
};

/**
 * Dual-scope report aggregation for ADMIN mainline task detail / report board.
 *
 * - direct_reports: main-task direct reports (reportBelongsToLedgerTask)
 * - thread_reports: full collaboration chain including worker child-task REPORTs
 */
export function aggregateTaskReportScopes<T extends ReportLike>(
  rootTaskId: string,
  tasks: TaskLike[],
  reports: T[],
  opts: {
    ledgerRow?: ThreadRow | null;
    ledgerRows?: ThreadRow[];
  } = {},
): TaskReportScopes<T> {
  const rootId = taskIdFromFilename(rootTaskId) || rootTaskId;
  const ledgerTasks = tasks as unknown as LedgerTaskRecord[];

  const direct_reports = reports.filter((r) =>
    reportBelongsToLedgerTask(
      r as unknown as LedgerReportRecord,
      rootId,
      ledgerTasks,
    ),
  );

  const ledgerRow =
    opts.ledgerRow ??
    findLedgerRowForRoot(rootId, opts.ledgerRows ?? []);

  let thread_reports: T[];
  if (ledgerRow?.report_ids?.length) {
    thread_reports = resolveReportsFromLedgerIds(ledgerRow.report_ids, reports);
  } else {
    const related = computeRelatedTaskIds(rootId, tasks, reports, {
      ledgerRow: ledgerRow ?? undefined,
      rootThreadKey: ledgerRow?.thread_key,
    });
    const bareKey = bareThreadKey(
      String(ledgerRow?.thread_key ?? "").trim() ||
        String(
          tasks.find((t) => taskIdFromFilename(t.filename ?? "") === rootId)
            ?.thread_key ?? "",
        ).trim(),
    );
    thread_reports = reports.filter((r) =>
      reportBelongsToRelatedThread(r, related, bareKey || undefined),
    );
  }

  if (!thread_reports.length && direct_reports.length) {
    thread_reports = [...direct_reports];
  }

  return { direct_reports, thread_reports };
}

export {
  classifyReportIntake,
  isLateOrphanIntakeReport,
  partitionReportsByIntake,
  type ReportIntakeKind,
  type ReportIntakeMeta,
} from "./panel-report-intake.ts";
