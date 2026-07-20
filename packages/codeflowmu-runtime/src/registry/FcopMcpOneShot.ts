import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LEADER_TOOLS } from "../skill/FcopToolProfile.ts";

const ONCE_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/fcop_invoke_once.py",
);

/** Windows stdio MCP 易死锁；可用 CODEFLOW_FCOP_ONE_SHOT=1 强制一次性 Python 调用。 */
export function shouldUseFcopOneShot(): boolean {
  return (
    process.platform === "win32" ||
    process.env.CODEFLOW_FCOP_ONE_SHOT === "1"
  );
}

export function resolvePythonBin(command: string): string {
  if (command === "python" || command === "python3") {
    return process.env.PYTHON_BIN || command;
  }
  return command;
}

/** fcop-mcp-filter 用 tsx 作 command；一次性调用必须用 FCOP_PYTHON_BIN 或 python。 */
export function resolveOneShotPythonBin(mcpConfig: {
  command: string;
  env?: Record<string, string | undefined>;
}): string {
  const fromEnv = mcpConfig.env?.FCOP_PYTHON_BIN?.trim();
  if (fromEnv) return resolvePythonBin(fromEnv);
  const cmd = mcpConfig.command?.trim() || "python";
  if (cmd === "tsx" || cmd === "node" || cmd.endsWith(".ts")) {
    return resolvePythonBin(process.env.PYTHON_BIN || "python");
  }
  return resolvePythonBin(cmd);
}

export function parseAllowedToolsFromEnv(
  env?: Record<string, string | undefined>,
): string[] {
  const raw = env?.FCOP_ALLOWED_TOOLS?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Gemini function declarations when we skip long-lived MCP (tools/list). */
type GoogleToolParameters = {
  type: "OBJECT";
  properties: Record<string, unknown>;
  required?: string[];
};

const STRING_PROP = { type: "STRING" } as const;

/** fcop-mcp 3.2.x: optional lang on status/report tools; heavy tools also accept full/limit/scope. */
const FCOP_LANG_PROP = {
  type: "STRING",
  enum: ["zh", "en"],
  description: "Output language zh or en. Omit for default (zh).",
} as const;

const FCOP_STATIC_TOOL_SCHEMAS: Record<string, GoogleToolParameters> = {
  "pm.summarize_thread": {
    type: "OBJECT",
    properties: { thread_key: { ...STRING_PROP, description: "FCoP thread_key." } },
    required: ["thread_key"],
  },
  "pm.detect_thread_stall": {
    type: "OBJECT",
    properties: { thread_key: { ...STRING_PROP, description: "FCoP thread_key." } },
    required: ["thread_key"],
  },
  "pm.close_admin_task": {
    type: "OBJECT",
    properties: {
      thread_key: { ...STRING_PROP, description: "thread_key; optional when task_id is provided." },
      task_id: { ...STRING_PROP, description: "ADMIN to PM root task id; optional when thread_key is provided." },
    },
  },
  "pm.wake_downstream": {
    type: "OBJECT",
    properties: {
      task_id: { ...STRING_PROP, description: "Existing PM downstream task id." },
      role: { type: "STRING", enum: ["DEV", "OPS", "QA"], description: "Downstream role." },
      reason: { ...STRING_PROP, description: "Runtime wake reason." },
      thread_key: { ...STRING_PROP, description: "FCoP thread_key." },
      agent_id: { ...STRING_PROP, description: "Optional target agent id." },
    },
    required: ["task_id", "role"],
  },
  "pm.review_check": {
    type: "OBJECT",
    properties: {
      task_id: { ...STRING_PROP, description: "Related task id." },
      report_id: { ...STRING_PROP, description: "Related report id." },
    },
  },
  "pm.record_planning_skill_evidence": {
    type: "OBJECT",
    properties: {
      skill_id: { ...STRING_PROP, description: "Executed PM/UI Playbook skill id." },
      task_id: { ...STRING_PROP, description: "ADMIN to PM root task id." },
      thread_key: { ...STRING_PROP, description: "Optional FCoP thread_key." },
      input_context: { ...STRING_PROP, description: "Concrete task context used by the skill." },
      output_summary: { ...STRING_PROP, description: "Concrete output produced by applying the skill." },
      brief_section: { ...STRING_PROP, description: "Matching Product Brief or PLAN section." },
      product_decisions: {
        type: "ARRAY",
        items: { type: "STRING" },
        description: "Product decisions affected by this execution.",
      },
    },
    required: ["skill_id", "task_id", "input_context", "output_summary", "brief_section", "product_decisions"],
  },
  "pm.write_planning_artifact": {
    type: "OBJECT",
    properties: {
      task_id: { ...STRING_PROP, description: "ADMIN to PM root task id." },
      body_markdown: { ...STRING_PROP, description: "Complete planning Markdown without YAML frontmatter." },
      status: { type: "STRING", enum: ["draft", "ready"], description: "Planning artifact status." },
      thread_key: { ...STRING_PROP, description: "Optional FCoP thread_key." },
    },
    required: ["task_id", "body_markdown"],
  },
  write_report: {
    type: "OBJECT",
    properties: {
      task_id: { ...STRING_PROP, description: "Canonical task id, for example TASK-20260606-001." },
      reporter: { ...STRING_PROP, description: "Reporting role code, for example PM, DEV, QA, or OPS." },
      recipient: { ...STRING_PROP, description: "Recipient role code, for example ADMIN or PM." },
      body: { ...STRING_PROP, description: "Markdown report body. Do not include YAML frontmatter." },
      status: {
        type: "STRING",
        enum: ["done", "in_progress", "blocked"],
        description: "Report status.",
      },
      client_submission_id: {
        ...STRING_PROP,
        description: "Stable idempotency key for retries of one submission attempt.",
      },
      session_id: { ...STRING_PROP, description: "Runtime Session that produced this report." },
      run_id: { ...STRING_PROP, description: "Runtime run that produced this report." },
      evidence_refs: {
        type: "ARRAY",
        items: { type: "STRING" },
        description: "Session, run, and QA evidence asset references.",
      },
    },
    required: ["task_id", "reporter", "recipient", "body"],
  },
  write_task: {
    type: "OBJECT",
    properties: {
      sender: { ...STRING_PROP, description: "Sender role code." },
      recipient: { ...STRING_PROP, description: "Recipient role code." },
      subject: { ...STRING_PROP, description: "Short task title." },
      body: { ...STRING_PROP, description: "Markdown task body. Do not include YAML frontmatter." },
      priority: { ...STRING_PROP, description: "Priority such as P0, P1, P2, or P3." },
      references: {
        type: "ARRAY",
        items: { type: "STRING" },
        description: "Direct parent first, then related TASK ids. The current pinned PM TASK must be first; same-thread siblings never replace a new child task.",
      },
      depends_on: {
        type: "ARRAY",
        items: { type: "STRING" },
        description: "Concrete task ids that must complete before this task auto-runs. Required for QA/OPS tasks that validate a referenced DEV task.",
      },
      thread_key: { ...STRING_PROP, description: "Thread key to preserve task lineage." },
    },
    required: ["sender", "recipient", "subject", "body"],
  },
  create_task: {
    type: "OBJECT",
    properties: {
      sender: { ...STRING_PROP, description: "Sender role code." },
      recipient: { ...STRING_PROP, description: "Recipient role code." },
      subject: { ...STRING_PROP, description: "Short task title." },
      body: { ...STRING_PROP, description: "Markdown task body. Do not include YAML frontmatter." },
      priority: { ...STRING_PROP, description: "Priority such as P0, P1, P2, or P3." },
      references: {
        type: "ARRAY",
        items: { type: "STRING" },
        description: "Parent and related TASK ids.",
      },
      depends_on: {
        type: "ARRAY",
        items: { type: "STRING" },
        description: "Concrete dependency task ids.",
      },
      thread_key: { ...STRING_PROP, description: "Thread key to preserve task lineage." },
    },
    required: ["sender", "recipient", "subject", "body"],
  },
  submit_task: {
    type: "OBJECT",
    properties: {
      task_id: { ...STRING_PROP, description: "Canonical task id to submit for review." },
      actor: { ...STRING_PROP, description: "Acting role code." },
      report_id: {
        ...STRING_PROP,
        description: "The REPORT id just written for this task. Required by CodeFlowMu lifecycle submit_review.",
      },
      report: {
        ...STRING_PROP,
        description: "Alias for report_id.",
      },
    },
    required: ["task_id"],
  },
  approve_task: {
    type: "OBJECT",
    properties: {
      task_id: { ...STRING_PROP, description: "Canonical task id to approve." },
      actor: { ...STRING_PROP, description: "Acting role code." },
    },
    required: ["task_id"],
  },
  reject_task: {
    type: "OBJECT",
    properties: {
      task_id: { ...STRING_PROP, description: "Canonical task id to reject." },
      actor: { ...STRING_PROP, description: "Acting role code." },
      reason: { ...STRING_PROP, description: "Markdown or plain text rejection reason." },
    },
    required: ["task_id"],
  },
  archive_task: {
    type: "OBJECT",
    properties: {
      task_id: { ...STRING_PROP, description: "Canonical task id to archive." },
      actor: { ...STRING_PROP, description: "Acting role code." },
    },
    required: ["task_id"],
  },
  read_task: {
    type: "OBJECT",
    properties: {
      task_id: { ...STRING_PROP, description: "Task id or TASK filename." },
    },
    required: ["task_id"],
  },
  inspect_task: {
    type: "OBJECT",
    properties: {
      task_id: { ...STRING_PROP, description: "Task id or TASK filename." },
    },
    required: ["task_id"],
  },
  read_report: {
    type: "OBJECT",
    properties: {
      report_id: { ...STRING_PROP, description: "Report id or REPORT filename." },
    },
    required: ["report_id"],
  },
  list_tasks: {
    type: "OBJECT",
    properties: {
      recipient: { ...STRING_PROP, description: "Optional recipient role filter." },
      status: { ...STRING_PROP, description: "Optional lifecycle/status filter." },
    },
  },
  list_reports: {
    type: "OBJECT",
    properties: {
      recipient: { ...STRING_PROP, description: "Optional recipient role filter." },
      sender: { ...STRING_PROP, description: "Optional sender role filter." },
      reporter: { ...STRING_PROP, description: "Optional reporter role filter." },
      task_id: { ...STRING_PROP, description: "Scope to reports for this task id." },
      thread_key: { ...STRING_PROP, description: "Optional thread_key filter." },
      since: { ...STRING_PROP, description: "ISO timestamp; only reports on or after this time." },
      status: { ...STRING_PROP, description: "Optional report status filter." },
      limit: {
        type: "INTEGER",
        description: "Max rows (PM default cap 20). Prefer scoped queries over full ledger scan.",
      },
    },
  },
  list_issues: {
    type: "OBJECT",
    properties: {
      recipient: { ...STRING_PROP, description: "Optional recipient role filter." },
      status: { ...STRING_PROP, description: "Optional issue status filter." },
    },
  },
  write_issue: {
    type: "OBJECT",
    properties: {
      sender: { ...STRING_PROP, description: "Sender role code." },
      recipient: { ...STRING_PROP, description: "Recipient role code." },
      subject: { ...STRING_PROP, description: "Short issue title." },
      body: { ...STRING_PROP, description: "Markdown issue body." },
      priority: { ...STRING_PROP, description: "Priority such as P0, P1, P2, or P3." },
      references: { ...STRING_PROP, description: "Related TASK, REPORT, ISSUE, or file reference." },
    },
    required: ["sender", "recipient", "subject", "body"],
  },
  drop_suggestion: {
    type: "OBJECT",
    properties: {
      sender: { ...STRING_PROP, description: "Sender role code." },
      body: { ...STRING_PROP, description: "Suggestion body." },
      references: { ...STRING_PROP, description: "Related protocol or file reference." },
    },
    required: ["body"],
  },
  fcop_report: {
    type: "OBJECT",
    properties: {
      lang: FCOP_LANG_PROP,
      full: {
        type: "BOOLEAN",
        description:
          "false (default): compact status. true: full UNBOUND report — use sparingly.",
      },
    },
  },
  fcop_check: {
    type: "OBJECT",
    properties: {
      lang: FCOP_LANG_PROP,
      full: {
        type: "BOOLEAN",
        description:
          "false (default): summary drift check. true: full governance audit — Hot Path / explicit request only.",
      },
    },
  },
  get_team_status: {
    type: "OBJECT",
    properties: {
      lang: FCOP_LANG_PROP,
    },
  },
  fcop_audit: {
    type: "OBJECT",
    properties: {
      scope: {
        type: "STRING",
        enum: ["new", "upgrade", "takeover", "auto"],
        description: "Inspection scope.",
      },
      output: {
        type: "STRING",
        enum: ["stdout", "file"],
        description: "Where to write INSPECTION report.",
      },
    },
  },
  claim_task: {
    type: "OBJECT",
    properties: {
      task_id: { ...STRING_PROP, description: "Task id to claim (inbox → active)." },
      actor: { ...STRING_PROP, description: "Acting role code." },
    },
    required: ["task_id"],
  },
  finish_task: {
    type: "OBJECT",
    properties: {
      task_id: { ...STRING_PROP, description: "Task id to finish (review → done)." },
      actor: { ...STRING_PROP, description: "Acting role code." },
    },
    required: ["task_id"],
  },
  write_review: {
    type: "OBJECT",
    properties: {
      subject_id: { ...STRING_PROP, description: "TASK/REPORT/ISSUE id under review." },
      reviewer: { ...STRING_PROP, description: "Reviewer role code." },
      decision: {
        type: "STRING",
        enum: ["approved", "changes_requested", "blocked", "rejected", "needs_human"],
        description: "Review decision.",
      },
      body: { ...STRING_PROP, description: "Markdown review body." },
    },
    required: ["subject_id", "reviewer", "decision"],
  },
  list_reviews: {
    type: "OBJECT",
    properties: {
      decision: { ...STRING_PROP, description: "Optional decision filter." },
      reviewer: { ...STRING_PROP, description: "Optional reviewer filter." },
    },
  },
  read_review: {
    type: "OBJECT",
    properties: {
      review_id: { ...STRING_PROP, description: "Review id or REVIEW filename." },
    },
    required: ["review_id"],
  },
  mark_human_approved: {
    type: "OBJECT",
    properties: {
      review_id: { ...STRING_PROP, description: "Review id with decision=needs_human." },
      approved_by: { ...STRING_PROP, description: "Human approver identifier." },
      note: { ...STRING_PROP, description: "Optional approval note." },
    },
    required: ["review_id", "approved_by"],
  },
  archive_to_history: {
    type: "OBJECT",
    properties: {
      task_id: { ...STRING_PROP, description: "Archived task id to move to history/YYYY-MM-DD/." },
      actor: { ...STRING_PROP, description: "Acting role code." },
    },
    required: ["task_id"],
  },
  bulk_archive_to_history: {
    type: "OBJECT",
    properties: {
      task_ids: {
        type: "ARRAY",
        items: STRING_PROP,
        description: "Task ids to deep-archive.",
      },
      actor: { ...STRING_PROP, description: "Acting role code." },
    },
    required: ["task_ids"],
  },
  list_history: {
    type: "OBJECT",
    properties: {
      date: { ...STRING_PROP, description: "Optional YYYY-MM-DD history bucket." },
    },
  },
  read_history_task: {
    type: "OBJECT",
    properties: {
      task_id: { ...STRING_PROP, description: "Task id under history/." },
    },
    required: ["task_id"],
  },
  fcop_list_alerts: {
    type: "OBJECT",
    properties: {
      status: { ...STRING_PROP, description: "Optional alert status filter." },
      severity: { ...STRING_PROP, description: "Optional severity filter." },
    },
  },
  fcop_create_alert: {
    type: "OBJECT",
    properties: {
      signal: { ...STRING_PROP, description: "Alert signal name." },
      severity: { ...STRING_PROP, description: "Alert severity." },
      summary: { ...STRING_PROP, description: "Short summary." },
      evidence: { ...STRING_PROP, description: "Evidence file path or id." },
    },
    required: ["signal", "severity", "summary"],
  },
  new_workspace: {
    type: "OBJECT",
    properties: {
      slug: { ...STRING_PROP, description: "Logical artifact slug. Root mode returns the project root; multi mode creates workspace/<slug>." },
      title: { ...STRING_PROP, description: "Human title." },
      description: { ...STRING_PROP, description: "Optional description." },
    },
    required: ["slug", "title"],
  },
  list_workspaces: {
    type: "OBJECT",
    properties: {
      lang: { ...STRING_PROP, description: "Optional response language." },
    },
  },
  list_governance_events: {
    type: "OBJECT",
    properties: {
      limit: { type: "INTEGER", description: "Max events to return." },
    },
  },
  get_governance_summary: {
    type: "OBJECT",
    properties: {},
  },
  get_available_teams: {
    type: "OBJECT",
    properties: {},
  },
  init_project: {
    type: "OBJECT",
    properties: {
      team: { ...STRING_PROP, description: "Preset team id, e.g. dev-team." },
      project_dir: { ...STRING_PROP, description: "Optional project directory override." },
    },
    required: ["team"],
  },
  init_solo: {
    type: "OBJECT",
    properties: {
      role_code: { ...STRING_PROP, description: "Solo role code, e.g. ME." },
      project_dir: { ...STRING_PROP, description: "Optional project directory override." },
    },
    required: ["role_code"],
  },
  create_custom_team: {
    type: "OBJECT",
    properties: {
      team_name: { ...STRING_PROP, description: "Display name for the custom team." },
      roles: {
        type: "ARRAY",
        items: STRING_PROP,
        description: "Role codes, e.g. [PM, DEV, QA].",
      },
      leader: { ...STRING_PROP, description: "Leader role code." },
    },
    required: ["team_name", "roles", "leader"],
  },
  validate_team_config: {
    type: "OBJECT",
    properties: {
      team: { ...STRING_PROP, description: "Team id or custom config reference." },
    },
  },
  deploy_role_templates: {
    type: "OBJECT",
    properties: {
      team: { ...STRING_PROP, description: "Team template id to deploy." },
      force: { type: "BOOLEAN", description: "Archive conflicting files before deploy." },
    },
    required: ["team"],
  },
  set_project_dir: {
    type: "OBJECT",
    properties: {
      project_dir: { ...STRING_PROP, description: "Absolute or relative FCoP project root." },
    },
    required: ["project_dir"],
  },
  redeploy_rules: {
    type: "OBJECT",
    properties: {
      force: { type: "BOOLEAN", description: "Overwrite bundled rules in project." },
    },
  },
  upgrade_fcop: {
    type: "OBJECT",
    properties: {},
  },
  check_update: {
    type: "OBJECT",
    properties: {},
  },
};

function staticToolSchemaFor(name: string): GoogleToolParameters {
  return FCOP_STATIC_TOOL_SCHEMAS[name] ?? { type: "OBJECT", properties: {} };
}

/** Tool names with explicit one-shot Gemini schemas (not empty fallback). */
export const FCOP_STATIC_TOOL_SCHEMA_NAMES = Object.freeze(
  Object.keys(FCOP_STATIC_TOOL_SCHEMAS),
) as readonly string[];

/** Returns FCoP tool names missing from FCOP_STATIC_TOOL_SCHEMAS (one-shot gap). */
export function fcopStaticSchemaCoverage(toolNames: readonly string[]): string[] {
  const known = new Set(FCOP_STATIC_TOOL_SCHEMA_NAMES);
  return toolNames.filter((name) => !known.has(name));
}

export function buildStaticGoogleTools(toolNames: readonly string[]): Array<{
  name: string;
  description: string;
  parameters: GoogleToolParameters;
}> {
  return toolNames.map((name) => ({
    name,
    description: `FCoP MCP tool: ${name}`,
    parameters: staticToolSchemaFor(name),
  }));
}

export function defaultLeaderGoogleTools(): ReturnType<
  typeof buildStaticGoogleTools
> {
  return buildStaticGoogleTools(LEADER_TOOLS);
}

/** Walk up from projectRoot to find repo containing fcop_sdk/ (for PYTHONPATH). */
export function resolveRepoRootWithFcopSdk(projectRoot: string): string | undefined {
  let dir = path.resolve(projectRoot);
  for (let i = 0; i < 16; i += 1) {
    if (existsSync(path.join(dir, "fcop_sdk", "ledger_bridge.py"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function prependPythonPath(
  env: NodeJS.ProcessEnv,
  segment: string,
): void {
  const sep = path.delimiter;
  const cur = env.PYTHONPATH?.trim();
  if (cur?.split(sep).includes(segment)) return;
  env.PYTHONPATH = cur ? `${segment}${sep}${cur}` : segment;
}

export function invokeFcopToolOnce(
  pythonBin: string,
  projectRoot: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<string> {
  const scriptPath = existsSync(ONCE_SCRIPT)
    ? ONCE_SCRIPT
    : path.join(projectRoot, "packages", "codeflowmu-runtime", "scripts", "fcop_invoke_once.py");

  const payload = JSON.stringify({ tool, arguments: args });
  const py = resolvePythonBin(pythonBin);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUNBUFFERED: "1",
    FCOP_PROJECT_DIR: projectRoot,
  };
  const repoRoot = resolveRepoRootWithFcopSdk(projectRoot);
  if (repoRoot) {
    prependPythonPath(env, repoRoot);
  }

  return new Promise((resolve, reject) => {
    execFile(
      py,
      ["-u", scriptPath, projectRoot, payload],
      {
        cwd: projectRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: timeoutMs,
        env,
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || "").trim() || err.message;
          reject(new Error(`fcop one-shot [${tool}]: ${detail}`));
          return;
        }
        const text = (stdout || "").trim();
        if (!text) {
          reject(new Error(`fcop one-shot [${tool}]: empty stdout`));
          return;
        }
        resolve(text);
      },
    );
  });
}

export function oneShotTimeoutForTool(toolName: string): number {
  // 实测 one-shot fcop_report/fcop_check ~2s；留足 git 大仓库余量，仍远小于 stdio MCP 90s 挂死。
  if (toolName === "fcop_report" || toolName === "fcop_audit") return 60_000;
  if (toolName === "fcop_check") return 90_000;
  return 45_000;
}
