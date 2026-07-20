import {
  isAdminRejectHotPathPrompt,
  isPmSelfExecuteHotPathPrompt,
} from "./promptHotPath.ts";

/** PM heavy tools: default param trim + fcop_check low-frequency gate (docs/FCoP-Agent-工具分配策略.md §4–§6). */
export const PM_HEAVY_TOOLS = new Set([
  "list_reports",
  "fcop_report",
  "fcop_check",
]);

const LIST_REPORTS_SCOPE_KEYS = [
  "task_id",
  "recipient",
  "reporter",
  "sender",
  "since",
  "thread_key",
  "status",
] as const;

const PM_LIST_REPORTS_MAX_LIMIT = 20;

/** Prompt explicitly requires fcop_check (system check, Hot Path, etc.). */
const EXPLICIT_FCOP_CHECK_RE =
  /fcop_check\s*\(|`fcop_check`|必做.*fcop_check|fcop_check\s*→|fcop_check\s*与|与\s*fcop_check|fcop_report\s*\(\)\s*与\s*fcop_check/i;

export type PmHeavyToolContext = {
  taskId?: string;
  promptRoutingText?: string;
  agentId?: string;
};

export type PmHeavyToolWrapperResult = {
  allowed: boolean;
  args: Record<string, unknown>;
  /** Synthetic JSON payload when allowed=false (soft-skip, not authority denial). */
  skipMessage?: string;
};

export function isPmHeavyTool(toolName: string): boolean {
  return PM_HEAVY_TOOLS.has(toolName);
}

function hasListReportsScope(args: Record<string, unknown>): boolean {
  return LIST_REPORTS_SCOPE_KEYS.some((key) => {
    const value = args[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function coerceLimit(args: Record<string, unknown>): number {
  const raw = args.limit;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return PM_LIST_REPORTS_MAX_LIMIT;
}

function wantsFullHeavy(args: Record<string, unknown>): boolean {
  return args.full === true || args.full === "true";
}

function buildFcopCheckSkipMessage(): string {
  return JSON.stringify({
    ok: true,
    skipped: true,
    tool: "fcop_check",
    reason: "PM_HEAVY_LOW_FREQ",
    message_zh:
      "PM 常规 wake/巡检默认跳过 fcop_check（低频 heavy 工具）。请改用 get_team_status 或 fcop_report(full=false)。仅在 ADMIN Hot Path 返工、prompt 明确要求 fcop_check、或 full=true 时调用。",
    message_en:
      "Routine PM wake/patrol skips fcop_check by default. Use get_team_status or fcop_report(full=false). Call fcop_check only on ADMIN Hot Path rework, when the prompt explicitly requires it, or with full=true.",
    suggested_alternative: "get_team_status",
  });
}

export function shouldAllowPmFcopCheck(
  ctx: PmHeavyToolContext,
  args: Record<string, unknown>,
): boolean {
  if (wantsFullHeavy(args)) return true;
  const prompt = ctx.promptRoutingText ?? "";
  const agentId = ctx.agentId ?? "";
  if (!prompt.trim() && !agentId.trim()) return false;
  if (isPmSelfExecuteHotPathPrompt(prompt, agentId)) return true;
  if (isAdminRejectHotPathPrompt(prompt, agentId)) return true;
  if (EXPLICIT_FCOP_CHECK_RE.test(prompt)) return true;
  return false;
}

export function applyPmHeavyToolWrapper(
  role: string,
  toolName: string,
  args: Record<string, unknown>,
  ctx: PmHeavyToolContext,
): PmHeavyToolWrapperResult {
  if (role !== "PM" || !isPmHeavyTool(toolName)) {
    return { allowed: true, args };
  }

  const next = { ...args };

  if (toolName === "list_reports") {
    const capped = Math.min(Math.max(1, coerceLimit(next)), PM_LIST_REPORTS_MAX_LIMIT);
    next.limit = capped;
    if (!hasListReportsScope(next) && ctx.taskId?.trim()) {
      next.task_id = ctx.taskId.trim();
    }
    return { allowed: true, args: next };
  }

  if (toolName === "fcop_report") {
    if (!wantsFullHeavy(next)) {
      next.full = false;
    }
    return { allowed: true, args: next };
  }

  if (toolName === "fcop_check") {
    if (!wantsFullHeavy(next)) {
      next.full = false;
    }
    if (shouldAllowPmFcopCheck(ctx, next)) {
      return { allowed: true, args: next };
    }
    return {
      allowed: false,
      args: next,
      skipMessage: buildFcopCheckSkipMessage(),
    };
  }

  return { allowed: true, args: next };
}
