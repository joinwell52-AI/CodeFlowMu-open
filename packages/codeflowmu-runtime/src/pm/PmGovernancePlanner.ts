/**
 * PM 自动治理循环：读 PM.todo / threads.jsonl / ledger，按线程状态选 skill 并落盘 cycle journal。
 * wake_downstream：有 executor + allow_auto_wake 时在限流窗口内自动 wake；已有 REPORT 则跳过 wake 改 review_check。
 */

import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";

import { findReportForTaskOnDisk } from "../_internal/report-reconcile.ts";
import { isWorkerReportToPm } from "../fcop/governance.ts";
import { LedgerBuilder } from "../ledger/LedgerBuilder.ts";
import { resolveLedgerLayout } from "../ledger/paths.ts";
import { settleVirtualPmBranchHotPathTask, settleVirtualPmLifecycleReviewTask } from "../ledger/virtualPmBranchSettle.ts";
import { maybeWriteEvalObservation } from "../eval/EvalObservationGenerator.ts";
import type { PmBuiltinSkillId } from "./PmSkillManifest.ts";
import {
  closeAdminTaskDraft,
  detectThreadStall,
  isReportId,
  isTaskId,
  markWaitingPmAttentionOnTask,
  reviewCheck,
  summarizeThread,
  writePmAdminSummaryReport,
  buildWakeDownstreamRequest,
  buildPmReportIntakeWakeRequest,
  type PmAdminSummaryWriteResult,
  type ThreadStallDetection,
  type WakeDownstreamRequest,
} from "./PmGovernanceActions.ts";
import { tryAutoSubmitReviewForActiveChild } from "./pmAutoSubmitReview.ts";
import { reconcilePmWorkerReviewsPendingApprove } from "./pmWorkerReviewAutoApprove.ts";
import { aggregateUsageForThread } from "./UsageAggregator.ts";
import {
  evaluateWakeAllowance,
  evaluateStallIntakeWakeAllowance,
  loadPmGovernanceWaitState,
  recordStallIntakeWakeExecuted,
  recordWakeExecuted,
  savePmGovernanceWaitState,
} from "./PmGovernanceWaitState.ts";
import {
  channelFromGovernanceTrigger,
  recordSkillInvocation,
} from "./SkillInvocationJournal.ts";

export type PmGovernanceTrigger =
  | "pm_wake"
  | "patrol"
  | "api"
  | "report_arrival";

export type PmGovernanceJudgmentMode = "suggest" | "executed";

export type PmGovernanceJudgmentOutcome = "ok" | "failed" | "skipped";

export type PmGovernanceDetectedState =
  | "pending_pm_review"
  | "waiting_pm_attention"
  | "active_stalled_done_report"
  | "missing_report"
  | "waiting_pm_summary"
  | "ready_to_close_admin"
  | "unknown";

export type PmGovernanceSafetyLevel =
  | "read_only"
  | "draft_only"
  | "suggest_only"
  | "auto_wake"
  | "wake_throttled";

/** Planner 对外标准 decision 字段（API / Panel / wake prompt） */
export interface PmGovernanceDecision {
  thread_key: string;
  task_id: string | null;
  detected_state: PmGovernanceDetectedState;
  suggested_skill: PmBuiltinSkillId;
  reason: string;
  safety_level: PmGovernanceSafetyLevel;
  requires_confirmation: boolean;
  can_auto_execute: boolean;
  evidence_paths: string[];
  /** 执行结果（cycle 运行后填充） */
  outcome?: PmGovernanceJudgmentOutcome;
  persisted?: boolean;
  persist_path?: string | null;
  summary?: string;
  at?: string;
}

export interface ParsedPmTodoPendingReview {
  task_id: string;
  thread_key: string;
}

export interface ParsedPmTodo {
  pending_reviews: ParsedPmTodoPendingReview[];
  thread_keys: string[];
}

export interface PmGovernanceJudgmentPlan {
  skill_id: PmBuiltinSkillId;
  thread_key: string;
  task_id: string | null;
  report_id: string | null;
  reason: string;
  priority: number;
  mode: PmGovernanceJudgmentMode;
}

export interface PmGovernanceJudgmentResult extends PmGovernanceJudgmentPlan {
  outcome: PmGovernanceJudgmentOutcome;
  persisted: boolean;
  persist_path: string | null;
  summary: string;
  payload?: unknown;
  at: string;
}

export interface PmGovernanceCycleRecord {
  cycle_id: string;
  triggered_by: PmGovernanceTrigger;
  at: string;
  primary_skill_id: PmBuiltinSkillId | null;
  primary_thread_key: string | null;
  /** 标准 planner decisions（与 judgments 同序，供 API/Panel） */
  decisions: PmGovernanceDecision[];
  judgments: PmGovernanceJudgmentResult[];
  prompt_summary: string;
}

export interface WakeDownstreamExecutorResult {
  ok: boolean;
  outcome?: "ok" | "skipped" | "delayed" | "error";
  session_id?: string;
  agent_id?: string;
  error?: string;
  skipped?: boolean;
  reason?: string;
  /** Transient SDK backoff exhausted — not a hard task failure. */
  delayed?: boolean;
  /** Milliseconds until a delayed wake should be retried. */
  remainingMs?: number;
  delayedReason?: string;
  untilMs?: number;
  cooldownReason?: string;
  policy?: "PM_STOP" | "ESCALATE_ADMIN_FORCE_RECOVERY";
  current_leg?: string | null;
  blocked_target?: string;
  next_allowed_agent?: string | null;
  next_owner?: string;
}

/** Shell/runtime 注入：实际 startSession + journal（planner 不直接调 SDK）。 */
export type WakeDownstreamExecutor = (
  req: WakeDownstreamRequest,
) => Promise<WakeDownstreamExecutorResult>;

export interface RunPmGovernanceCycleOpts {
  triggered_by?: PmGovernanceTrigger;
  max_threads?: number;
  max_judgments?: number;
  /** 提供时 missing_report 可在安全窗口内自动 wake（仍受 wait-state 限流）。 */
  wake_downstream?: WakeDownstreamExecutor;
  allow_auto_wake?: boolean;
  /** 默认 true：门禁通过时自动写入 PM-to-ADMIN 总报告；仅显式 `false` 时只落关单草稿。 */
  auto_review?: boolean;
}

export function pmGovernanceDir(projectRoot: string): string {
  return join(projectRoot, ".codeflowmu", "pm-governance");
}

export function pmGovernanceCycleJournalPath(projectRoot: string): string {
  return join(pmGovernanceDir(projectRoot), "cycle.jsonl");
}

export function pmGovernanceDraftsDir(projectRoot: string): string {
  return join(pmGovernanceDir(projectRoot), "drafts");
}

const ACTIVE_STALE_MS = 6 * 60 * 60 * 1000;

export async function parsePmTodoMd(projectRoot: string): Promise<ParsedPmTodo> {
  const layout = resolveLedgerLayout(projectRoot);
  const viewsDir = join(layout.ledgerDir, "views");
  const todoPath = join(viewsDir, "PM.todo.md");
  let raw = "";
  try {
    raw = await fs.readFile(todoPath, "utf-8");
  } catch {
    return { pending_reviews: [], thread_keys: [] };
  }

  const pending_reviews: ParsedPmTodoPendingReview[] = [];
  const threadSet = new Set<string>();

  for (const line of raw.split(/\r?\n/)) {
    const pending = /pending_pm_review:\s*`([^`]+)`\s*\(([^)]+)\)/.exec(line);
    if (pending) {
      pending_reviews.push({
        task_id: pending[1]!.trim(),
        thread_key: pending[2]!.trim(),
      });
      threadSet.add(pending[2]!.trim());
    }
    const waitingSummary = /\b(?:waiting_pm_summary|ready_to_close_admin):\s*`?([^`\s(]+)`?\s*\(([^)]+)\)/.exec(line);
    if (waitingSummary) {
      threadSet.add(waitingSummary[2]!.trim());
    }
    const threadInLine = /thread_key[=:]\s*`?([a-zA-Z0-9._:#-]+)`?/.exec(line);
    if (threadInLine) threadSet.add(threadInLine[1]!.trim());
  }

  return { pending_reviews, thread_keys: [...threadSet] };
}

async function rebuildLedgerBestEffort(projectRoot: string): Promise<void> {
  try {
    await new LedgerBuilder({ projectRoot }).rebuild();
  } catch {
    /* Planner refresh is best-effort; keep the governance cycle alive. */
  }
}

async function readThreadKeysFromJsonl(projectRoot: string): Promise<string[]> {
  const layout = resolveLedgerLayout(projectRoot);
  try {
    const raw = await fs.readFile(join(layout.ledgerDir, "threads.jsonl"), "utf-8");
    const keys = new Set<string>();
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const row = JSON.parse(t) as { thread_key?: string; pending_pm_review?: string[] };
        if (row.thread_key) keys.add(row.thread_key);
      } catch {
        /* skip bad line */
      }
    }
    return [...keys];
  } catch {
    return [];
  }
}

export async function collectPlannerThreadKeys(
  projectRoot: string,
  opts?: { max?: number },
): Promise<string[]> {
  const max = opts?.max ?? 16;
  const todo = await parsePmTodoMd(projectRoot);
  const fromJsonl = await readThreadKeysFromJsonl(projectRoot);
  const ordered: string[] = [];
  const seen = new Set<string>();

  const push = (k: string) => {
    const key = k.trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    ordered.push(key);
  };

  for (const p of todo.pending_reviews) push(p.thread_key);
  for (const k of todo.thread_keys) push(k);
  for (const k of fromJsonl) push(k);

  return ordered.slice(0, max);
}

function normalizeTaskId(taskId: string): string {
  return taskId.replace(/\.md$/i, "").trim();
}

function taskIdMatchesPrefix(taskId: string, prefix: string): boolean {
  const norm = normalizeTaskId(taskId).toUpperCase();
  const p = normalizeTaskId(prefix).toUpperCase();
  return norm === p || norm.startsWith(`${p}-`) || p.startsWith(`${norm}-`);
}

/** 从 ledger tasks.jsonl 解析下游 recipient 角色码（优先于 reason 正则）。 */
export async function resolveTaskRecipientRole(
  projectRoot: string,
  taskId: string,
): Promise<string | null> {
  const layout = resolveLedgerLayout(projectRoot);
  let raw = "";
  try {
    raw = await fs.readFile(join(layout.ledgerDir, "tasks.jsonl"), "utf-8");
  } catch {
    return null;
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t) as { task_id?: string; recipient?: string };
      if (!row.task_id || !taskIdMatchesPrefix(row.task_id, taskId)) continue;
      const rec = String(row.recipient ?? "").trim();
      if (!rec) return null;
      return rec.split(".")[0]!.trim().toUpperCase();
    } catch {
      /* skip */
    }
  }
  return null;
}

function planFromStall(
  stall: ThreadStallDetection,
  todo: ParsedPmTodo,
  allowAutoWake = false,
): PmGovernanceJudgmentPlan[] {
  const wakeMode: PmGovernanceJudgmentMode = allowAutoWake ? "executed" : "suggest";
  const plans: PmGovernanceJudgmentPlan[] = [];
  const threadKey = stall.thread_key;
  const rootId = stall.root_task_id;

  for (const f of stall.findings) {
    if (f.code === "waiting_pm_attention") {
      plans.push({
        skill_id: "pm.review_check",
        thread_key: threadKey,
        task_id: f.entity_id?.trim() || null,
        report_id: null,
        reason: f.message,
        priority: 5,
        mode: "executed",
      });
    }
    if (f.code === "pending_pm_review") {
      const entity = f.entity_id?.trim() || "";
      const fromTodo = todo.pending_reviews.find(
        (p) => p.thread_key === threadKey && (p.task_id === entity || !entity),
      );
      const todoEntity = fromTodo?.task_id?.trim() || entity;
      const reportId = isReportId(todoEntity) ? todoEntity : null;
      const taskId = isTaskId(todoEntity)
        ? todoEntity
        : reportId
          ? null
          : todoEntity || null;
      plans.push({
        skill_id: "pm.review_check",
        thread_key: threadKey,
        task_id: taskId,
        report_id: reportId,
        reason: f.message,
        priority: 10,
        mode: "executed",
      });
    }
    if (f.code === "waiting_pm_summary") {
      plans.push({
        skill_id: "pm.close_admin_task",
        thread_key: threadKey,
        task_id: f.entity_id?.trim() || rootId,
        report_id: null,
        reason: f.message,
        priority: 35,
        mode: "executed",
      });
    }
    if (f.code === "active_stalled_done_report") {
      const entityId = f.entity_id?.trim() || rootId;
      plans.push({
        skill_id: "pm.review_check",
        thread_key: threadKey,
        task_id: entityId ?? null,
        report_id: null,
        reason: f.message,
        priority: 15,
        mode: "executed",
      });
      plans.push({
        skill_id: "pm.detect_thread_stall",
        thread_key: threadKey,
        task_id: entityId ?? null,
        report_id: null,
        reason: f.message,
        priority: 20,
        mode: "executed",
      });
    }
    if (f.code === "missing_report") {
      plans.push({
        skill_id: "pm.wake_downstream",
        thread_key: threadKey,
        task_id: f.entity_id?.trim() || null,
        report_id: null,
        reason: f.message,
        priority: 30,
        mode: wakeMode,
      });
    }
  }

  for (const s of stall.suggestions) {
    if (s.action === "close_admin_task") {
      const taskId = s.params?.task_id ?? rootId ?? null;
      plans.push({
        skill_id: "pm.close_admin_task",
        thread_key: s.params?.thread_key ?? threadKey,
        task_id: taskId,
        report_id: null,
        reason: s.detail,
        priority: 40,
        mode: "executed",
      });
    }
    if (s.action === "wake_downstream" && s.params?.task_id) {
      const exists = plans.some(
        (p) => p.skill_id === "pm.wake_downstream" && p.task_id === s.params!.task_id,
      );
      if (!exists) {
        plans.push({
          skill_id: "pm.wake_downstream",
          thread_key: threadKey,
          task_id: s.params.task_id,
          report_id: null,
          reason: s.detail,
          priority: 30,
          mode: wakeMode,
        });
      }
    }
  }

  return dedupePlans(plans);
}

function relProjectPath(projectRoot: string, absPath: string): string {
  try {
    return relative(projectRoot, absPath).replace(/\\/g, "/");
  } catch {
    return absPath.replace(/\\/g, "/");
  }
}

function planToDetectedState(plan: PmGovernanceJudgmentPlan): PmGovernanceDetectedState {
  switch (plan.skill_id) {
    case "pm.review_check":
      return /事实核查未通过|waiting_pm_attention|REVIEW-GATE/i.test(plan.reason)
        ? "waiting_pm_attention"
        : "pending_pm_review";
    case "pm.detect_thread_stall":
      return "active_stalled_done_report";
    case "pm.wake_downstream":
      return "missing_report";
    case "pm.close_admin_task":
      return /缺 PM-to-ADMIN|waiting_pm_summary/i.test(plan.reason)
        ? "waiting_pm_summary"
        : "ready_to_close_admin";
    default:
      return "unknown";
  }
}

function planToSafety(plan: PmGovernanceJudgmentPlan): {
  safety_level: PmGovernanceSafetyLevel;
  requires_confirmation: boolean;
  can_auto_execute: boolean;
} {
  switch (plan.skill_id) {
    case "pm.review_check":
    case "pm.detect_thread_stall":
      return { safety_level: "read_only", requires_confirmation: false, can_auto_execute: true };
    case "pm.close_admin_task":
      return { safety_level: "read_only", requires_confirmation: false, can_auto_execute: true };
    case "pm.wake_downstream":
      return { safety_level: "suggest_only", requires_confirmation: true, can_auto_execute: false };
    default:
      return { safety_level: "read_only", requires_confirmation: true, can_auto_execute: false };
  }
}

function planToDecision(plan: PmGovernanceJudgmentPlan, evidence_paths: string[]): PmGovernanceDecision {
  const safety = planToSafety(plan);
  return {
    thread_key: plan.thread_key,
    task_id: plan.task_id,
    detected_state: planToDetectedState(plan),
    suggested_skill: plan.skill_id,
    reason: plan.reason,
    evidence_paths,
    ...safety,
  };
}

function judgmentToSafety(j: PmGovernanceJudgmentResult): {
  safety_level: PmGovernanceSafetyLevel;
  requires_confirmation: boolean;
  can_auto_execute: boolean;
} {
  if (j.skill_id === "pm.wake_downstream") {
    if (j.mode === "executed" && j.outcome === "ok") {
      const payload = j.payload as { skipped_wake?: boolean } | undefined;
      if (payload?.skipped_wake) {
        return {
          safety_level: "read_only",
          requires_confirmation: false,
          can_auto_execute: true,
        };
      }
      return {
        safety_level: "auto_wake",
        requires_confirmation: false,
        can_auto_execute: true,
      };
    }
    if (
      j.outcome === "skipped" &&
      /限流|等待窗口|已升级|delayed|transient|SDK transient/.test(j.summary)
    ) {
      return {
        safety_level: "wake_throttled",
        requires_confirmation: true,
        can_auto_execute: false,
      };
    }
  }
  if (j.skill_id === "pm.close_admin_task") {
    if (j.persisted && j.persist_path && /\.md$/i.test(j.persist_path)) {
      return {
        safety_level: "read_only",
        requires_confirmation: false,
        can_auto_execute: true,
      };
    }
    if (
      j.outcome === "skipped" &&
      /pm_admin_final_already_exists|总报告门禁|总报告已存在/.test(j.summary ?? "")
    ) {
      return {
        safety_level: "read_only",
        requires_confirmation: false,
        can_auto_execute: true,
      };
    }
    if (j.persisted && j.persist_path && /\.json$/i.test(j.persist_path)) {
      return {
        safety_level: "draft_only",
        requires_confirmation: true,
        can_auto_execute: false,
      };
    }
  }
  return planToSafety(j);
}

function judgmentToDecision(j: PmGovernanceJudgmentResult): PmGovernanceDecision {
  const safety = judgmentToSafety(j);
  let detected_state = planToDetectedState(j);
  if (
    j.skill_id === "pm.close_admin_task" &&
    j.outcome === "ok" &&
    j.persisted &&
    j.persist_path &&
    /\.md$/i.test(j.persist_path)
  ) {
    detected_state = "ready_to_close_admin";
  } else if (
    j.skill_id === "pm.close_admin_task" &&
    j.outcome === "skipped" &&
    /pm_admin_final_already_exists|总报告已存在/.test(j.summary ?? "")
  ) {
    detected_state = "ready_to_close_admin";
  }
  return {
    thread_key: j.thread_key,
    task_id: j.task_id,
    detected_state,
    suggested_skill: j.skill_id,
    reason: j.reason,
    evidence_paths: [],
    ...safety,
    outcome: j.outcome,
    persisted: j.persisted,
    persist_path: j.persist_path,
    summary: j.summary,
    at: j.at,
  };
}

const V3_LIFECYCLE_BUCKETS = new Set(["inbox", "active", "review", "done", "archive"]);
const V2_FCOP_BUCKETS = new Set(["tasks", "reports", "issues", "shared", "log"]);

function ledgerTaskEvidencePath(bucket: string, filename: string): string {
  if (V3_LIFECYCLE_BUCKETS.has(bucket)) {
    return `fcop/_lifecycle/${bucket}/${filename}`;
  }
  if (V2_FCOP_BUCKETS.has(bucket)) {
    return `fcop/${bucket}/${filename}`;
  }
  return `fcop/_lifecycle/${bucket}/${filename}`;
}

async function collectEvidencePaths(
  projectRoot: string,
  plan: PmGovernanceJudgmentPlan,
  stall: ThreadStallDetection,
): Promise<string[]> {
  const layout = resolveLedgerLayout(projectRoot);
  const viewsDir = join(layout.ledgerDir, "views");
  const paths = new Set<string>([
    relProjectPath(projectRoot, join(viewsDir, "PM.todo.md")),
    relProjectPath(projectRoot, join(layout.ledgerDir, "threads.jsonl")),
    relProjectPath(projectRoot, join(layout.ledgerDir, "tasks.jsonl")),
    relProjectPath(projectRoot, join(layout.ledgerDir, "reports.jsonl")),
  ]);

  const summary = await summarizeThread(projectRoot, plan.thread_key);
  if (summary) {
    for (const t of summary.tasks) {
      if (plan.task_id && t.task_id !== plan.task_id) continue;
      if (t.bucket && t.filename) {
        paths.add(ledgerTaskEvidencePath(t.bucket, t.filename));
      }
    }
    for (const r of summary.reports) {
      if (plan.task_id && r.task_id && r.task_id !== plan.task_id) continue;
      paths.add(`fcop/reports/${r.filename}`);
    }
    for (const day of summary.usage.days_scanned) {
      paths.add(`fcop/logs/usage/usage-${day}.jsonl`);
    }
  } else {
    const taskIds = [plan.task_id, stall.root_task_id].filter(Boolean) as string[];
    const usage = aggregateUsageForThread(projectRoot, {
      thread_key: plan.thread_key,
      task_ids: taskIds,
    });
    for (const day of usage.days_scanned) {
      paths.add(`fcop/logs/usage/usage-${day}.jsonl`);
    }
  }

  return [...paths].slice(0, 14);
}

export function flattenRecentPmGovernanceDecisions(
  cycles: PmGovernanceCycleRecord[],
  limit = 20,
): PmGovernanceDecision[] {
  const out: PmGovernanceDecision[] = [];
  for (const cycle of cycles) {
    const batch =
      cycle.decisions?.length > 0
        ? cycle.decisions
        : (cycle.judgments ?? []).map((j) => judgmentToDecision(j));
    for (const d of batch) {
      out.push({ ...d, at: d.at ?? cycle.at });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function dedupePlans(plans: PmGovernanceJudgmentPlan[]): PmGovernanceJudgmentPlan[] {
  const seen = new Set<string>();
  const out: PmGovernanceJudgmentPlan[] = [];
  for (const p of [...plans].sort((a, b) => a.priority - b.priority)) {
    const key = `${p.skill_id}:${p.thread_key}:${p.task_id ?? ""}:${p.report_id ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

async function isActiveTaskStale(
  projectRoot: string,
  taskPath: string | undefined,
): Promise<boolean> {
  if (!taskPath) return false;
  const full = join(projectRoot, taskPath.replace(/^[/\\]+/, ""));
  try {
    const st = await fs.stat(full);
    return Date.now() - st.mtimeMs > ACTIVE_STALE_MS;
  } catch {
    return false;
  }
}

/** 默认自动写 PM-to-ADMIN 总报告；仅显式 `auto_review: false` 时只落关单草稿。 */
function pmSummaryAutoWriteEnabled(cycleOpts?: RunPmGovernanceCycleOpts): boolean {
  return cycleOpts?.auto_review !== false;
}

async function finalizePmAdminSummaryWrite(
  projectRoot: string,
  written: Extract<PmAdminSummaryWriteResult, { path: string }>,
): Promise<void> {
  await maybeWriteEvalObservation({
    projectRoot,
    pmReportPath: written.path,
    pmReportFilename: written.filename,
    pmReportContent: written.content,
    pmReportFm: written.frontmatter,
  }).catch(() => undefined);
}

function judgmentFromPmSummaryWrite(
  base: PmGovernanceJudgmentResult,
  written: Extract<PmAdminSummaryWriteResult, { path: string }>,
): PmGovernanceJudgmentResult {
  return {
    ...base,
    outcome: "ok",
    persisted: true,
    persist_path: written.path,
    summary: `PM-to-ADMIN 总报告已写入 · ${written.report_id}`,
    payload: written,
  };
}

async function maybeAutoWritePmAdminSummaryReport(
  projectRoot: string,
  input: { thread_key: string; task_id?: string | null },
): Promise<PmAdminSummaryWriteResult | null> {
  return writePmAdminSummaryReport(projectRoot, {
    thread_key: input.thread_key,
    task_id: input.task_id ?? undefined,
  });
}

async function appendPmSummaryAfterReview(
  projectRoot: string,
  cycleOpts: RunPmGovernanceCycleOpts | undefined,
  plan: PmGovernanceJudgmentPlan,
  stall: ThreadStallDetection,
  settleNote: string,
): Promise<string> {
  if (!pmSummaryAutoWriteEnabled(cycleOpts) || !plan.thread_key) {
    return settleNote;
  }
  const rootId = stall.root_task_id ?? plan.task_id;
  const written = await maybeAutoWritePmAdminSummaryReport(projectRoot, {
    thread_key: plan.thread_key,
    task_id: rootId,
  });
  if (written && "skipped" in written) {
    return `${settleNote} · PM 总报告未写：${written.skipped_reason}`;
  }
  if (written && "path" in written) {
    await finalizePmAdminSummaryWrite(projectRoot, written);
    return `${settleNote} · PM-to-ADMIN 总报告已写入 · ${written.report_id}`;
  }
  return settleNote;
}

async function tryVirtualPmSettleAfterReview(
  projectRoot: string,
  plan: PmGovernanceJudgmentPlan,
  reviewOk: boolean,
  cycleOpts?: RunPmGovernanceCycleOpts,
): Promise<import("../ledger/virtualPmBranchSettle.ts").VirtualPmBranchSettleResult | null> {
  const taskId = plan.task_id ?? null;
  if (!reviewOk) {
    if (taskId) {
      await markWaitingPmAttentionOnTask(
        projectRoot,
        taskId,
        "PM 自动审查未通过，需 PM 人工处理",
      );
    }
    return null;
  }
  if (!taskId && !plan.report_id) return null;

  const effectiveTaskId = taskId;
  if (effectiveTaskId) {
    const lifecycleSettled = await settleVirtualPmLifecycleReviewTask(
      projectRoot,
      effectiveTaskId,
      { report_id: plan.report_id ?? undefined },
    );
    if (lifecycleSettled?.reviewed) return lifecycleSettled;
  }

  if (!effectiveTaskId) return null;
  try {
    return await settleVirtualPmBranchHotPathTask(projectRoot, effectiveTaskId, {
      report_id: plan.report_id ?? undefined,
    });
  } catch {
    return null;
  }
}

async function taskStillActiveStalledDoneReport(
  projectRoot: string,
  taskId: string,
): Promise<boolean> {
  const layout = resolveLedgerLayout(projectRoot);
  let tasksRaw = "";
  let reportsRaw = "";
  try {
    tasksRaw = await fs.readFile(join(layout.ledgerDir, "tasks.jsonl"), "utf-8");
    reportsRaw = await fs.readFile(join(layout.ledgerDir, "reports.jsonl"), "utf-8");
  } catch {
    return false;
  }
  let bucket = "";
  for (const line of tasksRaw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { task_id?: string; bucket?: string };
      if (row.task_id && taskIdMatchesPrefix(row.task_id, taskId)) {
        bucket = String(row.bucket ?? "").toLowerCase();
        break;
      }
    } catch {
      /* skip */
    }
  }
  if (bucket !== "active" && bucket !== "inbox") return false;
  for (const line of reportsRaw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as {
        task_id?: string;
        sender?: string;
        recipient?: string;
        status?: string;
        filename?: string;
        report_id?: string;
      };
      if (
        row.task_id &&
        taskIdMatchesPrefix(row.task_id, taskId) &&
        isWorkerReportToPm(
          row.report_id ?? row.filename ?? "",
          row.sender ?? "",
          row.recipient ?? "",
        )
      ) {
        const st = String(row.status ?? "done").trim().toLowerCase();
        if (st === "done" || st === "completed" || !st) return true;
      }
    } catch {
      /* skip */
    }
  }
  return false;
}

async function executeJudgmentCore(
  projectRoot: string,
  plan: PmGovernanceJudgmentPlan,
  stall: ThreadStallDetection,
  cycleOpts?: RunPmGovernanceCycleOpts,
): Promise<PmGovernanceJudgmentResult> {
  const at = new Date().toISOString();
  const base: PmGovernanceJudgmentResult = {
    ...plan,
    outcome: "ok",
    persisted: false,
    persist_path: null,
    summary: "",
    at,
  };

  try {
    switch (plan.skill_id) {
      case "pm.review_check": {
        if (!plan.task_id && !plan.report_id) {
          return { ...base, outcome: "skipped", summary: "缺少 task_id/report_id" };
        }
        const result = await reviewCheck(projectRoot, {
          task_id: plan.task_id ?? undefined,
          report_id: plan.report_id ?? undefined,
        });
        const ok = result?.ok ?? false;
        const planForSettle: PmGovernanceJudgmentPlan = {
          ...plan,
          task_id: plan.task_id ?? result?.task_id ?? null,
          report_id: plan.report_id ?? result?.report_id ?? null,
        };
        let autoSubmitNote = "";
        let autoSubmit: Awaited<ReturnType<typeof tryAutoSubmitReviewForActiveChild>> = null;
        if (ok && planForSettle.task_id) {
          autoSubmit = await tryAutoSubmitReviewForActiveChild(projectRoot, {
            task_id: planForSettle.task_id,
            report_id: planForSettle.report_id,
            review_ok: ok,
          });
          if (autoSubmit?.submitted) {
            autoSubmitNote = ` · auto submit_review → review (${autoSubmit.task_id})`;
          } else if (autoSubmit?.skipped_reason) {
            autoSubmitNote = ` · submit_review 跳过: ${autoSubmit.skipped_reason}`;
          }
        }
        const settled = await tryVirtualPmSettleAfterReview(
          projectRoot,
          planForSettle,
          ok,
          cycleOpts,
        );
        let settleNote = settled?.archived
          ? ` · 虚拟 PM 已审核并归档 ${settled.task_id}`
          : settled?.skipped_reason
            ? ` · 未归档: ${settled.skipped_reason}`
            : "";
        if (ok) {
          if (autoSubmit?.submitted || settled?.reviewed || settled?.archived) {
            await rebuildLedgerBestEffort(projectRoot);
          }
          settleNote = await appendPmSummaryAfterReview(
            projectRoot,
            cycleOpts,
            planForSettle,
            stall,
            settleNote,
          );
        }
        return {
          ...base,
          outcome: ok ? "ok" : "failed",
          summary: result
            ? `review_check ${ok ? "通过" : "有问题"} · findings=${result.findings.length}${autoSubmitNote}${settleNote}`
            : "review_check 无结果",
          payload: { review: result, auto_submit: autoSubmit, settle: settled },
        };
      }
      case "pm.detect_thread_stall": {
        const finding = stall.findings.find((f) => f.code === "active_stalled_done_report");
        const next = stall.suggestions.find((s) => s.action === "write_report");
        const taskId = plan.task_id ?? finding?.entity_id ?? null;
        let wakeNote = "";
        let wakePayload: unknown;
        let persisted = false;

        const executor = cycleOpts?.wake_downstream;
        const allowAuto =
          cycleOpts?.allow_auto_wake === true ||
          (cycleOpts?.allow_auto_wake !== false && Boolean(executor));

        if (taskId && finding && executor && allowAuto) {
          const wakeReq = buildPmReportIntakeWakeRequest({
            task_id: taskId,
            report_id: null,
            thread_key: plan.thread_key,
            reason: "active_stalled_done_report",
          });
          const wakeResult = await executor(wakeReq);
          wakePayload = { wakeReq, wakeResult };
          wakeNote = wakeResult.ok
            ? ` · 已直接 wake PM report-intake（session=${wakeResult.session_id ?? "—"}）`
            : ` · PM report-intake wake failed: ${wakeResult.error ?? "unknown"}`;
        } else if (taskId && finding) {
          const stillStalled = await taskStillActiveStalledDoneReport(
            projectRoot,
            taskId,
          );
          if (!stillStalled) {
            wakeNote = " · 子任务已离开 active，跳过 PM intake wake";
          } else if (!executor || !allowAuto) {
            wakeNote = " · 建议 wake PM report-intake（需注入 wake executor）";
          } else {
            const waitState = await loadPmGovernanceWaitState(projectRoot);
            const allowance = evaluateStallIntakeWakeAllowance(waitState, taskId);
            if (!allowance.allowed) {
              wakeNote = ` · ${allowance.reason}`;
            } else {
              const review = await reviewCheck(projectRoot, { task_id: taskId });
              const wakeReq = buildPmReportIntakeWakeRequest({
                task_id: taskId,
                report_id: review?.report_id ?? null,
                thread_key: plan.thread_key,
                reason: "active_stalled_done_report",
              });
              const wakeResult = await executor(wakeReq);
              wakePayload = { wakeReq, wakeResult, review_ok: review?.ok ?? false };
              if (wakeResult.ok) {
                recordStallIntakeWakeExecuted(waitState, taskId, plan.thread_key);
                await savePmGovernanceWaitState(projectRoot, waitState);
                persisted = true;
                wakeNote = ` · 已 wake PM report-intake（session=${wakeResult.session_id ?? "—"}）`;
              } else if (wakeResult.skipped) {
                wakeNote = ` · PM intake wake skipped: ${wakeResult.reason ?? "unknown"}`;
              } else {
                wakeNote = ` · PM intake wake failed: ${wakeResult.error ?? "unknown"}`;
              }
            }
          }
        }

        return {
          ...base,
          persisted,
          summary: finding
            ? `stall: ${finding.message}${next ? ` → 建议 ${next.detail}` : ""}${wakeNote}`
            : `stall 已记录${wakeNote}`,
          payload: {
            findings: stall.findings.filter((f) => f.code === "active_stalled_done_report"),
            wake: wakePayload,
          },
        };
      }
      case "pm.wake_downstream": {
        if (!plan.task_id) {
          return { ...base, outcome: "skipped", summary: "缺少 task_id，无法构建 wake 建议" };
        }
        const roleFromLedger = await resolveTaskRecipientRole(projectRoot, plan.task_id);
        const roleMatch = /→\s*(\w+)/.exec(plan.reason);
        const role = roleFromLedger ?? roleMatch?.[1] ?? "DEV";

        // The PM agent already decided to wake this role. Runtime executes
        // that decision; it must not replace it with report, lifecycle,
        // cooldown or dependency policy. The woken AI inspects current state
        // and decides what work (if any) remains.
        const useDirectAiWake = (): boolean => true;
        if (useDirectAiWake()) {
          const wakeReq = buildWakeDownstreamRequest({
            task_id: plan.task_id,
            role,
            reason: "pm_agent_nudge",
            thread_key: plan.thread_key,
            source: "governance_planner",
            caller: "PM",
          });
          const executor = cycleOpts?.wake_downstream;
          if (!executor || cycleOpts?.allow_auto_wake === false) {
            return {
              ...base,
              mode: "suggest",
              summary: `建议直接唤醒 ${role} AI`,
              payload: wakeReq,
            };
          }
          const wakeResult = await executor(wakeReq);
          return {
            ...base,
            mode: "executed",
            outcome: wakeResult.ok ? (wakeResult.skipped ? "skipped" : "ok") : "failed",
            summary: wakeResult.ok
              ? wakeResult.skipped
                ? `${role} AI 已在运行`
                : `已直接唤醒 ${role} AI · session=${wakeResult.session_id ?? "?"}`
              : wakeResult.error ?? `唤醒 ${role} AI 失败`,
            payload: wakeResult,
          };
        }

        const hasReport = await findReportForTaskOnDisk({
          projectRoot,
          taskId: plan.task_id,
          reporter: role,
        });
        if (hasReport) {
          const review = await reviewCheck(projectRoot, { task_id: plan.task_id });
          const ok = review?.ok ?? false;
          const settled = await tryVirtualPmSettleAfterReview(
            projectRoot,
            plan,
            ok,
            cycleOpts,
          );
          let settleNote = settled?.archived
            ? ` · 虚拟 PM 已审核并归档 ${settled.task_id}`
            : "";
          if (ok) {
            if (settled?.reviewed || settled?.archived) {
              await rebuildLedgerBestEffort(projectRoot);
            }
            settleNote = await appendPmSummaryAfterReview(
              projectRoot,
              cycleOpts,
              plan,
              stall,
              settleNote,
            );
          }
          return {
            ...base,
            mode: "executed",
            outcome: ok ? "ok" : "failed",
            summary: `已有 REPORT，跳过 wake；review_check ${ok ? "通过" : "需关注"}${settleNote}`,
            payload: { skipped_wake: true, review, settle: settled },
          };
        }

        const worker = stall.findings.find(
          (f) => f.code === "missing_report" && f.entity_id === plan.task_id,
        );
        let stale = false;
        if (worker) {
          const layout = resolveLedgerLayout(projectRoot);
          const tasksRaw = await fs.readFile(join(layout.ledgerDir, "tasks.jsonl"), "utf-8").catch(() => "");
          for (const line of tasksRaw.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
              const row = JSON.parse(line) as { task_id?: string; path?: string };
              if (row.task_id && taskIdMatchesPrefix(row.task_id, plan.task_id)) {
                stale = await isActiveTaskStale(projectRoot, row.path);
                break;
              }
            } catch {
              /* skip */
            }
          }
        }
        const wakeReq = buildWakeDownstreamRequest({
          task_id: plan.task_id,
          role,
          reason: stale ? "stale_active" : "nudge",
          thread_key: plan.thread_key,
          source: "governance_planner",
          caller: "PM",
        });

        const executor = cycleOpts?.wake_downstream;
        const allowAuto =
          cycleOpts?.allow_auto_wake === true ||
          (cycleOpts?.allow_auto_wake !== false && Boolean(executor));

        if (!executor || !allowAuto) {
          return {
            ...base,
            mode: "suggest",
            summary: stale
              ? `建议 wake ${role}（active ≥6h 无 REPORT）· 需 POST wake-downstream 或注入 executor`
              : `建议 wake ${role} · 需 POST wake-downstream 或注入 executor`,
            payload: wakeReq,
          };
        }

        const waitState = await loadPmGovernanceWaitState(projectRoot);
        const allowance = evaluateWakeAllowance(waitState, plan.task_id, plan.thread_key);
        if (allowance.phase === "waiting" || allowance.phase === "escalate") {
          await savePmGovernanceWaitState(projectRoot, waitState);
          return {
            ...base,
            mode: "suggest",
            outcome: "skipped",
            summary:
              allowance.phase === "escalate"
                ? allowance.reason
                : `wake 限流：${allowance.reason}`,
            payload: { wakeReq, allowance },
          };
        }

        const wakeResult = await executor(wakeReq);
        if (wakeResult.skipped) {
          // A skipped wake usually means the worker is already running, the
          // wake was throttled, or another sequential leg owns the slot. It
          // does not imply that a REPORT exists. Recheck disk only to cover a
          // report-arrival race; never review an absent receipt.
          const reportArrivedAfterWake = await findReportForTaskOnDisk({
            projectRoot,
            taskId: plan.task_id,
            reporter: role,
          });
          if (!reportArrivedAfterWake) {
            return {
              ...base,
              mode: "executed",
              outcome: "skipped",
              summary: `wake skipped (${wakeResult.reason ?? "unknown"}); waiting for worker REPORT`,
              payload: { skipped_wake: true, wakeResult, waiting_for_report: true },
            };
          }
          const review = await reviewCheck(projectRoot, { task_id: plan.task_id });
          const ok = review?.ok ?? false;
          const settled = await tryVirtualPmSettleAfterReview(
            projectRoot,
            plan,
            ok,
            cycleOpts,
          );
          let settleNote = settled?.archived
            ? ` · 虚拟 PM 已审核并归档 ${settled.task_id}`
            : "";
          if (ok) {
            if (settled?.reviewed || settled?.archived) {
              await rebuildLedgerBestEffort(projectRoot);
            }
            settleNote = await appendPmSummaryAfterReview(
              projectRoot,
              cycleOpts,
              plan,
              stall,
              settleNote,
            );
          }
          return {
            ...base,
            mode: "executed",
            outcome: ok ? "ok" : "failed",
            summary: `wake 跳过（${wakeResult.reason ?? "已有 REPORT"}）；review_check ${ok ? "通过" : "需关注"}${settleNote}`,
            payload: { skipped_wake: true, wakeResult, review, settle: settled },
          };
        }
        if (wakeResult.delayed) {
          return {
            ...base,
            mode: "executed",
            outcome: "skipped",
            summary: wakeResult.error ?? "SDK transient delayed（非任务失败）",
            payload: wakeResult,
          };
        }
        if (!wakeResult.ok) {
          return {
            ...base,
            mode: "executed",
            outcome: "failed",
            summary: wakeResult.error ?? "wake 失败",
            payload: wakeResult,
          };
        }

        recordWakeExecuted(waitState, plan.task_id, plan.thread_key);
        await savePmGovernanceWaitState(projectRoot, waitState);

        return {
          ...base,
          mode: "executed",
          outcome: "ok",
          summary: `已 wake ${wakeReq.agent_id} · session=${wakeResult.session_id ?? "?"}`,
          payload: wakeResult,
        };
      }
      case "pm.close_admin_task": {
        if (pmSummaryAutoWriteEnabled(cycleOpts)) {
          const written = await writePmAdminSummaryReport(projectRoot, {
            thread_key: plan.thread_key,
            task_id: plan.task_id ?? undefined,
          });
          if (written && "skipped" in written) {
            return {
              ...base,
              outcome: "skipped",
              summary: `PM 总报告门禁未通过：${written.skipped_reason}`,
              payload: written,
            };
          }
          if (written && "path" in written) {
            await finalizePmAdminSummaryWrite(projectRoot, written);
            return judgmentFromPmSummaryWrite(base, written);
          }
          return {
            ...base,
            outcome: "skipped",
            summary: "PM 总报告未能写入（缺少 root 或上下文）",
          };
        }

        const draft = await closeAdminTaskDraft(projectRoot, {
          thread_key: plan.thread_key,
          task_id: plan.task_id ?? undefined,
        });
        if (!draft) {
          return {
            ...base,
            outcome: "skipped",
            summary: `关单草稿跳过：thread ${plan.thread_key ?? "?"} 无可用 ADMIN→PM root（请 ledger rebuild 修复 threads.jsonl）`,
          };
        }
        const draftsDir = pmGovernanceDraftsDir(projectRoot);
        await fs.mkdir(draftsDir, { recursive: true });
        const safeId = (draft.task_id || plan.thread_key).replace(/[^\w-]/g, "_");
        const persistPath = join(draftsDir, `close-${safeId}.json`);
        if (existsSync(persistPath)) {
          return {
            ...base,
            outcome: "skipped",
            summary: `关单草稿已存在，跳过重复写入：${persistPath}`,
            persist_path: persistPath,
            persisted: true,
          };
        }
        await fs.writeFile(persistPath, `${JSON.stringify(draft, null, 2)}\n`, "utf-8");
        const layout = resolveLedgerLayout(projectRoot);
        const reportsRaw = await fs.readFile(join(layout.ledgerDir, "reports.jsonl"), "utf-8").catch(() => "");
        const rootPrefix = draft.task_id ?? plan.task_id ?? "";
        let pmReportExists = false;
        for (const line of reportsRaw.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const row = JSON.parse(line) as {
              sender?: string;
              recipient?: string;
              task_id?: string;
              status?: string;
              report_id?: string;
            };
            if (
              row.sender === "PM" &&
              row.recipient === "ADMIN" &&
              row.task_id &&
              rootPrefix &&
              (row.task_id === rootPrefix || row.task_id.startsWith(`${rootPrefix}-`)) &&
              (row.status === "done" || row.status === "completed")
            ) {
              pmReportExists = true;
              break;
            }
          } catch {
            /* skip */
          }
        }
        return {
          ...base,
          outcome: "ok",
          persisted: true,
          persist_path: persistPath,
          summary: pmReportExists
            ? `关单草稿已落盘 · task_id=${draft.task_id}（PM-to-ADMIN REPORT 已存在，待 archive）`
            : `关单草稿已落盘 · task_id=${draft.task_id}（auto_review 关闭，未自动 write_report；待 PM 人工）`,
          payload: draft,
        };
      }
      default:
        return { ...base, outcome: "skipped", summary: `未知 skill ${plan.skill_id}` };
    }
  } catch (err) {
    return {
      ...base,
      outcome: "failed",
      summary: `执行失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function executeJudgment(
  projectRoot: string,
  plan: PmGovernanceJudgmentPlan,
  stall: ThreadStallDetection,
  cycleOpts?: RunPmGovernanceCycleOpts,
  cycleId?: string,
): Promise<PmGovernanceJudgmentResult> {
  const t0 = Date.now();
  const result = await executeJudgmentCore(projectRoot, plan, stall, cycleOpts);
  const outcome =
    result.outcome === "failed"
      ? "failed"
      : result.outcome === "skipped"
        ? "skipped"
        : "ok";
  try {
    await recordSkillInvocation(projectRoot, {
      skill_id: plan.skill_id,
      channel: channelFromGovernanceTrigger(cycleOpts?.triggered_by),
      ...(cycleOpts?.triggered_by
        ? { triggered_by: cycleOpts.triggered_by }
        : {}),
      caller_role: "PM",
      thread_key: plan.thread_key,
      ...(plan.task_id ? { task_id: plan.task_id } : {}),
      outcome,
      summary: result.summary || plan.reason,
      ...(cycleId ? { cycle_id: cycleId } : {}),
      duration_ms: Date.now() - t0,
    });
  } catch {
    /* journal 写入失败不阻断治理循环 */
  }
  return result;
}

function buildPromptSummary(judgments: PmGovernanceJudgmentResult[]): string {
  if (!judgments.length) return "本轮未发现需 PM 自动处理的线程信号。";
  const primary = judgments[0]!;
  const parts = [
    `${primary.skill_id} @ ${primary.thread_key}`,
    primary.summary,
  ];
  if (judgments.length > 1) {
    parts.push(`另有 ${judgments.length - 1} 条判断`);
  }
  return parts.join(" · ");
}

export function formatPmGovernanceCycleBlock(cycle: PmGovernanceCycleRecord): string {
  const decisions =
    cycle.decisions?.length > 0
      ? cycle.decisions
      : (cycle.judgments ?? []).map((j) => judgmentToDecision(j));
  const lines: string[] = [
    `## PM 自动治理循环（planner 已运行）`,
    ``,
    `cycle_id: \`${cycle.cycle_id}\` · triggered_by: \`${cycle.triggered_by}\` · at: ${cycle.at}`,
    ``,
    cycle.prompt_summary,
    ``,
  ];
  if (!decisions.length) {
    lines.push(`_无自动判断；请读 PM.todo.md 后人工巡查。_`);
    return lines.join("\n");
  }
  lines.push(`| 状态 | skill | thread | task_id | 需确认 | 可自动 | 落盘 | 摘要 |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const d of decisions.slice(0, 12)) {
    const persisted = d.persisted ? "是" : "否";
    const taskCol = d.task_id ?? "—";
    const confirm = d.requires_confirmation ? "是" : "否";
    const auto = d.can_auto_execute ? "是" : "否";
    const summary = (d.summary ?? d.reason).replace(/\|/g, "\\|").slice(0, 100);
    lines.push(
      `| \`${d.detected_state}\` | \`${d.suggested_skill}\` | \`${d.thread_key}\` | \`${taskCol}\` | ${confirm} | ${auto} | ${persisted} | ${summary} |`,
    );
  }
  lines.push(``);
  lines.push(
    `_安全策略：review/stall 只读可自动执行；门禁通过时默认自动写入 PM-to-ADMIN 总报告（仅 auto_review=false 时落关单草稿）；wake 在 wait-state 窗口内可自动执行（限流）；已有 REPORT 跳过 wake。_`,
  );
  return lines.join("\n");
}

async function appendCycleRecord(
  projectRoot: string,
  record: PmGovernanceCycleRecord,
): Promise<void> {
  const dir = pmGovernanceDir(projectRoot);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(
    pmGovernanceCycleJournalPath(projectRoot),
    `${JSON.stringify(record)}\n`,
    "utf-8",
  );
}

export async function readRecentPmGovernanceCycles(
  projectRoot: string,
  limit = 5,
): Promise<PmGovernanceCycleRecord[]> {
  const path = pmGovernanceCycleJournalPath(projectRoot);
  let raw = "";
  try {
    raw = await fs.readFile(path, "utf-8");
  } catch {
    return [];
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const out: PmGovernanceCycleRecord[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      out.push(JSON.parse(lines[i]!) as PmGovernanceCycleRecord);
    } catch {
      /* skip */
    }
  }
  return out;
}

export async function runPmGovernanceCycle(
  projectRoot: string,
  opts?: RunPmGovernanceCycleOpts,
): Promise<PmGovernanceCycleRecord> {
  const cycleOpts: RunPmGovernanceCycleOpts = {
    ...opts,
    auto_review: opts?.auto_review !== false,
  };
  const triggered_by = cycleOpts.triggered_by ?? "api";
  const maxThreads = cycleOpts.max_threads ?? 12;
  const maxJudgments = cycleOpts.max_judgments ?? 10;
  const cycle_id = randomUUID();
  const at = new Date().toISOString();

  const todo = await parsePmTodoMd(projectRoot);
  const threadKeys = await collectPlannerThreadKeys(projectRoot, { max: maxThreads });
  const allowAutoWake =
    cycleOpts.allow_auto_wake === true ||
    (cycleOpts.allow_auto_wake !== false && Boolean(cycleOpts.wake_downstream));

  const allPlans: PmGovernanceJudgmentPlan[] = [];
  const stallByThread = new Map<string, ThreadStallDetection>();

  for (const threadKey of threadKeys) {
    const stall = await detectThreadStall(projectRoot, threadKey);
    if (!stall) continue;
    stallByThread.set(threadKey, stall);
    allPlans.push(...planFromStall(stall, todo, allowAutoWake));
  }

  const sorted = dedupePlans(allPlans).slice(0, maxJudgments);
  const judgments: PmGovernanceJudgmentResult[] = [];
  const decisions: PmGovernanceDecision[] = [];

  for (const plan of sorted) {
    const stall = stallByThread.get(plan.thread_key);
    if (!stall) continue;
    const evidence_paths = await collectEvidencePaths(projectRoot, plan, stall);
    const result = await executeJudgment(projectRoot, plan, stall, cycleOpts, cycle_id);
    judgments.push(result);
    decisions.push({
      ...judgmentToDecision(result),
      evidence_paths,
    });
  }

  judgments.sort((a, b) => a.priority - b.priority);
  decisions.sort((a, b) => {
    const pa = sorted.find((p) => p.skill_id === a.suggested_skill && p.thread_key === a.thread_key)?.priority ?? 99;
    const pb = sorted.find((p) => p.skill_id === b.suggested_skill && p.thread_key === b.thread_key)?.priority ?? 99;
    return pa - pb;
  });

  if (cycleOpts.auto_review !== false) {
    for (const threadKey of threadKeys) {
      try {
        await reconcilePmWorkerReviewsPendingApprove(projectRoot, {
          thread_key: threadKey,
          limit: 12,
        });
      } catch {
        /* best-effort — catch review-bucket stragglers after judgments */
      }
    }
  }

  const primary = judgments[0] ?? null;
  const record: PmGovernanceCycleRecord = {
    cycle_id,
    triggered_by,
    at,
    primary_skill_id: primary?.skill_id ?? null,
    primary_thread_key: primary?.thread_key ?? null,
    decisions,
    judgments,
    prompt_summary: buildPromptSummary(judgments),
  };

  await appendCycleRecord(projectRoot, record);
  return record;
}
