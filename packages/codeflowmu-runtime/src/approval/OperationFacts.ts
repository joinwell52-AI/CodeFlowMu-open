import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";

export type OperationKind =
  | "read"
  | "create"
  | "write"
  | "append"
  | "delete"
  | "move"
  | "copy"
  | "execute"
  | "network_read"
  | "network_write"
  | "process_control"
  | "remote_git"
  | "publish"
  | "governance_change"
  | "unknown";

export type OperationFacts = {
  subject: {
    role: string;
    agent_id: string;
    session_id: string;
  };
  context: {
    project_id: string;
    project_root_realpath: string;
    task_id: string;
    thread_key: string;
    task_scope_digest: string;
  };
  tool: {
    canonical_tool_id: string;
    adapter_id: string;
    source_channel: string;
  };
  operation: {
    kind: OperationKind;
    exact_targets: string[];
    canonical_targets: string[];
    target_set_stable: boolean;
    recursive: boolean;
    dynamic_or_wildcard: boolean;
  };
  target_state: {
    lifecycle_class:
      | "task_scratch"
      | "generated"
      | "product"
      | "governance"
      | "shared"
      | "protected"
      | "external"
      | "unknown";
    owner_task_id?: string;
    owner_session_id?: string;
    git_tracked?: boolean;
    locked_or_in_use?: boolean;
    link_boundary?: "none" | "symlink" | "junction" | "hardlink" | "unknown";
  };
  impact: {
    persistent: boolean;
    external: boolean;
    shared: boolean;
    reversible: boolean | "unknown";
    recovery_evidence?: string;
    privilege_change: boolean;
    runtime_change: boolean;
    governance_change: boolean;
  };
  confidence: {
    complete: boolean;
    unresolved_fields: string[];
    detector_ids: string[];
  };
};

export const NEGATIVE_RULE_IDS = [
  "NEG.SCOPE.ESCAPE",
  "NEG.PROTECTED.BOUNDARY",
  "NEG.GOVERNANCE.BYPASS",
  "NEG.SHARED.STATE",
  "NEG.IRREVERSIBLE.EFFECT",
  "NEG.BULK.DYNAMIC_TARGETS",
  "NEG.EXTERNAL.SIDE_EFFECT",
  "NEG.SECURITY.AUTHORITY",
  "NEG.RUNTIME.CONTROL",
  "NEG.REMOTE.RELEASE.PRODUCTION",
  "NEG.CONTRACT.CHANGE",
  "NEG.OPAQUE.EFFECT",
  "NEG.CONCURRENCY.CONFLICT",
] as const;

export type NegativeRuleId = (typeof NEGATIVE_RULE_IDS)[number];

export type NegativeMatch = {
  rule_id: NegativeRuleId;
  matched: boolean;
  evidence_fields: string[];
  reason_zh: string;
  required_fact_fields: string[];
};

export type OperationFactsInput = {
  toolName: string;
  args: Record<string, unknown>;
  projectRoot: string;
  projectId: string;
  agentId: string;
  sessionId?: string;
  taskId?: string;
  threadKey?: string;
  sourceChannel?: string;
};

function roleFromAgentId(agentId: string): string {
  return agentId.trim().split(/[-_:]/, 1)[0]?.toUpperCase() || "UNKNOWN";
}

export function canonicalToolId(toolName: string): string {
  const raw = String(toolName ?? "").trim().toLowerCase();
  const mcp = raw.match(/(?:^|[.:/])mcp[.:/]?([^.:/]+)[.:/]([^.:/]+)$/);
  if (mcp) return `mcp.${mcp[1]}.${mcp[2]}`;
  return raw.replace(/^.*[.:/]/, "") || "unknown";
}

export function canonicalToolCallId(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const base = canonicalToolId(toolName);
  if (base !== "mcp") return base;
  const provider = String(args["providerIdentifier"] ?? args["provider"] ?? "").trim().toLowerCase();
  const name = String(args["toolName"] ?? args["tool_name"] ?? "").trim().toLowerCase();
  return provider && name ? `mcp.${provider}.${name}` : base;
}

function stableDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
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

function textArg(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (typeof args[key] === "string" && String(args[key]).trim()) {
      return String(args[key]).trim();
    }
  }
  return "";
}

function directTargets(args: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const key of [
    "path", "file", "file_path", "filePath", "target", "target_path",
    "targetFile", "destination", "destinationPath",
  ]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) values.push(value.trim());
  }
  for (const key of ["targets", "allowed_paths"]) {
    if (!Array.isArray(args[key])) continue;
    for (const value of args[key] as unknown[]) {
      if (typeof value === "string" && value.trim()) values.push(value.trim());
    }
  }
  return [...new Set(values)];
}

type AdapterResult = {
  kind: OperationKind;
  targets: string[];
  recursive: boolean;
  dynamic: boolean;
  external: boolean;
  privilege: boolean;
  runtime: boolean;
  governance: boolean;
  reversible: boolean | "unknown";
  persistent: boolean;
  complete: boolean;
  unresolved: string[];
  detectors: string[];
  adapterId: string;
};

function pushMatches(command: string, pattern: RegExp, bucket: string[]): void {
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    const value = String(match[1] ?? "").trim();
    if (value && !bucket.includes(value)) bucket.push(value);
  }
}

/**
 * Shell text is only an evidence adapter.  A detector may add facts or lower
 * confidence; it never returns an authorization decision.
 */
function adaptShell(command: string): AdapterResult {
  const targets: string[] = [];
  const detectors: string[] = [];
  let kind: OperationKind = "execute";
  let persistent = false;
  let reversible: boolean | "unknown" = true;

  const writePatterns: Array<[RegExp, OperationKind, string]> = [
    [/\b(?:set-content|out-file)\b[^\r\n;|]*?(?:-LiteralPath|-Path|-FilePath)\s+[rRuUbBfF]*["']([^"']+)["']/gi, "write", "shell.powershell.write"],
    [/\badd-content\b[^\r\n;|]*?(?:-LiteralPath|-Path)\s+[rRuUbBfF]*["']([^"']+)["']/gi, "append", "shell.powershell.append"],
    [/(?:^|[;&|]\s*)(?:mkdir|md)\s+(?:-[^\s]+\s+)*["']?([^"';&|\s]+)["']?/gim, "create", "shell.cmd.mkdir"],
    [/\bnew-item\b[^\r\n;|]*?(?:-ItemType\s+Directory[^\r\n;|]*?)?(?:-LiteralPath|-Path)\s+["']([^"']+)["']/gi, "create", "shell.powershell.new_item"],
    [/\bos\.makedirs?\s*\(\s*[rRuUbBfF]*["']([^"']+)["']/gi, "create", "shell.python.makedirs"],
    [/\bopen\s*\(\s*[rRuUbBfF]*["']([^"']+)["']\s*,\s*["'][wax+]/gi, "write", "shell.python.open_write"],
    [/\b(?:writeFile|writeFileSync|createWriteStream|mkdirSync)\s*\(\s*[rRuUbBfF]*["']([^"']+)["']/gi, "write", "shell.node.fs_mutation"],
    [/\b(?:remove-item|rm|del|erase|unlinkSync|rmSync)\b[^\r\n;|]*?(?:-LiteralPath|-Path\s+)?["']([^"']+)["']/gi, "delete", "shell.delete"],
    [/(?:^|\s)(?:>>?|1>>?)\s*["']?([^"'\s;&|]+)["']?/gim, "write", "shell.redirect"],
  ];
  for (const [pattern, detectedKind, detector] of writePatterns) {
    const before = targets.length;
    pushMatches(command, pattern, targets);
    if (targets.length > before) {
      detectors.push(detector);
      persistent = true;
      kind = detectedKind;
      if (detectedKind === "delete") reversible = "unknown";
    }
  }

  const obviousReadOnlyTextCommand = /^\s*(?:echo\b(?![^\r\n]*(?:>>?|1>>?))|rg\b|grep\b|findstr\b)/i.test(command);
  const effectCommand = obviousReadOnlyTextCommand ? command.split(/\s+/, 1)[0]! : command;
  const dynamic = /[*?]|\$\(|`[^`]+`|\b(?:for|foreach)\b|\bget-childitem\b[^\r\n]*\|/i.test(command);
  const recursive = /(?:^|\s)(?:-r|-recurse|\/s)(?:\s|$)/i.test(command);
  const remoteGit = /\bgit(?:\.exe)?\s+(?:push|remote\s+(?:add|remove|rename|set-url)|tag\s+-[amfs])/i.test(effectCommand);
  const publish = /\b(?:npm|pnpm|yarn)\s+publish\b|\bdocker\s+push\b|\bgh\s+(?:release|pr\s+(?:create|merge))\b|\b(?:kubectl|helm|terraform)\s+(?:apply|destroy|upgrade|install)/i.test(effectCommand);
  const externalWrite = remoteGit || publish || /\b(?:curl|wget|invoke-restmethod|invoke-webrequest)\b[^\r\n]*(?:-x\s*(?:post|put|patch|delete)|-method\s+(?:post|put|patch|delete)|--data|-d\s)/i.test(effectCommand);
  const runtime = /\b(?:stop-process|restart-service|stop-service|start-service|taskkill|sc\s+(?:start|stop)|shutdown)\b/i.test(effectCommand);
  const privilege = /\b(?:chmod|chown|icacls|takeown|set-acl|new-selfsignedcertificate)\b/i.test(effectCommand);
  const destructive = /\b(?:diskpart|format(?:\.exe)?|format-volume)\b\s+(?:[a-z]:|\\\\\.\\physicaldrive)|\bgit(?:\.exe)?\s+reset\s+--hard\b/i.test(effectCommand);
  const opaque = /(?:-encodedcommand\b|\bfrombase64string\b|\beval\s*\(|\bexec\s*\()/i.test(effectCommand);
  if (remoteGit) { kind = "remote_git"; detectors.push("shell.remote_git"); }
  if (publish) { kind = "publish"; detectors.push("shell.publish"); }
  if (externalWrite) detectors.push("shell.external_write");
  if (runtime) { kind = "process_control"; detectors.push("shell.runtime_control"); }
  if (privilege) detectors.push("shell.security_authority");
  if (destructive) { persistent = true; reversible = false; detectors.push("shell.irreversible"); }
  if (opaque) detectors.push("shell.opaque_execution");

  const effectful = persistent || externalWrite || runtime || privilege || destructive;
  const conservativePythonRead = /^\s*(?:python|py)(?:\.exe)?\s+(?:-[^\s]+\s+)*-c\s+/i.test(command) &&
    !/\b(?:os\.(?:system|remove|unlink|rename|replace|mkdir|makedirs)|subprocess\.|shutil\.|requests\.|urllib\.|socket\.|pathlib\.[^\r\n]*(?:write|unlink|rename)|open\s*\([^)]*,\s*["'][wax+]|eval\s*\(|exec\s*\()/i.test(command);
  const conservativeNodeRead = /^\s*node(?:\.exe)?\s+-e\s+/i.test(command) &&
    !/\b(?:writeFile|appendFile|createWriteStream|mkdir|rm|unlink|rename|spawn|exec|fetch|https?\.request)\b/i.test(command);
  const knownLocalRead = /^\s*(?:git\s+(?:status|diff|show|log|grep|ls-files)|rg\b|grep\b|findstr\b|dir\b|ls\b|get-childitem\b|get-content\b|echo\b(?![^\r\n]*(?:>>?|1>>?)))/i.test(command) || conservativePythonRead || conservativeNodeRead;
  const knownLocalBuild = /^\s*(?:git\s+commit\b|npm\s+(?:test|run\s+(?:test|build|typecheck))\b|node\s+--test\b|tsc\b)/i.test(command);
  if (knownLocalRead && !effectful) kind = "read";
  const complete = !opaque && (!effectful || targets.length > 0 || remoteGit || publish || runtime || privilege || destructive) && (knownLocalRead || knownLocalBuild || effectful);
  const unresolved: string[] = [];
  if (!complete) unresolved.push(effectful && targets.length === 0 ? "operation.exact_targets" : "operation.effects");
  return {
    kind,
    targets,
    recursive,
    dynamic,
    external: externalWrite,
    privilege,
    runtime,
    governance: false,
    reversible,
    persistent: persistent || externalWrite || runtime || privilege,
    complete,
    unresolved,
    detectors,
    adapterId: "shell.candidate-facts.v1",
  };
}

function adaptStructured(tool: string, args: Record<string, unknown>): AdapterResult {
  const targets = directTargets(args);
  const kind: OperationKind =
    /^(?:read|read_file|read_text_file|grep|grep_files|glob|list|list_files|list_dir|list_directory|list_tasks|list_reports|list_issues|read_task|read_report|fcop_report|fcop_check|fcop_audit|get_team_status|inspect_task|search|find)$/.test(tool) ? "read" :
    /mkdir|create_directory|scratch\.create/.test(tool) ? "create" :
    /append/.test(tool) ? "append" :
    /delete|remove|cleanup/.test(tool) ? "delete" :
    /copy/.test(tool) ? "copy" :
    /move|rename/.test(tool) ? "move" :
    /write|edit|patch|create_file|scratch\.write/.test(tool) ? "write" :
    /^(?:write_task|create_task|write_report|write_issue|write_review|submit_review|review_task|approve_review|reject_review|mark_human_approved|archive_task|approve_task|reject_task|claim_task|submit_task|finish_task)$/.test(tool) ? "governance_change" :
    "unknown";
  const governance = kind === "governance_change";
  const persistent = !["read", "unknown"].includes(kind);
  return {
    kind,
    targets,
    recursive: args["recursive"] === true,
    dynamic: targets.some((value) => /[*?]/.test(value)),
    external: false,
    privilege: false,
    runtime: false,
    governance,
    reversible: kind === "delete" ? "unknown" : true,
    persistent,
    complete: kind !== "unknown" && (kind === "read" || governance || targets.length > 0),
    unresolved: kind === "unknown" ? ["operation.kind"] : persistent && !governance && targets.length === 0 ? ["operation.exact_targets"] : [],
    detectors: ["structured.tool"],
    adapterId: "structured.tool.v1",
  };
}

function classifyTarget(projectRoot: string, target: string, taskId: string, sessionId: string): OperationFacts["target_state"] {
  if (!inside(projectRoot, target)) return { lifecycle_class: "external", link_boundary: "unknown" };
  const rel = relative(projectRoot, target).replace(/\\/g, "/").toLowerCase();
  const task = taskId.toLowerCase();
  const session = sessionId.toLowerCase();
  const scratchPrefixes = [
    `.codeflowmu/scratch/${task}/${session}`,
    `.fcop/drawer/`,
    `workspace/${task}/scratch`,
  ].filter(Boolean);
  let lifecycle: OperationFacts["target_state"]["lifecycle_class"] = "product";
  if (scratchPrefixes.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) lifecycle = "task_scratch";
  else if (/(?:^|\/)fcop\/(?:_lifecycle|tasks|reports|issues|reviews?|ledger|approvals)(?:\/|$)/.test(rel)) lifecycle = "governance";
  else if (/(?:^|\/)(?:projects-registry\.json|runtime\.lock|instance\.json|mobile-gateway\.json|operation-approvals)(?:\/|$)/.test(rel)) lifecycle = "shared";
  else if (!/(?:^|\/)__tests__(?:\/|$)/.test(rel) && ["packages/codeflowmu-runtime/src/approval/", "packages/codeflowmu-runtime/src/session/sdkrunhandle.ts", "packages/codeflowmu-runtime/src/registry/roletoolpolicy.ts", "codeflowmu-shell/src/runtime-writer-lock.ts", "codeflowmu-shell/src/runtime-instance.ts"].some((prefix) => rel.startsWith(prefix))) lifecycle = "protected";
  else if (/(?:^|\/)(?:dist|build|coverage|tmp|temp)(?:\/|$)/.test(rel)) lifecycle = "generated";
  let link: OperationFacts["target_state"]["link_boundary"] = "none";
  try {
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) link = "symlink";
  } catch {
    link = "unknown";
  }
  return {
    lifecycle_class: lifecycle,
    ...(lifecycle === "task_scratch" ? { owner_task_id: taskId, owner_session_id: sessionId } : {}),
    link_boundary: link,
    locked_or_in_use: false,
  };
}

export function buildOperationFacts(input: OperationFactsInput): OperationFacts {
  const root = canonicalPath(input.projectRoot, ".");
  const tool = canonicalToolCallId(input.toolName, input.args);
  const command = textArg(input.args, ["command", "cmd", "script", "input"]);
  const adapted = command ? adaptShell(command) : adaptStructured(tool, input.args);
  const selfAttestedGovernance =
    input.args["pm_implementation_override"] === true ||
    input.args["approved_by"] !== undefined ||
    input.args["governance_lease_validation_error"] !== undefined;
  if (selfAttestedGovernance) {
    adapted.governance = true;
    adapted.persistent = true;
    adapted.detectors.push("governance.untrusted_self_attestation");
  }
  const canonicalTargets = adapted.targets.map((value) => canonicalPath(root, value));
  const taskId = String(input.taskId ?? input.args["task_id"] ?? "").trim();
  const sessionId = String(input.sessionId ?? "").trim();
  const threadKey = String(input.threadKey ?? input.args["thread_key"] ?? (taskId ? `task:${taskId}` : "")).trim();
  const states = canonicalTargets.map((target) => classifyTarget(root, target, taskId, sessionId));
  const dominant = states.find((state) => state.lifecycle_class === "external") ??
    states.find((state) => state.lifecycle_class === "protected") ??
    states.find((state) => state.lifecycle_class === "governance") ??
    states.find((state) => state.lifecycle_class === "shared") ??
    states[0] ?? { lifecycle_class: "unknown" as const, link_boundary: "unknown" as const };
  const unresolved = [...adapted.unresolved];
  if (adapted.persistent && !taskId) unresolved.push("context.task_id");
  if (adapted.persistent && !threadKey) unresolved.push("context.thread_key");
  const complete = adapted.complete && unresolved.length === 0;
  const shared = states.some((state) => state.lifecycle_class === "shared" || (state.owner_task_id && state.owner_task_id !== taskId));
  const facts: OperationFacts = {
    subject: { role: roleFromAgentId(input.agentId), agent_id: input.agentId, session_id: sessionId },
    context: {
      project_id: input.projectId,
      project_root_realpath: root,
      task_id: taskId,
      thread_key: threadKey,
      task_scope_digest: stableDigest({ project: input.projectId, root, task: taskId, thread: threadKey }),
    },
    tool: {
      canonical_tool_id: tool,
      adapter_id: adapted.adapterId,
      source_channel: input.sourceChannel ?? "runtime",
    },
    operation: {
      kind: adapted.kind,
      exact_targets: [...adapted.targets],
      canonical_targets: canonicalTargets,
      target_set_stable: !adapted.dynamic && canonicalTargets.length === adapted.targets.length,
      recursive: adapted.recursive,
      dynamic_or_wildcard: adapted.dynamic,
    },
    target_state: dominant,
    impact: {
      persistent: adapted.persistent,
      external: adapted.external || states.some((state) => state.lifecycle_class === "external"),
      shared,
      reversible: adapted.reversible,
      ...(adapted.reversible === true ? { recovery_evidence: "bounded operation with stable targets" } : {}),
      privilege_change: adapted.privilege,
      runtime_change: adapted.runtime,
      governance_change: adapted.governance || (adapted.persistent && states.some((state) => state.lifecycle_class === "governance")),
    },
    confidence: {
      complete,
      unresolved_fields: [...new Set(unresolved)],
      detector_ids: [...new Set(adapted.detectors)],
    },
  };
  return Object.freeze(facts);
}

function match(rule_id: NegativeRuleId, matched: boolean, evidence_fields: string[], reason_zh: string, required_fact_fields: string[]): NegativeMatch {
  return { rule_id, matched, evidence_fields: matched ? evidence_fields : [], reason_zh, required_fact_fields };
}

export function negativeScopeEscape(facts: OperationFacts): NegativeMatch {
  const matched = facts.impact.persistent && (facts.impact.external || facts.operation.canonical_targets.some((target) => !inside(facts.context.project_root_realpath, target)));
  return match("NEG.SCOPE.ESCAPE", matched, ["context.project_root_realpath", "operation.canonical_targets", "impact.external"], "操作的真实影响越出当前项目或任务范围", ["context.project_root_realpath", "context.task_id", "operation.canonical_targets"]);
}
export function negativeProtectedBoundary(facts: OperationFacts): NegativeMatch {
  return match("NEG.PROTECTED.BOUNDARY", facts.impact.persistent && facts.target_state.lifecycle_class === "protected", ["target_state.lifecycle_class", "operation.canonical_targets"], "操作将改变受保护的 Runtime、审批或实例身份边界", ["target_state.lifecycle_class", "operation.canonical_targets"]);
}
export function negativeGovernanceBypass(facts: OperationFacts): NegativeMatch {
  const formal = /^(?:write_task|create_task|write_report|write_issue|write_review|submit_review|review_task|approve_review|reject_review|mark_human_approved|archive_task|approve_task|reject_task|claim_task|submit_task|finish_task)$/.test(facts.tool.canonical_tool_id);
  const selfAttested = facts.confidence.detector_ids.includes("governance.untrusted_self_attestation");
  return match("NEG.GOVERNANCE.BYPASS", selfAttested || (facts.impact.persistent && facts.impact.governance_change && facts.target_state.lifecycle_class === "governance" && !formal), ["tool.canonical_tool_id", "target_state.lifecycle_class", "impact.governance_change", "confidence.detector_ids"], "操作绕过正式治理工具直接改变治理事实源，或提交了不可验证的自证授权", ["tool.canonical_tool_id", "target_state.lifecycle_class"]);
}
export function negativeSharedState(facts: OperationFacts): NegativeMatch {
  return match("NEG.SHARED.STATE", facts.impact.persistent && (facts.impact.shared || facts.target_state.lifecycle_class === "shared"), ["impact.shared", "target_state.lifecycle_class", "target_state.owner_task_id"], "操作会改变共享状态或其他任务、会话所有的资源", ["impact.shared", "target_state.owner_task_id"]);
}
export function negativeIrreversibleEffect(facts: OperationFacts): NegativeMatch {
  return match("NEG.IRREVERSIBLE.EFFECT", facts.impact.persistent && (facts.impact.reversible === false || facts.impact.reversible === "unknown" || !facts.impact.recovery_evidence), ["impact.persistent", "impact.reversible", "impact.recovery_evidence"], "操作具有持久影响，但恢复或重建能力不足", ["impact.persistent", "impact.reversible", "impact.recovery_evidence"]);
}
export function negativeBulkDynamicTargets(facts: OperationFacts): NegativeMatch {
  return match("NEG.BULK.DYNAMIC_TARGETS", facts.operation.recursive || facts.operation.dynamic_or_wildcard || !facts.operation.target_set_stable || facts.operation.canonical_targets.length > 200, ["operation.recursive", "operation.dynamic_or_wildcard", "operation.target_set_stable", "operation.canonical_targets"], "目标集合是递归、动态、通配或超出集中阈值", ["operation.canonical_targets", "operation.target_set_stable", "operation.recursive"]);
}
export function negativeExternalSideEffect(facts: OperationFacts): NegativeMatch {
  return match("NEG.EXTERNAL.SIDE_EFFECT", facts.impact.external && facts.operation.kind !== "network_read", ["impact.external", "operation.kind"], "操作将对外部系统产生持久副作用或发送内容", ["impact.external", "operation.kind"]);
}
export function negativeSecurityAuthority(facts: OperationFacts): NegativeMatch {
  return match("NEG.SECURITY.AUTHORITY", facts.impact.privilege_change, ["impact.privilege_change"], "操作将改变身份、权限、凭据或安全边界", ["impact.privilege_change"]);
}
export function negativeRuntimeControl(facts: OperationFacts): NegativeMatch {
  return match("NEG.RUNTIME.CONTROL", facts.impact.runtime_change || facts.operation.kind === "process_control", ["impact.runtime_change", "operation.kind"], "操作将控制稳定或共享运行实例、服务或基础设施", ["impact.runtime_change", "operation.kind"]);
}
export function negativeRemoteReleaseProduction(facts: OperationFacts): NegativeMatch {
  return match("NEG.REMOTE.RELEASE.PRODUCTION", facts.operation.kind === "remote_git" || facts.operation.kind === "publish", ["operation.kind", "confidence.detector_ids"], "操作涉及远端 Git、发布或生产环境变更", ["operation.kind"]);
}
export function negativeContractChange(facts: OperationFacts): NegativeMatch {
  const contractTool = /^(?:edit_task_contract|change_task_scope|change_acceptance_gate)$/.test(facts.tool.canonical_tool_id);
  return match("NEG.CONTRACT.CHANGE", contractTool, ["tool.canonical_tool_id", "context.task_scope_digest"], "操作将改变任务范围、关系、Gate 或验收合同", ["tool.canonical_tool_id", "context.task_scope_digest"]);
}
export function negativeOpaqueEffect(facts: OperationFacts): NegativeMatch {
  return match("NEG.OPAQUE.EFFECT", facts.operation.kind !== "read" && !facts.confidence.complete, ["confidence.complete", "confidence.unresolved_fields", "confidence.detector_ids"], "执行前无法可靠形成完整的目标、作用域和副作用事实", ["confidence.complete", "confidence.unresolved_fields"]);
}
export function negativeConcurrencyConflict(facts: OperationFacts): NegativeMatch {
  const conflict = facts.target_state.locked_or_in_use === true || (facts.target_state.link_boundary != null && facts.target_state.link_boundary !== "none" && facts.target_state.link_boundary !== "unknown");
  return match("NEG.CONCURRENCY.CONFLICT", conflict, ["target_state.locked_or_in_use", "target_state.link_boundary"], "目标存在占用、锁或链接边界冲突", ["target_state.locked_or_in_use", "target_state.link_boundary"]);
}

export const NEGATIVE_PREDICATES = [
  negativeScopeEscape,
  negativeProtectedBoundary,
  negativeGovernanceBypass,
  negativeSharedState,
  negativeIrreversibleEffect,
  negativeBulkDynamicTargets,
  negativeExternalSideEffect,
  negativeSecurityAuthority,
  negativeRuntimeControl,
  negativeRemoteReleaseProduction,
  negativeContractChange,
  negativeOpaqueEffect,
  negativeConcurrencyConflict,
] as const;

export function evaluateNegativePredicates(facts: OperationFacts): NegativeMatch[] {
  return NEGATIVE_PREDICATES.map((predicate) => predicate(facts)).filter((result) => result.matched);
}

export function operationFingerprint(facts: OperationFacts): string {
  return stableDigest({
    subject: facts.subject,
    context: facts.context,
    tool: facts.tool,
    operation: facts.operation,
    target_state: facts.target_state,
    impact: facts.impact,
  });
}
