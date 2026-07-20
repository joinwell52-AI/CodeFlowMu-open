import { promises as fs } from "node:fs";
import { join } from "node:path";

import { parseMarkdownFrontmatter, strField, listField } from "./frontmatter.ts";
import { LedgerBuilder } from "./LedgerBuilder.ts";
import { resolveLedgerLayout } from "./paths.ts";
import type { LedgerReportRecord, LedgerTaskRecord, LedgerThreadRecord } from "./types.ts";

export type ComputedTaskStatus =
  | "inbox_pending"
  | "active_in_progress"
  | "active_stalled_done_report"
  | "review_pending_approval"
  | "done"
  | "archived"
  | "legacy_tasks_bucket"
  | "unknown_bucket";

export type ComputedReportStatus =
  | "authoritative_done"
  | "intermediate_in_progress"
  | "reportgate_blocked_noise"
  | "superseded"
  | "other";

export interface LedgerEntityInspection {
  id: string;
  kind: "task" | "report";
  ledger_bucket?: string;
  ledger_status?: string;
  computed_status: ComputedTaskStatus | ComputedReportStatus;
  path?: string;
  notes: string[];
}

export interface LedgerRegressionVerifyResult {
  rebuilt_at: string;
  rebuild: { tasks: number; reports: number; threads: number; viewsWritten: number };
  list_tasks_all: number;
  list_tasks_pm: number;
  list_tasks_ops: number;
  disk_active_task_files: string[];
  entities: LedgerEntityInspection[];
  findings: string[];
}

/** Thread-scoped verify result (generalized from verify_237). */
export interface LedgerThreadVerifyResult extends LedgerRegressionVerifyResult {
  task_id: string;
  thread_key: string | null;
  thread_task_ids: string[];
  thread_report_ids: string[];
}

const REGRESSION_237_TASK_PREFIXES = ["TASK-20260531-237", "TASK-20260531-001"];
const REGRESSION_237_REPORT_PREFIXES = [
  "REPORT-20260531-002",
  "REPORT-20260531-003",
  "REPORT-20260531-004",
];

function normalizeTaskPrefix(taskId: string): string {
  return taskId.replace(/\.md$/i, "").trim();
}

function taskIdMatchesPrefix(taskId: string, prefix: string): boolean {
  const norm = normalizeTaskPrefix(taskId).toUpperCase();
  const p = normalizeTaskPrefix(prefix).toUpperCase();
  return norm === p || norm.startsWith(`${p}-`) || p.startsWith(`${norm}-`);
}

function loadJsonlLines<T>(raw: string): T[] {
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

async function loadThreadsFromDisk(projectRoot: string): Promise<LedgerThreadRecord[]> {
  const layout = resolveLedgerLayout(projectRoot);
  try {
    const raw = await fs.readFile(join(layout.ledgerDir, "threads.jsonl"), "utf-8");
    return loadJsonlLines<LedgerThreadRecord>(raw);
  } catch {
    return [];
  }
}

function findThreadForTask(
  threads: LedgerThreadRecord[],
  taskPrefix: string,
): LedgerThreadRecord | null {
  const candidates = threads.filter(
    (t) =>
      (t.root_task_id && taskIdMatchesPrefix(t.root_task_id, taskPrefix)) ||
      t.task_ids.some((id) => taskIdMatchesPrefix(id, taskPrefix)),
  );
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => b.task_ids.length - a.task_ids.length)[0]!;
}

function taskInThreadScope(
  task: LedgerTaskRecord,
  thread: LedgerThreadRecord | null,
  taskPrefix: string,
): boolean {
  if (thread) {
    return thread.task_ids.some((tid) => taskIdMatchesPrefix(task.task_id, tid));
  }
  return taskIdMatchesPrefix(task.task_id, taskPrefix);
}

function reportInThreadScope(
  report: EnrichedReport,
  thread: LedgerThreadRecord | null,
  scopedTasks: LedgerTaskRecord[],
): boolean {
  if (thread?.report_ids.length) {
    const inThreadList = thread.report_ids.some(
      (rid) =>
        report.report_id === rid ||
        report.report_id.startsWith(rid) ||
        rid.startsWith(report.report_id),
    );
    if (inThreadList) return true;
  }
  return scopedTasks.some((t) => reportRelatesToTask(t, report));
}

export interface EnrichedReport extends LedgerReportRecord {
  references: string[];
  superseded_by?: string;
  fm_status: string;
}

/** When YAML frontmatter is malformed (e.g. smart quotes), scrape key fields for verify-only. */
function scrapeFrontmatterFallback(raw: string): Record<string, string> {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const block = m[1]!;
  const out: Record<string, string> = {};
  const status = block.match(/^status:\s*(\S+)/m);
  if (status) out.status = status[1]!;
  const superseded = block.match(/^superseded_by:\s*(.+)$/m);
  if (superseded) out.superseded_by = superseded[1]!.trim();
  const refs: string[] = [];
  const refSection = block.match(/^references:\s*\n((?:-\s*.+\n?)*)/m);
  if (refSection) {
    for (const line of refSection[1]!.split("\n")) {
      const item = line.match(/^-\s*(.+)$/);
      if (item) refs.push(item[1]!.trim());
    }
  }
  if (refs.length) out.references = refs.join("\n");
  return out;
}

async function enrichReportsFromDisk(
  reports: LedgerReportRecord[],
): Promise<EnrichedReport[]> {
  const out: EnrichedReport[] = [];
  for (const r of reports) {
    let fm: Record<string, unknown> = {};
    let raw = "";
    try {
      raw = await fs.readFile(r.path, "utf-8");
      fm = parseMarkdownFrontmatter(raw);
    } catch {
      /* keep ledger row */
    }
    const fallback = Object.keys(fm).length === 0 && raw ? scrapeFrontmatterFallback(raw) : {};
    const fmStatus =
      strField(fm, "status") || fallback.status || r.status;
    const superseded =
      strField(fm, "superseded_by") || fallback.superseded_by || undefined;
    let references = listField(fm, "references");
    if (!references.length && fallback.references) {
      references = fallback.references.split("\n").filter(Boolean);
    }
    out.push({
      ...r,
      status: fmStatus || r.status,
      task_id: strField(fm, "task_id") || r.task_id,
      references,
      superseded_by: superseded,
      fm_status: fmStatus || "unknown",
    });
  }
  return out;
}

function reportRelatesToTask(
  task: LedgerTaskRecord,
  report: EnrichedReport,
): boolean {
  const tid = task.task_id.replace(/\.md$/i, "");
  const rtid = report.task_id.replace(/\.md$/i, "");
  if (rtid && (rtid === tid || rtid.startsWith(`${tid}-`) || tid.startsWith(`${rtid}-`))) {
    return true;
  }
  for (const ref of report.references) {
    const norm = ref.replace(/\.md$/i, "");
    if (norm === tid || norm.startsWith(`${tid}-`) || tid.startsWith(`${norm}-`)) {
      return true;
    }
  }
  if (task.filename && report.report_id.includes(task.filename.replace(".md", ""))) {
    return true;
  }
  return false;
}

function computeTaskStatus(
  task: LedgerTaskRecord,
  reports: EnrichedReport[],
): { status: ComputedTaskStatus; notes: string[] } {
  const notes: string[] = [];
  const related = reports.filter((r) => reportRelatesToTask(task, r));
  const doneReports = related.filter(
    (r) =>
      (r.fm_status === "done" || r.fm_status === "completed") &&
      !r.superseded_by,
  );

  switch (task.bucket) {
    case "inbox":
      return { status: "inbox_pending", notes };
    case "tasks":
      return { status: "legacy_tasks_bucket", notes: ["v2 legacy tasks/ bucket"] };
    case "archive":
      return { status: "archived", notes };
    case "done":
      return { status: "done", notes };
    case "review":
      return { status: "review_pending_approval", notes };
    case "active":
      if (doneReports.length) {
        notes.push(
          `done report(s): ${doneReports.map((r) => r.report_id).join(", ")}`,
        );
        return { status: "active_stalled_done_report", notes };
      }
      return { status: "active_in_progress", notes };
    default:
      return { status: "unknown_bucket", notes: [`bucket=${task.bucket}`] };
  }
}

async function computeReportStatus(
  report: EnrichedReport,
): Promise<{ status: ComputedReportStatus; notes: string[] }> {
  const notes: string[] = [];
  const fmStatus = report.fm_status;

  if (report.superseded_by) {
    notes.push(`superseded_by=${report.superseded_by}`);
    if (fmStatus === "blocked") {
      notes.push("ReportGate blocked duplicate");
      return { status: "reportgate_blocked_noise", notes };
    }
    return { status: "superseded", notes };
  }

  if (fmStatus === "done" || fmStatus === "completed") {
    return { status: "authoritative_done", notes };
  }

  if (fmStatus === "blocked") {
    return { status: "reportgate_blocked_noise", notes };
  }

  if (fmStatus === "in_progress") {
    return { status: "intermediate_in_progress", notes };
  }

  return { status: "other", notes: [`status=${fmStatus}`] };
}

async function listDiskActiveTasks(
  projectRoot: string,
): Promise<string[]> {
  const activeDir = join(projectRoot, "fcop", "_lifecycle", "active");
  try {
    const names = await fs.readdir(activeDir);
    return names.filter((n) => n.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

/** Read-only thread diagnosis: rebuild ledger, then inspect one task_id's thread. */
export async function verifyThread(
  projectRoot: string,
  taskId: string,
): Promise<LedgerThreadVerifyResult> {
  const taskPrefix = normalizeTaskPrefix(taskId);
  const builder = new LedgerBuilder({ projectRoot });
  const rebuild = await builder.rebuild();

  const allTasks = await builder.listTasks(undefined, { pendingOnly: false });
  const pmTasks = await builder.listTasks("PM");
  const opsTasks = await builder.listTasks("OPS");

  const layout = resolveLedgerLayout(projectRoot);
  const reportsRaw = await fs.readFile(
    join(layout.ledgerDir, "reports.jsonl"),
    "utf-8",
  );
  const reports = await enrichReportsFromDisk(
    loadJsonlLines<LedgerReportRecord>(reportsRaw),
  );

  const threads = await loadThreadsFromDisk(projectRoot);
  const thread = findThreadForTask(threads, taskPrefix);

  const scopedTasks = allTasks.filter((t) => taskInThreadScope(t, thread, taskPrefix));

  const entities: LedgerEntityInspection[] = [];
  const findings: string[] = [];

  if (!thread && scopedTasks.length === 0) {
    findings.push(`No ledger thread or task row matched task_id=${taskPrefix}`);
  } else if (!thread) {
    findings.push(`Task found but no threads.jsonl entry references ${taskPrefix}`);
  }

  for (const t of scopedTasks) {
    const { status, notes } = computeTaskStatus(t, reports);
    entities.push({
      id: t.task_id,
      kind: "task",
      ledger_bucket: t.bucket,
      computed_status: status,
      path: t.path,
      notes,
    });
    if (status === "active_stalled_done_report") {
      findings.push(
        `${t.task_id}: ledger bucket=active but computed_status=active_stalled_done_report`,
      );
    }
  }

  const reportSeen = new Set<string>();
  for (const r of reports) {
    if (!reportInThreadScope(r, thread, scopedTasks)) continue;
    if (reportSeen.has(r.report_id)) continue;
    reportSeen.add(r.report_id);
    const { status, notes } = await computeReportStatus(r);
    entities.push({
      id: r.report_id,
      kind: "report",
      ledger_status: r.status,
      computed_status: status,
      path: r.path,
      notes: [...notes, `fm_status=${r.fm_status}`],
    });
  }

  const diskActive = await listDiskActiveTasks(projectRoot);

  return {
    rebuilt_at: new Date().toISOString(),
    rebuild,
    list_tasks_all: allTasks.length,
    list_tasks_pm: pmTasks.length,
    list_tasks_ops: opsTasks.length,
    disk_active_task_files: diskActive,
    entities,
    findings,
    task_id: taskPrefix,
    thread_key: thread?.thread_key ?? null,
    thread_task_ids: thread?.task_ids ?? scopedTasks.map((t) => t.task_id),
    thread_report_ids: thread?.report_ids ?? [],
  };
}

/** Regression wrapper for TASK-237 sample (preserves verify_237 CLI contract). */
export async function verifyRegression237(
  projectRoot: string,
): Promise<LedgerRegressionVerifyResult> {
  const result = await verifyThread(projectRoot, "TASK-20260531-237");
  const findings = [...result.findings];

  for (const e of result.entities) {
    if (e.kind === "task" && e.computed_status === "active_stalled_done_report") {
      const regressionMsg = `${e.id}: ledger bucket=active but computed_status=active_stalled_done_report (regression sample preserved)`;
      const idx = findings.findIndex(
        (f) => f.startsWith(e.id) && f.includes("active_stalled_done_report"),
      );
      if (idx >= 0) findings[idx] = regressionMsg;
      else findings.push(regressionMsg);
    }
    if (
      e.kind === "report" &&
      e.id.includes("-003-") &&
      e.computed_status === "reportgate_blocked_noise" &&
      !findings.some((f) => f.includes("REPORT-003"))
    ) {
      findings.push(
        "REPORT-003: computed_status=reportgate_blocked_noise (expected noise; 002 is authoritative)",
      );
    }
  }

  const builder = new LedgerBuilder({ projectRoot });
  const pmTasks = await builder.listTasks("PM");
  if (pmTasks.length === 0 && result.disk_active_task_files.length > 0) {
    findings.push(
      `list_tasks(PM) returned 0 but _lifecycle/active has ${result.disk_active_task_files.length} file(s) — pending filter may hide non-PM recipients`,
    );
  }

  const pmPending = pmTasks.filter((t) =>
    REGRESSION_237_TASK_PREFIXES.some((p) =>
      t.task_id.toUpperCase().startsWith(p.toUpperCase()),
    ),
  );
  if (pmPending.length >= 1) {
    findings.push(
      `list_tasks(PM) includes ${pmPending.length} target thread task(s) in pending set`,
    );
  }

  // Ensure legacy report prefixes appear even if thread linkage is loose
  for (const prefix of REGRESSION_237_REPORT_PREFIXES) {
    if (!result.entities.some((e) => e.kind === "report" && e.id.startsWith(prefix))) {
      const row = (await enrichReportsFromDisk(
        loadJsonlLines<LedgerReportRecord>(
          await fs.readFile(
            join(resolveLedgerLayout(projectRoot).ledgerDir, "reports.jsonl"),
            "utf-8",
          ),
        ),
      )).find((r) => r.report_id.startsWith(prefix));
      if (row) {
        const { status, notes } = await computeReportStatus(row);
        result.entities.push({
          id: row.report_id,
          kind: "report",
          ledger_status: row.status,
          computed_status: status,
          path: row.path,
          notes: [...notes, `fm_status=${row.fm_status}`, "added by verify_237 regression scan"],
        });
      }
    }
  }

  return { ...result, findings };
}
