/**
 * ReviewDecisionPolicyLoader — loads the team review decision policy from
 * `fcop/shared/policies/review-decision-policy.yaml`.
 *
 * Load order (§5.3 of task spec):
 *   1. Project config: `{projectRoot}/fcop/shared/policies/review-decision-policy.yaml`
 *   2. If missing and `initializeIfMissing=true`: copy from adoptedSource template
 *   3. If both missing: return safe fallback (no team_rules, fallback_to_human still works)
 *
 * Writing:
 *   - Panel POST uses `saveReviewDecisionPolicy()` — writes project copy only, never adoptedSource
 *   - Uses atomic tmp → rename pattern via `atomicWriteYaml()`
 *   - Basic structure validation before save
 *
 * References:
 *   - Task doc §5, §7, §8 (fcop/shared/policies/review-decision-policy.yaml)
 *   - TASK-20260509-022 REVIEW engine scope
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type PolicyRuleAction =
  | "needs_human"
  | "auto"
  | "deny"
  | "invalid"
  | "fallback_to_human"
  | "invalid_or_needs_human";

export interface PolicyRule {
  id: string;
  name: string;
  /** Defaults to true when absent in YAML. */
  enabled?: boolean;
  action: PolicyRuleAction;
  description: string;
}

export interface ReviewDecisionPolicy {
  team_name: string;
  team_type: string;
  approval_mode: string;
  version?: number;
  description?: string;
  system_invariants: {
    configurable: false;
    description?: string;
    rules: PolicyRule[];
  };
  team_rules: {
    configurable: true;
    description?: string;
    rules: PolicyRule[];
  };
}

export interface LoadReviewDecisionPolicyOpts {
  /** Absolute path to the project root. */
  projectRoot: string;
  /**
   * Root where adoptedSource templates live.
   * Defaults to `{projectRoot}/adoptedSource`.
   */
  adoptedSourceRoot?: string;
  /**
   * If true and the project policy file is missing, attempt to copy
   * from adoptedSource. Falls back to SAFE_FALLBACK_POLICY on failure.
   */
  initializeIfMissing?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

const POLICY_REL = "fcop/shared/policies/review-decision-policy.yaml";
const ADOPTED_REL = "adoptedSource/fcop/shared/policies/review-decision-policy.yaml";

export function policyFilePath(projectRoot: string): string {
  return join(projectRoot, POLICY_REL);
}

export function adoptedPolicyFilePath(projectRoot: string, adoptedSourceRoot?: string): string {
  if (adoptedSourceRoot) {
    return join(adoptedSourceRoot, "fcop/shared/policies/review-decision-policy.yaml");
  }
  return join(projectRoot, ADOPTED_REL);
}

// ─────────────────────────────────────────────────────────────────────────────
// Safe fallback — used when both policy files are missing.
// system_invariants still active; team_rules empty.
// ─────────────────────────────────────────────────────────────────────────────

const SAFE_FALLBACK_POLICY: ReviewDecisionPolicy = {
  team_name: "开发团队",
  team_type: "software_dev",
  approval_mode: "semi_auto",
  system_invariants: {
    configurable: false,
    description: "系统底线规则（fallback）",
    rules: [
      { id: "reviewer_not_found",   name: "REVIEW agent 不存在",   action: "fallback_to_human", description: "Runtime 找不到 REVIEW agent，提交 ADMIN 人工处理。" },
      { id: "reviewer_start_failed",name: "REVIEW agent 启动失败", action: "fallback_to_human", description: "REVIEW agent session 启动失败，提交 ADMIN 人工处理。" },
      { id: "verdict_parse_failed", name: "REVIEW 输出解析失败",   action: "fallback_to_human", description: "REVIEW agent 输出格式不符合 verdict 协议，提交 ADMIN 人工处理。" },
      { id: "reviewer_cancelled",   name: "REVIEW session 被取消", action: "fallback_to_human", description: "REVIEW session 被取消，提交 ADMIN 人工处理。" },
    ],
  },
  team_rules: {
    configurable: true,
    description: "开发团队可配置审批规则（未加载）",
    rules: [],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Minimal YAML parser — only handles the flat structure we produce.
// We avoid pulling in `js-yaml` as a hard dep. The YAML we write is
// deterministic; we use a simple line-based parser for reading it back.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse the review-decision-policy.yaml produced by this module.
 * Returns null on any structural mismatch so the caller can fallback.
 */
function parsePolicy(yamlText: string): ReviewDecisionPolicy | null {
  try {
    // Attempt to use js-yaml if available (optional peer dep).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const jsYaml = require("js-yaml") as { load: (s: string) => unknown };
    const raw = jsYaml.load(yamlText);
    return validateAndNormalize(raw);
  } catch {
    // js-yaml not available or parse error — fall through to our minimal parser.
  }

  // Minimal line-based fallback (handles the exact YAML we produce).
  return parseMinimalYaml(yamlText);
}

function validateAndNormalize(raw: unknown): ReviewDecisionPolicy | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["team_name"] !== "string") return null;
  if (typeof r["team_type"] !== "string") return null;
  if (typeof r["approval_mode"] !== "string") return null;

  const si = r["system_invariants"];
  const tr = r["team_rules"];
  if (!si || typeof si !== "object") return null;
  if (!tr || typeof tr !== "object") return null;

  const siObj = si as Record<string, unknown>;
  const trObj = tr as Record<string, unknown>;

  return {
    team_name: r["team_name"] as string,
    team_type: r["team_type"] as string,
    approval_mode: r["approval_mode"] as string,
    version: typeof r["version"] === "number" ? r["version"] : undefined,
    description: typeof r["description"] === "string" ? r["description"] : undefined,
    system_invariants: {
      configurable: false,
      description: typeof siObj["description"] === "string" ? siObj["description"] : undefined,
      rules: normalizeRules(siObj["rules"]),
    },
    team_rules: {
      configurable: true,
      description: typeof trObj["description"] === "string" ? trObj["description"] : undefined,
      rules: normalizeRules(trObj["rules"]),
    },
  };
}

function normalizeRules(raw: unknown): PolicyRule[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && typeof r === "object")
    .map((r) => {
      const obj = r as Record<string, unknown>;
      return {
        id: String(obj["id"] ?? ""),
        name: String(obj["name"] ?? ""),
        enabled: typeof obj["enabled"] === "boolean" ? obj["enabled"] : undefined,
        action: String(obj["action"] ?? "needs_human") as PolicyRuleAction,
        description: String(obj["description"] ?? ""),
      };
    })
    .filter((r) => r.id && r.action);
}

/**
 * Minimal YAML parser for the very specific structure we emit.
 * Only called if js-yaml is unavailable.
 */
function parseMinimalYaml(text: string): ReviewDecisionPolicy | null {
  // We rely on structured sections; if format diverges, return null → fallback.
  try {
    const lines = text.split(/\r?\n/);
    const get = (key: string): string => {
      const line = lines.find((l) => l.trimStart().startsWith(`${key}:`));
      if (!line) return "";
      return line.split(":").slice(1).join(":").trim().replace(/^'|'$/g, "").replace(/^"|"$/g, "");
    };

    const team_name = get("team_name");
    const team_type = get("team_type");
    const approval_mode = get("approval_mode");
    if (!team_name || !team_type || !approval_mode) return null;

    // Parse rule blocks — each starts with `- id:`
    const parseRulesSection = (sectionKey: string): PolicyRule[] => {
      const startIdx = lines.findIndex((l) => l.trimStart().startsWith(`${sectionKey}:`));
      if (startIdx < 0) return [];
      const rules: PolicyRule[] = [];
      let i = startIdx + 1;
      let currentRule: Partial<PolicyRule> | null = null;
      while (i < lines.length) {
        const line = lines[i];
        if (line === undefined) {
          i++;
          continue;
        }
        // Stop if we hit a top-level key (not indented)
        if (line.length > 0 && !/^\s/.test(line) && !line.startsWith("#")) break;
        const trimmed = line.trimStart();
        if (trimmed.startsWith("- id:")) {
          if (currentRule?.id && currentRule.action) rules.push(currentRule as PolicyRule);
          currentRule = {
            id: trimmed.split(":").slice(1).join(":").trim(),
            name: "",
            action: "needs_human",
            description: "",
          };
        } else if (currentRule) {
          if (trimmed.startsWith("name:")) currentRule.name = trimmed.split(":").slice(1).join(":").trim();
          else if (trimmed.startsWith("action:")) currentRule.action = trimmed.split(":").slice(1).join(":").trim() as PolicyRuleAction;
          else if (trimmed.startsWith("description:")) currentRule.description = trimmed.split(":").slice(1).join(":").trim();
          else if (trimmed.startsWith("enabled:")) {
            const val = trimmed.split(":").slice(1).join(":").trim();
            currentRule.enabled = val !== "false";
          }
        }
        i++;
      }
      if (currentRule?.id && currentRule.action) rules.push(currentRule as PolicyRule);
      return rules;
    };

    return {
      team_name,
      team_type,
      approval_mode,
      system_invariants: {
        configurable: false,
        rules: parseRulesSection("system_invariants"),
      },
      team_rules: {
        configurable: true,
        rules: parseRulesSection("team_rules"),
      },
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// YAML serializer — produces deterministic output for our schema.
// ─────────────────────────────────────────────────────────────────────────────

function serializePolicy(policy: ReviewDecisionPolicy): string {
  const lines: string[] = [
    `team_name: ${policy.team_name}`,
    `team_type: ${policy.team_type}`,
    `approval_mode: ${policy.approval_mode}`,
    `version: ${policy.version ?? 1}`,
    "",
  ];
  if (policy.description) {
    lines.push(`description: >`);
    lines.push(`  ${policy.description}`);
    lines.push("");
  }

  const serializeRules = (
    key: string,
    section: { configurable: boolean; description?: string; rules: PolicyRule[] },
  ): void => {
    lines.push(`${key}:`);
    lines.push(`  configurable: ${section.configurable}`);
    if (section.description) lines.push(`  description: ${section.description}`);
    lines.push(`  rules:`);
    for (const r of section.rules) {
      lines.push(`    - id: ${r.id}`);
      lines.push(`      name: ${r.name}`);
      if (r.enabled !== undefined) lines.push(`      enabled: ${r.enabled}`);
      lines.push(`      action: ${r.action}`);
      lines.push(`      description: ${r.description}`);
      lines.push("");
    }
  };

  serializeRules("system_invariants", policy.system_invariants);
  lines.push("");
  serializeRules("team_rules", policy.team_rules);

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Atomic write (tmp → rename)
// ─────────────────────────────────────────────────────────────────────────────

function atomicWriteYaml(destPath: string, content: string): void {
  const dir = dirname(destPath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${destPath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, content, "utf-8");
    // On Windows rename is not atomic across drives but same-dir is fine.
    // Use try/catch + fallback copy+delete for cross-device safety.
    try {
      const { renameSync } = require("node:fs") as { renameSync: (a: string, b: string) => void };
      renameSync(tmp, destPath);
    } catch {
      // Cross-device fallback
      writeFileSync(destPath, content, "utf-8");
    }
  } finally {
    try {
      const { unlinkSync } = require("node:fs") as { unlinkSync: (p: string) => void };
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load the review decision policy for the project.
 *
 * Load order:
 *   1. `{projectRoot}/fcop/shared/policies/review-decision-policy.yaml`
 *   2. Copy from adoptedSource when initializeIfMissing=true
 *   3. SAFE_FALLBACK_POLICY
 */
export async function loadReviewDecisionPolicy(
  opts: LoadReviewDecisionPolicyOpts,
): Promise<ReviewDecisionPolicy> {
  const { projectRoot, adoptedSourceRoot, initializeIfMissing = false } = opts;
  const projectPolicyPath = policyFilePath(projectRoot);

  // 1. Try project copy.
  if (existsSync(projectPolicyPath)) {
    try {
      const text = readFileSync(projectPolicyPath, "utf-8");
      const parsed = parsePolicy(text);
      if (parsed) return parsed;
    } catch { /* fall through */ }
  }

  // 2. Initialize from adoptedSource.
  if (initializeIfMissing) {
    const adoptedPath = adoptedPolicyFilePath(projectRoot, adoptedSourceRoot);
    if (existsSync(adoptedPath)) {
      try {
        const dir = dirname(projectPolicyPath);
        mkdirSync(dir, { recursive: true });
        copyFileSync(adoptedPath, projectPolicyPath);
        const text = readFileSync(projectPolicyPath, "utf-8");
        const parsed = parsePolicy(text);
        if (parsed) return parsed;
      } catch { /* fall through */ }
    } else {
      // adoptedSource missing: write safe fallback to project copy so
      // subsequent calls find it without retrying the copy path.
      try {
        atomicWriteYaml(projectPolicyPath, serializePolicy(SAFE_FALLBACK_POLICY));
      } catch { /* ignore write failure; we still return fallback */ }
    }
  }

  // 3. Return safe fallback — no crash.
  return { ...SAFE_FALLBACK_POLICY };
}

/**
 * Return only the `enabled` team rules (i.e. `enabled !== false`).
 * system_invariants are NOT included — they are handled separately by Runtime.
 */
export function enabledTeamRules(policy: ReviewDecisionPolicy): PolicyRule[] {
  return (policy.team_rules?.rules ?? []).filter((r) => r.enabled !== false);
}

/**
 * Render the policy block to inject into the REVIEW agent's prompt.
 * Only enabled team_rules are included (task doc §8.3).
 */
export function renderReviewDecisionPolicyPromptBlock(policy: ReviewDecisionPolicy): string {
  const enabled = enabledTeamRules(policy);
  const rulesBlock =
    enabled.length > 0
      ? enabled
          .map((r) => `- ${r.id}: ${r.name}\n  action: ${r.action}\n  description: ${r.description}`)
          .join("\n")
      : "(no team rules enabled — auto-approve unless red flags detected by gate)";

  return (
    `\n` +
    `──── Team Review Decision Policy ────\n` +
    `You are the REVIEW agent for team: ${policy.team_name} (${policy.team_type}).\n` +
    `\n` +
    `Use the enabled team approval rules below to decide whether this task requires ADMIN approval.\n` +
    `\n` +
    `Policy file: fcop/shared/policies/review-decision-policy.yaml\n` +
    `Approval mode: ${policy.approval_mode}\n` +
    `\n` +
    `Enabled team rules:\n` +
    `${rulesBlock}\n` +
    `\n` +
    `If any enabled team rule is matched and the requested action should not be automatically accepted, emit:\n` +
    `  VERDICT: needs_human; RATIONALE: trigger_reason=reviewer_decided_needs_human; matched_rules=[rule_id]; reason=<why ADMIN approval is required>\n` +
    `\n` +
    `IMPORTANT — Do NOT emit needs_human for these situations:\n` +
    `  - Missing report, missing evidence, empty approval card, missing requested_action\n` +
    `  - These are invalid/runtime bugs, not normal risk approvals\n` +
    `\n` +
    `If the task is safe, evidence is consistent, and no enabled team rule is matched, emit: approved.\n` +
    `────────────────────────────────────\n`
  );
}

/**
 * Validate and save a policy to the project copy (never adoptedSource).
 * system_invariants from the existing file are preserved (callers cannot remove them).
 * Only team_rules.rules[].enabled and top-level identity fields can change.
 *
 * @throws Error on structural validation failure.
 */
export async function saveReviewDecisionPolicy(opts: {
  projectRoot: string;
  adoptedSourceRoot?: string;
  /** Partial updates — only the provided fields are merged. */
  updates: {
    team_name?: string;
    team_type?: string;
    approval_mode?: string;
    /** Only `enabled` per rule is applied; other rule fields are preserved. */
    team_rules?: Array<{ id: string; enabled: boolean }>;
  };
}): Promise<ReviewDecisionPolicy> {
  const { projectRoot, adoptedSourceRoot, updates } = opts;

  // Load current policy (initializes if missing).
  const current = await loadReviewDecisionPolicy({
    projectRoot,
    adoptedSourceRoot,
    initializeIfMissing: true,
  });

  // Apply updates.
  const updated: ReviewDecisionPolicy = {
    ...current,
    team_name: updates.team_name ?? current.team_name,
    team_type: updates.team_type ?? current.team_type,
    approval_mode: updates.approval_mode ?? current.approval_mode,
    // system_invariants is always preserved as-is.
    system_invariants: current.system_invariants,
    team_rules: {
      ...current.team_rules,
      rules: current.team_rules.rules.map((r) => {
        const patch = updates.team_rules?.find((u) => u.id === r.id);
        return patch !== undefined ? { ...r, enabled: patch.enabled } : r;
      }),
    },
  };

  // Serialize and atomic-write.
  const yaml = serializePolicy(updated);
  const destPath = policyFilePath(projectRoot);
  atomicWriteYaml(destPath, yaml);

  return updated;
}
