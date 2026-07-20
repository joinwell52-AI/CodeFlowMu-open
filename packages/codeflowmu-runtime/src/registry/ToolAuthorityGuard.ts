import {
  OBSERVER_TOOLS,
  roleCodeFromAgentId,
} from "../skill/FcopToolProfile.ts";
const VISION_INSPECT_ATTACHMENT_TOOL = "vision_inspect_attachment" as const;

/** Agent tool runtime 运行时角色（P0 最小集，见设计文档 §19）。 */
export type ToolGuardRole =
  | "PM"
  | "DEV"
  | "OPS"
  | "QA"
  | "ADMIN"
  | "REVIEW"
  | "EVAL"
  | "UNKNOWN";

export type ToolAuthorityError = {
  code: "AUTHORITY_DENIED";
  message: string;
  role: ToolGuardRole;
  toolName: string;
};

export type ToolAuthorityCheckInput = {
  agentId: string;
  toolName: string;
  args?: Record<string, unknown>;
};

const EVAL_WRITE_TASK_RECIPIENTS = new Set(["PM", "ADMIN"]);

export type ToolAuthorityCheckResult =
  | { allowed: true }
  | { allowed: false; error: ToolAuthorityError };

const LEADER_ROLE_CODES = new Set(["PM", "PLANNER", "PUBLISHER", "MARKETER"]);

const WORKSPACE_READ = [
  "read_file",
  "grep_files",
  "list_dir",
  "web_search",
  "web_extract",
  "web_research",
  "skill_search",
  "skill_learn",
] as const;
const WORKSPACE_WRITE = ["write_file", "skill_publish"] as const;

const FCOP_READ = [
  "read_task",
  "read_report",
  "list_tasks",
  "list_reports",
  "list_issues",
  "fcop_report",
  "fcop_check",
  "fcop_audit",
  "get_team_status",
  "inspect_task",
] as const;

const FCOP_EXECUTOR = [
  "write_report",
  "write_issue",
  "drop_suggestion",
  "submit_task",
  "claim_task",
] as const;

const VISION_TOOLS = [VISION_INSPECT_ATTACHMENT_TOOL] as const;

const FCOP_DISPATCH = ["write_task", "create_task"] as const;

const FCOP_GOVERNANCE = [
  "approve_task",
  "reject_task",
  "archive_task",
  "finish_task",
] as const;

const FCOP_REVIEW = ["write_review"] as const;

const GOVERNANCE_TOOL_SET = new Set<string>([
  ...FCOP_GOVERNANCE,
  ...FCOP_DISPATCH,
]);

function uniqueTools(...groups: readonly (readonly string[])[]): Set<string> {
  const out = new Set<string>();
  for (const group of groups) {
    for (const name of group) out.add(name);
  }
  return out;
}

const DEV_OPS_ALLOW = uniqueTools(
  FCOP_READ,
  FCOP_EXECUTOR,
  WORKSPACE_READ,
  VISION_TOOLS,
  ["read_task"],
);

const QA_ALLOW = uniqueTools(
  FCOP_READ,
  FCOP_EXECUTOR,
  FCOP_REVIEW,
  WORKSPACE_READ,
  VISION_TOOLS,
  ["read_task", "read_report"],
);

const PM_ALLOW = uniqueTools(
  FCOP_READ,
  FCOP_EXECUTOR,
  FCOP_DISPATCH,
  WORKSPACE_READ,
  WORKSPACE_WRITE,
  VISION_TOOLS,
  [
    "submit_task",
    "pm.summarize_thread",
    "pm.detect_thread_stall",
    "pm.close_admin_task",
    "pm.wake_downstream",
    "pm.review_check",
    "pm.write_planning_artifact",
    "pm.record_planning_skill_evidence",
  ],
);

const ADMIN_ALLOW = uniqueTools(
  FCOP_READ,
  FCOP_EXECUTOR,
  FCOP_GOVERNANCE,
  FCOP_DISPATCH,
  WORKSPACE_READ,
  VISION_TOOLS,
);

const REVIEW_ALLOW = uniqueTools(
  FCOP_READ,
  FCOP_REVIEW,
  FCOP_EXECUTOR,
  WORKSPACE_READ,
  VISION_TOOLS,
  ["read_task", "read_report"],
);

const EVAL_ALLOW = uniqueTools(
  OBSERVER_TOOLS,
  WORKSPACE_READ,
  VISION_TOOLS,
);

export function resolveRoleFromAgentId(agentId: string): ToolGuardRole {
  const code = roleCodeFromAgentId(agentId).toUpperCase();
  if (code === "ADMIN") return "ADMIN";
  if (LEADER_ROLE_CODES.has(code)) return "PM";
  if (code === "DEV") return "DEV";
  if (code === "OPS") return "OPS";
  if (code === "QA") return "QA";
  if (code === "REVIEW") return "REVIEW";
  if (code === "EVAL") return "EVAL";
  return "UNKNOWN";
}

export function allowedToolsForRole(role: ToolGuardRole): Set<string> {
  switch (role) {
    case "PM":
      return PM_ALLOW;
    case "DEV":
    case "OPS":
      return DEV_OPS_ALLOW;
    case "QA":
      return QA_ALLOW;
    case "ADMIN":
      return ADMIN_ALLOW;
    case "REVIEW":
      return REVIEW_ALLOW;
    case "EVAL":
      return EVAL_ALLOW;
    case "UNKNOWN":
      return uniqueTools(FCOP_READ, FCOP_EXECUTOR, WORKSPACE_READ, VISION_TOOLS);
    default:
      return new Set<string>();
  }
}

export function isGovernanceTool(toolName: string): boolean {
  return GOVERNANCE_TOOL_SET.has(toolName);
}

function normalizeWriteTaskRecipient(raw: unknown): string {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  const upper = value.toUpperCase();
  const direct = upper.split(/[.\s]/)[0] ?? "";
  return direct;
}

export function checkEvalWriteTaskRecipient(
  input: ToolAuthorityCheckInput,
): ToolAuthorityCheckResult {
  const toolName = String(input.toolName ?? "").trim();
  if (toolName !== "write_task" && toolName !== "create_task") {
    return { allowed: true };
  }
  const role = resolveRoleFromAgentId(input.agentId);
  if (role !== "EVAL") {
    return { allowed: true };
  }
  const recipient = normalizeWriteTaskRecipient(input.args?.recipient);
  if (!EVAL_WRITE_TASK_RECIPIENTS.has(recipient)) {
    return {
      allowed: false,
      error: {
        code: "AUTHORITY_DENIED",
        message: `EVAL 的 ${toolName} 仅允许 recipient 为 PM 或 ADMIN，收到: ${recipient || "(empty)"}`,
        role: "EVAL",
        toolName,
      },
    };
  }
  return { allowed: true };
}

export function checkToolAuthority(
  input: ToolAuthorityCheckInput,
): ToolAuthorityCheckResult {
  const toolName = String(input.toolName ?? "").trim();
  if (!toolName) {
    return {
      allowed: false,
      error: {
        code: "AUTHORITY_DENIED",
        message: "工具名为空，拒绝执行",
        role: "UNKNOWN",
        toolName,
      },
    };
  }

  const role = resolveRoleFromAgentId(input.agentId);
  const allow = allowedToolsForRole(role);

  if (allow.has(toolName)) {
    const recipientCheck = checkEvalWriteTaskRecipient(input);
    if (!recipientCheck.allowed) {
      return recipientCheck;
    }
    return { allowed: true };
  }

  return {
    allowed: false,
    error: {
      code: "AUTHORITY_DENIED",
      message: `角色 ${role} 无权调用工具 ${toolName}`,
      role,
      toolName,
    },
  };
}

export function formatAuthorityDeniedPayload(
  error: ToolAuthorityError,
): string {
  return JSON.stringify({ ok: false, error });
}
