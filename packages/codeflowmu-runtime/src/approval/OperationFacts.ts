import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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
  "NEG.SCOPE.ESCAPE.WRITE",
  "NEG.PROTECTED.BOUNDARY.WRITE",
  "NEG.GOVERNANCE.BYPASS",
  "NEG.SHARED.STATE.WRITE",
  "NEG.TRACKED.DELETE",
  "NEG.BULK.CLEANUP",
  "NEG.IRREVERSIBLE.EFFECT",
  "NEG.EXTERNAL.WRITE",
  "NEG.SECURITY.AUTHORITY",
  "NEG.RUNTIME.CONTROL",
  "NEG.REMOTE.GIT.WRITE",
  "NEG.RELEASE.PRODUCTION",
  "NEG.SOFTWARE.SYSTEM.CHANGE",
  "NEG.TASK.CONTRACT.CHANGE",
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
    "targetFile", "destination", "destinationPath", "url", "uri",
    "endpoint", "recipient", "repository", "remote", "branch",
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
  targetsAreExternal?: boolean;
};

function pushMatches(command: string, pattern: RegExp, bucket: string[]): void {
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    const value = String(match[1] ?? "").trim();
    if (value && !bucket.includes(value)) bucket.push(value);
  }
}

type ShellLexSegment = { words: string[]; redirects: string[] };

function maskShellPayloadBlocks(command: string): string {
  const blank = (value: string) => value.replace(/[^\r\n]/g, " ");
  return command
    .replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, blank)
    .replace(/<<-?\s*['"]?([A-Za-z_][\w-]*)['"]?[^\r\n]*\r?\n([\s\S]*?)\r?\n\1(?=\r?$)/gm, blank);
}

/** Minimal shell lexer: only unquoted shell-layer operators are structural. */
function lexShell(command: string): ShellLexSegment[] {
  const source = maskShellPayloadBlocks(command);
  const segments: ShellLexSegment[] = [];
  let words: string[] = [];
  let redirects: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  const pushWord = () => {
    const value = word.trim();
    if (value) words.push(value);
    word = "";
  };
  const pushSegment = () => {
    pushWord();
    if (words.length || redirects.length) segments.push({ words, redirects });
    words = [];
    redirects = [];
  };
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quote) {
      if (ch === quote && source[i - 1] !== "\\") quote = null;
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (ch === "\n" || ch === "\r") pushSegment();
      else pushWord();
      continue;
    }
    if (ch === ";" || ch === "|") {
      pushSegment();
      if (source[i + 1] === ch) i += 1;
      continue;
    }
    if (ch === "&" && source[i + 1] === "&") {
      pushSegment();
      i += 1;
      continue;
    }
    if (ch === ">") {
      pushWord();
      if (source[i - 1] === ">" || source[i + 1] === "=") {
        word += ch;
        continue;
      }
      if (source[i + 1] === ">") i += 1;
      while (i + 1 < source.length && /[ \t]/.test(source[i + 1]!)) i += 1;
      let target = "";
      let targetQuote: "'" | '"' | null = null;
      for (let j = i + 1; j < source.length; j += 1) {
        const next = source[j]!;
        if (targetQuote) {
          if (next === targetQuote && source[j - 1] !== "\\") targetQuote = null;
          else target += next;
          i = j;
          continue;
        }
        if (next === "'" || next === '"') {
          targetQuote = next;
          i = j;
          continue;
        }
        if (/\s/.test(next) || next === ";" || next === "|" || next === "&") break;
        target += next;
        i = j;
      }
      const normalized = target.trim();
      // Numeric/comparison values are never meaningful filesystem targets.
      if (normalized && !/^(?:=?[+-]?(?:\d+(?:\.\d+)?|\.\d+))$/.test(normalized)) {
        redirects.push(normalized);
      }
      continue;
    }
    word += ch;
  }
  pushSegment();
  return segments;
}

function executableWords(segment: ShellLexSegment): string[] {
  const words = [...segment.words];
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
  if (/^(?:sudo|env)$/i.test(words[0] ?? "")) words.shift();
  return words;
}

function validExternalTarget(value: string): boolean {
  const target = value.trim();
  if (!target || /^(?:=?[+-]?(?:\d+(?:\.\d+)?|\.\d+))$/.test(target)) return false;
  if (/^https?:\/\/[^\s/$.?#].*$/i.test(target)) return true;
  if (/^git:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._/-]+)?$/.test(target)) return true;
  if (/^(?:recipient|resource|repository):[^\s]+$/i.test(target)) return true;
  return false;
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
    [/\b(?:set-content|out-file)\b(?:\s+(?:-LiteralPath|-Path|-FilePath))?\s+["']?([^"';&|\s]+)["']?/gi, "write", "shell.powershell.write"],
    [/\badd-content\b[^\r\n;|]*?(?:-LiteralPath|-Path)\s+["']([^"']+)["']/gi, "append", "shell.powershell.append"],
    [/(?:^|[;&|]\s*)(?:mkdir|md)\s+(?:-[^\s]+\s+)*["']?([^"';&|\s]+)["']?/gim, "create", "shell.cmd.mkdir"],
    [/\bnew-item\b[^\r\n;|]*?(?:-ItemType\s+Directory[^\r\n;|]*?)?(?:-LiteralPath|-Path)\s+["']([^"']+)["']/gi, "create", "shell.powershell.new_item"],
    [/\bos\.makedirs?\s*\(\s*[rRuUbBfF]*["']([^"']+)["']/gi, "create", "shell.python.makedirs"],
    [/\bopen\s*\(\s*[rRuUbBfF]*["']([^"']+)["']\s*,\s*["'][wax+]/gi, "write", "shell.python.open_write"],
    [/\b(?:writeFile|writeFileSync|createWriteStream|mkdirSync)\s*\(\s*[rRuUbBfF]*["']([^"']+)["']/gi, "write", "shell.node.fs_mutation"],
    [/\b(?:remove-item|rm|del|erase|unlinkSync|rmSync)\b[^\r\n;|]*?(?:-LiteralPath|-Path\s+)?["']([^"']+)["']/gi, "delete", "shell.delete"],
    [/(?:^|[;&|]\s*)(?:del|erase|rm)\s+(?:\/[a-z]\s+|-[^\s]+\s+)*["']?([^"';&|\s]+)["']?/gim, "delete", "shell.delete.unquoted"],
    [/\bgit(?:\.exe)?\s+checkout\s+--\s+["']?([^"';&|\s]+)["']?/gi, "write", "shell.git.restore"],
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

  const shellSegments = lexShell(command);
  for (const redirect of shellSegments.flatMap((segment) => segment.redirects)) {
    if (!targets.includes(redirect)) targets.push(redirect);
    if (!detectors.includes("shell.redirect")) detectors.push("shell.redirect");
    persistent = true;
    kind = "write";
  }

  const obviousReadOnlyTextCommand = /^\s*(?:echo\b(?![^\r\n]*(?:>>?|1>>?))|rg\b|grep\b|findstr\b)/i.test(command);
  const effectCommand = obviousReadOnlyTextCommand ? command.split(/\s+/, 1)[0]! : command;
  const dynamic = /[*?]|\$\(|`[^`]+`|\b(?:for|foreach)\b|\bget-childitem\b[^\r\n]*\|/i.test(command);
  const recursive = /(?:^|\s)(?:-r|-recurse|\/s)(?:\s|$)/i.test(command);
  let remoteGit = false;
  let release = false;
  let externalWrite = false;
  const externalTargets: string[] = [];
  for (const segment of shellSegments) {
    const words = executableWords(segment);
    const executable = String(words[0] ?? "").replace(/\.exe$/i, "").toLowerCase();
    const action = String(words[1] ?? "").toLowerCase();
    if (executable === "git" && action === "push") {
      remoteGit = true;
      const remote = words.find((value, index) => index >= 2 && !value.startsWith("-")) ?? "remote";
      const remoteIndex = words.indexOf(remote);
      const branch = words.find((value, index) => index > remoteIndex && !value.startsWith("-"));
      externalTargets.push(`git:${remote}${branch ? `/${branch}` : ""}`);
    }
    if (executable === "git" && action === "remote" && words[2]?.toLowerCase() === "set-url") {
      remoteGit = true;
      const target = words.find((value, index) => index >= 3 && /^https?:\/\//i.test(value));
      if (target && validExternalTarget(target)) externalTargets.push(target);
      else detectors.push("shell.remote_git_target_missing");
    }
    if (executable === "gh" && action === "pr" && words[2]?.toLowerCase() === "merge") remoteGit = true;
    if (
      (executable === "git" && action === "tag" && !/^(?:--list|-l)$/i.test(words[2] ?? "")) ||
      (["npm", "pnpm", "yarn"].includes(executable) && action === "publish") ||
      (executable === "docker" && action === "push") ||
      (executable === "gh" && action === "release" && /^(?:create|delete|edit)$/i.test(words[2] ?? "")) ||
      (["kubectl", "helm", "terraform"].includes(executable) && /^(?:apply|destroy|upgrade|install)$/i.test(action))
    ) release = true;
    const isHttpTool = ["curl", "wget", "invoke-restmethod", "invoke-webrequest"].includes(executable);
    if (isHttpTool) {
      const lower = words.map((value) => value.toLowerCase());
      const methodIndex = lower.findIndex((value) => ["-x", "--request", "-method"].includes(value));
      const method = methodIndex >= 0 ? lower[methodIndex + 1] ?? "" : "";
      const hasWritePayload = lower.some((value) => /^(?:--data(?:-.+)?|-d|--form|-f|--upload-file)$/.test(value));
      const writes = /^(?:post|put|patch|delete)$/i.test(method) || hasWritePayload;
      const target = words.find((value) => /^https?:\/\//i.test(value));
      if (writes && target && validExternalTarget(target)) {
        externalWrite = true;
        externalTargets.push(target);
      } else if (writes) {
        detectors.push("shell.external_write_target_missing");
      }
    }
    if (["send_message", "send-email", "upload", "submit_form"].includes(executable)) {
      const rawTarget = words.find((value, index) => index > 0 && !value.startsWith("-"));
      if (rawTarget) {
        const target = `recipient:${rawTarget}`;
        if (validExternalTarget(target)) {
          externalWrite = true;
          externalTargets.push(target);
        }
      } else {
        detectors.push("shell.external_write_target_missing");
      }
    }
  }
  const runtime = /\b(?:stop-process|restart-service|stop-service|start-service|taskkill|sc\s+(?:start|stop)|shutdown)\b/i.test(effectCommand);
  const privilege = /\b(?:chmod|chown|icacls|takeown|set-acl|new-selfsignedcertificate)\b/i.test(effectCommand);
  const systemChange = /\b(?:winget|choco|scoop)\s+(?:install|uninstall|upgrade)\b|\b(?:npm|pnpm|yarn)\s+(?:install|add|remove|uninstall)\b[^\r\n]*(?:--global|-g)\b|\b(?:dism|msiexec)\b/i.test(effectCommand);
  const destructive = /\b(?:diskpart|format(?:\.exe)?|format-volume)\b\s+(?:[a-z]:|\\\\\.\\physicaldrive)|\bgit(?:\.exe)?\s+reset\s+--hard\b/i.test(effectCommand);
  const opaque = /(?:-encodedcommand\b|\bfrombase64string\b|\beval\s*\(|\bexec\s*\()/i.test(effectCommand);
  if (remoteGit) { kind = "remote_git"; detectors.push("shell.remote_git"); }
  if (release) { kind = "publish"; detectors.push("shell.release_production"); }
  if (externalWrite) { kind = "network_write"; detectors.push("shell.external_write"); }
  if ((externalWrite || remoteGit) && externalTargets.length > 0) {
    targets.splice(0, targets.length, ...new Set(externalTargets.filter(validExternalTarget)));
  }
  if (runtime) { kind = "process_control"; detectors.push("shell.runtime_control"); }
  if (privilege) detectors.push("shell.security_authority");
  if (systemChange) detectors.push("shell.software_system_change");
  if (destructive) { persistent = true; reversible = false; detectors.push("shell.irreversible"); }
  if (opaque) detectors.push("shell.opaque_execution");

  const effectful = persistent || externalWrite || remoteGit || release || runtime || privilege || systemChange || destructive;
  const conservativePythonRead = /^\s*(?:python|py)(?:\.exe)?\s+(?:-[^\s]+\s+)*-c\s+/i.test(command) &&
    !/\b(?:os\.(?:system|remove|unlink|rename|replace|mkdir|makedirs)|subprocess\.|shutil\.|requests\.|urllib\.|socket\.|pathlib\.[^\r\n]*(?:write|unlink|rename)|open\s*\([^)]*,\s*["'][wax+]|eval\s*\(|exec\s*\()/i.test(command);
  const conservativeNodeRead = /^\s*node(?:\.exe)?\s+-e\s+/i.test(command) &&
    !/\b(?:writeFile|appendFile|createWriteStream|mkdir|rm|unlink|rename|spawn|exec|fetch|https?\.request)\b/i.test(command);
  const knownLocalRead = /^\s*(?:git\s+(?:status|diff|show|log|grep|ls-files)|rg\b|grep\b|findstr\b|dir\b|ls\b|get-childitem\b|get-content\b|echo\b(?![^\r\n]*(?:>>?|1>>?)))/i.test(command) || conservativePythonRead || conservativeNodeRead;
  const knownLocalBuild = /^\s*(?:git\s+(?:add|commit|branch|switch|checkout)\b|npm\s+(?:ci|install|test|run\s+(?:test|build|typecheck|lint))\b|node\s+--test\b|tsc\b)/i.test(command);
  if (knownLocalRead && !effectful) kind = "read";
  const complete = !opaque && (!effectful || targets.length > 0 || remoteGit || release || runtime || privilege || destructive) && (knownLocalRead || knownLocalBuild || effectful);
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
    persistent: persistent || externalWrite || remoteGit || release || runtime || privilege || systemChange,
    complete,
    unresolved,
    detectors,
    adapterId: "shell.candidate-facts.v1",
    targetsAreExternal: externalWrite || remoteGit,
  };
}

function adaptStructured(tool: string, args: Record<string, unknown>): AdapterResult {
  const targets = directTargets(args);
  let kind: OperationKind =
    /^(?:read|read_file|read_text_file|grep|grep_files|glob|list|list_files|list_dir|list_directory|list_tasks|list_reports|list_issues|read_task|read_report|fcop_report|fcop_check|fcop_audit|get_team_status|inspect_task|search|find)$/.test(tool) ? "read" :
    /mkdir|create_directory|scratch\.create/.test(tool) ? "create" :
    /append/.test(tool) ? "append" :
    /delete|remove|cleanup/.test(tool) ? "delete" :
    /copy/.test(tool) ? "copy" :
    /move|rename/.test(tool) ? "move" :
    /write|edit|patch|create_file|scratch\.write/.test(tool) ? "write" :
    /^(?:write_task|create_task|write_report|write_issue|write_review|submit_review|review_task|approve_review|reject_review|mark_human_approved|archive_task|approve_task|reject_task|claim_task|submit_task|finish_task)$/.test(tool) ? "governance_change" :
    "unknown";
  const externalAction = /^(?:send_message|send_email|upload|submit_form|http_post|http_put|http_patch|http_delete|api_write)$/.test(tool);
  const external = externalAction && targets.length > 0;
  const runtime = /^(?:stop_process|restart_process|start_service|stop_service|restart_service|restart_gateway|stop_gateway)$/.test(tool);
  const privilege = /^(?:set_permission|set_acl|change_credentials|share_resource|change_security_boundary)$/.test(tool);
  const remoteGit = /^(?:git_push|remote_branch_delete|git_force_push)$/.test(tool);
  const release = /^(?:create_tag|create_release|publish_package|production_deploy)$/.test(tool);
  const systemChange = /^(?:install_system_software|uninstall_system_software|upgrade_system_software|install_global_tool)$/.test(tool);
  if (external) kind = "network_write";
  if (runtime) kind = "process_control";
  if (remoteGit) kind = "remote_git";
  if (release) kind = "publish";
  const governance = kind === "governance_change";
  const persistent = !["read", "unknown"].includes(kind) || privilege || systemChange;
  return {
    kind,
    targets,
    recursive: args["recursive"] === true,
    dynamic: targets.some((value) => /[*?]/.test(value)),
    external,
    privilege,
    runtime,
    governance,
    reversible: kind === "delete" ? "unknown" : true,
    persistent,
    complete: kind !== "unknown" && (kind === "read" || governance || targets.length > 0),
    unresolved: kind === "unknown"
      ? ["operation.kind"]
      : externalAction && targets.length === 0
        ? ["operation.external_target"]
        : persistent && !governance && targets.length === 0
          ? ["operation.exact_targets"]
          : [],
    detectors: [
      "structured.tool",
      ...(systemChange ? ["structured.software_system_change"] : []),
    ],
    adapterId: "structured.tool.v1",
    targetsAreExternal: external || remoteGit,
  };
}

function isGitTracked(projectRoot: string, target: string): boolean {
  if (!inside(projectRoot, target)) return false;
  const rel = relative(projectRoot, target);
  if (!rel || rel.startsWith("..")) return false;
  try {
    execFileSync("git", ["-C", projectRoot, "ls-files", "--error-unmatch", "--", rel], {
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
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
    git_tracked: isGitTracked(projectRoot, target),
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
  const canonicalTargets = adapted.targets.map((value) =>
    adapted.targetsAreExternal ? value.trim() : canonicalPath(root, value),
  );
  const recursiveDelete = adapted.kind === "delete" && canonicalTargets.some((target) => {
    try { return existsSync(target) && lstatSync(target).isDirectory(); } catch { return false; }
  });
  const taskId = String(input.taskId ?? input.args["task_id"] ?? "").trim();
  const sessionId = String(input.sessionId ?? "").trim();
  const threadKey = String(input.threadKey ?? input.args["thread_key"] ?? "").trim();
  const states: OperationFacts["target_state"][] = canonicalTargets.map((target) =>
    adapted.targetsAreExternal
      ? { lifecycle_class: "external", link_boundary: "unknown" }
      : classifyTarget(root, target, taskId, sessionId),
  );
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
      recursive: adapted.recursive || recursiveDelete,
      dynamic_or_wildcard: adapted.dynamic,
    },
    target_state: dominant,
    impact: {
      persistent: adapted.persistent,
      external: adapted.external,
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
  const matched = facts.impact.persistent &&
    !["network_write", "remote_git", "publish"].includes(facts.operation.kind) &&
    facts.operation.canonical_targets.some((target) => !inside(facts.context.project_root_realpath, target));
  return match("NEG.SCOPE.ESCAPE.WRITE", matched, ["context.project_root_realpath", "operation.canonical_targets"], "写入、移动或删除目标明确超出当前项目授权范围", ["context.project_root_realpath", "operation.canonical_targets"]);
}
export function negativeProtectedBoundary(facts: OperationFacts): NegativeMatch {
  return match("NEG.PROTECTED.BOUNDARY.WRITE", facts.impact.persistent && facts.target_state.lifecycle_class === "protected", ["target_state.lifecycle_class", "operation.canonical_targets"], "操作将修改受保护的 Runtime、审批或实例身份边界", ["target_state.lifecycle_class", "operation.canonical_targets"]);
}
export function negativeGovernanceBypass(facts: OperationFacts): NegativeMatch {
  const formal = /^(?:write_task|create_task|write_report|write_issue|write_review|submit_review|review_task|approve_review|reject_review|mark_human_approved|archive_task|approve_task|reject_task|claim_task|submit_task|finish_task)$/.test(facts.tool.canonical_tool_id);
  const selfAttested = facts.confidence.detector_ids.includes("governance.untrusted_self_attestation");
  return match("NEG.GOVERNANCE.BYPASS", selfAttested || (facts.impact.persistent && facts.impact.governance_change && facts.target_state.lifecycle_class === "governance" && !formal), ["tool.canonical_tool_id", "target_state.lifecycle_class", "impact.governance_change", "confidence.detector_ids"], "操作绕过正式治理工具直接改变治理事实源，或提交了不可验证的自证授权", ["tool.canonical_tool_id", "target_state.lifecycle_class"]);
}
export function negativeSharedState(facts: OperationFacts): NegativeMatch {
  return match("NEG.SHARED.STATE.WRITE", facts.impact.persistent && (facts.impact.shared || facts.target_state.lifecycle_class === "shared"), ["impact.shared", "target_state.lifecycle_class", "target_state.owner_task_id"], "操作会修改共享状态或其他任务、会话所有的资源", ["impact.shared", "target_state.owner_task_id"]);
}
export function negativeTrackedDelete(facts: OperationFacts): NegativeMatch {
  return match("NEG.TRACKED.DELETE", facts.operation.kind === "delete" && facts.target_state.git_tracked === true, ["operation.kind", "target_state.git_tracked", "operation.canonical_targets"], "操作将删除已确认受版本跟踪的源码、文档或产物", ["operation.kind", "target_state.git_tracked", "operation.canonical_targets"]);
}
export function negativeIrreversibleEffect(facts: OperationFacts): NegativeMatch {
  return match("NEG.IRREVERSIBLE.EFFECT", facts.impact.persistent && facts.impact.reversible === false, ["impact.persistent", "impact.reversible", "confidence.detector_ids"], "操作具有明确且不可恢复的永久破坏效果", ["impact.persistent", "impact.reversible"]);
}
export function negativeBulkDynamicTargets(facts: OperationFacts): NegativeMatch {
  const fixedTargets = facts.operation.canonical_targets.length;
  const matched = facts.operation.kind === "delete" && (
    (facts.operation.recursive && fixedTargets > 0) ||
    (facts.operation.dynamic_or_wildcard && fixedTargets > 1) ||
    fixedTargets > 200
  );
  return match("NEG.BULK.CLEANUP", matched, ["operation.kind", "operation.recursive", "operation.dynamic_or_wildcard", "operation.canonical_targets"], "操作将对已明确的目标集合执行递归、批量或通配清理", ["operation.kind", "operation.canonical_targets", "operation.recursive"]);
}
export function negativeExternalSideEffect(facts: OperationFacts): NegativeMatch {
  return match("NEG.EXTERNAL.WRITE", facts.impact.external && facts.operation.kind === "network_write", ["impact.external", "operation.kind"], "操作将向外部系统发送、上传、提交或修改数据", ["impact.external", "operation.kind"]);
}
export function negativeSecurityAuthority(facts: OperationFacts): NegativeMatch {
  return match("NEG.SECURITY.AUTHORITY", facts.impact.privilege_change, ["impact.privilege_change"], "操作将改变身份、权限、凭据或安全边界", ["impact.privilege_change"]);
}
export function negativeRuntimeControl(facts: OperationFacts): NegativeMatch {
  return match("NEG.RUNTIME.CONTROL", facts.impact.runtime_change || facts.operation.kind === "process_control", ["impact.runtime_change", "operation.kind"], "操作将控制稳定或共享运行实例、服务或基础设施", ["impact.runtime_change", "operation.kind"]);
}
export function negativeRemoteGitWrite(facts: OperationFacts): NegativeMatch {
  return match("NEG.REMOTE.GIT.WRITE", facts.operation.kind === "remote_git", ["operation.kind", "confidence.detector_ids"], "操作将写入远端 Git 或改写远端分支", ["operation.kind"]);
}
export function negativeReleaseProduction(facts: OperationFacts): NegativeMatch {
  return match("NEG.RELEASE.PRODUCTION", facts.operation.kind === "publish", ["operation.kind", "confidence.detector_ids"], "操作将创建发布、发布包或变更生产环境", ["operation.kind"]);
}
export function negativeSoftwareSystemChange(facts: OperationFacts): NegativeMatch {
  const matched = facts.confidence.detector_ids.some((id) => id.endsWith("software_system_change"));
  return match("NEG.SOFTWARE.SYSTEM.CHANGE", matched, ["confidence.detector_ids"], "操作将安装、卸载或升级系统级软件、服务或全局工具", ["confidence.detector_ids"]);
}
export function negativeContractChange(facts: OperationFacts): NegativeMatch {
  const contractTool = /^(?:edit_task_contract|change_task_scope|change_acceptance_gate)$/.test(facts.tool.canonical_tool_id);
  return match("NEG.TASK.CONTRACT.CHANGE", contractTool, ["tool.canonical_tool_id", "context.task_scope_digest"], "操作将改变正式任务范围、关系、Gate 或验收合同", ["tool.canonical_tool_id", "context.task_scope_digest"]);
}
export function negativeConcurrencyConflict(facts: OperationFacts): NegativeMatch {
  const conflict = facts.target_state.locked_or_in_use === true;
  return match("NEG.CONCURRENCY.CONFLICT", conflict, ["target_state.locked_or_in_use", "target_state.owner_session_id"], "目标存在由其他有效 Session 或 Writer Lock 持有的明确冲突", ["target_state.locked_or_in_use", "target_state.owner_session_id"]);
}

export const NEGATIVE_PREDICATES = [
  negativeScopeEscape,
  negativeProtectedBoundary,
  negativeGovernanceBypass,
  negativeSharedState,
  negativeTrackedDelete,
  negativeBulkDynamicTargets,
  negativeIrreversibleEffect,
  negativeExternalSideEffect,
  negativeSecurityAuthority,
  negativeRuntimeControl,
  negativeRemoteGitWrite,
  negativeReleaseProduction,
  negativeSoftwareSystemChange,
  negativeContractChange,
  negativeConcurrencyConflict,
] as const;

export function evaluateNegativePredicates(facts: OperationFacts): NegativeMatch[] {
  return NEGATIVE_PREDICATES.map((predicate) => predicate(facts)).filter((result) => result.matched);
}

export function operationFingerprint(facts: OperationFacts): string {
  return stableDigest({
    subject: {
      role: facts.subject.role,
      agent_id: facts.subject.agent_id,
    },
    context: facts.context,
    tool: facts.tool,
    operation: facts.operation,
    target_state: facts.target_state,
    impact: facts.impact,
  });
}
