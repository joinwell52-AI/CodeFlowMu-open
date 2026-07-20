/**
 * reconcileAgentTaskState — unified Agent / session / TASK reconcile (7 states).
 *
 * Triggered checks (Panel / Runtime) call this before swap-AI, wake, dispatch,
 * recover, startup, task detail, queue refresh, session ended, PM summary.
 */

import type { AgentRegistry } from "../registry/AgentRegistry.ts";
import type { SessionManager } from "../session/SessionManager.ts";
import type { LedgerReportRecord, LedgerTaskRecord } from "../ledger/types.ts";
import { resolveTaskCurrentBucket } from "./taskCurrentBucket.ts";
import {
  mergeWorkerReceiptSignals,
  resolveWorkerReceiptDurableHints,
} from "./workerReceiptDurableHints.ts";
import { evaluateWorkerReceiptWaiting } from "./workerReceiptWaiting.ts";

export type AgentTaskReconcileState =
  | "running"
  | "waiting_report"
  | "recoverable"
  | "failed"
  | "blocked"
  | "done"
  | "idle"
  | "unknown";

export interface ReconcileAgentTaskStateOpts {
  projectRoot: string;
  agentId: string;
  taskId?: string | null;
  registry: AgentRegistry;
  sessionManager: SessionManager;
  tasks: LedgerTaskRecord[];
  reports: LedgerReportRecord[];
  /** In-memory PmQueueGuard signals when available. */
  nudgeCount?: number;
  workerFailed?: boolean;
}

export interface ReconcileAgentTaskStateResult {
  state: AgentTaskReconcileState;
  task_id: string | null;
  role: string | null;
  agent_id: string;
  session_id: string | null;
  reason_code: string;
  reason_text: string;
  admin_hint: string;
  suggested_action: "wait" | "recover" | "review_report" | "none";
  queue_state: string;
  last_activity_at: string | null;
}

const PASS_REPORT = new Set(["done", "completed", "pass", "passed"]);
const FAIL_REPORT = new Set(["failed", "blocked", "cancelled", "force_archived"]);

function normalizeTaskId(id: string): string {
  return id.replace(/\.md$/i, "").trim();
}

function taskForAgent(
  tasks: LedgerTaskRecord[],
  role: string,
  focusTaskId?: string | null,
): LedgerTaskRecord | null {
  const normRole = role.toUpperCase();
  if (focusTaskId) {
    const norm = normalizeTaskId(focusTaskId);
    const hit =
      tasks.find((t) => normalizeTaskId(t.task_id) === norm) ??
      tasks.find((t) => normalizeTaskId(String(t.filename ?? "")) === norm);
    if (hit) return hit;
  }
  const open = tasks.filter((t) => {
    if (String(t.recipient ?? "").toUpperCase() !== normRole) return false;
    const bucket = resolveTaskCurrentBucket(t);
    return bucket === "active" || bucket === "review" || bucket === "inbox";
  });
  open.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
  return open[0] ?? null;
}

function latestReportStatus(
  reports: LedgerReportRecord[],
  taskId: string,
): string {
  const norm = normalizeTaskId(taskId);
  let best = "";
  let bestTs = "";
  for (const r of reports) {
    const refs = [
      normalizeTaskId(String(r.task_id ?? "")),
      ...(Array.isArray(r.references)
        ? r.references.map((x) => normalizeTaskId(String(x)))
        : []),
    ].filter(Boolean);
    if (!refs.some((ref) => ref === norm || ref.startsWith(norm) || norm.startsWith(ref))) {
      continue;
    }
    const ts = String(r.updated_at ?? r.created_at ?? "");
    if (!bestTs || ts > bestTs) {
      bestTs = ts;
      best = String(r.status ?? "").toLowerCase();
    }
  }
  return best;
}

function buildAdminHint(
  state: AgentTaskReconcileState,
  ctx: {
    taskId: string | null;
    role: string | null;
    sessionId: string | null;
    reasonCode: string;
    lastActivity: string | null;
  },
): string {
  const task = ctx.taskId ? `任务：${ctx.taskId}` : "";
  const session = ctx.sessionId ? `session：${ctx.sessionId}` : "";
  switch (state) {
    case "running":
      return [
        "Agent 正在执行",
        task,
        session,
        ctx.lastActivity ? `最后活动：${ctx.lastActivity}` : "",
        "建议：等待当前执行完成",
      ]
        .filter(Boolean)
        .join("\n");
    case "waiting_report":
      return [
        "等待 Agent 回执",
        task,
        session,
        "建议：稍等或稍后触发恢复检查",
      ]
        .filter(Boolean)
        .join("\n");
    case "recoverable":
      return [
        "会话未结算，可恢复执行",
        task,
        ctx.role ? `Agent：${ctx.role}-01` : "",
        session ? `旧 session：${ctx.sessionId}` : "",
        `原因：${ctx.reasonCode}`,
        "建议：恢复执行或换 AI 后恢复",
      ]
        .filter(Boolean)
        .join("\n");
    case "failed":
      return [
        "回执失败，需要 PM/ADMIN 决策",
        task,
        `原因：${ctx.reasonCode}`,
        "建议：返工、补验或人工归档",
      ]
        .filter(Boolean)
        .join("\n");
    case "blocked":
      return [
        "下游已提交阻塞/失败回报，等待 PM 决策",
        task,
        `原因：${ctx.reasonCode}`,
        "建议：PM 阅读正式 REPORT 后派返工、补验或接受阻塞结论",
      ]
        .filter(Boolean)
        .join("\n");
    case "done":
      return [task ? `任务已完成\n${task}` : "任务已完成", "建议：无需恢复"]
        .filter(Boolean)
        .join("\n");
    case "idle":
      return "Agent 空闲，无待结算任务";
    default:
      return "状态未知，请刷新或查看 runtime 日志";
  }
}

function mapPhaseToState(
  phase: string,
  queueState: string,
  bucket: string,
  latestStatus: string,
): AgentTaskReconcileState {
  if (PASS_REPORT.has(latestStatus) || bucket === "done" || bucket === "archive") {
    return "done";
  }
  if (FAIL_REPORT.has(latestStatus)) {
    return "blocked";
  }
  if (phase === "session_running" || queueState === "running") return "running";
  if (phase === "session_recoverable" || queueState === "recoverable") {
    return "recoverable";
  }
  if (phase === "worker_receipt_failed") {
    return "failed";
  }
  if (phase === "worker_report_needs_pm") {
    return "blocked";
  }
  if (
    phase === "waiting_worker_receipt" ||
    phase === "waiting_qa_receipt" ||
    queueState === "waiting_report"
  ) {
    return "waiting_report";
  }
  if (phase === "cleared" || phase === "none") {
    if (bucket === "inbox") return "idle";
    return "idle";
  }
  return "unknown";
}

export async function reconcileAgentTaskState(
  opts: ReconcileAgentTaskStateOpts,
): Promise<ReconcileAgentTaskStateResult> {
  const agentId = opts.agentId.trim();
  const record = await opts.registry.get(agentId);
  const role = String(record?.protocol.role ?? "").trim().toUpperCase() || null;

  if (!record) {
    return {
      state: "unknown",
      task_id: null,
      role,
      agent_id: agentId,
      session_id: null,
      reason_code: "agent_not_found",
      reason_text: `agent ${agentId} not in registry`,
      admin_hint: buildAdminHint("unknown", {
        taskId: null,
        role,
        sessionId: null,
        reasonCode: "agent_not_found",
        lastActivity: null,
      }),
      suggested_action: "none",
      queue_state: "none",
      last_activity_at: null,
    };
  }

  const activeSessions = await opts.sessionManager.listActive();
  const agentSession = activeSessions.find((s) => s.agent_id === agentId);
  const agentStatus = String(record.protocol.status ?? "").toLowerCase();
  const agentRunning =
    agentStatus === "running" || agentSession !== undefined;
  const staleBusy = agentStatus === "running" && !agentSession;

  const worker = role
    ? taskForAgent(opts.tasks, role, opts.taskId)
    : null;
  const taskId = worker ? normalizeTaskId(worker.task_id) : null;
  const bucket = worker ? resolveTaskCurrentBucket(worker) : "";

  if (!taskId) {
    const idle = agentStatus === "idle" || agentStatus === "error";
    return {
      state: idle ? "idle" : agentRunning ? "running" : "unknown",
      task_id: null,
      role,
      agent_id: agentId,
      session_id: agentSession?.session_id ?? null,
      reason_code: idle ? "no_open_task" : "agent_active_no_task",
      reason_text: idle ? "no open task for agent" : "agent active without tracked task",
      admin_hint: buildAdminHint(idle ? "idle" : "running", {
        taskId: null,
        role,
        sessionId: agentSession?.session_id ?? null,
        reasonCode: "no_open_task",
        lastActivity: record.protocol.last_active_at ?? null,
      }),
      suggested_action: idle ? "none" : "wait",
      queue_state: idle ? "none" : "running",
      last_activity_at: record.protocol.last_active_at ?? null,
    };
  }

  const durable = await resolveWorkerReceiptDurableHints(opts.projectRoot, taskId);
  const merged = mergeWorkerReceiptSignals(
    {
      nudgeCount: opts.nudgeCount ?? 0,
      workerFailed: opts.workerFailed ?? false,
    },
    durable,
    { agentRunning: agentRunning && !staleBusy },
  );

  const latestStatus = latestReportStatus(opts.reports, taskId);
  const hasReportOnDisk = opts.reports.some((r) => {
    const st = String(r.status ?? "").toLowerCase();
    return (
      PASS_REPORT.has(st) &&
      (normalizeTaskId(String(r.task_id ?? "")) === taskId ||
        (Array.isArray(r.references) &&
          r.references.some((ref) => normalizeTaskId(String(ref)) === taskId)))
    );
  });

  const ev = evaluateWorkerReceiptWaiting({
    tasks: opts.tasks,
    reports: opts.reports,
    targetRole: role ?? undefined,
    focusTaskId: taskId,
    nudgeCount: merged.nudgeCount,
    workerFailed: merged.workerFailed,
    sessionFailed: merged.sessionFailed,
    sessionUnsettled: merged.sessionUnsettled,
    recoverable: merged.recoverable || staleBusy,
    lastSessionId: merged.lastSessionId,
    lastFailureCode: merged.lastFailureCode,
    lastFailureCategory: merged.lastFailureCategory,
    isFirstTurnAbort: merged.isFirstTurnAbort,
    lastSessionStatus: durable.lastSessionStatus,
    agentRunning: agentRunning && !staleBusy,
    hasReportOnDisk,
  });

  let state = mapPhaseToState(ev.phase, ev.queueState, bucket, latestStatus);

  if (staleBusy && state !== "done" && state !== "failed") {
    state = "recoverable";
  }

  const suggested =
    state === "recoverable"
      ? "recover"
      : state === "failed"
        ? "review_report"
        : state === "blocked"
          ? "review_report"
        : state === "running" || state === "waiting_report"
          ? "wait"
          : "none";

  const reasonCode =
    staleBusy
      ? "stale_busy_no_session"
      : ev.reasonCode ?? ev.reason ?? state;

  return {
    state,
    task_id: taskId,
    role,
    agent_id: agentId,
    session_id: agentSession?.session_id ?? ev.lastSessionId,
    reason_code: String(reasonCode),
    reason_text: ev.reason,
    admin_hint: buildAdminHint(state, {
      taskId,
      role,
      sessionId: agentSession?.session_id ?? ev.lastSessionId,
      reasonCode: String(reasonCode),
      lastActivity: record.protocol.last_active_at ?? null,
    }),
    suggested_action: suggested,
    queue_state: ev.queueState,
    last_activity_at: record.protocol.last_active_at ?? null,
  };
}

/** PM summary gate — block close when thread has recoverable / running unsettled tasks. */
export async function findPmSummaryBlockers(
  opts: Omit<ReconcileAgentTaskStateOpts, "agentId" | "taskId"> & {
    threadKey?: string | null;
  },
): Promise<ReconcileAgentTaskStateResult[]> {
  const blockers: ReconcileAgentTaskStateResult[] = [];
  const agents = await opts.registry.list();
  const thread = String(opts.threadKey ?? "").trim();

  for (const agent of agents) {
    const role = String(agent.protocol.role ?? "").toUpperCase();
    if (!role || role === "ADMIN" || role === "EVAL") continue;

    const openTasks = opts.tasks.filter((t) => {
      if (String(t.recipient ?? "").toUpperCase() !== role) return false;
      if (thread) {
        const tk = String(t.thread_key ?? "").trim();
        if (tk && tk !== thread) return false;
      }
      const bucket = resolveTaskCurrentBucket(t);
      return bucket === "active" || bucket === "review" || bucket === "inbox";
    });

    for (const t of openTasks) {
      const r = await reconcileAgentTaskState({
        ...opts,
        agentId: agent.protocol.agent_id,
        taskId: t.task_id,
      });
      if (r.state === "recoverable" || r.state === "running") {
        blockers.push(r);
      }
      if (r.state === "failed" || r.state === "blocked") {
        blockers.push(r);
      }
    }
  }
  return blockers;
}
