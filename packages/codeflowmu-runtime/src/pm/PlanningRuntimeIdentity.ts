import { resolve } from "node:path";

import type { SessionStore } from "../session/SessionStore.ts";

const issuedAuthorities = new WeakSet<object>();

export type VerifiedPlanningRuntimeIdentity = Readonly<{
  project_root: string;
  session_id: string;
  agent_id: string;
  caller_role: string;
  task_id: string;
  root_task_id: string;
  thread_key: string;
}>;

export class PlanningRuntimeIdentityError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PlanningRuntimeIdentityError";
  }
}

/**
 * Resolve a planning authority from the persisted Runtime SessionStore.
 * The returned object is branded in this module; raw role/session strings or
 * object literals cannot be used as formal-write authority.
 */
export async function authorizePlanningRuntimeIdentity(input: {
  sessionStore: SessionStore;
  projectRoot: string;
  sessionId: string;
  callerRole: string;
  taskId: string;
  agentId?: string;
  threadKey?: string;
}): Promise<VerifiedPlanningRuntimeIdentity> {
  const sessionId = String(input.sessionId ?? "").trim();
  const callerRole = String(input.callerRole ?? "").trim();
  const taskId = String(input.taskId ?? "").trim();
  const agentId = String(input.agentId ?? "").trim();
  const requestedThreadKey = String(input.threadKey ?? "").trim();
  if (!sessionId || !callerRole || !taskId) {
    throw new PlanningRuntimeIdentityError(
      "INVALID_PLANNING_ARTIFACT_CALL",
      "Runtime session, caller role and task identity are required",
    );
  }
  const session = await input.sessionStore.load(sessionId);
  if (!session) {
    throw new PlanningRuntimeIdentityError(
      "RUNTIME_SESSION_NOT_FOUND",
      `Unknown Runtime session_id: ${sessionId}`,
    );
  }
  if (session.protocol.status !== "running") {
    throw new PlanningRuntimeIdentityError(
      "RUNTIME_SESSION_NOT_ACTIVE",
      `Runtime session is ${session.protocol.status}`,
    );
  }
  const persistedAgentId = String(session.protocol.agent_id ?? "").trim();
  if (!/^PM(?:[-.]|$)/i.test(persistedAgentId)) {
    throw new PlanningRuntimeIdentityError(
      "RUNTIME_CONTEXT_MISMATCH",
      `Runtime session ${sessionId} is not bound to a PM agent`,
    );
  }
  if (persistedAgentId !== callerRole || (agentId && persistedAgentId !== agentId)) {
    throw new PlanningRuntimeIdentityError(
      "RUNTIME_CONTEXT_MISMATCH",
      `caller identity does not match SessionStore agent_id for ${sessionId}`,
    );
  }
  const sessionTaskId = String(session.protocol.task_id ?? "").trim();
  const rootTaskId = String(session.runtime_root_task_id ?? sessionTaskId).trim();
  if (rootTaskId !== taskId) {
    throw new PlanningRuntimeIdentityError(
      "RUNTIME_TASK_MISMATCH",
      `current root task_id does not match SessionStore context for ${sessionId}`,
    );
  }
  const persistedThreadKey = String(session.runtime_thread_key ?? "").trim();
  if (requestedThreadKey && persistedThreadKey !== requestedThreadKey) {
    throw new PlanningRuntimeIdentityError(
      "RUNTIME_THREAD_MISMATCH",
      `thread_key does not match SessionStore context for ${sessionId}`,
    );
  }
  const authority = Object.freeze({
    project_root: resolve(input.projectRoot),
    session_id: sessionId,
    agent_id: persistedAgentId,
    caller_role: persistedAgentId,
    task_id: sessionTaskId || rootTaskId,
    root_task_id: rootTaskId,
    thread_key: persistedThreadKey,
  });
  issuedAuthorities.add(authority);
  return authority;
}

export function assertPlanningRuntimeIdentity(
  value: unknown,
): asserts value is VerifiedPlanningRuntimeIdentity {
  if (!value || typeof value !== "object" || !issuedAuthorities.has(value)) {
    throw new PlanningRuntimeIdentityError(
      "VERIFIED_RUNTIME_IDENTITY_REQUIRED",
      "A verified Runtime planning identity is required for formal writes",
    );
  }
}

