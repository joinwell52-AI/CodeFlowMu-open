/**
 * fcop-mcp tool catalog for Web Panel «About → FCoP» (display-only).
 * Aligns with fcop-mcp ≥ 3.2.x tool surface; names are protocol-stable.
 * Descriptions sourced from FCoP docs/mcp-tools.md (fcop-mcp 3.x, 45 tools).
 */

export interface FcopToolDesc {
  zh: string;
  en: string;
}

export interface FcopToolGroup {
  id: string;
  title: string;
  titleEn: string;
  tools: string[];
}

/** One-line purpose per tool for About panel & API consumers. */
export const FCOP_MCP_TOOL_DESC: Record<string, FcopToolDesc> = {
  fcop_report: {
    zh: "新 MCP 会话第一步：项目状态 / UNBOUND / 初始化建议；报告头含规则版本漂移提示",
    en: "First call each MCP session: project state, UNBOUND report, init hints; version drift in header",
  },
  fcop_check: {
    zh: "日常轻量自检：schema、文件名↔frontmatter、治理事件摘要（不写盘）",
    en: "Light daily check: schema, filename/frontmatter, governance event summary (read-only)",
  },
  set_project_dir: {
    zh: "切换 MCP 项目根目录，无需改 mcp.json 或重启 Cursor",
    en: "Switch MCP project root without editing mcp.json or restarting the host",
  },
  init_project: {
    zh: "用预设团队模板初始化（dev/media/mvp/qa-team），建立 fcop/ 与 _lifecycle/",
    en: "Init with preset team template; creates fcop/ layout and _lifecycle/ (idempotent)",
  },
  init_solo: {
    zh: "Solo 模式：单 AI 角色直接对 ADMIN，无中间派发层",
    en: "Solo mode: single AI role talks to ADMIN directly",
  },
  create_custom_team: {
    zh: "自定义角色与 leader 初始化团队；建议先 validate_team_config",
    en: "Init custom team with roles and leader; validate_team_config recommended first",
  },
  validate_team_config: {
    zh: "校验自定义团队配置（roles / leader），不写盘",
    en: "Validate custom team config (roles, leader) without writing files",
  },
  deploy_role_templates: {
    zh: "部署或刷新 fcop/shared/ 团队文档与 roles/ 角色档案（force 时先归档旧文件）",
    en: "Deploy/refresh team docs under fcop/shared/ and role charters (archives on force)",
  },
  create_task: {
    zh: "v3 规范入口：创建任务，落入 _lifecycle/inbox/（v2 项目落 fcop/tasks/）",
    en: "v3 spec entry: create task in _lifecycle/inbox/ (v2: fcop/tasks/)",
  },
  write_task: {
    zh: "同 create_task（v1/v2 兼容名称，与 create_task 长期并存）",
    en: "Alias of create_task (v1/v2 compatible name)",
  },
  read_task: {
    zh: "读取任务全文（自动定位 _lifecycle 各阶段或 v2 tasks/）",
    en: "Read full task body (resolves v3 lifecycle stage or v2 tasks/)",
  },
  list_tasks: {
    zh: "按发件人 / 收件人 / 状态 / 日期过滤列出任务，支持分页",
    en: "List tasks filtered by sender, recipient, status, date (paginated)",
  },
  inspect_task: {
    zh: "离线校验任务 schema 与「文件名↔frontmatter」一致性，不写盘",
    en: "Offline validate task schema and filename↔frontmatter consistency",
  },
  claim_task: {
    zh: "v3：inbox → active，领取任务并开始执行",
    en: "v3: inbox → active — claim task and start work",
  },
  submit_task: {
    zh: "v3：active → review，提交工作等待审核（CodeFlowMu 语义名 submit_review；须先有 REPORT）",
    en: "v3: active → review — submit for review (CodeFlowMu: submit_review; REPORT required first)",
  },
  finish_task: {
    zh: "v3：legacy — active → done，跳过 review/done 权责；CodeFlowMu 勿作默认热路径，用 submit_task + approve_task",
    en: "v3: legacy — active → done, skips review/done authority; do not use as CodeFlowMu default; prefer submit_task + approve_task",
  },
  approve_task: {
    zh: "v3：review → done，ADMIN/治理角色审核通过",
    en: "v3: review → done — approve by ADMIN or governance role",
  },
  reject_task: {
    zh: "v3：review → active，打回重做（建议 note 写明原因）",
    en: "v3: review → active — reject back to active (note recommended)",
  },
  write_report: {
    zh: "写完成报告，回执给 leader/PM（status: done / in_progress / blocked）",
    en: "Write completion report to leader/PM",
  },
  list_reports: {
    zh: "按 reporter / task_id / status 过滤列出报告",
    en: "List reports filtered by reporter, task_id, status",
  },
  read_report: {
    zh: "读取报告全文",
    en: "Read full report body",
  },
  write_issue: {
    zh: "上报阻塞、规则不清或外部故障等问题单",
    en: "File an issue for blockers, rule gaps, or external failures",
  },
  list_issues: {
    zh: "按 reporter / severity / status 过滤列出问题（默认 open）",
    en: "List issues filtered by reporter, severity, and status (default open)",
  },
  close_issue: {
    zh: "结案 ISSUE（frontmatter status: closed + closed_at）",
    en: "Close an ISSUE (frontmatter status: closed + closed_at)",
  },
  write_review: {
    zh: "写 REVIEW 治理决策（approved / needs_changes / needs_human 等）",
    en: "Write REVIEW governance decision on a task/report/change",
  },
  list_reviews: {
    zh: "过滤列出 REVIEW，标注人工审批 pending/approved 状态",
    en: "List reviews with human_approval pending/approved markers",
  },
  read_review: {
    zh: "读取 REVIEW 全文（含 human_approval 子结构）",
    en: "Read full REVIEW including human_approval block",
  },
  mark_human_approved: {
    zh: "闭合 needs_human：写入 human_approval，须 admin 层角色审批",
    en: "Close needs_human loop: record human_approval (admin layer required)",
  },
  archive_task: {
    zh: "将 done 任务（及同名报告）搬到 _lifecycle/archive/ 或 v2 log/",
    en: "Move done task (+ matching report) to archive/ or v2 log/",
  },
  archive_to_history: {
    zh: "v3.2+：单个任务从 archive/ 迁入 history/YYYY-MM-DD/<stem>/ 深归档",
    en: "v3.2+: move one archived task into history/YYYY-MM-DD/ deep archive",
  },
  bulk_archive_to_history: {
    zh: "v3.2+：批量将 archive/ 内全部任务迁入 history/ 日期分片",
    en: "v3.2+: bulk move all archive/ tasks into dated history/ buckets",
  },
  list_history: {
    zh: "列出 history/ 日期分片或某分片下的历史任务",
    en: "List history/ date buckets or tasks within a bucket",
  },
  read_history_task: {
    zh: "从历史档案读取指定任务全文（可限定 date 分片加速）",
    en: "Read task from history/ deep archive (optional date bucket)",
  },
  fcop_audit: {
    zh: "三场景协议深度体检（new/upgrade/takeover），产出 INSPECTION 整改建议",
    en: "Deep protocol inspection (new/upgrade/takeover) with INSPECTION report",
  },
  fcop_list_alerts: {
    zh: "GAL 治理告警收件箱，按 status / severity 过滤",
    en: "GAL governance alert inbox, filter by status/severity",
  },
  fcop_create_alert: {
    zh: "手动归档治理缺口为 ALERT（ADMIN / 治理观察者）",
    en: "Manually record governance gap as ALERT",
  },
  list_governance_events: {
    zh: "读取 fcop_events.jsonl 最近治理事件（tool / risk / session）",
    en: "Read recent governance events from fcop_events.jsonl",
  },
  get_governance_summary: {
    zh: "治理调用统计：总量、风险分布、Top 工具、CRITICAL 清单",
    en: "Governance stats: totals, risk tiers, top tools, CRITICAL events",
  },
  drop_suggestion: {
    zh: "协议泄压阀：对规则提反对意见，写入 .fcop/proposals/（禁止自改规则文件）",
    en: "Protocol feedback valve: write suggestion to .fcop/proposals/",
  },
  new_workspace: {
    zh: "按项目 workspace_mode 解析业务代码根：root 返回项目根，multi 创建 workspace/<slug>",
    en: "Resolve the configured artifact root: project root in root mode, workspace/<slug> in multi mode",
  },
  list_workspaces: {
    zh: "列出业务工作区；root 模式返回项目根，multi 模式列出 workspace/<slug>",
    en: "List existing workspace slugs",
  },
  get_team_status: {
    zh: "项目快照：初始化状态、open 任务/报告/问题数、最近活动",
    en: "Project snapshot: init state, open counts, recent activity",
  },
  get_available_teams: {
    zh: "列出包内预设团队模板及 leader / 成员角色",
    en: "List bundled preset teams with leader and roles",
  },
  check_update: {
    zh: "比对本地 fcop-mcp 与 PyPI 最新版（不写盘、不安装）",
    en: "Compare local fcop-mcp with PyPI latest (read-only)",
  },
  upgrade_fcop: {
    zh: "打印针对当前安装方式的 fcop/fcop-mcp 升级命令（不自动执行 pip）",
    en: "Print upgrade commands for fcop/fcop-mcp (does not run pip)",
  },
  redeploy_rules: {
    zh: "ADMIN：把 wheel 内四份规则文件部署到项目根（fcop_report 漂移时调用）",
    en: "ADMIN: redeploy four rule files from wheel when version drift detected",
  },
};

export function fcopMcpToolDescription(name: string, lang: "zh" | "en" = "zh"): string {
  const row = FCOP_MCP_TOOL_DESC[name];
  if (!row) return "";
  return lang === "en" ? row.en : row.zh;
}

export const FCOP_MCP_TOOL_GROUPS: FcopToolGroup[] = [
  {
    id: "startup",
    title: "启动与会话",
    titleEn: "Startup & session",
    tools: [
      "fcop_report",
      "fcop_check",
      "init_solo",
      "init_project",
      "create_custom_team",
      "set_project_dir",
      "deploy_role_templates",
      "validate_team_config",
    ],
  },
  {
    id: "lifecycle-v3",
    title: "v3 任务生命周期",
    titleEn: "v3 task lifecycle",
    tools: [
      "create_task",
      "claim_task",
      "submit_task",
      "finish_task",
      "approve_task",
      "reject_task",
      "inspect_task",
      "list_tasks",
      "read_task",
    ],
  },
  {
    id: "ipc-legacy",
    title: "IPC 读写（兼容别名）",
    titleEn: "IPC read/write (aliases)",
    tools: ["write_task", "write_report", "write_issue", "write_review"],
  },
  {
    id: "reports",
    title: "报告与问题",
    titleEn: "Reports & issues",
    tools: [
      "list_reports",
      "read_report",
      "list_issues",
      "close_issue",
      "write_issue",
      "list_reviews",
      "read_review",
      "mark_human_approved",
    ],
  },
  {
    id: "history",
    title: "历史归档（3.2+）",
    titleEn: "History archive (3.2+)",
    tools: [
      "archive_task",
      "archive_to_history",
      "bulk_archive_to_history",
      "list_history",
      "read_history_task",
    ],
  },
  {
    id: "governance",
    title: "治理与审计",
    titleEn: "Governance & audit",
    tools: [
      "fcop_audit",
      "fcop_list_alerts",
      "fcop_create_alert",
      "list_governance_events",
      "get_governance_summary",
      "drop_suggestion",
    ],
  },
  {
    id: "workspace",
    title: "工作区与团队",
    titleEn: "Workspace & team",
    tools: [
      "new_workspace",
      "list_workspaces",
      "get_team_status",
      "get_available_teams",
    ],
  },
  {
    id: "upgrade",
    title: "升级与规则",
    titleEn: "Upgrade & rules",
    tools: ["check_update", "upgrade_fcop", "redeploy_rules"],
  },
];

export function fcopMcpToolCount(): number {
  const seen = new Set<string>();
  for (const g of FCOP_MCP_TOOL_GROUPS) {
    for (const t of g.tools) seen.add(t);
  }
  return seen.size;
}
