export const GOVERNANCE_ADMIN_TOOL_NAMES = [
  "admin.list_pending_approvals",
  "admin.get_approval_detail",
  "admin.approve_governance",
  "admin.reject_governance",
  "admin.request_governance_changes",
  "admin.revoke_governance",
] as const;

export type GovernanceAdminToolName =
  (typeof GOVERNANCE_ADMIN_TOOL_NAMES)[number];

export interface GovernanceAdminToolDefinition {
  name: GovernanceAdminToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

const stringProp = (description: string) => ({
  type: "string",
  description,
});

const decisionProperties = {
  governance_id: stringProp("治理记录 id"),
  revision: { type: "integer", minimum: 1 },
  approval_id: stringProp("待审批项 id"),
  reason: stringProp("ADMIN 决定理由"),
  conditions: {
    type: "array",
    items: { type: "string" },
    description: "可选批准条件",
  },
  source_ui_action_id: stringProp("正式审批组件生成的 UI action id"),
  idempotency_key: stringProp("跨 Desktop/PWA 的决定幂等键"),
} as const;

export const GOVERNANCE_ADMIN_TOOL_DEFINITIONS: readonly GovernanceAdminToolDefinition[] =
  [
    {
      name: "admin.list_pending_approvals",
      description: "列出当前项目待 ADMIN 审批的正式治理记录。",
      inputSchema: {
        type: "object",
        properties: {
          task_id: stringProp("可选目标 TASK id"),
          limit: { type: "integer", minimum: 1, maximum: 1000 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "admin.get_approval_detail",
      description: "读取治理正文、原始聊天证据引用、范围哈希和历史决定。",
      inputSchema: {
        type: "object",
        properties: {
          governance_id: stringProp("治理记录 id"),
          revision: { type: "integer", minimum: 1 },
        },
        required: ["governance_id", "revision"],
        additionalProperties: false,
      },
    },
    ...(
      [
        [
          "admin.approve_governance",
          "批准正式治理记录并原子建立 effective 投影。",
        ],
        [
          "admin.reject_governance",
          "驳回正式治理记录并保留不可变决定。",
        ],
        [
          "admin.request_governance_changes",
          "要求 PM 创建新 revision，不覆盖当前版本。",
        ],
      ] as const
    ).map(([name, description]) => ({
      name,
      description,
      inputSchema: {
        type: "object",
        properties: decisionProperties,
        required: [
          "governance_id",
          "revision",
          "approval_id",
          "reason",
          "source_ui_action_id",
          "idempotency_key",
        ],
        additionalProperties: false,
      },
    })),
    {
      name: "admin.revoke_governance",
      description: "撤销已生效治理记录并保留不可变撤销决定。",
      inputSchema: {
        type: "object",
        properties: {
          governance_id: stringProp("治理记录 id"),
          revision: { type: "integer", minimum: 1 },
          reason: stringProp("撤销理由"),
          source_ui_action_id: stringProp("正式审批组件生成的 UI action id"),
          idempotency_key: stringProp("撤销幂等键"),
        },
        required: [
          "governance_id",
          "revision",
          "reason",
          "source_ui_action_id",
          "idempotency_key",
        ],
        additionalProperties: false,
      },
    },
  ];

function requiredString(
  args: Record<string, unknown>,
  name: string,
): string {
  const value = String(args[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function invokeGovernanceAdminTool(input: {
  toolName: GovernanceAdminToolName;
  args: Record<string, unknown>;
  actor: string;
  panelUrl: string;
}): Promise<Record<string, unknown>> {
  if (input.actor.trim().toUpperCase() !== "ADMIN") {
    return {
      ok: false,
      code: "APPROVER_NOT_AUTHORIZED",
      error: "governance decisions are ADMIN-only",
    };
  }
  const panelUrl = input.panelUrl.replace(/\/$/, "");
  let method = "GET";
  let path = "";
  let body: Record<string, unknown> | undefined;
  const id = () => encodeURIComponent(requiredString(input.args, "governance_id"));
  const revision = () =>
    encodeURIComponent(requiredString(input.args, "revision"));
  switch (input.toolName) {
    case "admin.list_pending_approvals": {
      const params = new URLSearchParams({ status: "pending_approval" });
      const taskId = String(input.args["task_id"] ?? "").trim();
      const limit = String(input.args["limit"] ?? "").trim();
      if (taskId) params.set("task_id", taskId);
      if (limit) params.set("limit", limit);
      path = `/api/v2/governance/records?${params.toString()}`;
      break;
    }
    case "admin.get_approval_detail":
      path = `/api/v2/governance/records/${id()}/${revision()}`;
      break;
    case "admin.approve_governance":
    case "admin.reject_governance":
    case "admin.request_governance_changes": {
      method = "POST";
      path = `/api/v2/admin/governance/approvals/${id()}/${revision()}/decide`;
      const decisions = {
        "admin.approve_governance": "approved",
        "admin.reject_governance": "rejected",
        "admin.request_governance_changes": "changes_requested",
      } as const;
      body = {
        actor: "ADMIN",
        approval_id: requiredString(input.args, "approval_id"),
        decision: decisions[input.toolName],
        reason: requiredString(input.args, "reason"),
        conditions: Array.isArray(input.args["conditions"])
          ? input.args["conditions"]
          : [],
        source_ui_action_id: requiredString(
          input.args,
          "source_ui_action_id",
        ),
        idempotency_key: requiredString(input.args, "idempotency_key"),
      };
      break;
    }
    case "admin.revoke_governance":
      method = "POST";
      path = `/api/v2/admin/governance/approvals/${id()}/${revision()}/revoke`;
      body = {
        actor: "ADMIN",
        reason: requiredString(input.args, "reason"),
        source_ui_action_id: requiredString(
          input.args,
          "source_ui_action_id",
        ),
        idempotency_key: requiredString(input.args, "idempotency_key"),
      };
      break;
  }

  try {
    const response = await fetch(`${panelUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    const parsed = text
      ? (JSON.parse(text) as Record<string, unknown>)
      : {};
    return {
      ...parsed,
      ok: typeof parsed["ok"] === "boolean" ? parsed["ok"] : response.ok,
      http_status: response.status,
    };
  } catch (error) {
    return {
      ok: false,
      code: "GOVERNANCE_ADMIN_TOOL_FAILED",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
