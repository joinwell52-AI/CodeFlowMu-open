import { promises as fs } from "node:fs";
import { basename, join } from "node:path";

import { LedgerBuilder } from "../ledger/LedgerBuilder.ts";
import { areAllChildrenSettledForRoot } from "../ledger/lifecycleProjection.ts";
import { listField, parseMarkdownFrontmatter, renderFrontmatter, strField } from "../ledger/frontmatter.ts";
import { resolveLedgerLayout } from "../ledger/paths.ts";
import {
  verifyThread,
  type LedgerThreadVerifyResult,
} from "../ledger/LedgerVerifier.ts";
import type {
  LedgerReportRecord,
  LedgerTaskRecord,
  LedgerThreadRecord,
} from "../ledger/types.ts";
import { toLocalIsoString } from "../_internal/local-iso.ts";
import {
  isGovernanceReportToPm,
  isWorkerReportToPm,
} from "../fcop/governance.ts";
import {
  isPmAdminFinalSummaryReport,
  isPmToAdminReport,
} from "../ledger/reportParenting.ts";
import { evaluatePmSummaryGate } from "./PmSummaryGate.ts";
import { evaluateProductDeliveryGate } from "./ProductDeliveryGovernance.ts";
import { evaluateQaReportAcceptance } from "./qaAcceptanceFromReport.ts";
import { aggregateUsageForThread, type ThreadUsageSummary } from "./UsageAggregator.ts";
import {
  isTaskHotPathBody,
  readTaskBodyByIdPrefix,
} from "./pmAdminRejectPrompt.ts";

const DEFAULT_ROLE_AGENT: Record<string, string> = {
  PM: "PM-01",
  DEV: "DEV-01",
  OPS: "OPS-01",
  QA: "QA-01",
};

export interface ResolveThreadInput {
  thread_key?: string;
  task_id?: string;
}

export interface ThreadContext {
  thread_key: string;
  root_task_id: string | null;
  thread: LedgerThreadRecord;
  tasks: LedgerTaskRecord[];
  reports: LedgerReportRecord[];
  root_body?: string | null;
}

export interface ThreadSummaryTaskRow {
  task_id: string;
  filename: string;
  sender: string;
  recipient: string;
  bucket: string;
  thread_key?: string;
  parent?: string;
}

export interface ThreadSummaryReportRow {
  report_id: string;
  filename: string;
  sender: string;
  recipient: string;
  task_id?: string;
  status?: string;
  thread_key?: string;
}

export interface ThreadSummary {
  thread_key: string;
  root_task_id: string | null;
  root_task: ThreadSummaryTaskRow | null;
  tasks: ThreadSummaryTaskRow[];
  reports: ThreadSummaryReportRow[];
  pending_pm_review: string[];
  usage: ThreadUsageSummary;
  generated_at: string;
}

export type StallFindingCode =
  | "active_stalled_done_report"
  | "missing_report"
  | "inbox_fragment"
  | "pending_pm_review"
  | "waiting_pm_attention"
  | "waiting_pm_summary"
  | "verify_finding"
  | "no_root_admin_task";

export interface StallFinding {
  code: StallFindingCode;
  severity: "info" | "warn" | "error";
  message: string;
  entity_id?: string;
}

export interface StallSuggestion {
  action:
    | "write_report"
    | "wake_downstream"
    | "close_admin_task"
    | "submit_review"
    | "read_pending_report"
    | "rebuild_ledger"
    | "verify_thread";
  detail: string;
  params?: Record<string, string>;
}

export interface ThreadStallDetection {
  thread_key: string;
  root_task_id: string | null;
  /** true when warn/error findings indicate actionable stall signals. */
  is_stalled: boolean;
  findings: StallFinding[];
  suggestions: StallSuggestion[];
  verify: LedgerThreadVerifyResult | null;
  generated_at: string;
}

export interface CloseAdminTaskDraft {
  task_id: string;
  reporter: "PM";
  recipient: "ADMIN";
  status: "done";
  /** Human-readable close draft label for API summaries. */
  suggested_status: string;
  thread_key: string;
  body: string;
  write_report_hint: {
    task_id: string;
    reporter: "PM";
    recipient: "ADMIN";
    status: "done";
    body: string;
  };
  downstream_reports: Array<{
    report_id: string;
    filename: string;
    task_id?: string;
    excerpt: string;
  }>;
  generated_at: string;
}

export type ReviewCheckFindingCode =
  | "report_missing"
  | "report_file_missing"
  | "task_id_mismatch"
  | "missing_task_id"
  | "missing_references"
  | "weak_evidence"
  | "status_not_acceptable"
  | "superseded"
  | "task_not_found"
  | "fact_check_needs_human"
  | "governance_report_excluded"
  | "qa_report_dependency_blocked"
  | "qa_acceptance_fail";

export interface ReviewCheckFinding {
  code: ReviewCheckFindingCode;
  severity: "info" | "warn" | "error";
  message: string;
}

export interface ReviewCheckResult {
  ok: boolean;
  task_id: string | null;
  report_id: string | null;
  findings: ReviewCheckFinding[];
  report?: {
    filename: string;
    sender: string;
    recipient: string;
    status: string;
    path: string;
  };
  generated_at: string;
}

export interface ReviewCheckInput {
  task_id?: string;
  report_id?: string;
}

export interface WakeDownstreamRequest {
  role: string;
  agent_id: string;
  task_id: string;
  thread_key: string | null;
  reason: string;
  source?: string;
  caller?: string;
  caller_session_id?: string;
  intent: "wake";
  operator_role: "PM";
  message: string;
  journal_entry: {
    at: string;
    action: "wake_agent";
    role: string;
    task_id: string;
    thread_key: string | null;
    reason: string;
    operator: "PM";
  };
}

function loadJsonlLines<T>(raw: string): T[] {
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      /* skip */
    }
  }
  return out;
}

function normalizeTaskId(taskId: string): string {
  return taskId.replace(/\.md$/i, "").trim();
}

function taskIdMatchesPrefix(taskId: string, prefix: string): boolean {
  const norm = normalizeTaskId(taskId).toUpperCase();
  const p = normalizeTaskId(prefix).toUpperCase();
  return norm === p || norm.startsWith(`${p}-`) || p.startsWith(`${norm}-`);
}

export function isReportId(id: string): boolean {
  return /^REPORT-\d{8}-\d{3,}/i.test(id.trim());
}

export function isTaskId(id: string): boolean {
  return /^TASK-\d{8}-\d{3,}/i.test(id.trim());
}

export function hasPmAdminSummaryReport(
  rootId: string,
  reports: LedgerReportRecord[],
): boolean {
  return reports.some((r) => isPmAdminFinalSummaryReport(rootId, r));
}

async function nextReportPath(
  reportsDir: string,
  dateKey: string,
): Promise<string> {
  await fs.mkdir(reportsDir, { recursive: true });
  for (let i = 1; i <= 999; i += 1) {
    const seq = String(i).padStart(3, "0");
    const path = join(reportsDir, `REPORT-${dateKey}-${seq}-PM-to-ADMIN.md`);
    try {
      const handle = await fs.open(path, "wx");
      await handle.close();
      return path;
    } catch (err) {
      if ((err as { code?: string }).code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error(`no REPORT sequence available for ${dateKey}`);
}

function buildPmAdminSummaryBody(
  ctx: ThreadContext,
  rootTask: LedgerTaskRecord,
  downstream: CloseAdminTaskDraft["downstream_reports"],
): string {
  const childTasks = ctx.tasks.filter(
    (t) =>
      t.task_id !== rootTask.task_id &&
      t.sender === "PM" &&
      t.recipient !== "PM",
  );
  const lines: string[] = [
    "# 总结",
    "",
    "## 本次任务目标",
    `ADMIN 主线任务 \`${rootTask.task_id}\`（thread: \`${ctx.thread_key}\`）。`,
    "",
    "## 已完成内容",
  ];
  if (!downstream.length) {
    lines.push("- （ledger 未索引到下游 worker REPORT）");
  } else {
    for (const d of downstream) {
      lines.push(
        `- \`${d.filename}\`${d.task_id ? `（task: \`${d.task_id}\`）` : ""}`,
      );
      if (d.excerpt) lines.push(`  - ${d.excerpt}`);
    }
  }
  lines.push(
    "",
    "## 关键改动",
    ...childTasks.map((t) => `- 子任务 \`${t.task_id}\` → ${t.recipient}`),
    ...(childTasks.length ? [] : ["- （无 PM 下游子任务索引）"]),
    "",
    "## 验收结果",
    downstream.length
      ? "- 下游 REPORT 已落盘，PM 自动汇总关单"
      : "- 待 PM 人工补充验收证据",
    "",
    "## 失败与重试情况",
    "- 无自动 blocked 噪声（Runtime 总线自动汇总）",
    "",
    "## 当前风险",
    "- 请 ADMIN 核对 PM 总报告与 EVAL observation",
    "",
    "## PM 结论",
    "- 建议 ADMIN 归档主线任务",
    "",
  );
  return lines.join("\n");
}

/** Resolve ADMIN→PM root from scoped tasks, parent chain, or ledger hint. */
function buildPmAdminSummaryBodyRuntime(
  ctx: ThreadContext,
  rootTask: LedgerTaskRecord,
  downstream: CloseAdminTaskDraft["downstream_reports"],
): string {
  const childTasks = ctx.tasks.filter(
    (t) =>
      t.task_id !== rootTask.task_id &&
      t.sender === "PM" &&
      t.recipient !== "PM",
  );
  const childRoles = new Set(childTasks.map((t) => String(t.recipient ?? "").toUpperCase()));
  const downstreamText = downstream
    .map((d) => `${d.filename} ${d.task_id ?? ""} ${d.excerpt ?? ""}`)
    .join("\n");
  const pwaLike = /PWA|manifest|service\s*worker|离线|手机|移动端|真机/i.test(
    `${ctx.root_body ?? ""}\n${downstreamText}`,
  );
  const lines: string[] = [
    "# PM 项目汇总报告",
    "",
    "## 主任务",
    `ADMIN 主线任务：\`${rootTask.task_id}\`（thread: \`${ctx.thread_key}\`）。`,
    "",
    "## 下游交付与回执",
  ];
  if (!downstream.length) {
    lines.push("- ledger 暂未索引到下游 worker REPORT；PM 不应据此关单。");
  } else {
    for (const d of downstream) {
      lines.push(
        `- \`${d.filename}\`${d.task_id ? `（task: \`${d.task_id}\`）` : ""}`,
      );
      if (d.excerpt) lines.push(`  - ${d.excerpt}`);
    }
  }
  lines.push(
    "",
    "## 协作链路",
    ...childTasks.map((t) => `- 子任务 \`${t.task_id}\`：PM → ${t.recipient}`),
    ...(childTasks.length ? [] : ["- 未索引到 PM 下游子任务；需要 PM 人工核对是否符合 FCoP 冷路径。"]),
    "",
    "## 验收结论",
    downstream.length
      ? "- 下游 REPORT 已落盘，本报告由 PM 治理流程自动汇总生成；ADMIN 仍需按报告证据做最终验收。"
      : "- 缺少下游验收证据，不能作为最终关单依据。",
    childRoles.has("QA")
      ? "- QA 独立验收链路已纳入本轮汇总。"
      : "- 未发现 QA 子任务；若主任务要求独立验收，应打回 PM 补派 QA。",
    ...(pwaLike
      ? [
          "",
          "## PWA / 手机预览说明",
          "- 电脑本机预览可使用 `http://localhost:<port>/`。",
          "- 手机真机预览不能使用 localhost；需要静态服务监听 `0.0.0.0`，手机访问 `http://<电脑局域网IP>:<port>/`。",
          "- CodeFlowMu 的移动端 Gateway/二维码用于控制面板绑定，不自动代理产品项目页面。",
        ]
      : []),
    "",
    "## 失败与重试情况",
    "- 自动汇总路径未引入 blocked 状态；若下游报告有缺陷，PM 应在本节说明并给出返工/二次升级建议。",
    "",
    "## 当前风险",
    "- 请 ADMIN 核对下游报告、PM 汇总和 EVAL observation 后再归档。",
    "",
    "## PM 结论",
    "- 建议 ADMIN 按上述证据验收；如发现 QA 缺失、手机预览说明缺失或产品缺陷未披露，应打回 PM 补充。",
    "",
  );
  return lines.join("\n");
}

function resolveAdminRootTaskId(
  scopedTasks: LedgerTaskRecord[],
  allTasks: LedgerTaskRecord[],
  hintedRoot?: string | null,
): string | undefined {
  if (hintedRoot) {
    const norm = normalizeTaskId(hintedRoot);
    const hinted = allTasks.find(
      (t) =>
        normalizeTaskId(t.task_id) === norm &&
        t.sender === "ADMIN" &&
        t.recipient === "PM",
    );
    if (hinted) return hinted.task_id;
  }
  const direct = scopedTasks.find(
    (t) => t.sender === "ADMIN" && t.recipient === "PM",
  );
  if (direct) return direct.task_id;
  for (const t of scopedTasks) {
    let parentNorm = String(t.parent ?? "")
      .replace(/\.md$/i, "")
      .trim();
    const seen = new Set<string>();
    while (parentNorm && !seen.has(parentNorm)) {
      seen.add(parentNorm);
      const p = allTasks.find((x) => x.task_id === parentNorm);
      if (!p) break;
      if (p.sender === "ADMIN" && p.recipient === "PM") return p.task_id;
      parentNorm = String(p.parent ?? "")
        .replace(/\.md$/i, "")
        .trim();
    }
  }
  return hintedRoot ?? scopedTasks[0]?.task_id;
}

async function loadLedgerRows(projectRoot: string): Promise<{
  tasks: LedgerTaskRecord[];
  reports: LedgerReportRecord[];
  threads: LedgerThreadRecord[];
}> {
  const layout = resolveLedgerLayout(projectRoot);
  const readJsonl = async <T>(name: string): Promise<T[]> => {
    try {
      const raw = await fs.readFile(join(layout.ledgerDir, name), "utf-8");
      return loadJsonlLines<T>(raw);
    } catch {
      return [];
    }
  };
  let tasks = await readJsonl<LedgerTaskRecord>("tasks.jsonl");
  let reports = await readJsonl<LedgerReportRecord>("reports.jsonl");
  let threads = await readJsonl<LedgerThreadRecord>("threads.jsonl");
  if (!tasks.length && !reports.length) {
    const builder = new LedgerBuilder({ projectRoot });
    await builder.rebuild();
    tasks = await readJsonl<LedgerTaskRecord>("tasks.jsonl");
    reports = await readJsonl<LedgerReportRecord>("reports.jsonl");
    threads = await readJsonl<LedgerThreadRecord>("threads.jsonl");
  }
  return { tasks, reports, threads };
}

function findThreadByKey(
  threads: LedgerThreadRecord[],
  threadKey: string,
): LedgerThreadRecord | null {
  const key = threadKey.trim();
  return threads.find((t) => t.thread_key === key) ?? null;
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

function taskPathToFull(projectRoot: string, taskPath: string | undefined): string | null {
  const p = String(taskPath ?? "").trim();
  if (!p) return null;
  if (/^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p)) return p;
  return join(projectRoot, p.replace(/^[/\\]+/, ""));
}

async function readTaskBodyText(
  projectRoot: string,
  task: LedgerTaskRecord | null | undefined,
): Promise<string> {
  const full = taskPathToFull(projectRoot, task?.path);
  if (!full) {
    return task?.task_id ? (readTaskBodyByIdPrefix(projectRoot, task.task_id) ?? "") : "";
  }
  try {
    const raw = await fs.readFile(full, "utf-8");
    const parsed = parseMarkdownFrontmatter(raw);
    const body = String(parsed.body ?? "");
    if (body.trim()) return body;
  } catch {
    /* fall back to lifecycle lookup below */
  }
  return task?.task_id ? (readTaskBodyByIdPrefix(projectRoot, task.task_id) ?? "") : "";
}

export async function resolveThreadContext(
  projectRoot: string,
  input: ResolveThreadInput,
): Promise<ThreadContext | null> {
  const threadKeyRaw = String(input.thread_key ?? "").trim();
  const taskIdRaw = String(input.task_id ?? "").trim();
  if (!threadKeyRaw && !taskIdRaw) return null;

  const { tasks, reports, threads } = await loadLedgerRows(projectRoot);
  let thread: LedgerThreadRecord | null = null;
  if (threadKeyRaw) {
    thread = findThreadByKey(threads, threadKeyRaw);
  }
  if (!thread && taskIdRaw) {
    thread = findThreadForTask(threads, taskIdRaw);
  }
  if (!thread) {
    if (threadKeyRaw) {
      const scopedTasks = tasks.filter((t) => t.thread_key?.trim() === threadKeyRaw);
      if (!scopedTasks.length) return null;
      thread = {
        thread_key: threadKeyRaw,
        root_task_id: resolveAdminRootTaskId(scopedTasks, tasks),
        task_ids: scopedTasks.map((t) => t.task_id),
        report_ids: reports
          .filter((r) => r.thread_key?.trim() === threadKeyRaw)
          .map((r) => r.report_id ?? r.filename),
        pending_pm_review: [],
      };
    } else if (taskIdRaw) {
      const anchor = tasks.find((t) =>
        taskIdMatchesPrefix(t.task_id, taskIdRaw),
      );
      if (!anchor) return null;
      const key = anchor.thread_key?.trim();
      if (key) {
        const scopedTasks = tasks.filter((t) => t.thread_key?.trim() === key);
        thread = {
          thread_key: key,
          root_task_id: resolveAdminRootTaskId(scopedTasks, tasks, taskIdRaw),
          task_ids: scopedTasks.map((t) => t.task_id),
          report_ids: reports
            .filter(
              (r) =>
                r.thread_key?.trim() === key ||
                scopedTasks.some((st) =>
                  taskIdMatchesPrefix(r.task_id, st.task_id),
                ),
            )
            .map((r) => r.report_id ?? r.filename),
          pending_pm_review: [],
        };
      } else {
        const rootNorm = normalizeTaskId(anchor.task_id);
        const scopedTasks = tasks.filter(
          (t) =>
            taskIdMatchesPrefix(t.task_id, taskIdRaw) ||
            normalizeTaskId(t.parent ?? "") === rootNorm ||
            taskIdMatchesPrefix(rootNorm, t.parent ?? ""),
        );
        const scopedNorms = new Set(
          scopedTasks.map((t) => normalizeTaskId(t.task_id)),
        );
        const relatedReports = reports.filter(
          (r) =>
            taskIdMatchesPrefix(r.task_id, taskIdRaw) ||
            (r.parent_task_id &&
              taskIdMatchesPrefix(r.parent_task_id, taskIdRaw)) ||
            scopedNorms.has(normalizeTaskId(r.task_id ?? "")) ||
            (r.parent_task_id &&
              scopedNorms.has(normalizeTaskId(r.parent_task_id))),
        );
        const adminRoot =
          anchor.sender === "ADMIN" && anchor.recipient === "PM"
            ? anchor.task_id
            : resolveAdminRootTaskId(scopedTasks, tasks, taskIdRaw);
        thread = {
          thread_key: `task:${normalizeTaskId(adminRoot ?? anchor.task_id)}`,
          root_task_id: adminRoot,
          task_ids: scopedTasks.map((t) => t.task_id),
          report_ids: relatedReports.map((r) => r.report_id ?? r.filename),
          pending_pm_review: [],
        };
      }
    } else {
      return null;
    }
  }
  if (!thread) return null;

  const threadKey = thread.thread_key;
  const taskIds = new Set(thread.task_ids.map(normalizeTaskId));
  let scopedTasks = tasks.filter(
    (t) =>
      taskIds.has(normalizeTaskId(t.task_id)) ||
      t.thread_key?.trim() === threadKey,
  );
  const rootIdNorm = thread.root_task_id
    ? normalizeTaskId(thread.root_task_id)
    : "";
  if (
    rootIdNorm &&
    !scopedTasks.some((t) => normalizeTaskId(t.task_id) === rootIdNorm)
  ) {
    const rootRow = tasks.find(
      (t) => normalizeTaskId(t.task_id) === rootIdNorm,
    );
    if (rootRow) scopedTasks = [rootRow, ...scopedTasks];
  }
  const reportIdSet = new Set(thread.report_ids.map((id) => id.replace(/\.md$/i, "")));
  const scopedReports = reports.filter(
    (r) =>
      reportIdSet.has((r.report_id ?? r.filename).replace(/\.md$/i, "")) ||
      r.thread_key?.trim() === threadKey ||
      (r.task_id && taskIds.has(normalizeTaskId(r.task_id))),
  );
  const rootTask =
    scopedTasks.find(
      (t) =>
        t.sender === "ADMIN" &&
        t.recipient === "PM" &&
        (!thread.root_task_id || taskIdMatchesPrefix(t.task_id, thread.root_task_id)),
    ) ??
    scopedTasks.find((t) => thread.root_task_id && taskIdMatchesPrefix(t.task_id, thread.root_task_id)) ??
    null;
  const rootBody = await readTaskBodyText(projectRoot, rootTask);

  return {
    thread_key: threadKey,
    root_task_id: thread.root_task_id ?? null,
    thread,
    tasks: scopedTasks,
    reports: scopedReports,
    root_body: rootBody,
  };
}

function toTaskRow(t: LedgerTaskRecord): ThreadSummaryTaskRow {
  return {
    task_id: t.task_id,
    filename: t.filename,
    sender: t.sender,
    recipient: t.recipient,
    bucket: t.bucket,
    thread_key: t.thread_key,
    parent: t.parent,
  };
}

function toReportRow(r: LedgerReportRecord): ThreadSummaryReportRow {
  return {
    report_id: r.report_id ?? r.filename,
    filename: r.filename,
    sender: r.sender,
    recipient: r.recipient,
    task_id: r.task_id,
    status: r.status,
    thread_key: r.thread_key,
  };
}

export async function summarizeThread(
  projectRoot: string,
  threadKey: string,
): Promise<ThreadSummary | null> {
  const ctx = await resolveThreadContext(projectRoot, { thread_key: threadKey });
  if (!ctx) return null;

  const rootTask =
    ctx.tasks.find(
      (t) =>
        t.sender === "ADMIN" &&
        t.recipient === "PM" &&
        (!ctx.root_task_id || taskIdMatchesPrefix(t.task_id, ctx.root_task_id)),
    ) ??
    ctx.tasks.find((t) => ctx.root_task_id && taskIdMatchesPrefix(t.task_id, ctx.root_task_id)) ??
    null;

  const usage = aggregateUsageForThread(projectRoot, {
    thread_key: ctx.thread_key,
    task_ids: ctx.tasks.map((t) => t.task_id),
  });

  return {
    thread_key: ctx.thread_key,
    root_task_id: ctx.root_task_id,
    root_task: rootTask ? toTaskRow(rootTask) : null,
    tasks: ctx.tasks.map(toTaskRow),
    reports: ctx.reports.map(toReportRow),
    pending_pm_review: [...ctx.thread.pending_pm_review],
    usage,
    generated_at: toLocalIsoString(),
  };
}

async function readBodyExcerpt(projectRoot: string, relPath: string, max = 400): Promise<string> {
  const full = join(projectRoot, relPath.replace(/^[/\\]+/, ""));
  try {
    const raw = await fs.readFile(full, "utf-8");
    const bodyStart = raw.indexOf("\n---\n");
    const body = bodyStart >= 0 ? raw.slice(bodyStart + 5).trim() : raw.trim();
    const flat = body.replace(/\s+/g, " ").trim();
    return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
  } catch {
    return "";
  }
}

export async function closeAdminTaskDraft(
  projectRoot: string,
  input: ResolveThreadInput,
): Promise<CloseAdminTaskDraft | null> {
  const ctx = await resolveThreadContext(projectRoot, input);
  if (!ctx) return null;

  const rootTask =
    ctx.tasks.find(
      (t) =>
        t.sender === "ADMIN" &&
        t.recipient === "PM" &&
        (!ctx.root_task_id || taskIdMatchesPrefix(t.task_id, ctx.root_task_id)),
    ) ??
    ctx.tasks.find((t) => ctx.root_task_id && taskIdMatchesPrefix(t.task_id, ctx.root_task_id));

  if (!rootTask) return null;

  const productGate = await evaluateProductDeliveryGate({
    projectRoot,
    taskId: rootTask.task_id,
    taskBody: ctx.root_body ?? "",
    taskFrontmatter: rootTask.yaml,
  });
  const summaryGate = evaluatePmSummaryGate({
    thread: ctx.thread,
    tasks: ctx.tasks,
    reports: ctx.reports,
    root_task_id: rootTask.task_id,
    root_body: ctx.root_body,
  });
  if (
    productGate.classification.task_class === "product_delivery" &&
    (!productGate.allowed || !summaryGate.ok)
  ) {
    return null;
  }

  const downstream = ctx.reports.filter(
    (r) =>
      isWorkerReportToPm(r.filename, r.sender, r.recipient) &&
      (["done", "completed", "blocked", "failed", "aborted"].includes(
        String(r.status ?? "").trim().toLowerCase(),
      ) || !r.status),
  );

  const downstreamBlocks: CloseAdminTaskDraft["downstream_reports"] = [];
  for (const r of downstream) {
    const rel = r.path ?? join("fcop", "reports", r.filename);
    downstreamBlocks.push({
      report_id: r.report_id ?? r.filename,
      filename: r.filename,
      task_id: r.task_id,
      excerpt: await readBodyExcerpt(projectRoot, rel),
    });
  }

  const lines: string[] = [
    `## 执行结果`,
    ``,
    `thread_key: \`${ctx.thread_key}\``,
    `主任务: \`${rootTask.task_id}\``,
    ``,
    `## 子任务回执`,
  ];
  if (!downstreamBlocks.length) {
    lines.push(`- （ledger 未索引到 PM 侧下游 REPORT；请 read fcop/reports/ 核对后再关单）`);
  } else {
    for (const d of downstreamBlocks) {
      lines.push(`- \`${d.filename}\`${d.task_id ? `（task: ${d.task_id}）` : ""}`);
      if (d.excerpt) lines.push(`  - 摘要：${d.excerpt}`);
    }
  }
  lines.push(
    ``,
    `## PM 关单说明`,
    `本 REPORT 由 PM 内置 \`close_admin_task\` 草稿生成；请 PM 核对后 MCP \`write_report\` 落盘。`,
  );

  const body = lines.join("\n");

  return {
    task_id: rootTask.task_id,
    reporter: "PM",
    recipient: "ADMIN",
    status: "done",
    suggested_status: "ready_to_close",
    thread_key: ctx.thread_key,
    body,
    write_report_hint: {
      task_id: rootTask.task_id,
      reporter: "PM",
      recipient: "ADMIN",
      status: "done",
      body,
    },
    downstream_reports: downstreamBlocks,
    generated_at: toLocalIsoString(),
  };
}

export interface PmAdminSummaryWritten {
  path: string;
  filename: string;
  report_id: string;
  content: string;
  frontmatter: Record<string, unknown>;
}

export type PmAdminSummaryWriteResult =
  | PmAdminSummaryWritten
  | { skipped: true; skipped_reason: string };

/** 写入 PM-to-ADMIN status=done 总报告（关单硬门禁凭证）。 */
export async function writePmAdminSummaryReport(
  projectRoot: string,
  input: ResolveThreadInput,
): Promise<PmAdminSummaryWriteResult | null> {
  const ctx = await resolveThreadContext(projectRoot, input);
  if (!ctx) return null;

  const { reconcilePmWorkerReviewsPendingApprove } = await import(
    "./pmWorkerReviewAutoApprove.ts"
  );
  try {
    await reconcilePmWorkerReviewsPendingApprove(projectRoot, {
      thread_key: ctx.thread_key,
      limit: 12,
    });
  } catch {
    /* best-effort before summary gate */
  }

  const refreshed = await resolveThreadContext(projectRoot, input);
  if (!refreshed) return null;

  const productRoot = refreshed.tasks.find(
    (task) => task.task_id === refreshed.root_task_id,
  );
  const productGate = await evaluateProductDeliveryGate({
    projectRoot,
    taskId: refreshed.root_task_id ?? String(input.task_id ?? ""),
    taskBody: refreshed.root_body ?? "",
    taskFrontmatter: productRoot?.yaml,
  });
  if (!productGate.allowed) {
    return {
      skipped: true,
      skipped_reason: `close_gate_failed:${productGate.findings.join(",")}`,
    };
  }

  const gate = evaluatePmSummaryGate({
    thread: refreshed.thread,
    tasks: refreshed.tasks,
    reports: refreshed.reports,
    root_task_id: refreshed.root_task_id,
    root_body: refreshed.root_body,
  });
  if (!gate.ok) {
    return { skipped: true, skipped_reason: gate.skipped_reason };
  }

  const rootTask =
    refreshed.tasks.find((t) => taskIdMatchesPrefix(t.task_id, gate.root_task_id)) ??
    refreshed.tasks.find(
      (t) =>
        t.sender === "ADMIN" &&
        t.recipient === "PM" &&
        taskIdMatchesPrefix(t.task_id, gate.root_task_id),
    );
  if (!rootTask) return null;

  const draft = await closeAdminTaskDraft(projectRoot, input);
  if (!draft) return null;

  const layout = resolveLedgerLayout(projectRoot);
  const dateKey = toLocalIsoString().slice(0, 10).replace(/-/g, "");
  const reportPath = await nextReportPath(layout.reportsDir, dateKey);
  const filename = basename(reportPath);
  const reportId = basename(reportPath, ".md");

  const references = [
    ...gate.references,
    ...(productGate.classification.product_design_required
      ? [basename(productGate.product_brief_path), ...productGate.related_issues]
      : []),
  ];

  const body = buildPmAdminSummaryBodyRuntime(
    refreshed,
    rootTask,
    draft.downstream_reports,
  );
  const fm: Record<string, unknown> = {
    protocol: "fcop",
    version: 1,
    kind: "report",
    report_id: reportId,
    sender: "PM",
    recipient: "ADMIN",
    status: draft.status ?? "done",
    report_type: "final_summary",
    final: true,
    auto_final_summary: true,
    task_id: rootTask.task_id,
    thread_key: refreshed.thread_key,
    references,
  };
  const content = `${renderFrontmatter(fm)}\n\n${body}\n`;
  await fs.writeFile(reportPath, content, "utf-8");
  try {
    const { ReportResolver } = await import("../ledger/ReportResolver.ts");
    const resolver = new ReportResolver({
      projectRoot,
      lifecycleRoot: layout.lifecycleRoot,
    });
    await resolver.resolve(reportPath);
  } catch {
    /* best-effort: PM final report is still the durable handoff artifact */
  }
  await new LedgerBuilder({ projectRoot }).rebuild();

  return {
    path: reportPath,
    filename,
    report_id: reportId,
    content,
    frontmatter: fm,
  };
}

export async function markWaitingPmAttentionOnTask(
  projectRoot: string,
  taskId: string,
  reason: string,
  reportId?: string | null,
): Promise<void> {
  const layout = resolveLedgerLayout(projectRoot);
  const { findTaskLocationById } = await import("../lifecycle/taskPathUtils.ts");
  const located = await findTaskLocationById(layout.lifecycleRoot, taskId, {
    hotTasksDir: layout.tasksDir,
  });
  if (!located) return;
  const { TaskFrontmatterStore } = await import("../lifecycle/TaskFrontmatterStore.ts");
  const store = new TaskFrontmatterStore();
  const { fm, body } = await store.read(located.path);
  fm.display_status = "waiting_pm_attention";
  fm.pm_attention_reason = reason;
  if (reportId) fm.pm_attention_report_id = reportId;
  else delete fm.pm_attention_report_id;
  await store.write(located.path, fm, body);
  await new LedgerBuilder({ projectRoot }).rebuild();
}

/** Clears waiting_pm_attention display_status (ADMIN force-recovery SOP step 1). */
export async function clearWaitingPmAttentionOnTask(
  projectRoot: string,
  taskId: string,
): Promise<boolean> {
  const layout = resolveLedgerLayout(projectRoot);
  const { findTaskLocationById } = await import("../lifecycle/taskPathUtils.ts");
  const located = await findTaskLocationById(layout.lifecycleRoot, taskId, {
    hotTasksDir: layout.tasksDir,
  });
  if (!located) return false;
  const { TaskFrontmatterStore } = await import("../lifecycle/TaskFrontmatterStore.ts");
  const store = new TaskFrontmatterStore();
  const { fm, body } = await store.read(located.path);
  if (fm.display_status !== "waiting_pm_attention") return false;
  delete fm.display_status;
  delete fm.pm_attention_reason;
  delete fm.pm_attention_report_id;
  await store.write(located.path, fm, body);
  await new LedgerBuilder({ projectRoot }).rebuild();
  return true;
}

export async function detectThreadStall(
  projectRoot: string,
  threadKey: string,
): Promise<ThreadStallDetection | null> {
  const ctx = await resolveThreadContext(projectRoot, { thread_key: threadKey });
  if (!ctx) return null;

  const rootId =
    ctx.root_task_id ??
    ctx.tasks.find((t) => t.sender === "ADMIN" && t.recipient === "PM")?.task_id ??
    null;

  let verify: LedgerThreadVerifyResult | null = null;
  if (rootId) {
    try {
      verify = await verifyThread(projectRoot, rootId);
    } catch {
      verify = null;
    }
  }

  const findings: StallFinding[] = [];
  const suggestions: StallSuggestion[] = [];

  if (!rootId) {
    findings.push({
      code: "no_root_admin_task",
      severity: "warn",
      message: "线程缺少 ADMIN→PM 主线 TASK，关单链路不完整",
    });
  }

  for (const t of ctx.tasks) {
    if (String(t.display_status ?? "").toLowerCase() === "waiting_pm_attention") {
      const reason = String(t.pm_attention_reason ?? "").trim();
      findings.push({
        code: "waiting_pm_attention",
        severity: "error",
        message: reason
          ? `事实核查未通过，需人工裁定：${reason}`
          : "事实核查未通过，需人工裁定（REVIEW-GATE decision=needs_human）",
        entity_id: t.task_id,
      });
      suggestions.push({
        action: "read_pending_report",
        detail: "查看 REVIEW-GATE「判定说明」，人工裁定后修正 REPORT 或 mark_human_approved",
        params: { task_id: t.task_id },
      });
    }
    if (t.bucket === "inbox") {
      findings.push({
        code: "inbox_fragment",
        severity: "info",
        message: `TASK 仍在 inbox：${t.task_id}`,
        entity_id: t.task_id,
      });
    }
    // PM 下游 worker 任务：inbox 达等待阈值后也进入 wake；刚创建的 inbox
    // 仍交给正常 doorbell 调度，不立即误判为 stall。
    const workerRole = t.recipient.trim().toUpperCase();
    const openWorkerBucket =
      t.bucket === "inbox" ||
      t.bucket === "active" ||
      t.bucket === "review" ||
      t.bucket === "tasks";
    const parentId =
      (typeof t.yaml?.parent === "string" ? t.yaml.parent.trim() : "") ||
      t.parent?.trim() ||
      "";
    const validOpenMainline = parentId
      ? ctx.tasks.some(
          (parent) =>
            parent.sender === "ADMIN" &&
            parent.recipient === "PM" &&
            parent.bucket !== "done" &&
            parent.bucket !== "archive" &&
            taskIdMatchesPrefix(parent.task_id, parentId),
        )
      : false;
    const updatedAtMs = Date.parse(t.updated_at || t.created_at || "");
    const inboxWaitThresholdReached =
      t.bucket !== "inbox" ||
      (Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs >= 5 * 60_000);
    const trustedInbox = t.bucket !== "inbox" || validOpenMainline;
    const isOpenPmWorkerTask =
      t.sender === "PM" &&
      ["DEV", "OPS", "QA"].includes(workerRole) &&
      openWorkerBucket &&
      trustedInbox &&
      inboxWaitThresholdReached;
    if (isOpenPmWorkerTask) {
      const hasReport = ctx.reports.some(
        (r) =>
          isWorkerReportToPm(r.report_id ?? r.filename, r.sender, r.recipient) &&
          r.task_id &&
          taskIdMatchesPrefix(r.task_id, t.task_id),
      );
      if (!hasReport) {
        findings.push({
          code: "missing_report",
          severity: "warn",
          message: `${t.bucket} 任务无下游 REPORT：${t.task_id} → ${t.recipient}`,
          entity_id: t.task_id,
        });
        suggestions.push({
          action: "wake_downstream",
          detail: `催 ${t.recipient} 补 write_report 或继续执行`,
          params: { task_id: t.task_id, role: t.recipient, reason: "nudge" },
        });
      }
    }
  }

  if (verify) {
    for (const ent of verify.entities) {
      if (ent.computed_status === "active_stalled_done_report") {
        findings.push({
          code: "active_stalled_done_report",
          severity: "warn",
          message: ent.notes.join("; ") || `active_stalled_done_report: ${ent.id}`,
          entity_id: ent.id,
        });
        suggestions.push({
          action: "write_report",
          detail: "已有 done REPORT 但 TASK 仍在 active；勿自行 mv _lifecycle，走 Runtime 验收链或 PM 关单",
          params: rootId ? { task_id: rootId } : undefined,
        });
      }
    }
    for (const f of verify.findings) {
      findings.push({
        code: "verify_finding",
        severity: "error",
        message: f,
      });
    }
    suggestions.push({
      action: "verify_thread",
      detail: "复跑 ledger verify_thread 做交叉核对",
      params: rootId ? { task_id: rootId } : undefined,
    });
  }

  const hasPmToAdminDone =
    !!rootId && hasPmAdminSummaryReport(rootId, ctx.reports);

  const childrenSettled =
    !!rootId &&
    areAllChildrenSettledForRoot(
      rootId,
      ctx.tasks,
      ctx.thread,
      ctx.reports,
    );

  for (const reportId of ctx.thread.pending_pm_review) {
    if (hasPmToAdminDone) continue;
    findings.push({
      code: "pending_pm_review",
      severity: "info",
      message: `待 PM 审阅 REPORT：${reportId}`,
      entity_id: reportId,
    });
    suggestions.push({
      action: "read_pending_report",
      detail: "阅读 pending_pm_review 后再 write_report PM-to-ADMIN 或 submit_review",
      params: { report_id: reportId },
    });
  }

  const hasDownstreamToPm = ctx.reports.some((r) =>
    isWorkerReportToPm(r.filename, r.sender, r.recipient),
  );
  const summaryGate = rootId
    ? evaluatePmSummaryGate({
        thread: ctx.thread,
        tasks: ctx.tasks,
        reports: ctx.reports,
        root_task_id: rootId,
        root_body: ctx.root_body,
      })
    : null;
  if (
    rootId &&
    summaryGate?.ok &&
    childrenSettled &&
    !hasPmToAdminDone &&
    !ctx.thread.pending_pm_review.length
  ) {
    findings.push({
      code: "waiting_pm_summary",
      severity: "warn",
      message: `子任务已完成，缺 PM-to-ADMIN 总报告：${rootId}`,
      entity_id: rootId,
    });
    suggestions.push({
      action: "close_admin_task",
      detail: "请 PM write_report PM-to-ADMIN status=done 总报告",
      params: { thread_key: ctx.thread_key, task_id: rootId },
    });
  } else if (rootId && hasDownstreamToPm) {
    if (!hasPmToAdminDone && !ctx.thread.pending_pm_review.length) {
      if (summaryGate?.ok) {
        suggestions.push({
          action: "close_admin_task",
          detail: "下游 REPORT 已齐，可生成 PM-to-ADMIN 关单草稿并 write_report",
          params: { thread_key: ctx.thread_key, task_id: rootId },
        });
      } else if (summaryGate && !summaryGate.ok) {
        findings.push({
          code: "verify_finding",
          severity: "info",
          message: `PM 总报告门禁未通过：${summaryGate.skipped_reason}`,
          entity_id: rootId,
        });
      }
    } else if (hasPmToAdminDone) {
      suggestions.push({
        action: "close_admin_task",
        detail: "PM-to-ADMIN 关单 REPORT 已落盘；生成归档草稿并推进 lifecycle archive",
        params: { thread_key: ctx.thread_key, task_id: rootId },
      });
    }
  }

  if (!findings.length) {
    findings.push({
      code: "verify_finding",
      severity: "info",
      message: "未检测到明显 stall 信号（仍建议 summarize_thread 人工复核）",
    });
  }

  const is_stalled = findings.some(
    (f) => f.severity === "warn" || f.severity === "error",
  );

  return {
    thread_key: ctx.thread_key,
    root_task_id: rootId,
    is_stalled,
    findings,
    suggestions: dedupeSuggestions(suggestions),
    verify,
    generated_at: toLocalIsoString(),
  };
}

function dedupeSuggestions(items: StallSuggestion[]): StallSuggestion[] {
  const seen = new Set<string>();
  const out: StallSuggestion[] = [];
  for (const s of items) {
    const key = `${s.action}:${JSON.stringify(s.params ?? {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

export function defaultAgentIdForRole(role: string): string {
  const r = role.trim().toUpperCase();
  return DEFAULT_ROLE_AGENT[r] ?? `${r}-01`;
}

export function buildWakeDownstreamRequest(opts: {
  task_id: string;
  role: string;
  reason?: string;
  thread_key?: string | null;
  agent_id?: string;
  source?: string;
  caller?: string;
  caller_session_id?: string;
}): WakeDownstreamRequest {
  const taskId = normalizeTaskId(opts.task_id);
  const role = opts.role.trim().toUpperCase();
  const reason = String(opts.reason ?? "nudge").trim() || "nudge";
  const agentId = opts.agent_id?.trim() || defaultAgentIdForRole(role);
  const threadKey = opts.thread_key?.trim() || null;
  const at = toLocalIsoString();

  const message = [
    `[PM 催办 · ${reason} · 非新派单]`,
    ``,
    `task_id: \`${taskId}\`${threadKey ? `\nthread_key: \`${threadKey}\`` : ""}`,
    ``,
    `请 **第一动作** 阅读 \`fcop/ledger/views/${role}.todo.md\`，再读本 task_id 对应 TASK 与同 thread REPORT。`,
    `继续执行既有工作，或补写缺失的 \`write_report\`（仍走正常 MCP，不是催办本身产出文件）。`,
    ``,
    `禁止：write_task 新派单；禁止 shell/IDE 自行 mv \`fcop/_lifecycle/\`。`,
  ].join("\n");

  return {
    role,
    agent_id: agentId,
    task_id: taskId,
    thread_key: threadKey,
    reason,
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.caller ? { caller: opts.caller } : {}),
    ...(opts.caller_session_id ? { caller_session_id: opts.caller_session_id } : {}),
    intent: "wake",
    operator_role: "PM",
    message,
    journal_entry: {
      at,
      action: "wake_agent",
      role,
      task_id: taskId,
      thread_key: threadKey,
      reason,
      operator: "PM",
    },
  };
}

/** Plan C: wake PM report-intake when active child has done REPORT but stalled. */
export function buildPmReportIntakeWakeRequest(opts: {
  task_id: string;
  report_id?: string | null;
  thread_key?: string | null;
  reason?: string;
  agent_id?: string;
}): WakeDownstreamRequest {
  const taskId = normalizeTaskId(opts.task_id);
  const reportId = String(opts.report_id ?? "").trim() || null;
  const role = "PM";
  const reason = String(opts.reason ?? "active_stalled_done_report").trim();
  const agentId = opts.agent_id?.trim() || defaultAgentIdForRole(role);
  const threadKey = opts.thread_key?.trim() || null;
  const at = toLocalIsoString();

  const message = [
    `[PM report-intake · ${reason}]`,
    ``,
    `task_id: \`${taskId}\`${reportId ? `\nreport_id: \`${reportId}\`` : ""}${threadKey ? `\nthread_key: \`${threadKey}\`` : ""}`,
    ``,
    `下游 worker 已写 done REPORT，但 TASK 仍在 active；请按 FCoP 验收链处理：`,
    `1. 读 \`fcop/ledger/views/PM.todo.md\``,
    `2. \`pm.review_check\`（本 report / task_id）`,
    `3. 必要时 submit_review / approve_review`,
    `4. 门禁通过后 write_report PM-to-ADMIN 总报告`,
    ``,
    `PM 是唯一协调中心：先读实际 REPORT，再决定是否创建新的 DEV / QA / OPS / 其他角色 TASK；不得写死角色循环。`,
    `QA 已完成测试但产品结论 FAIL 时，QA TASK 可以收口，主线保持未完成；仅在证据支持时用 write_task 新建下一轮修复/复验任务，并引用本 REPORT。`,
    `依赖仅处于 pending 时不得当成失败或返工；交给 Runtime 排队放行。禁止 shell/IDE 自行 mv \`fcop/_lifecycle/\`。`,
  ].join("\n");

  return {
    role,
    agent_id: agentId,
    task_id: taskId,
    thread_key: threadKey,
    reason,
    intent: "wake",
    operator_role: "PM",
    message,
    journal_entry: {
      at,
      action: "wake_agent",
      role,
      task_id: taskId,
      thread_key: threadKey,
      reason: `pm_report_intake:${reason}`,
      operator: "PM",
    },
  };
}

/** ADMIN 打回后唤醒 PM：Hot Path 时 PM 亲自完成治理核查/协调；Cold Path 时派发责任角色。 */
export function buildAdminRejectPmWakeRequest(opts: {
  task_id: string;
  reason: string;
  executor_role?: string | null;
  thread_key?: string | null;
  task_path?: string | null;
  actor?: string;
  agent_id?: string;
  projectRoot?: string | null;
}): WakeDownstreamRequest {
  const taskId = normalizeTaskId(opts.task_id);
  const reason = String(opts.reason ?? "").trim() || "（未填写打回原因）";
  const actor = String(opts.actor ?? "ADMIN").trim() || "ADMIN";
  const role = "PM";
  const agentId = opts.agent_id?.trim() || defaultAgentIdForRole(role);
  const threadKey = opts.thread_key?.trim() || null;
  const taskPath = opts.task_path?.trim().replace(/\\/g, "/") || null;
  const at = toLocalIsoString();
  const wakeReason = `admin_reject:${taskId}`;

  const projectRoot = opts.projectRoot?.trim() || null;
  const taskBody =
    projectRoot != null ? readTaskBodyByIdPrefix(projectRoot, taskId) : null;
  const isHotPath = taskBody != null && isTaskHotPathBody(taskBody);

  const message = isHotPath
    ? [
        `[ADMIN 打回 · Hot Path · PM 治理核查/协调（不代表可修改产品代码）]`,
        ``,
        `task_id: \`${taskId}\`${threadKey ? `\nthread_key: \`${threadKey}\`` : ""}`,
        taskPath
          ? `task 文件: \`${taskPath}\`（正文已预载或可用 read_file 一次核对）`
          : `task 文件：fcop/_lifecycle 下完整路径`,
        `打回方: ${actor}`,
        `打回原因: ${reason}`,
        ``,
        `## 必做（按顺序）`,
        `1. MCP \`fcop_report({ lang: "zh" })\` + \`fcop_check\`（含 git diff 与 ledger 对照）`,
        `2. 只读证据探针：\`read_file\` / \`grep_files\` / 只读 shell（如 Get-Content、git diff --stat）`,
        `3. \`write_report(status=done)\` 向 ADMIN 汇总证据（禁止 interim ack 后停步）`,
        ``,
        `**PM Hot Path 允许**：fcop_report、fcop_check、read/grep 探针、write_report。`,
        `**PM Hot Path 禁止**：edit 产品代码、shell 写入、创建补丁脚本、直接运行实现性修改。`,
        `**若需代码/UI/API/测试实现**：必须 MCP \`write_task\` 派发给责任角色（代码→DEV、运行态→OPS、验收→QA、审计→EVAL）。`,
        `**无法唤醒目标角色时**：仍应 \`write_task\` 到对应角色 inbox，并向 ADMIN 报告等待执行。`,
        `**禁止**：以「Hot Path / 亲自返工 / 当前只有我一个 agent」为借口直接 edit 或 shell 写产品文件。`,
        `禁止：shell/IDE 自行 mv \`fcop/_lifecycle/\`。`,
      ].join("\n")
    : [
        `[ADMIN 打回 · Cold Path · PM 派发责任角色（不是 PM 自己落地）]`,
        ``,
        `task_id: \`${taskId}\`${threadKey ? `\nthread_key: \`${threadKey}\`` : ""}`,
        taskPath
          ? `task 文件（第一动作 read_file）: \`${taskPath}\``
          : `task 文件：用 read_file 读取 fcop/_lifecycle 下完整路径（勿只用 basename）`,
        `打回方: ${actor}`,
        `打回原因: ${reason}`,
        ``,
        `## 必做（按顺序）`,
        `1. \`read_file\` 上述 TASK 全文 + \`fcop/ledger/views/PM.todo.md\`「ADMIN 判定打回」区块`,
        `2. 按 TASK 正文与打回原因，用 MCP **write_task** 向 DEV / QA / OPS 等执行方派返工子任务。若存在 DEV→QA 顺序：先创建 DEV 并取得新 task_id，再创建 QA；QA 的 \`references\` 必须同时包含 \`${taskId}\` 与本轮新 DEV task_id（工具支持时同步写 \`depends_on=[新 DEV task_id]\`）。\`thread_key\` 继承父任务；body 仅 Markdown。`,
        `3. **禁止** 此阶段仅 \`write_report\` 向 ADMIN _ack_ 打回；下游 TASK 落盘后再汇总`,
        ``,
        `禁止：忽略打回原因；禁止 shell/IDE 自行 mv \`fcop/_lifecycle/\`。`,
      ].join("\n");

  return {
    role,
    agent_id: agentId,
    task_id: taskId,
    thread_key: threadKey,
    reason: wakeReason,
    intent: "wake",
    operator_role: "PM",
    message,
    journal_entry: {
      at,
      action: "wake_agent",
      role,
      task_id: taskId,
      thread_key: threadKey,
      reason: wakeReason,
      operator: "PM",
    },
  };
}

function reportMatchesId(report: LedgerReportRecord, id: string): boolean {
  const norm = normalizeTaskId(id);
  const rid = normalizeTaskId(report.report_id ?? report.filename.replace(/\.md$/i, ""));
  const fname = report.filename.replace(/\.md$/i, "");
  return rid === norm || normalizeTaskId(fname) === norm;
}

function pickLatestReportForTask(
  reports: LedgerReportRecord[],
  taskPrefix: string,
): LedgerReportRecord | undefined {
  const related = reports.filter(
    (r) =>
      ((r.source_task_id && taskIdMatchesPrefix(r.source_task_id, taskPrefix)) ||
        (r.task_id && taskIdMatchesPrefix(r.task_id, taskPrefix))) &&
      (isWorkerReportToPm(r.report_id ?? r.filename, r.sender, r.recipient) ||
        isPmToAdminReport(r.sender, r.recipient)),
  );
  if (!related.length) return undefined;
  return [...related].sort((a, b) => {
    const terminalDelta =
      Number(isTerminalReviewReport(b)) - Number(isTerminalReviewReport(a));
    if (terminalDelta !== 0) return terminalDelta;
    return (b.report_id ?? b.filename).localeCompare(a.report_id ?? a.filename);
  })[0];
}

function isTerminalReviewReport(report: LedgerReportRecord): boolean {
  const status = String(report.status ?? "").trim().toLowerCase();
  return status === "done" || status === "completed" || status === "blocked";
}

/** PM 内置 skill：回执验收检查（不 write_report、不动 _lifecycle）。 */
export async function reviewCheck(
  projectRoot: string,
  input: ReviewCheckInput,
): Promise<ReviewCheckResult | null> {
  const taskIdRaw = String(input.task_id ?? "").trim();
  const reportIdRaw = String(input.report_id ?? "").trim();
  if (!taskIdRaw && !reportIdRaw) return null;

  const { tasks, reports } = await loadLedgerRows(projectRoot);
  const findings: ReviewCheckFinding[] = [];

  let report: LedgerReportRecord | undefined;
  if (reportIdRaw) {
    report = reports.find((r) => reportMatchesId(r, reportIdRaw));
    if (!report) {
      findings.push({
        code: "report_missing",
        severity: "error",
        message: `ledger 无 REPORT ${reportIdRaw}`,
      });
      return {
        ok: false,
        task_id: taskIdRaw || null,
        report_id: reportIdRaw,
        findings,
        generated_at: toLocalIsoString(),
      };
    }
  } else if (taskIdRaw) {
    report = pickLatestReportForTask(reports, taskIdRaw);
    if (!report) {
      findings.push({
        code: "report_missing",
        severity: "error",
        message: `无 REPORT 关联 task_id ${taskIdRaw}`,
      });
      return {
        ok: false,
        task_id: taskIdRaw,
        report_id: null,
        findings,
        generated_at: toLocalIsoString(),
      };
    }
  }

  if (!report) {
    return {
      ok: false,
      task_id: taskIdRaw || null,
      report_id: reportIdRaw || null,
      findings,
      generated_at: toLocalIsoString(),
    };
  }

  if (
    isGovernanceReportToPm(
      report.report_id ?? report.filename,
      report.sender,
    )
  ) {
    return {
      ok: true,
      task_id: taskIdRaw || report.task_id || null,
      report_id: report.report_id ?? report.filename,
      findings: [
        {
          code: "governance_report_excluded",
          severity: "info",
          message: `治理层 REPORT 不参与 worker review：${report.filename}`,
        },
      ],
      generated_at: toLocalIsoString(),
    };
  }

  const linkedTaskPrefix =
    taskIdRaw || String(report.task_id ?? "").trim() || "";
  if (linkedTaskPrefix) {
    const linkedTask = tasks.find((t) =>
      taskIdMatchesPrefix(t.task_id, linkedTaskPrefix),
    );
    const attentionReportId = String(
      linkedTask?.pm_attention_report_id ?? "",
    )
      .replace(/\.md$/i, "")
      .trim();
    const currentReportId = String(report.report_id ?? report.filename ?? "")
      .replace(/\.md$/i, "")
      .trim();
    const waitingForPm =
      String(linkedTask?.display_status ?? "").toLowerCase() ===
      "waiting_pm_attention";
    if (linkedTask && waitingForPm && !attentionReportId) {
      // Legacy markers without REPORT provenance were also produced by the
      // old "wake skipped -> review missing report" bug. A real receipt now
      // exists, so remove that stale marker from disk as well as ignoring it.
      await clearWaitingPmAttentionOnTask(projectRoot, linkedTask.task_id);
      linkedTask.display_status = undefined;
      linkedTask.pm_attention_reason = undefined;
    }
    if (
      linkedTask &&
      waitingForPm &&
      Boolean(attentionReportId) &&
      taskIdMatchesPrefix(attentionReportId, currentReportId)
    ) {
      const attn = String(linkedTask.pm_attention_reason ?? "").trim();
      findings.push({
        code: "fact_check_needs_human",
        severity: "error",
        message: attn
          ? `自动事实核查未通过，需人工裁定：${attn}`
          : "自动事实核查未通过，需人工裁定（decision=needs_human）",
      });
    }
  }

  let raw = "";
  try {
    raw = await fs.readFile(report.path, "utf-8");
  } catch {
    findings.push({
      code: "report_file_missing",
      severity: "error",
      message: `磁盘文件缺失: ${report.path}`,
    });
  }

  const fm = raw ? parseMarkdownFrontmatter(raw) : {};
  const fmTaskId = strField(fm, "task_id");
  const fmStatus = strField(fm, "status") || report.status;
  const superseded = strField(fm, "superseded_by");
  const references = listField(fm, "references");
  const ledgerRefs = report.references ?? [];

  if (superseded) {
    findings.push({
      code: "superseded",
      severity: "warn",
      message: `已被 supersede: ${superseded}`,
    });
  }

  const effectiveTaskId = taskIdRaw || fmTaskId || report.task_id || null;
  if (taskIdRaw && fmTaskId && !taskIdMatchesPrefix(fmTaskId, taskIdRaw)) {
    findings.push({
      code: "task_id_mismatch",
      severity: "error",
      message: `frontmatter task_id=${fmTaskId} 与输入 ${taskIdRaw} 不一致`,
    });
  }
  if (!fmTaskId && !report.task_id && !references.length && !ledgerRefs.length) {
    findings.push({
      code: "missing_task_id",
      severity: "warn",
      message: "缺少 task_id 与 references 交叉引用",
    });
  }
  if (taskIdRaw && !references.length && !ledgerRefs.length) {
    findings.push({
      code: "missing_references",
      severity: "info",
      message: "无 references 交叉引用（非阻塞）",
    });
  }

  const body = raw.replace(/^---[\s\S]*?---\r?\n?/, "").trim();
  const hasEvidence =
    /##\s*(结论|结果|详情|验收|证据|Evidence|Outcome|Summary)/i.test(body) ||
    body.length >= 80;
  if (!hasEvidence) {
    findings.push({
      code: "weak_evidence",
      severity: "warn",
      message: "正文缺少结论/证据段落或过短",
    });
  }

  const acceptable = ["done", "completed", "blocked"].includes(
    fmStatus.trim().toLowerCase(),
  );
  if (!acceptable) {
    findings.push({
      code: "status_not_acceptable",
      severity: "warn",
      message: `status=${fmStatus || "unknown"} 未明确 done/completed/blocked`,
    });
  }

  const qaAcceptance = evaluateQaReportAcceptance({
    status: fmStatus || report.status,
    body,
    sender: strField(fm, "sender") || report.sender,
    recipient: strField(fm, "recipient") || report.recipient,
  });
  if (qaAcceptance?.blocksReview) {
    findings.push({
      code:
        qaAcceptance.verdict === "blocked"
          ? "qa_report_dependency_blocked"
          : "qa_acceptance_fail",
      severity: "error",
      message: qaAcceptance.reason,
    });
  }

  if (effectiveTaskId) {
    const task = tasks.find((t) => taskIdMatchesPrefix(t.task_id, effectiveTaskId));
    if (!task) {
      findings.push({
        code: "task_not_found",
        severity: "info",
        message: `ledger 未索引 TASK ${effectiveTaskId}`,
      });
    }
  }

  const ok = !findings.some((f) => f.severity === "error");

  return {
    ok,
    task_id: effectiveTaskId,
    report_id: report.report_id ?? report.filename,
    findings,
    report: {
      filename: report.filename,
      sender: report.sender,
      recipient: report.recipient,
      status: fmStatus || report.status,
      path: report.path,
    },
    generated_at: toLocalIsoString(),
  };
}

/** Append wake audit line per FCoP-ADOPTED-0002 (optional, no lifecycle MV). */
export async function appendWakeJournal(
  projectRoot: string,
  entry: WakeDownstreamRequest["journal_entry"],
): Promise<void> {
  const layout = resolveLedgerLayout(projectRoot);
  const journalPath = join(layout.ledgerDir, "journal.jsonl");
  await fs.mkdir(layout.ledgerDir, { recursive: true });
  await fs.appendFile(journalPath, `${JSON.stringify(entry)}\n`, "utf-8");
}
