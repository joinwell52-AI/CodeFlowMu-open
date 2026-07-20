import { basename, isAbsolute, relative, resolve } from "node:path";

import {
  buildGitPushApprovalInput,
  type GitPushSubject,
} from "./GitPushApproval.ts";
import type { PrepareOperationInput } from "./OperationApprovalService.ts";

export const OPERATION_APPROVAL_REQUIRED = "OPERATION_APPROVAL_REQUIRED";
export const OPERATION_BOUNDARY_DENIED = "OPERATION_BOUNDARY_DENIED";

export type NativeOperationBoundaryDecision =
  | { decision: "ALLOW" }
  | { decision: "DENY"; reason: string }
  | { decision: "REQUIRE_APPROVAL"; input: PrepareOperationInput };

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

function isGovernanceBoundarySource(target: string): boolean {
  if (!target || /(?:^|\/)__tests__(?:\/|$)|\.test\.[cm]?[jt]sx?$/.test(target)) return false;
  return [
    "/src/approval/",
    "/registry/roletoolpolicy.ts",
    "/session/sdkrunhandle.ts",
    "/native-operation-confirm.ts",
    "/git-operation-approval.ts",
  ].some((marker) => target.includes(marker));
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
}): Promise<NativeOperationBoundaryDecision> {
  const command = extractCommand(input.args);
  const target = extractTargetPath(input.args);
  const readOnly = isReadOnlyTool(input.toolName);
  const runtimeProtocolWrite = isRuntimeGovernanceWriteTool(input.toolName);
  const directMutation = isDirectMutationTool(input.toolName);

  if (isGovernanceBoundarySource(target) && !readOnly && !runtimeProtocolWrite) {
    return { decision: "DENY", reason: "governance_boundary_adapter_not_registered" };
  }
  if (isGovernanceStorageTarget(target)) {
    if (readOnly || runtimeProtocolWrite) return { decision: "ALLOW" };
    if (directMutation || command) {
      return { decision: "DENY", reason: "governance_storage_boundary_violation" };
    }
    return { decision: "DENY", reason: "governance_storage_boundary_unknown_tool" };
  }
  if (commandTargetsGovernanceStorage(command)) {
    if (isReadOnlyGovernanceShellCommand(command)) return { decision: "ALLOW" };
    return { decision: "DENY", reason: "governance_storage_boundary_violation" };
  }
  const unsupportedReason = command ? unsupportedHighRiskReason(command) : null;
  if (unsupportedReason) {
    return { decision: "DENY", reason: unsupportedReason };
  }
  if (!command || !/\bgit(?:\.exe)?\s+push\b/i.test(command)) {
    return { decision: "ALLOW" };
  }

  if (containsShellComposition(command)) {
    return { decision: "DENY", reason: "git_push_compound_command_impact_unknown" };
  }
  if (/\s(?:--force(?:-with-lease)?|-f)(?:\s|$)/i.test(command)) {
    return { decision: "DENY", reason: "git_push_force_update_not_supported" };
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
