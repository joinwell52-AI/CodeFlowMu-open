/**
 * Read-only helpers: serve fcop/ledger/*.jsonl + views to the web panel (ADR-0002).
 */
import { readFileSync, existsSync, statSync, unlinkSync, readdirSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import {
  LedgerBuilder,
  resolveLedgerLayout,
  reconcileVirtualPmBranchArchives,
  repairMisplacedArchivedTasks,
  isTaskReopenedForReworkFromLedger,
  findTaskPathByIdSync,
  evaluateQaReportAcceptance,
  isVirtualPmSettlementNote,
  canDispatchQA,
  filterThreadTasks,
  loadExecutionGateContext,
  normalizeTaskIdPrefix,
  pmEvaluate,
  type ExecutionGateContext,
  type LedgerReportRecord,
  type LedgerTaskRecord,
  type LedgerThreadRecord,
  parseMarkdownFrontmatter,
} from "@codeflowmu/runtime";

import {
  aggregateTaskReportScopes,
  findLedgerRowForRoot,
} from "./panel-report-aggregation.ts";
import { isReworkResubmitUnblocked } from "./panel-task-rework-report.ts";

/** TTL for ensureLedgerFresh — same burst of home API calls share one freshness check. */
export const LEDGER_FRESH_TTL_MS = 8000;

type FreshGate = {
  inFlight: Promise<boolean> | null;
  lastOkAt: number;
  lastResult: boolean;
};

const freshGates = new Map<string, FreshGate>();

export type EnsureLedgerFreshOptions = {
  /** Bypass TTL and in-flight coalescing (still shares one in-flight rebuild). */
  force?: boolean;
  /** Unconditional ledger rebuild (e.g. ledger file empty but disk has tasks). */
  rebuild?: boolean;
};

function gateKey(projectRoot: string): string {
  return pathResolve(projectRoot);
}

function normalizeLedgerReferences(
  raw: unknown,
): string | string[] | undefined {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) {
    const vals = raw.map((x) => String(x).trim()).filter(Boolean);
    return vals.length ? vals : undefined;
  }
  const s = String(raw).trim();
  return s || undefined;
}

function getGate(projectRoot: string): FreshGate {
  const key = gateKey(projectRoot);
  let gate = freshGates.get(key);
  if (!gate) {
    gate = { inFlight: null, lastOkAt: 0, lastResult: true };
    freshGates.set(key, gate);
  }
  return gate;
}

/** Test hook — reset per-project freshness gates. */
export function resetLedgerFreshGateForTests(): void {
  freshGates.clear();
}

/** Invalidate TTL so the next ensureLedgerFresh re-checks disk vs ledger. */
export function invalidateLedgerFreshCache(projectRoot: string): void {
  const gate = freshGates.get(gateKey(projectRoot));
  if (gate) gate.lastOkAt = 0;
}

function readJsonl<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, "utf-8");
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
  } catch {
    return [];
  }
}

function normalizeTaskId(id: string): string {
  return id.replace(/\.md$/i, "").trim();
}

/** Derive lifecycle bucket from on-disk path (disk truth for scope projection). */
function lifecycleBucketFromPath(
  filePath: string,
  lifecycleRoot: string,
): string {
  const norm = filePath.replace(/\\/g, "/");
  const root = lifecycleRoot.replace(/\\/g, "/");
  if (norm.includes("/tasks/") && !norm.includes("/_lifecycle/")) return "tasks";
  for (const stage of [
    "inbox",
    "active",
    "review",
    "done",
    "archive",
  ] as const) {
    if (norm.includes(`${root}/${stage}/`)) return stage;
  }
  return "unknown";
}

export function resolveLedgerRowPath(projectRoot: string, rowPath: string): string {
  if (!rowPath.trim()) return "";
  const abs = pathResolve(projectRoot, rowPath);
  if (existsSync(abs)) return abs;
  if (existsSync(rowPath)) return rowPath;
  return abs;
}

/** True when no TASK file exists on disk for this ledger row (ghost / ledger_orphan). */
export function isLedgerTaskRowOrphan(
  projectRoot: string,
  t: Pick<LedgerTaskRecord, "path" | "task_id">,
): boolean {
  const layout = resolveLedgerLayout(projectRoot);
  const stem = normalizeTaskId(String(t.task_id ?? ""));
  if (stem && findTaskPathByIdSync(layout.lifecycleRoot, stem)) {
    return false;
  }
  const rel = String(t.path ?? "").trim();
  if (!rel) return Boolean(stem);
  const abs = resolveLedgerRowPath(projectRoot, rel);
  return !existsSync(abs);
}

/** True when ledger has a row for task_id but _lifecycle has no matching TASK file. */
export function isLedgerTaskIdOrphan(
  projectRoot: string,
  taskId: string,
): boolean {
  const layout = resolveLedgerLayout(projectRoot);
  const stem = normalizeTaskId(taskId);
  if (!stem) return false;
  if (findTaskPathByIdSync(layout.lifecycleRoot, stem)) return false;
  const rows = readJsonl<LedgerTaskRecord>(join(layout.ledgerDir, "tasks.jsonl"));
  return rows.some((r) => normalizeTaskId(r.task_id) === stem);
}

/** Read fcop/ledger/diagnostics.jsonl (ledger_orphan, file_without_ledger, etc.). */
export function readLedgerDiagnostics(
  projectRoot: string,
): Record<string, unknown>[] {
  const layout = resolveLedgerLayout(projectRoot);
  return readJsonl<Record<string, unknown>>(
    join(layout.ledgerDir, "diagnostics.jsonl"),
  );
}

export type FinalizeTaskCreateResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * After TASK markdown lands on disk: stat → rebuild ledger from _lifecycle files.
 * On ledger failure, remove the file so no ghost task remains.
 */
export async function finalizeTaskCreateAfterDiskWrite(
  projectRoot: string,
  filepath: string,
): Promise<FinalizeTaskCreateResult> {
  try {
    statSync(filepath);
  } catch {
    return { ok: false, error: `TASK file not found after write: ${filepath}` };
  }
  try {
    invalidateLedgerFreshCache(projectRoot);
    const ok = await ensureLedgerFresh(projectRoot, {
      rebuild: true,
      force: true,
    });
    if (!ok) {
      throw new Error("ledger rebuild returned false");
    }
    return { ok: true };
  } catch (err) {
    try {
      unlinkSync(filepath);
    } catch {
      /* best-effort rollback */
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Ledger rebuild failed; rolled back task file: ${msg}`,
    };
  }
}

/** Count tasks.jsonl rows whose path is missing — triggers J1 rebuild in auto list. */
export function countLedgerTaskOrphans(projectRoot: string): number {
  const layout = resolveLedgerLayout(projectRoot);
  const rows = readJsonl<LedgerTaskRecord>(join(layout.ledgerDir, "tasks.jsonl"));
  let n = 0;
  for (const t of rows) {
    if (isLedgerTaskRowOrphan(projectRoot, t)) n++;
  }
  return n;
}

/**
 * Scope for panel/API: ledger bucket unless disk path contradicts (e.g. stale archive row).
 */
function effectiveLedgerTaskBucket(
  t: LedgerTaskRecord,
  projectRoot: string,
  lifecycleRoot: string,
): string {
  const absPath = resolveLedgerRowPath(projectRoot, t.path);
  if (absPath && existsSync(absPath)) {
    const fromDisk = lifecycleBucketFromPath(absPath, lifecycleRoot);
    if (fromDisk !== "unknown") {
      return fromDisk;
    }
  }
  return String(t.bucket ?? t.state ?? "inbox").toLowerCase();
}

function isLedgerTaskSettledClosed(
  t: LedgerTaskRecord,
  scope: string,
): boolean {
  const reviewStatus = String(t.review_status ?? "").toLowerCase();
  if (reviewStatus !== "approved") return false;
  const normalizedScope = String(scope ?? "").toLowerCase();
  if (
    normalizedScope === "inbox" ||
    normalizedScope === "active" ||
    normalizedScope === "review"
  ) {
    return false;
  }
  if (normalizedScope === "done" || normalizedScope === "archive") {
    return true;
  }
  const displayStatus = String(t.display_status ?? "").toLowerCase();
  if (displayStatus === "done") return true;
  const state = String(t.state ?? "").toLowerCase();
  const bucket = String(t.bucket ?? "").toLowerCase();
  return (
    state === "done" ||
    state === "archive" ||
    bucket === "done" ||
    bucket === "archive"
  );
}

/** J1: force ledger rebuild after lifecycle join (archive/approve/reopen/…). */
export async function reconcileLedgerAfterJoin(
  projectRoot: string,
): Promise<void> {
  try {
    await reconcileVirtualPmBranchArchives(projectRoot);
  } catch {
    /* best-effort backfill before rebuild */
  }
  try {
    await repairMisplacedArchivedTasks(projectRoot);
  } catch {
    /* best-effort — half-archive repair before rebuild */
  }
  invalidateLedgerFreshCache(projectRoot);
  await ensureLedgerFresh(projectRoot, { rebuild: true });
}

function reportTaskRefIds(report: LedgerReportRecord): string[] {
  const ids: string[] = [];
  const tid = report.task_id.replace(/\.md$/i, "").trim();
  if (tid) ids.push(tid);
  for (const ref of report.references ?? []) {
    const norm = ref.replace(/\.md$/i, "").trim();
    if (norm && !ids.includes(norm)) ids.push(norm);
  }
  return ids;
}

export function readLedgerThreads(projectRoot: string): LedgerThreadRecord[] {
  const layout = resolveLedgerLayout(projectRoot);
  return readJsonl<LedgerThreadRecord>(join(layout.ledgerDir, "threads.jsonl"));
}

export function readLedgerViewMarkdown(
  projectRoot: string,
  role: string,
  variant: string,
): { role: string; variant: string; path: string; markdown: string } | null {
  const layout = resolveLedgerLayout(projectRoot);
  const safeRole = role.toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const safeVariant = variant.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const filename = `${safeRole}.${safeVariant}.md`;
  const filePath = join(layout.ledgerDir, "views", filename);
  if (!existsSync(filePath)) return null;
  try {
    return {
      role: safeRole,
      variant: safeVariant,
      path: `fcop/ledger/views/${filename}`,
      markdown: readFileSync(filePath, "utf-8"),
    };
  } catch {
    return null;
  }
}

export type LedgerProjectionContext = {
  pendingReview: Set<string>;
  consolidationRoots: Set<string>;
  latestReportByTaskId: Map<string, LedgerReportRecord>;
};

function bodyAfterFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("---", 3);
  if (end < 0) return raw;
  return raw.slice(end + 3).replace(/^\s*\r?\n/, "");
}

function ledgerTransitionList(t: LedgerTaskRecord): Record<string, unknown>[] {
  const yamlFm = (t.yaml ?? {}) as Record<string, unknown>;
  if (Array.isArray(t.transitions)) return t.transitions as Record<string, unknown>[];
  if (Array.isArray(yamlFm.transitions)) return yamlFm.transitions as Record<string, unknown>[];
  return [];
}

/** True when ledger transitions or metadata mark ADMIN force_archive / cancel. */
export function taskHasForceArchiveTransition(t: LedgerTaskRecord): boolean {
  const yamlFm = (t.yaml ?? {}) as Record<string, unknown>;
  const archiveMode = String(
    (t as { archive_mode?: string }).archive_mode ?? yamlFm.archive_mode ?? "",
  ).toLowerCase();
  const taskType = String(yamlFm.task_type ?? "").toLowerCase();
  if (archiveMode === "force" || taskType === "force_archive") return true;
  for (const tr of ledgerTransitionList(t)) {
    const action = String(tr.action ?? "").toLowerCase();
    if (action === "force_archive_task" || action === "force_archive") return true;
  }
  return false;
}

function forceArchiveReasonFromTransitions(t: LedgerTaskRecord): string {
  for (const tr of ledgerTransitionList(t)) {
    const action = String(tr.action ?? "").toLowerCase();
    if (action === "force_archive_task" || action === "force_archive") {
      const reason = String(tr.reason ?? "").trim();
      if (reason) return reason;
    }
  }
  return "ADMIN cancelled / force archive";
}

function loadLatestReportPayloadForTask(
  projectRoot: string,
  report: LedgerReportRecord | undefined,
): { status?: string; body?: string; sender?: string; recipient?: string } | null {
  if (!report) return null;
  const rel = String(report.path ?? "").trim();
  let body: string | undefined;
  let status = String(report.status ?? "").trim();
  let sender = report.sender;
  let recipient = report.recipient;
  if (rel) {
    const abs = resolveLedgerRowPath(projectRoot, rel);
    if (abs && existsSync(abs)) {
      try {
        const raw = readFileSync(abs, "utf-8");
        const fm = parseMarkdownFrontmatter(raw) as Record<string, string>;
        body = bodyAfterFrontmatter(raw);
        status = String(fm.status ?? status).trim();
        sender = String(fm.sender ?? sender ?? "");
        recipient = String(fm.recipient ?? recipient ?? "");
      } catch {
        /* fall back to ledger row fields */
      }
    }
  }
  return { status, body, sender, recipient };
}

type LedgerDisplayStatusResolution = {
  display_status: string;
  display_reason?: string;
  archive_mode?: string;
};

function resolveLedgerDisplayStatus(
  t: LedgerTaskRecord,
  ctx: LedgerProjectionContext,
  projectRoot: string,
  opts: { isSettledClosed: boolean },
): LedgerDisplayStatusResolution | undefined {
  if (taskHasForceArchiveTransition(t)) {
    return {
      display_status: "cancelled",
      display_reason: forceArchiveReasonFromTransitions(t),
      archive_mode: "force",
    };
  }

  const tid = normalizeTaskId(t.task_id);
  const report = tid ? ctx.latestReportByTaskId.get(tid) : undefined;
  const payload = loadLatestReportPayloadForTask(projectRoot, report);
  const workerReportStatus = String(payload?.status ?? "").trim().toLowerCase();
  const workerSender = String(payload?.sender ?? "").trim().toUpperCase();
  const workerRecipient = String(payload?.recipient ?? "").trim().toUpperCase();
  if (
    ["DEV", "QA", "OPS"].includes(workerSender) &&
    workerRecipient === "PM" &&
    ["blocked", "aborted", "failed", "fail", "needs_input"].includes(workerReportStatus)
  ) {
    return {
      display_status: "worker_report_blocked",
      display_reason: `${workerSender} REPORT status=${workerReportStatus}，等待 PM 安排返工或处理阻塞`,
    };
  }
  const qaEval = payload ? evaluateQaReportAcceptance(payload) : null;

  if (qaEval?.blocksReview) {
    if (qaEval.verdict === "blocked") {
      return { display_status: "worker_report_blocked", display_reason: qaEval.reason };
    }
    return { display_status: "qa_acceptance_fail", display_reason: qaEval.reason };
  }

  if (!opts.isSettledClosed) return undefined;

  const yamlFm = (t.yaml ?? {}) as Record<string, unknown>;
  const reviewNote = String(t.review_note ?? yamlFm.review_note ?? "").trim();
  if (isVirtualPmSettlementNote(reviewNote)) {
    return {
      display_status: "auto_review_approved",
      display_reason: reviewNote,
    };
  }

  return { display_status: "human_review_approved" };
}

/** Last-wins map of task_id → latest REPORT row (jsonl append order). */
export function buildLatestReportsByTaskId(
  projectRoot: string,
): Map<string, LedgerReportRecord> {
  const layout = resolveLedgerLayout(projectRoot);
  const rows = readJsonl<LedgerReportRecord>(join(layout.ledgerDir, "reports.jsonl"));
  const map = new Map<string, LedgerReportRecord>();
  for (const r of rows) {
    for (const ref of reportTaskRefIds(r)) {
      const nid = normalizeTaskId(ref);
      if (nid) map.set(nid, r);
    }
  }
  return map;
}

/** Thread-index fields shared by task list and approval-history projection. */
export function buildLedgerThreadIndex(
  projectRoot: string,
): LedgerProjectionContext {
  const pendingReview = new Set<string>();
  const consolidationRoots = new Set<string>();
  for (const th of readLedgerThreads(projectRoot)) {
    for (const id of th.pending_pm_review ?? []) {
      pendingReview.add(normalizeTaskId(id));
    }
    if (th.waiting_pm_consolidation && th.root_task_id) {
      consolidationRoots.add(normalizeTaskId(th.root_task_id));
    }
  }
  return { pendingReview, consolidationRoots, latestReportByTaskId: new Map() };
}

/** Full projection context: threads + latest worker reports per task. */
export function buildLedgerProjectionContext(
  projectRoot: string,
): LedgerProjectionContext {
  const ctx = buildLedgerThreadIndex(projectRoot);
  ctx.latestReportByTaskId = buildLatestReportsByTaskId(projectRoot);
  return ctx;
}

/** Project one ledger task row to the panel task-list shape (null when orphan). */
export function projectLedgerTaskFromRow(
  projectRoot: string,
  t: LedgerTaskRecord,
  ctx: LedgerProjectionContext,
): Record<string, unknown> | null {
  if (isLedgerTaskRowOrphan(projectRoot, t)) return null;

  const layout = resolveLedgerLayout(projectRoot);
  const tid = normalizeTaskId(t.task_id);
  const ledgerBucket: string = effectiveLedgerTaskBucket(
    t,
    projectRoot,
    layout.lifecycleRoot,
  );
  let scope: string = ledgerBucket;
  let display_status: string | undefined;
  const yamlFm = (t.yaml ?? {}) as Record<string, unknown>;
  const reopenReason = String(t.reopen_reason ?? yamlFm.reopen_reason ?? "").trim();
  const reviewStatus = String(t.review_status ?? yamlFm.review_status ?? "").trim();
  const reopenedCount = Number(t.reopened_count ?? yamlFm.reopened_count ?? 0);
  const reworkCompletedBy = String(
    (t as { rework_completed_by_report?: string }).rework_completed_by_report ??
      yamlFm.rework_completed_by_report ??
      "",
  ).trim();
  const yamlDisplayStatus = String(t.display_status ?? yamlFm.display_status ?? "").trim();
  const isSettledClosed = isLedgerTaskSettledClosed(t, scope);
  const reworkFields = {
    display_status: yamlDisplayStatus,
    reopen_reason: reopenReason,
    review_note: String(t.review_note ?? yamlFm.review_note ?? "").trim(),
    review_status: reviewStatus,
    reopened_count: reopenedCount,
    rework_completed_by_report: reworkCompletedBy,
    bucket: t.bucket,
    scope,
    state: t.state,
  };
  const isReopenedForRework = isTaskReopenedForReworkFromLedger(reworkFields);

  const ledgerDisplay = yamlDisplayStatus.toLowerCase();

  if (ledgerDisplay === "waiting_pm_attention" && !isSettledClosed) {
    display_status = "waiting_pm_attention";
  } else if (ctx.pendingReview.has(tid) && !isSettledClosed) {
    scope = "review";
    display_status = "waiting_pm_review";
  } else if (yamlDisplayStatus && !isSettledClosed) {
    display_status = yamlDisplayStatus;
    if (
      isReopenedForRework &&
      (scope === "done" || scope === "archive") &&
      !isReworkResubmitUnblocked(reworkFields)
    ) {
      scope = "active";
    }
  } else if (isReopenedForRework && !isSettledClosed) {
    display_status = "admin_rejected";
    if (scope === "done" || scope === "archive") {
      scope = "active";
    }
  } else if (ctx.consolidationRoots.has(tid) && !isSettledClosed) {
    display_status = "waiting_pm_consolidation";
  }

  const displayResolution = resolveLedgerDisplayStatus(t, ctx, projectRoot, {
    isSettledClosed,
  });
  let resolvedArchiveMode: string | undefined;
  const openAttention =
    display_status === "waiting_pm_attention" ||
    display_status === "waiting_pm_review" ||
    display_status === "waiting_pm_consolidation" ||
    display_status === "admin_rejected";

  if (displayResolution) {
    const ds = displayResolution.display_status;
    if (
      ds === "cancelled" ||
      ds === "worker_report_blocked" ||
      ds === "qa_acceptance_fail"
    ) {
      display_status = ds;
      resolvedArchiveMode = displayResolution.archive_mode;
    } else if (isSettledClosed && !openAttention) {
      display_status = ds;
      resolvedArchiveMode = displayResolution.archive_mode;
    }
  } else if (isSettledClosed && !display_status) {
    display_status = "human_review_approved";
  }

  if (scope === "tasks") {
    scope = "active";
  }

  const pmAttentionReason = String(t.pm_attention_reason ?? "").trim();
  const resolutionReason = displayResolution?.display_reason?.trim();
  const display_reason =
    display_status === "waiting_pm_attention"
      ? pmAttentionReason || "fact_check_needs_human"
      : display_status === "waiting_pm_consolidation"
        ? "child_tasks_settled_waiting_pm_summary"
        : display_status === "admin_rejected"
          ? reopenReason || "admin_rejected"
          : display_status === "cancelled" ||
              display_status === "worker_report_blocked" ||
              display_status === "qa_acceptance_fail" ||
              display_status === "auto_review_approved" ||
              display_status === "human_review_approved"
            ? resolutionReason || undefined
            : undefined;

  return {
    filename: t.filename,
    task_id: t.task_id,
    sender: t.sender,
    recipient: t.recipient,
    thread_key: t.thread_key,
    bucket: ledgerBucket,
    scope,
    display_status,
    display_reason,
    ...(resolvedArchiveMode ? { archive_mode: resolvedArchiveMode } : {}),
    ...(pmAttentionReason ? { pm_attention_reason: pmAttentionReason } : {}),
    review_status: reviewStatus || t.review_status,
    reopen_reason: reopenReason || t.reopen_reason,
    review_note: t.review_note,
    reopened_count: reopenedCount > 0 ? reopenedCount : t.reopened_count,
    ...(reworkCompletedBy ? { rework_completed_by_report: reworkCompletedBy } : {}),
    ...(Array.isArray(t.transitions) ? { transitions: t.transitions } : {}),
    parent: (() => {
      const parentRaw = String(
        t.parent_task_id ?? t.parent ?? yamlFm.parent ?? "",
      ).trim();
      return parentRaw || t.parent;
    })(),
    parent_task_id: (() => {
      const parentRaw = String(
        t.parent_task_id ?? t.parent ?? yamlFm.parent ?? "",
      ).trim();
      return parentRaw || (t.parent_task_id ?? t.parent);
    })(),
    references: normalizeLedgerReferences(
      (t as { references?: unknown }).references ?? yamlFm.references,
    ),
    _state: t.state ?? t.bucket,
    _source: "ledger",
    path: t.path,
    ...(t.sync_status && t.sync_status !== "ok" ? { sync_status: t.sync_status } : {}),
    created_at: t.created_at,
    updated_at: t.updated_at,
    timezone: t.timezone,
  };
}

/** Last-wins map of task_id → latest ledger row (jsonl append order). */
export function readLatestLedgerTasksByTaskId(
  projectRoot: string,
): Map<string, LedgerTaskRecord> {
  const layout = resolveLedgerLayout(projectRoot);
  const rows = readJsonl<LedgerTaskRecord>(join(layout.ledgerDir, "tasks.jsonl"));
  const map = new Map<string, LedgerTaskRecord>();
  for (const t of rows) {
    const key = normalizeTaskId(t.task_id);
    if (!key) continue;
    map.set(key, t);
  }
  return map;
}

export type ApprovalHistoryOutcome = "approved" | "rejected" | "pending";

/** Classify settled vs in-flight approval outcomes from a projected ledger task. */
export function classifyApprovalHistoryOutcome(
  projection: Record<string, unknown>,
): ApprovalHistoryOutcome | null {
  const displayStatus = String(projection.display_status ?? "").toLowerCase();
  const reviewStatus = String(projection.review_status ?? "").toLowerCase();
  /** Disk/ledger bucket before rework UI remaps scope → active. */
  const physicalScope = String(
    projection.bucket ?? projection._state ?? projection.scope ?? "",
  ).toLowerCase();

  if (
    displayStatus === "human_review_approved" ||
    displayStatus === "auto_review_approved"
  ) {
    return "approved";
  }

  if (
    displayStatus === "qa_acceptance_fail" ||
    displayStatus === "worker_report_blocked" ||
    displayStatus === "cancelled"
  ) {
    return null;
  }

  if (
    reviewStatus === "rejected" &&
    (physicalScope === "done" || physicalScope === "archive")
  ) {
    return "rejected";
  }

  if (
    displayStatus === "waiting_pm_attention" ||
    displayStatus === "waiting_pm_review" ||
    displayStatus === "waiting_pm_consolidation" ||
    displayStatus === "admin_rejected"
  ) {
    return "pending";
  }

  return null;
}

export type ApprovalHistoryStats = {
  total: number;
  approved: number;
  rejected: number;
  pending: number;
};

export type ApprovalHistoryEntry = Record<string, unknown> & {
  task_id: string;
  id: string;
  filename: string;
  decision: "approve" | "reject" | "pending";
  resolved_decision: "approved" | "rejected" | "pending";
  sender: string;
};

/** Aggregate approval history counts from ledger latest task state (one row per task_id). */
export function aggregateApprovalHistoryFromLedger(
  projectRoot: string,
  opts?: { limit?: number; decision?: "approved" | "rejected" },
): { stats: ApprovalHistoryStats; total: number; history: ApprovalHistoryEntry[] } {
  const ctx = buildLedgerProjectionContext(projectRoot);
  const latest = readLatestLedgerTasksByTaskId(projectRoot);
  const stats: ApprovalHistoryStats = {
    total: 0,
    approved: 0,
    rejected: 0,
    pending: 0,
  };
  const history: ApprovalHistoryEntry[] = [];

  for (const row of latest.values()) {
    const proj = projectLedgerTaskFromRow(projectRoot, row, ctx);
    if (!proj) continue;
    const outcome = classifyApprovalHistoryOutcome(proj);
    if (outcome === null) continue;

    if (outcome === "pending") {
      stats.pending++;
      continue;
    } else if (outcome === "approved") {
      stats.approved++;
    } else {
      stats.rejected++;
    }

    const yamlFm = (row.yaml ?? {}) as Record<string, unknown>;
    const taskId = String(proj.task_id ?? row.task_id ?? "");
    history.push({
      kind: "task",
      id: normalizeTaskId(taskId),
      task_id: taskId,
      filename: String(proj.filename ?? row.filename ?? ""),
      sender: String(proj.sender ?? row.sender ?? ""),
      recipient: String(proj.recipient ?? row.recipient ?? ""),
      decision: outcome === "approved" ? "approve" : "reject",
      resolved_decision: outcome,
      summary: "",
      preview: "",
      time: String(proj.updated_at ?? proj.created_at ?? row.updated_at ?? row.created_at ?? ""),
      updated_at: String(proj.updated_at ?? row.updated_at ?? ""),
      created_at: String(proj.created_at ?? row.created_at ?? ""),
      thread_key: proj.thread_key as string | undefined,
      risk: String(
        (row as { risk_level?: string }).risk_level ?? yamlFm.risk_level ?? "low",
      ),
      _source: "ledger",
    });
  }

  stats.total = stats.approved + stats.rejected;
  history.sort((a, b) => String(b.time ?? "").localeCompare(String(a.time ?? "")));

  let filtered = history;
  if (opts?.decision === "approved") {
    filtered = history.filter((h) => h.resolved_decision === "approved");
  } else if (opts?.decision === "rejected") {
    filtered = history.filter((h) => h.resolved_decision === "rejected");
  }

  const limit = opts?.limit ?? 50;
  return { stats, total: stats.total, history: filtered.slice(0, limit) };
}

/** Attach REVIEW file preview/path from fcop/reviews/ (does not affect stats). */
export function enrichApprovalHistoryFromReviews(
  reviewsDir: string,
  history: ApprovalHistoryEntry[],
): void {
  if (!reviewsDir || !existsSync(reviewsDir)) return;

  const bySubject = new Map<
    string,
    { preview: string; review_filename: string; fm: Record<string, unknown> }
  >();

  for (const sub of ["", "approved", "rejected"]) {
    const scanDir = sub ? join(reviewsDir, sub) : reviewsDir;
    if (!existsSync(scanDir)) continue;
    let files: string[];
    try {
      files = readdirSync(scanDir).filter(
        (f) => f.endsWith(".md") && f.startsWith("REVIEW-"),
      );
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const raw = readFileSync(join(scanDir, f), "utf-8");
        const fm = parseMarkdownFrontmatter(raw) as Record<string, unknown>;
        const subjectId = normalizeTaskId(
          String(fm.subject_id ?? fm.task_id ?? ""),
        );
        if (!subjectId) continue;
        const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
        const preview =
          body.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() ??
          "";
        const review_filename = sub ? `${sub}/${f}` : f;
        const existing = bySubject.get(subjectId);
        if (!existing || review_filename.localeCompare(existing.review_filename) > 0) {
          bySubject.set(subjectId, { preview, review_filename, fm });
        }
      } catch {
        /* skip unreadable review */
      }
    }
  }

  for (const entry of history) {
    const key = normalizeTaskId(String(entry.task_id ?? entry.id ?? ""));
    const enrich = bySubject.get(key);
    if (!enrich) continue;
    if (enrich.preview) {
      entry.preview = enrich.preview;
      if (!entry.summary) entry.summary = enrich.preview;
    }
    entry.review_filename = enrich.review_filename;
    const risk = enrich.fm.risk_level ?? enrich.fm.risk;
    if (risk && !entry.risk) entry.risk = String(risk);
  }
}

function findGateTaskRef(
  gateCtx: ExecutionGateContext,
  taskId: string,
) {
  const prefix = normalizeTaskIdPrefix(taskId);
  return gateCtx.tasks.find(
    (t) => normalizeTaskIdPrefix(t.taskId) === prefix,
  );
}

/** Read-only projection: pmEvaluate + canDispatchQA fields for panel task rows. */
export function applyExecutionGateProjection(
  tasks: Record<string, unknown>[],
  gateCtx: ExecutionGateContext,
): Record<string, unknown>[] {
  return tasks.map((proj) => {
    const taskId = String(proj.task_id ?? "");
    const ref = findGateTaskRef(gateCtx, taskId);
    if (!ref) return proj;

    const threadKey =
      ref.threadKey ?? (String(proj.thread_key ?? "").trim() || undefined);
    const threadTasks = filterThreadTasks(gateCtx.tasks, threadKey);
    const pm = pmEvaluate(ref, gateCtx, threadTasks);
    const enriched: Record<string, unknown> = {
      ...proj,
      execution_state: pm.execution_state,
      pm_action: pm.action,
      pm_evaluate_reason: pm.reason,
    };

    const qaGate = canDispatchQA(ref, gateCtx, threadTasks);
    if (qaGate.reason !== "not_qa_task") {
      enriched.qa_dispatch_allowed = qaGate.allowed;
      if (qaGate.reason) enriched.qa_dispatch_block = qaGate.reason;
      if (qaGate.detail) enriched.qa_dispatch_detail = qaGate.detail;
      if (qaGate.waiting_on) enriched.qa_dispatch_waiting_on = qaGate.waiting_on;
      if (qaGate.execution_state && enriched.execution_state == null) {
        enriched.execution_state = qaGate.execution_state;
      }
    }

    return enriched;
  });
}

/** Map ledger task rows to the shape expected by the web panel task list. */
export function listTasksFromLedgerFile(
  projectRoot: string,
  opts?: {
    sender?: string;
    recipient?: string;
    limit?: number;
    executionGate?: ExecutionGateContext;
  },
): Record<string, unknown>[] {
  const layout = resolveLedgerLayout(projectRoot);
  const rows = readJsonl<LedgerTaskRecord>(join(layout.ledgerDir, "tasks.jsonl"));
  if (!rows.length) return [];

  const senderFilter = opts?.sender?.trim().toUpperCase() ?? "";
  const recipientFilter = opts?.recipient?.trim().toUpperCase() ?? "";
  const limit = opts?.limit ?? 500;
  const ctx = buildLedgerProjectionContext(projectRoot);

  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];

  for (const t of rows) {
    const key = normalizeTaskId(t.task_id);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (senderFilter && t.sender?.toUpperCase() !== senderFilter) continue;
    if (recipientFilter && t.recipient?.toUpperCase() !== recipientFilter) continue;

    const proj = projectLedgerTaskFromRow(projectRoot, t, ctx);
    if (proj) out.push(proj);
  }

  let result = out.slice(0, limit);
  if (opts?.executionGate) {
    result = applyExecutionGateProjection(result, opts.executionGate);
  }
  return result;
}

/** Map ledger report rows to the shape expected by the web panel report list. */
export function listReportsFromLedgerFile(
  projectRoot: string,
  opts?: { limit?: number },
): Record<string, unknown>[] {
  const layout = resolveLedgerLayout(projectRoot);
  const rows = readJsonl<LedgerReportRecord>(join(layout.ledgerDir, "reports.jsonl"));
  if (!rows.length) return [];

  const limit = opts?.limit ?? 500;
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];

  for (const r of rows) {
    const key = r.path || r.filename || r.report_id;
    if (seen.has(key)) continue;
    seen.add(key);
    const rel = String(r.path ?? "").trim();
    if (rel) {
      const abs = resolveLedgerRowPath(projectRoot, rel);
      if (!existsSync(abs)) continue;
    }
    const linked = reportTaskRefIds(r);
    out.push({
      filename: r.filename,
      report_id: r.report_id,
      task_id: r.task_id,
      sender: r.sender,
      recipient: r.recipient,
      status: r.status,
      thread_key: r.thread_key,
      linked_task_ids:
        Array.isArray(r.linked_task_ids) && r.linked_task_ids.length
          ? r.linked_task_ids
          : linked,
      parent_task_id: r.parent_task_id,
      report_kind: r.report_kind,
      references: r.references,
      path: r.path,
      created_at: r.created_at,
      updated_at: r.updated_at,
      _source: "ledger",
    });
  }

  return out.slice(-limit).reverse();
}

/** Rebuild fcop/ledger when disk tasks diverge from tasks.jsonl (TTL + in-flight coalesce). */
export async function ensureLedgerFresh(
  projectRoot: string,
  opts?: EnsureLedgerFreshOptions,
): Promise<boolean> {
  const gate = getGate(projectRoot);
  const now = Date.now();

  if (opts?.rebuild) {
    try {
      const builder = new LedgerBuilder({ projectRoot });
      await builder.rebuild();
      gate.lastOkAt = Date.now();
      gate.lastResult = true;
      return true;
    } catch {
      gate.lastOkAt = Date.now();
      gate.lastResult = false;
      return false;
    }
  }

  if (!opts?.force && gate.inFlight) {
    return gate.inFlight;
  }

  if (!opts?.force && now - gate.lastOkAt < LEDGER_FRESH_TTL_MS) {
    return gate.lastResult;
  }

  const run = (async (): Promise<boolean> => {
    try {
      const builder = new LedgerBuilder({ projectRoot });
      const result = await builder.ensureFresh();
      gate.lastOkAt = Date.now();
      gate.lastResult = result;
      return result;
    } catch {
      gate.lastOkAt = Date.now();
      gate.lastResult = false;
      return false;
    } finally {
      gate.inFlight = null;
    }
  })();

  gate.inFlight = run;
  return run;
}

/** Async variant: ensures ledger freshness, then reads tasks.jsonl. */
export async function listTasksFromLedgerAuto(
  projectRoot: string,
  opts?: { sender?: string; recipient?: string; limit?: number },
): Promise<{
  tasks: Record<string, unknown>[];
  source: "ledger" | "empty";
  diagnostics: Record<string, unknown>[];
}> {
  try {
    await ensureLedgerFresh(projectRoot);
  } catch {
    /* fallback handled by caller */
  }

  let executionGate: ExecutionGateContext | undefined;
  try {
    executionGate = await loadExecutionGateContext(projectRoot);
  } catch {
    /* panel still works without execution gate projection */
  }
  const listOpts = { ...opts, executionGate };

  let tasks = listTasksFromLedgerFile(projectRoot, listOpts);
  const orphanCount = countLedgerTaskOrphans(projectRoot);
  if (orphanCount > 0) {
    try {
      invalidateLedgerFreshCache(projectRoot);
      // Rebuild writes disk-only rows to tasks.jsonl; orphans land in diagnostics.jsonl.
      await ensureLedgerFresh(projectRoot, { rebuild: true, force: true });
      try {
        executionGate = await loadExecutionGateContext(projectRoot);
      } catch {
        /* keep prior gate ctx if reload fails */
      }
      tasks = listTasksFromLedgerFile(projectRoot, {
        ...listOpts,
        executionGate,
      });
    } catch {
      /* keep filtered projection */
    }
  }
  const diagnostics = readLedgerDiagnostics(projectRoot);
  if (tasks.length) return { tasks, source: "ledger", diagnostics };

  try {
    await ensureLedgerFresh(projectRoot, { rebuild: true, force: true });
    try {
      executionGate = await loadExecutionGateContext(projectRoot);
    } catch {
      /* keep prior gate ctx if reload fails */
    }
    tasks = listTasksFromLedgerFile(projectRoot, {
      ...listOpts,
      executionGate,
    });
  } catch {
    /* fallback handled by caller */
  }

  return {
    tasks,
    source: tasks.length ? "ledger" : "empty",
    diagnostics: readLedgerDiagnostics(projectRoot),
  };
}

/** Async variant: ensures ledger freshness, then reads reports.jsonl. */
export async function listReportsFromLedgerAuto(
  projectRoot: string,
  opts?: { limit?: number },
): Promise<{ reports: Record<string, unknown>[]; source: "ledger" | "empty" }> {
  try {
    await ensureLedgerFresh(projectRoot);
  } catch {
    /* fallback handled by caller */
  }

  let reports = listReportsFromLedgerFile(projectRoot, opts);
  if (reports.length) return { reports, source: "ledger" };

  try {
    await ensureLedgerFresh(projectRoot, { rebuild: true });
    reports = listReportsFromLedgerFile(projectRoot, opts);
  } catch {
    /* fallback handled by caller */
  }

  return { reports, source: reports.length ? "ledger" : "empty" };
}

/** Read threads.jsonl after ensuring ledger matches disk. */
export async function readLedgerThreadsAuto(
  projectRoot: string,
): Promise<LedgerThreadRecord[]> {
  await ensureLedgerFresh(projectRoot);
  return readLedgerThreads(projectRoot);
}

/** Read a role view markdown after ensuring ledger matches disk. */
export async function readLedgerViewMarkdownAuto(
  projectRoot: string,
  role: string,
  variant: string,
): Promise<{ role: string; variant: string; path: string; markdown: string } | null> {
  await ensureLedgerFresh(projectRoot);
  return readLedgerViewMarkdown(projectRoot, role, variant);
}

/** Dual-scope report counts for a root ADMIN mainline task. */
export async function readTaskReportScopes(
  projectRoot: string,
  taskId: string,
): Promise<{
  task_id: string;
  direct_reports: LedgerReportRecord[];
  thread_reports: LedgerReportRecord[];
  direct_count: number;
  thread_count: number;
}> {
  await ensureLedgerFresh(projectRoot);
  const norm = normalizeTaskId(taskId);
  const layout = resolveLedgerLayout(projectRoot);
  const tasks = readJsonl<LedgerTaskRecord>(join(layout.ledgerDir, "tasks.jsonl"));
  const reports = readJsonl<LedgerReportRecord>(
    join(layout.ledgerDir, "reports.jsonl"),
  );
  const threads = readJsonl<LedgerThreadRecord>(
    join(layout.ledgerDir, "threads.jsonl"),
  );
  const ledgerRow = findLedgerRowForRoot(norm, threads);
  const scopes = aggregateTaskReportScopes(norm, tasks, reports, {
    ledgerRow,
    ledgerRows: threads,
  });
  return {
    task_id: norm,
    direct_reports: scopes.direct_reports as LedgerReportRecord[],
    thread_reports: scopes.thread_reports as LedgerReportRecord[],
    direct_count: scopes.direct_reports.length,
    thread_count: scopes.thread_reports.length,
  };
}

/** ADMIN 关单旁路视图：PM final summary + EVAL observation（只读）。 */
export async function readAdminTaskCloseout(
  projectRoot: string,
  taskId: string,
) {
  await ensureLedgerFresh(projectRoot);
  const { getAdminTaskCloseout } = await import("@codeflowmu/runtime");
  return getAdminTaskCloseout(projectRoot, taskId);
}

/** ADMIN 关单：手动补写 EVAL observation（幂等；forceRegenerate 覆盖既有 OBSERVATION）。 */
export async function generateAdminTaskCloseoutEval(
  projectRoot: string,
  taskId: string,
  options?: { forceRegenerate?: boolean },
) {
  await ensureLedgerFresh(projectRoot);
  const { ensureEvalObservationForCloseout, getAdminTaskCloseout } =
    await import("@codeflowmu/runtime");
  const result = await ensureEvalObservationForCloseout(
    projectRoot,
    taskId,
    options,
  );
  const closeout = await getAdminTaskCloseout(projectRoot, taskId);
  return { result, closeout };
}
