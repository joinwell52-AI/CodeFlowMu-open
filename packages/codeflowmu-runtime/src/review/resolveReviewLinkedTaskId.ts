/**
 * Unified REVIEW → TASK linkage (P0 REVIEW-GATE §3.1).
 * REVIEW-GATE files carry subject_id=REPORT-* and task_id=TASK-*; task_id wins.
 */

export type ResolveReviewLinkedTaskIdOptions = {
  filename?: string;
  /** Step 5: resolve REPORT frontmatter by normalized report id. */
  resolveReport?: (
    reportId: string,
  ) => Record<string, unknown> | null | undefined;
};

function normalizeRef(value: unknown): string {
  return String(value ?? "")
    .replace(/\.md$/i, "")
    .trim();
}

function asTaskId(value: unknown): string | null {
  const id = normalizeRef(value);
  if (!id || !/^TASK-/i.test(id)) return null;
  return id;
}

function taskIdFromReportFm(fm: Record<string, unknown>): string | null {
  const direct = asTaskId(fm.task_id);
  if (direct) return direct;

  const refs = fm.references;
  if (Array.isArray(refs)) {
    for (const ref of refs) {
      const fromRef = asTaskId(ref);
      if (fromRef) return fromRef;
    }
  }

  return asTaskId(fm.subject_id);
}

function taskIdFromFilename(filename: string): string | null {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? filename;
  const match = base.match(/-on-(TASK-.+)\.md$/i);
  return match?.[1] ? asTaskId(match[1]) : null;
}

/**
 * Resolve which TASK a REVIEW file belongs to.
 * Priority: task_id → subject_task → subject_ref → subject_id (TASK-*) →
 * report_id → REPORT.task_id/references → filename -on-TASK-*.md
 */
export function resolveReviewLinkedTaskId(
  review: Record<string, unknown>,
  options?: ResolveReviewLinkedTaskIdOptions,
): string | null {
  const fromTaskId = asTaskId(review.task_id);
  if (fromTaskId) return fromTaskId;

  const fromSubjectTask = asTaskId(review.subject_task);
  if (fromSubjectTask) return fromSubjectTask;

  const fromSubjectRef = asTaskId(review.subject_ref);
  if (fromSubjectRef) return fromSubjectRef;

  const fromSubjectId = asTaskId(review.subject_id);
  if (fromSubjectId) return fromSubjectId;

  const reportId = normalizeRef(review.report_id);
  if (reportId && /^REPORT-/i.test(reportId) && options?.resolveReport) {
    const reportFm = options.resolveReport(reportId);
    if (reportFm) {
      const fromReport = taskIdFromReportFm(reportFm);
      if (fromReport) return fromReport;
    }
  }

  if (options?.filename) {
    const fromFilename = taskIdFromFilename(options.filename);
    if (fromFilename) return fromFilename;
  }

  return null;
}
