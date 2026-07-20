/**
 * Role-level hard gate for native host tools (Cursor SDK edit/shell) and
 * workspace writes — complements fcop-mcp AuthorityGuard (MCP layer only).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  normalize,
  relative,
  resolve,
} from "node:path";

import { fcopLogsRuntimeDir } from "../logs/actionLogPaths.ts";
import { recordSkillInvocation } from "../pm/SkillInvocationJournal.ts";
import { resolveRoleFromAgentId, type ToolGuardRole } from "./ToolAuthorityGuard.ts";

export type ToolIntent = "read" | "write" | "shell" | "edit" | "mcp" | "unknown";

export type RoleToolChannel = "cursor_sdk" | "unknown";

export interface RoleToolDecision {
  allow: boolean;
  reason?: string;
  severity?: "warn" | "block";
}

export const ROLE_TOOL_BLOCKED = "CODEFLOWMU_POLICY_BLOCKED";

export const ROLE_TOOL_BLOCKED_MESSAGE = "CODEFLOWMU_POLICY_BLOCKED";

const PM_FCOP_MCP_ALLOW = new Set([
  "write_task",
  "create_task",
  "write_report",
  "read_task",
  "read_report",
  "list_tasks",
  "list_reports",
  "list_issues",
  "fcop_report",
  "fcop_check",
  "fcop_audit",
  "get_team_status",
  "inspect_task",
  "drop_suggestion",
  "write_issue",
  "submit_task",
  "claim_task",
  "new_workspace",
  "list_workspaces",
]);

const FCOP_ONE_SHOT_ALLOWED_TOOLS = new Set([
  "fcop_report",
  "fcop_check",
  "get_team_status",
  "list_tasks",
  "list_reports",
  "list_issues",
  "read_task",
  "read_report",
  "inspect_task",
  "create_task",
  "write_task",
  "write_report",
  "write_issue",
  "drop_suggestion",
  "new_workspace",
  "list_workspaces",
]);

const PM_WORKSPACE_READ = new Set([
  "read_file",
  "grep_files",
  "list_dir",
  "glob_file_search",
  "web_search",
  "web_extract",
  "web_research",
  "skill_search",
  "skill_learn",
  "skill_publish",
]);

const PM_GOVERNANCE_SKILL_PREFIXES = [
  "summarize_thread",
  "detect_thread_stall",
  "close_admin_task",
  "review_check",
  "wake_downstream",
  "pm.summarize_thread",
  "pm.detect_thread_stall",
  "pm.close_admin_task",
  "pm.review_check",
  "pm.wake_downstream",
  "write_planning_artifact",
  "pm.write_planning_artifact",
  "record_planning_skill_evidence",
  "pm.record_planning_skill_evidence",
];

const EDIT_TOOL_NAMES = new Set([
  "edit",
  "write",
  "strreplace",
  "applypatch",
  "create",
  "delete",
  "search_replace",
  "editnotebook",
  "edit_notebook",
]);

const READ_TOOL_NAMES = new Set([
  "read",
  "grep",
  "glob",
  "glob_file_search",
  "list_dir",
  "read_file",
  "grep_files",
  "semanticsearch",
  "codebase_search",
  "list_mcp_resources",
  "fetch_mcp_resource",
]);

const SHELL_TOOL_NAMES = new Set([
  "shell",
  "terminal",
  "run_terminal_cmd",
  "bash",
  "powershell",
  "execute_command",
]);

const PRODUCT_DIR_PREFIXES = [
  "codeflowmu-shell/",
  "packages/",
  "codeflowmu-desktop/panel/",
];

const PRODUCT_FILE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|html|css|scss|py|json|md|mdc|vue|svelte)$/i;

const SHELL_WRITE_PATTERNS: RegExp[] = [
  /\bset-content\b/i,
  /\bout-file\b/i,
  /\badd-content\b/i,
  /\becho\b[^|\n]*(?:>|>>)/i,
  /\bcat\b[^|\n]*(?:>|>>)/i,
  /\btee\b/i,
  /\bgit\s+commit\b/i,
  /\bgit\s+checkout\b/i,
  /\bgit\s+apply\b/i,
  /\b(?:del|erase|rmdir|rd|mkdir|copy|xcopy|robocopy|move|ren|rename)\b/i,
  /\b(?:new-item|remove-item|move-item|copy-item|rename-item)\b/i,
  /\bnpm\s+run\s+build\b/i,
  /\bpnpm\s+run\s+build\b/i,
  /\byarn\s+build\b/i,
  /\bpython(?:3)?\b[^\n|]*(?:>\s*(?!&|nul\b|\/dev\/null\b)|write|open\s*\([^)]*['"]w)/i,
  /\bpython(?:3)?\b[^\n|]*\bos\.makedirs?\s*\(/i,
  /\bpython(?:3)?\b[^\n|]*\.mkdir\s*\(/i,
  /\bpython(?:3)?\b[^\n|]*\bjson\.dump\s*\(/i,
  /\bpython(?:3)?\b[^\n|]*\.(?:write_text|write_bytes)\s*\(/i,
  /\bpython(?:3)?\b[^\n|]*\bshutil\./i,
  /\bnode\b[^\n|]*(?:writeFile|writeFileSync|createWriteStream)/i,
];

const SHELL_READ_PATTERNS: RegExp[] = [
  /^\s*cd\s+["']?[^&|<>]+["']?\s*$/i,
  /^\s*(?:rg|grep|findstr|select-string)\b/i,
  /^\s*(?:cat|type|get-content|head|tail|wc|ls|dir)\b/i,
  /^\s*cmd\s+\/c\s+(?:"\s*)?dir\b[\s\S]*$/i,
  /^\s*cmd\s+\/c\s+(["'])[\s\S]*(?:\bdir\b|\becho\b|\bif\s+exist\b)[\s\S]*\1\s*$/i,
  /^\s*cmd\s+\/c\s+(?:"\s*)?where\b[\s\S]*$/i,
  /^\s*(?:if\s*\(\s*)?test-path\b[\s\S]*(?:get-childitem|get-item|select-object|sort-object|where-object|format-table|measure-object|write-output)[\s\S]*$/i,
  /^\s*(?:get-childitem|get-item|select-object|sort-object|where-object|format-table|measure-object|write-output|foreach-object)\b/i,
  /^\s*@\([^)]+\)\s*\|\s*foreach-object\b[\s\S]*(?:test-path|get-childitem|get-item|select-object|sort-object|where-object|format-table|measure-object|write-output)[\s\S]*$/i,
  /^\s*git\s+(?:diff|status|log|show)\b/i,
  /^\s*(?:pwd|where|which)\b/i,
  /^\s*(?:node|npm|python|python3|py)\s+(?:--version|-v|version)\b/i,
  /^\s*(?:python|python3|py)\s+-c\s+(["'])[\s\S]*\bimport\b[\s\S]*\bprint\s*\([\s\S]*\)\1\s*(?:2>&1)?\s*$/i,
  /^\s*(?:python|python3|py)\s+-m\s+pip\s+show\s+[\w.-]+\s*(?:2>&1)?\s*$/i,
];

export type EvaluateRoleToolCallInput = {
  agentId: string;
  toolName: string;
  args?: Record<string, unknown>;
  projectRoot?: string;
  protectedRoots?: string[];
  /** Force the active-project write boundary outside Open-edition tests. */
  enforceProjectWriteBoundary?: boolean;
  channel?: RoleToolChannel;
};

function normalizeToolName(toolName: string): string {
  return String(toolName ?? "")
    .trim()
    .replace(/^mcp[_-]/i, "")
    .replace(/[^a-z0-9_]/gi, "")
    .toLowerCase();
}

function extractPathFromArgs(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  for (const key of [
    "path",
    "file_path",
    "filePath",
    "target_file",
    "targetFile",
    "destination",
    "destinationPath",
    "target",
  ]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function extractShellCommand(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  for (const key of ["command", "cmd", "script", "input"]) {
    const v = args[key];
    if (typeof v === "string") return v;
  }
  return JSON.stringify(args);
}

function shellRequiresMissingInteractiveArgument(command: string): boolean {
  const segments = command
    .trim()
    .split(/(?:\r?\n|;|&&)/)
    .map((part) => part.trim())
    .filter(Boolean);
  return segments.some((segment) => {
    if (/^(?:Invoke-WebRequest|iwr)\b/i.test(segment)) {
      return !/(?:^|\s)-Uri\s+\S+/i.test(segment) && !/https?:\/\//i.test(segment);
    }
    if (/^curl\b/i.test(segment)) {
      return !/https?:\/\//i.test(segment) && !/\s--url\s+\S+/i.test(segment);
    }
    return false;
  });
}

function normalizeRelPath(projectRoot: string | undefined, rawPath: string): string {
  const p = rawPath.replace(/\\/g, "/");
  if (!projectRoot) return p.replace(/^\/+/, "");
  if (isAbsolute(rawPath)) {
    try {
      return relative(resolve(projectRoot), resolve(rawPath)).replace(/\\/g, "/");
    } catch {
      return p;
    }
  }
  return p.replace(/^\.?\//, "");
}

function normalizeAbsPath(rawPath: string, cwd?: string): string {
  const base = cwd ? resolve(cwd) : process.cwd();
  const abs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(base, rawPath);
  return normalize(abs).replace(/\\/g, "/").toLowerCase();
}

/**
 * Resolve symlinks/junctions for the nearest existing ancestor. This also
 * protects not-yet-created files whose parent is a reparse point.
 */
function canonicalBoundaryPath(rawPath: string, cwd?: string): string {
  const base = cwd ? resolve(cwd) : process.cwd();
  const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(base, rawPath);
  let probe = absolute;
  const missing: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    missing.unshift(basename(probe));
    probe = parent;
  }
  try {
    return normalize(resolve(realpathSync.native(probe), ...missing))
      .replace(/\\/g, "/")
      .toLowerCase();
  } catch {
    return normalize(absolute).replace(/\\/g, "/").toLowerCase();
  }
}

function isInsideActiveProject(projectRoot: string, rawPath: string): boolean {
  return isInsideAbs(
    canonicalBoundaryPath(projectRoot),
    canonicalBoundaryPath(rawPath, projectRoot),
  );
}

function shouldEnforceProjectWriteBoundary(
  input: EvaluateRoleToolCallInput,
): boolean {
  return input.enforceProjectWriteBoundary === true;
}

function extractAbsolutePathsFromCommand(command: string): string[] {
  const paths: string[] = [];
  const quoted = /(["'`])((?:[a-zA-Z]:[\\/]|\\\\)[^"'`\r\n]+?)\1/g;
  for (const match of command.matchAll(quoted)) {
    if (match[2]) paths.push(match[2].trim());
  }
  const unquoted = /(?:^|\s)((?:[a-zA-Z]:[\\/]|\\\\)[^\s|;&<>]+)/g;
  for (const match of command.matchAll(unquoted)) {
    if (match[1]) paths.push(match[1].replace(/[),]+$/, "").trim());
  }
  return Array.from(new Set(paths));
}

function commandEscapesActiveProject(
  command: string,
  input: EvaluateRoleToolCallInput,
): boolean {
  if (!input.projectRoot) return true;
  const args = input.args ?? {};
  const workingDirectory =
    typeof args["workingDirectory"] === "string"
      ? args["workingDirectory"]
      : typeof args["cwd"] === "string"
        ? args["cwd"]
        : input.projectRoot;
  if (!isInsideActiveProject(input.projectRoot, workingDirectory)) return true;
  if (/(?:^|[;&|]\s*|\s)(?:cd|pushd)\s+(?:\/d\s+)?["']?\.\.(?:[\\/]|["']?(?:\s|$))/i.test(command)) {
    return true;
  }
  return extractAbsolutePathsFromCommand(command).some(
    (path) => !isInsideActiveProject(input.projectRoot!, path),
  );
}

function isInsideAbs(parent: string, child: string): boolean {
  const p = normalize(parent).replace(/\\/g, "/").toLowerCase();
  const c = normalize(child).replace(/\\/g, "/").toLowerCase();
  return c === p || c.startsWith(`${p}/`);
}

function isOpenRuntimeWritablePath(protectedRoot: string, absPath: string): boolean {
  const root = normalize(protectedRoot).replace(/\\/g, "/").toLowerCase();
  const path = normalize(absPath).replace(/\\/g, "/").toLowerCase();
  return [
    "projects",
    "workspace",
    "fcop",
    ".codeflowmu",
    ".fcop",
    "codeflowmu-shell/fcop",
    "codeflowmu-shell/.codeflowmu",
  ].some((prefix) => isInsideAbs(`${root}/${prefix}`, path));
}

function commandMentionsOpenRuntimeWritablePath(protectedRoot: string, command: string): boolean {
  const root = normalize(protectedRoot).replace(/\\/g, "/").toLowerCase();
  const cmd = command.replace(/\\/g, "/").toLowerCase();
  return [
    "projects",
    "workspace",
    "fcop",
    ".codeflowmu",
    ".fcop",
    "codeflowmu-shell/fcop",
    "codeflowmu-shell/.codeflowmu",
  ].some((prefix) => cmd.includes(`${root}/${prefix}`));
}

function commandMentionsOpenProgramPath(protectedRoot: string, command: string): boolean {
  const root = normalize(protectedRoot).replace(/\\/g, "/").toLowerCase();
  const cmd = command.replace(/\\/g, "/").toLowerCase();
  return [
    "codeflowmu-shell/src",
    "codeflowmu-shell/package.json",
    "codeflowmu-shell/tsconfig.json",
    "codeflowmu-desktop",
    "packages",
    "docs",
    "adoptedsource",
    "package.json",
    "package-lock.json",
    "start-codeflowmu-open.bat",
    "version.json",
  ].some((suffix) => cmd.includes(`${root}/${suffix}`));
}

function protectedRootsFromEnv(): string[] {
  return [
    process.env["CODEFLOW_OPEN_PROTECTED_ROOTS"],
    process.env["CODEFLOW_OPEN_HOST_ROOT"],
  ]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .flatMap((v) => v.split(delimiter))
    .map((v) => v.trim())
    .filter(Boolean);
}

function inferOpenProtectedRoot(projectRoot?: string): string | null {
  if (process.env["CODEFLOW_OPEN_EDITION"] !== "1" || !projectRoot) return null;
  const normalized = normalize(projectRoot).replace(/\\/g, "/");
  const lower = normalized.toLowerCase();
  const indexes = ["/projects/", "/workspace/"]
    .map((marker) => lower.indexOf(marker))
    .filter((idx) => idx > 0);
  if (indexes.length === 0) return null;
  return normalized.slice(0, Math.min(...indexes));
}

function effectiveProtectedRoots(input: EvaluateRoleToolCallInput): string[] {
  const inferred = inferOpenProtectedRoot(input.projectRoot);
  const roots = [
    ...(input.protectedRoots ?? []),
    ...protectedRootsFromEnv(),
    ...(inferred ? [inferred] : []),
  ];
  return Array.from(new Set(roots.map((r) => normalize(r)).filter(Boolean)));
}

function pathTouchesProtectedInstall(
  rawPath: string,
  input: EvaluateRoleToolCallInput,
): boolean {
  const protectedRoots = effectiveProtectedRoots(input);
  if (protectedRoots.length === 0) return false;
  const absPath = normalizeAbsPath(rawPath, input.projectRoot);
  const projectRoot = input.projectRoot ? normalizeAbsPath(input.projectRoot) : null;
  if (projectRoot && isInsideAbs(projectRoot, absPath)) return false;
  return protectedRoots.some(
    (root) => isInsideAbs(root, absPath) && !isOpenRuntimeWritablePath(root, absPath),
  );
}

function commandTouchesProtectedInstall(
  command: string,
  input: EvaluateRoleToolCallInput,
): boolean {
  const protectedRoots = effectiveProtectedRoots(input);
  if (protectedRoots.length === 0) return false;
  const normalizedCommand = command.replace(/\\/g, "/").toLowerCase();
  for (const root of protectedRoots) {
    const normalizedRoot = normalize(root).replace(/\\/g, "/").toLowerCase();
    if (
      normalizedCommand.includes(normalizedRoot) &&
      commandMentionsOpenProgramPath(root, command) &&
      !commandMentionsOpenRuntimeWritablePath(root, command)
    ) {
      return true;
    }
  }
  return /\.\.\/\.\.\/(?:codeflowmu-shell|codeflowmu-desktop|packages|docs|adoptedsource)\b/i.test(
    normalizedCommand,
  );
}

export function isProductPath(
  rawPath: string,
  projectRoot?: string,
): boolean {
  const rel = normalizeRelPath(projectRoot, rawPath).toLowerCase();
  if (!rel || rel.startsWith("..")) return false;
  for (const prefix of PRODUCT_DIR_PREFIXES) {
    if (rel === prefix.slice(0, -1) || rel.startsWith(prefix)) return true;
  }
  if (PRODUCT_FILE_EXT.test(rel)) {
    if (
      rel.startsWith("fcop/") ||
      rel.startsWith(".codeflowmu/") ||
      rel.startsWith(".fcop/")
    ) {
      return false;
    }
    return true;
  }
  return false;
}

function isPmGovernanceSkill(toolName: string): boolean {
  const n = toolName.toLowerCase();
  return PM_GOVERNANCE_SKILL_PREFIXES.some(
    (p) => n === p.toLowerCase() || n.endsWith(p.toLowerCase()),
  );
}

export function classifyToolIntent(
  toolName: string,
  args?: Record<string, unknown>,
): ToolIntent {
  const n = normalizeToolName(toolName);
  if (PM_FCOP_MCP_ALLOW.has(n) || PM_WORKSPACE_READ.has(n)) return "mcp";
  if (EDIT_TOOL_NAMES.has(n)) return "edit";
  if (READ_TOOL_NAMES.has(n)) return "read";
  if (SHELL_TOOL_NAMES.has(n)) return "shell";
  if (n === "writefile" || n === "write_file") return "write";
  if (n.includes("write") && !n.includes("write_task") && !n.includes("write_report")) {
    return "write";
  }
  if (n.includes("read")) return "read";
  const cmd = extractShellCommand(args);
  if (/\b(set-content|out-file|git\s+commit)\b/i.test(cmd)) return "shell";
  return "unknown";
}

function shellLooksWriteOnly(command: string): boolean {
  const trimmed = command
    .replace(/\s+\d?>&\d\b/g, "")
    .replace(/\s+\d?>\s*(?:nul|\/dev\/null)\b/gi, "")
    .trim();
  if (!trimmed) return false;
  if (SHELL_WRITE_PATTERNS.some((re) => re.test(trimmed))) return true;
  return false;
}

function shellLooksReadOnlyFcopProbe(command: string): boolean {
  const match = command.match(/^\s*(?:python|python3|py)\s+-c\s+(["'])([\s\S]*)\1\s*(?:2>&1)?\s*$/i);
  if (!match) return false;
  const code = match[2] ?? "";
  const importsFcopProject = /\bfrom\s+fcop\.project\s+import\s+Project\b/.test(code);
  const readsFcopState =
    /\.\s*(?:is_initialized|status|topology|topology_report|workspace_layout)\s*\(/.test(code) ||
    /\.\s*list_(?:tasks|reports|issues|reviews|history)\s*\(/.test(code);
  const hasWriteIntent =
    /\b(?:write|remove|unlink|rmdir|mkdir|replace)\s*\(/.test(code) ||
    /\bopen\s*\([^)]*['"]w/.test(code) ||
    /\.write_text\s*\(/.test(code) ||
    /\.write_bytes\s*\(/.test(code) ||
    /\bshutil\./.test(code);
  return importsFcopProject && readsFcopState && !hasWriteIntent;
}

function shellLooksAllowedFcopOneShot(command: string): boolean {
  const trimmed = command
    .replace(/\s+\d?>&\d\b/g, "")
    .replace(/\s+\d?>\s*(?:nul|\/dev\/null)\b/gi, "")
    .trim();
  if (!/fcop_invoke_once\.py/i.test(trimmed)) return false;
  if (shellLooksAllowedFcopTempPayload(trimmed)) return true;
  const hasDangerousExtraWrite = [
    /\bset-content\b/i,
    /\bout-file\b/i,
    /\badd-content\b/i,
    /\becho\b[^|\n]*(?:>|>>)/i,
    /\bcat\b[^|\n]*(?:>|>>)/i,
    /\btee\b/i,
    /\bgit\s+(?:commit|checkout|apply)\b/i,
    /\b(?:del|erase|rmdir|rd|mkdir|copy|xcopy|robocopy|move|ren|rename)\b/i,
    /\b(?:new-item|remove-item|move-item|copy-item|rename-item)\b/i,
    /\b(?:writeFile|writeFileSync|createWriteStream)\b/i,
    /\bopen\s*\([^)]*['"]w/i,
    />\s*(?!&|nul\b|\/dev\/null\b)/i,
  ].some((re) => re.test(trimmed));
  if (hasDangerousExtraWrite) return false;
  const match = trimmed.match(
    /^\s*(?:python|python3|py|["'][^"']*python(?:\.exe)?["'])\s+["'][^"']*fcop_invoke_once\.py["']\s+["'][^"']+["']\s+([\s\S]+?)\s*$/i,
  );
  const tail = (match ? match[1] : trimmed) ?? "";
  const jsonTool = tail.match(/["']?tool["']?\s*[:=]\s*["']([a-z0-9_]+)["']/i)?.[1];
  const psTool = tail.match(/\btool\s*=\s*["']([a-z0-9_]+)["']/i)?.[1];
  const firstToken = match ? tail.trim().match(/^["']?([a-z0-9_]+)["']?(?:\s|$)/i)?.[1] : undefined;
  const tool = (jsonTool ?? psTool ?? firstToken ?? "").toLowerCase();
  if (FCOP_ONE_SHOT_ALLOWED_TOOLS.has(tool)) return true;
  for (const t of FCOP_ONE_SHOT_ALLOWED_TOOLS) {
    if (new RegExp(`["']${t}["']|\\b${t}\\b`, "i").test(tail)) return true;
  }
  return false;
}

function shellLooksAllowedFcopTempPayload(command: string): boolean {
  const assignsTempPayload =
    /\$payloadPath\s*=\s*["']\$env:TEMP\\fcop-[^"']+\.json["']/i.test(command) ||
    /\$payloadPath\s*=\s*join-path\s+\$env:TEMP\s+["']fcop-[^"']+\.json["']/i.test(command);
  if (!assignsTempPayload) return false;

  const invokesTempPayload =
    /\bpython(?:3)?\s+\$py\s+\$root\s+\$payloadPath\b/i.test(command) ||
    /\bpython(?:3)?\b[\s\S]*fcop_invoke_once\.py[\s\S]*\$payloadPath\b/i.test(command);
  if (!invokesTempPayload) return false;

  const protectedWrite = /\b(?:set-content|out-file|add-content|new-item|remove-item|move-item|copy-item|rename-item)\b[\s\S]*(?:D:\\CodeFlowMu-open|D:\/CodeFlowMu-open|D:\\codeflowmu|D:\/codeflowmu)/i.test(
    command,
  );
  if (protectedWrite) return false;

  const dangerousBeyondTempPayload = [
    /\b(?:del|erase|rmdir|rd|mkdir|copy|xcopy|robocopy|move|ren|rename)\b/i,
    /\bgit\s+(?:commit|checkout|apply)\b/i,
    /\b(?:writeFile|writeFileSync|createWriteStream)\b/i,
    /\bopen\s*\([^)]*['"]w/i,
    />\s*(?!&|nul\b|\/dev\/null\b)/i,
  ].some((re) => re.test(command));
  if (dangerousBeyondTempPayload) return false;

  const tool =
    command.match(/["']?tool["']?\s*[:=]\s*["']([a-z0-9_]+)["']/i)?.[1] ??
    command.match(/\btool\s*=\s*["']([a-z0-9_]+)["']/i)?.[1] ??
    "";
  return FCOP_ONE_SHOT_ALLOWED_TOOLS.has(tool.toLowerCase());
}

function shellLooksReadOnlyLedgerCli(command: string): boolean {
  const trimmed = command
    .replace(/\s+\d?>&\d\b/g, "")
    .replace(/\s+\d?>\s*(?:nul|\/dev\/null)\b/gi, "")
    .trim();
  if (!/\bledger_cli\.ts\b/i.test(trimmed)) return false;
  if (!/\b(?:review_check|wake_downstream_plan|summarize_thread|detect_thread_stall|close_admin_task)\b/i.test(trimmed)) return false;

  const hasWriteIntent = [
    /\bset-content\b/i,
    /\bout-file\b/i,
    /\badd-content\b/i,
    /\becho\b[^|\n]*(?:>|>>)/i,
    /\bcat\b[^|\n]*(?:>|>>)/i,
    /\btee\b/i,
    /\bgit\s+(?:commit|checkout|apply)\b/i,
    /\b(?:del|erase|rmdir|rd|mkdir|copy|xcopy|robocopy|move|ren|rename)\b/i,
    /\b(?:new-item|remove-item|move-item|copy-item|rename-item)\b/i,
    /\b(?:writeFile|writeFileSync|createWriteStream)\b/i,
    /\bopen\s*\([^)]*['"]w/i,
    />\s*(?!&|nul\b|\/dev\/null\b)/i,
  ].some((re) => re.test(trimmed));
  if (hasWriteIntent) return false;

  return /^\s*(?:(?:cd|pushd)\s+(?:\/d\s+)?["'][^"']+["']\s*&&\s*)?(?:npx\s+(?:--yes\s+)?tsx|node\s+--import\s+[^ ]+\s+--test|tsx)\s+["']?[^"']*ledger_cli\.ts["']?\s+(?:review_check|wake_downstream_plan|summarize_thread|detect_thread_stall|close_admin_task)\b[\s\S]*$/i.test(
    trimmed,
  );
}

function shellLooksLocalPmGovernanceApi(command: string): boolean {
  const trimmed = command
    .replace(/\s+\d?>&\d\b/g, "")
    .replace(/\s+\d?>\s*(?:nul|\/dev\/null)\b/gi, "")
    .trim();
  if (!trimmed) return false;
  if (!/\b(?:curl|curl\.exe|invoke-restmethod|irm|invoke-webrequest|iwr)\b/i.test(trimmed)) {
    return false;
  }
  if (!/https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v2\/pm\/governance\//i.test(trimmed)) {
    return false;
  }
  const allowedEndpoint =
    /\/api\/v2\/pm\/governance\/(?:review-check|wake-downstream|close-draft|cycle\/recent|thread\/[^"'`\s]+\/(?:summary|stall))/i.test(
      trimmed,
    );
  if (!allowedEndpoint) return false;

  const hasUnsafeShellWrite = [
    /\bset-content\b/i,
    /\bout-file\b/i,
    /\badd-content\b/i,
    /\becho\b[^|\n]*(?:>|>>)/i,
    /\bcat\b[^|\n]*(?:>|>>)/i,
    /\btee\b/i,
    /\bgit\s+(?:commit|checkout|apply)\b/i,
    /\b(?:del|erase|rmdir|rd|mkdir|copy|xcopy|robocopy|move|ren|rename)\b/i,
    /\b(?:new-item|remove-item|move-item|copy-item|rename-item)\b/i,
    /\b(?:writeFile|writeFileSync|createWriteStream)\b/i,
    /\bopen\s*\([^)]*['"]w/i,
    />\s*(?!&|nul\b|\/dev\/null\b)/i,
  ].some((re) => re.test(trimmed));
  return !hasUnsafeShellWrite;
}

function shellLooksReadOnly(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (shellLooksAllowedFcopOneShot(trimmed)) return true;
  if (shellLooksReadOnlyLedgerCli(trimmed)) return true;
  if (shellLooksLocalPmGovernanceApi(trimmed)) return true;
  if (shellLooksWriteOnly(trimmed)) return false;
  if (
    SHELL_READ_PATTERNS.some((re) => re.test(trimmed)) ||
    shellLooksReadOnlyFcopProbe(trimmed) ||
    shellLooksAllowedFcopOneShot(trimmed) ||
    shellLooksReadOnlyLedgerCli(trimmed) ||
    shellLooksLocalPmGovernanceApi(trimmed)
  ) {
    return true;
  }
  const parts = trimmed
    .split(
      /\s*(?:&&|;\s*(?=(?:if\s*\(|test-path|cd|python|python3|py|git|rg|grep|findstr|select-string|cat|type|get-content|get-childitem|get-item|select-object|sort-object|where-object|format-table|measure-object|write-output|foreach-object|head|tail|wc|ls|dir|pwd|where|which|node|npm)\b))\s*/gi,
    )
    .map((part) => part.trim())
    .filter(Boolean);
  const probes = parts.length > 0 ? parts : [trimmed];
  return probes.every(
    (part) =>
      SHELL_READ_PATTERNS.some((re) => re.test(part)) ||
      shellLooksReadOnlyFcopProbe(part) ||
      shellLooksAllowedFcopOneShot(part) ||
      shellLooksReadOnlyLedgerCli(part) ||
      shellLooksLocalPmGovernanceApi(part),
  );
}

function evaluatePmToolCall(input: EvaluateRoleToolCallInput): RoleToolDecision {
  const toolNorm = normalizeToolName(input.toolName);
  const args = input.args ?? {};
  const intent = classifyToolIntent(input.toolName, args);

  if (
    PM_FCOP_MCP_ALLOW.has(toolNorm) ||
    PM_WORKSPACE_READ.has(toolNorm) ||
    isPmGovernanceSkill(input.toolName)
  ) {
    if (toolNorm === "write_file" || toolNorm === "writefile") {
      const path = extractPathFromArgs(args);
      if (path && isProductPath(path, input.projectRoot)) {
        return {
          allow: false,
          severity: "block",
          reason: "Current role must dispatch implementation work through FCoP task files",
        };
      }
    }
    return { allow: true };
  }

  if (intent === "edit" || EDIT_TOOL_NAMES.has(toolNorm)) {
    const path = extractPathFromArgs(args);
    if (!path || isProductPath(path, input.projectRoot)) {
      return {
        allow: false,
        severity: "block",
        reason: "Current role must dispatch implementation work through FCoP task files",
      };
    }
  }

  if (toolNorm === "write_file" || intent === "write") {
    const path = extractPathFromArgs(args);
    if (!path || isProductPath(path, input.projectRoot)) {
      return {
        allow: false,
        severity: "block",
        reason: "Current role must dispatch implementation work through FCoP task files",
      };
    }
  }

  if (intent === "read" || READ_TOOL_NAMES.has(toolNorm)) {
    return { allow: true };
  }

  if (intent === "shell" || SHELL_TOOL_NAMES.has(toolNorm)) {
    const cmd = extractShellCommand(args);
    if (shellLooksAllowedFcopOneShot(cmd)) return { allow: true };
    if (shellLooksReadOnly(cmd)) return { allow: true };
    if (shellLooksWriteOnly(cmd)) {
      return {
        allow: false,
        severity: "block",
        reason: "Current role shell is read-only; dispatch write work through FCoP task files",
      };
    }
    return {
      allow: false,
      severity: "block",
      reason: "PM shell command not in read-only allowlist",
    };
  }

  if (intent === "unknown") {
    return { allow: true, severity: "warn" };
  }

  return { allow: true };
}

function pmImplementationOverrideAllows(input: EvaluateRoleToolCallInput): boolean {
  const args = input.args ?? {};
  if (args["pm_implementation_override"] !== true) return false;
  if (String(args["approved_by"] ?? "").trim().toUpperCase() !== "ADMIN") return false;
  if (!String(args["reason"] ?? "").trim() || !String(args["task_id"] ?? "").trim()) {
    return false;
  }
  const expiresAt = Date.parse(String(args["expires_at"] ?? ""));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
  const scopeRaw = args["scope"];
  const scope = (Array.isArray(scopeRaw) ? scopeRaw : [scopeRaw])
    .filter((value): value is string => typeof value === "string")
    .map((value) => normalizeRelPath(input.projectRoot, value).toLowerCase());
  const target = extractPathFromArgs(args);
  if (!target || scope.length === 0) return false;
  const rel = normalizeRelPath(input.projectRoot, target).toLowerCase();
  return scope.some((allowed) => rel === allowed || rel.startsWith(`${allowed.replace(/\/$/, "")}/`));
}

export function evaluateRoleToolCall(
  input: EvaluateRoleToolCallInput,
): RoleToolDecision {
  const args = input.args ?? {};
  const toolNorm = normalizeToolName(input.toolName);
  const intent = classifyToolIntent(input.toolName, args);
  const path = extractPathFromArgs(args);

  if (intent === "shell" || SHELL_TOOL_NAMES.has(toolNorm)) {
    const cmd = extractShellCommand(args);
    if (shellRequiresMissingInteractiveArgument(cmd)) {
      return {
        allow: false,
        severity: "block",
        reason:
          "Interactive web command is missing an explicit URI; provide -Uri/--url so the shared Runtime terminal cannot stop for input",
      };
    }
  }

  if (shouldEnforceProjectWriteBoundary(input)) {
    if (
      (intent === "edit" || intent === "write" || EDIT_TOOL_NAMES.has(toolNorm)) &&
      (!input.projectRoot || !path || !isInsideActiveProject(input.projectRoot, path))
    ) {
      return {
        allow: false,
        severity: "block",
        reason:
          "Open edition write boundary: native writes are allowed only inside the Panel active project root",
      };
    }
    if (intent === "shell" || SHELL_TOOL_NAMES.has(toolNorm)) {
      const cmd = extractShellCommand(args);
      if (shellLooksWriteOnly(cmd) && commandEscapesActiveProject(cmd, input)) {
        return {
          allow: false,
          severity: "block",
          reason:
            "Open edition write boundary: shell writes cannot escape the Panel active project root",
        };
      }
    }
  }
  if (
    path &&
    (intent === "edit" || intent === "write" || EDIT_TOOL_NAMES.has(toolNorm)) &&
    pathTouchesProtectedInstall(path, input)
  ) {
    return {
      allow: false,
      severity: "block",
      reason: "Open edition install directory is read-only; write only inside the active project root",
    };
  }
  if (intent === "shell" || SHELL_TOOL_NAMES.has(toolNorm)) {
    const cmd = extractShellCommand(args);
    if (shellLooksWriteOnly(cmd) && commandTouchesProtectedInstall(cmd, input)) {
      return {
        allow: false,
        severity: "block",
        reason: "Open edition install directory is read-only; shell writes to tool files are not allowed",
      };
    }
  }

  const role: ToolGuardRole = resolveRoleFromAgentId(input.agentId);
  if (role !== "PM") {
    return { allow: true };
  }
  if (pmImplementationOverrideAllows(input)) {
    return { allow: true };
  }
  return evaluatePmToolCall(input);
}

export function formatRoleToolBlockedPayload(
  decision: RoleToolDecision,
): string {
  return decision.reason
    ? `${ROLE_TOOL_BLOCKED_MESSAGE}: ${decision.reason}`
    : ROLE_TOOL_BLOCKED_MESSAGE;
}

export type RecordRoleToolBlockedInput = {
  projectRoot: string;
  agentId: string;
  toolName: string;
  reason?: string;
  channel?: RoleToolChannel;
  sessionId?: string;
  runId?: string;
  taskId?: string;
};

function appendRuntimeRoleToolBlockedEvent(
  projectRoot: string,
  payload: Record<string, unknown>,
): void {
  const dir = fcopLogsRuntimeDir(projectRoot);
  try {
    mkdirSync(dir, { recursive: true });
    const d = new Date();
    const key = d.toISOString().slice(0, 10).replace(/-/g, "");
    const path = `${dir}/runtime-events-${key}.jsonl`.replace(/\\/g, "/");
    appendFileSync(path, `${JSON.stringify(payload)}\n`, "utf-8");
  } catch {
    /* best-effort */
  }
}

export async function recordRoleToolBlocked(
  input: RecordRoleToolBlockedInput,
): Promise<void> {
  const role = resolveRoleFromAgentId(input.agentId);
  const at = new Date().toISOString();
  const eventPayload = {
    ts: Date.now(),
    at,
    event_type: "role_tool_blocked",
    agent_id: input.agentId,
    role,
    tool: input.toolName,
    reason:
      input.reason ??
      "Current role must dispatch implementation work through FCoP task files",
    suggested_action: "write_task_to_responsible_role",
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
    ...(input.runId ? { run_id: input.runId } : {}),
    ...(input.taskId ? { task_id: input.taskId } : {}),
    ...(input.channel ? { channel: input.channel } : {}),
  };

  appendRuntimeRoleToolBlockedEvent(input.projectRoot, eventPayload);

  try {
    await recordSkillInvocation(input.projectRoot, {
      skill_id: "role_tool_blocked",
      channel: "agent_runtime",
      triggered_by: input.agentId,
      caller_role: role,
      outcome: "failed",
      summary: `${ROLE_TOOL_BLOCKED_MESSAGE} tool=${input.toolName} reason=${input.reason ?? "blocked"}`,
      ...(input.taskId ? { task_id: input.taskId } : {}),
    });
  } catch {
    /* best-effort */
  }
}

/** Dispatch routing hint for PM when landing work is needed. */
export function suggestDispatchRoleForWork(kind: string): string {
  const k = kind.toLowerCase();
  if (/code|ui|api|test|impl|panel|html|css|typescript|javascript/.test(k)) {
    return "DEV";
  }
  if (/ops|runtime|log|env|recover|sop|deploy|restart/.test(k)) {
    return "OPS";
  }
  if (/qa|accept|verify|screenshot|user.path|复测|验收/.test(k)) {
    return "QA";
  }
  if (/audit|eval|fact|compliance|规则|观察/.test(k)) {
    return "EVAL";
  }
  return "PM";
}
