/**
 * Ephemeral coordination filenames (*.tmp / *.part / *.lock / dotfiles)
 * must never trigger ReportWatcher, ReportResolver, PM consolidation, or Panel lists.
 */

const EPHEMERAL_SUFFIX_RE = /\.(tmp|part|lock)$/i;

/** True for hidden/dot names and common write-in-progress suffixes. */
export function isEphemeralCoordinationFilename(name: string): boolean {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? name;
  if (!base || base === "." || base === "..") return true;
  if (base.startsWith(".")) return true;
  return EPHEMERAL_SUFFIX_RE.test(base);
}

/**
 * Canonical REPORT markdown on disk (not tmp/part/lock, ends with `.md` only).
 * Rejects `REPORT-xxx.md.pid.ts.rand.tmp` and `REPORT-xxx.md.tmp`.
 */
export function isCanonicalReportMarkdownFilename(name: string): boolean {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? name;
  if (isEphemeralCoordinationFilename(base)) return false;
  if (!/^REPORT-/i.test(base)) return false;
  if (!base.endsWith(".md")) return false;
  // Exclude REPORT-foo.md.extra (should not exist for canonical reports)
  const mdIdx = base.toLowerCase().lastIndexOf(".md");
  return mdIdx === base.length - 3;
}

/** Map a report tmp filename to its canonical REPORT-*.md basename, if parseable. */
export function canonicalReportBasenameFromTmp(tmpName: string): string | null {
  const base = tmpName.replace(/\\/g, "/").split("/").pop() ?? tmpName;
  if (!base.endsWith(".tmp")) return null;

  // Legacy fixed suffix: REPORT-xxx.md.tmp
  if (base.endsWith(".md.tmp") && !/\.md\.\d+\.\d+\.[a-f0-9]+\.tmp$/i.test(base)) {
    return base.slice(0, -4);
  }

  const match = /^(.+\.md)\.\d+\.\d+\.[a-f0-9]+\.tmp$/i.exec(base);
  return match?.[1] ?? null;
}

export function shouldIgnoreCoordinationWatchPath(path: string): boolean {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return isEphemeralCoordinationFilename(base);
}
