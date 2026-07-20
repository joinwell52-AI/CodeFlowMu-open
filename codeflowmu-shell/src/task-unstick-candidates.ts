/**
 * Scan recoverable「一键解除卡死」候选项（Panel 设置→项目页兜底）。
 */

export type UnstickCandidate = {
  task_id: string;
  agent_id: string;
  role: string;
  thread_key?: string | null;
  reason: string;
  session_id?: string | null;
};

export type UnstickCandidateTaskRow = {
  task_id: string;
  recipient?: string | null;
  thread_key?: string | null;
  display_status?: string | null;
  sender?: string | null;
};

export type UnstickCandidateDispatchRetry = {
  task_id: string;
  role?: string | null;
  failureCount?: number;
  decisionRequired?: boolean;
  forceArchived?: boolean;
  lastSessionId?: string | null;
  reason?: string | null;
};

export type UnstickCandidateQueueSnapshot = {
  pm_downstream_receipt_phase?: string | null;
  pm_downstream_receipt_task_id?: string | null;
  pm_downstream_role?: string | null;
  pm_downstream_receipt_thread_key?: string | null;
  pm_downstream_receipt_session_id?: string | null;
  pm_downstream_queue_state?: string | null;
  pm_downstream_suggested_action?: string | null;
  pm_stale_released?: boolean;
};

export function defaultAgentIdForRole(role: string): string {
  const r = role.trim().toUpperCase();
  if (!r) return "";
  return `${r}-01`;
}

function pushCandidate(
  out: UnstickCandidate[],
  seen: Set<string>,
  row: UnstickCandidate,
): void {
  const key = row.task_id.trim();
  if (!key || seen.has(key)) return;
  seen.add(key);
  out.push(row);
}

export function collectUnstickCandidates(input: {
  queue?: UnstickCandidateQueueSnapshot | null;
  dispatchRetries?: UnstickCandidateDispatchRetry[];
  tasks?: UnstickCandidateTaskRow[];
  agentIdByRole?: Record<string, string>;
}): UnstickCandidate[] {
  const out: UnstickCandidate[] = [];
  const seen = new Set<string>();
  const agentIdByRole = input.agentIdByRole ?? {};

  const resolveAgent = (role: string): string =>
    agentIdByRole[role.toUpperCase()] || defaultAgentIdForRole(role);

  const q = input.queue ?? {};
  const qTaskId = String(q.pm_downstream_receipt_task_id ?? "").trim();
  const qRole = String(q.pm_downstream_role ?? "").trim();
  if (qTaskId && qRole) {
    const phase = String(q.pm_downstream_receipt_phase ?? "");
    const qState = String(q.pm_downstream_queue_state ?? "");
    const stale = Boolean(q.pm_stale_released);
    const recoverable =
      phase === "worker_receipt_failed" ||
      phase === "session_recoverable" ||
      qState === "recoverable" ||
      qState === "failed" ||
      q.pm_downstream_suggested_action === "recover" ||
      stale;
    if (recoverable) {
      let reason = phase || qState || "recoverable";
      if (stale) reason = "pm_stale_released";
      pushCandidate(out, seen, {
        task_id: qTaskId,
        role: qRole,
        agent_id: resolveAgent(qRole),
        thread_key: q.pm_downstream_receipt_thread_key ?? null,
        session_id: q.pm_downstream_receipt_session_id ?? null,
        reason,
      });
    }
  }

  for (const rec of input.dispatchRetries ?? []) {
    const taskId = String(rec.task_id ?? "").trim();
    const role = String(rec.role ?? "").trim();
    if (!taskId || !role) continue;
    const failures = Number(rec.failureCount ?? 0);
    if (!rec.decisionRequired && failures <= 0) continue;
    if (rec.forceArchived) continue;
    pushCandidate(out, seen, {
      task_id: taskId,
      role,
      agent_id: resolveAgent(role),
      session_id: rec.lastSessionId ?? null,
      reason: rec.decisionRequired
        ? "dispatch_retry_decision_required"
        : `dispatch_retry_failed(${failures})`,
    });
  }

  for (const t of input.tasks ?? []) {
    const taskId = String(t.task_id ?? "").trim();
    const role = String(t.recipient ?? "").trim();
    if (!taskId || !role || t.sender !== "PM") continue;
    const ds = String(t.display_status ?? "").toLowerCase();
    if (
      ds !== "waiting_pm_attention" &&
      ds !== "blocked" &&
      ds !== "admin_rejected"
    ) {
      continue;
    }
    pushCandidate(out, seen, {
      task_id: taskId,
      role,
      agent_id: resolveAgent(role),
      thread_key: t.thread_key ?? null,
      reason: `display_status:${ds}`,
    });
  }

  return out;
}
