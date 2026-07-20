/**
 * Startup scan: stale REPORT *.tmp under fcop/reports/ must not trigger watchers.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { canonicalReportBasenameFromTmp } from "./report-ephemeral.ts";

const QUARANTINE_AGE_MS = 5 * 60 * 1000;

export interface QuarantineTmpReportsResult {
  quarantined: string[];
  orphans: string[];
}

export interface QuarantineTmpReportsLogger {
  info?(msg: string): void;
  warn?(msg: string): void;
}

function isReportTmpName(name: string): boolean {
  if (!name.endsWith(".tmp")) return false;
  if (canonicalReportBasenameFromTmp(name)) return true;
  return /^REPORT-.*\.md\.tmp$/i.test(name);
}

/**
 * Before ReportWatcher starts:
 * - md exists + tmp older than 5m → move tmp to fcop/internal/quarantine/tmp-reports/
 * - tmp only → log orphan_tmp_report, keep file
 */
export async function quarantineStaleReportTmps(
  reportsDir: string,
  projectRoot: string,
  logger?: QuarantineTmpReportsLogger,
): Promise<QuarantineTmpReportsResult> {
  const result: QuarantineTmpReportsResult = { quarantined: [], orphans: [] };
  let names: string[];
  try {
    names = await fs.readdir(reportsDir);
  } catch {
    return result;
  }

  const quarantineDir = join(
    projectRoot,
    "fcop",
    "internal",
    "quarantine",
    "tmp-reports",
  );
  const now = Date.now();

  for (const name of names) {
    if (!isReportTmpName(name)) continue;

    const canonical =
      canonicalReportBasenameFromTmp(name) ??
      (name.endsWith(".md.tmp") ? name.slice(0, -4) : null);
    if (!canonical) continue;

    const tmpPath = join(reportsDir, name);
    const mdPath = join(reportsDir, canonical);

    let st: { mtimeMs: number };
    try {
      st = await fs.stat(tmpPath);
    } catch {
      continue;
    }

    let mdExists = false;
    try {
      await fs.access(mdPath);
      mdExists = true;
    } catch {
      mdExists = false;
    }

    if (!mdExists) {
      result.orphans.push(name);
      logger?.warn?.(
        `[report-tmp-quarantine] orphan_tmp_report: ${name} (no ${canonical})`,
      );
      continue;
    }

    if (now - st.mtimeMs < QUARANTINE_AGE_MS) continue;

    await fs.mkdir(quarantineDir, { recursive: true });
    const dest = join(quarantineDir, name);
    try {
      await fs.rename(tmpPath, dest);
      result.quarantined.push(name);
      logger?.info?.(
        `[report-tmp-quarantine] quarantined stale tmp ${name} → ${dest}`,
      );
    } catch (err) {
      logger?.warn?.(
        `[report-tmp-quarantine] failed to quarantine ${name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return result;
}
