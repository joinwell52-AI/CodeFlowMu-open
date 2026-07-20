/**
 * PM 内置技能 manifest（与 MCP SkillRegistry 分离）。
 *
 * MCP `skills/*.json` 仅承载 fcop/git 等 MCP 工具 skill；带点号的
 * `pm.*` 内置 playbook 走本 manifest + wake prompt 注入。
 */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type PmBuiltinSkillId =
  | "pm.close_admin_task"
  | "pm.summarize_thread"
  | "pm.wake_downstream"
  | "pm.detect_thread_stall"
  | "pm.review_check"
  | "pm.write_planning_artifact"
  | "pm.record_planning_skill_evidence";

export interface PmSkillInputSpec {
  required?: boolean;
  description: string;
}

export interface PmBuiltinSkillDefinition {
  skill_id: PmBuiltinSkillId;
  display_name: string;
  description: string;
  available_to_roles: ["PM"];
  inputs: Record<string, PmSkillInputSpec>;
  outputs: string;
  tools?: string[];
  restrictions?: string[];
  cli: string;
  api?: string;
}

export interface PmSkillManifestFile {
  manifest_version: "1.0.0";
  kind: "pm-builtin-skills";
  role: "PM";
  skills: PmBuiltinSkillDefinition[];
  generated_at?: string;
}

export const PM_BUILTIN_SKILLS: readonly PmBuiltinSkillDefinition[] = [
  {
    skill_id: "pm.summarize_thread",
    display_name: "线程摘要",
    description: "汇总 thread 内主线 TASK、子 TASK、REPORT、pending_pm_review 与 token/cost。",
    available_to_roles: ["PM"],
    inputs: {
      thread_key: { required: true, description: "FCoP thread_key" },
    },
    outputs: "ThreadSummary JSON",
    cli: "ledger_cli.ts summarize_thread <projectRoot> <thread_key>",
    api: "GET /api/v2/pm/governance/thread/:threadKey/summary",
  },
  {
    skill_id: "pm.detect_thread_stall",
    display_name: "线程卡顿检测",
    description:
      "检测 active 无 REPORT、inbox 残片、pending_pm_review、ledger 缺失等 stall 信号并给建议。",
    available_to_roles: ["PM"],
    inputs: {
      thread_key: { required: true, description: "FCoP thread_key" },
    },
    outputs: "ThreadStallDetection JSON",
    cli: "ledger_cli.ts detect_thread_stall <projectRoot> <thread_key>",
    api: "GET /api/v2/pm/governance/thread/:threadKey/stall",
  },
  {
    skill_id: "pm.close_admin_task",
    display_name: "ADMIN 关单草稿",
    description: "据主线 TASK 与下游 REPORT 生成 PM-to-ADMIN write_report 正文草稿。",
    available_to_roles: ["PM"],
    inputs: {
      thread_key: { description: "thread_key（与 task_id 二选一）" },
      task_id: { description: "主线 task_id（与 thread_key 二选一）" },
    },
    outputs: "CloseAdminTaskDraft（含 write_report_hint）",
    tools: ["write_report"],
    restrictions: ["不 archive", "不手工 mv _lifecycle"],
    cli: "ledger_cli.ts close_admin_task <projectRoot> <thread_key|task_id>",
    api: "GET /api/v2/pm/governance/close-draft?thread_key=&task_id=",
  },
  {
    skill_id: "pm.wake_downstream",
    display_name: "下游唤醒",
    description: "复用 doorbell wake 催促 DEV/OPS/QA；不新增 TASK/REPORT。",
    available_to_roles: ["PM"],
    inputs: {
      task_id: { required: true, description: "待催促的子任务 task_id" },
      role: { required: true, description: "下游角色码 DEV|OPS|QA" },
      reason: { description: '唤醒原因，默认 "nudge"' },
      thread_key: { description: "FCoP thread_key" },
      agent_id: { description: "可选目标 Agent id" },
    },
    outputs: "Runtime wake result（ok/skipped/delayed/error、agent_id、session_id）",
    tools: ["pm.wake_downstream"],
    restrictions: [
      "不 write_task",
      "不 write_report",
      "不动 _lifecycle",
      "下游已有有效 REPORT 时不 wake",
      "禁止 curl/HTTP 轮询 localhost 等本地 API",
      "等 REPORT 读 ledger cache / runtime-events.jsonl / cycle.jsonl",
    ],
    cli: "Runtime tool: pm.wake_downstream",
    api: "POST /api/v2/pm/governance/wake-downstream",
  },
  {
    skill_id: "pm.write_planning_artifact",
    display_name: "受控写入规划产物",
    description: "由 Runtime 按任务规划等级写入唯一合法的 PLAN/Product Brief 路径。",
    available_to_roles: ["PM"],
    inputs: {
      task_id: { required: true, description: "ADMIN→PM 主任务 id" },
      body_markdown: { required: true, description: "无 YAML frontmatter 的完整规划正文" },
      status: { description: "draft 或 ready，默认 ready" },
      thread_key: { description: "可选 FCoP thread_key" },
    },
    outputs: "规划产物路径、修订号与实时规划门禁结果",
    tools: ["pm.write_planning_artifact"],
    restrictions: ["禁止 shell/Python 写入", "禁止自选路径", "禁止在正文中附带 YAML frontmatter"],
    cli: "Runtime tool: pm.write_planning_artifact",
    api: "POST /api/v2/pm/governance/planning-artifact",
  },
  {
    skill_id: "pm.record_planning_skill_evidence",
    display_name: "规划技能真实执行证据",
    description: "逐项记录 PM 实际读取并应用规划技能后的输入、输出、方案章节与产品决策。",
    available_to_roles: ["PM"],
    inputs: {
      skill_id: { required: true, description: "实际执行的 PM/UI Playbook skill id" },
      task_id: { required: true, description: "ADMIN→PM 主任务 id" },
      input_context: { required: true, description: "本次技能输入上下文" },
      output_summary: { required: true, description: "实际产出摘要" },
      brief_section: { required: true, description: "Product Brief/PLAN 对应章节" },
      product_decisions: { required: true, description: "受影响的产品决策列表" },
    },
    outputs: "Runtime-signed SkillInvocationRecord",
    tools: ["pm.record_planning_skill_evidence"],
    restrictions: ["auto_inject 不计完成", "禁止手工追加 JSONL", "必须在首次下游派单前调用"],
    cli: "Runtime tool: pm.record_planning_skill_evidence",
    api: "POST /api/v2/pm/governance/planning-skill-evidence",
  },
  {
    skill_id: "pm.review_check",
    display_name: "回执验收检查",
    description: "检查 REPORT 的 references、证据段、status 是否满足 PM 验收。",
    available_to_roles: ["PM"],
    inputs: {
      task_id: { description: "关联 TASK id（与 report_id 至少其一）" },
      report_id: { description: "REPORT id（与 task_id 至少其一）" },
    },
    outputs: "ReviewCheckResult JSON",
    cli: "ledger_cli.ts review_check <projectRoot> [--task_id=] [--report_id=]",
    api: "GET /api/v2/pm/governance/review-check?task_id=&report_id=",
  },
] as const;

export function buildPmSkillManifestFile(): PmSkillManifestFile {
  return {
    manifest_version: "1.0.0",
    kind: "pm-builtin-skills",
    role: "PM",
    skills: [...PM_BUILTIN_SKILLS],
    generated_at: new Date().toISOString(),
  };
}

export function listPmBuiltinSkills(): PmBuiltinSkillDefinition[] {
  return [...PM_BUILTIN_SKILLS];
}

export function listPmSkillsForRole(role: string): PmBuiltinSkillDefinition[] {
  const code = role.trim().toUpperCase();
  if (!code.startsWith("PM")) return [];
  return listPmBuiltinSkills();
}

export function formatPmBuiltinSkillsPlaybookBlock(): string {
  const rows = PM_BUILTIN_SKILLS.map((s) => {
    const restr = s.restrictions?.length ? ` · 限制：${s.restrictions.join("；")}` : "";
    return `| \`${s.skill_id}\` | ${s.description} | \`${s.cli.split(" ")[1] ?? s.cli}\` · \`${s.api ?? "—"}\`${restr} |`;
  }).join("\n");

  return `**PM 内置治理技能**（wake/patrol playbook；registry: \`.codeflowmu/pm-skills.manifest.json\`；**不是** ADMIN 按钮墙）：

| skill_id | 用途 | 入口 |
|----------|------|------|
${rows}

**Cold Path 派单后固定节奏**：\`write_task\` → \`pm.wake_downstream\` → 盯 REPORT → \`pm.review_check\` → \`pm.close_admin_task\` + MCP \`write_report\`。**只有当前 TASK 分支的新下游任务已有有效 REPORT 时，才可跳过 wake，直接 review_check / 汇总关单**；同一 thread 的旧父任务、兄弟任务及其 REPORT 仅作历史背景，不能满足当前 TASK，也不得被当前 TASK 重新 wake。不得对已完成任务重复催办。

**下游 inbox/active/review/tasks 无 REPORT 超过约 5 分钟**：PM **必须**调用 \`pm.wake_downstream\`（禁止只让 ADMIN 点 Panel 开工）；Runtime 也会 \`DOWNSTREAM_AUTO_NUDGE\`。先自动催办，失败再请 ADMIN；回复 ADMIN 须写清催办角色、子 task_id、session_id/wake 结果、下一步等待什么。**等待 REPORT 时禁止 shell 轮询本地 HTTP**——读 ledger cache、\`.codeflowmu/events/runtime-events.jsonl\`、\`cycle.jsonl\`。诊断辅助：\`pm.detect_thread_stall\` / \`pm.summarize_thread\`。`;
}

export function pmSkillsManifestPath(projectRoot: string): string {
  return join(projectRoot, ".codeflowmu", "pm-skills.manifest.json");
}

export async function readPmSkillManifest(
  projectRoot: string,
): Promise<PmSkillManifestFile> {
  const path = pmSkillsManifestPath(projectRoot);
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as PmSkillManifestFile;
    if (parsed?.kind === "pm-builtin-skills" && Array.isArray(parsed.skills)) {
      return parsed;
    }
  } catch {
    /* fall through */
  }
  return buildPmSkillManifestFile();
}

export async function plantPmSkillManifestIfMissing(
  projectRoot: string,
): Promise<{ planted: boolean; path: string }> {
  const path = pmSkillsManifestPath(projectRoot);
  try {
    await access(path);
    return { planted: false, path };
  } catch {
    await mkdir(join(projectRoot, ".codeflowmu"), { recursive: true });
    const manifest = buildPmSkillManifestFile();
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    return { planted: true, path };
  }
}
