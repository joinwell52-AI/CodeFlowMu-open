import { basename, isAbsolute, relative, resolve } from "node:path";

import {
  buildGitPushApprovalInput,
  type GitPushSubject,
} from "./GitPushApproval.ts";
import {
  GovernanceApprovalError,
  GovernanceApprovalService,
  type GovernanceAuthorizationReference,
} from "./GovernanceApprovalService.ts";
import type { PrepareOperationInput } from "./OperationApprovalService.ts";
import {
  assessFilesystemCleanupRisk,
  buildFilesystemCleanupApprovalInput,
} from "./FilesystemCleanupApproval.ts";
import { validateWindowsShellCommand } from "./WindowsShellDialect.ts";
import { evaluateUnifiedOperationPolicy } from "./UnifiedOperationPolicy.ts";

export const OPERATION_APPROVAL_REQUIRED = "OPERATION_APPROVAL_REQUIRED";
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
          | "governance_authorization_consumed";
        targets: string[];
        classification:
          | "allowed_cleanup"
          | "already_absent"
          | "governance_authorized";
        governance_id?: string;
      };
    }
  | {
      decision: "DENY";
      reason: string;
      code?: string;
      next_safe_action?: string;
    }
  | { decision: "REQUIRE_APPROVAL"; input: PrepareOperationInput };

function governanceAuthorizationReference(
  args: Record<string, unknown>,
): GovernanceAuthorizationReference | null {
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

function evaluateGovernanceAuthorization(input: {
  args: Record<string, unknown>;
  projectRoot: string;
  projectId: string;
  taskId?: string;
  action: string;
  targets: string[];
  toolName: string;
}): NativeOperationBoundaryDecision | null {
  const reference = governanceAuthorizationReference(input.args);
  if (!reference) return null;
  try {
    const governance = new GovernanceApprovalService({
      projectRoot: input.projectRoot,
    }).authorizeAction(
      reference,
      {
        project_id: input.projectId,
        target_task_id: input.taskId ?? "",
        action: input.action,
        targets: input.targets,
      },
      {
        tool: input.toolName,
        pre_action_gate: true,
      },
    );
    return {
      decision: "ALLOW",
      outcome: {
        ok: true,
        changed: true,
        reason: "governance_authorization_consumed",
        targets: input.targets,
        classification: "governance_authorized",
        governance_id: governance.governance_id,
      },
    };
  } catch (error) {
    if (error instanceof GovernanceApprovalError) {
      return {
        decision: "DENY",
        code: error.code,
        reason: error.message,
        next_safe_action:
          error.code === "ABSOLUTELY_PROHIBITED"
            ? "stop_and_report_policy_violation"
            : "request_new_or_corrected_governance_approval",
      };
    }
    return {
      decision: "DENY",
      code: "APPROVAL_REQUIRED",
      reason: error instanceof Error ? error.message : String(error),
      next_safe_action: "request_governance_approval",
    };
  }
}

function extractCommand(args: Record<string, unknown>): string {
  for (const key of ["command", "cmd", "script", "input"]) {
    if (typeof args[key] === "string" && String(args[key]).trim()) {
      return String(args[key]).trim();
    }
  }
  return "";
}

function resolveCommandCwd(projectRoot: string, args: Record<string, unknown>): string | null {
  const raw = [args["cwd"], args["workingDirectory"], args["workdir"]]
    .find((value) => typeof value === "string" && value.trim());
  const cwd = raw ? resolve(projectRoot, String(raw)) : resolve(projectRoot);
  const rel = relative(resolve(projectRoot), cwd);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return cwd;
  return null;
}

function roleFromAgentId(agentId: string): string {
  return agentId.trim().split(/[-_:]/, 1)[0]?.toUpperCase() || "UNKNOWN";
}

function containsShellComposition(command: string): boolean {
  return /(?:&&|\|\||[;|`]|\r|\n)/.test(command);
}

function extractTargetPath(args: Record<string, unknown>): string {
  for (const key of ["path", "file", "file_path", "filepath", "target", "target_path"]) {
    if (typeof args[key] === "string" && String(args[key]).trim()) {
      return String(args[key]).replace(/\\/g, "/").toLowerCase();
    }
  }
  return "";
}

function normalizedToolName(toolName: string): string {
  return toolName.trim().toLowerCase().replace(/^.*[.:/]/, "");
}

function isReadOnlyTool(toolName: string): boolean {
  const name = normalizedToolName(toolName);
  return /^(?:read|read_file|read_text_file|read_task|read_report|grep|grep_files|glob|list|list_files|list_directory|list_tasks|list_reports|list_issues|search|search_files|find)$/.test(name);
}

function isRuntimeGovernanceWriteTool(toolName: string): boolean {
  const name = normalizedToolName(toolName);
  return /^(?:write_task|write_report|write_issue|write_review|review|review_task|submit_review|approve_review|reject_review|mark_human_approved|archive_task|claim_task|submit_task|finish_task|approve_task|reopen_task)$/.test(name);
}

function isDirectMutationTool(toolName: string): boolean {
  const name = normalizedToolName(toolName);
  return /^(?:edit|edit_file|delete|delete_file|remove|remove_file|apply_patch|write|write_file|create_file|move|move_file)$/.test(name);
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  const matcher = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens.filter(Boolean);
}

function executableName(token: string): string {
  return basename(token.replace(/^&\s*/, ""))
    .replace(/\.(?:exe|com|cmd|bat)$/i, "")
    .toLowerCase();
}

function effectiveExecutable(tokens: string[]): { name: string; args: string[] } {
  if (tokens.length === 0) return { name: "", args: [] };
  const first = executableName(tokens[0]!);
  if (first === "cmd") {
    const commandIndex = tokens.findIndex((token) => /^\/(?:c|k)$/i.test(token));
    if (commandIndex >= 0 && tokens[commandIndex + 1]) {
      return {
        name: executableName(tokens[commandIndex + 1]!),
        args: tokens.slice(commandIndex + 2),
      };
    }
  }
  return { name: first, args: tokens.slice(1) };
}

function isActualDiskFormatCommand(command: string): boolean {
  const executable = effectiveExecutable(tokenizeCommand(command));
  if (executable.name === "diskpart") return true;
  if (executable.name === "format") {
    return executable.args.some((arg) =>
      /^(?:[a-z]:|\\\\\.\\(?:physicaldrive\d+|[a-z]:))$/i.test(arg),
    );
  }
  if (["powershell", "pwsh"].includes(executable.name)) {
    const commandIndex = executable.args.findIndex((arg) => /^-(?:c|command)$/i.test(arg));
    const script = commandIndex >= 0 ? executable.args.slice(commandIndex + 1) : executable.args;
    return script.some((arg) => /^format-volume$/i.test(arg));
  }
  return false;
}

function isGovernanceStorageTarget(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  return /(?:^|\/)fcop\/(?:_lifecycle|tasks|reports|issues|review|logs|approvals)(?:\/|$)/.test(normalized);
}

function commandTargetsGovernanceStorage(command: string): boolean {
  const tokens = tokenizeCommand(command);
  return tokens.some(isGovernanceStorageTarget);
}

function isReadOnlyGovernanceShellCommand(command: string): boolean {
  if (/(?:^|\s)(?:>>?|2>)(?:\s|$)/.test(command)) return false;
  if (containsShellComposition(command)) return false;
  const executable = effectiveExecutable(tokenizeCommand(command));
  if (executable.name === "git") {
    return /^(?:grep|diff|show|status|log)$/i.test(executable.args[0] ?? "");
  }
  return /^(?:type|more|dir|ls|rg|grep|findstr|find|get-content|select-string|get-childitem)$/.test(executable.name);
}

function unsupportedHighRiskReason(command: string): string | null {
  const rules: Array<[RegExp, string]> = [
    [/\bgh(?:\.exe)?\s+(?:pr\s+(?:create|merge|review|comment)|issue\s+(?:create|comment)|release\s+create)\b/i, "external_write_adapter_not_registered"],
    [/\b(?:npm|pnpm|yarn)\s+publish\b|\bdocker\s+push\b|\bvercel\b[^\r\n]*\b--prod\b/i, "production_release_adapter_not_registered"],
    [/\bkubectl\s+(?:apply|create|delete|patch|replace|scale)\b|\bhelm\s+(?:install|upgrade|uninstall)\b|\bterraform\s+(?:apply|destroy)\b/i, "production_operation_adapter_not_registered"],
    [/\b(?:chmod|chown|icacls|takeown)\b|\bgit(?:\.exe)?\s+remote\s+(?:add|remove|rename|set-url)\b/i, "security_authority_adapter_not_registered"],
    [/\bgit(?:\.exe)?\s+(?:reset\s+--hard|clean\s+-[^\s]*[fdx])\b/i, "destructive_operation_adapter_not_registered"],
  ];
  if (isActualDiskFormatCommand(command)) return "destructive_operation_adapter_not_registered";
  return rules.find(([pattern]) => pattern.test(command))?.[1] ?? null;
}

/** Deterministic pre-action gate for native SDK shell calls. */
export async function evaluateNativeOperationBoundary(input: {
  toolName: string;
  args: Record<string, unknown>;
  projectRoot: string;
  projectId: string;
  agentId: string;
  sessionId?: string;
  taskId?: string;
}): Promise<NativeOperationBoundaryDecision> {
  const command = extractCommand(input.args);
  const target = extractTargetPath(input.args);
  const readOnly = isReadOnlyTool(input.toolName);
  const runtimeProtocolWrite = isRuntimeGovernanceWriteTool(input.toolName);
  const directMutation = isDirectMutationTool(input.toolName);

  if (command) {
    const shellValidation = validateWindowsShellCommand({
      command,
      args: input.args,
    });
    if (!shellValidation.ok) {
      return {
        decision: "DENY",
        reason: shellValidation.reason,
        next_safe_action: shellValidation.next_safe_action,
      };
    }
  }

  if (isGovernanceStorageTarget(target)) {
    if (readOnly || runtimeProtocolWrite) return { decision: "ALLOW" };
    if (directMutation || command) {
      return {
        decision: "DENY",
        code: "ABSOLUTELY_PROHIBITED",
        reason: "governance_storage_boundary_violation",
      };
    }
    return { decision: "DENY", reason: "governance_storage_boundary_unknown_tool" };
  }
  if (commandTargetsGovernanceStorage(command)) {
    if (isReadOnlyGovernanceShellCommand(command)) return { decision: "ALLOW" };
    return {
      decision: "DENY",
      code: "ABSOLUTELY_PROHIBITED",
      reason: "governance_storage_boundary_violation",
    };
  }
  if (runtimeProtocolWrite) return { decision: "ALLOW" };
  const tool = normalizedToolName(input.toolName);
  if (
    /^(?:filesystem_cleanup|cleanup|delete|delete_file|remove|remove_file)$/.test(
      tool,
    )
  ) {
    const rawTargets = Array.isArray(input.args["targets"])
      ? input.args["targets"].map(String)
      : [input.args["path"], input.args["target"], input.args["file"]]
          .filter((value) => typeof value === "string")
          .map(String);
    if (rawTargets.length === 0) {
      return { decision: "DENY", reason: "filesystem_cleanup_targets_missing" };
    }
    const assessment = assessFilesystemCleanupRisk({
      projectRoot: input.projectRoot,
      targets: rawTargets,
      explicitlyTemporary:
        input.args["temporary"] === true ||
        input.args["session_created"] === true,
    });
    if (assessment.decision === "DENY") {
      return { decision: "DENY", reason: assessment.reason };
    }
    if (assessment.decision === "ALREADY_ABSENT") {
      return {
        decision: "ALLOW",
        outcome: {
          ok: true,
          changed: false,
          reason: "already_absent",
          targets: assessment.resolved_targets,
          classification: "already_absent",
        },
      };
    }
    if (assessment.decision === "ALLOW") {
      return {
        decision: "ALLOW",
        outcome: {
          ok: true,
          changed: true,
          reason: "task_temporary_untracked_file",
          targets: assessment.resolved_targets,
          classification: "allowed_cleanup",
        },
      };
    }
    try {
      return {
        decision: "REQUIRE_APPROVAL",
        input: buildFilesystemCleanupApprovalInput({
          projectRoot: input.projectRoot,
          targets: assessment.resolved_targets.filter((target) =>
            assessment.git_status[target] !== "absent"
          ),
          subject: {
            actor: input.agentId,
            role: roleFromAgentId(input.agentId),
            project_id: input.projectId,
            agent_id: input.agentId,
            ...(input.sessionId ? { session_id: input.sessionId } : {}),
            ...(input.taskId ? { task_id: input.taskId } : {}),
          },
          mode:
            String(input.args["mode"] ?? "quarantine") === "permanent_delete"
              ? "permanent_delete"
              : "quarantine",
          retentionDays: Number(input.args["retention_days"] ?? 14),
          reason: String(input.args["reason"] ?? "").trim() || undefined,
        }),
      };
    } catch (error) {
      return {
        decision: "DENY",
        reason: `filesystem_cleanup_preflight_failed:${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
  const unsupportedReason = command ? unsupportedHighRiskReason(command) : null;
  if (unsupportedReason) {
    if (isActualDiskFormatCommand(command)) {
      return {
        decision: "DENY",
        code: "ABSOLUTELY_PROHIBITED",
        reason: unsupportedReason,
      };
    }
    return {
      decision: "DENY",
      code: "APPROVAL_ADAPTER_REQUIRED",
      reason: unsupportedReason,
      next_safe_action: "use_a_registered_structured_executor_or_add_a_reviewed_adapter",
    };
  }
  if (!command || !/\bgit(?:\.exe)?\s+push\b/i.test(command)) {
    if (directMutation && target) {
      const governedLocalWrite = evaluateGovernanceAuthorization({
        args: input.args,
        projectRoot: input.projectRoot,
        projectId: input.projectId,
        taskId: input.taskId,
        action: "workspace.fs.write",
        targets: [target],
        toolName: input.toolName,
      });
      if (governedLocalWrite) return governedLocalWrite;
    }
    const unified = evaluateUnifiedOperationPolicy(input);
    if (unified.decision === "ALLOW") return { decision: "ALLOW" };
    if (unified.decision === "REQUIRE_APPROVAL") {
      return { decision: "REQUIRE_APPROVAL", input: unified.input };
    }
    return {
      decision: "DENY",
      code: unified.code,
      reason: unified.reason,
      next_safe_action: unified.next_safe_action,
    };
  }

  if (containsShellComposition(command)) {
    return { decision: "DENY", reason: "git_push_compound_command_impact_unknown" };
  }
  if (/\s(?:--force(?:-with-lease)?|-f)(?:\s|$)/i.test(command)) {
    return {
      decision: "DENY",
      code: "ABSOLUTELY_PROHIBITED",
      reason: "git_push_force_update_not_supported",
      next_safe_action: "use_a_non_force_push_after_reconciling_the_remote_branch",
    };
  }

  const match = command.match(
    /^\s*git(?:\.exe)?\s+push\s+(?:(?:-u|--set-upstream)\s+)?origin\s+([A-Za-z0-9._/-]+)\s*$/i,
  );
  if (!match) {
    return { decision: "DENY", reason: "git_push_scope_cannot_be_bound_to_one_origin_branch" };
  }

  const cwd = resolveCommandCwd(input.projectRoot, input.args);
  if (!cwd) {
    return { decision: "DENY", reason: "git_push_cwd_outside_active_project" };
  }

  const subject: GitPushSubject = {
    actor: input.agentId,
    role: roleFromAgentId(input.agentId),
    project_id: input.projectId,
    agent_id: input.agentId,
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
    ...(input.taskId ? { task_id: input.taskId } : {}),
  };
  try {
    return {
      decision: "REQUIRE_APPROVAL",
      input: await buildGitPushApprovalInput({ cwd, branch: match[1]!, subject }),
    };
  } catch (error) {
    return {
      decision: "DENY",
      reason: `git_push_preflight_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
