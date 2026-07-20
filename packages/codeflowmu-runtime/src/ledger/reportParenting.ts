/**
 * REPORT → TASK 挂树规则（Cursor 总线 MVP）。
 * worker-to-PM 挂 PM→worker 子任务；PM-to-ADMIN 挂 ADMIN→PM root。
 */

import { isAckOnlyReportBody } from "../review/ReviewFactGate.ts";
import { isWorkerReportToPm } from "../fcop/governance.ts";
import { inferReportTaskIdFromFilename } from "./frontmatter.ts";
import type {
  LedgerReportKind,
  LedgerReportRecord,
  LedgerTaskRecord,
} from "./types.ts";

export type { LedgerReportKind };

export const PM_DOWNSTREAM_WORKER_ROLES = new Set(["DEV", "OPS", "QA"]);

function normalizeId(id: string): string {
  return id.replace(/\.md$/i, "").trim();
}

export function taskIdPrefix(id: string): string {
  const m = /^TASK-\d{8}-\d{3,}/i.exec(normalizeId(id));
  return m ? m[0].toUpperCase() : normalizeId(id).toUpperCase();
}

export function taskIdMatchesPrefix(taskId: string, prefix: string): boolean {
  const norm = normalizeId(taskId).toUpperCase();
  const p = normalizeId(prefix).toUpperCase();
  return norm === p || norm.startsWith(`${p}-`) || p.startsWith(`${norm}-`);
}

function isAdminMainlineFilename(filename: string): boolean {
  return /-ADMIN-to-PM/i.test(filename);
}

export function isPmToAdminReport(sender: string, recipient: string): boolean {
  return sender.toUpperCase() === "PM" && recipient.toUpperCase() === "ADMIN";
}

export function isPmDownstreamChildTask(task: LedgerTaskRecord): boolean {
  return (
    task.sender.toUpperCase() === "PM" &&
    PM_DOWNSTREAM_WORKER_ROLES.has(task.recipient.toUpperCase())
  );
}

/** Hot path：worker 直接发 TASK/REPORT 给 PM（非 PM→worker 子任务）。 */
export function isHotPathWorkerToPmTask(task: LedgerTaskRecord): boolean {
  const sender = task.sender.toUpperCase();
  return (
    PM_DOWNSTREAM_WORKER_ROLES.has(sender) &&
    task.recipient.toUpperCase() === "PM"
  );
}

export function isAdminToPmRootTask(task: LedgerTaskRecord): boolean {
  return (
    task.sender.toUpperCase() === "ADMIN" &&
    task.recipient.toUpperCase() === "PM" &&
    (isAdminMainlineFilename(task.filename) || !task.parent)
  );
}

function reportMatchScore(task: LedgerTaskRecord, ref: string): number {
  const norm = normalizeId(ref);
  if (!norm) return 0;
  const baseName = task.filename.replace(/\.md$/i, "");
  if (task.task_id === norm || baseName === norm) return 100;
  if (norm.startsWith(`${task.task_id}-`)) return 80;
  if (task.task_id.startsWith(`${norm}-`)) {
    if (/-rework-/i.test(task.filename) || /-OPS-to-OPS-/i.test(task.filename)) {
      return 0;
    }
    return 60;
  }
  if (baseName.startsWith(`${norm}-`)) return 50;
  return 0;
}

function reportDateSeqTaskPrefix(report: LedgerReportRecord): string {
  const source = report.filename || report.report_id || "";
  const m = /^REPORT-(\d{8})-(\d{3,})/i.exec(source.replace(/^.*[/\\]/, ""));
  return m ? `TASK-${m[1]}-${m[2]}` : "";
}

function extractTaskRefsFromText(text: string | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const re =
    /TASK-\d{8}-\d{3,}(?:-[A-Za-z0-9_-]+-to-[A-Za-z0-9_.-]+)?/gi;
  for (const m of text.matchAll(re)) {
    const id = normalizeId(m[0]!);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function adminRootMatchesId(task: LedgerTaskRecord, ref: string): boolean {
  const norm = normalizeId(ref);
  if (!norm) return false;
  const baseName = task.filename.replace(/\.md$/i, "");
  if (task.task_id === norm || baseName === norm) return true;
  return norm.startsWith(`${task.task_id}-`);
}

function refMatchesRootId(ref: string, rootId: string): boolean {
  return taskIdMatchesPrefix(ref, rootId);
}

/** PM→ADMIN 报告是否明确绑定到指定 ADMIN root（禁止仅靠共享 thread_key 或宽松前缀）。 */
export function reportBoundToAdminRoot(
  rootId: string,
  report: LedgerReportRecord,
): boolean {
  const rootNorm = normalizeId(rootId);
  if (!rootNorm) return false;

  let explicitHit = false;
  if (report.task_id?.trim() && refMatchesRootId(report.task_id, rootNorm)) {
    explicitHit = true;
  }
  for (const ref of report.references ?? []) {
    if (refMatchesRootId(ref, rootNorm)) {
      explicitHit = true;
      break;
    }
  }
  if (explicitHit) return true;

  const parent = report.parent_task_id?.trim();
  if (!parent || !refMatchesRootId(parent, rootNorm)) return false;

  const hasExplicitRef = Boolean(
    report.task_id?.trim() || (report.references?.length ?? 0) > 0,
  );
  return !hasExplicitRef;
}

function resolveLineageAdminRootForTask(
  task: LedgerTaskRecord,
  tasks: LedgerTaskRecord[],
): LedgerTaskRecord | undefined {
  if (isAdminToPmRootTask(task)) return task;

  let current: LedgerTaskRecord | undefined = task;
  const seen = new Set<string>();
  while (current?.parent?.trim()) {
    const pNorm = normalizeId(current.parent);
    if (seen.has(pNorm)) break;
    seen.add(pNorm);
    const parentTask = tasks.find(
      (t) =>
        t.task_id === pNorm ||
        t.filename.replace(/\.md$/i, "") === pNorm ||
        adminRootMatchesId(t, pNorm),
    );
    if (!parentTask) break;
    if (isAdminToPmRootTask(parentTask)) return parentTask;
    current = parentTask;
  }
  return undefined;
}

/** 同一 thread_key 下多个 ADMIN root 时按 lineage 分桶，避免错链。 */
export function resolveThreadBucketKey(
  task: LedgerTaskRecord,
  tasks: LedgerTaskRecord[],
): string {
  const lineageRoot = resolveLineageAdminRootForTask(task, tasks);
  if (lineageRoot) {
    const rootTk =
      lineageRoot.thread_key?.trim() || `_orphan_${lineageRoot.task_id}`;
    const adminRootsOnRootTk = tasks.filter(
      (t) =>
        isAdminToPmRootTask(t) &&
        (t.thread_key?.trim() || `_orphan_${t.task_id}`) === rootTk,
    );
    if (adminRootsOnRootTk.length > 1) {
      return `${rootTk}#${taskIdPrefix(lineageRoot.task_id)}`;
    }
    return rootTk;
  }

  const tk = task.thread_key?.trim();
  if (!tk) return `_orphan_${task.task_id}`;

  const adminRoots = tasks.filter(
    (t) => isAdminToPmRootTask(t) && (t.thread_key?.trim() || "") === tk,
  );
  if (adminRoots.length <= 1) return tk;

  if (isAdminToPmRootTask(task)) {
    return `${tk}#${taskIdPrefix(task.task_id)}`;
  }
  return `_orphan_${task.task_id}`;
}

/** 自动关单 / submit_review 用的 root 解析（禁止「thread 下第一个无 parent PM 任务」）。 */
export function resolveSettlementRootId(
  trigger: LedgerTaskRecord,
  tasks: LedgerTaskRecord[],
): string | undefined {
  if (isAdminToPmRootTask(trigger) && !trigger.parent) {
    return trigger.task_id;
  }

  if (trigger.parent?.trim()) {
    return findAdminRootTask(tasks, {
      rootTaskId: trigger.parent,
      references: [trigger.parent],
    })?.task_id;
  }

  if (trigger.thread_key?.trim()) {
    return findAdminRootTask(tasks, {
      threadKey: trigger.thread_key.trim(),
    })?.task_id;
  }

  return undefined;
}

/** 按 date-seq / thread / references 解析 ADMIN→PM root（禁止落到 PM 子任务）。 */
export function findAdminRootTask(
  tasks: LedgerTaskRecord[],
  opts?: {
    threadKey?: string;
    dateSeqPrefix?: string;
    rootTaskId?: string;
    references?: string[];
  },
): LedgerTaskRecord | undefined {
  const candidates = tasks.filter(isAdminToPmRootTask);
  if (!candidates.length) return undefined;

  const refHits: LedgerTaskRecord[] = [];
  for (const ref of opts?.references ?? []) {
    for (const hit of candidates) {
      if (adminRootMatchesId(hit, ref)) {
        if (!refHits.some((t) => t.task_id === hit.task_id)) refHits.push(hit);
        continue;
      }
      if (reportMatchScore(hit, ref) >= 80) {
        if (!refHits.some((t) => t.task_id === hit.task_id)) refHits.push(hit);
      }
    }
  }
  if (refHits.length === 1) return refHits[0];
  if (refHits.length > 1) return undefined;

  if (opts?.rootTaskId) {
    const hits = candidates.filter((t) =>
      adminRootMatchesId(t, opts.rootTaskId!),
    );
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return undefined;
  }

  if (opts?.dateSeqPrefix) {
    const prefix = taskIdPrefix(opts.dateSeqPrefix);
    const hits = candidates.filter((t) => taskIdPrefix(t.task_id) === prefix);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return undefined;
  }

  if (opts?.threadKey) {
    const hits = candidates.filter(
      (t) => (t.thread_key?.trim() || "") === opts.threadKey!.trim(),
    );
    if (hits.length === 1) return hits[0];
    return undefined;
  }

  return undefined;
}

function matchWorkerReportToTasks(
  report: LedgerReportRecord,
  candidates: LedgerTaskRecord[],
  opts?: {
    reportBody?: string;
    taskBodies?: Map<string, string>;
  },
): LedgerTaskRecord | undefined {
  if (!candidates.length) return undefined;

  // REPORT frontmatter task_id/source_task_id is the authoritative owner.
  // Rework reports commonly mention rejected predecessor tasks in references
  // and body text; those historical links must not steal the report when the
  // explicit owner exists in the ledger.
  const explicitOwnerIds = uniqueIds([
    report.source_task_id ?? "",
    report.task_id,
  ]);
  for (const ownerId of explicitOwnerIds) {
    const exact = candidates.filter((task) => {
      const taskId = normalizeId(task.task_id).toUpperCase();
      const filenameId = normalizeId(task.filename).toUpperCase();
      const owner = normalizeId(ownerId).toUpperCase();
      return taskId === owner || filenameId === owner;
    });
    if (exact.length === 1) return exact[0];
  }

  const refs = [
    report.task_id,
    ...(report.references ?? []),
    inferReportTaskIdFromFilename(report.filename),
    reportDateSeqTaskPrefix(report),
  ].filter(Boolean);

  let best: LedgerTaskRecord | undefined;
  let bestScore = 0;
  for (const child of candidates) {
    for (const ref of refs) {
      const score = reportMatchScore(child, ref);
      if (score > bestScore) {
        bestScore = score;
        best = child;
      }
    }
  }
  if (bestScore > 0) return best;
  const bodyMatch = matchWorkerReportToTaskBody(
    opts?.reportBody,
    candidates,
    opts?.taskBodies,
  );
  if (bodyMatch) return bodyMatch;
  const recent = matchWorkerReportToRecentOpenTask(report, candidates);
  if (recent) return recent;
  return candidates.length === 1 ? candidates[0] : undefined;
}

function getTaskBody(
  task: LedgerTaskRecord,
  taskBodies: Map<string, string> | undefined,
): string {
  if (!taskBodies) return "";
  return (
    taskBodies.get(task.path) ??
    taskBodies.get(task.task_id) ??
    taskBodies.get(task.filename) ??
    ""
  );
}

const BODY_MATCH_STOPWORDS = new Set([
  "task",
  "report",
  "status",
  "done",
  "workspace",
  "codeflowmu",
  "sender",
  "recipient",
  "created_at",
  "updated_at",
  "thread_key",
  "references",
  "protocol",
  "version",
]);

function meaningfulTokens(text: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const raw of String(text ?? "").toLowerCase().match(/[a-z0-9][a-z0-9_.-]{3,}/g) ?? []) {
    const token = raw.replace(/^[-_.]+|[-_.]+$/g, "");
    if (!token || BODY_MATCH_STOPWORDS.has(token)) continue;
    if (/^\d{4,}$/.test(token)) continue;
    out.add(token);
  }
  return out;
}

function bodyMatchScore(reportBody: string | undefined, taskBody: string): number {
  const reportTokens = meaningfulTokens(reportBody);
  if (!reportTokens.size) return 0;
  const taskTokens = meaningfulTokens(taskBody);
  let score = 0;
  for (const token of reportTokens) {
    if (taskTokens.has(token)) score += token.length >= 8 ? 3 : 1;
  }
  return score;
}

function matchWorkerReportToTaskBody(
  reportBody: string | undefined,
  candidates: LedgerTaskRecord[],
  taskBodies: Map<string, string> | undefined,
): LedgerTaskRecord | undefined {
  if (!reportBody || !taskBodies?.size) return undefined;
  const scored = candidates
    .map((task) => ({
      task,
      score: bodyMatchScore(reportBody, getTaskBody(task, taskBodies)),
    }))
    .filter((row) => row.score >= 6)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return undefined;
  if (scored.length > 1 && scored[0]!.score === scored[1]!.score) {
    return undefined;
  }
  return scored[0]!.task;
}

function timestampMs(value: string | undefined): number {
  if (!value) return 0;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : 0;
}

function openTaskPriority(task: LedgerTaskRecord): number {
  const bucket = task.bucket.toLowerCase();
  const display = String(task.display_status ?? "").toLowerCase();
  if (display === "waiting_pm_attention") return 0;
  if (bucket === "active" || bucket === "review" || bucket === "inbox") return 1;
  if (bucket === "tasks") return 2;
  if (bucket === "done") return 5;
  return 9;
}

function matchWorkerReportToRecentOpenTask(
  report: LedgerReportRecord,
  candidates: LedgerTaskRecord[],
): LedgerTaskRecord | undefined {
  const reportTime = timestampMs(report.created_at_utc) || timestampMs(report.created_at);
  const ranked = candidates
    .map((task) => {
      const taskTime = timestampMs(task.created_at_utc) || timestampMs(task.created_at);
      const age = reportTime && taskTime ? reportTime - taskTime : 0;
      return { task, age, priority: openTaskPriority(task) };
    })
    .filter(({ age }) => !reportTime || age >= -5 * 60 * 1000)
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.age !== b.age) return a.age - b.age;
      return b.task.task_id.localeCompare(a.task.task_id);
    });
  return ranked[0]?.task;
}

/** worker REPORT 必须挂到 PM→{sender} 子任务。 */
export function findPmDownstreamChildForWorkerReport(
  report: LedgerReportRecord,
  tasks: LedgerTaskRecord[],
  opts?: {
    reportBody?: string;
    taskBodies?: Map<string, string>;
  },
): LedgerTaskRecord | undefined {
  const workerRole = report.sender.toUpperCase();
  const children = tasks.filter(
    (t) =>
      isPmDownstreamChildTask(t) &&
      t.recipient.toUpperCase() === workerRole,
  );
  return matchWorkerReportToTasks(report, children, opts);
}

/** Hot path worker REPORT 挂到 {sender}-to-PM 任务本身。 */
export function findHotPathWorkerTaskForReport(
  report: LedgerReportRecord,
  tasks: LedgerTaskRecord[],
  opts?: {
    reportBody?: string;
    taskBodies?: Map<string, string>;
  },
): LedgerTaskRecord | undefined {
  const workerRole = report.sender.toUpperCase();
  const candidates = tasks.filter(
    (t) =>
      isHotPathWorkerToPmTask(t) &&
      t.sender.toUpperCase() === workerRole,
  );
  return matchWorkerReportToTasks(report, candidates, opts);
}

/** PM→worker 子任务优先；无匹配时回退 hot path {worker}-to-PM。 */
export function findWorkerReportLinkedTask(
  report: LedgerReportRecord,
  tasks: LedgerTaskRecord[],
  opts?: {
    reportBody?: string;
    taskBodies?: Map<string, string>;
  },
): LedgerTaskRecord | undefined {
  return (
    findPmDownstreamChildForWorkerReport(report, tasks, opts) ??
    findHotPathWorkerTaskForReport(report, tasks, opts)
  );
}

const PM_FINAL_SUMMARY_TERMINAL_STATUSES = new Set([
  "done",
  "completed",
  "blocked",
  "needs_admin",
  "failed",
]);

function normalizeReportStatus(status: string | undefined): string {
  return String(status ?? "")
    .trim()
    .toLowerCase();
}

/** PM-to-ADMIN final summary 允许的 terminal status（非 in_progress / dispatching）。 */
export function isPmFinalSummaryTerminalStatus(status: string | undefined): boolean {
  return PM_FINAL_SUMMARY_TERMINAL_STATUSES.has(normalizeReportStatus(status));
}

/** in_progress / dispatching 等非 final 状态。 */
export function isPmNonFinalAdminReportStatus(status: string | undefined): boolean {
  const norm = normalizeReportStatus(status);
  if (!norm) return false;
  if (norm === "in_progress" || norm === "dispatching") return true;
  if (/in[_-]?progress/.test(norm)) return true;
  return /dispatching/.test(norm);
}

export function hasPmFinalSummaryFrontmatter(report: LedgerReportRecord): boolean {
  if (report.report_type?.trim() === "final_summary") return true;
  return report.final === true;
}

export function classifyReportKind(
  report: LedgerReportRecord,
  body?: string,
): LedgerReportKind {
  if (isWorkerReportToPm(report.filename, report.sender, report.recipient)) {
    return "worker_to_pm";
  }
  if (isPmToAdminReport(report.sender, report.recipient)) {
    if (isPmNonFinalAdminReportStatus(report.status)) {
      return "pm_to_admin_in_progress";
    }
    const terminal = isPmFinalSummaryTerminalStatus(report.status);
    const explicitFinal = hasPmFinalSummaryFrontmatter(report);
    const ack = body
      ? isAckOnlyReportBody(body)
      : !terminal && !explicitFinal;
    if (explicitFinal && terminal) return "pm_to_admin_final";
    if (terminal && !ack) return "pm_to_admin_final";
    if (
      report.status === "in_progress" ||
      /in[_-]?progress/i.test(String(report.status))
    ) {
      return "pm_to_admin_in_progress";
    }
    return "pm_to_admin_ack";
  }
  return "other";
}

export function isPmAdminFinalSummaryReport(
  rootId: string,
  report: LedgerReportRecord,
  body?: string,
): boolean {
  if (!isPmToAdminReport(report.sender, report.recipient)) return false;
  if (!reportBoundToAdminRoot(rootId, report)) return false;
  if (report.report_kind === "pm_to_admin_in_progress") return false;
  if (isPmNonFinalAdminReportStatus(report.status)) return false;
  if (/-reciprocal/i.test(report.filename ?? "")) return false;
  if (/-AUTO-/i.test(report.report_id ?? report.filename)) return false;
  if (body && isAckOnlyReportBody(body)) return false;

  const terminal = isPmFinalSummaryTerminalStatus(report.status);
  const explicitFinal = hasPmFinalSummaryFrontmatter(report);

  if (report.report_kind === "pm_to_admin_ack" && !explicitFinal) return false;
  if (!terminal) return false;

  if (report.report_kind === "pm_to_admin_final") return true;
  if (explicitFinal) return true;
  return true;
}

export interface ApplyReportParentingOpts {
  reportBodies?: Map<string, string>;
  taskBodies?: Map<string, string>;
}

function uniqueIds(ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const n = normalizeId(id);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** 校正 parent_task_id / report_kind / linked_task_ids，并规范化 task_id 用于列表查询。 */
export function applyReportParenting(
  reports: LedgerReportRecord[],
  tasks: LedgerTaskRecord[],
  opts?: ApplyReportParentingOpts,
): LedgerReportRecord[] {
  return reports.map((r) => {
    const body =
      opts?.reportBodies?.get(r.path) ??
      opts?.reportBodies?.get(r.report_id);
    const kind = classifyReportKind(r, body);

    if (kind.startsWith("pm_to_admin")) {
      const dateSeq =
        r.task_id ||
        inferReportTaskIdFromFilename(r.filename) ||
        taskIdPrefix(r.report_id);
      const adminRoot =
        findAdminRootTask(tasks, {
          threadKey: r.thread_key,
          dateSeqPrefix: dateSeq,
          rootTaskId: r.task_id,
          references: r.references,
        }) ?? undefined;

      if (adminRoot) {
        const linked = uniqueIds([
          adminRoot.task_id,
          ...(r.references ?? []),
          r.task_id,
        ]);
        return {
          ...r,
          task_id: taskIdPrefix(adminRoot.task_id),
          parent_task_id: adminRoot.task_id,
          linked_task_ids: linked,
          report_kind: kind,
        };
      }
      return { ...r, report_kind: kind };
    }

    if (kind === "worker_to_pm") {
      const bodyRefs = extractTaskRefsFromText(body);
      const reportForMatch =
        bodyRefs.length > 0
          ? { ...r, references: uniqueIds([...(r.references ?? []), ...bodyRefs]) }
          : r;
      const child = findWorkerReportLinkedTask(reportForMatch, tasks, {
        reportBody: body,
        taskBodies: opts?.taskBodies,
      });
      if (child) {
        const linked = uniqueIds([
          child.task_id,
          ...(reportForMatch.references ?? []),
          r.task_id,
        ]);
        return {
          ...r,
          task_id: child.task_id,
          parent_task_id: child.task_id,
          linked_task_ids: linked,
          report_kind: kind,
        };
      }
      return { ...r, report_kind: kind };
    }

    return { ...r, report_kind: kind };
  });
}

/** listReportsForTask / 面板挂树：parent_task_id 优先。 */
export function reportBelongsToLedgerTask(
  report: LedgerReportRecord,
  taskId: string,
  tasks: LedgerTaskRecord[],
): boolean {
  const norm = normalizeId(taskId);
  if (!norm) return false;

  const sourceTaskId = normalizeId(report.source_task_id ?? "");
  if (sourceTaskId && taskIdMatchesPrefix(sourceTaskId, norm)) return true;

  const parent = report.parent_task_id?.trim();
  if (parent) {
    if (parent === norm || taskIdMatchesPrefix(parent, norm)) return true;
    if (norm === parent || taskIdMatchesPrefix(norm, parent)) return true;
    return false;
  }

  if (isPmToAdminReport(report.sender, report.recipient)) {
    const admin = tasks.find(
      (t) =>
        (t.task_id === norm || adminRootMatchesId(t, norm)) &&
        isAdminToPmRootTask(t),
    );
    if (!admin) return false;
    return reportBoundToAdminRoot(admin.task_id, report);
  }

  const tid = normalizeId(report.task_id);
  if (tid === norm) return true;
  if (tid.startsWith(`${norm}-`) || norm.startsWith(`${tid}-`)) return true;
  return false;
}
