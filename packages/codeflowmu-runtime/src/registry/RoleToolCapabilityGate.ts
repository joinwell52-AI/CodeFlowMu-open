import { canonicalToolId } from "../approval/OperationFacts.ts";

export type RoleToolCapabilityDecision =
  | { decision: "TOOL_ALLOWED"; canonical_tool_id: string }
  | { decision: "ROLE_CAPABILITY_DENIED"; canonical_tool_id: string; reason: string };

const SDK_TOOL_IDS = new Set([
  "read", "read_file", "grep", "grep_files", "glob", "list", "list_files",
  "read_text_file", "list_dir", "list_directory", "search", "find", "shell", "terminal", "run", "execute",
  "write", "write_file", "edit", "edit_file", "create_file", "create_directory",
  "delete", "delete_file", "remove", "remove_file", "move", "move_file",
  "copy", "apply_patch", "patch", "filesystem.cleanup", "cleanup",
]);

const FCOP_READ = [
  "read_task", "read_report", "list_tasks", "list_reports", "list_issues",
  "fcop_report", "fcop_check", "fcop_audit", "get_team_status", "inspect_task",
] as const;
const FCOP_EXECUTOR = ["write_report", "write_issue", "drop_suggestion", "submit_task", "claim_task"] as const;
const FCOP_DISPATCH = ["write_task", "create_task"] as const;
const FCOP_GOVERNANCE = ["approve_task", "reject_task", "archive_task", "finish_task"] as const;
const FCOP_REVIEW = ["write_review", "submit_review", "review_task", "approve_review", "reject_review", "mark_human_approved"] as const;
const PM_RUNTIME = [
  "pm.summarize_thread", "pm.detect_thread_stall", "pm.close_admin_task",
  "pm.wake_downstream", "pm.review_check", "pm.write_planning_artifact",
  "pm.record_planning_skill_evidence", "pm.inspect_task_spec",
  "pm.inspect_capability_matrix", "pm.inspect_project_baseline",
  "pm.inspect_runtime_topology", "pm.create_child_task",
  "pm.request_operation_approval", "pm.capture_evidence", "software.inventory",
  "software.search", "software.request_install", "software.verify_package",
] as const;

function setOf(...groups: readonly (readonly string[])[]): ReadonlySet<string> {
  return new Set(groups.flatMap((group) => [...group]));
}

const FORMAL_TOOLS_BY_ROLE: Record<string, ReadonlySet<string>> = {
  PM: setOf(FCOP_READ, FCOP_EXECUTOR, FCOP_DISPATCH, PM_RUNTIME),
  DEV: setOf(FCOP_READ, FCOP_EXECUTOR),
  OPS: setOf(FCOP_READ, FCOP_EXECUTOR, ["software.install"]),
  QA: setOf(FCOP_READ, FCOP_EXECUTOR, FCOP_REVIEW),
  REVIEW: setOf(FCOP_READ, FCOP_EXECUTOR, FCOP_REVIEW),
  EVAL: setOf(FCOP_READ, ["write_issue", "write_report", "write_task"]),
  ADMIN: setOf(FCOP_READ, FCOP_EXECUTOR, FCOP_DISPATCH, FCOP_GOVERNANCE, FCOP_REVIEW),
  ME: setOf(FCOP_READ, FCOP_EXECUTOR, FCOP_DISPATCH, FCOP_GOVERNANCE, FCOP_REVIEW, PM_RUNTIME),
};

function formalToolId(id: string): string {
  return id.startsWith("mcp.fcop.")
    ? id.slice("mcp.fcop.".length)
    : id.startsWith("mcp.fcop_mcp.")
      ? id.slice("mcp.fcop_mcp.".length)
      : id;
}

function callToolId(toolName: string, args: Record<string, unknown>): string {
  const base = canonicalToolId(toolName);
  if (base !== "mcp") return base;
  const provider = String(args["providerIdentifier"] ?? args["provider"] ?? "").trim().toLowerCase();
  const name = String(args["toolName"] ?? args["tool_name"] ?? "").trim().toLowerCase();
  return provider && name ? `mcp.${provider}.${name}` : base;
}

/** Exact role/tool capability gate.  It does not inspect command text or effects. */
export function evaluateRoleToolCapability(input: {
  role: string;
  toolName: string;
  args?: Record<string, unknown>;
  activeCapabilities?: Iterable<string>;
}): RoleToolCapabilityDecision {
  const role = input.role.trim().toUpperCase();
  const id = callToolId(input.toolName, input.args ?? {});
  const formal = formalToolId(id);
  const active = input.activeCapabilities == null
    ? null
    : new Set([...input.activeCapabilities].flatMap((value) => {
        const canonical = canonicalToolId(value);
        return [canonical, formalToolId(canonical)];
      }));
  if (active && !active.has(id) && !active.has(formal) && !active.has(canonicalToolId(input.toolName))) {
    return { decision: "ROLE_CAPABILITY_DENIED", canonical_tool_id: id, reason: "exact canonical tool capability or active lease is missing" };
  }
  const formalCatalog = FORMAL_TOOLS_BY_ROLE[role] ?? new Set<string>();
  if (formalCatalog.has(formal)) {
    return { decision: "TOOL_ALLOWED", canonical_tool_id: id };
  }
  if (SDK_TOOL_IDS.has(id) && (role !== "EVAL" || /^(?:read|read_file|read_text_file|grep|grep_files|glob|list|list_files|list_dir|list_directory|search|find)$/.test(id))) {
    return { decision: "TOOL_ALLOWED", canonical_tool_id: id };
  }
  if (id.startsWith("mcp.") && active?.has(id)) return { decision: "TOOL_ALLOWED", canonical_tool_id: id };
  return { decision: "ROLE_CAPABILITY_DENIED", canonical_tool_id: id, reason: "canonical tool id is not registered for this role" };
}
