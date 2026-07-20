/**
 * Classify fcop MCP tool stdout — process exit 0 does not mean business success.
 */
export type ToolOutcomeKind = "success" | "failed";

export interface ClassifiedToolOutcome {
  outcome: ToolOutcomeKind;
  /** Short label for toolLog / UI (中文). */
  label: string;
}

const FAIL_PATTERNS: RegExp[] = [
  /^File not found:/im,
  /no task matches/i,
  /FAIL — \d+ error/i,
  /Cannot claim:/i,
  /Cannot submit:/i,
  /\{"error"\s*:/,
  /^错误[：:]/m,
  /validation error/i,
  /unknown tool:/i,
];

function isFinishAlreadyDone(toolName: string, text: string): boolean {
  if (toolName !== "finish" && toolName !== "finish_task") return false;
  return /Cannot finish: task is in stage '(done|archive)'/i.test(text);
}

function isInspectTaskFail(text: string): boolean {
  return /\bFAIL\b/.test(text) && /error\(s\)/i.test(text);
}

function hasStructuredFailure(text: string): boolean {
  const candidates = [text, ...text.split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { ok?: unknown; error?: unknown };
      if (parsed.ok === false || parsed.error !== undefined) return true;
    } catch {
      // Non-JSON output continues through the legacy text classifiers.
    }
  }
  return false;
}

/**
 * Map tool stdout/stderr text to success vs failed for session settlement and UI.
 */
export function classifyFcopToolOutcome(
  toolName: string,
  output: string,
): ClassifiedToolOutcome {
  const text = (output ?? "").trim();
  if (hasStructuredFailure(text)) {
    return { outcome: "failed", label: "失败" };
  }
  if (!text) {
    return { outcome: "success", label: "成功" };
  }

  if (isFinishAlreadyDone(toolName, text)) {
    return {
      outcome: "success",
      label: "成功（任务已在 done/archive，无需再次 finish）",
    };
  }

  if (toolName === "inspect_task" && isInspectTaskFail(text)) {
    return { outcome: "failed", label: "失败" };
  }

  if (/Cannot finish:/i.test(text) && !isFinishAlreadyDone(toolName, text)) {
    return { outcome: "failed", label: "失败" };
  }

  for (const re of FAIL_PATTERNS) {
    if (re.test(text)) {
      return { outcome: "failed", label: "失败" };
    }
  }

  return { outcome: "success", label: "成功" };
}
