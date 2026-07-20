/** PM Agent 到 CodeFlowMu Runtime 控制面的原生工具适配。 */

export const PM_RUNTIME_CONTROL_TOOL_NAMES = [
  "pm.summarize_thread",
  "pm.detect_thread_stall",
  "pm.close_admin_task",
  "pm.wake_downstream",
  "pm.review_check",
  "pm.write_planning_artifact",
  "pm.record_planning_skill_evidence",
] as const;

export type PmRuntimeControlToolName =
  (typeof PM_RUNTIME_CONTROL_TOOL_NAMES)[number];

export type PmRuntimeControlToolDefinition = {
  name: PmRuntimeControlToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};

const stringProp = (description: string) => ({ type: "string", description });

export const PM_RUNTIME_CONTROL_TOOL_DEFINITIONS: readonly PmRuntimeControlToolDefinition[] = [
  {
    name: "pm.summarize_thread",
    description: "通过 Runtime 汇总 FCoP thread 的任务、报告与待处理状态。",
    inputSchema: {
      type: "object",
      properties: { thread_key: stringProp("FCoP thread_key") },
      required: ["thread_key"],
      additionalProperties: false,
    },
  },
  {
    name: "pm.detect_thread_stall",
    description: "通过 Runtime 检测 PM thread 的下游卡顿与缺失回执。",
    inputSchema: {
      type: "object",
      properties: { thread_key: stringProp("FCoP thread_key") },
      required: ["thread_key"],
      additionalProperties: false,
    },
  },
  {
    name: "pm.close_admin_task",
    description: "通过 Runtime 生成 ADMIN 主线关单草稿；不直接归档。",
    inputSchema: {
      type: "object",
      properties: {
        thread_key: stringProp("thread_key，与 task_id 二选一"),
        task_id: stringProp("ADMIN→PM 主任务 id，与 thread_key 二选一"),
      },
      additionalProperties: false,
    },
  },
  {
    name: "pm.wake_downstream",
    description:
      "通过 Runtime 唤醒既有 PM→DEV/OPS/QA 子任务；复用 Panel、Planner 与 AutoNudge 的同一 wake executor，不新增 TASK/REPORT。",
    inputSchema: {
      type: "object",
      properties: {
        task_id: stringProp("待唤醒的既有 PM 下游子任务 id"),
        role: {
          type: "string",
          enum: ["DEV", "OPS", "QA"],
          description: "下游角色",
        },
        reason: stringProp("唤醒原因，默认 pm_agent_nudge"),
        thread_key: stringProp("FCoP thread_key"),
        agent_id: stringProp("可选的目标 Agent id"),
      },
      required: ["task_id", "role"],
      additionalProperties: false,
    },
  },
  {
    name: "pm.write_planning_artifact",
    description:
      "通过 Runtime 在主任务唯一合法路径写入 PLAN/Product Brief。禁止使用 shell、Python 或手工 frontmatter 写规划产物。",
    inputSchema: {
      type: "object",
      properties: {
        task_id: stringProp("ADMIN→PM 主任务 id"),
        body_markdown: stringProp("完整规划正文；只传 Markdown 正文，不得包含 YAML frontmatter"),
        status: {
          type: "string",
          enum: ["draft", "ready"],
          description: "规划状态；章节完整后使用 ready",
        },
        thread_key: stringProp("可选 FCoP thread_key，用于定位主任务"),
      },
      required: ["task_id", "body_markdown"],
      additionalProperties: false,
    },
  },
  {
    name: "pm.record_planning_skill_evidence",
    description:
      "提交一次真实 PM 规划技能执行证据。auto_inject、手工 JSONL 和缺少 Session/方案映射的记录不能解锁派单。",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: stringProp("本次实际执行的 PM/UI Playbook skill id"),
        task_id: stringProp("ADMIN→PM 主任务 id"),
        thread_key: stringProp("可选 FCoP thread_key"),
        input_context: stringProp("本次技能使用的任务上下文与约束"),
        output_summary: stringProp("应用技能后得到的具体输出摘要"),
        brief_section: stringProp("写入 Product Brief/PLAN 的对应章节标题"),
        product_decisions: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "本技能实际影响的产品决策",
        },
      },
      required: [
        "skill_id",
        "task_id",
        "input_context",
        "output_summary",
        "brief_section",
        "product_decisions",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "pm.review_check",
    description: "通过 Runtime 检查下游 REPORT 是否满足 PM 验收条件。",
    inputSchema: {
      type: "object",
      properties: {
        task_id: stringProp("关联 TASK id，与 report_id 至少一个"),
        report_id: stringProp("REPORT id，与 task_id 至少一个"),
      },
      additionalProperties: false,
    },
  },
] as const;

export function isPmRuntimeControlTool(
  name: string,
): name is PmRuntimeControlToolName {
  return (PM_RUNTIME_CONTROL_TOOL_NAMES as readonly string[]).includes(name);
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = String(args[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalString(args: Record<string, unknown>, name: string): string {
  return String(args[name] ?? "").trim();
}

function withQuery(path: string, query: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value) params.set(key, value);
  }
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

export async function invokePmRuntimeControlTool(input: {
  toolName: PmRuntimeControlToolName;
  args: Record<string, unknown>;
  agentId?: string;
  sessionId?: string;
  panelUrl?: string;
}): Promise<Record<string, unknown>> {
  const agentId = String(input.agentId ?? "PM-01").trim();
  if (!/^PM(?:[-.]|$)/i.test(agentId)) {
    return { ok: false, outcome: "error", error: "PM runtime tools are PM-only" };
  }
  const panelUrl = String(
    input.panelUrl ?? process.env["CODEFLOWMU_PANEL_URL"] ?? "",
  ).replace(/\/$/, "");
  if (!panelUrl) {
    return {
      ok: false,
      outcome: "error",
      error: "CODEFLOWMU_PANEL_URL is unavailable; Runtime control plane is not ready",
    };
  }

  let method = "GET";
  let path = "";
  let body: Record<string, unknown> | undefined;
  switch (input.toolName) {
    case "pm.summarize_thread":
      path = `/api/v2/pm/governance/thread/${encodeURIComponent(requiredString(input.args, "thread_key"))}/summary`;
      break;
    case "pm.detect_thread_stall":
      path = `/api/v2/pm/governance/thread/${encodeURIComponent(requiredString(input.args, "thread_key"))}/stall`;
      break;
    case "pm.close_admin_task":
      path = withQuery("/api/v2/pm/governance/close-draft", {
        thread_key: optionalString(input.args, "thread_key"),
        task_id: optionalString(input.args, "task_id"),
        current_task_id: optionalString(input.args, "current_task_id"),
      });
      break;
    case "pm.review_check":
      path = withQuery("/api/v2/pm/governance/review-check", {
        task_id: optionalString(input.args, "task_id"),
        report_id: optionalString(input.args, "report_id"),
      });
      break;
    case "pm.wake_downstream":
      method = "POST";
      path = "/api/v2/pm/governance/wake-downstream";
      body = {
        task_id: requiredString(input.args, "task_id"),
        role: requiredString(input.args, "role").toUpperCase(),
        reason: optionalString(input.args, "reason") || "pm_agent_nudge",
        thread_key: optionalString(input.args, "thread_key") || undefined,
        agent_id: optionalString(input.args, "agent_id") || undefined,
        current_task_id: optionalString(input.args, "current_task_id") || undefined,
        caller: agentId,
        source: "pm_agent_tool",
        caller_session_id: input.sessionId,
      };
      break;
    case "pm.record_planning_skill_evidence":
      method = "POST";
      path = "/api/v2/pm/governance/planning-skill-evidence";
      body = {
        skill_id: requiredString(input.args, "skill_id"),
        task_id: requiredString(input.args, "task_id"),
        thread_key: optionalString(input.args, "thread_key") || undefined,
        input_context: requiredString(input.args, "input_context"),
        output_summary: requiredString(input.args, "output_summary"),
        brief_section: requiredString(input.args, "brief_section"),
        product_decisions: Array.isArray(input.args["product_decisions"])
          ? input.args["product_decisions"]
          : [],
        caller_role: agentId,
        session_id: input.sessionId,
      };
      break;
    case "pm.write_planning_artifact":
      method = "POST";
      path = "/api/v2/pm/governance/planning-artifact";
      body = {
        task_id: requiredString(input.args, "task_id"),
        body_markdown: requiredString(input.args, "body_markdown"),
        status: optionalString(input.args, "status") || "ready",
        thread_key: optionalString(input.args, "thread_key") || undefined,
        caller_role: agentId,
        session_id: input.sessionId,
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
    let parsed: Record<string, unknown>;
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = { detail: text };
    }
    const runtimeResult =
      input.toolName === "pm.wake_downstream" &&
      parsed["result"] &&
      typeof parsed["result"] === "object"
        ? (parsed["result"] as Record<string, unknown>)
        : parsed;
    return {
      ...parsed,
      ...runtimeResult,
      ok:
        typeof runtimeResult["ok"] === "boolean"
          ? runtimeResult["ok"]
          : response.ok,
      outcome:
        runtimeResult["outcome"] ??
        (runtimeResult["delayed"]
          ? "delayed"
          : runtimeResult["skipped"]
            ? "skipped"
            : response.ok
              ? "ok"
              : "error"),
      http_status: response.status,
    };
  } catch (error) {
    return {
      ok: false,
      outcome: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
