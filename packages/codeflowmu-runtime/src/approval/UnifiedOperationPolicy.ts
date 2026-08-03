import type {
  OperationEffects,
  PrepareOperationInput,
} from "./OperationApprovalService.ts";
import {
  buildOperationFacts,
  evaluateNegativePredicates,
  operationFingerprint,
  type NegativeMatch,
  type OperationFacts,
} from "./OperationFacts.ts";

/** Historical read-only codes.  New execution paths never return them. */
export const APPROVAL_ADAPTER_REQUIRED = "APPROVAL_ADAPTER_REQUIRED";
export const ABSOLUTELY_PROHIBITED = "ABSOLUTELY_PROHIBITED";
export const UNIFIED_OPERATION_POLICY_FEATURE_FLAG = "CODEFLOWMU_UNIFIED_OPERATION_POLICY_ENABLED";

export type UnifiedPolicyDecision =
  | {
      decision: "ALLOW";
      rule_ids: string[];
      classification: string;
      effects: OperationEffects;
      targets: string[];
      reason: string;
      facts: OperationFacts;
    }
  | {
      decision: "REQUIRE_APPROVAL";
      rule_ids: string[];
      input: PrepareOperationInput;
      operation_fingerprint: string;
      resume_strategy: "agent_retry";
      facts: OperationFacts;
      matches: NegativeMatch[];
    };

export type UnifiedOperationInput = {
  toolName: string;
  args: Record<string, unknown>;
  projectRoot: string;
  projectId: string;
  agentId: string;
  sessionId?: string;
  taskId?: string;
  threadKey?: string;
  sourceChannel?: string;
};

function effectsFromFacts(facts: OperationFacts): OperationEffects {
  return {
    destructive: facts.operation.kind === "delete" || facts.impact.reversible === false,
    external_write: facts.impact.external,
    production: facts.operation.kind === "publish",
    security_change: facts.impact.privilege_change,
    governance_change: facts.impact.governance_change,
    software_change:
      facts.impact.persistent &&
      ["product", "protected"].includes(facts.target_state.lifecycle_class),
    process_control: facts.impact.runtime_change,
    target_unbounded: false,
    out_of_scope: false,
    unknown: false,
  };
}

function genericApprovalInput(
  input: UnifiedOperationInput,
  facts: OperationFacts,
  matches: NegativeMatch[],
): PrepareOperationInput {
  const targets = facts.operation.canonical_targets;
  const request = {
    subject: {
      actor: input.agentId,
      role: facts.subject.role,
      project_id: input.projectId,
      agent_id: input.agentId,
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      ...(facts.context.task_id ? { task_id: facts.context.task_id } : {}),
    },
    action: {
      capability: facts.tool.canonical_tool_id,
      operation: facts.operation.kind,
      executor: "agent.retry",
    },
    resource: {
      type: facts.target_state.lifecycle_class,
      targets,
      scope: {
        project_root_realpath: facts.context.project_root_realpath,
        task_scope_digest: facts.context.task_scope_digest,
      },
    },
    context: {
      workspace: facts.context.project_root_realpath,
      environment: "local",
      initiated_by: "agent" as const,
      authorization_source: "none" as const,
    },
    effect: effectsFromFacts(facts),
    snapshot: {
      operation_fingerprint: operationFingerprint(facts),
      operation_facts: facts,
    },
  };
  return {
    request,
    reason: matches.map((item) => item.reason_zh).join("；"),
    effects: matches.map((item) => item.rule_id),
    non_effects: ["current operation has not executed", "logical Session and Task remain recoverable"],
    recovery: "ADMIN decision is delivered to the original Agent; the Agent retries the exact call and Runtime consumes one matching authorization",
    rule_ids: matches.map((item) => item.rule_id),
    operation_facts: facts,
    operation_fingerprint: operationFingerprint(facts),
    thread_key: facts.context.thread_key,
    missing_information: [],
  };
}

/**
 * Task operation policy has exactly two routes: ALLOW or REQUIRE_APPROVAL.
 * Whether a routed operation can be approved is decided on the persisted
 * approval record, never by this policy function.
 */
export function evaluateUnifiedOperationPolicy(input: UnifiedOperationInput): UnifiedPolicyDecision {
  const facts = buildOperationFacts(input);
  const matches = evaluateNegativePredicates(facts);
  if (matches.length === 0) {
    return {
      decision: "ALLOW",
      rule_ids: [],
      classification: facts.operation.kind === "read" ? "local_read" : "bounded_task_operation",
      effects: effectsFromFacts(facts),
      targets: facts.operation.canonical_targets,
      reason: "no negative risk predicate matched",
      facts,
    };
  }

  const prepared = genericApprovalInput(input, facts, matches);
  return {
    decision: "REQUIRE_APPROVAL",
    rule_ids: matches.map((item) => item.rule_id),
    input: prepared,
    operation_fingerprint: operationFingerprint(facts),
    resume_strategy: "agent_retry",
    facts,
    matches,
  };
}
