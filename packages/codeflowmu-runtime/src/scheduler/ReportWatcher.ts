/**
 * ReportWatcher — watches fcop/reports/ for REPORT-*-{ROLE}-to-PM.md
 * and synthesises a PM consolidation task so PM-01 can summarise and
 * report back to ADMIN automatically.
 *
 * This closes the multi-role loop:
 *
 *   DEV-01 writes REPORT-*-DEV-to-PM.md
 *         ↓  (ReportWatcher detects)
 *   PM-01 gets a synthetic "consolidation" session
 *         ↓
 *   PM-01 writes REPORT-*-PM-to-ADMIN.md
 *
 * Design:
 *   - Watches ONE directory (fcop/reports/), depth=0.
 *   - add / change / rename merged via EventDedupeRegistry (mtime+size).
 *   - Matches REPORT-YYYYMMDD-NNN-{ROLE}-to-PM.md (recipient = PM).
 *   - Ignores REPORT-*-PM-to-*.md (PM's own outgoing reports).
 *   - Reads the file, packages its content into a `ReportEvent`, and
 *     calls a handler provided by the caller (typically ReportDispatcher).
 *   - Handler errors are isolated — one bad report cannot crash the loop.
 *
 * Added in v0.3 (multi-role loop closure sprint).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import chokidar from "chokidar";
import type { FSWatcher } from "chokidar";
import { eventDedupeRegistry } from "../_internal/EventDedupeRegistry.ts";
import { shouldIgnoreCoordinationWatchPath } from "../_internal/report-ephemeral.ts";
import { isGovernanceReportToPm } from "../fcop/governance.ts";
import type { ReportWatcherSeenStore } from "./ReportWatcherSeenStore.ts";

/** A report file that arrived for the PM role. */
export interface ReportEvent {
  /** Absolute path to the REPORT-*.md file. */
  filepath: string;
  /** Just the filename, e.g. REPORT-20260513-017-DEV-to-PM-v03.md */
  filename: string;
  /** Sender role extracted from filename (e.g. "DEV"). */
  senderRole: string;
  /** Full markdown content of the report file. */
  content: string;
}

export type ReportEventHandler = (evt: ReportEvent) => Promise<void> | void;

export interface ReportWatcherOpts {
  /** Absolute path to fcop/reports/ directory. */
  dir: string;
  /** Called when a new REPORT-*-{ROLE}-to-PM.md is added. */
  onReport: ReportEventHandler;
  /** Optional persistent dedup store (survives restart). */
  seenStore?: ReportWatcherSeenStore;
  /** Formal REPORT files are append-only; any in-place change is an audit violation. */
  onIntegrityViolation?: (input: {
    filepath: string;
    filename: string;
    reason: "formal_report_modified_in_place";
  }) => Promise<void> | void;
  logger?: {
    info?(msg: string): void;
    warn?(msg: string): void;
    error?(msg: string): void;
  };
}

/** Regex: REPORT-YYYYMMDD-NNN-{SENDER}-to-PM[-slug].md */
const REPORT_TO_PM_RE =
  /^REPORT-\d{8}-\d{3,}-([A-Za-z]+)-to-PM(-[A-Za-z0-9]+)*\.md$/;

/** PM hot-path closure: REPORT-*-PM-to-ADMIN → submit_review (not PM consolidation). */
const REPORT_PM_TO_ADMIN_RE =
  /^REPORT-\d{8}-\d{3,}-PM-to-ADMIN(-[a-z][a-z0-9-]*)?\.md$/i;

export class ReportWatcher {
  private readonly _dir: string;
  private readonly _handler: ReportEventHandler;
  private readonly _seenStore: ReportWatcherSeenStore | null;
  private readonly _onIntegrityViolation: ReportWatcherOpts["onIntegrityViolation"];
  private readonly _log: NonNullable<ReportWatcherOpts["logger"]>;
  private _watcher: FSWatcher | null = null;
  /** Successfully dispatched filenames (in-process). */
  private readonly _dispatchedReports = new Set<string>();
  /** Handler in-flight — prevents concurrent double-dispatch. */
  private readonly _inFlight = new Set<string>();

  constructor(opts: ReportWatcherOpts) {
    this._dir = resolvePath(opts.dir);
    this._handler = opts.onReport;
    this._seenStore = opts.seenStore ?? null;
    this._onIntegrityViolation = opts.onIntegrityViolation;
    this._log = opts.logger ?? {};
  }

  async start(): Promise<void> {
    this._seenStore?.load();
    this._watcher = chokidar.watch(this._dir, {
      depth: 0,
      ignoreInitial: true,
      persistent: true,
      // write_report lands the file and immediately enriches its frontmatter.
      // Treat that short internal write sequence as one stable add event;
      // a later user/agent edit still arrives as a real change violation.
      awaitWriteFinish: {
        stabilityThreshold: 750,
        pollInterval: 50,
      },
      ignored: (watchPath) => shouldIgnoreCoordinationWatchPath(watchPath),
    });

    const onFsEvent = (fullPath: string): void => {
      void this._onFilesystemEvent(fullPath);
    };
    const onChange = (fullPath: string): void => {
      const filename = fullPath.replace(/\\/g, "/").split("/").pop() ?? "";
      if (REPORT_TO_PM_RE.test(filename) || REPORT_PM_TO_ADMIN_RE.test(filename)) {
        void this._onIntegrityViolation?.({
          filepath: fullPath,
          filename,
          reason: "formal_report_modified_in_place",
        });
        this._log.error?.(
          `[ReportWatcher] integrity violation: formal REPORT modified in place: ${filename}`,
        );
        return;
      }
      onFsEvent(fullPath);
    };

    this._watcher.on("add", onFsEvent);
    this._watcher.on("change", onChange);

    await new Promise<void>((resolve) => {
      this._watcher!.on("ready", resolve);
    });
    await this._backfillPmToAdminReports();
    this._log.info?.(`[ReportWatcher] watching ${this._dir}`);
  }

  /** 启动时补扫已落盘但未 seen 的 PM-to-ADMIN（手动物盘 / watcher 未在线）。 */
  private async _backfillPmToAdminReports(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this._dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (!REPORT_PM_TO_ADMIN_RE.test(name)) continue;
      if (this._dispatchedReports.has(name) || this._seenStore?.has(name)) {
        continue;
      }
      const fullPath = resolvePath(this._dir, name);
      await this._dispatchReport(
        name,
        fullPath,
        "PM",
        "startup backfill — PM-to-ADMIN",
      );
    }
  }

  async stop(): Promise<void> {
    await this._watcher?.close();
    this._watcher = null;
  }

  private async _onFilesystemEvent(fullPath: string): Promise<void> {
    if (shouldIgnoreCoordinationWatchPath(fullPath)) return;

    const filename = fullPath.replace(/\\/g, "/").split("/").pop() ?? "";

    const pmToAdmin = REPORT_PM_TO_ADMIN_RE.exec(filename);
    if (pmToAdmin) {
      await this._dispatchReport(
        filename,
        fullPath,
        "PM",
        "PM outbound — submit_review path",
      );
      return;
    }

    const match = REPORT_TO_PM_RE.exec(filename);
    if (!match) return;

    const senderRole = match[1]!;
    if (senderRole.toUpperCase() === "PM") return;
    if (isGovernanceReportToPm(filename, senderRole)) {
      this._log.info?.(
        `[ReportWatcher] skip governance report ${filename} (not team-visible)`,
      );
      return;
    }

    await this._dispatchReport(
      filename,
      fullPath,
      senderRole,
      "routing to PM-01 for consolidation",
    );
  }

  private async _dispatchReport(
    filename: string,
    fullPath: string,
    senderRole: string,
    logHint: string,
  ): Promise<void> {
    if (
      this._dispatchedReports.has(filename) ||
      this._seenStore?.has(filename)
    ) {
      return;
    }
    if (this._inFlight.has(filename)) {
      return;
    }

    let st: { mtimeMs: number; size: number };
    try {
      st = await stat(fullPath);
    } catch {
      return;
    }

    if (
      !eventDedupeRegistry.shouldProcessFileEvent(
        fullPath,
        st.mtimeMs,
        st.size,
      )
    ) {
      return;
    }

    this._inFlight.add(filename);
    this._log.info?.(`[ReportWatcher] ${filename} — ${logHint}`);

    try {
      const content = await readFile(fullPath, "utf-8");
      await this._handler({
        filepath: fullPath,
        filename,
        senderRole,
        content,
      });
      this._dispatchedReports.add(filename);
      this._seenStore?.mark(filename);
    } catch (err) {
      eventDedupeRegistry.forgetFileEvent(fullPath, st.mtimeMs, st.size);
      this._log.error?.(
        `[ReportWatcher] handler error for ${filename}: ${String(err)}`,
      );
    } finally {
      this._inFlight.delete(filename);
    }
  }
}
