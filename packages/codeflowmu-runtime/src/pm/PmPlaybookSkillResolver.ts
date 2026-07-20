/**
 * PM playbook skill auto-resolution: keyword/heuristic matching + prompt injection
 * + recommendation journal (channel: auto_inject, never execution evidence).
 *
 * v1: inject guidance into PM prompts on dispatch/wake/patrol — does not execute
 * playbook steps programmatically (see docs/skills/pm-skills-mapping.md).
 */

import { readFile } from "node:fs/promises";

import { readAgentSkillsManifestResolved } from "../skills/AgentPlaybookCatalog.js";
import { resolveSkillAssetPath } from "../skills/SkillAssetResolver.js";
import {
  recordSkillInvocation,
  type SkillInvocationChannel,
} from "./SkillInvocationJournal.js";

export type PmPlaybookIntent =
  | "dispatch"
  | "patrol"
  | "wake"
  | "pm_task"
  | "chat";

export interface PmPlaybookMatch {
  skillId: string;
  reason: string;
  displayName?: string;
  skillPackage?: string;
}

export interface ResolvePmPlaybookSkillsOpts {
  role: string;
  message: string;
  intent: PmPlaybookIntent;
  /** When dispatching to DEV/QA/OPS — strengthens pm-tech-scope signal. */
  downstreamRole?: string;
  taskId?: string;
  threadKey?: string;
  sessionId?: string;
  /** Max skills to inject (default 3). */
  maxSkills?: number;
  /** Include SKILL.md excerpt in prompt (default true). */
  includeExcerpts?: boolean;
  /** Max chars per skill excerpt (default 900). */
  excerptMaxChars?: number;
  /** Write journal entries (default true when projectRoot set). */
  recordJournal?: boolean;
}

export interface ResolvePmPlaybookSkillsResult {
  matches: PmPlaybookMatch[];
  skillIds: string[];
  promptBlock: string;
}

const AUTO_INJECT_CHANNEL: SkillInvocationChannel = "auto_inject";

const STACK_SIGNAL =
  /python|typescript|javascript|node\.?js|react|vue|vite|webpack|html\/css|静态\s*html|技术栈|tech\s*stack|现有项目栈|framework|框架选型|runtime|go\b|rust\b|java\b|\.net/i;

const DISPATCH_DEV_SIGNAL =
  /write_task|recipient\s*[:=]\s*["']?(DEV|QA|OPS)|to-(DEV|QA|OPS)|派(?:给|发)?\s*(DEV|QA|开发|测试)/i;

const PRODUCT_DESIGN_SIGNAL =
  /产品方案|设计方案|产品级|产品定位|产品名称|目标用户|用户旅程|信息架构|页面结构|页面设计|交互|视觉|UI|UX|移动端|手机端|PWA|service\s*worker|manifest|离线|Gateway|公网|局域网|应用合并|合并.*应用|二次升级|版本升级|小应用|小游戏|dashboard|看板/i;

interface RuleDef {
  skillId: string;
  reason: string;
  priority: number;
  test: (text: string, intent: PmPlaybookIntent, downstream?: string) => boolean;
}

const PM_PLAYBOOK_RULES: RuleDef[] = [
  {
    skillId: "pm-product-design-brief",
    reason: "产品 / UI / PWA / 移动端 / 升级类任务需要 PM 先完成产品方案设计闸门",
    priority: 12,
    test: (text, intent) => {
      if (intent === "chat") return false;
      return PRODUCT_DESIGN_SIGNAL.test(text);
    },
  },
  {
    skillId: "pm-tech-scope",
    reason: "派下游开发/测试且技术栈或语言未在任务中明确",
    priority: 10,
    test: (text, intent, downstream) => {
      if (intent === "chat") return false;
      const devish =
        downstream != null && /^(DEV|QA|OPS)$/i.test(downstream.trim());
      const dispatchHint = DISPATCH_DEV_SIGNAL.test(text) || devish;
      if (!dispatchHint) return false;
      return !STACK_SIGNAL.test(text);
    },
  },
  {
    skillId: "pm-product-requirements",
    reason: "需求整理 / PRD / 用户故事类任务",
    priority: 20,
    test: (text) =>
      /需求整理|产品需求|PRD|user\s*stor|用户故事|需求澄清|requirement\s*doc/i.test(
        text,
      ),
  },
  {
    skillId: "pm-acceptance-criteria",
    reason: "验收标准 / AC 相关",
    priority: 25,
    test: (text) =>
      /验收标准|acceptance\s*criteria|\bAC\b|验收条件|完成定义|definition\s*of\s*done/i.test(
        text,
      ),
  },
  {
    skillId: "pm-scope-control",
    reason: "范围边界 / scope 控制",
    priority: 30,
    test: (text) =>
      /范围控制|scope\s*creep|超出范围|越界|scope\s*control|边界不清|做多了/i.test(
        text,
      ),
  },
  {
    skillId: "pm-priority-triage",
    reason: "优先级 / 紧急度分拣",
    priority: 35,
    test: (text, intent) => {
      if (intent === "patrol") return true;
      return /优先级|P0|P1|P2|triage|紧急|urgent|先做什么|排序/i.test(text);
    },
  },
  {
    skillId: "pm-architecture-review",
    reason: "架构 / ADR / 技术方案评审",
    priority: 40,
    test: (text) =>
      /架构评审|architecture\s*review|\bADR\b|技术方案|系统设计|模块划分|接口设计/i.test(
        text,
      ),
  },
  {
    skillId: "pm-delivery-plan",
    reason: "交付计划 / 排期 / 里程碑",
    priority: 45,
    test: (text) =>
      /交付计划|delivery\s*plan|sprint|排期|里程碑|迭代计划|上线计划|甘特/i.test(
        text,
      ),
  },
];

/**
 * Pure heuristic matcher — no filesystem I/O.
 */
export function matchPmPlaybookSkills(
  message: string,
  intent: PmPlaybookIntent,
  downstreamRole?: string,
  maxSkills = 3,
): PmPlaybookMatch[] {
  if (intent === "chat") return [];

  const text = String(message ?? "");
  const hits: Array<PmPlaybookMatch & { priority: number }> = [];

  for (const rule of PM_PLAYBOOK_RULES) {
    if (rule.test(text, intent, downstreamRole)) {
      hits.push({
        skillId: rule.skillId,
        reason: rule.reason,
        priority: rule.priority,
      });
    }
  }

  hits.sort((a, b) => a.priority - b.priority);

  const seen = new Set<string>();
  const out: PmPlaybookMatch[] = [];
  for (const h of hits) {
    if (seen.has(h.skillId)) continue;
    seen.add(h.skillId);
    out.push({
      skillId: h.skillId,
      reason: h.reason,
    });
    if (out.length >= maxSkills) break;
  }

  return out;
}

function enrichMatchesFromManifest(
  matches: PmPlaybookMatch[],
  resolved: Awaited<ReturnType<typeof readAgentSkillsManifestResolved>>,
): PmPlaybookMatch[] {
  const rawList = resolved.data["pm_playbook_skills"];
  const playbookList = Array.isArray(rawList)
    ? (rawList as Array<Record<string, unknown>>)
    : [];
  const byId = new Map(
    playbookList.map((s) => [String(s["id"] ?? "").trim(), s]),
  );
  return matches.map((m) => {
    const entry = byId.get(m.skillId);
    if (!entry) return m;
    return {
      ...m,
      displayName:
        (typeof entry["display_name"] === "string"
          ? entry["display_name"]
          : undefined) ?? m.skillId,
      skillPackage:
        typeof entry["skill_package"] === "string"
          ? entry["skill_package"]
          : undefined,
    };
  });
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
    return `${trimmed.slice(0, maxChars)}\n…（已截断，完整内容见 ${rel}）`;
  } catch {
    return undefined;
  }
}

export function formatPmPlaybookAutoInjectBlock(
  matches: PmPlaybookMatch[],
  excerpts: Map<string, string> | undefined,
): string {
  if (matches.length === 0) return "";

  const lines: string[] = [
    "## Auto-loaded PM Playbook Skills（系统自动匹配）",
    "",
    "以下 playbook 仅为系统推荐，不代表已执行。请实际读取、应用并在首次派单前提交 Runtime 技能证据。",
    "",
  ];

  for (const m of matches) {
    const label = m.displayName ?? m.skillId;
    lines.push(`### ${label} (\`${m.skillId}\`)`);
    lines.push(`- 匹配原因：${m.reason}`);
    if (m.skillPackage) {
      lines.push(`- 包路径：\`${m.skillPackage}\``);
    }
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

export async function resolveAndInjectPmPlaybookSkills(
  projectRoot: string,
  opts: ResolvePmPlaybookSkillsOpts,
): Promise<ResolvePmPlaybookSkillsResult> {
  const role = String(opts.role ?? "").trim();
  if (!/^PM$/i.test(role)) {
    return { matches: [], skillIds: [], promptBlock: "" };
  }

  const intent = opts.intent ?? "pm_task";
  if (intent === "chat") {
    return { matches: [], skillIds: [], promptBlock: "" };
  }

  const maxSkills = opts.maxSkills ?? 3;
  const includeExcerpts = opts.includeExcerpts !== false;
  const excerptMaxChars = opts.excerptMaxChars ?? 900;
  const recordJournal = opts.recordJournal !== false;

  let rawMatches = matchPmPlaybookSkills(
    opts.message,
    intent,
    opts.downstreamRole,
    maxSkills,
  );

  // Patrol with no keyword hits: still nudge priority triage once
  if (rawMatches.length === 0 && intent === "patrol") {
    rawMatches = [
      {
        skillId: "pm-priority-triage",
        reason: "巡检默认：快速扫描 open 任务优先级与阻塞",
      },
    ];
  }

  if (rawMatches.length === 0) {
    return { matches: [], skillIds: [], promptBlock: "" };
  }

  let manifest: Awaited<ReturnType<typeof readAgentSkillsManifestResolved>> | null =
    null;
  try {
    manifest = await readAgentSkillsManifestResolved(projectRoot);
  } catch {
    manifest = null;
  }

  const matches = manifest
    ? enrichMatchesFromManifest(rawMatches, manifest)
    : rawMatches;

  const excerpts = new Map<string, string>();
  if (includeExcerpts) {
    for (const m of matches) {
      const ex = await readSkillExcerpt(
        projectRoot,
        m.skillPackage,
        excerptMaxChars,
      );
      if (ex) excerpts.set(m.skillId, ex);
    }
  }

  const promptBlock = formatPmPlaybookAutoInjectBlock(matches, excerpts);
  const skillIds = matches.map((m) => m.skillId);

  if (recordJournal && projectRoot) {
    for (const m of matches) {
      await recordSkillInvocation(projectRoot, {
        skill_id: m.skillId,
        ...(m.displayName && m.displayName !== m.skillId
          ? { skill_display_name: m.displayName }
          : {}),
        channel: AUTO_INJECT_CHANNEL,
        caller_role: "PM",
        task_id: opts.taskId,
        thread_key: opts.threadKey,
        outcome: "ok",
        summary: `auto_inject: ${m.reason}`.slice(0, 500),
        triggered_by: intent,
      });
    }
  }

  return { matches, skillIds, promptBlock };
}
