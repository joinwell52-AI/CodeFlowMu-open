/**
 * FcopToolProfile — fcop-mcp 工具权限分层定义
 *
 * 背景：fcop-mcp 提供 45 个工具，全量注入每个 agent 会造成严重 token 浪费。
 *
 *   45 工具 ≈ 19,320 tokens（~58 KB ÷ 3 bytes/token）
 *   4 个 agent 并发 = 77,280 tokens 仅工具定义
 *
 * 按 FCoP 三层组织（worker / governance / admin）分级，worker 只需 7 个工具：
 *
 *   executor  ( 3 工具) ≈  1,500 tokens — DEV / QA / OPS（task-report 热路径）
 *   leader    (28 工具) ≈ 12,000 tokens — PM / PLANNER
 *   observer  (12 工具) ≈  6,500 tokens — EVAL 旁观者（读材料 + 旁观 report）
 *   governance(36 工具) ≈ 15,500 tokens — LEAD-* / 审计角色
 *   admin     (45 工具) ≈ 19,320 tokens — 项目初始化 / 一次性操作
 *
 * 典型 4-agent 团队节省：
 *   无分层：77,280 tokens
 *   有分层：12,000 (PM) + 3×3,000 (DEV/QA/OPS) = 21,000 tokens
 *   节省：≈ 73%
 *
 * 实现路径：
 *   sdk-factory.ts 根据 agent layer 选择 profile，通过 FCOP_ALLOWED_TOOLS 环境变量
 *   传给 fcop-mcp-filter.ts（MCP 代理），由代理过滤 tools/list 响应。
 */

import type { AgentLayer } from "@codeflowmu/protocol";

// ─── Layer 1: Executor (worker) ─────────────────────────────────────────────

/**
 * 执行层工具集 (DEV / QA / OPS)。
 * 只包含 task-report 热路径：TASK 已由 Runtime 注入，完成时写 REPORT。
 * 禁止 `claim_task` / `read_task` / `finish_task` 进入执行层工具白名单。
 * 3 工具 ≈ 1,500 tokens。
 */
export const EXECUTOR_TOOLS = [
  "write_report", // 完成回执（fcop/reports/）
  "write_issue", // 上报阻塞/问题
  "drop_suggestion", // FCoP 协议反馈通道
] as const;

/**
 * CodeFlowMu 实时派发热路径禁止经 Adapter/MCP 同步调用的工具。
 * TASK 由 Runtime 注入；`_lifecycle` 迁移由 LifecycleGovernor 异步 rename。
 */
export const RUNTIME_HOT_PATH_BLOCKED_TOOLS = [
  "claim_task",
  "read_task",
  "inspect_task",
  "finish_task",
] as const;

export const RUNTIME_HOT_PATH_BLOCKED_SET = new Set<string>(
  RUNTIME_HOT_PATH_BLOCKED_TOOLS,
);

/** dev-team / media-team / mvp-team 主控角色码（可向下游 write_task）。 */
export const LEADER_ROLE_CODES = [
  "PM",
  "PLANNER",
  "PUBLISHER",
  "MARKETER",
] as const;

/**
 * Runtime 已注入当前 TASK 正文时，leader 仍须保留的派单/协调工具。
 * 不含 claim/finish/inspect；含 read_task/read_report/list_issues 供读取**其他** ledger 正文。
 */
export const LEADER_RUNTIME_HOT_PATH_TOOLS = [
  "write_task",
  "create_task",
  "list_tasks",
  "list_reports",
  "read_task",
  "read_report",
  "list_issues",
  "fcop_report",
  "get_team_status",
  "submit_task",
] as const;

/**
 * PM 专属 Runtime 控制面工具。它们不是 Python fcop-mcp 工具；实际调用由
 * CodeFlowMu Runtime 适配器转发到当前 Panel/Runtime 实例。
 */
export const PM_RUNTIME_CONTROL_TOOLS = [
  "pm.summarize_thread",
  "pm.detect_thread_stall",
  "pm.close_admin_task",
  "pm.wake_downstream",
  "pm.review_check",
  "pm.write_planning_artifact",
  "pm.record_planning_skill_evidence",
] as const;

export function roleCodeFromAgentId(agentId: string): string {
  return agentId.trim().split(/[-.]/)[0]?.toUpperCase() ?? "";
}

export function isLeaderRoleAgentId(agentId: string): boolean {
  const code = roleCodeFromAgentId(agentId);
  return (LEADER_ROLE_CODES as readonly string[]).includes(code);
}

export function isEvalRoleAgentId(agentId: string): boolean {
  return roleCodeFromAgentId(agentId) === "EVAL";
}

// ─── Observer (EVAL) ────────────────────────────────────────────────────────

/**
 * 旁观者工具集 (EVAL)。
 * 读取任务/报告/issue/治理摘要，写旁观 report/issue；有限 write_task（路由层限制收件人）。
 * 12 工具 ≈ 6,500 tokens。
 */
export const OBSERVER_TOOLS = [
  "list_tasks",
  "read_task",
  "inspect_task",
  "list_reports",
  "read_report",
  "list_issues",
  "write_issue",
  "write_report",
  "get_team_status",
  "get_governance_summary",
  "list_governance_events",
  "write_task",
] as const;

// ─── Layer 2: Leader (governance/PM) ────────────────────────────────────────

/**
 * 领导层工具集 (PM / PLANNER)。
 * 包含任务派发、审查流程、汇报能力。
 * 30 工具 ≈ 12,800 tokens。
 */
export const LEADER_TOOLS = [
  ...EXECUTOR_TOOLS,
  "list_tasks",
  "read_task",
  // 任务生命周期管理
  "create_task",
  "write_task",
  "submit_task",
  "approve_task",
  "reject_task",
  "inspect_task",
  "archive_task",
  "archive_to_history",
  "bulk_archive_to_history",
  "list_history",
  "read_history_task",
  // Review 流程
  "write_review",
  "list_reviews",
  "read_review",
  "mark_human_approved",
  // 报告 & 状态
  "fcop_report",
  "fcop_check",
  "list_reports",
  "read_report",
  "list_issues",
  "get_team_status",
  // PM 必须能用受控 MCP 创建/检查业务工作区；禁止退回 shell mkdir。
  "new_workspace",
  "list_workspaces",
  // 可选治理（异步；CodeFlowMu Runtime 用本地 fs rename，勿在开工前同步 claim）
  "claim_task",
  // finish_task 仅 admin 层 legacy；leader 走 submit_task → approve_task → archive_task
] as const;

// ─── Layer 3: Governance (compliance + alerts) ───────────────────────────────

/**
 * 治理层工具集 (LEAD-* / 审计角色)。
 * 在 leader 基础上增加合规体检、治理告警、工作区管理。
 * 36 工具 ≈ 15,500 tokens。
 */
export const GOVERNANCE_TOOLS = [
  ...LEADER_TOOLS,
  "fcop_audit",
  "fcop_create_alert",
  "fcop_list_alerts",
  "get_governance_summary",
  "list_governance_events",
  "get_available_teams",
] as const;

// ─── Layer 4: Admin (all 45 tools) ──────────────────────────────────────────

/**
 * 管理员工具集（全量）。
 * 仅用于项目初始化、协议升级等一次性高权限操作。
 * 45 工具 ≈ 19,320 tokens。
 */
export const ADMIN_TOOLS = [
  ...GOVERNANCE_TOOLS,
  "finish_task", // legacy only — 勿作 CodeFlowMu 默认热路径
  "init_project",
  "init_solo",
  "create_custom_team",
  "validate_team_config",
  "deploy_role_templates",
  "set_project_dir",
  "redeploy_rules",
  "upgrade_fcop",
  "check_update",
] as const;

// ─── Types & helpers ─────────────────────────────────────────────────────────

export type FcopToolProfile =
  | "executor"
  | "leader"
  | "observer"
  | "governance"
  | "admin";

/**
 * 根据 profile 返回工具允许列表。
 * 传给 CursorAdapterConfig.allowedTools 或 FCOP_ALLOWED_TOOLS 环境变量。
 */
export function toolsForProfile(
  profile: FcopToolProfile,
): readonly string[] {
  switch (profile) {
    case "executor":
      return EXECUTOR_TOOLS;
    case "leader":
      return LEADER_TOOLS;
    case "observer":
      return OBSERVER_TOOLS;
    case "governance":
      return GOVERNANCE_TOOLS;
    case "admin":
      return ADMIN_TOOLS;
  }
}

/** 按真实 Agent 身份补充角色专属 Runtime 工具，避免把 PM 能力泄露给其他 leader。 */
export function toolsForAgent(
  agentId: string,
  layer: AgentLayer,
): readonly string[] {
  const base = toolsForProfile(profileForAgent(agentId, layer));
  if (roleCodeFromAgentId(agentId) !== "PM") return base;
  return [...new Set([...base, ...PM_RUNTIME_CONTROL_TOOLS])];
}

/**
 * 将 codeflowmu `Agent.layer` 映射到 fcop-mcp 工具 profile。
 *
 * - worker     → executor   (3 工具，DEV/QA/OPS task-report)
 * - leader     → leader     (28 工具，PM 等主控)
 * - observer   → observer   (12 工具，EVAL 旁观者)
 * - governance → governance (36 工具，LEAD-* / 审计)
 * - admin      → admin      (45 工具，初始化/升级)
 */
export function profileForLayer(layer: AgentLayer): FcopToolProfile {
  switch (layer) {
    case "worker":
      return "executor";
    case "leader":
      return "leader";
    case "observer":
      return "observer";
    case "governance":
      return "governance";
    case "admin":
      return "admin";
  }
}

/**
 * 按 agent 身份 + layer 解析工具 profile。
 * EVAL 角色码或 `layer: observer` 均映射到 observer（兼容旧 governance 配置）。
 */
export function profileForAgent(
  agentId: string,
  layer: AgentLayer,
): FcopToolProfile {
  if (layer === "observer" || isEvalRoleAgentId(agentId)) {
    return "observer";
  }
  return profileForLayer(layer);
}

/**
 * Token 节省汇总报告（用于 banner / 日志）。
 */
export function tokenSavingsSummary(profiles: FcopToolProfile[]): string {
  const totalWithout = profiles.length * 19320;
  const totalWith = profiles.reduce((sum, p) => {
    const counts: Record<FcopToolProfile, number> = {
      executor: 3000,
      leader: 12000,
      observer: 6500,
      governance: 15500,
      admin: 19320,
    };
    return sum + (counts[p] ?? 19320);
  }, 0);
  const savings = Math.round(((totalWithout - totalWith) / totalWithout) * 100);
  return `fcop-mcp 工具分层: ${profiles.length} agents, 节省 ≈${savings}% token (${totalWith.toLocaleString()} vs ${totalWithout.toLocaleString()})`;
}
