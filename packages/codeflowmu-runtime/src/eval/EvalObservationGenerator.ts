import { promises as fs } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";

import { isWorkerReportToPm } from "../fcop/governance.ts";
import { bodyAfterFrontmatter } from "../ledger/leaderLedgerContextPack.ts";
import {
  listField,
  parseMarkdownFrontmatter,
  renderFrontmatter,
} from "../ledger/frontmatter.ts";
import { taskParentMatchesRoot } from "../ledger/lifecycleProjection.ts";
import { resolveLedgerLayout } from "../ledger/paths.ts";
import {
  findAdminRootTask,
  isAdminToPmRootTask,
  isPmAdminFinalSummaryReport,
  isPmDownstreamChildTask,
} from "../ledger/reportParenting.ts";
import { selectCanonicalPmFinalReport } from "../ledger/selectCanonicalPmFinalReport.ts";
import type { LedgerReportRecord, LedgerTaskRecord } from "../ledger/types.ts";
import { readAllActionEvidenceRecords } from "../logs/ActionEvidenceLogger.ts";
import { resolveThreadContext } from "../pm/PmGovernanceActions.ts";
import {
  classifyPendingReviewGate,
  filterReviewsForThread,
  isPendingHumanReviewRow,
  reviewsForPmSummaryCoverage,
  type EvalReviewRow,
} from "./evalReviewScope.ts";
import { humanApprovalApprovedAt } from "../review/reviewHumanApproval.ts";
import { taskIdMatchesPrefix } from "../ledger/reportParenting.ts";

export type EvalObservationInput = {
  projectRoot: string;
  pmReportPath: string;
  pmReportFilename: string;
  pmReportContent: string;
  pmReportFm: Record<string, unknown>;
  now?: () => Date;
};

export type EvalRiskLevel = "low" | "medium" | "high";

export type PmSummaryConsistency = {
  covers_all_child_tasks: boolean;
  covers_all_worker_reports: boolean;
  covers_review_results: boolean;
  covers_open_items: boolean;
  covers_risk_items: boolean;
  covers_retry_rework: boolean;
  missing_child_task_ids: string[];
  missing_worker_report_ids: string[];
  missing_review_ids: string[];
  summary: string;
};

export type EvalObservationAnalysis = {
  main_task_id: string;
  thread_key: string;
  source_report_id: string;
  risk_level: EvalRiskLevel;
  findings: string[];
  evidence_gaps: string[];
  pm_summary_consistency: PmSummaryConsistency;
  recommended_admin_attention: string[];
};

export type AdminTaskCloseout = {
  root_task_id: string;
  thread_key: string;
  pm_final_report: {
    report_id: string;
    filename: string;
    path: string;
    status: string;
    content: string;
    frontmatter: Record<string, unknown>;
  } | null;
  eval_observation: {
    observation_id: string;
    filename: string;
    path: string;
    risk_level: EvalRiskLevel;
    source_report: string;
    internal_only: true;
    bypass_observation: true;
    drives_lifecycle: false;
    content: string;
    frontmatter: Record<string, unknown>;
    findings: string[];
    evidence_gaps: string[];
    pm_summary_consistency: PmSummaryConsistency;
    recommended_admin_attention: string[];
  } | null;
  labels: {
    internal_only: true;
    bypass_observation: true;
    drives_lifecycle: false;
  };
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v != null ? String(v).trim() : "";
}

function dateKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function internalOnlyBlock(): string {
  return [
    "> ⚠️ **INTERNAL ONLY · 内部档案 · DO NOT EXTERNALIZE WITHOUT REVIEW**",
    ">",
    "> 本文件位于 `fcop/internal/eval/`，属于 **EVAL 旁路观察报告**。",
    "> **不驱动 lifecycle**、不自动 approve/reject、不创建 TASK，仅供 ADMIN 关单前参考。",
    "",
  ].join("\n");
}

function pmReportToLedgerRecord(
  fm: Record<string, unknown>,
  filename: string,
): LedgerReportRecord {
  const reportId = basename(filename, ".md");
  return {
    report_id: reportId,
    task_id: str(fm.task_id) || str(fm.parent),
    filename,
    sender: str(fm.sender) || "PM",
    recipient: str(fm.recipient) || "ADMIN",
    status: str(fm.status),
    path: "",
    created_at: str(fm.created_at) || new Date().toISOString(),
    updated_at: str(fm.updated_at) || new Date().toISOString(),
    timezone: str(fm.timezone) || "UTC",
    created_at_utc: str(fm.created_at_utc) || new Date().toISOString(),
    thread_key: str(fm.thread_key) || undefined,
    parent_task_id: str(fm.parent_task_id) || str(fm.parent) || undefined,
    report_kind: str(fm.report_kind) as LedgerReportRecord["report_kind"],
    references: listField(fm, "references"),
    ...(str(fm.report_type) ? { report_type: str(fm.report_type) } : {}),
    ...(fm.final === true ||
    String(fm.final ?? "").trim().toLowerCase() === "true"
      ? { final: true }
      : {}),
  };
}

function resolveAdminRootId(
  tasks: LedgerTaskRecord[],
  report: LedgerReportRecord,
  fm: Record<string, unknown>,
): string {
  const hinted =
    str(fm.task_id) ||
    str(fm.parent) ||
    str(fm.parent_task_id) ||
    report.task_id ||
    report.parent_task_id ||
    "";
  const adminRoot =
    findAdminRootTask(tasks, {
      threadKey: report.thread_key,
      rootTaskId: hinted,
      references: report.references,
    }) ?? tasks.find(isAdminToPmRootTask);
  return adminRoot?.task_id ?? hinted.replace(/\.md$/i, "");
}

/** 仅 PM-to-ADMIN final summary 触发 EVAL（非 ack / 非 in_progress）。 */
export function shouldTriggerEvalObservation(
  input: Pick<
    EvalObservationInput,
    "pmReportFilename" | "pmReportContent" | "pmReportFm"
  > & { tasks?: LedgerTaskRecord[] },
): boolean {
  const body = bodyAfterFrontmatter(input.pmReportContent);
  const report = pmReportToLedgerRecord(input.pmReportFm, input.pmReportFilename);
  const tasks = input.tasks ?? [];
  const rootId = resolveAdminRootId(tasks, report, input.pmReportFm);
  if (!rootId) return false;
  return isPmAdminFinalSummaryReport(rootId, report, body);
}

function pmDownstreamChildren(
  rootId: string,
  tasks: LedgerTaskRecord[],
): LedgerTaskRecord[] {
  return tasks.filter(
    (t) =>
      isPmDownstreamChildTask(t) && taskParentMatchesRoot(t.parent, rootId),
  );
}

function workerReportsForThread(
  reports: LedgerReportRecord[],
  children: LedgerTaskRecord[],
): LedgerReportRecord[] {
  const childIds = new Set(children.map((c) => c.task_id.replace(/\.md$/i, "")));
  return reports.filter((r) => {
    if (!isWorkerReportToPm(r.filename, r.sender, r.recipient)) return false;
    const parent = r.parent_task_id?.replace(/\.md$/i, "") ?? "";
    if (parent && childIds.has(parent)) return true;
    const tid = r.task_id?.replace(/\.md$/i, "") ?? "";
    return [...childIds].some(
      (cid) => tid === cid || tid.startsWith(`${cid}-`),
    );
  });
}

function pmFinalReportForRoot(
  reports: LedgerReportRecord[],
  rootId: string,
  bodies: Map<string, string>,
  threadKey?: string,
): LedgerReportRecord | undefined {
  const { canonical } = selectCanonicalPmFinalReport(
    reports,
    { rootTaskId: rootId, threadKey },
    bodies,
  );
  if (!canonical) return undefined;
  const body =
    bodies.get(canonical.report_id ?? canonical.filename) ??
    bodies.get(canonical.path) ??
    "";
  if (!isPmAdminFinalSummaryReport(rootId, canonical, body)) return undefined;
  return canonical;
}

function bodyMentionsId(body: string, id: string): boolean {
  const norm = id.replace(/\.md$/i, "");
  if (!norm) return false;
  if (body.includes(norm)) return true;
  const short = norm.match(/^TASK-\d{8}-\d{3,}/)?.[0];
  return short ? body.includes(short) : false;
}

function bumpRisk(current: EvalRiskLevel, next: EvalRiskLevel): EvalRiskLevel {
  const order: EvalRiskLevel[] = ["low", "medium", "high"];
  return order.indexOf(next) > order.indexOf(current) ? next : current;
}

function parsePmSummaryConsistencyFromDoc(
  fm: Record<string, unknown>,
  content: string,
): PmSummaryConsistency {
  const body = bodyAfterFrontmatter(content);
  const missingChild = listField(fm, "pm_summary_missing_child_tasks");
  const missingWorker = listField(fm, "pm_summary_missing_worker_reports");
  const missingReview = listField(fm, "pm_summary_missing_reviews");
  const summary =
    str(fm.pm_summary_consistency_summary) ||
    (() => {
      const m = body.match(/## PM Summary Consistency[\s\S]*?\n\n([\s\S]*?)(?:\n## |$)/);
      return m?.[1]?.trim() ?? "";
    })();
  return {
    covers_all_child_tasks: missingChild.length === 0,
    covers_all_worker_reports: missingWorker.length === 0,
    covers_review_results: missingReview.length === 0,
    covers_open_items: !/未完成|open item|pending/i.test(summary),
    covers_risk_items: !/风险项未覆盖|risk.*missing/i.test(summary),
    covers_retry_rework: !/重试|rework|retry/i.test(summary) || /已覆盖/.test(summary),
    missing_child_task_ids: missingChild,
    missing_worker_report_ids: missingWorker,
    missing_review_ids: missingReview,
    summary: summary || "（未解析）",
  };
}

/** 基于 ledger 行生成 EVAL 分析（不落盘，供单元测试与集成）。 */
export function buildEvalObservationAnalysisFromRows(input: {
  pmReportFilename: string;
  pmReportContent: string;
  pmReportFm: Record<string, unknown>;
  tasks: LedgerTaskRecord[];
  reports: LedgerReportRecord[];
  actionEvidence?: { task_id?: string }[];
  reviews?: EvalReviewRow[];
  issueCount?: number;
}): EvalObservationAnalysis | null {
  const pmBody = bodyAfterFrontmatter(input.pmReportContent);
  const pmReport = pmReportToLedgerRecord(
    input.pmReportFm,
    input.pmReportFilename,
  );
  const rootId = resolveAdminRootId(
    input.tasks,
    pmReport,
    input.pmReportFm,
  );
  if (!rootId || !isPmAdminFinalSummaryReport(rootId, pmReport, pmBody)) {
    return null;
  }

  const threadKey =
    str(input.pmReportFm.thread_key) ||
    input.tasks.find((t) => t.task_id === rootId)?.thread_key ||
    "";

  const children = pmDownstreamChildren(rootId, input.tasks);
  const workerReports = workerReportsForThread(input.reports, children);
  const findings: string[] = [];
  const evidenceGaps: string[] = [];
  let risk: EvalRiskLevel = "low";

  const scopedReviews = filterReviewsForThread(input.reviews ?? [], {
    rootId,
    children,
    threadKey,
    reports: input.reports,
  });
  let changesRequested = 0;
  const actionablePending = scopedReviews.filter(isPendingHumanReviewRow);
  const childChainPending = actionablePending.filter(
    (r) => classifyPendingReviewGate(r, rootId, children) === "child_review_pending",
  );
  for (const rev of actionablePending) {
    const gateKind = classifyPendingReviewGate(rev, rootId, children);
    if (gateKind === "child_review_pending") {
      findings.push(`子链路 REVIEW 需人工：${rev.id}`);
    } else if (gateKind === "main_admin_approval_pending") {
      findings.push(`主任务 ADMIN 验收待决：${rev.id}`);
    }
  }
  if (childChainPending.length > 0) risk = "high";
  for (const rev of scopedReviews) {
    if (rev.decision === "changes_requested") {
      changesRequested += 1;
    }
  }
  if (changesRequested > 0) risk = bumpRisk(risk, "medium");

  const scopedEvidence = (input.actionEvidence ?? []).filter((r) => {
    const tid = str(r.task_id);
    if (!tid) return false;
    if (tid.startsWith(rootId.slice(0, 18))) return true;
    return children.some(
      (c) => tid === c.task_id || tid.startsWith(`${c.task_id}-`),
    );
  });
  if (children.length > 0 && scopedEvidence.length === 0) {
    evidenceGaps.push("子任务存在但 Action Evidence Log 中缺少对应 task_id 证据");
    risk = "high";
  }

  const openChildren = children.filter((c) => c.bucket !== "done");
  const missingChildIds = children
    .map((c) => c.task_id)
    .filter((id) => !bodyMentionsId(pmBody, id));
  const missingWorkerIds = workerReports
    .map((r) => r.report_id ?? r.filename.replace(/\.md$/i, ""))
    .filter((id) => !bodyMentionsId(pmBody, id));
  const coverageReviews = reviewsForPmSummaryCoverage(scopedReviews);
  const missingReviewIds = coverageReviews
    .map((r) => r.id)
    .filter((id) => !bodyMentionsId(pmBody, id));

  if (missingChildIds.length) {
    findings.push(`PM 总报告未覆盖子任务：${missingChildIds.join(", ")}`);
    risk = bumpRisk(risk, "medium");
  }
  if (missingWorkerIds.length) {
    findings.push(
      `PM 总报告未引用 worker REPORT：${missingWorkerIds.join(", ")}`,
    );
    risk = bumpRisk(risk, "medium");
  }

  const issueCount = input.issueCount ?? 0;
  if (issueCount > 0 && !/issue|问题/i.test(pmBody)) {
    findings.push(`线程存在 ${issueCount} 份 ISSUE 但 PM 总报告未提及`);
    risk = bumpRisk(risk, "medium");
  }

  const pmSummaryConsistency: PmSummaryConsistency = {
    covers_all_child_tasks: missingChildIds.length === 0,
    covers_all_worker_reports: missingWorkerIds.length === 0,
    covers_review_results: missingReviewIds.length === 0,
    covers_open_items: openChildren.length === 0,
    covers_risk_items:
      childChainPending.length === 0 && changesRequested === 0,
    covers_retry_rework: true,
    missing_child_task_ids: missingChildIds,
    missing_worker_report_ids: missingWorkerIds,
    missing_review_ids: missingReviewIds,
    summary: `子任务 ${children.length}；worker REPORT ${workerReports.length}`,
  };

  const recommended =
    risk === "high"
      ? ["request_rework", "hold"]
      : risk === "medium"
        ? ["hold"]
        : ["approve_close"];

  return {
    main_task_id: rootId,
    thread_key: threadKey,
    source_report_id: basename(input.pmReportFilename, ".md"),
    risk_level: risk,
    findings,
    evidence_gaps: evidenceGaps,
    pm_summary_consistency: pmSummaryConsistency,
    recommended_admin_attention: recommended,
  };
}

async function nextObservationSeq(evalDir: string, date: string): Promise<number> {
  let names: string[] = [];
  try {
    names = await fs.readdir(evalDir);
  } catch {
    return 1;
  }
  let max = 0;
  const prefix = `OBSERVATION-${date}-`;
  for (const name of names) {
    const m = name.match(new RegExp(`^${prefix}(\\d{3})`, "i"));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(dir);
    return names
      .filter((n) => n.endsWith(".md"))
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

async function countThreadIssues(
  issuesDir: string,
  scope: {
    rootId: string;
    children: LedgerTaskRecord[];
    threadKey: string;
  },
): Promise<number> {
  const taskIds = new Set<string>([scope.rootId]);
  for (const c of scope.children) {
    if (c.task_id) taskIds.add(c.task_id);
  }
  let count = 0;
  for (const path of await listMarkdownFiles(issuesDir)) {
    const fm = await readFm(path);
    const issueThread = str(fm.thread_key);
    if (scope.threadKey && issueThread === scope.threadKey) {
      count += 1;
      continue;
    }
    const tid = (str(fm.task_id) || str(fm.subject_id)).replace(/\.md$/i, "");
    if (
      tid &&
      [...taskIds].some((id) => taskIdMatchesPrefix(tid, id))
    ) {
      count += 1;
    }
  }
  return count;
}

async function loadEvalReviewRows(reviewsDir: string): Promise<EvalReviewRow[]> {
  const rows: EvalReviewRow[] = [];
  for (const path of await listMarkdownFiles(reviewsDir)) {
    const raw = await fs.readFile(path, "utf-8").catch(() => "");
    const fm = parseMarkdownFrontmatter(raw) as Record<string, unknown>;
    const approvedAt = humanApprovalApprovedAt(fm);
    rows.push({
      id: basename(path, ".md"),
      decision: str(fm.decision),
      taskId: str(fm.task_id) || str(fm.subject_id),
      reviewer: str(fm.reviewer),
      subjectId: str(fm.subject_id),
      threadKey: str(fm.thread_key),
      humanApprovalApprovedAt: approvedAt,
    });
  }
  return rows;
}

async function readFm(path: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path, "utf-8").catch(() => "");
  return parseMarkdownFrontmatter(raw) as Record<string, unknown>;
}

export async function findEvalObservationBySourceReport(
  projectRoot: string,
  sourceReportId: string,
): Promise<{ path: string; filename: string; content: string; fm: Record<string, unknown> } | null> {
  const layout = resolveLedgerLayout(projectRoot);
  const evalDir = join(layout.fcopRoot, "internal", "eval");
  const norm = sourceReportId.replace(/\.md$/i, "");
  for (const path of await listMarkdownFiles(evalDir)) {
    const fm = await readFm(path);
    if (str(fm.source_report).replace(/\.md$/i, "") === norm) {
      const content = await fs.readFile(path, "utf-8");
      return { path, filename: basename(path), content, fm };
    }
  }
  return null;
}

async function loadThreadRowsForEval(
  projectRoot: string,
  pmReportFm: Record<string, unknown>,
  pmReport: LedgerReportRecord,
): Promise<{
  tasks: LedgerTaskRecord[];
  reports: LedgerReportRecord[];
} | null> {
  const threadKey = str(pmReportFm.thread_key) || pmReport.thread_key || "";
  const refIds = [
    ...listField(pmReportFm, "references"),
    ...(pmReport.references ?? []),
  ];
  const taskId =
    str(pmReportFm.task_id) ||
    str(pmReportFm.parent) ||
    str(pmReportFm.parent_task_id) ||
    pmReport.task_id ||
    pmReport.parent_task_id ||
    refIds[0] ||
    "";
  const ctx = await resolveThreadContext(projectRoot, {
    thread_key: threadKey || undefined,
    task_id: taskId || undefined,
  });
  if (!ctx) return null;
  return { tasks: ctx.tasks, reports: ctx.reports };
}

async function buildAnalysisFromProject(
  input: EvalObservationInput,
): Promise<EvalObservationAnalysis | null> {
  const pmReport = pmReportToLedgerRecord(
    input.pmReportFm,
    input.pmReportFilename,
  );
  const rows = await loadThreadRowsForEval(
    input.projectRoot,
    input.pmReportFm,
    pmReport,
  );
  if (!rows) return null;

  const layout = resolveLedgerLayout(input.projectRoot);
  const reportBodies = new Map<string, string>();
  reportBodies.set(basename(input.pmReportPath, ".md"), input.pmReportContent);

  const rootId = resolveAdminRootId(rows.tasks, pmReport, input.pmReportFm);
  const threadKey =
    str(input.pmReportFm.thread_key) ||
    pmReport.thread_key ||
    rows.tasks.find((t) => t.task_id === rootId)?.thread_key ||
    "";
  const children = rootId ? pmDownstreamChildren(rootId, rows.tasks) : [];
  const reviews = await loadEvalReviewRows(layout.reviewsDir);
  const issueCount = rootId
    ? await countThreadIssues(layout.issuesDir, {
        rootId,
        children,
        threadKey,
      })
    : 0;

  const evidence = await readAllActionEvidenceRecords(input.projectRoot);
  return buildEvalObservationAnalysisFromRows({
    pmReportFilename: input.pmReportFilename,
    pmReportContent: input.pmReportContent,
    pmReportFm: input.pmReportFm,
    tasks: rows.tasks,
    reports: rows.reports,
    actionEvidence: evidence,
    reviews,
    issueCount,
  });
}

function renderObservationDoc(
  analysis: EvalObservationAnalysis,
  obsId: string,
): string {
  const c = analysis.pm_summary_consistency;
  return [
    renderFrontmatter({
      protocol: "fcop",
      version: 1,
      kind: "eval-observation",
      observation_id: obsId,
      source_report: analysis.source_report_id,
      main_task_id: analysis.main_task_id,
      thread_key: analysis.thread_key || undefined,
      risk_level: analysis.risk_level,
      internal_only: true,
      bypass_observation: true,
      drives_lifecycle: false,
      findings: analysis.findings,
      evidence_gaps: analysis.evidence_gaps,
      recommended_admin_attention: analysis.recommended_admin_attention,
      pm_summary_missing_child_tasks: c.missing_child_task_ids,
      pm_summary_missing_worker_reports: c.missing_worker_report_ids,
      pm_summary_missing_reviews: c.missing_review_ids,
      pm_summary_consistency_summary: c.summary,
    }),
    "",
    internalOnlyBlock(),
    `# EVAL 任务观察 / Task Observation`,
    "",
    `Source PM report: ${analysis.source_report_id}`,
    `Main task: ${analysis.main_task_id}`,
    analysis.thread_key ? `Thread: ${analysis.thread_key}` : "",
    "",
    "## Findings",
    "",
    ...(analysis.findings.length
      ? analysis.findings.map((f) => `- ${f}`)
      : ["- （未检出显著风险项）"]),
    "",
    "## Evidence Gaps",
    "",
    ...(analysis.evidence_gaps.length
      ? analysis.evidence_gaps.map((g) => `- ${g}`)
      : ["- （未检出明显证据缺口）"]),
    "",
    "## PM Summary Consistency",
    "",
    c.summary,
    "",
    `- covers_all_child_tasks: ${c.covers_all_child_tasks}`,
    `- covers_all_worker_reports: ${c.covers_all_worker_reports}`,
    `- covers_review_results: ${c.covers_review_results}`,
    `- covers_open_items: ${c.covers_open_items}`,
    "",
    "## Recommended Admin Attention",
    "",
    ...analysis.recommended_admin_attention.map((r) => `- ${r}`),
    "",
  ].join("\n");
}

export type EvalObservationWriteOptions = {
  /** 已有 OBSERVATION 时覆盖重写（关单页「生成 EVAL」刷新） */
  forceRegenerate?: boolean;
};

/**
 * P3: 旁路 EVAL 观察报告。仅 PM-to-ADMIN final 触发；不改 lifecycle、不创建 TASK。
 */
export async function maybeWriteEvalObservation(
  input: EvalObservationInput,
  options?: EvalObservationWriteOptions,
): Promise<string | null> {
  const rows = await loadThreadRowsForEval(
    input.projectRoot,
    input.pmReportFm,
    pmReportToLedgerRecord(input.pmReportFm, input.pmReportFilename),
  );
  if (
    !shouldTriggerEvalObservation({
      ...input,
      tasks: rows?.tasks,
    })
  ) {
    return null;
  }

  const analysis = await buildAnalysisFromProject(input);
  if (!analysis) return null;

  const layout = resolveLedgerLayout(input.projectRoot);
  const evalDir = join(layout.fcopRoot, "internal", "eval");
  await fs.mkdir(evalDir, { recursive: true });

  const existing = await findEvalObservationBySourceReport(
    input.projectRoot,
    analysis.source_report_id,
  );
  if (existing && !options?.forceRegenerate) return null;

  const now = input.now?.() ?? new Date();
  let obsId: string;
  let path: string;
  if (existing && options?.forceRegenerate) {
    obsId =
      str(existing.fm.observation_id) ||
      basename(existing.filename, ".md").replace(/-pm-summary$/i, "");
    path = existing.path;
  } else {
    const dk = dateKey(now);
    const seq = await nextObservationSeq(evalDir, dk);
    const seqStr = String(seq).padStart(3, "0");
    obsId = `OBSERVATION-${dk}-${seqStr}`;
    const filename = `${obsId}-pm-summary.md`;
    path = join(evalDir, filename);
  }

  const doc = renderObservationDoc(analysis, obsId);
  await fs.writeFile(path, doc, "utf-8");
  return path;
}

function resolveReportAbsPath(
  projectRoot: string,
  report: Pick<LedgerReportRecord, "path" | "filename">,
): string {
  const raw = str(report.path);
  if (raw) {
    if (isAbsolute(raw)) return raw;
    return join(projectRoot, raw.replace(/^[/\\]+/, ""));
  }
  const layout = resolveLedgerLayout(projectRoot);
  return join(layout.reportsDir, report.filename);
}

function relPathUnderProject(projectRoot: string, absPath: string): string {
  const rel = relative(projectRoot, absPath);
  return rel.replace(/\\/g, "/");
}

function indexReportBody(
  map: Map<string, string>,
  report: LedgerReportRecord,
  raw: string,
): void {
  const id = report.report_id ?? basename(report.filename, ".md");
  map.set(id, raw);
  map.set(report.filename, raw);
  map.set(basename(report.filename, ".md"), raw);
}

export type AdminTaskCloseoutOptions = {
  /** 有 PM final 但无 EVAL 时自动补写（默认 true） */
  ensureEval?: boolean;
};

type EvalObservationRecord = {
  path: string;
  filename: string;
  content: string;
  fm: Record<string, unknown>;
};

function obsRecordToEvalPayload(
  projectRoot: string,
  obs: EvalObservationRecord,
): NonNullable<AdminTaskCloseout["eval_observation"]> {
  const c = parsePmSummaryConsistencyFromDoc(obs.fm, obs.content);
  return {
    observation_id: str(obs.fm.observation_id) || basename(obs.filename, ".md"),
    filename: obs.filename,
    path: relPathUnderProject(projectRoot, obs.path),
    risk_level: (str(obs.fm.risk_level) as EvalRiskLevel) || "low",
    source_report: str(obs.fm.source_report),
    internal_only: true,
    bypass_observation: true,
    drives_lifecycle: false,
    content: obs.content,
    frontmatter: obs.fm,
    findings: listField(obs.fm, "findings"),
    evidence_gaps: listField(obs.fm, "evidence_gaps"),
    pm_summary_consistency: c,
    recommended_admin_attention: listField(
      obs.fm,
      "recommended_admin_attention",
    ),
  };
}

function resolvePmFinalAbsPath(
  projectRoot: string,
  pmFinal: NonNullable<AdminTaskCloseout["pm_final_report"]>,
): string {
  return resolveReportAbsPath(projectRoot, {
    path: pmFinal.path,
    filename: pmFinal.filename,
  });
}

export type EnsureEvalOptions = EvalObservationWriteOptions;

/** 为已有 PM final 补写 EVAL（幂等；已有则返回既有路径）。 */
export async function ensureEvalObservationForPmFinal(
  projectRoot: string,
  pmFinal: NonNullable<AdminTaskCloseout["pm_final_report"]>,
  options?: EnsureEvalOptions,
): Promise<string | null> {
  const existing = await findEvalObservationBySourceReport(
    projectRoot,
    pmFinal.report_id,
  );
  if (existing && !options?.forceRegenerate) return existing.path;

  const abs = resolvePmFinalAbsPath(projectRoot, pmFinal);
  return maybeWriteEvalObservation(
    {
      projectRoot,
      pmReportPath: abs,
      pmReportFilename: pmFinal.filename,
      pmReportContent: pmFinal.content,
      pmReportFm: pmFinal.frontmatter,
    },
    { forceRegenerate: options?.forceRegenerate ?? !!existing },
  );
}

export type EnsureEvalCloseoutResult = {
  generated: boolean;
  path: string | null;
  regenerated?: boolean;
  reason?:
    | "no_closeout"
    | "no_pm_final"
    | "already_exists"
    | "not_eligible"
    | "regenerated";
};

/** ADMIN 关单：按 task_id 补写 EVAL（供 API 手动触发）。 */
export async function ensureEvalObservationForCloseout(
  projectRoot: string,
  taskId: string,
  options?: EnsureEvalOptions,
): Promise<EnsureEvalCloseoutResult> {
  const closeout = await getAdminTaskCloseout(projectRoot, taskId, {
    ensureEval: false,
  });
  if (!closeout) {
    return { generated: false, path: null, reason: "no_closeout" };
  }
  if (!closeout.pm_final_report) {
    return { generated: false, path: null, reason: "no_pm_final" };
  }
  const hadEval = !!closeout.eval_observation;
  if (hadEval && !options?.forceRegenerate) {
    return {
      generated: false,
      path: closeout.eval_observation!.path,
      reason: "already_exists",
    };
  }
  const path = await ensureEvalObservationForPmFinal(
    projectRoot,
    closeout.pm_final_report,
    options,
  );
  if (!path) {
    return { generated: false, path: null, reason: "not_eligible" };
  }
  if (hadEval && options?.forceRegenerate) {
    return {
      generated: true,
      path,
      regenerated: true,
      reason: "regenerated",
    };
  }
  return { generated: true, path };
}

/** ADMIN 关单视图：PM final summary + EVAL observation（只读）。 */
export async function getAdminTaskCloseout(
  projectRoot: string,
  taskId: string,
  options?: AdminTaskCloseoutOptions,
): Promise<AdminTaskCloseout | null> {
  const norm = taskId.replace(/\.md$/i, "").trim();
  if (!norm) return null;

  const ctx = await resolveThreadContext(projectRoot, { task_id: norm });
  if (!ctx) return null;

  const root =
    findAdminRootTask(ctx.tasks, {
      threadKey: ctx.thread_key,
      rootTaskId: ctx.root_task_id ?? norm,
    }) ?? ctx.tasks.find(isAdminToPmRootTask);

  if (!root || !isAdminToPmRootTask(root)) return null;

  const rootId = root.task_id;
  const reportBodies = new Map<string, string>();
  for (const r of ctx.reports) {
    try {
      const abs = resolveReportAbsPath(projectRoot, r);
      const raw = await fs.readFile(abs, "utf-8");
      indexReportBody(reportBodies, r, raw);
    } catch {
      /* skip */
    }
  }

  const pmFinal = pmFinalReportForRoot(
    ctx.reports,
    rootId,
    reportBodies,
    ctx.thread_key,
  );
  let pmFinalPayload: AdminTaskCloseout["pm_final_report"] = null;
  if (pmFinal) {
    const abs = resolveReportAbsPath(projectRoot, pmFinal);
    const rel = relPathUnderProject(projectRoot, abs);
    const content =
      reportBodies.get(pmFinal.report_id ?? pmFinal.filename) ??
      reportBodies.get(pmFinal.filename) ??
      reportBodies.get(basename(pmFinal.filename, ".md")) ??
      (await fs.readFile(abs, "utf-8").catch(() => ""));
    pmFinalPayload = {
      report_id: pmFinal.report_id ?? pmFinal.filename.replace(/\.md$/i, ""),
      filename: pmFinal.filename,
      path: rel,
      status: pmFinal.status ?? "done",
      content,
      frontmatter: parseMarkdownFrontmatter(content) as Record<string, unknown>,
    };
  }

  let evalPayload: AdminTaskCloseout["eval_observation"] = null;
  if (pmFinalPayload) {
    if (options?.ensureEval !== false) {
      await ensureEvalObservationForPmFinal(projectRoot, pmFinalPayload);
    }
    const obs = await findEvalObservationBySourceReport(
      projectRoot,
      pmFinalPayload.report_id,
    );
    if (obs) {
      evalPayload = obsRecordToEvalPayload(projectRoot, obs);
    }
  }

  return {
    root_task_id: rootId,
    thread_key: ctx.thread_key,
    pm_final_report: pmFinalPayload,
    eval_observation: evalPayload,
    labels: {
      internal_only: true,
      bypass_observation: true,
      drives_lifecycle: false,
    },
  };
}
