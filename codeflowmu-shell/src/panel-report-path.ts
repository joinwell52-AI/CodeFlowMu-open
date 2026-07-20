/** Resolve REPORT disk paths before resolveReportAfterWrite (caller must pass full path). */

import { join, resolve as pathResolve, isAbsolute } from "node:path";

const REPORT_BASENAME_RE = /^REPORT-.*\.md$/i;

function isAbsoluteReportPath(raw: string): boolean {
  return isAbsolute(raw) || /^[a-zA-Z]:[/\\]/.test(raw) || raw.startsWith("/");
}

/** Bare REPORT-*.md filename (no directory segments). */
function isBareReportFilename(raw: string): boolean {
  const normalized = raw.replace(/\\/g, "/").replace(/^[/\\]+/, "");
  return !normalized.includes("/") && REPORT_BASENAME_RE.test(normalized);
}

/**
 * Map session/report payload paths to absolute REPORT file paths.
 * - Absolute path → unchanged (resolved)
 * - fcop/reports/REPORT-*.md → projectRoot + relative
 * - Bare REPORT-*.md filename → projectRoot/fcop/reports/filename
 * - Other relative paths → projectRoot + relative
 */
export function resolveReportPathForAfterWrite(
  projectRoot: string,
  reportPathOrName: string,
): string {
  const raw = String(reportPathOrName ?? "").trim();
  if (!raw) return raw;

  if (isAbsoluteReportPath(raw)) {
    return pathResolve(raw);
  }

  const normalized = raw.replace(/\\/g, "/").replace(/^[/\\]+/, "");

  if (isBareReportFilename(normalized)) {
    return join(projectRoot, "fcop", "reports", normalized);
  }

  return join(projectRoot, normalized);
}
