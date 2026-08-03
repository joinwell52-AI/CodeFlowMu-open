import type {
  DispatchAttempt,
  ExecutionLease,
} from "./DispatchAttemptStore.js";

export type TaskDispatchStallState =
  | "waiting_dependency"
  | "lifecycle_split"
  | "task_unclaimed"
  | "session_lost"
  | "waiting_admin"
  | "running"
  | "settled"
  | "unknown";

export interface TaskDispatchStallInput {
  lifecycleBucket?: string | null;
  fmState?: string | null;
  dependencyAllowed?: boolean;
  waitingAdmin?: boolean;
  activeLease?: ExecutionLease | null;
  latestAttempt?: DispatchAttempt | null;
  hasLiveSession?: boolean;
}

export interface TaskDispatchStallClassification {
  state: TaskDispatchStallState;
  actionable: boolean;
  recommended_action:
    | "wait_dependency"
    | "repair_retry"
    | "claim_task"
    | "restart_session"
    | "wait_admin"
    | "none";
  reason: string;
}

/**
 * One deterministic classifier shared by PM diagnostics, Panel and Mobile.
 * It never mutates lifecycle state; recovery still goes through TaskDispatcher.
 */
export function classifyTaskDispatchStall(
  input: TaskDispatchStallInput,
): TaskDispatchStallClassification {
  const bucket = String(input.lifecycleBucket ?? "").trim().toLowerCase();
  const fmState = String(input.fmState ?? "").trim().toLowerCase();

  if (input.dependencyAllowed === false) {
    return {
      state: "waiting_dependency",
      actionable: false,
      recommended_action: "wait_dependency",
      reason: "task dependencies are not settled",
    };
  }
  if (bucket === "inbox" && ["dispatched", "running"].includes(fmState)) {
    return {
      state: "lifecycle_split",
      actionable: true,
      recommended_action: "repair_retry",
      reason: `physical bucket=inbox but frontmatter state=${fmState}`,
    };
  }
  if (input.waitingAdmin) {
    return {
      state: "waiting_admin",
      actionable: false,
      recommended_action: "wait_admin",
      reason: "dispatch retry requires ADMIN decision",
    };
  }
  if (["done", "review", "archive"].includes(bucket)) {
    return {
      state: "settled",
      actionable: false,
      recommended_action: "none",
      reason: `task lifecycle bucket=${bucket}`,
    };
  }
  if (bucket === "inbox" && !input.activeLease) {
    return {
      state: "task_unclaimed",
      actionable: true,
      recommended_action: "claim_task",
      reason: "canonical task is available in the recipient inbox",
    };
  }
  if (bucket === "active") {
    if (input.activeLease && input.hasLiveSession) {
      return {
        state: "running",
        actionable: false,
        recommended_action: "none",
        reason: "task has one active lease and a live session",
      };
    }
    return {
      state: "session_lost",
      actionable: true,
      recommended_action: "restart_session",
      reason: input.activeLease
        ? "execution lease exists but its session is no longer active"
        : "active task has no execution lease",
    };
  }
  if (input.latestAttempt?.status === "settled") {
    return {
      state: "settled",
      actionable: false,
      recommended_action: "none",
      reason: "latest dispatch attempt is settled",
    };
  }
  return {
    state: "unknown",
    actionable: false,
    recommended_action: "none",
    reason: `unclassified lifecycle bucket=${bucket || "unknown"}`,
  };
}
