export const RUNTIME_TASK_CONTROL_TOOL_NAMES = [
  "list_my_tasks",
  "read_my_task",
  "claim_task",
] as const;

export type RuntimeTaskControlToolName = (typeof RUNTIME_TASK_CONTROL_TOOL_NAMES)[number];
export type RuntimeTaskControlToolDefinition = {
  name: RuntimeTaskControlToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};

export const RUNTIME_TASK_CONTROL_TOOL_DEFINITIONS: readonly RuntimeTaskControlToolDefinition[] = [
  {
    name: "list_my_tasks",
    description: "List canonical inbox TASK files addressed to the current agent role, including dependency readiness.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_my_task",
    description: "Read one canonical TASK only when its recipient matches the current agent role.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "claim_task",
    description: "Atomically claim an assigned inbox TASK through LifecycleKernel and acquire the single execution lease. This normal recovery action does not require operation approval.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        idempotency_key: { type: "string" },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
] as const;

export function isRuntimeTaskControlTool(name: string): name is RuntimeTaskControlToolName {
  return (RUNTIME_TASK_CONTROL_TOOL_NAMES as readonly string[]).includes(name);
}

function roleFromAgentId(agentId: string): string {
  return agentId.trim().split(/[-.:_]/)[0]?.toUpperCase() ?? "";
}

export async function invokeRuntimeTaskControlTool(input: {
  toolName: RuntimeTaskControlToolName;
  args: Record<string, unknown>;
  agentId: string;
  sessionId: string;
  panelUrl?: string;
}): Promise<Record<string, unknown>> {
  const agentId = input.agentId.trim();
  const sessionId = input.sessionId.trim();
  const role = roleFromAgentId(agentId);
  if (!agentId || !sessionId || !["DEV", "QA", "OPS"].includes(role)) {
    return { ok: false, code: "EXECUTOR_IDENTITY_REQUIRED", error: "registered DEV/QA/OPS agent_id and session_id are required" };
  }
  const panelUrl = String(input.panelUrl ?? process.env["CODEFLOWMU_PANEL_URL"] ?? "").replace(/\/$/, "");
  if (!panelUrl) return { ok: false, code: "CONTROL_PLANE_UNAVAILABLE", error: "CODEFLOWMU_PANEL_URL is unavailable" };
  const taskId = String(input.args["task_id"] ?? "").trim();
  let method = "GET";
  let path = "/api/v2/runtime/tasks/my";
  let body: Record<string, unknown> | undefined;
  if (input.toolName === "read_my_task") {
    if (!taskId) return { ok: false, code: "TASK_ID_REQUIRED" };
    path = `/api/v2/runtime/tasks/${encodeURIComponent(taskId)}/my?agent_id=${encodeURIComponent(agentId)}&session_id=${encodeURIComponent(sessionId)}&role=${encodeURIComponent(role)}`;
  } else if (input.toolName === "claim_task") {
    if (!taskId) return { ok: false, code: "TASK_ID_REQUIRED" };
    method = "POST";
    path = `/api/v2/runtime/tasks/${encodeURIComponent(taskId)}/claim`;
    body = {
      agent_id: agentId,
      session_id: sessionId,
      role,
      idempotency_key: String(input.args["idempotency_key"] ?? "").trim() || undefined,
    };
  } else {
    path += `?agent_id=${encodeURIComponent(agentId)}&session_id=${encodeURIComponent(sessionId)}&role=${encodeURIComponent(role)}`;
  }
  try {
    const response = await fetch(`${panelUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    const result = text ? JSON.parse(text) as Record<string, unknown> : {};
    return { ...result, ok: typeof result["ok"] === "boolean" ? result["ok"] : response.ok, http_status: response.status };
  } catch (error) {
    return { ok: false, code: "CONTROL_PLANE_REQUEST_FAILED", error: error instanceof Error ? error.message : String(error) };
  }
}
