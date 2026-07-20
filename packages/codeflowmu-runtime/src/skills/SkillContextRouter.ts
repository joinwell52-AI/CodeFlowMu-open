/**
 * Context-aware agent skill routing.
 *
 * This is intentionally a lazy router: it returns only the few skills that
 * match the current role and task context, then injects only those SKILL.md
 * excerpts. The manifest remains an index, never a full prompt payload.
 */

import { readFile } from "node:fs/promises";

import { recordSkillInvocation } from "../pm/SkillInvocationJournal.ts";
import {
  classifyProductTask,
  PRODUCT_DESIGN_REQUIRED_SKILLS,
} from "../pm/ProductDeliveryGovernance.ts";
import {
  isPmDispatchForbiddenBody,
  isTaskHotPathBody,
} from "../pm/pmAdminRejectPrompt.ts";
import { readAgentSkillsManifestResolved } from "./AgentPlaybookCatalog.ts";
import { resolveSkillAssetPath } from "./SkillAssetResolver.ts";

export type SkillRouteIntent =
  | "dispatch"
  | "patrol"
  | "wake"
  | "task"
  | "review"
  | "verify"
  | "diagnose"
  | "close"
  | "chat";

export interface SkillContextMatch {
  skillId: string;
  reason: string;
  displayName?: string;
  skillPackage?: string;
  status?: string;
  groupKey?: string;
}

export interface ResolveSkillContextOpts {
  role: string;
  message: string;
  intent?: SkillRouteIntent;
  downstreamRole?: string;
  taskId?: string;
  threadKey?: string;
  sessionId?: string;
  maxSkills?: number;
  includeExcerpts?: boolean;
  excerptMaxChars?: number;
  recordJournal?: boolean;
}

export interface ResolveSkillContextResult {
  matches: SkillContextMatch[];
  skillIds: string[];
  promptBlock: string;
}

interface RuleDef {
  role: string;
  skillId: string;
  reason: string;
  priority: number;
  test: (ctx: RuleContext) => boolean;
}

interface RuleContext {
  role: string;
  text: string;
  intent: SkillRouteIntent;
  downstreamRole?: string;
}

const ROLE_GROUPS: Record<string, string[]> = {
  PM: ["pm_playbook_skills", "ui_playbook_skills", "common_skills"],
  DEV: ["dev_playbook_skills", "common_skills"],
  QA: ["qa_playbook_skills", "common_skills"],
  OPS: ["ops_playbook_skills", "common_skills"],
  EVAL: ["eval_playbook_skills", "common_skills"],
  TM: ["technical_manager_playbook_skills", "common_skills"],
  ARCHITECT: ["architect_playbook_skills", "common_skills"],
  UI: ["ui_playbook_skills", "common_skills"],
};

const STACK_SIGNAL =
  /python|typescript|javascript|node\.?js|react|vue|vite|webpack|html\/css|static\s*html|tech\s*stack|framework|runtime|go\b|rust\b|java\b|\.net|技术栈|框架|静态\s*html/i;
const DISPATCH_SIGNAL =
  /write_task|recipient\s*[:=]\s*["']?(DEV|QA|OPS)|to-(DEV|QA|OPS)|派(?:给|发)?\s*(DEV|QA|OPS|开发|测试|运维)/i;
const REQUIREMENTS_SIGNAL =
  /requirement|requirements|PRD|user\s*stor|需求|产品需求|用户故事|需求澄清/i;
const ACCEPTANCE_SIGNAL =
  /acceptance\s*criteria|\bAC\b|definition\s*of\s*done|验收|验收标准|完成定义/i;
const SCOPE_SIGNAL =
  /scope|scope\s*creep|boundary|out\s*of\s*scope|范围|边界|越界|做多了/i;
const PRIORITY_SIGNAL =
  /priority|triage|urgent|\bP0\b|\bP1\b|\bP2\b|优先级|紧急|排序|先做/i;
const ARCH_SIGNAL =
  /architecture|ADR|system\s*design|接口|架构|技术方案|系统设计|模块/i;
const DELIVERY_SIGNAL =
  /delivery|milestone|sprint|release|plan|排期|里程碑|交付|上线|迭代/i;
const CODE_LOCATE_SIGNAL =
  /where|locat|file|module|stack\s*trace|call\s*site|入口|定位|在哪|文件|模块/i;
const PATCH_SIGNAL =
  /fix|patch|implement|change|update|edit|bug|修复|实现|修改|改代码|补丁/i;
const TEST_SIGNAL =
  /test|verify|explain|evidence|测试|验证|说明|证据/i;
const BROWSER_AUTOMATION_SIGNAL =
  /playwright|browser|chromium|webkit|firefox|screenshot|viewport|click|form|navigation|page\.|网页|浏览器|截图|视口|点击|表单|页面|可视化|前端验收|UI\s*check/i;
const WINDOWS_USE_SIGNAL =
  /windows[ -]?use|computer[ -]?use|windows\s+(?:desktop|app|application)|native\s+windows|desktop\s+app|win32|uiautomation|ui\s*automation|记事本|资源管理器|桌面应用|窗口自动化|操作\s*windows/i;
const WEB_SEARCH_SIGNAL =
  /web\s*search|search\s+the\s+web|internet\s+search|find\s+(?:web\s+)?sources|搜索网页|网页搜索|联网搜索|查找来源|检索网页/i;
const WEB_EXTRACT_SIGNAL =
  /web\s*extract|extract\s+(?:the\s+)?(?:page|article|table|content)|open\s+(?:the\s+)?(?:url|webpage)|source_url|提取网页|抽取网页|提取正文|抽取正文|提取表格|打开网页|指定\s*URL/i;
const WEB_RESEARCH_SIGNAL =
  /web\s*research|research\s+(?:the\s+)?web|sourced\s+(?:answer|report|conclusion)|market\s+research|competitor\s+research|带来源|带引用|来源链接|网页调研|网络调研|市场调研|竞品调研|查证并汇总|搜索.*(?:结论|报告)|调研.*(?:结论|报告)/i;
const WEB_SEARCH_SIGNAL_ZH = /搜索网页|网页搜索|联网搜索|查找来源|检索网页|搜索来源/i;
const WEB_EXTRACT_SIGNAL_ZH = /提取网页|抽取网页|提取正文|抽取正文|提取表格|打开网页|结构化参数|详细参数/i;
const WEB_RESEARCH_SIGNAL_ZH = /带来源|带引用|来源链接|网页调研|网络调研|市场调研|竞品调研|查证并汇总|调研.*(?:结论|报告|方案)|车系盘账|品牌.*车系.*款/i;
const LOCAL_COMMAND_SIGNAL =
  /\bnpm\b|\bnode\b|\bpython\b|\bpytest\b|\btsx\b|\btsc\b|\bpnpm\b|\byarn\b|\bbuild\b|\btypecheck\b|\btest\b|command|script|CLI|shell|terminal|命令|脚本|终端|构建|类型检查/i;
const CODE_SEARCH_SIGNAL =
  /\brg\b|ripgrep|search|grep|find\s+(?:the\s+)?file|locate|symbol|call\s*site|route|entry\s*point|where\s+is|代码搜索|查找代码|定位文件|调用点|入口/i;
const TEST_SELECTION_SIGNAL =
  /which\s+tests|what\s+tests|tests?\s+to\s+run|decide\s+(?:which\s+)?tests?|test\s+scope|coverage|regression|smoke|typecheck|verification\s+scope|测试范围|跑哪些测试|回归|冒烟|验证范围/i;
const REPRO_SIGNAL =
  /reproduce|repro|bug|issue|复现|重现|问题/i;
const REGRESSION_SIGNAL =
  /regression|smoke|release|回归|冒烟|发布/i;
const HEALTH_SIGNAL =
  /health|status|runtime|server|panel|daemon|环境|健康|状态|服务/i;
const LOG_SIGNAL =
  /log|trace|error|exception|jsonl|日志|报错|异常|堆栈/i;
const STUCK_SIGNAL =
  /stuck|blocked|stall|missing\s*report|卡住|阻塞|无回执|没报告/i;
const OBSERVATION_SIGNAL =
  /observation|observe|记录|观察/i;
const RISK_SIGNAL =
  /risk|gap|unsafe|风险|差距|缺口/i;
const PROMOTION_SIGNAL =
  /promot|ADR|absorb|晋升|吸收|提案/i;

const RULES: RuleDef[] = [
  {
    role: "*",
    skillId: "windows-use",
    reason: "The task needs an approved native Windows application controlled through the Cursor capability bus.",
    priority: 4,
    test: (c) => WINDOWS_USE_SIGNAL.test(c.text),
  },
  {
    role: "*",
    skillId: "web-research",
    reason: "The task needs end-to-end web research with extracted evidence and sourced conclusions.",
    priority: 5,
    test: (c) => WEB_RESEARCH_SIGNAL.test(c.text) || WEB_RESEARCH_SIGNAL_ZH.test(c.text),
  },
  {
    role: "*",
    skillId: "web-search",
    reason: "The task needs web query construction, discovery, and source selection.",
    priority: 6,
    test: (c) => WEB_SEARCH_SIGNAL.test(c.text) || WEB_SEARCH_SIGNAL_ZH.test(c.text) || WEB_RESEARCH_SIGNAL.test(c.text) || WEB_RESEARCH_SIGNAL_ZH.test(c.text),
  },
  {
    role: "*",
    skillId: "web-extract",
    reason: "The task needs webpage正文 or table extraction with source_url preservation.",
    priority: 7,
    test: (c) => WEB_EXTRACT_SIGNAL.test(c.text) || WEB_EXTRACT_SIGNAL_ZH.test(c.text) || WEB_RESEARCH_SIGNAL.test(c.text) || WEB_RESEARCH_SIGNAL_ZH.test(c.text),
  },
  {
    role: "*",
    skillId: "browser-playwright-check",
    reason: "The task needs browser automation, screenshots, viewport checks, or interactive web verification.",
    priority: 15,
    test: (c) =>
      BROWSER_AUTOMATION_SIGNAL.test(c.text) &&
      !WEB_RESEARCH_SIGNAL.test(c.text) &&
      !WEB_EXTRACT_SIGNAL.test(c.text),
  },
  {
    role: "*",
    skillId: "code-search-navigation",
    reason: "The task needs code discovery before editing or explaining implementation boundaries.",
    priority: 16,
    test: (c) => CODE_SEARCH_SIGNAL.test(c.text),
  },
  {
    role: "*",
    skillId: "run-local-command-check",
    reason: "The task needs local command, script, build, typecheck, or CLI evidence.",
    priority: 17,
    test: (c) => LOCAL_COMMAND_SIGNAL.test(c.text),
  },
  {
    role: "*",
    skillId: "test-selection",
    reason: "The task needs an explicit verification or test-scope decision.",
    priority: 18,
    test: (c) => TEST_SELECTION_SIGNAL.test(c.text),
  },
  {
    role: "PM",
    skillId: "pm-tech-scope",
    reason: "PM is dispatching downstream work and the stack/runtime is not explicit.",
    priority: 10,
    test: (c) => {
      if (c.intent === "chat") return false;
      if (isPmDispatchForbiddenBody(c.text) || isTaskHotPathBody(c.text)) {
        return false;
      }
      const downstream = /^(DEV|QA|OPS)$/i.test(c.downstreamRole ?? "");
      return (downstream || DISPATCH_SIGNAL.test(c.text)) && !STACK_SIGNAL.test(c.text);
    },
  },
  {
    role: "PM",
    skillId: "pm-product-requirements",
    reason: "The task asks for requirement or PRD shaping.",
    priority: 20,
    test: (c) => REQUIREMENTS_SIGNAL.test(c.text),
  },
  {
    role: "PM",
    skillId: "pm-acceptance-criteria",
    reason: "The task needs acceptance criteria or done definition.",
    priority: 25,
    test: (c) => ACCEPTANCE_SIGNAL.test(c.text),
  },
  {
    role: "PM",
    skillId: "pm-scope-control",
    reason: "The task contains scope or boundary-control signals.",
    priority: 30,
    test: (c) => SCOPE_SIGNAL.test(c.text),
  },
  {
    role: "PM",
    skillId: "pm-priority-triage",
    reason: "The task needs priority, urgency, or patrol triage.",
    priority: 35,
    test: (c) => c.intent === "patrol" || PRIORITY_SIGNAL.test(c.text),
  },
  {
    role: "PM",
    skillId: "pm-architecture-review",
    reason: "The task references architecture, ADR, or technical design.",
    priority: 40,
    test: (c) => ARCH_SIGNAL.test(c.text),
  },
  {
    role: "PM",
    skillId: "pm-delivery-plan",
    reason: "The task needs delivery planning, milestones, or release timing.",
    priority: 45,
    test: (c) => DELIVERY_SIGNAL.test(c.text),
  },
  {
    role: "DEV",
    skillId: "dev-code-location",
    reason: "DEV needs to locate the relevant code path before changing it.",
    priority: 10,
    test: (c) => CODE_LOCATE_SIGNAL.test(c.text),
  },
  {
    role: "DEV",
    skillId: "dev-small-scope-patch",
    reason: "DEV is authorized to make a narrow implementation or fix.",
    priority: 20,
    test: (c) => c.intent === "task" || PATCH_SIGNAL.test(c.text),
  },
  {
    role: "DEV",
    skillId: "dev-test-and-explain",
    reason: "DEV must verify the change and explain evidence.",
    priority: 30,
    test: (c) => TEST_SIGNAL.test(c.text),
  },
  {
    role: "QA",
    skillId: "qa-reproduce-issue",
    reason: "QA needs to reproduce or characterize an issue.",
    priority: 10,
    test: (c) => REPRO_SIGNAL.test(c.text),
  },
  {
    role: "QA",
    skillId: "qa-verify-fix",
    reason: "QA needs to verify a reported fix against acceptance criteria.",
    priority: 20,
    test: (c) => c.intent === "verify" || /fix|修复/.test(c.text),
  },
  {
    role: "QA",
    skillId: "qa-regression-check",
    reason: "QA needs regression, smoke, or release-oriented checks.",
    priority: 30,
    test: (c) => REGRESSION_SIGNAL.test(c.text),
  },
  {
    role: "OPS",
    skillId: "ops-runtime-health",
    reason: "OPS needs runtime, panel, daemon, or environment health checks.",
    priority: 10,
    test: (c) => c.intent === "diagnose" || HEALTH_SIGNAL.test(c.text),
  },
  {
    role: "OPS",
    skillId: "ops-log-diagnosis",
    reason: "OPS needs log or error diagnosis.",
    priority: 20,
    test: (c) => LOG_SIGNAL.test(c.text),
  },
  {
    role: "OPS",
    skillId: "ops-stuck-workflow",
    reason: "OPS needs to diagnose a stuck workflow or missing report.",
    priority: 30,
    test: (c) => STUCK_SIGNAL.test(c.text),
  },
  {
    role: "EVAL",
    skillId: "eval-observation-writing",
    reason: "EVAL needs to write or review an observation.",
    priority: 10,
    test: (c) => OBSERVATION_SIGNAL.test(c.text),
  },
  {
    role: "EVAL",
    skillId: "eval-risk-gap-analysis",
    reason: "EVAL needs risk or gap analysis.",
    priority: 20,
    test: (c) => RISK_SIGNAL.test(c.text),
  },
  {
    role: "EVAL",
    skillId: "eval-promotion-advice",
    reason: "EVAL needs promotion or protocol absorption advice.",
    priority: 30,
    test: (c) => PROMOTION_SIGNAL.test(c.text),
  },
];

function roleKey(role: string): string {
  return String(role ?? "").trim().toUpperCase();
}

function allowedGroupsForRole(role: string): Set<string> {
  return new Set(ROLE_GROUPS[roleKey(role)] ?? ["common_skills"]);
}

function matchContextSkills(
  opts: ResolveSkillContextOpts,
): SkillContextMatch[] {
  const role = roleKey(opts.role);
  if (!role) return [];
  const ctx: RuleContext = {
    role,
    text: String(opts.message ?? ""),
    intent: opts.intent ?? "task",
    downstreamRole: opts.downstreamRole,
  };
  const hits = RULES.filter(
    (r) => (r.role === role || r.role === "*") && r.test(ctx),
  ).sort(
    (a, b) => a.priority - b.priority,
  );
  const productRequired =
    role === "PM" && classifyProductTask(ctx.text).product_design_required;
  const max = productRequired
    ? Math.max(opts.maxSkills ?? 3, PRODUCT_DESIGN_REQUIRED_SKILLS.length)
    : opts.maxSkills ?? 3;
  const seen = new Set<string>();
  const out: SkillContextMatch[] = [];
  if (productRequired) {
    for (const skillId of PRODUCT_DESIGN_REQUIRED_SKILLS) {
      seen.add(skillId);
      out.push({
        skillId,
        reason: "Product-delivery gate requires this PM/UI playbook before downstream dispatch.",
      });
    }
  }
  for (const hit of hits) {
    if (out.length >= max) break;
    if (seen.has(hit.skillId)) continue;
    seen.add(hit.skillId);
    out.push({ skillId: hit.skillId, reason: hit.reason });
    if (out.length >= max) break;
  }
  return out;
}

export function matchAgentContextSkills(
  opts: ResolveSkillContextOpts,
): SkillContextMatch[] {
  return matchContextSkills(opts);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function enrichMatchesFromManifest(
  matches: SkillContextMatch[],
  manifest: Record<string, unknown>,
  role: string,
): SkillContextMatch[] {
  const groups = allowedGroupsForRole(role);
  const byId = new Map<string, Record<string, unknown> & { groupKey: string }>();
  for (const groupKey of groups) {
    const rawList = manifest[groupKey];
    if (!Array.isArray(rawList)) continue;
    for (const raw of rawList) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      const id = str(entry["id"]).trim();
      if (id) byId.set(id, { ...entry, groupKey });
    }
  }
  const out: SkillContextMatch[] = [];
  for (const m of matches) {
    const entry = byId.get(m.skillId);
    if (!entry) continue;
    out.push({
      ...m,
      displayName: str(entry["display_name"]) || m.skillId,
      skillPackage: str(entry["skill_package"]) || undefined,
      status: str(entry["status"]) || undefined,
      groupKey: entry.groupKey,
    });
  }
  return out;
}

async function readSkillExcerpt(
  projectRoot: string,
  skillPackage: string | undefined,
  maxChars: number,
): Promise<string | undefined> {
  if (!skillPackage) return undefined;
  const rel = skillPackage.replace(/^\/+/, "");
  try {
    const path = await resolveSkillAssetPath(projectRoot, rel);
    if (!path) return undefined;
    const raw = await readFile(path, "utf8");
    const trimmed = raw.trim();
    if (trimmed.length <= maxChars) return trimmed;
    return `${trimmed.slice(0, maxChars)}\n...(truncated; see ${rel})`;
  } catch {
    return undefined;
  }
}

export function formatSkillContextAutoInjectBlock(
  role: string,
  matches: SkillContextMatch[],
  excerpts?: Map<string, string>,
): string {
  if (!matches.length) return "";
  const lines = [
    `## Auto-loaded ${roleKey(role)} Playbook Skills`,
    "",
    "Loaded by context. Use these pocket manuals only for this task; do not load the full skill catalog.",
    "",
  ];
  for (const m of matches) {
    lines.push(`### ${m.displayName ?? m.skillId} (\`${m.skillId}\`)`);
    lines.push(`- Match reason: ${m.reason}`);
    if (m.status) lines.push(`- Status: \`${m.status}\``);
    if (m.skillPackage) lines.push(`- Package: \`${m.skillPackage}\``);
    const excerpt = excerpts?.get(m.skillId);
    if (excerpt) {
      lines.push("");
      lines.push("```markdown");
      lines.push(excerpt);
      lines.push("```");
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export async function resolveAndInjectAgentContextSkills(
  projectRoot: string,
  opts: ResolveSkillContextOpts,
): Promise<ResolveSkillContextResult> {
  const role = roleKey(opts.role);
  if (!role) {
    return { matches: [], skillIds: [], promptBlock: "" };
  }

  const rawMatches = matchContextSkills(opts);
  if (!rawMatches.length) return { matches: [], skillIds: [], promptBlock: "" };

  let matches = rawMatches;
  try {
    const resolved = await readAgentSkillsManifestResolved(projectRoot);
    matches = enrichMatchesFromManifest(rawMatches, resolved.data, role);
  } catch {
    /* keep heuristic matches without display metadata */
  }

  if (!matches.length) return { matches: [], skillIds: [], promptBlock: "" };

  const excerpts = new Map<string, string>();
  if (opts.includeExcerpts !== false) {
    for (const m of matches) {
      const excerpt = await readSkillExcerpt(
        projectRoot,
        m.skillPackage,
        opts.excerptMaxChars ?? 900,
      );
      if (excerpt) excerpts.set(m.skillId, excerpt);
    }
  }

  let promptBlock = formatSkillContextAutoInjectBlock(role, matches, excerpts);
  if (
    role === "PM" &&
    opts.taskId &&
    matches.some((match) => match.skillId === "pm-product-design-brief")
  ) {
    promptBlock += `\n\n## Product Design Gate (runtime-enforced) — CodeFlowMu Dev-Team PM Planning\nThis is a CodeFlowMu development-team workflow above FCoP, not an FCoP core-protocol rule. Runtime classifies the root task as Level 0-3. Before the first write_task to DEV/QA/OPS, complete the matching PLAN (Level 1/2) or Product Brief (Level 3) by calling \`pm.write_planning_artifact\` with Markdown body only. Runtime will write Level 3 to \`fcop/internal/product-briefs/PRODUCT-BRIEF-${opts.taskId}.md\` and Level 1/2 to the corresponding \`PLAN-${opts.taskId}.md\`. Do not use shell, Python, native edit, or hand-written YAML to create the planning file; Runtime selects the canonical path and frontmatter. Auto-injected guidance is recommendation only and is never execution evidence. For every required Level 3 skill, read and apply it, then call \`pm.record_planning_skill_evidence\` with task_id, Runtime session_id (added automatically), input context, output summary, matching brief section, and affected product decisions. Never append \`.codeflowmu/skill-invocations.jsonl\` by shell or script.`;
  }
  const skillIds = matches.map((m) => m.skillId);

  if (opts.recordJournal !== false) {
    for (const m of matches) {
      await recordSkillInvocation(projectRoot, {
        skill_id: m.skillId,
        ...(m.displayName && m.displayName !== m.skillId
          ? { skill_display_name: m.displayName }
          : {}),
        channel: "auto_inject",
        caller_role: role,
        task_id: opts.taskId,
        thread_key: opts.threadKey,
        outcome: "ok",
        summary: `auto_inject recommendation only (not execution evidence): ${m.reason}`.slice(0, 500),
        triggered_by: opts.intent ?? "task",
      });
    }
  }

  return { matches, skillIds, promptBlock };
}
