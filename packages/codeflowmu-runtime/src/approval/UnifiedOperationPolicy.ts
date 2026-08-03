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
import { buildWorkspaceOperationApprovalInput } from "./WorkspaceOperationApproval.ts";
import type { WorkspaceExecutorName } from "./WorkspaceOperationApproval.ts";

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
      executor: string;
      operation_fingerprint: string;
      resume_strategy: "controlled_execute" | "capability_lease";
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

function executorFor(facts: OperationFacts): WorkspaceExecutorName | "git.push" | "filesystem.cleanup" | "review.policy.save" | "" {
  const tool = facts.tool.canonical_tool_id;
  if (facts.operation.kind === "remote_git") return "git.push";
  if (facts.operation.kind === "delete" && /cleanup/.test(tool)) return "filesystem.cleanup";
  if (/review.*policy.*save/.test(tool)) return "review.policy.save";
  if (facts.tool.adapter_id !== "structured.tool.v1") return "";
  if (facts.operation.kind === "create") return "workspace.fs.mkdir";
  if (facts.operation.kind === "write" || facts.operation.kind === "append") {
    return /patch|apply_patch/.test(tool) ? "workspace.patch.apply" : "workspace.fs.write";
  }
  if (facts.operation.kind === "copy") return "workspace.fs.copy";
  if (facts.operation.kind === "move") return "workspace.fs.move";
  return "";
}

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
    target_unbounded: !facts.operation.target_set_stable,
    out_of_scope: facts.impact.external,
    unknown: !facts.confidence.complete,
  };
}

function genericApprovalInput(
  input: UnifiedOperationInput,
  facts: OperationFacts,
  matches: NegativeMatch[],
  executor: string,
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
      executor: executor || "unresolved.operation",
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
    recovery: "ADMIN decision is written to this approval record; execution requires a controlled executor and digest recheck",
    rule_ids: matches.map((item) => item.rule_id),
    operation_facts: facts,
    operation_fingerprint: operationFingerprint(facts),
    thread_key: facts.context.thread_key,
    missing_information: facts.confidence.unresolved_fields,
    executor_status: executor ? "ready" : "missing",
    suggested_executor: executor || "structured operation adapter required",
  };
}

function structuredWorkspaceApprovalInput(
  input: UnifiedOperationInput,
  facts: OperationFacts,
  matches: NegativeMatch[],
  executor: WorkspaceExecutorName,
): PrepareOperationInput {
  const content = typeof input.args["content"] === "string"
    ? String(input.args["content"])
    : typeof input.args["text"] === "string"
      ? String(input.args["text"])
      : "";
  const source = typeof input.args["source"] === "string"
    ? String(input.args["source"])
    : typeof input.args["source_path"] === "string"
      ? String(input.args["source_path"])
      : undefined;
  const patch = typeof input.args["patch"] === "string"
    ? String(input.args["patch"])
    : typeof input.args["diff"] === "string"
      ? String(input.args["diff"])
      : undefined;
  const prepared = buildWorkspaceOperationApprovalInput({
    projectRoot: input.projectRoot,
    subject: {
      actor: input.agentId,
      role: facts.subject.role,
      project_id: input.projectId,
      agent_id: input.agentId,
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      ...(facts.context.task_id ? { task_id: facts.context.task_id } : {}),
    },
    executor,
    targets: executor === "workspace.patch.apply" ? undefined : facts.operation.canonical_targets,
    source,
    content,
    patch,
    allowed_paths: executor === "workspace.patch.apply" ? facts.operation.canonical_targets : undefined,
    encoding: "utf8",
    overwrite: input.args["overwrite"] !== false,
    policy_rule_ids: matches.map((item) => item.rule_id),
  });
  return {
    ...prepared,
    rule_ids: matches.map((item) => item.rule_id),
    operation_facts: facts,
    operation_fingerprint: operationFingerprint(facts),
    thread_key: facts.context.thread_key,
    missing_information: facts.confidence.unresolved_fields,
    executor_status: "ready",
    suggested_executor: executor,
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
  if (
    process.env[UNIFIED_OPERATION_POLICY_FEATURE_FLAG] === "0" &&
    facts.operation.kind !== "read" &&
    matches.length === 0
  ) {
    matches.push({
      rule_id: "NEG.OPAQUE.EFFECT",
      matched: true,
      evidence_fields: ["tool.canonical_tool_id", "operation.kind"],
      reason_zh: "统一效果策略已停用；当前非只读操作安全降级为建单等待",
      required_fact_fields: ["tool.canonical_tool_id", "operation.kind"],
    });
  }
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

  const executor = executorFor(facts);
  let prepared: PrepareOperationInput;
  if (executor && executor.startsWith("workspace.")) {
    try {
      prepared = structuredWorkspaceApprovalInput(input, facts, matches, executor as WorkspaceExecutorName);
    } catch (error) {
      prepared = genericApprovalInput(input, facts, matches, "");
      prepared.executor_status = "incompatible";
      const executorProblem = error instanceof Error ? error.message : String(error);
      prepared.reason = `${prepared.reason}; controlled executor preflight: ${executorProblem}`;
      prepared.suggested_executor = facts.target_state.lifecycle_class === "governance"
        ? "use the exact formal governance tool for this ledger mutation"
        : `${executor}: ${executorProblem}`;
    }
  } else {
    prepared = genericApprovalInput(input, facts, matches, executor);
  }
  return {
    decision: "REQUIRE_APPROVAL",
    rule_ids: matches.map((item) => item.rule_id),
    input: prepared,
    executor: executor || "unresolved.operation",
    operation_fingerprint: operationFingerprint(facts),
    resume_strategy: "controlled_execute",
    facts,
    matches,
  };
}
