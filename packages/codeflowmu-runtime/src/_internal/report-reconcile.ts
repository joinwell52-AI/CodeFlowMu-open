/**
 * Reconcile session outcome against on-disk REPORT files (Rule 6 / disk truth).
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { isCanonicalReportMarkdownFilename } from "./report-ephemeral.ts";
import { resolveEnvelopeTimestamps } from "./local-iso.ts";
import {
  parseMarkdownFrontmatter,
  strField,
} from "../ledger/frontmatter.ts";
import { findTaskLocationById } from "../lifecycle/taskPathUtils.ts";

export interface FindReportForTaskOpts {
  projectRoot?: string;
  fcopReportsDir?: string;
  taskId: string;
  reporter: string;
  reportRecipient?: string;
  /** @deprecated Timestamp vs transition comparison supersedes this flag. */
  ignoreStalePmFinalWhenRootInRework?: boolean;
}

function normalizeTaskId(taskId: string): string {
  return taskId.replace(/\.md$/i, "").trim();
}

function taskIdMatchesReport(taskId: string, haystack: string): boolean {
  const norm = normalizeTaskId(taskId);
  const h = haystack.trim();
  if (!norm || !h) return false;
  if (h === norm || h.startsWith(`${norm}-`)) return true;
  if (norm.startsWith(`${h}-`)) return true;
  return false;
}

function reportFilenameMatchesReporter(filename: string, reporter: string): boolean {
  const base = filename.replace(/\.md$/i, "");
  return base.includes(`-${reporter}-to-`);
}

function reportFilenameMatches(
  filename: string,
  reporter: string,
  reportRecipient?: string,
): boolean {
  if (!reportRecipient) {
    return reportFilenameMatchesReporter(filename, reporter);
  }
  const base = filename.replace(/\.md$/i, "");
  const suffix = `-${reporter}-to-${reportRecipient}`;
  return base.endsWith(suffix) || base.includes(suffix);
}

function reportReferencesTask(content: string, taskId: string): boolean {
  const fm = parseMarkdownFrontmatter(content);
  const refs = [
    strField(fm, "task_id"),
    fm.references,
    strField(fm, "parent"),
    fm.related,
  ];
  for (const ref of refs) {
    if (typeof ref === "string" && taskIdMatchesReport(taskId, ref)) {
      return true;
    }
    if (Array.isArray(ref)) {
      for (const item of ref) {
        if (typeof item === "string" && taskIdMatchesReport(taskId, item)) {
          return true;
        }
      }
    }
  }
  if (taskIdMatchesReport(taskId, content.slice(0, 800))) return true;
  return false;
}

/** Parse ISO-8601 (offset or Z) to epoch ms; null when unparseable. */
export function parseIsoTimeMs(value: string | undefined): number | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/** Latest `transitions[].at` on task frontmatter, or null when none. */
export function getLatestTransitionAtMs(
  taskFm: Record<string, unknown>,
): number | null {
  const transitions = Array.isArray(taskFm.transitions) ? taskFm.transitions : [];
  let max: number | null = null;
  for (const t of transitions) {
    if (!t || typeof t !== "object" || !("at" in t)) continue;
    const ms = parseIsoTimeMs(String((t as { at: unknown }).at ?? ""));
    if (ms == null) continue;
    if (max == null || ms > max) max = ms;
  }
  return max;
}

export function getReportCreatedAtMs(
  reportFm: Record<string, unknown>,
  mtimeMs?: number,
): number {
  const ts = resolveEnvelopeTimestamps(reportFm, mtimeMs);
  return (
    parseIsoTimeMs(ts.created_at) ??
    (Number.isFinite(mtimeMs) ? (mtimeMs as number) : Date.now())
  );
}

/**
 * True when an on-disk REPORT should block wake for the current lifecycle round.
 * Requires report.created_at strictly after the latest task transition.
 */
export function reportBlocksCurrentRoundWake(
  reportCreatedAtMs: number,
  latestTransitionAtMs: number | null,
): boolean {
  if (latestTransitionAtMs == null) {
    return true;
  }
  return reportCreatedAtMs > latestTransitionAtMs;
}

interface MatchedReportOnDisk {
  name: string;
  content: string;
  createdAtMs: number;
}

function reportDirs(opts: FindReportForTaskOpts): string[] {
  const dirs: string[] = [];
  if (opts.fcopReportsDir) {
    dirs.push(opts.fcopReportsDir);
  }
  if (opts.projectRoot) {
    dirs.push(
      join(opts.projectRoot, "fcop", "reports"),
      join(opts.projectRoot, "fcop", "_lifecycle", "review"),
      join(opts.projectRoot, "fcop", "_lifecycle", "done"),
    );
  }
  return dirs;
}

async function collectMatchingReports(
  opts: FindReportForTaskOpts,
): Promise<MatchedReportOnDisk[]> {
  const matches: MatchedReportOnDisk[] = [];
  for (const dir of reportDirs(opts)) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!isCanonicalReportMarkdownFilename(name)) continue;
      if (!reportFilenameMatches(name, opts.reporter, opts.reportRecipient)) {
        continue;
      }
      const full = join(dir, name);
      const content = await fs.readFile(full, "utf8").catch(() => "");
      if (!reportReferencesTask(content, opts.taskId)) continue;
      const stat = await fs.stat(full).catch(() => null);
      const fm = parseMarkdownFrontmatter(content);
      const createdAtMs = getReportCreatedAtMs(
        fm,
        stat?.mtimeMs,
      );
      matches.push({ name, content, createdAtMs });
    }
  }
  return matches;
}

async function latestMatchingReportBlocksWake(
  opts: FindReportForTaskOpts,
  matches: MatchedReportOnDisk[],
): Promise<boolean> {
  if (matches.length === 0) return false;
  if (!opts.projectRoot) {
    return true;
  }

  const latest = matches.reduce((a, b) =>
    b.createdAtMs > a.createdAtMs ? b : a,
  );

  const lifecycleRoot = join(opts.projectRoot, "fcop", "_lifecycle");
  const located = await findTaskLocationById(
    lifecycleRoot,
    normalizeTaskId(opts.taskId),
    { hotTasksDir: join(opts.projectRoot, "fcop", "tasks") },
  );
  if (!located) {
    return true;
  }

  const taskBody = await fs.readFile(located.path, "utf8").catch(() => "");
  const taskFm = parseMarkdownFrontmatter(taskBody);
  const latestTransitionAt = getLatestTransitionAtMs(taskFm);
  return reportBlocksCurrentRoundWake(latest.createdAtMs, latestTransitionAt);
}

/** Extract role prefix from agent id (e.g. `DEV-01` → `DEV`). */
export function roleFromAgentId(agentId: string): string {
  const m = /^([A-Za-z]+)/.exec(agentId.trim());
  return (m?.[1] ?? agentId).toUpperCase();
}

/**
 * Returns true when a current-round REPORT referencing `taskId` from `reporter`
 * exists on disk (blocks wake). Stale reports from prior rounds do not count.
 */
export async function findReportForTaskOnDisk(
  opts: FindReportForTaskOpts,
): Promise<boolean> {
  const matches = await collectMatchingReports(opts);
  return latestMatchingReportBlocksWake(opts, matches);
}

/** Returns relative path (posix-style) to latest matching REPORT, or null. */
export async function findReportPathForTaskOnDisk(
  opts: FindReportForTaskOpts,
): Promise<string | null> {
  const dirs: { root?: string; dir: string }[] = [];
  if (opts.fcopReportsDir) {
    dirs.push({ dir: opts.fcopReportsDir });
  }
  if (opts.projectRoot) {
    const root = opts.projectRoot;
    dirs.push(
      { root, dir: join(root, "fcop", "reports") },
      { root, dir: join(root, "fcop", "_lifecycle", "review") },
      { root, dir: join(root, "fcop", "_lifecycle", "done") },
    );
  }
  if (dirs.length === 0) return null;

  let best: { rel: string; createdAtMs: number } | null = null;

  for (const { root, dir } of dirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!isCanonicalReportMarkdownFilename(name)) continue;
      if (!reportFilenameMatches(name, opts.reporter, opts.reportRecipient)) {
        continue;
      }
      const full = join(dir, name);
      const content = await fs.readFile(full, "utf8").catch(() => "");
      if (!reportReferencesTask(content, opts.taskId)) continue;
      const stat = await fs.stat(full).catch(() => null);
      const fm = parseMarkdownFrontmatter(content);
      const createdAtMs = getReportCreatedAtMs(fm, stat?.mtimeMs);
      const rel = root
        ? full
            .slice(root.length)
            .replace(/^[/\\]+/, "")
            .replace(/\\/g, "/")
        : name;
      if (!best || createdAtMs > best.createdAtMs) {
        best = { rel, createdAtMs };
      }
    }
  }

  return best?.rel ?? null;
}
