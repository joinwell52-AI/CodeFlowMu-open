import { resolveThreadContext } from "./PmGovernanceActions.ts";

const LEG_ORDER = ["DEV", "OPS", "QA"] as const;
type LegRole = (typeof LEG_ORDER)[number];
const TERMINAL_RECEIPT_STATUSES = new Set([
  "done",
  "completed",
  "blocked",
  "failed",
  "aborted",
  "rejected",
]);

export const PM_STOP_POLICY = "PM_STOP" as const;
export const ADMIN_FORCE_RECOVERY_POLICY =
  "ESCALATE_ADMIN_FORCE_RECOVERY" as const;

export interface SequentialDispatchDecision {
  allow: boolean;
  reason?: "sequential_dispatch_guarded";
  current_leg: LegRole | null;
  blocked_target?: string;
  next_allowed_agent: LegRole | null;
  task_bucket?: string | null;
}

interface AbnormalWindowState {
  recoverCount: number;
  stopped: boolean;
  reason?: string;
  remainingMs?: number;
  untilMs?: number;
  cooldownReason?: string;
}

const abnormalWindows = new Map<string, AbnormalWindowState>();

function normalizeId(value: string): string {
  return value.replace(/\.md$/i, "").trim().toUpperCase();
}

function sameTaskId(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const a = normalizeId(left);
  const b = normalizeId(right);
  return a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`);
}

function windowKey(taskId: string, agentId: string): string {
  return `${normalizeId(taskId)}::${agentId.trim().toUpperCase()}`;
}

export async function evaluateSequentialDispatchGuard(input: {
  projectRoot: string;
  taskId: string;
  targetRole: string;
}): Promise<SequentialDispatchDecision> {
  const targetRole = input.targetRole.trim().toUpperCase();
  const ctx = await resolveThreadContext(input.projectRoot, {
    task_id: input.taskId,
  });
  if (!ctx || !LEG_ORDER.includes(targetRole as LegRole)) {
    return {
      allow: true,
      current_leg: null,
      next_allowed_agent: null,
    };
  }

  const allWorkerTasks = ctx.tasks.filter(
    (task) =>
      task.sender === "PM" &&
      LEG_ORDER.includes(task.recipient.toUpperCase() as LegRole),
  );
  const matchingTask = allWorkerTasks.find((task) =>
    sameTaskId(task.task_id, input.taskId),
  );
  // A thread_key may be intentionally reused by successive ADMIN roots. Keep
  // sequential dispatch inside the current parent/root branch so an old,
  // report-less OPS/QA task cannot permanently own a newer task's leg.
  const branchParent = matchingTask?.parent;
  const workerTasks = branchParent
    ? allWorkerTasks.filter((task) => sameTaskId(task.parent, branchParent))
    : allWorkerTasks;
  const isDone = (role: LegRole): boolean => {
    const tasks = workerTasks.filter(
      (task) => task.recipient.toUpperCase() === role,
    );
    if (!tasks.length) return true;
    return tasks.every((task) =>
      ctx.reports.some(
        (report) =>
          report.sender.toUpperCase() === role &&
          report.recipient.toUpperCase() === "PM" &&
          TERMINAL_RECEIPT_STATUSES.has(
            String(report.status ?? "").trim().toLowerCase(),
          ) &&
          sameTaskId(report.task_id, task.task_id),
      ),
    );
  };

  const currentLeg = LEG_ORDER.find(
    (role) => workerTasks.some((task) => task.recipient.toUpperCase() === role) && !isDone(role),
  ) ?? null;
  const targetIndex = LEG_ORDER.indexOf(targetRole as LegRole);
  const currentIndex = currentLeg ? LEG_ORDER.indexOf(currentLeg) : -1;
  if (currentLeg && targetIndex > currentIndex) {
    return {
      allow: false,
      reason: "sequential_dispatch_guarded",
      current_leg: currentLeg,
      blocked_target: targetRole,
      next_allowed_agent: currentLeg,
      task_bucket: matchingTask?.bucket ?? null,
    };
  }
  return {
    allow: true,
    current_leg: currentLeg,
    next_allowed_agent: currentLeg,
    task_bucket: matchingTask?.bucket ?? null,
  };
}

export function markPmStop(input: {
  taskId: string;
  agentId: string;
  reason: string;
  remainingMs?: number;
  untilMs?: number;
  cooldownReason?: string;
}): AbnormalWindowState & { policy: typeof PM_STOP_POLICY } {
  const remainingMs = Math.max(0, input.remainingMs ?? 0);
  const untilMs = input.untilMs ?? (remainingMs > 0 ? Date.now() + remainingMs : undefined);
  const key = windowKey(input.taskId, input.agentId);
  const previous = abnormalWindows.get(key);
  const state: AbnormalWindowState = {
    recoverCount: previous?.recoverCount ?? 0,
    stopped: true,
    reason: input.reason,
    remainingMs,
    untilMs,
    cooldownReason: input.cooldownReason ?? input.reason,
  };
  abnormalWindows.set(key, state);
  return { ...state, policy: PM_STOP_POLICY };
}

export function tryBeginPmRecover(input: {
  taskId: string;
  agentId: string;
}): { allow: boolean; reason?: string; state: AbnormalWindowState } {
  const key = windowKey(input.taskId, input.agentId);
  const state = abnormalWindows.get(key) ?? { recoverCount: 0, stopped: false };
  if (state.stopped) return { allow: false, reason: state.reason ?? "pm_stopped", state };
  if (state.recoverCount >= 1) {
    return { allow: false, reason: "recover_limit_reached", state };
  }
  const next = { ...state, recoverCount: state.recoverCount + 1 };
  abnormalWindows.set(key, next);
  return { allow: true, state: next };
}

export function clearPmAbnormalWindow(taskId: string, agentId: string): void {
  abnormalWindows.delete(windowKey(taskId, agentId));
}

export function shouldEscalateAdminForceRecovery(input: {
  reason?: string | null;
  wakeThrottled?: boolean;
  taskBucket?: string | null;
}): boolean {
  const reason = String(input.reason ?? "").trim();
  if (reason === "stale_busy_no_session" || reason === "session_unsettled") return true;
  if (input.wakeThrottled && reason === "stale_busy_no_session") return true;
  return reason === "agent_running" && input.taskBucket === "inbox";
}

export function resetPmExecutionGovernanceForTests(): void {
  abnormalWindows.clear();
}
