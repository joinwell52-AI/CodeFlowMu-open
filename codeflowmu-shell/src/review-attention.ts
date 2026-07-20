import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isTaskSettledClosed } from "@codeflowmu/runtime";

export type ReviewAttentionFinding = {
  code: string;
  severity: string;
  message: string;
};

export type ReviewAttention = {
  reason: string;
  findings: ReviewAttentionFinding[];
  source: "cycle.jsonl" | "task_frontmatter";
  report_id?: string;
};

type CycleReviewPayload = {
  ok?: boolean;
  task_id?: string;
  report_id?: string;
  findings?: Array<{ code?: string; severity?: string; message?: string }>;
};

type CycleJudgment = {
  skill_id?: string;
  task_id?: string;
  outcome?: string;
  payload?: { review?: CycleReviewPayload };
};

type CycleDecision = {
  task_id?: string;
  detected_state?: string;
  reason?: string;
  outcome?: string;
};

type CycleRow = {
  triggered_by?: string;
  decisions?: CycleDecision[];
  judgments?: CycleJudgment[];
};

type LedgerReportLink = {
  task_id?: string;
  source_task_id?: string;
  status?: string;
};

const DEFAULT_REASON = "PM 自动审查未通过，需 PM 人工处理";

function normalizeTaskId(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .replace(/\.md$/i, "");
}

function normalizeFinding(
  row: { code?: string; severity?: string; message?: string },
): ReviewAttentionFinding | null {
  const message = String(row.message ?? "").trim();
  if (!message) return null;
  return {
    code: String(row.code ?? "fact_check_needs_human").trim() || "fact_check_needs_human",
    severity: String(row.severity ?? "error").trim() || "error",
    message,
  };
}

function pmGovernanceCyclePath(projectRoot: string): string {
  return join(projectRoot, ".codeflowmu", "pm-governance", "cycle.jsonl");
}

function resolvedReportTaskIds(projectRoot: string): Set<string> {
  const path = join(projectRoot, "fcop", "ledger", "reports.jsonl");
  if (!existsSync(path)) return new Set();
  let raw = "";
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return new Set();
  }
  const out = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const report = JSON.parse(line) as LedgerReportLink;
      const status = String(report.status ?? "").trim().toLowerCase();
      if (!new Set(["done", "completed", "blocked"]).has(status)) continue;
      for (const id of [report.source_task_id, report.task_id]) {
        const normalized = normalizeTaskId(id);
        if (normalized) out.add(normalized);
      }
    } catch {
      /* skip malformed ledger row */
    }
  }
  return out;
}

const STALE_LINK_FINDINGS = new Set(["report_missing", "task_id_mismatch"]);

function isResolvedLinkageAttention(
  taskId: string,
  entry: ReviewAttention,
  resolvedTaskIds: Set<string>,
): boolean {
  return (
    resolvedTaskIds.has(taskId) &&
    entry.findings.length > 0 &&
    entry.findings.every((finding) => STALE_LINK_FINDINGS.has(finding.code))
  );
}

/** Build latest review_check failure index keyed by task_id from cycle.jsonl. */
export function buildReviewAttentionIndex(projectRoot: string): Map<string, ReviewAttention> {
  const path = pmGovernanceCyclePath(projectRoot);
  if (!existsSync(path)) return new Map();

  const reportArrival = new Map<string, ReviewAttention>();
  const fallback = new Map<string, ReviewAttention>();

  let raw = "";
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return new Map();
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let cycle: CycleRow;
    try {
      cycle = JSON.parse(trimmed) as CycleRow;
    } catch {
      continue;
    }

    const decisionReasonByTask = new Map<string, string>();
    for (const d of cycle.decisions ?? []) {
      const tid = normalizeTaskId(d.task_id);
      if (!tid) continue;
      const reason = String(d.reason ?? "").trim();
      if (reason) decisionReasonByTask.set(tid, reason);
    }

    for (const j of cycle.judgments ?? []) {
      if (j.skill_id !== "pm.review_check") continue;
      if (String(j.outcome ?? "").toLowerCase() === "ok") continue;
      const tid = normalizeTaskId(j.task_id);
      if (!tid) continue;

      const review = j.payload?.review;
      const findings = (review?.findings ?? [])
        .map(normalizeFinding)
        .filter((f): f is ReviewAttentionFinding => f !== null);

      const decisionReason = decisionReasonByTask.get(tid) ?? "";
      const firstFindingMsg = findings[0]?.message ?? "";
      const reason =
        decisionReason ||
        firstFindingMsg ||
        DEFAULT_REASON;

      const entry: ReviewAttention = {
        reason,
        findings,
        source: "cycle.jsonl",
        ...(review?.report_id ? { report_id: String(review.report_id).trim() } : {}),
      };

      const target =
        cycle.triggered_by === "report_arrival" ? reportArrival : fallback;
      target.set(tid, entry);
    }
  }

  const merged = new Map<string, ReviewAttention>(fallback);
  for (const [tid, entry] of reportArrival) {
    merged.set(tid, entry);
  }
  const resolvedTaskIds = resolvedReportTaskIds(projectRoot);
  for (const [tid, entry] of merged) {
    if (isResolvedLinkageAttention(tid, entry, resolvedTaskIds)) {
      merged.delete(tid);
    }
  }
  return merged;
}

function taskSettledClosed(task: Record<string, unknown>): boolean {
  return isTaskSettledClosed({
    review_status: String(task.review_status ?? "") || undefined,
    scope: String(task.scope ?? task.bucket ?? task.physical_scope ?? "") || undefined,
    display_status: String(task.display_status ?? "") || undefined,
    bucket: String(task.bucket ?? "") || undefined,
    state: String(task.state ?? task._state ?? "") || undefined,
  });
}

function taskNeedsReviewAttention(task: Record<string, unknown>): boolean {
  if (taskSettledClosed(task)) return false;
  const ds = String(task.display_status ?? "").toLowerCase();
  if (ds === "human_review_approved") return false;
  if (ds === "waiting_pm_attention") return true;
  if (String(task.pm_attention_reason ?? "").trim()) return true;
  const scope = String(task.scope ?? task.bucket ?? task.physical_scope ?? "").toLowerCase();
  return scope === "review";
}

/** Resolve review_attention for one task row (read-only; no review-check recompute). */
export function resolveReviewAttentionForTask(
  task: Record<string, unknown>,
  index: Map<string, ReviewAttention>,
): ReviewAttention | undefined {
  const tid = normalizeTaskId(task.task_id ?? task.filename);
  const fromCycle = tid ? index.get(tid) : undefined;
  // cycle.jsonl is an immutable history, not current task state. Project a
  // historical failure only while the current task still carries an active
  // review/attention signal; otherwise a repaired/retried task would keep
  // showing REVIEW forever after its frontmatter marker was cleared.
  if (fromCycle) {
    if (!taskNeedsReviewAttention(task)) return undefined;
    return fromCycle;
  }

  if (!taskNeedsReviewAttention(task)) return undefined;

  const pmReason = String(task.pm_attention_reason ?? task.display_reason ?? "").trim();
  if (pmReason || String(task.display_status ?? "").toLowerCase() === "waiting_pm_attention") {
    return {
      reason: pmReason || DEFAULT_REASON,
      findings: [],
      source: "task_frontmatter",
    };
  }

  return undefined;
}

/** Attach review_attention to task list rows when applicable. */
export function enrichTasksWithReviewAttention(
  projectRoot: string,
  tasks: Record<string, unknown>[],
): Record<string, unknown>[] {
  if (!tasks.length) return tasks;
  const index = buildReviewAttentionIndex(projectRoot);
  const resolvedTaskIds = resolvedReportTaskIds(projectRoot);
  return tasks.map((task) => {
    const tid = normalizeTaskId(task.task_id ?? task.filename);
    const staleGenericReason =
      resolvedTaskIds.has(tid) &&
      String(task.display_status ?? "").toLowerCase() === "waiting_pm_review" &&
      String(task.pm_attention_reason ?? "").trim() === DEFAULT_REASON &&
      !index.has(tid);
    const projectedTask = staleGenericReason
      ? { ...task, pm_attention_reason: undefined }
      : task;
    const review_attention = resolveReviewAttentionForTask(projectedTask, index);
    return review_attention ? { ...projectedTask, review_attention } : projectedTask;
  });
}
