import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, join, relative } from "node:path";

import { resolveEnvelopeTimestamps, toLocalIsoString } from "../_internal/local-iso.ts";
import { isGovernanceReportToPm, isWorkerReportToPm } from "../fcop/governance.ts";
import { TaskFrontmatterStore } from "../lifecycle/TaskFrontmatterStore.ts";
import {
  isAdminMainlineTaskFilename,
  isClosedParentResidueTask,
  isParentTaskClosed,
} from "../lifecycle/closedParentResidue.ts";
import {
  inferReportTaskIdFromBody,
  inferReportTaskIdFromFilename,
  listField,
  parseMarkdownFrontmatter,
  strField,
} from "./frontmatter.ts";
import { areAllChildrenSettledForRoot } from "./lifecycleProjection.ts";
import { resolveTaskCurrentBucket } from "../pm/taskCurrentBucket.ts";
import { isTaskWorkflowSealedForPmReview } from "./taskWorkflowSeal.ts";
import { resolveReviewLinkedTaskId } from "../review/resolveReviewLinkedTaskId.ts";
import { ensureLedgerLayout, resolveLedgerLayout } from "./paths.ts";
import {
  readLedgerTasksJsonl,
  reconcileTaskDiagnostics,
  writeDiagnosticsJsonl,
} from "./reconcileDiagnostics.ts";
import { taskSequenceKey } from "./taskIdMatch.ts";
import {
  applyReportParenting,
  findAdminRootTask,
  findWorkerReportLinkedTask,
  isPmToAdminReport,
  isAdminToPmRootTask,
  reportBelongsToLedgerTask,
  resolveThreadBucketKey,
} from "./reportParenting.ts";
import {
  applyCanonicalPmFinalReportKinds,
  selectCanonicalPmFinalReport,
} from "./selectCanonicalPmFinalReport.ts";
import { isProbeBootstrapLedgerTask } from "./probeBootstrapTask.ts";
import { isTaskReopenedForReworkFromLedger } from "./taskReworkSemantics.ts";
import type {
  LedgerLifecycleBucket,
  LedgerOrphanRecord,
  LedgerReportRecord,
  LedgerTaskRecord,
  LedgerThreadRecord,
} from "./types.ts";
import { evaluateQaReportAcceptance } from "../pm/qaAcceptanceFromReport.ts";
import { isDependencyPendingReport } from "./reportDependencyOutcome.ts";

const TASK_FILE_RE = /^TASK-\d{8}-\d{3,}-/i;
const REPORT_FILE_RE = /^REPORT-\d{8}-\d{3,}-/i;

function normalizeTaskId(taskId: string): string {
  return taskId.replace(/\.md$/i, "").trim();
}

export interface LedgerBuilderOpts {
  projectRoot: string;
}

export interface LedgerRebuildResult {
  tasks: number;
  reports: number;
  threads: number;
  viewsWritten: number;
  /** ledger_orphan count written to diagnostics.jsonl */
  orphans?: number;
  /** total diagnostics lines persisted */
  diagnostics?: number;
}

async function walkMdFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await walkMdFiles(full)));
    } else if (ent.isFile() && ent.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

function canonicalTaskId(filename: string, fm: Record<string, unknown>): string {
  const fromFm = strField(fm, "task_id");
  const base = (fromFm || basename(filename, ".md")).replace(/\.md$/i, "");
  const m = /^TASK-\d{8}-\d{3,}/i.exec(base);
  return m ? m[0].toUpperCase() : base;
}

/** Resolve the strong task-tree relation. Weak references never imply a parent. */
function resolveTaskParentFromFm(
  fm: Record<string, unknown>,
  _selfTaskId: string,
): string | undefined {
  const explicit = strField(fm, "parent").trim();
  if (!explicit) return undefined;
  const stripped = explicit.replace(/\.md$/i, "").trim();
  const m = /^TASK-\d{8}-\d{3,}/i.exec(stripped);
  return m ? m[0].toUpperCase() : stripped;
}

function canonicalReportId(filename: string, fm: Record<string, unknown>): string {
  const fromFm = strField(fm, "report_id");
  if (fromFm) return fromFm.replace(/\.md$/i, "");
  return basename(filename, ".md");
}

function recipientMatches(recordRecipient: string, filter: string): boolean {
  const r = recordRecipient.trim().toUpperCase();
  const f = filter.trim().toUpperCase();
  if (!f) return true;
  if (f === "TEAM") return true;
  if (r === f) return true;
  if (r.startsWith(`${f}.`)) return true;
  return false;
}

function isAdminMainlineFilename(filename: string): boolean {
  return /-ADMIN-to-PM/i.test(filename);
}

/** Rework / same-role respawn must not steal reports keyed by date-seq only. */
function isSpuriousShortIdExtensionMatch(
  task: LedgerTaskRecord,
  norm: string,
): boolean {
  if (!task.task_id.startsWith(`${norm}-`)) return false;
  const fn = task.filename;
  if (/-rework-/i.test(fn)) return true;
  if (/-OPS-to-OPS-/i.test(fn)) return true;
  return false;
}

/** Match ledger task row to report frontmatter task_id (short id vs full routing id). */
function taskIdMatchesReportTask(
  task: LedgerTaskRecord,
  reportTaskId: string,
): boolean {
  const norm = reportTaskId.replace(/\.md$/i, "").trim();
  if (!norm) return false;
  const baseName = task.filename.replace(/\.md$/i, "");
  if (baseName === norm) return true;
  if (task.task_id === norm) return true;
  if (norm.startsWith(`${task.task_id}-`)) return true;
  // REPORT 侧 task_id 常为短前缀 TASK-YYYYMMDD-NNN（如 PM ack 文件名推断）
  if (task.task_id.startsWith(`${norm}-`)) {
    if (isSpuriousShortIdExtensionMatch(task, norm)) return false;
    return true;
  }
  if (baseName.startsWith(`${norm}-`)) return true;
  return false;
}

function reportTaskMatchScore(task: LedgerTaskRecord, ref: string): number {
  const norm = ref.replace(/\.md$/i, "").trim();
  if (!norm) return 0;
  const baseName = task.filename.replace(/\.md$/i, "");
  if (task.task_id === norm || baseName === norm) {
    if (/-rework-/i.test(task.filename) || /-OPS-to-OPS-/i.test(task.filename)) {
      return 90;
    }
    return 100;
  }
  if (norm.startsWith(`${task.task_id}-`)) return 80;
  if (task.task_id.startsWith(`${norm}-`)) {
    if (isSpuriousShortIdExtensionMatch(task, norm)) return 0;
    return 60;
  }
  if (baseName.startsWith(`${norm}-`)) return 50;
  return 0;
}

function findTaskByParentRef(
  tasks: LedgerTaskRecord[],
  parentRef: string,
): LedgerTaskRecord | undefined {
  let best: LedgerTaskRecord | undefined;
  let bestScore = 0;
  for (const t of tasks) {
    const score = reportTaskMatchScore(t, parentRef);
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return bestScore > 0 ? best : undefined;
}

function pickThreadRootTaskId(threadTasks: LedgerTaskRecord[]): string | undefined {
  const rootless = threadTasks.filter((t) => !t.parent);
  if (!rootless.length) return undefined;
  const admin = rootless.find((t) => isAdminMainlineFilename(t.filename));
  if (admin) return admin.task_id;
  return rootless
    .map((t) => t.task_id)
    .sort()
    .at(-1);
}

/** Resolve root within one thread; canonicalTaskId() can collide across files (e.g. 002 base vs 002-rework). */
function findRootTaskInThread(
  tasks: LedgerTaskRecord[],
  threadTaskIds: readonly string[],
  rootId: string,
): LedgerTaskRecord | undefined {
  const idSet = new Set(threadTaskIds);
  let best: LedgerTaskRecord | undefined;
  let bestScore = 0;
  for (const t of tasks) {
    if (!idSet.has(t.task_id)) continue;
    const score = reportTaskMatchScore(t, rootId);
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return bestScore > 0 ? best : undefined;
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

function reportTaskSeq(id: string): string {
  const m = id.replace(/\.md$/i, "").trim().match(/^(?:TASK|REPORT)-\d{8}-(\d{3})/i);
  return m?.[1] ?? "";
}

/** Warn when frontmatter task_id and references disagree (true link conflicts only). */
export function detectReportTaskLinkMismatch(
  filename: string,
  fm: Record<string, unknown>,
  _resolvedTaskId: string,
): string | undefined {
  const references = listField(fm, "references")
    .map((r) => r.replace(/\.md$/i, "").trim())
    .filter(Boolean);
  const fmTaskId = strField(fm, "task_id").replace(/\.md$/i, "").trim();

  if (fmTaskId && references[0] && fmTaskId !== references[0]) {
    const fmSeq = reportTaskSeq(fmTaskId);
    const rSeq = reportTaskSeq(references[0]);
    if (fmSeq && rSeq && fmSeq !== rSeq) {
      return `task_id ${fmTaskId} vs references[0] ${references[0]}`;
    }
  }
  return undefined;
}

function isWaitingPmAttentionTask(task: LedgerTaskRecord): boolean {
  return (
    String(task.display_status ?? "").toLowerCase() === "waiting_pm_attention"
  );
}

function tasksMatchingReportRefs(
  report: LedgerReportRecord,
  tasks: LedgerTaskRecord[],
): LedgerTaskRecord[] {
  if (isPmToAdminReport(report.sender, report.recipient)) {
    const root = findAdminRootTask(tasks, {
      threadKey: report.thread_key,
      dateSeqPrefix: report.task_id || report.report_id,
      rootTaskId: report.task_id,
      references: report.references,
    });
    return root ? [root] : [];
  }
  if (isWorkerReportToPm(report.filename, report.sender, report.recipient)) {
    const child = findWorkerReportLinkedTask(report, tasks);
    return child ? [child] : [];
  }

  const refs = reportTaskRefIds(report);
  if (!refs.length) return [];
  const byId = new Map<string, LedgerTaskRecord>();
  for (const ref of refs) {
    let best: LedgerTaskRecord | undefined;
    let bestScore = 0;
    for (const t of tasks) {
      const score = reportTaskMatchScore(t, ref);
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    if (best && bestScore > 0 && !byId.has(best.task_id)) {
      byId.set(best.task_id, best);
    }
  }
  return [...byId.values()];
}

function resolveReportThreadKey(
  report: LedgerReportRecord,
  tasks: LedgerTaskRecord[],
): string {
  if (isPmToAdminReport(report.sender, report.recipient)) {
    if (report.parent_task_id?.trim()) {
      const parentTask = tasks.find(
        (t) =>
          t.task_id === report.parent_task_id ||
          t.filename.replace(/\.md$/i, "") === report.parent_task_id,
      );
      if (parentTask) return resolveThreadBucketKey(parentTask, tasks);
    }
    const root = findAdminRootTask(tasks, {
      threadKey: report.thread_key,
      dateSeqPrefix: report.task_id || report.report_id,
      rootTaskId: report.task_id,
      references: report.references,
    });
    if (root) return resolveThreadBucketKey(root, tasks);
  }
  if (isWorkerReportToPm(report.filename, report.sender, report.recipient)) {
    const child = findWorkerReportLinkedTask(report, tasks);
    if (child) return resolveThreadBucketKey(child, tasks);
  }

  const matched = tasksMatchingReportRefs(report, tasks);
  if (matched.length === 1) {
    return resolveThreadBucketKey(matched[0]!, tasks);
  }

  const explicit = report.thread_key?.trim();
  if (explicit) {
    const sameThreadAdminRoots = tasks.filter(
      (t) =>
        isAdminToPmRootTask(t) &&
        (t.thread_key?.trim() || "") === explicit,
    );
    if (
      isPmToAdminReport(report.sender, report.recipient) &&
      sameThreadAdminRoots.length > 1
    ) {
      return `_orphan_${report.report_id}`;
    }
    return explicit;
  }

  const matchedWithThread = matched.filter((t) => t.thread_key?.trim());
  if (matchedWithThread.length === 1) {
    return resolveThreadBucketKey(matchedWithThread[0]!, tasks);
  }
  return `_orphan_${report.report_id}`;
}

function bucketFromPath(
  filePath: string,
  lifecycleRoot: string,
): LedgerLifecycleBucket {
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

export class LedgerBuilder {
  readonly #projectRoot: string;

  constructor(opts: LedgerBuilderOpts) {
    this.#projectRoot = opts.projectRoot;
  }

  /** Compare on-disk TASK files with fcop/ledger/tasks.jsonl (task_id + bucket). */
  async detectStale(): Promise<boolean> {
    const layout = resolveLedgerLayout(this.#projectRoot);
    const jsonlPath = join(layout.ledgerDir, "tasks.jsonl");

    const diskTasks = await this.#collectTasks(layout);
    const diskById = new Map(
      diskTasks.map((t) => [taskSequenceKey(t.task_id), t] as const),
    );

    let ledgerTasks: LedgerTaskRecord[] = [];
    try {
      const raw = await fs.readFile(jsonlPath, "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          ledgerTasks.push(JSON.parse(line) as LedgerTaskRecord);
        } catch {
          /* skip corrupt line */
        }
      }
    } catch {
      return diskTasks.length > 0;
    }

    const ledgerById = new Map(
      ledgerTasks.map((t) => [taskSequenceKey(t.task_id), t] as const),
    );

    if (diskById.size !== ledgerById.size) return true;
    for (const [id, dt] of diskById) {
      const lt = ledgerById.get(id);
      if (!lt) return true;
      if (lt.bucket !== dt.bucket) return true;
      if (lt.filename !== dt.filename) return true;
    }
    for (const id of ledgerById.keys()) {
      if (!diskById.has(id)) return true;
    }
    return false;
  }

  /** True when role todo views omit rows that #roleTodoTasks would render. */
  async detectViewsStale(): Promise<boolean> {
    const layout = resolveLedgerLayout(this.#projectRoot);
    const tasks = await this.#readTasksJsonl();
    if (!tasks.length) return false;
    for (const role of ["PM", "DEV", "OPS", "QA"] as const) {
      const expected = this.#roleTodoTasks(role, tasks);
      const viewPath = join(layout.ledgerDir, "views", `${role}.todo.md`);
      let raw = "";
      try {
        raw = await fs.readFile(viewPath, "utf-8");
      } catch {
        return true;
      }
      if (!expected.length) {
        if (!raw.includes("（暂无任务）")) return true;
        continue;
      }
      if (raw.includes("（暂无任务）")) return true;
      for (const t of expected) {
        if (!raw.includes(t.task_id)) return true;
      }
    }
    return false;
  }

  async #readTasksJsonl(): Promise<LedgerTaskRecord[]> {
    const layout = resolveLedgerLayout(this.#projectRoot);
    const jsonlPath = join(layout.ledgerDir, "tasks.jsonl");
    try {
      const raw = await fs.readFile(jsonlPath, "utf-8");
      const tasks: LedgerTaskRecord[] = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          tasks.push(JSON.parse(line) as LedgerTaskRecord);
        } catch {
          /* skip corrupt line */
        }
      }
      return tasks;
    } catch {
      return [];
    }
  }

  /** Same row set as fcop/ledger/views/{role}.todo.md body lines (excludes probe bootstrap). */
  #roleTodoTasks(
    role: "PM" | "OPS" | "DEV" | "QA",
    tasks: LedgerTaskRecord[],
  ): LedgerTaskRecord[] {
    const currentBucket = (t: LedgerTaskRecord): string =>
      resolveTaskCurrentBucket({
        bucket: t.bucket,
        path: t.path,
        physical_scope: t.physical_scope,
      });
    const isAdminToPmMainline = (t: LedgerTaskRecord): boolean =>
      /-ADMIN-to-PM/i.test(t.filename ?? "");
    const isAdminRejected = (t: LedgerTaskRecord): boolean =>
      isTaskReopenedForReworkFromLedger(t);
    const isReviewApproved = (t: LedgerTaskRecord): boolean =>
      String(t.review_status ?? "").trim().toLowerCase() === "approved";
    const includeTasksBucket = (
      t: LedgerTaskRecord,
      r: "PM" | "OPS" | "DEV" | "QA",
    ): boolean => {
      if (t.bucket !== "tasks") return false;
      if (r === "PM") return isAdminRejected(t);
      return !isReviewApproved(t);
    };

    return tasks.filter(
      (t) =>
        !isProbeBootstrapLedgerTask(t) &&
        recipientMatches(t.recipient, role) &&
        !this.#isResidueExcludedFromWorkerTodo(t, tasks) &&
        (currentBucket(t) === "inbox" ||
          currentBucket(t) === "active" ||
          (role === "PM" &&
            currentBucket(t) === "review" &&
            isAdminRejected(t)) ||
          includeTasksBucket(t, role)) &&
        !(
          role === "PM" &&
          isAdminToPmMainline(t) &&
          currentBucket(t) === "review" &&
          !isAdminRejected(t)
        ),
    );
  }

  /** Rebuild ledger when on-disk tasks diverge from tasks.jsonl or views lag jsonl. */
  async ensureFresh(): Promise<boolean> {
    const stale =
      (await this.detectStale()) || (await this.detectViewsStale());
    if (!stale) return false;
    await this.rebuild();
    return true;
  }

  async rebuild(): Promise<LedgerRebuildResult> {
    const layout = await ensureLedgerLayout(this.#projectRoot);
    const tasksJsonlPath = join(layout.ledgerDir, "tasks.jsonl");
    const priorLedger = await readLedgerTasksJsonl(tasksJsonlPath);
    const diskTasks = await this.#collectTasks(layout);
    const reconciled = reconcileTaskDiagnostics(diskTasks, priorLedger, {
      detectedAt: toLocalIsoString(new Date()),
      projectRoot: this.#projectRoot,
    });
    const tasks = reconciled.normalTasks;
    const taskBodies = new Map<string, string>();
    for (const t of tasks) {
      try {
        const content = await fs.readFile(join(this.#projectRoot, t.path), "utf-8");
        taskBodies.set(t.path, content);
        taskBodies.set(t.task_id, content);
        taskBodies.set(t.filename, content);
      } catch {
        /* skip unreadable task */
      }
    }
    const rawReports = await this.#collectReports(layout);
    const reportBodies = new Map<string, string>();
    for (const r of rawReports) {
      try {
        const content = await fs.readFile(r.path, "utf-8");
        reportBodies.set(r.path, content);
        reportBodies.set(r.report_id, content);
        reportBodies.set(r.filename, content);
      } catch {
        /* skip unreadable report */
      }
    }
    let reports = applyReportParenting(rawReports, tasks, {
      reportBodies,
      taskBodies,
    });
    reports = applyCanonicalPmFinalReportKinds(reports, tasks, reportBodies);
    const reviewApproved = await this.#loadHotPathReviewApproved(
      tasks,
      layout.reviewsDir,
      reports,
    );
    const threads = this.#buildThreads(tasks, reports, reviewApproved);

    const reportMismatchDiagnostics = reports
      .filter((r) => r.task_id_link_warning)
      .map((r) => ({
        id: `report_task_id_mismatch:${r.report_id}`,
        task_id: r.task_id,
        type: "report_task_id_mismatch" as const,
        severity: "warn" as const,
        title: "Report task_id link mismatch",
        message: r.task_id_link_warning ?? "",
        detected_at: toLocalIsoString(new Date()),
        visible: true,
      }));
    const diagnostics = [
      ...reconciled.diagnostics,
      ...reportMismatchDiagnostics,
    ];

    await fs.writeFile(
      join(layout.ledgerDir, "tasks.jsonl"),
      tasks.map((t) => JSON.stringify(t)).join("\n") +
        (tasks.length ? "\n" : ""),
      "utf-8",
    );
    await writeDiagnosticsJsonl(layout, diagnostics);
    await fs.writeFile(
      join(layout.ledgerDir, "reports.jsonl"),
      reports.map((r) => JSON.stringify(r)).join("\n") +
        (reports.length ? "\n" : ""),
      "utf-8",
    );
    await fs.writeFile(
      join(layout.ledgerDir, "threads.jsonl"),
      threads.map((t) => JSON.stringify(t)).join("\n") +
        (threads.length ? "\n" : ""),
      "utf-8",
    );

    const viewsWritten = await this.#writeViews(layout, tasks, reports, threads);
    // P1 TODO: context pack (current_snapshot.json + role views/*.context.md) — not in P0 scope

    return {
      tasks: tasks.length,
      reports: reports.length,
      threads: threads.length,
      viewsWritten,
      orphans: reconciled.summary.ledgerOrphanCount,
      diagnostics: diagnostics.filter((d) => d.visible !== false).length,
    };
  }

  async listTasks(
    recipient?: string,
    opts?: { pendingOnly?: boolean },
  ): Promise<LedgerTaskRecord[]> {
    const layout = resolveLedgerLayout(this.#projectRoot);
    const jsonlPath = join(layout.ledgerDir, "tasks.jsonl");
    let raw = "";
    try {
      raw = await fs.readFile(jsonlPath, "utf-8");
    } catch {
      const rebuilt = await this.rebuild();
      if (rebuilt.tasks === 0) return [];
      return this.listTasks(recipient);
    }

    const lines = raw.split("\n").filter((l) => l.trim());
    const tasks: LedgerTaskRecord[] = [];
    for (const line of lines) {
      try {
        tasks.push(JSON.parse(line) as LedgerTaskRecord);
      } catch {
        /* skip corrupt line */
      }
    }

    if (!recipient?.trim()) {
      return this.#filterPending(tasks, opts?.pendingOnly);
    }
    return this.#filterPending(tasks, opts?.pendingOnly).filter((t) =>
      recipientMatches(t.recipient, recipient),
    );
  }

  #filterPending(
    tasks: LedgerTaskRecord[],
    pendingOnly?: boolean,
  ): LedgerTaskRecord[] {
    if (pendingOnly === false) return tasks;
    const pending = new Set<LedgerLifecycleBucket>([
      "inbox",
      "active",
      "tasks",
    ]);
    return tasks.filter(
      (t) =>
        pending.has(t.bucket) && !this.#isResidueExcludedFromWorkerTodo(t, tasks),
    );
  }

  #isResidueExcludedFromWorkerTodo(
    t: LedgerTaskRecord,
    allTasks: LedgerTaskRecord[],
  ): boolean {
    const yaml = t.yaml ?? {};
    if (yaml.archived_by_parent_mainline === true) return true;
    if (isAdminMainlineTaskFilename(t.filename ?? "")) return false;
    const parentId = String(t.parent ?? "").trim();
    if (!parentId) {
      const yaml = t.yaml ?? {};
      return isClosedParentResidueTask(yaml, t.bucket, false);
    }
    const parent = allTasks.find(
      (p) =>
        p.task_id === parentId ||
        p.task_id.startsWith(`${parentId}-`) ||
        parentId.startsWith(`${p.task_id}-`),
    );
    const parentClosed = parent
      ? isParentTaskClosed(parent.yaml ?? {}, parent.bucket)
      : false;
    return isClosedParentResidueTask(t.yaml ?? {}, t.bucket, parentClosed);
  }

  async listReportsForTask(taskId: string): Promise<LedgerReportRecord[]> {
    const layout = resolveLedgerLayout(this.#projectRoot);
    const jsonlPath = join(layout.ledgerDir, "reports.jsonl");
    let raw = "";
    try {
      raw = await fs.readFile(jsonlPath, "utf-8");
    } catch {
      await this.rebuild();
      return this.listReportsForTask(taskId);
    }
    const norm = taskId.replace(/\.md$/i, "").trim();
    const tasks = await this.listTasks(undefined, { pendingOnly: false });
    const out: LedgerReportRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as LedgerReportRecord;
        if (reportBelongsToLedgerTask(r, norm, tasks)) {
          out.push(r);
        }
      } catch {
        /* skip */
      }
    }
    return out;
  }

  async #collectTasks(
    layout: ReturnType<typeof resolveLedgerLayout>,
    opts?: { oldLedgerTaskIds?: Set<string> },
  ): Promise<LedgerTaskRecord[]> {
    const scanDirs = [
      ...["inbox", "active", "review", "done", "archive"].map((s) =>
        join(layout.lifecycleRoot, s),
      ),
      layout.tasksDir,
    ];
    const seen = new Set<string>();
    const tasks: LedgerTaskRecord[] = [];

    for (const dir of scanDirs) {
      const files = await walkMdFiles(dir);
      for (const filePath of files) {
        const name = basename(filePath);
        if (!TASK_FILE_RE.test(name)) continue;
        const content = await fs.readFile(filePath, "utf-8");
        const fm = parseMarkdownFrontmatter(content);
        const stat = await fs.stat(filePath);
        const ts = resolveEnvelopeTimestamps(fm, stat.mtimeMs);
        const task_id = canonicalTaskId(name, fm);
        const parentResolved = resolveTaskParentFromFm(fm, task_id);
        const dedupeKey = `${task_id}:${filePath}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const relPath = relative(this.#projectRoot, filePath).replace(/\\/g, "/");
        const sync_status =
          opts?.oldLedgerTaskIds &&
          opts.oldLedgerTaskIds.size > 0 &&
          !opts.oldLedgerTaskIds.has(task_id)
            ? ("file_without_ledger" as const)
            : undefined;
        const transitionsRaw = fm.transitions;
        const transitions = Array.isArray(transitionsRaw)
          ? transitionsRaw
          : undefined;
        const physicalBucket = bucketFromPath(filePath, layout.lifecycleRoot);
        const settledPhysical =
          physicalBucket === "done" || physicalBucket === "archive";
        const normalizedFm = settledPhysical
          ? {
              ...fm,
              state: physicalBucket,
              lifecycle_projection: physicalBucket,
              lifecycle_path: `fcop/_lifecycle/${physicalBucket}`,
              display_status:
                physicalBucket === "archive" ? "archived" : "done",
            }
          : fm;

        tasks.push({
          task_id,
          filename: name,
          sender: strField(fm, "sender"),
          recipient: strField(fm, "recipient"),
          bucket: physicalBucket,
          path: relPath,
          created_at: ts.created_at,
          updated_at: ts.updated_at,
          timezone: ts.timezone,
          created_at_utc: ts.created_at_utc,
          yaml: normalizedFm,
          ...(transitions ? { transitions } : {}),
          ...(sync_status ? { sync_status } : {}),
          ...(strField(fm, "thread_key")
            ? { thread_key: strField(fm, "thread_key") }
            : {}),
          ...(parentResolved
            ? { parent: parentResolved, parent_task_id: parentResolved }
            : {}),
          ...(listField(fm, "related").length
            ? { related: listField(fm, "related") }
            : {}),
          ...(strField(normalizedFm, "state")
            ? { state: strField(normalizedFm, "state") }
            : {}),
          ...(strField(normalizedFm, "lifecycle_projection")
            ? {
                lifecycle_projection: strField(
                  normalizedFm,
                  "lifecycle_projection",
                ),
              }
            : {}),
          ...(strField(normalizedFm, "lifecycle_path")
            ? { lifecycle_path: strField(normalizedFm, "lifecycle_path") }
            : {}),
          ...(strField(normalizedFm, "review_status")
            ? { review_status: strField(normalizedFm, "review_status") }
            : {}),
          ...(strField(fm, "reopen_reason")
            ? { reopen_reason: strField(fm, "reopen_reason") }
            : {}),
          ...(typeof fm.reopened_count === "number" && fm.reopened_count > 0
            ? { reopened_count: fm.reopened_count }
            : {}),
          ...(strField(fm, "review_note")
            ? { review_note: strField(fm, "review_note") }
            : {}),
          ...(strField(normalizedFm, "display_status")
            ? { display_status: strField(normalizedFm, "display_status") }
            : {}),
          ...(strField(fm, "pm_attention_reason")
            ? { pm_attention_reason: strField(fm, "pm_attention_reason") }
            : {}),
          ...(strField(fm, "pm_attention_report_id")
            ? { pm_attention_report_id: strField(fm, "pm_attention_report_id") }
            : {}),
        });
      }
    }
    return tasks;
  }

  async #collectReports(
    layout: ReturnType<typeof resolveLedgerLayout>,
  ): Promise<LedgerReportRecord[]> {
    const scanDirs = [
      layout.reportsDir,
      join(layout.lifecycleRoot, "review"),
      join(layout.lifecycleRoot, "done"),
    ];
    const reports: LedgerReportRecord[] = [];
    const seen = new Set<string>();

    for (const dir of scanDirs) {
      const files = await walkMdFiles(dir);
      for (const filePath of files) {
        const name = basename(filePath);
        if (!REPORT_FILE_RE.test(name)) continue;
        const content = await fs.readFile(filePath, "utf-8");
        const fm = parseMarkdownFrontmatter(content);
        const stat = await fs.stat(filePath);
        const ts = resolveEnvelopeTimestamps(fm, stat.mtimeMs);
        const report_id = canonicalReportId(name, fm);
        if (seen.has(report_id)) continue;
        seen.add(report_id);

        const status =
          strField(fm, "status") ||
          (content.includes("status: done") ? "done" : "unknown");

        const references = listField(fm, "references");
        const report_type = strField(fm, "report_type");
        const finalMarker =
          fm.final === true ||
          String(fm.final ?? "").trim().toLowerCase() === "true";
        const autoFinalSummary =
          fm.auto_final_summary === true ||
          String(fm.auto_final_summary ?? "").trim().toLowerCase() === "true";
        const revision = Number(fm.revision ?? 0);
        const reworkRound = Number(fm.rework_round ?? 0);
        const submissionAttempt = Number(fm.submission_attempt ?? 0);
        const sourceTaskId = strField(fm, "source_task_id").replace(/\.md$/i, "");
        let task_id = (sourceTaskId || strField(fm, "task_id")).replace(/\.md$/i, "");
        if (!task_id && references.length) {
          task_id = references[0]!.replace(/\.md$/i, "");
        }
        if (!task_id) {
          task_id = inferReportTaskIdFromBody(content);
        }
        if (!task_id) {
          task_id = inferReportTaskIdFromFilename(name);
        }
        task_id = /^TASK-\d{8}-\d{3,}/i.exec(task_id)?.[0].toUpperCase() ?? task_id;

        const taskIdLinkWarning = detectReportTaskLinkMismatch(name, fm, task_id);
        const reportSender = strField(fm, "sender");
        const reportRecipient = strField(fm, "recipient");
        const reportBody = content.replace(/^---[\s\S]*?---\r?\n?/, "");
        const qaAcceptance = evaluateQaReportAcceptance({
          status,
          body: reportBody,
          sender: reportSender,
          recipient: reportRecipient,
        });
        const dependencyPending = isDependencyPendingReport({
          status,
          body: reportBody,
          explicitMarker: fm["dependency_pending"],
        });
        const qaBrowserVerified =
          fm["browser_verified"] === true ||
          String(fm["browser_verified"] ?? "").trim().toLowerCase() === "true" ||
          (/浏览器|browser|playwright|chromium|edge|chrome/i.test(reportBody) &&
            /模拟(?:用户)?操作|用户操作|交互|interaction|click|点击|流程/i.test(reportBody) &&
            /截图|screenshot|\.png\b|证据|evidence|qa-results|测试输出|命令输出/i.test(reportBody));

        reports.push({
          report_id,
          task_id,
          ...(sourceTaskId ? { source_task_id: sourceTaskId } : {}),
          filename: name,
          sender: reportSender,
          recipient: reportRecipient,
          status,
          ...(fm.valid !== undefined
            ? { valid: String(fm.valid).toLowerCase() !== "false" }
            : {}),
          ...(strField(fm, "invalidated_by")
            ? { invalidated_by: strField(fm, "invalidated_by") }
            : {}),
          ...(strField(fm, "invalid_reason")
            ? { invalid_reason: strField(fm, "invalid_reason") }
            : {}),
          ...(strField(fm, "superseded_by")
            ? { superseded_by: strField(fm, "superseded_by") }
            : {}),
          path: filePath,
          created_at: ts.created_at,
          updated_at: ts.updated_at,
          timezone: ts.timezone,
          created_at_utc: ts.created_at_utc,
          ...(strField(fm, "thread_key")
            ? { thread_key: strField(fm, "thread_key") }
            : {}),
          ...(references.length ? { references } : {}),
          ...(report_type ? { report_type } : {}),
          ...(finalMarker ? { final: true } : {}),
          ...(autoFinalSummary ? { auto_final_summary: true } : {}),
          ...(Number.isFinite(revision) && revision > 0 ? { revision } : {}),
          ...(Number.isFinite(reworkRound) && reworkRound >= 0
            ? { rework_round: reworkRound }
            : {}),
          ...(Number.isFinite(submissionAttempt) && submissionAttempt > 0
            ? { submission_attempt: submissionAttempt }
            : {}),
          ...(strField(fm, "revision_of")
            ? { revision_of: strField(fm, "revision_of") }
            : {}),
          ...(strField(fm, "supersedes")
            ? { supersedes: strField(fm, "supersedes") }
            : {}),
          ...(strField(fm, "content_hash")
            ? { content_hash: strField(fm, "content_hash") }
            : {}),
          ...(strField(fm, "client_submission_id")
            ? { client_submission_id: strField(fm, "client_submission_id") }
            : {}),
          ...(taskIdLinkWarning ? { task_id_link_warning: taskIdLinkWarning } : {}),
          ...(qaAcceptance ? { qa_verdict: qaAcceptance.verdict } : {}),
          ...(qaAcceptance ? { qa_browser_verified: qaBrowserVerified } : {}),
          ...(dependencyPending ? { dependency_pending: true } : {}),
        });
      }
    }
    return reports;
  }

  async #loadHotPathReviewApproved(
    tasks: LedgerTaskRecord[],
    reviewsDir: string,
    reports: LedgerReportRecord[] = [],
  ): Promise<Map<string, boolean>> {
    const store = new TaskFrontmatterStore();
    const approved = new Map<string, boolean>();
    for (const t of tasks) {
      if (t.bucket !== "tasks" && t.bucket !== "active") continue;
      try {
        const { fm } = await store.read(t.path);
        if (String(fm.review_status ?? "").toLowerCase() === "approved") {
          approved.set(t.task_id, true);
        }
      } catch {
        /* skip unreadable */
      }
    }

    const reportLookup = new Map<string, Record<string, unknown>>();
    for (const r of reports) {
      reportLookup.set(r.report_id, {
        task_id: r.task_id,
        references: r.references,
      });
    }
    const resolveReport = (reportId: string) =>
      reportLookup.get(reportId.replace(/\.md$/i, "").trim()) ?? null;

    try {
      const subDirs = ["", "approved", "rejected"];
      const filePaths: string[] = [];
      for (const sub of subDirs) {
        const scanDir = sub ? join(reviewsDir, sub) : reviewsDir;
        try {
          const names = await fs.readdir(scanDir);
          for (const name of names) {
            if (!/^REVIEW-/i.test(name) || !name.endsWith(".md")) continue;
            filePaths.push(join(scanDir, name));
          }
        } catch { /* subfolder doesn't exist/readable */ }
      }
      for (const filepath of filePaths) {
        const raw = await fs.readFile(filepath, "utf-8");
        const fm = parseMarkdownFrontmatter(raw);
        const decision = String(fm.decision ?? "").toLowerCase();
        if (decision !== "approved") continue;
        const linkedTaskId = resolveReviewLinkedTaskId(fm, {
          filename: basename(filepath),
          resolveReport,
        });
        if (linkedTaskId) approved.set(linkedTaskId, true);
      }
    } catch {
      /* no reviews dir */
    }
    return approved;
  }

  #buildThreads(
    tasks: LedgerTaskRecord[],
    reports: LedgerReportRecord[],
    reviewApproved: Map<string, boolean>,
  ): LedgerThreadRecord[] {
    const byThread = new Map<string, LedgerThreadRecord>();

    for (const t of tasks) {
      const key = resolveThreadBucketKey(t, tasks);
      let rec = byThread.get(key);
      if (!rec) {
        rec = {
          thread_key: key,
          task_ids: [],
          report_ids: [],
          pending_pm_review: [],
        };
        byThread.set(key, rec);
      }
      if (!rec.task_ids.includes(t.task_id)) rec.task_ids.push(t.task_id);
      if (
        !rec.root_task_id &&
        !t.parent &&
        !key.startsWith("_orphan_") &&
        isAdminToPmRootTask(t)
      ) {
        rec.root_task_id = rec.root_task_id ?? t.task_id;
      }
    }

    for (const rec of byThread.values()) {
      if (rec.thread_key.startsWith("_orphan")) continue;
      const threadTasks = tasks.filter(
        (t) => resolveThreadBucketKey(t, tasks) === rec.thread_key,
      );
      const picked = pickThreadRootTaskId(threadTasks);
      if (picked) rec.root_task_id = picked;
    }

    for (const t of tasks) {
      if (!t.parent) continue;
      const parentNorm = t.parent.replace(/\.md$/i, "");
      const parentTask = findTaskByParentRef(tasks, parentNorm);
      const key = parentTask
        ? resolveThreadBucketKey(parentTask, tasks)
        : resolveThreadBucketKey(t, tasks);
      let rec = byThread.get(key);
      if (!rec) {
        rec = {
          thread_key: key,
          root_task_id: parentNorm,
          task_ids: [],
          report_ids: [],
          pending_pm_review: [],
        };
        byThread.set(key, rec);
      }
      rec.root_task_id = rec.root_task_id ?? parentNorm;
    }

    for (const r of reports) {
      const key = resolveReportThreadKey(r, tasks);
      let rec = byThread.get(key);
      if (!rec) {
        rec = {
          thread_key: key,
          task_ids: [],
          report_ids: [],
          pending_pm_review: [],
        };
        byThread.set(key, rec);
      }
      if (!rec.report_ids.includes(r.report_id)) rec.report_ids.push(r.report_id);

      if (
        r.recipient.toUpperCase() === "PM" &&
        (r.status === "done" || r.status === "completed")
      ) {
        if (isGovernanceReportToPm(r.report_id ?? r.filename, r.sender)) {
          continue;
        }
        if (isPmToAdminReport(r.sender, r.recipient)) {
          continue;
        }
        if (isWorkerReportToPm(r.filename, r.sender, r.recipient)) {
          const childTask = findWorkerReportLinkedTask(r, tasks);
          if (childTask) {
            if (resolveThreadBucketKey(childTask, tasks) !== key) continue;
            if (reviewApproved.get(childTask.task_id)) continue;
            if (isTaskWorkflowSealedForPmReview(childTask)) continue;
            if (
              !rec.pending_pm_review.includes(childTask.task_id) &&
              !isWaitingPmAttentionTask(childTask)
            ) {
              rec.pending_pm_review.push(childTask.task_id);
            }
          } else {
            for (const childTask of tasksMatchingReportRefs(r, tasks)) {
              if (resolveThreadBucketKey(childTask, tasks) !== key) continue;
              if (reviewApproved.get(childTask.task_id)) continue;
              if (isTaskWorkflowSealedForPmReview(childTask)) continue;
              if (
                !rec.pending_pm_review.includes(childTask.task_id) &&
                !isWaitingPmAttentionTask(childTask)
              ) {
                rec.pending_pm_review.push(childTask.task_id);
              }
            }
          }
          continue;
        }
        for (const childTask of tasksMatchingReportRefs(r, tasks)) {
          if (resolveThreadBucketKey(childTask, tasks) !== key) continue;
          if (reviewApproved.get(childTask.task_id)) continue;
          if (isTaskWorkflowSealedForPmReview(childTask)) continue;
          if (
            !rec.pending_pm_review.includes(childTask.task_id) &&
            !isWaitingPmAttentionTask(childTask)
          ) {
            rec.pending_pm_review.push(childTask.task_id);
          }
        }
      }
    }

    // Merge child tasks from _orphan_* rows into parent thread (parent / thread_key on disk)
    for (const t of tasks) {
      if (!t.parent) continue;
      const parentNorm = t.parent.replace(/\.md$/i, "");
      const parentTask = findTaskByParentRef(tasks, parentNorm);
      let targetKey = parentTask
        ? resolveThreadBucketKey(parentTask, tasks)
        : undefined;
      if (!targetKey || targetKey.startsWith("_orphan")) {
        for (const [k, rec] of byThread) {
          if (k.startsWith("_orphan_")) continue;
          if (
            rec.root_task_id === parentNorm ||
            rec.task_ids.includes(parentNorm)
          ) {
            targetKey = k;
            break;
          }
        }
      }
      if (!targetKey) continue;
      const childBucket = resolveThreadBucketKey(t, tasks);
      if (childBucket !== targetKey) continue;
      let target = byThread.get(targetKey);
      if (!target) continue;
      if (!target.task_ids.includes(t.task_id)) target.task_ids.push(t.task_id);
      target.root_task_id = target.root_task_id ?? parentNorm;
      const orphanKey = `_orphan_${t.task_id}`;
      const orphan = byThread.get(orphanKey);
      if (orphan) {
        orphan.task_ids = orphan.task_ids.filter((id) => id !== t.task_id);
        for (const rid of orphan.report_ids) {
          if (!target.report_ids.includes(rid)) target.report_ids.push(rid);
        }
        if (!orphan.task_ids.length && !orphan.report_ids.length) {
          byThread.delete(orphanKey);
        }
      }
    }

    const mergeThreadRecords = (
      target: LedgerThreadRecord,
      source: LedgerThreadRecord,
    ): void => {
      for (const id of source.task_ids) {
        if (!target.task_ids.includes(id)) target.task_ids.push(id);
      }
      for (const id of source.report_ids) {
        if (!target.report_ids.includes(id)) target.report_ids.push(id);
      }
      for (const id of source.pending_pm_review) {
        if (!target.pending_pm_review.includes(id)) target.pending_pm_review.push(id);
      }
      target.waiting_pm_consolidation =
        target.waiting_pm_consolidation || !!source.waiting_pm_consolidation;
      if (!target.root_task_id && source.root_task_id) {
        target.root_task_id = source.root_task_id;
      }
    };

    for (const rec of byThread.values()) {
      const rootId = rec.root_task_id;
      if (!rootId) continue;
      if (!rec.task_ids.includes(rootId) && tasks.some((t) => t.task_id === rootId)) {
        rec.task_ids.unshift(rootId);
      }
    }

    const keysToDelete: string[] = [];
    const rootToPrimary = new Map<string, string>();
    for (const [key, rec] of byThread) {
      const rootId = rec.root_task_id;
      if (!rootId) continue;
      const rootTask = findRootTaskInThread(tasks, rec.task_ids, rootId);
      const canonicalKey = rootTask?.thread_key?.trim();
      const rootAnchor = key;
      const mayMergeCanonical =
        canonicalKey &&
        canonicalKey !== key &&
        !key.includes("#") &&
        !canonicalKey.includes("#");
      if (mayMergeCanonical && byThread.has(canonicalKey)) {
        mergeThreadRecords(byThread.get(canonicalKey)!, rec);
        keysToDelete.push(key);
        rootToPrimary.set(`${rootId}\0${rootAnchor}`, canonicalKey);
        continue;
      }
      const rootPrimaryKey = `${rootId}\0${rootAnchor}`;
      if (rootToPrimary.has(rootPrimaryKey)) {
        const primaryKey = rootToPrimary.get(rootPrimaryKey)!;
        if (primaryKey !== key) {
          mergeThreadRecords(byThread.get(primaryKey)!, rec);
          keysToDelete.push(key);
        }
      } else {
        rootToPrimary.set(rootPrimaryKey, key);
      }
    }
    for (const k of keysToDelete) byThread.delete(k);

    const taskById = new Map(tasks.map((t) => [t.task_id, t]));

    for (const rec of byThread.values()) {
      const rootId = rec.root_task_id;
      if (!rootId) continue;
      const rootTask = tasks.find((t) => t.task_id === rootId);
      const pmToAdminClosed = Boolean(
        selectCanonicalPmFinalReport(
          reports,
          { rootTaskId: rootId, threadKey: rootTask?.thread_key },
        ).canonical,
      );
      if (pmToAdminClosed) {
        rec.pending_pm_review = [];
        rec.waiting_pm_consolidation = false;
        continue;
      }

      rec.pending_pm_review = rec.pending_pm_review.filter((id) => {
        const task = taskById.get(id);
        return (
          !reviewApproved.get(id) &&
          !isTaskWorkflowSealedForPmReview(task) &&
          (!task || !isWaitingPmAttentionTask(task))
        );
      });

      if (
        rootTask &&
        areAllChildrenSettledForRoot(rootId, tasks, rec, reports, reviewApproved)
      ) {
        const rootAwaitingPm =
          rootTask.bucket === "tasks" ||
          rootTask.bucket === "active" ||
          rootTask.bucket === "inbox";
        if (rootAwaitingPm) {
          rec.waiting_pm_consolidation = true;
        }
      }
    }

    return [...byThread.values()];
  }

  async #writeViews(
    layout: ReturnType<typeof resolveLedgerLayout>,
    tasks: LedgerTaskRecord[],
    reports: LedgerReportRecord[],
    threads: LedgerThreadRecord[],
  ): Promise<number> {
    const viewsDir = join(layout.ledgerDir, "views");
    let n = 0;

    const write = async (name: string, body: string) => {
      await fs.writeFile(join(viewsDir, name), body, "utf-8");
      n += 1;
    };

    const currentBucket = (t: LedgerTaskRecord): string =>
      resolveTaskCurrentBucket({
        bucket: t.bucket,
        path: t.path,
        physical_scope: t.physical_scope,
      });

    const isAdminToPmMainline = (t: LedgerTaskRecord): boolean =>
      /-ADMIN-to-PM/i.test(t.filename ?? "");

    const adminInbox = tasks.filter(
      (t) =>
        currentBucket(t) === "inbox" && !isProbeBootstrapLedgerTask(t),
    );
    await write(
      "ADMIN.inbox.md",
      this.#renderView("ADMIN inbox", adminInbox, reports),
    );

    const adminResidue = tasks.filter(
      (t) =>
        !isAdminMainlineTaskFilename(t.filename ?? "") &&
        this.#isResidueExcludedFromWorkerTodo(t, tasks),
    );
    await write(
      "ADMIN.closed_parent_residue.md",
      this.#renderClosedParentResidueView(adminResidue),
    );

    const adminReview = tasks.filter(
      (t) =>
        currentBucket(t) === "review" && !isProbeBootstrapLedgerTask(t),
    );
    await write(
      "ADMIN.review.md",
      this.#renderView("ADMIN review queue", adminReview, reports),
    );

    const isAdminRejected = (t: LedgerTaskRecord): boolean =>
      isTaskReopenedForReworkFromLedger(t);

    for (const role of ["PM", "OPS", "DEV", "QA"] as const) {
      const roleTasks = this.#roleTodoTasks(role, tasks);
      const pendingLines = threads.flatMap((th) =>
        th.pending_pm_review.map((id) => `- pending_pm_review: \`${id}\` (${th.thread_key})`),
      );
      const consolidationLines = threads
        .filter((th) => th.waiting_pm_consolidation)
        .map(
          (th) =>
            `- waiting_pm_summary: \`${th.root_task_id}\` (${th.thread_key}) 子任务已验收，请 PM 写 PM-to-ADMIN 总报告 status=done`,
        );
      let header = "";
      if (role === "PM") {
        const adminRejected = tasks.filter(
          (t) =>
            isAdminRejected(t) &&
            (t.bucket === "active" ||
              t.bucket === "tasks" ||
              t.bucket === "review"),
        );
        if (adminRejected.length) {
          header += `\n## ADMIN 判定打回（待 PM 协调）\n\n${adminRejected
            .map((t) => {
              const reason = t.reopen_reason?.trim() || "（未填写原因）";
              return `- \`${t.task_id}\` **${t.sender}→${t.recipient}** bucket=\`${t.bucket}\` 打回原因：${reason}`;
            })
            .join("\n")}\n`;
        }
        if (pendingLines.length) {
          header += `\n## Pending PM review\n\n${pendingLines.join("\n")}\n`;
        }
        if (consolidationLines.length) {
          header += `\n## Waiting PM consolidation\n\n${consolidationLines.join("\n")}\n`;
        }
      }
      await write(
        `${role}.todo.md`,
        this.#renderView(`${role} todo`, roleTasks, reports) + header,
      );
    }

    return n;
  }

  #renderClosedParentResidueView(tasks: LedgerTaskRecord[]): string {
    const lines = [
      "# ADMIN 闭线残留处理区",
      "",
      `_generated: ${toLocalIsoString()}_`,
      "",
      "_父任务已归档，子任务未收口或缺少 residue 标记；仅 ADMIN 可处理。_",
      "",
    ];
    if (!tasks.length) {
      lines.push("_（暂无闭线残留）_");
      return lines.join("\n");
    }
    for (const t of tasks) {
      const yaml = t.yaml ?? {};
      const mismatch =
        String(t.bucket) === "inbox" &&
        String(yaml.state ?? "").toLowerCase() === "dispatched"
          ? " state_bucket_mismatch"
          : "";
      lines.push(
        `- \`${t.task_id}\` **${t.sender}→${t.recipient}** bucket=\`${t.bucket}\` display=\`${t.display_status ?? yaml.display_status ?? "—"}\`${mismatch}`,
      );
    }
    return lines.join("\n");
  }

  #renderView(
    title: string,
    tasks: LedgerTaskRecord[],
    _reports: LedgerReportRecord[],
  ): string {
    const lines = [
      `# ${title}`,
      "",
      `_generated: ${toLocalIsoString()}_`,
      "",
    ];
    if (!tasks.length) {
      lines.push("_（暂无任务）_");
      return lines.join("\n");
    }
    for (const t of tasks) {
      lines.push(
        `- \`${t.task_id}\` **${t.sender}→${t.recipient}** bucket=\`${t.bucket}\` file=\`${t.filename}\``,
      );
    }
    return lines.join("\n");
  }
}
