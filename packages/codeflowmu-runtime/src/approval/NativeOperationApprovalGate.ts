import {
  GovernanceApprovalError,
  GovernanceApprovalService,
  type GovernanceAuthorizationReference,
} from "./GovernanceApprovalService.ts";
import { OperationApprovalService, type PrepareOperationInput } from "./OperationApprovalService.ts";
import {
  assessFilesystemCleanupRisk,
} from "./FilesystemCleanupApproval.ts";
import { validateWindowsShellCommand } from "./WindowsShellDialect.ts";
import { evaluateUnifiedOperationPolicy } from "./UnifiedOperationPolicy.ts";
import { evaluateRoleToolCapability } from "../registry/RoleToolCapabilityGate.ts";

export const OPERATION_APPROVAL_REQUIRED = "OPERATION_APPROVAL_REQUIRED";
/** Historical read-only code.  New operation policy does not emit it. */
export const OPERATION_BOUNDARY_DENIED = "OPERATION_BOUNDARY_DENIED";

export type NativeOperationBoundaryDecision =
  | {
      decision: "ALLOW";
      outcome?: {
        ok: true;
        changed: boolean;
        reason:
          | "task_temporary_untracked_file"
          | "already_absent"
          | "governance_authorization_consumed"
          | "operation_approval_consumed";
        targets: string[];
        classification:
          | "allowed_cleanup"
          | "already_absent"
          | "governance_authorized";
        governance_id?: string;
      };
    }
  | {
      decision: "ROLE_CAPABILITY_DENIED";
      canonical_tool_id: string;
      reason: string;
    }
  | {
      decision: "TOOL_REQUEST_INVALID";
      canonical_tool_id: string;
      reason: string;
    }
  | { decision: "REQUIRE_APPROVAL"; input: PrepareOperationInput };

function roleFromAgentId(agentId: string): string {
  return agentId.trim().split(/[-_:]/, 1)[0]?.toUpperCase() || "UNKNOWN";
}

function normalizedToolName(toolName: string): string {
  const raw = toolName.trim().toLowerCase();
  return raw.startsWith("pm.") ? raw : raw.replace(/^.*[.:/]/, "");
}

function extractCommand(args: Record<string, unknown>): string {
  for (const key of ["command", "cmd", "script", "input"]) {
    if (typeof args[key] === "string" && String(args[key]).trim()) return String(args[key]).trim();
  }
  return "";
}

function governanceAuthorizationReference(args: Record<string, unknown>): GovernanceAuthorizationReference | null {
  const raw = args["governance_authorization"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const reference = {
    governance_id: String(value["governance_id"] ?? "").trim(),
    revision: Number(value["revision"] ?? 0),
    approval_id: String(value["approval_id"] ?? "").trim(),
    decision_id: String(value["decision_id"] ?? "").trim(),
    scope_digest: String(value["scope_digest"] ?? "").trim(),
    content_hash: String(value["content_hash"] ?? "").trim(),
    lease_id: String(value["lease_id"] ?? "").trim(),
    idempotency_key: String(value["idempotency_key"] ?? "").trim(),
  };
  return Object.values(reference).every(Boolean) && Number.isSafeInteger(reference.revision)
    ? reference
    : null;
}

/**
 * Native pre-action route.  Role capability denial only rejects the current
 * tool call.  Every effect risk is routed to a persisted operation approval;
 * this function never decides that a risky operation is unapprovable.
 */
export async function evaluateNativeOperationBoundary(input: {
  toolName: string;
  args: Record<string, unknown>;
  projectRoot: string;
  projectId: string;
  agentId: string;
  sessionId?: string;
  taskId?: string;
  threadKey?: string;
  sourceChannel?: string;
  activeCapabilities?: Iterable<string>;
}): Promise<NativeOperationBoundaryDecision> {
  const roleGate = evaluateRoleToolCapability({
    role: roleFromAgentId(input.agentId),
    toolName: input.toolName,
    args: input.args,
    activeCapabilities: input.activeCapabilities,
  });
  if (roleGate.decision === "ROLE_CAPABILITY_DENIED") return roleGate;

  const command = extractCommand(input.args);
  if (command) {
    const validation = validateWindowsShellCommand({ command, args: input.args });
    if (!validation.ok) {
      return {
        decision: "TOOL_REQUEST_INVALID",
        canonical_tool_id: roleGate.canonical_tool_id,
        reason: `tool request is invalid for the current shell dialect: ${validation.reason}`,
      };
    }
  }

  const tool = normalizedToolName(input.toolName);

  const unifiedInput = {
    ...input,
    sourceChannel: input.sourceChannel ?? "native_sdk",
    args: { ...input.args },
  };

  const lease = governanceAuthorizationReference(input.args);
  if (input.args["governance_authorization"] !== undefined) {
    if (!lease) {
      unifiedInput.args["governance_lease_validation_error"] = "malformed_reference";
    } else {
      try {
        new GovernanceApprovalService({ projectRoot: input.projectRoot }).authorizeAction(
          lease,
          {
            project_id: input.projectId,
            target_task_id: input.taskId ?? "",
            action: tool,
            targets: Array.isArray(input.args["targets"])
              ? (input.args["targets"] as unknown[]).map(String)
              : [input.args["path"], input.args["target"]].filter((value): value is string => typeof value === "string"),
          },
          { tool: input.toolName, pre_action_gate: true },
        );
        unifiedInput.args["validated_governance_lease_id"] = lease.lease_id;
      } catch (error) {
        unifiedInput.args["governance_lease_validation_error"] =
          error instanceof GovernanceApprovalError ? error.code : "APPROVAL_SCOPE_MISMATCH";
      }
    }
  }

  if (/^(?:filesystem_cleanup|cleanup|delete|delete_file|remove|remove_file)$/.test(tool)) {
    const rawTargets = Array.isArray(input.args["targets"])
      ? input.args["targets"].map(String)
      : [input.args["path"], input.args["target"], input.args["file"]]
          .filter((value): value is string => typeof value === "string")
          .map(String);
    if (rawTargets.length > 0) {
      const assessment = assessFilesystemCleanupRisk({
        projectRoot: input.projectRoot,
        targets: rawTargets,
        explicitlyTemporary: input.args["temporary"] === true || input.args["session_created"] === true,
      });
      if (assessment.decision === "ALREADY_ABSENT") {
        return { decision: "ALLOW", outcome: { ok: true, changed: false, reason: "already_absent", targets: assessment.resolved_targets, classification: "already_absent" } };
      }
      if (assessment.decision === "ALLOW") {
        return { decision: "ALLOW", outcome: { ok: true, changed: true, reason: "task_temporary_untracked_file", targets: assessment.resolved_targets, classification: "allowed_cleanup" } };
      }
    }
  }

  const unified = evaluateUnifiedOperationPolicy(unifiedInput);
  if (unified.decision === "ALLOW") return { decision: "ALLOW" };
  const consumed = new OperationApprovalService({ projectRoot: input.projectRoot })
    .consumeApprovedAuthorization(unified.input.request, {
      operation_fingerprint: unified.operation_fingerprint,
      project_id: input.projectId,
      task_id: input.taskId ?? "",
      thread_key: input.threadKey ?? "",
      agent_id: input.agentId,
      role: roleFromAgentId(input.agentId),
      session_id: input.sessionId ?? "",
    });
  if (consumed) {
    return {
      decision: "ALLOW",
      outcome: {
        ok: true,
        changed: true,
        reason: "operation_approval_consumed",
        targets: unified.facts.operation.canonical_targets,
        classification: "governance_authorized",
        governance_id: consumed.approval_id,
      },
    };
  }
  return { decision: "REQUIRE_APPROVAL", input: unified.input };
}
