import { listField, strField } from "../ledger/frontmatter.ts";

/** 104 hard rule: REPORT-YYYYMMDD-NNN → TASK-YYYYMMDD-NNN from filename seq. */
export function inferReportFilenameTaskId(filename: string): string {
  const base = filename.replace(/^.*[/\\]/, "").replace(/\.md$/i, "");
  const m = base.match(/^REPORT-(\d{8})-(\d{3})-/i);
  if (!m) return "";
  return `TASK-${m[1]}-${m[2]}`;
}

export type ReportAttributionResult = {
  pass: boolean;
  errors: string[];
  filenameTaskId: string;
  fmTaskId: string;
  refTaskId: string;
};

/** filename 推断 task_id == frontmatter.task_id == references[0]. */
export function evaluateReportAttribution(
  filename: string,
  fm: Record<string, unknown>,
): ReportAttributionResult {
  const filenameTaskId = inferReportFilenameTaskId(filename);
  const fmTaskId = strField(fm, "task_id").replace(/\.md$/i, "").trim();
  const refs = listField(fm, "references");
  const refTaskId = refs[0]?.replace(/\.md$/i, "").trim() ?? "";

  const errors: string[] = [];
  if (!filenameTaskId) errors.push("filename_task_id_unresolved");
  if (!fmTaskId) errors.push("frontmatter_task_id_missing");
  if (!refTaskId) errors.push("references_missing");
  if (filenameTaskId && fmTaskId && filenameTaskId !== fmTaskId) {
    errors.push(`filename ${filenameTaskId} vs fm ${fmTaskId}`);
  }
  if (filenameTaskId && refTaskId && filenameTaskId !== refTaskId) {
    errors.push(`filename ${filenameTaskId} vs references ${refTaskId}`);
  }
  if (fmTaskId && refTaskId && fmTaskId !== refTaskId) {
    errors.push(`fm ${fmTaskId} vs references ${refTaskId}`);
  }

  return {
    pass:
      errors.length === 0 &&
      Boolean(filenameTaskId && fmTaskId && refTaskId),
    errors,
    filenameTaskId,
    fmTaskId,
    refTaskId,
  };
}

export function isValidDevReceiptForTask(
  filename: string,
  fm: Record<string, unknown>,
  expectedTaskId: string,
): boolean {
  const result = evaluateReportAttribution(filename, fm);
  const expected = expectedTaskId.replace(/\.md$/i, "").trim();
  return (
    result.pass &&
    result.filenameTaskId === expected &&
    result.fmTaskId === expected &&
    result.refTaskId === expected
  );
}
