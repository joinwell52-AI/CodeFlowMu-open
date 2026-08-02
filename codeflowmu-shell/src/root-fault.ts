import { createHash } from "node:crypto";

export type RootFaultCategory =
  | "governance"
  | "dependency"
  | "runtime"
  | "ledger"
  | "network";

export type RootFaultSeverity = "P0" | "P1" | "P2" | "P3";
export type RootFaultRetryPolicy = "manual" | "none" | "backoff";

export interface RootFaultIdentityInput {
  session_id?: string;
  task_id?: string;
  thread_key?: string;
  agent_id?: string;
  failure_code?: string;
  message?: string;
}

export interface RootFaultFields {
  fault_id: string;
  root_fault_id: string;
  is_root: boolean;
  parent_event_id?: string;
  session_id?: string;
  task_id?: string;
  thread_key?: string;
  agent_id?: string;
  tool_call_id?: string;
  category: RootFaultCategory;
  failure_code: string;
  severity: RootFaultSeverity;
  retry_policy: RootFaultRetryPolicy;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function extractStableFailureCode(
  value: unknown,
  fallback = "RUNTIME_FAILURE",
): string {
  const text = String(value ?? "").trim();
  const known = text.match(
    /\b(OPERATION_APPROVAL_REQUIRED|APPROVAL_(?:REQUIRED|PENDING|REJECTED|EXPIRED|REVOKED|SCOPE_MISMATCH|ALREADY_CONSUMED|STALE|ADAPTER_REQUIRED)|OPERATION_BOUNDARY_DENIED|ABSOLUTELY_PROHIBITED|CODEFLOWMU_POLICY_BLOCKED|AUTHORITY_DENIED|MODEL_NOT_FOUND|FUNCTION_RESPONSE_MISALIGNED|ERR_MODULE_NOT_FOUND|TASK_[A-Z_]+|LEDGER_[A-Z_]+|ECONNRESET|ETIMEDOUT|TURN_LIMIT)\b/i,
  );
  if (known) return known[1]!.toUpperCase();
  const token = text.match(/\b[A-Z][A-Z0-9_]{3,}\b/);
  return token?.[0] ?? fallback;
}

export function classifyRootFault(
  failureCode: string,
  message = "",
): Pick<RootFaultFields, "category" | "severity" | "retry_policy"> {
  const code = failureCode.toUpperCase();
  const text = `${code} ${message}`.toLowerCase();
  if (
    code === "OPERATION_APPROVAL_REQUIRED" ||
    code === "APPROVAL_REQUIRED" ||
    code === "APPROVAL_PENDING"
  ) {
    return { category: "governance", severity: "P3", retry_policy: "manual" };
  }
  if (
    code === "APPROVAL_REJECTED" ||
    code === "APPROVAL_EXPIRED" ||
    code === "APPROVAL_REVOKED" ||
    code === "APPROVAL_SCOPE_MISMATCH" ||
    code === "APPROVAL_ALREADY_CONSUMED" ||
    code === "APPROVAL_STALE" ||
    code === "APPROVAL_ADAPTER_REQUIRED" ||
    code === "OPERATION_BOUNDARY_DENIED" ||
    code === "ABSOLUTELY_PROHIBITED"
  ) {
    return { category: "governance", severity: "P3", retry_policy: "none" };
  }
  if (
    code === "CODEFLOWMU_POLICY_BLOCKED" ||
    code === "AUTHORITY_DENIED" ||
    text.includes("policy_blocked")
  ) {
    return { category: "governance", severity: "P3", retry_policy: "manual" };
  }
  if (
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "MODEL_NOT_FOUND" ||
    text.includes("cannot find module") ||
    text.includes("cannot find package")
  ) {
    return { category: "dependency", severity: "P1", retry_policy: "manual" };
  }
  if (code.startsWith("LEDGER_") || text.includes("ledger")) {
    return { category: "ledger", severity: "P1", retry_policy: "manual" };
  }
  if (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    text.includes("network") ||
    text.includes("rate limit") ||
    text.includes("429")
  ) {
    return { category: "network", severity: "P1", retry_policy: "backoff" };
  }
  return { category: "runtime", severity: "P1", retry_policy: "none" };
}

export function buildRootFaultId(input: RootFaultIdentityInput): string {
  const failureCode = extractStableFailureCode(
    input.failure_code || input.message,
  );
  const identity = [
    input.session_id || "no-session",
    input.task_id || "no-task",
    input.thread_key || "no-thread",
    input.agent_id || "no-agent",
    failureCode,
  ].join("|");
  return `root-fault-${shortHash(identity)}`;
}

export function buildRootFaultFields(
  input: RootFaultIdentityInput & {
    event_id?: string;
    root_fault_id?: string;
    is_root: boolean;
    parent_event_id?: string;
    tool_call_id?: string;
  },
): RootFaultFields {
  const failureCode = extractStableFailureCode(
    input.failure_code || input.message,
  );
  const rootFaultId = input.root_fault_id || buildRootFaultId({
    ...input,
    failure_code: failureCode,
  });
  const classification = classifyRootFault(failureCode, input.message);
  const faultSeed = [
    rootFaultId,
    input.event_id || "",
    input.parent_event_id || "",
    input.tool_call_id || "",
    input.is_root ? "root" : "derived",
  ].join("|");
  return {
    fault_id: `fault-${shortHash(faultSeed)}`,
    root_fault_id: rootFaultId,
    is_root: input.is_root,
    ...(input.parent_event_id
      ? { parent_event_id: input.parent_event_id }
      : {}),
    ...(input.session_id ? { session_id: input.session_id } : {}),
    ...(input.task_id ? { task_id: input.task_id } : {}),
    ...(input.thread_key ? { thread_key: input.thread_key } : {}),
    ...(input.agent_id ? { agent_id: input.agent_id } : {}),
    ...(input.tool_call_id ? { tool_call_id: input.tool_call_id } : {}),
    failure_code: failureCode,
    ...classification,
  };
}
