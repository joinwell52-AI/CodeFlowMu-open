/** PM Agent 到 CodeFlowMu Runtime 控制面的原生工具适配。 */

export const PM_RUNTIME_CONTROL_TOOL_NAMES = [
  "pm.summarize_thread",
  "pm.detect_thread_stall",
  "pm.close_admin_task",
  "pm.wake_downstream",
  "pm.review_check",
  "pm.write_planning_artifact",
  "pm.record_planning_skill_evidence",
  "pm.inspect_task_spec",
  "pm.inspect_capability_matrix",
  "pm.inspect_project_baseline",
  "pm.inspect_runtime_topology",
  "pm.create_child_task",
  "pm.request_operation_approval",
  "pm.capture_evidence",
  "software.inventory",
  "software.search",
  "software.request_install",
  "software.verify_package",
  "software.install",
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
      required: ["body_markdown"],
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
  {
    name: "pm.inspect_task_spec",
    description: "在正式投递前运行 TaskSpecAdmission 2.0，返回四态决策和逐条修改建议。",
    inputSchema: {
      type: "object",
      properties: {
        task_id: stringProp("可选预览 task_id"),
        subject: stringProp("任务标题"),
        body_markdown: stringProp("任务书 Markdown 正文"),
        priority: stringProp("P0/P1/P2/P3"),
        parent: stringProp("可选父 task_id"),
        thread_key: stringProp("可选 thread_key"),
      },
      required: ["subject", "body_markdown"],
      additionalProperties: false,
    },
  },
  {
    name: "pm.inspect_capability_matrix",
    description: "输出任务步骤、执行角色、所需能力、可用工具、当前策略、风险和修正建议。",
    inputSchema: {
      type: "object",
      properties: {
        task_id: stringProp("可选预览 task_id"),
        subject: stringProp("任务标题"),
        body_markdown: stringProp("任务书 Markdown 正文"),
        priority: stringProp("P0/P1/P2/P3"),
        parent: stringProp("可选父 task_id"),
        thread_key: stringProp("可选 thread_key"),
      },
      required: ["subject", "body_markdown"],
      additionalProperties: false,
    },
  },
  {
    name: "pm.inspect_project_baseline",
    description: "安全读取项目根、分支、HEAD、工作树分类、版本和依赖状态。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "pm.inspect_runtime_topology",
    description: "读取 Panel 端口、进程、活动实例、Gateway、Data Root、Registry 与隔离状态。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "pm.create_child_task",
    description: "通过正式 FCoP writer 创建 PM 子任务，支持 parent、thread_key、depends_on、priority 与验收人。",
    inputSchema: {
      type: "object",
      properties: {
        recipient: { type: "string", enum: ["DEV", "QA", "OPS"] },
        subject: stringProp("子任务标题"),
        body_markdown: stringProp("子任务正文"),
        parent: stringProp("父 task_id"),
        thread_key: stringProp("主线 thread_key"),
        priority: stringProp("P0/P1/P2/P3"),
        depends_on: { type: "array", items: { type: "string" } },
        acceptor: stringProp("验收角色"),
      },
      required: ["recipient", "subject", "body_markdown", "parent", "thread_key", "acceptor"],
      additionalProperties: false,
    },
  },
  {
    name: "pm.request_operation_approval",
    description: "主动提交后果驱动的操作审批，返回 operation_digest 与审批单。",
    inputSchema: {
      type: "object",
      properties: {
        task_id: stringProp("关联 task_id"),
        operation_type: stringProp("操作类型"),
        targets: { type: "array", items: { type: "string" }, minItems: 1 },
        reason: stringProp("操作原因"),
        expected_benefit: stringProp("预期收益"),
        risk: stringProp("风险分类"),
        preview_manifest: { type: "object" },
        rollback_plan: stringProp("回滚方案"),
        expires_at: stringProp("可选失效时间"),
        operation_digest: stringProp("可选调用方预计算摘要，仅用于对照"),
      },
      required: ["task_id", "operation_type", "targets", "reason", "expected_benefit", "risk", "rollback_plan"],
      additionalProperties: false,
    },
  },
  {
    name: "pm.capture_evidence",
    description: "记录命令摘要、日志、截图、SHA、时间戳和环境身份，不执行被记录的命令。",
    inputSchema: {
      type: "object",
      properties: {
        task_id: stringProp("关联 task_id"),
        evidence_type: stringProp("command/log/screenshot/sha/environment"),
        summary: stringProp("证据摘要"),
        source: stringProp("证据来源路径、命令或 URL"),
        sha256: stringProp("可选 SHA-256"),
        captured_at: stringProp("可选 ISO 时间；默认由 Runtime 生成"),
        environment_id: stringProp("环境身份"),
        metadata: { type: "object" },
      },
      required: ["task_id", "evidence_type", "summary", "source"],
      additionalProperties: false,
    },
  },
  {
    name: "software.inventory",
    description: "只读列出 Runtime、常用 Windows 应用和软件治理执行器状态。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "software.search",
    description: "只读搜索本机清单和受管软件源；不下载、不安装。",
    inputSchema: {
      type: "object",
      properties: { query: stringProp("软件名称或精确包 id") },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "software.verify_package",
    description: "校验精确本地包的大小和 SHA-256，或核对受管包的来源、版本和签名声明。",
    inputSchema: {
      type: "object",
      properties: {
        package_id: stringProp("包 id"),
        package_path: stringProp("可选的精确本地文件路径"),
        source: stringProp("来源"),
        version: stringProp("版本"),
        signature: stringProp("签名或签名状态"),
        sha256: stringProp("期望 SHA-256"),
      },
      required: ["package_id", "source", "version"],
      additionalProperties: false,
    },
  },
  {
    name: "software.request_install",
    description: "提交软件安装审批；只生成精确预览和审批，不执行安装。",
    inputSchema: {
      type: "object",
      properties: {
        task_id: stringProp("关联 task_id"),
        package_id: stringProp("受管软件源中的精确包 id"),
        source: stringProp("当前仅支持 winget"),
        version: stringProp("精确版本"),
        signature: stringProp("签名或签名状态"),
        sha256: stringProp("可选 SHA-256"),
        install_directory: stringProp("安装目录"),
        permissions: { type: "array", items: { type: "string" }, minItems: 1 },
        rollback_plan: stringProp("回滚方法"),
        expected_benefit: stringProp("预期收益"),
        risk: stringProp("风险说明"),
        installer_role: { type: "string", enum: ["OPS"] },
      },
      required: [
        "task_id",
        "package_id",
        "source",
        "version",
        "install_directory",
        "permissions",
        "rollback_plan",
        "installer_role",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "software.install",
    description: "执行已获批且摘要匹配的软件安装；仅 OPS，可用审批令牌只能使用一次。",
    inputSchema: {
      type: "object",
      properties: {
        approval_id: stringProp("已批准的软件安装 approval_id"),
        execution_token: stringProp("一次性 execution_token"),
      },
      required: ["approval_id", "execution_token"],
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
  currentTaskId?: string;
  panelUrl?: string;
}): Promise<Record<string, unknown>> {
  const agentId = String(input.agentId ?? "PM-01").trim();
  const softwareInstall = input.toolName === "software.install";
  if (
    (!softwareInstall && !/^PM(?:[-.]|$)/i.test(agentId)) ||
    (softwareInstall && !/^OPS(?:[-.]|$)/i.test(agentId))
  ) {
    return {
      ok: false,
      outcome: "error",
      error: softwareInstall
        ? "software.install is OPS-only"
        : "PM runtime tools are PM-only",
    };
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
        task_id:
          optionalString(input.args, "task_id") ||
          String(input.currentTaskId ?? "").trim(),
        current_task_id: String(input.currentTaskId ?? "").trim(),
        agent_id: agentId,
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
        task_id:
          optionalString(input.args, "task_id") ||
          String(input.currentTaskId ?? "").trim(),
        current_task_id: String(input.currentTaskId ?? "").trim(),
        agent_id: agentId,
        body_markdown: requiredString(input.args, "body_markdown"),
        status: optionalString(input.args, "status") || "ready",
        thread_key: optionalString(input.args, "thread_key") || undefined,
        caller_role: agentId,
        session_id: input.sessionId,
      };
      break;
    case "pm.inspect_task_spec":
    case "pm.inspect_capability_matrix":
      method = "POST";
      path = "/api/v2/pm/tools/inspect-task-spec";
      body = {
        ...input.args,
        view:
          input.toolName === "pm.inspect_capability_matrix"
            ? "capability_matrix"
            : "full",
        current_task_id: input.currentTaskId,
        caller_role: agentId,
        session_id: input.sessionId,
      };
      break;
    case "pm.inspect_project_baseline":
      path = "/api/v2/pm/tools/project-baseline";
      break;
    case "pm.inspect_runtime_topology":
      path = "/api/v2/pm/tools/runtime-topology";
      break;
    case "pm.create_child_task":
      method = "POST";
      path = "/api/v2/pm/tools/create-child-task";
      body = {
        ...input.args,
        sender: "PM",
        current_task_id: input.currentTaskId,
        caller_role: agentId,
        session_id: input.sessionId,
      };
      break;
    case "pm.request_operation_approval":
      method = "POST";
      path = "/api/v2/pm/tools/request-operation-approval";
      body = {
        ...input.args,
        actor: agentId,
        session_id: input.sessionId,
        current_task_id: input.currentTaskId,
      };
      break;
    case "pm.capture_evidence":
      method = "POST";
      path = "/api/v2/pm/tools/capture-evidence";
      body = {
        ...input.args,
        actor: agentId,
        session_id: input.sessionId,
        current_task_id: input.currentTaskId,
      };
      break;
    case "software.inventory":
      path = "/api/v2/software/inventory";
      break;
    case "software.search":
      path = withQuery("/api/v2/software/search", {
        query: requiredString(input.args, "query"),
      });
      break;
    case "software.verify_package":
      method = "POST";
      path = "/api/v2/software/verify-package";
      body = { ...input.args, actor: agentId, session_id: input.sessionId };
      break;
    case "software.request_install":
      method = "POST";
      path = "/api/v2/software/request-install";
      body = {
        ...input.args,
        actor: agentId,
        session_id: input.sessionId,
        current_task_id: input.currentTaskId,
      };
      break;
    case "software.install":
      method = "POST";
      path = "/api/v2/software/install";
      body = {
        ...input.args,
        actor: agentId,
        actor_role: "OPS",
        session_id: input.sessionId,
        current_task_id: input.currentTaskId,
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
      ...(!response.ok
        ? {
            error_code:
              String(runtimeResult["code"] ?? parsed["code"] ?? "") ||
              "PLANNING_RUNTIME_REQUEST_FAILED",
            recovery:
              "确认 PM Runtime 会话仍在运行且绑定当前根任务后重试；无需手工传 session_id 或 caller_role。",
          }
        : {}),
    };
  } catch (error) {
    return {
      ok: false,
      outcome: "error",
      error: error instanceof Error ? error.message : String(error),
      error_code: "PLANNING_RUNTIME_UNAVAILABLE",
      recovery: "确认 CodeFlowMu Panel Runtime 已启动后重试。",
    };
  }
}
