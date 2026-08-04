/** PM Agent 到 CodeFlowMu Runtime 控制面的原生工具适配。 */

export const PM_RUNTIME_CONTROL_TOOL_NAMES = [
  "pm.summarize_thread",
  "pm.detect_thread_stall",
  "pm.close_admin_task",
  "pm.wake_downstream",
  "pm.redispatch_task",
  "pm.review_check",
  "pm.validate_long_horizon_plan",
  "pm.write_planning_artifact",
  "pm.record_planning_skill_evidence",
  "pm.inspect_task_spec",
  "pm.inspect_capability_matrix",
  "pm.inspect_project_baseline",
  "pm.inspect_runtime_topology",
  "pm.create_child_task",
  "pm.request_operation_approval",
  "pm.write_governance_record",
  "pm.revise_governance_record",
  "pm.submit_governance_for_approval",
  "pm.list_governance_records",
  "pm.get_governance_record",
  "pm.request_authorization",
  "pm.reference_effective_governance",
  "pm.capture_evidence",
  "workspace.scratch.create",
  "workspace.scratch.write",
  "workspace.scratch.read",
  "workspace.scratch.list",
  "workspace.scratch.cleanup",
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
const stringArrayProp = (description: string) => ({
  type: "array",
  items: { type: "string" },
  description,
});

const governanceRecordProperties = {
  type: {
    type: "string",
    enum: [
      "DIRECTIVE",
      "AUTHORIZATION",
      "DECISION",
      "AMENDMENT",
      "APPROVAL_REQUEST",
      "REVOCATION",
      "SUPERSEDE",
    ],
  },
  recipient: stringProp("治理记录接收角色"),
  target_task_id: stringProp("当前项目中已存在的目标 TASK id"),
  thread_key: stringProp("目标 TASK 所属 thread_key"),
  project_id: stringProp("当前项目 id"),
  source_kind: {
    type: "string",
    enum: ["admin_chat", "pm_request", "legacy"],
  },
  source_message_id: stringProp("ADMIN 聊天证据 message id"),
  source_session_id: stringProp("ADMIN 聊天证据 session id"),
  intent_summary: stringProp("PM 对原始意图的准确复述"),
  boundary_summary: stringProp("授权或指令边界"),
  allowed_actions: stringArrayProp("明确允许的动作"),
  prohibited_actions: stringArrayProp("明确禁止的动作"),
  targets: stringArrayProp("目标资源"),
  effective_conditions: stringArrayProp("生效条件"),
  expires_at: stringProp("可选 ISO 失效时间"),
  usage_limit: { type: "integer", minimum: 1 },
  retry_semantics: {
    type: "string",
    enum: ["never", "if_no_side_effect", "explicit_new_approval"],
  },
  risk_and_rollback: stringProp("风险和回滚方案"),
  revocation_conditions: stringArrayProp("撤销条件"),
  evidence_requirements: stringArrayProp("执行证据要求"),
  references: stringArrayProp("关联证据"),
  supersedes: stringProp("被替代的治理记录 id"),
  blocks_task: { type: "boolean" },
  idempotency_key: stringProp("幂等键"),
} as const;

const governanceRecordRequired = [
  "type",
  "recipient",
  "target_task_id",
  "thread_key",
  "project_id",
  "source_kind",
  "intent_summary",
  "boundary_summary",
  "allowed_actions",
  "prohibited_actions",
  "targets",
  "effective_conditions",
  "risk_and_rollback",
  "revocation_conditions",
  "evidence_requirements",
] as const;

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
    name: "pm.redispatch_task",
    description:
      "Retry or repair and retry the same canonical TASK through TaskDispatcher. This creates a new auditable attempt, never a duplicate TASK.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: stringProp("Existing canonical TASK id"),
        mode: {
          type: "string",
          enum: ["retry", "repair_retry", "restart_session", "reassign"],
        },
        role: stringProp("Optional target role"),
        agent_id: stringProp("Optional registered target agent"),
        idempotency_key: stringProp("Required idempotency key"),
      },
      required: ["task_id", "mode", "idempotency_key"],
      additionalProperties: false,
    },
  },
  {
    name: "pm.validate_long_horizon_plan",
    description:
      "对长期复杂任务的 Planning IR、Requirement 覆盖、预算、DAG、事实时效和正文 digest 做确定性语义校验；结果与当前 task/thread/session 绑定。",
    inputSchema: {
      type: "object",
      properties: {
        task_id: stringProp("ADMIN→PM 根任务 id"),
        thread_key: stringProp("根任务 thread_key"),
        source_digest: stringProp("完整源任务书 SHA-256"),
        body_markdown: stringProp("待写入的完整自包含 Product Brief 正文"),
        planning_ir: { type: "object", description: "非权威 Planning IR JSON" },
        fact_snapshot_at: stringProp("实时事实快照 ISO-8601 时间"),
      },
      required: ["task_id", "thread_key", "source_digest", "body_markdown", "planning_ir", "fact_snapshot_at"],
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
          enum: ["draft", "needs_admin_decision", "ready_for_review", "ready", "paused", "terminated"],
          description: "长期规划使用 needs_admin_decision 或 ready_for_review；普通规划兼容 ready",
        },
        thread_key: stringProp("可选 FCoP thread_key，用于定位主任务"),
        source_digest: stringProp("长期规划源任务书 SHA-256"),
        validation_digest: stringProp("pm.validate_long_horizon_plan 返回的 validation digest"),
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
    name: "pm.write_governance_record",
    description:
      "把 ADMIN 聊天指令、授权或范围变化写成正式治理草稿；不会自动生效。",
    inputSchema: {
      type: "object",
      properties: governanceRecordProperties,
      required: governanceRecordRequired,
      additionalProperties: false,
    },
  },
  {
    name: "pm.revise_governance_record",
    description:
      "在 ADMIN 要求修改后创建新的治理 revision；不会覆盖旧版本。",
    inputSchema: {
      type: "object",
      properties: {
        governance_id: stringProp("待修订治理记录 id"),
        revision: { type: "integer", minimum: 1 },
        ...governanceRecordProperties,
      },
      required: [
        "governance_id",
        "revision",
        ...governanceRecordRequired,
      ],
      additionalProperties: false,
    },
  },
  {
    name: "pm.submit_governance_for_approval",
    description:
      "对正式治理草稿执行来源、任务、项目和哈希校验，并提交 ADMIN 审批。",
    inputSchema: {
      type: "object",
      properties: {
        governance_id: stringProp("治理记录 id"),
        revision: { type: "integer", minimum: 1 },
        idempotency_key: stringProp("提交幂等键"),
      },
      required: ["governance_id", "revision", "idempotency_key"],
      additionalProperties: false,
    },
  },
  {
    name: "pm.list_governance_records",
    description: "列出治理记录，可按状态或目标 TASK 过滤。",
    inputSchema: {
      type: "object",
      properties: {
        status: stringProp("可选治理状态"),
        task_id: stringProp("可选目标 TASK id"),
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pm.get_governance_record",
    description: "读取指定治理记录 revision、决定记录和审批卡投影。",
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
  {
    name: "pm.request_authorization",
    description:
      "创建 AUTHORIZATION 正式记录并提交审批；只返回待审批项，不直接授权。",
    inputSchema: {
      type: "object",
      properties: governanceRecordProperties,
      required: governanceRecordRequired.filter((name) => name !== "type"),
      additionalProperties: false,
    },
  },
  {
    name: "pm.reference_effective_governance",
    description:
      "在受限动作前机械校验治理审批 id、决定、范围、哈希和有效状态。",
    inputSchema: {
      type: "object",
      properties: {
        governance_id: stringProp("治理记录 id"),
        revision: { type: "integer", minimum: 1 },
        approval_id: stringProp("审批 id"),
        decision_id: stringProp("不可变 ADMIN 决定 id"),
        scope_digest: stringProp("获批范围摘要"),
        content_hash: stringProp("获批内容哈希"),
        lease_id: stringProp("正式 ADMIN 决定签发的 capability lease id"),
        idempotency_key: stringProp("后续消费幂等键"),
        project_id: stringProp("当前项目 id"),
        target_task_id: stringProp("当前 TASK id"),
      },
      required: [
        "governance_id",
        "revision",
        "approval_id",
        "decision_id",
        "scope_digest",
        "content_hash",
        "lease_id",
        "idempotency_key",
        "project_id",
        "target_task_id",
      ],
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
    name: "workspace.scratch.create",
    description: "Create a task-bound local scratch directory. This does not modify product or governance fact sources.",
    inputSchema: {
      type: "object",
      properties: { task_id: stringProp("Current TASK id"), path: stringProp("Relative scratch directory") },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "workspace.scratch.write",
    description: "Atomically write a UTF-8 file inside the current task scratch area.",
    inputSchema: {
      type: "object",
      properties: { task_id: stringProp("Current TASK id"), path: stringProp("Relative scratch file"), content: stringProp("UTF-8 content") },
      required: ["task_id", "path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "workspace.scratch.read",
    description: "Read a UTF-8 file from the current task scratch area.",
    inputSchema: {
      type: "object",
      properties: { task_id: stringProp("Current TASK id"), path: stringProp("Relative scratch file") },
      required: ["task_id", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "workspace.scratch.list",
    description: "List bounded files and directories in the current task scratch area.",
    inputSchema: {
      type: "object",
      properties: { task_id: stringProp("Current TASK id"), path: stringProp("Optional relative scratch directory") },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "workspace.scratch.cleanup",
    description: "Remove only the current task scratch area.",
    inputSchema: {
      type: "object",
      properties: { task_id: stringProp("Current TASK id") },
      required: ["task_id"],
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
    case "pm.redispatch_task":
      method = "POST";
      path = `/api/v2/runtime/tasks/${encodeURIComponent(requiredString(input.args, "task_id"))}/redispatch`;
      body = {
        mode: requiredString(input.args, "mode"),
        role: optionalString(input.args, "role") || undefined,
        agent_id: optionalString(input.args, "agent_id") || undefined,
        idempotency_key: requiredString(input.args, "idempotency_key"),
        caller: agentId,
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
        source_digest: optionalString(input.args, "source_digest") || undefined,
        validation_digest: optionalString(input.args, "validation_digest") || undefined,
        caller_role: agentId,
        session_id: input.sessionId,
      };
      break;
    case "pm.validate_long_horizon_plan":
      method = "POST";
      path = "/api/v2/pm/governance/planning-validation";
      body = {
        task_id: requiredString(input.args, "task_id"),
        current_task_id: String(input.currentTaskId ?? "").trim(),
        thread_key: requiredString(input.args, "thread_key"),
        source_digest: requiredString(input.args, "source_digest"),
        body_markdown: requiredString(input.args, "body_markdown"),
        planning_ir: input.args["planning_ir"],
        fact_snapshot_at: requiredString(input.args, "fact_snapshot_at"),
        caller_role: agentId,
        agent_id: agentId,
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
      path = withQuery("/api/v2/pm/tools/project-baseline", {
        task_id: String(input.currentTaskId ?? "").trim(),
        current_task_id: String(input.currentTaskId ?? "").trim(),
        caller_role: agentId,
        agent_id: agentId,
        session_id: String(input.sessionId ?? "").trim(),
      });
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
    case "pm.write_governance_record":
      method = "POST";
      path = "/api/v2/pm/governance/records";
      body = {
        ...input.args,
        actor: agentId,
      };
      break;
    case "pm.revise_governance_record":
      method = "POST";
      path =
        `/api/v2/pm/governance/records/${encodeURIComponent(requiredString(input.args, "governance_id"))}` +
        `/${encodeURIComponent(requiredString(input.args, "revision"))}/revise`;
      body = {
        ...input.args,
        actor: agentId,
      };
      break;
    case "pm.submit_governance_for_approval":
      method = "POST";
      path =
        `/api/v2/pm/governance/records/${encodeURIComponent(requiredString(input.args, "governance_id"))}` +
        `/${encodeURIComponent(requiredString(input.args, "revision"))}/submit`;
      body = {
        actor: agentId,
        idempotency_key: requiredString(input.args, "idempotency_key"),
      };
      break;
    case "pm.list_governance_records":
      path = withQuery("/api/v2/governance/records", {
        status: optionalString(input.args, "status"),
        task_id: optionalString(input.args, "task_id"),
        limit: optionalString(input.args, "limit"),
      });
      break;
    case "pm.get_governance_record":
      path =
        `/api/v2/governance/records/${encodeURIComponent(requiredString(input.args, "governance_id"))}` +
        `/${encodeURIComponent(requiredString(input.args, "revision"))}`;
      break;
    case "pm.request_authorization": {
      method = "POST";
      path = "/api/v2/pm/governance/records";
      body = {
        ...input.args,
        type: "AUTHORIZATION",
        actor: agentId,
        submit_immediately: true,
      };
      break;
    }
    case "pm.reference_effective_governance":
      method = "POST";
      path = "/api/v2/governance/authorizations/validate";
      body = {
        reference: {
          governance_id: requiredString(input.args, "governance_id"),
          revision: Number(input.args["revision"] ?? 0),
          approval_id: requiredString(input.args, "approval_id"),
          decision_id: requiredString(input.args, "decision_id"),
          scope_digest: requiredString(input.args, "scope_digest"),
          content_hash: requiredString(input.args, "content_hash"),
          lease_id: requiredString(input.args, "lease_id"),
          idempotency_key: requiredString(input.args, "idempotency_key"),
        },
        expected: {
          project_id: requiredString(input.args, "project_id"),
          target_task_id: requiredString(input.args, "target_task_id"),
          scope_digest: requiredString(input.args, "scope_digest"),
          content_hash: requiredString(input.args, "content_hash"),
        },
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
    case "workspace.scratch.create":
    case "workspace.scratch.write":
    case "workspace.scratch.read":
    case "workspace.scratch.list":
    case "workspace.scratch.cleanup":
      method = "POST";
      path = "/api/v2/workspace/scratch";
      body = {
        ...input.args,
        operation: input.toolName.slice("workspace.scratch.".length),
        current_task_id: input.currentTaskId,
        actor: agentId,
        session_id: input.sessionId,
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
