/** Provider-neutral write_report task_id guard — pins session TASK prefix, autofills or rejects hallucinated ids. */

import { extractTaskIdPrefixesFromText } from "../pm/pmAdminRejectPrompt.ts";

export const WRITE_REPORT_TASK_ID_AUTOFILL_TAG =
  "task_id_autofilled_from_session" as const;

export type SessionPinnedTaskIdSource =
  | "spec_pinnedTaskId"
  | "spec_taskFilepath"
  | "spec_frontmatterTaskId"
  | "prompt_text"
  | "none";

export type SessionPinnedTaskIdResolution = {
  pinnedTaskId: string | null;
  source: SessionPinnedTaskIdSource;
};

const TASK_ID_PREFIX_RE = /TASK-\d{8}-\d{3,}/i;

/** Extract TASK-YYYYMMDD-NNN from a TASK filename or path segment. */
export function extractTaskIdPrefixFromFilepath(
  filepath: string | null | undefined,
): string {
  if (!filepath || typeof filepath !== "string") return "";
  const base = filepath.replace(/\\/g, "/").split("/").pop() ?? "";
  const match = base.match(TASK_ID_PREFIX_RE);
  return match ? match[0]!.toUpperCase() : "";
}

/**
 * Resolve session pinned task id — explicit run spec first, prompt text last.
 * TaskDispatcher → SessionManager → AgentSendSpec is the primary path.
 */
export function resolveSessionPinnedTaskId(input: {
  pinnedTaskId?: string | null;
  taskFilepath?: string | null;
  frontmatterTaskId?: string | null;
  promptText?: string | null;
}): SessionPinnedTaskIdResolution {
  const fromSpec = normalizeWriteReportTaskIdPrefix(input.pinnedTaskId);
  if (fromSpec) {
    return { pinnedTaskId: fromSpec, source: "spec_pinnedTaskId" };
  }

  const fromPath = extractTaskIdPrefixFromFilepath(input.taskFilepath);
  if (fromPath) {
    return { pinnedTaskId: fromPath, source: "spec_taskFilepath" };
  }

  const fromFm = normalizeWriteReportTaskIdPrefix(input.frontmatterTaskId);
  if (fromFm) {
    return { pinnedTaskId: fromFm, source: "spec_frontmatterTaskId" };
  }

  const fromPrompt =
    extractTaskIdPrefixesFromText(String(input.promptText ?? ""))[0] ?? null;
  if (fromPrompt) {
    return {
      pinnedTaskId: normalizeWriteReportTaskIdPrefix(fromPrompt),
      source: "prompt_text",
    };
  }

  return { pinnedTaskId: null, source: "none" };
}

/**
 * Resolve pinned task id from explicit AgentSendSpec fields only — no prompt fallback.
 * Self-report mode must not infer task_id from prompt text.
 */
export function resolveExplicitSessionPinnedTaskId(input: {
  pinnedTaskId?: string | null;
  taskFilepath?: string | null;
  frontmatterTaskId?: string | null;
}): SessionPinnedTaskIdResolution {
  return resolveSessionPinnedTaskId({
    pinnedTaskId: input.pinnedTaskId,
    taskFilepath: input.taskFilepath,
    frontmatterTaskId: input.frontmatterTaskId,
    promptText: null,
  });
}

export type WriteReportTaskIdGuardResult =
  | { action: "pass"; args: Record<string, unknown> }
  | {
      action: "repair";
      args: Record<string, unknown>;
      repairTag: typeof WRITE_REPORT_TASK_ID_AUTOFILL_TAG;
      pinnedTaskId: string;
    }
  | {
      action: "reject";
      code: "TASK_ID_MISMATCH";
      message: string;
      providedTaskId: string;
      pinnedTaskId: string;
    };

/** Normalize write_report task_id to canonical TASK-YYYYMMDD-NNN prefix. */
export function normalizeWriteReportTaskIdPrefix(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const match = s.match(TASK_ID_PREFIX_RE);
  return match ? match[0]!.toUpperCase() : "";
}

/**
 * Guard write_report args against session pinned task id.
 * - Missing task_id + pinned → autofill pinned prefix.
 * - Mismatched task_id → reject without MCP.
 */
export function guardWriteReportTaskId(
  args: Record<string, unknown>,
  pinnedTaskId: string | null | undefined,
): WriteReportTaskIdGuardResult {
  const nextArgs = { ...args };
  const pinned = normalizeWriteReportTaskIdPrefix(pinnedTaskId);
  if (!pinned) {
    return { action: "pass", args: nextArgs };
  }

  const rawProvided = String(
    nextArgs.task_id ?? nextArgs.taskId ?? nextArgs.filename ?? nextArgs.id ?? "",
  ).trim();
  const provided = normalizeWriteReportTaskIdPrefix(rawProvided || undefined);

  if (!provided) {
    if (rawProvided) {
      return {
        action: "reject",
        code: "TASK_ID_MISMATCH",
        message: `write_report task_id "${rawProvided}" 不是合法的 TASK-YYYYMMDD-NNN 前缀；session pinned 为 "${pinned}"，拒绝执行 MCP`,
        providedTaskId: rawProvided,
        pinnedTaskId: pinned,
      };
    }
    return {
      action: "repair",
      args: { ...nextArgs, task_id: pinned },
      repairTag: WRITE_REPORT_TASK_ID_AUTOFILL_TAG,
      pinnedTaskId: pinned,
    };
  }

  if (provided !== pinned) {
    return {
      action: "reject",
      code: "TASK_ID_MISMATCH",
      message: `write_report task_id "${provided}" 与 session pinned "${pinned}" 不一致，拒绝执行 MCP`,
      providedTaskId: provided,
      pinnedTaskId: pinned,
    };
  }

  return { action: "pass", args: nextArgs };
}

export function formatWriteReportTaskIdMismatchPayload(
  result: Extract<WriteReportTaskIdGuardResult, { action: "reject" }>,
): Record<string, unknown> {
  return {
    ok: false,
    code: result.code,
    error: result.message,
    task_id: result.providedTaskId,
    pinned_task_id: result.pinnedTaskId,
  };
}
