import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { globalFileWriteMutex } from "../_internal/KeyedMutex.ts";

export type DispatchAttemptStatus =
  | "created" | "offered" | "claimed" | "running" | "reported" | "settled"
  | "rejected" | "expired" | "stale" | "session_failed" | "superseded";

export type DispatchAttempt = {
  attempt_id: string;
  task_id: string;
  task_path: string;
  task_content_hash?: string;
  thread_key?: string;
  parent_task_id?: string;
  target_role: string;
  target_agent_id?: string;
  source: string;
  mode: "initial" | "retry" | "repair_retry" | "restart_session" | "reassign" | "agent_claim";
  status: DispatchAttemptStatus;
  created_at: string;
  updated_at: string;
  claimed_at?: string;
  running_at?: string;
  ended_at?: string;
  session_id?: string;
  lease_id?: string;
  reason?: string;
  idempotency_key?: string;
};

export type ExecutionLease = {
  lease_id: string;
  task_id: string;
  attempt_id: string;
  agent_id: string;
  session_id: string;
  acquired_at: string;
  expires_at: string;
  released_at?: string;
  release_reason?: string;
};

export type TaskExecutionDecisionValue = "ALLOW" | "WAIT" | "REJECT" | "NEEDS_PM";

export type TaskExecutionDecision = {
  decision_id: string;
  operation_id: string;
  task_id: string;
  input_digest: string;
  decision: TaskExecutionDecisionValue;
  reason: string;
  source: string;
  created_at: string;
};

type DispatchStateFile = {
  version: 1;
  attempts: DispatchAttempt[];
  leases: ExecutionLease[];
  decisions: TaskExecutionDecision[];
};
export type OfferDispatchAttemptInput = Omit<DispatchAttempt, "attempt_id" | "status" | "created_at" | "updated_at">;
export type ClaimExecutionLeaseResult =
  | { ok: true; attempt: DispatchAttempt; lease: ExecutionLease; idempotent: boolean }
  | { ok: false; code: "LEASE_CONFLICT" | "ATTEMPT_NOT_FOUND" | "ATTEMPT_TERMINAL"; active_lease?: ExecutionLease };

const TERMINAL = new Set<DispatchAttemptStatus>([
  "settled", "rejected", "expired", "stale", "session_failed", "superseded",
]);
const emptyState = (): DispatchStateFile => ({ version: 1, attempts: [], leases: [], decisions: [] });

function dispatchTaskKey(taskId: string): string {
  const normalized = taskId.replace(/\.md$/i, "").trim().toUpperCase();
  return /^TASK-\d{8}-\d{3,}/.exec(normalized)?.[0] ?? normalized;
}

export class DispatchAttemptStore {
  readonly path: string;
  readonly #now: () => Date;

  constructor(opts: { projectRoot: string; now?: () => Date; path?: string }) {
    this.path = resolve(opts.path ?? join(opts.projectRoot, ".codeflowmu", "dispatch", "dispatch-state.json"));
    this.#now = opts.now ?? (() => new Date());
  }

  async snapshot(): Promise<DispatchStateFile> { return this.#read(); }

  async getTaskState(taskId: string): Promise<{ attempts: DispatchAttempt[]; active_lease?: ExecutionLease }> {
    const state = await this.#read();
    const key = dispatchTaskKey(taskId);
    const now = this.#now().getTime();
    const activeLease = state.leases.find((lease) =>
      dispatchTaskKey(lease.task_id) === key && !lease.released_at && Date.parse(lease.expires_at) > now);
    return {
      attempts: state.attempts.filter((attempt) => dispatchTaskKey(attempt.task_id) === key),
      ...(activeLease ? { active_lease: activeLease } : {}),
    };
  }

  async recordDecision(input: Omit<TaskExecutionDecision, "decision_id" | "created_at">): Promise<TaskExecutionDecision> {
    return this.#mutate((state) => {
      const existing = state.decisions.find((row) =>
        row.operation_id === input.operation_id &&
        dispatchTaskKey(row.task_id) === dispatchTaskKey(input.task_id) &&
        row.input_digest === input.input_digest);
      if (existing) {
        if (existing.decision !== input.decision || existing.reason !== input.reason) {
          throw new Error(
            `STATE_DECISION_CONFLICT: operation_id=${input.operation_id}; task_id=${input.task_id}; existing=${existing.decision}/${existing.reason}; next=${input.decision}/${input.reason}`,
          );
        }
        return { value: existing, changed: false };
      }
      const decision: TaskExecutionDecision = {
        ...input,
        decision_id: `decision-${randomUUID()}`,
        created_at: this.#now().toISOString(),
      };
      state.decisions.push(decision);
      if (state.decisions.length > 2_000) state.decisions.splice(0, state.decisions.length - 2_000);
      return { value: decision, changed: true };
    });
  }

  async offer(input: OfferDispatchAttemptInput): Promise<{ attempt: DispatchAttempt; idempotent: boolean }> {
    return this.#mutate<{ attempt: DispatchAttempt; idempotent: boolean }>((state) => {
      if (input.idempotency_key) {
        const existing = state.attempts.find((attempt) => attempt.idempotency_key === input.idempotency_key);
        if (existing) return { value: { attempt: existing, idempotent: true }, changed: false };
      }
      const now = this.#now().toISOString();
      const attempt: DispatchAttempt = {
        ...input,
        attempt_id: `attempt-${randomUUID()}`,
        status: "offered",
        created_at: now,
        updated_at: now,
      };
      state.attempts.push(attempt);
      return { value: { attempt, idempotent: false }, changed: true };
    });
  }

  async claim(input: { taskId: string; attemptId: string; agentId: string; sessionId: string; ttlMs?: number }): Promise<ClaimExecutionLeaseResult> {
    return this.#mutate<ClaimExecutionLeaseResult>((state) => {
      const attempt = state.attempts.find((item) => item.attempt_id === input.attemptId);
      if (!attempt) return { value: { ok: false, code: "ATTEMPT_NOT_FOUND" } as const, changed: false };
      if (TERMINAL.has(attempt.status)) return { value: { ok: false, code: "ATTEMPT_TERMINAL" } as const, changed: false };
      const nowDate = this.#now();
      const now = nowDate.toISOString();
      for (const lease of state.leases) {
        if (!lease.released_at && Date.parse(lease.expires_at) <= nowDate.getTime()) {
          lease.released_at = now;
          lease.release_reason = "expired";
        }
      }
      const active = state.leases.find((lease) => dispatchTaskKey(lease.task_id) === dispatchTaskKey(input.taskId) && !lease.released_at);
      if (active) {
        if (active.attempt_id === input.attemptId && active.agent_id === input.agentId && active.session_id === input.sessionId) {
          return { value: { ok: true, attempt, lease: active, idempotent: true } as const, changed: true };
        }
        return { value: { ok: false, code: "LEASE_CONFLICT", active_lease: active } as const, changed: true };
      }
      const lease: ExecutionLease = {
        lease_id: `lease-${randomUUID()}`,
        task_id: input.taskId,
        attempt_id: input.attemptId,
        agent_id: input.agentId,
        session_id: input.sessionId,
        acquired_at: now,
        expires_at: new Date(nowDate.getTime() + (input.ttlMs ?? 30 * 60_000)).toISOString(),
      };
      state.leases.push(lease);
      Object.assign(attempt, {
        status: "claimed" as const,
        target_agent_id: input.agentId,
        session_id: input.sessionId,
        lease_id: lease.lease_id,
        claimed_at: now,
        updated_at: now,
      });
      return { value: { ok: true, attempt, lease, idempotent: false } as const, changed: true };
    });
  }

  async markRunning(attemptId: string, sessionId: string): Promise<DispatchAttempt | undefined> {
    return this.#mutate((state) => {
      const attempt = state.attempts.find((item) => item.attempt_id === attemptId);
      if (!attempt || TERMINAL.has(attempt.status)) return { value: undefined, changed: false };
      const now = this.#now().toISOString();
      Object.assign(attempt, { status: "running" as const, session_id: sessionId, running_at: now, updated_at: now });
      const lease = state.leases.find((item) => item.attempt_id === attemptId && !item.released_at);
      if (lease) lease.session_id = sessionId;
      return { value: attempt, changed: true };
    });
  }

  async finish(attemptId: string, status: Extract<DispatchAttemptStatus, "reported" | "settled" | "rejected" | "expired" | "stale" | "session_failed" | "superseded">, reason?: string): Promise<void> {
    await this.#mutate((state) => {
      const attempt = state.attempts.find((item) => item.attempt_id === attemptId);
      if (!attempt) return { value: undefined, changed: false };
      const now = this.#now().toISOString();
      Object.assign(attempt, { status, updated_at: now, ended_at: now, ...(reason ? { reason } : {}) });
      const lease = state.leases.find((item) => item.attempt_id === attemptId && !item.released_at);
      if (lease) Object.assign(lease, { released_at: now, release_reason: reason ?? status });
      return { value: undefined, changed: true };
    });
  }

  async #read(): Promise<DispatchStateFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.path, "utf8")) as Partial<DispatchStateFile>;
      return {
        version: 1,
        attempts: Array.isArray(parsed.attempts) ? parsed.attempts : [],
        leases: Array.isArray(parsed.leases) ? parsed.leases : [],
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
  }

  async #mutate<T>(fn: (state: DispatchStateFile) => { value: T; changed: boolean }): Promise<T> {
    return globalFileWriteMutex.run(this.path, async () => {
      const state = await this.#read();
      const result = fn(state);
      if (result.changed) await this.#write(state);
      return result.value;
    });
  }

  async #write(state: DispatchStateFile): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    try {
      await fs.rename(tmp, this.path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      await fs.rm(this.path, { force: true });
      await fs.rename(tmp, this.path);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }
}
