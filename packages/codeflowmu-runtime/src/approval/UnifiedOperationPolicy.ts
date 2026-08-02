import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";

import type {
  OperationEffects,
  PrepareOperationInput,
} from "./OperationApprovalService.ts";
import { buildWorkspaceOperationApprovalInput } from "./WorkspaceOperationApproval.ts";
import type { WorkspaceExecutorName } from "./WorkspaceOperationApproval.ts";

export const APPROVAL_ADAPTER_REQUIRED = "APPROVAL_ADAPTER_REQUIRED";
export const ABSOLUTELY_PROHIBITED = "ABSOLUTELY_PROHIBITED";
export const UNIFIED_OPERATION_POLICY_FEATURE_FLAG = "CODEFLOWMU_UNIFIED_OPERATION_POLICY_ENABLED";

export type UnifiedPolicyDecision =
  | {
      decision: "ALLOW";
      rule_ids: string[];
      classification: string;
      effects: OperationEffects;
      targets: string[];
      reason: string;
    }
  | {
      decision: "REQUIRE_APPROVAL";
      rule_ids: string[];
      input: PrepareOperationInput;
      executor: string;
      operation_fingerprint: string;
      resume_strategy: "controlled_execute" | "capability_lease";
    }
  | {
      decision: "DENY";
      rule_ids: string[];
      code: string;
      reason: string;
      next_safe_action: string;
      effects: OperationEffects;
      targets: string[];
    };

export type UnifiedOperationInput = {
  toolName: string;
  args: Record<string, unknown>;
  projectRoot: string;
  projectId: string;
  agentId: string;
  sessionId?: string;
  taskId?: string;
};

type ResolvedIntent = {
  kind: "read" | "write" | "mkdir" | "delete" | "copy" | "move" | "patch" | "unknown";
  targets: string[];
  sources: string[];
  command: string;
  effects: OperationEffects;
};

function roleFromAgentId(agentId: string): string {
  return agentId.trim().split(/[-_:]/, 1)[0]?.toUpperCase() || "UNKNOWN";
}

function normalizedToolName(toolName: string): string {
  return String(toolName ?? "").trim().toLowerCase().replace(/^.*[.:/]/, "");
}

function commandFrom(args: Record<string, unknown>): string {
  for (const key of ["command", "cmd", "script", "input"]) {
    if (typeof args[key] === "string") return String(args[key]);
  }
  return "";
}

function directPaths(args: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const key of [
    "path", "file", "file_path", "filePath", "target", "target_path",
    "targetFile", "destination", "destinationPath",
  ]) {
    if (typeof args[key] === "string" && String(args[key]).trim()) {
      values.push(String(args[key]).trim());
    }
  }
  for (const key of ["targets", "allowed_paths"]) {
    if (Array.isArray(args[key])) {
      for (const value of args[key]) {
        if (typeof value === "string" && value.trim()) values.push(value.trim());
      }
    }
  }
  return [...new Set(values)];
}

function directSources(args: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const key of ["source", "source_path", "sourcePath"]) {
    if (typeof args[key] === "string" && String(args[key]).trim()) {
      values.push(String(args[key]).trim());
    }
  }
  return [...new Set(values)];
}

function canonicalPath(projectRoot: string, raw: string): string {
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(projectRoot, raw);
  let probe = absolute;
  const missing: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    missing.unshift(probe.slice(parent.length).replace(/^[\\/]+/, ""));
    probe = parent;
  }
  try {
    return normalize(resolve(realpathSync.native(probe), ...missing));
  } catch {
    return normalize(absolute);
  }
}

function inside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function collectCommandWriteTargets(command: string): { targets: string[]; sources: string[]; kind: ResolvedIntent["kind"] } {
  const targets: string[] = [];
  const sources: string[] = [];
  let kind: ResolvedIntent["kind"] = "unknown";
  const add = (value: string | undefined, bucket = targets) => {
    const clean = String(value ?? "").trim();
    if (clean && !/^[,.)]+$/.test(clean) && !bucket.includes(clean)) bucket.push(clean);
  };

  const patterns: Array<{ kind: ResolvedIntent["kind"]; re: RegExp; group?: number }> = [
    { kind: "mkdir", re: /\b(?:mkdir|md|new-item)\b[^\r\n;|]*?(?:-Path\s+)?[rRuUbBfF]*(?:["'])([^"']+)["']/gi },
    { kind: "mkdir", re: /\b(?:mkdir|md)\b\s+([^\s"';|]+)/gi },
    { kind: "mkdir", re: /\bos\.makedirs?\s*\(\s*[rRuUbBfF]*["']([^"']+)["']/gi },
    { kind: "mkdir", re: /\b(?:mkdirSync|mkdir)\s*\(\s*["']([^"']+)["']/gi },
    { kind: "write", re: /\b(?:set-content|out-file|add-content)\b[^\r\n;|]*?(?:-Path|-FilePath)\s+["']([^"']+)["']/gi },
    { kind: "write", re: /\b(?:set-content|out-file|add-content)\b\s+(?:-(?:Literal)?Path\s+)?["']?([^\s"';|]+)["']?/gi },
    { kind: "write", re: /\bopen\s*\(\s*[rRuUbBfF]*["']([^"']+)["']\s*,\s*["'][wax+]/gi },
    { kind: "write", re: /\b(?:writeFile|writeFileSync|createWriteStream)\s*\(\s*["']([^"']+)["']/gi },
    { kind: "write", re: /\bPath\s*\(\s*[rRuUbBfF]*["']([^"']+)["']\s*\)\s*\.write_(?:text|bytes)\s*\(/gi },
    { kind: "delete", re: /\b(?:remove-item|del|erase|unlinkSync|rmSync)\b[^\r\n;|]*?(?:-Path\s+)?["']([^"']+)["']/gi },
    { kind: "delete", re: /\b(?:remove-item|del|erase)\b\s+(?:-(?:Literal)?Path\s+)?["']?([^\s"';|]+)["']?/gi },
    { kind: "write", re: /(?:^|\s)(?:>>?|1>>?)\s*["']?([^"'\s;&|]+)["']?/gim },
  ];
  for (const entry of patterns) {
    let match: RegExpExecArray | null;
    while ((match = entry.re.exec(command)) !== null) {
      add(match[entry.group ?? 1]);
      if (kind === "unknown" || kind === "read") kind = entry.kind;
      if (entry.kind === "delete") kind = "delete";
    }
  }

  const copyMove = /\b(copy-item|move-item|copy|move)\b[^\r\n;|]*?(?:-Path\s+)?["']([^"']+)["'][^\r\n;|]*?(?:-Destination\s+)?["']([^"']+)["']/gi;
  let pair: RegExpExecArray | null;
  while ((pair = copyMove.exec(command)) !== null) {
    add(pair[2], sources);
    add(pair[3]);
    kind = /^move/i.test(pair[1] ?? "") ? "move" : "copy";
  }
  return { targets, sources, kind };
}

function resolveIntent(input: UnifiedOperationInput): ResolvedIntent {
  const tool = normalizedToolName(input.toolName);
  const command = commandFrom(input.args);
  const direct = directPaths(input.args);
  const sources = directSources(input.args);
  if (command) {
    const parsed = collectCommandWriteTargets(command);
    const unresolvedDynamicMutation = /(?:-EncodedCommand\b|\bfrombase64string\b|\beval\s*\(|\bexec\s*\()/i.test(command);
    if (parsed.kind === "unknown" && !unresolvedDynamicMutation) {
      parsed.kind = "read";
    }
    const destructive = parsed.kind === "delete" || parsed.kind === "move";
    return {
      ...parsed,
      command,
      effects: parsed.kind === "unknown" ? {} : { destructive },
    };
  }
  if (/^(?:read|read_file|grep|grep_files|glob|list|list_files|list_directory|search|find)$/.test(tool)) {
    return { kind: "read", targets: direct, sources: [], command: "", effects: {} };
  }
  const kind: ResolvedIntent["kind"] =
    /mkdir|create_directory/.test(tool) ? "mkdir" :
    /delete|remove|cleanup/.test(tool) ? "delete" :
    /copy/.test(tool) ? "copy" :
    /move|rename/.test(tool) ? "move" :
    /patch|apply_patch/.test(tool) ? "patch" :
    /write|edit|create/.test(tool) ? "write" : "unknown";
  return {
    kind,
    targets: direct,
    sources,
    command: "",
    effects: kind === "delete" || kind === "move" ? { destructive: true } : {},
  };
}

function governanceStorage(target: string): boolean {
  const value = target.replace(/\\/g, "/").toLowerCase();
  return /(?:^|\/)fcop\/(?:_lifecycle|tasks|reports|issues|reviews?|logs|approvals)(?:\/|$)/.test(value);
}

function protectedProductBoundary(target: string): boolean {
  const value = target.replace(/\\/g, "/").toLowerCase();
  if (/(?:^|\/)__tests__(?:\/|$)|\.test\.[cm]?[jt]sx?$/.test(value)) return false;
  return [
    "/src/approval/",
    "/registry/roletoolpolicy.ts",
    "/session/sdkrunhandle.ts",
    "/native-operation-confirm.ts",
    "/git-operation-approval.ts",
  ].some((marker) => value.includes(marker));
}

function taskScratch(projectRoot: string, target: string, taskId: string): boolean {
  if (!taskId) return false;
  const rel = relative(resolve(projectRoot), resolve(target)).replace(/\\/g, "/").toLowerCase();
  return rel === "workspace" || rel.startsWith("workspace/") ||
    rel.startsWith(".codeflowmu/scratch/") || rel.startsWith(".fcop/drawer/");
}

function fingerprint(input: UnifiedOperationInput, intent: ResolvedIntent, targets: string[]): string {
  const payload = JSON.stringify({
    tool: normalizedToolName(input.toolName),
    role: roleFromAgentId(input.agentId),
    task: input.taskId ?? input.args["task_id"] ?? "",
    kind: intent.kind,
    targets,
    command: intent.command,
  });
  let hash = 2166136261;
  for (let i = 0; i < payload.length; i += 1) hash = Math.imul(hash ^ payload.charCodeAt(i), 16777619);
  return `op-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function approvalInput(
  input: UnifiedOperationInput,
  intent: ResolvedIntent,
  targets: string[],
  policyRuleIds: string[],
): PrepareOperationInput | null {
  const executor: WorkspaceExecutorName | "" =
    intent.kind === "write" ? "workspace.fs.write" :
    intent.kind === "mkdir" ? "workspace.fs.mkdir" :
    intent.kind === "copy" ? "workspace.fs.copy" :
    intent.kind === "move" ? "workspace.fs.move" :
    intent.kind === "patch" ? "workspace.patch.apply" : "";
  if (!executor || intent.command) return null;
  const content = typeof input.args["content"] === "string" ? String(input.args["content"]) :
    typeof input.args["text"] === "string" ? String(input.args["text"]) : "";
  const source = intent.sources.length > 0
    ? canonicalPath(input.projectRoot, intent.sources[0]!)
    : undefined;
  const patch = typeof input.args["patch"] === "string"
    ? String(input.args["patch"])
    : typeof input.args["diff"] === "string"
      ? String(input.args["diff"])
      : undefined;
  return buildWorkspaceOperationApprovalInput({
    projectRoot: input.projectRoot,
    subject: {
      actor: input.agentId,
      role: roleFromAgentId(input.agentId),
      project_id: input.projectId,
      agent_id: input.agentId,
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      ...(input.taskId ? { task_id: input.taskId } : {}),
    },
    executor,
    targets: intent.kind === "patch" ? undefined : targets,
    source,
    content,
    patch,
    allowed_paths: intent.kind === "patch" ? targets : undefined,
    encoding: "utf8",
    overwrite: input.args["overwrite"] !== false,
    policy_rule_ids: policyRuleIds,
  });
}

export function evaluateUnifiedOperationPolicy(input: UnifiedOperationInput): UnifiedPolicyDecision {
  const intent = resolveIntent(input);
  const role = roleFromAgentId(input.agentId);
  const taskId = String(input.taskId ?? input.args["task_id"] ?? "").trim();
  const hasSelfAttestedOverride = input.args["pm_implementation_override"] === true ||
    input.args["approved_by"] !== undefined;
  if (hasSelfAttestedOverride && !input.args["governance_authorization"]) {
    return {
      decision: "DENY",
      rule_ids: ["GOV.IDENTITY.NO_SELF_ATTESTATION"],
      code: ABSOLUTELY_PROHIBITED,
      reason: "caller supplied approval fields are not a verifiable ADMIN decision",
      next_safe_action: "request a formal governance capability lease",
      effects: { governance_bypass: true, prohibited: true },
      targets: [],
    };
  }
  if (intent.kind === "read") {
    return { decision: "ALLOW", rule_ids: ["DEFAULT.LOCAL.READ"], classification: "local_read", effects: {}, targets: [], reason: "local read is within the default boundary" };
  }
  if (process.env[UNIFIED_OPERATION_POLICY_FEATURE_FLAG] === "0") {
    return {
      decision: "DENY",
      rule_ids: ["FEATURE.UNIFIED_OPERATION_POLICY.DISABLED"],
      code: APPROVAL_ADAPTER_REQUIRED,
      reason: "the unified mutation policy is disabled by the runtime rollback switch",
      next_safe_action: "re-enable the unified policy after inspection; historical approvals remain read-only",
      effects: { ...intent.effects, unknown: true },
      targets: [],
    };
  }
  if (intent.kind === "unknown") {
    if (!intent.command) {
      return { decision: "ALLOW", rule_ids: ["DEFAULT.NON_MUTATING.UNKNOWN_TOOL"], classification: "non_mutating_tool", effects: {}, targets: [], reason: "no mutation effect was detected" };
    }
    return {
      decision: "DENY", rule_ids: ["BOUNDARY.EFFECT.UNKNOWN"], code: APPROVAL_ADAPTER_REQUIRED,
      reason: "command mutation effects cannot be bound to exact targets", next_safe_action: "use a structured workspace tool or controlled executor",
      effects: { unknown: true }, targets: [],
    };
  }
  const targets = intent.targets.map((target) => canonicalPath(input.projectRoot, target));
  const sources = intent.sources.map((target) => canonicalPath(input.projectRoot, target));
  if (targets.length === 0) {
    return {
      decision: "DENY", rule_ids: ["BOUNDARY.TARGET.UNRESOLVED"], code: APPROVAL_ADAPTER_REQUIRED,
      reason: "mutation target set could not be resolved", next_safe_action: "use a structured workspace tool with exact target paths",
      effects: { ...intent.effects, target_unbounded: true }, targets: [],
    };
  }
  if ([...targets, ...sources].some((target) => !inside(input.projectRoot, target))) {
    return {
      decision: "DENY", rule_ids: ["BOUNDARY.PROJECT.CROSS_ROOT"], code: ABSOLUTELY_PROHIBITED,
      reason: "cross-project mutation is not approvable", next_safe_action: "switch the active project or create a task bound to the target project",
      effects: { ...intent.effects, out_of_scope: true, prohibited: true }, targets,
    };
  }
  if (targets.some(governanceStorage)) {
    return {
      decision: "DENY", rule_ids: ["GOV.FACT_SOURCE.DIRECT_WRITE"], code: ABSOLUTELY_PROHIBITED,
      reason: "formal FCoP fact sources must be changed through lifecycle tools", next_safe_action: "use the corresponding FCoP Runtime tool",
      effects: { ...intent.effects, governance_bypass: true, prohibited: true }, targets,
    };
  }
  if (targets.some(protectedProductBoundary)) {
    const prepared = approvalInput(input, intent, targets, [
      "PRODUCT.PROTECTED_BOUNDARY.REQUIRES_APPROVAL",
    ]);
    if (!prepared) {
      return {
        decision: "DENY",
        rule_ids: ["PRODUCT.PROTECTED_BOUNDARY.ADAPTER_REQUIRED"],
        code: APPROVAL_ADAPTER_REQUIRED,
        reason: "protected product code requires a registered structured executor",
        next_safe_action: "use a structured workspace executor with exact targets",
        effects: { ...intent.effects, software_change: true, governance_change: true },
        targets,
      };
    }
    prepared.request.effect.software_change = true;
    prepared.request.effect.governance_change = true;
    return {
      decision: "REQUIRE_APPROVAL",
      rule_ids: ["PRODUCT.PROTECTED_BOUNDARY.REQUIRES_APPROVAL"],
      input: prepared,
      executor: prepared.request.action.executor,
      operation_fingerprint: fingerprint(input, intent, targets),
      resume_strategy: "controlled_execute",
    };
  }
  if (role === "PM" && targets.every((target) => taskScratch(input.projectRoot, target, taskId)) &&
      (intent.kind === "write" || intent.kind === "mkdir")) {
    return {
      decision: "ALLOW", rule_ids: ["PM.TASK.SCRATCH.LOCAL_REVERSIBLE"], classification: "task_scratch_write",
      effects: intent.effects, targets, reason: "task-bound local scratch material is reversible and does not change a governance fact source",
    };
  }
  if (role !== "PM") {
    return {
      decision: "ALLOW", rule_ids: ["DEFAULT.ACTIVE_PROJECT.LOCAL_WRITE"], classification: "active_project_write",
      effects: intent.effects, targets, reason: "bounded local write is inside the active project",
    };
  }
  const prepared = approvalInput(input, intent, targets, [
    "PM.ROLE.BOUNDED_IMPLEMENTATION_EXCEPTION",
  ]);
  if (!prepared) {
    return {
      decision: "DENY", rule_ids: ["PM.ROLE.EXCEPTION.ADAPTER_REQUIRED"], code: APPROVAL_ADAPTER_REQUIRED,
      reason: "bounded PM implementation write requires a controlled executor; raw shell replay is not supported",
      next_safe_action: "use workspace.fs.write, workspace.fs.mkdir, workspace.fs.copy, workspace.fs.move, or workspace.patch.apply",
      effects: { ...intent.effects, governance_change: true }, targets,
    };
  }
  const fp = fingerprint(input, intent, targets);
  return {
    decision: "REQUIRE_APPROVAL", rule_ids: ["PM.ROLE.BOUNDED_IMPLEMENTATION_EXCEPTION"], input: prepared,
    executor: prepared.request.action.executor, operation_fingerprint: fp, resume_strategy: "controlled_execute",
  };
}
