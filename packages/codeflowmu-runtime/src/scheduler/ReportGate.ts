/**
 * ReportGate — ensure Rule 6 reciprocity when a worker session ends.
 *
 * If OPS/DEV/QA finishes (or fails / is cancelled) without landing
 * `REPORT-*-{role}-to-PM.md`, schedule a compensating `write_report`
 * with status `blocked` or `aborted`.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  parseMarkdownFrontmatter,
  strField,
} from "../ledger/frontmatter.ts";
import { LedgerBuilder } from "../ledger/LedgerBuilder.ts";
import { resolveReportAfterWrite } from "../ledger/index.ts";
import { invokeFcopToolOnce } from "../registry/FcopMcpOneShot.ts";
import type { PanelEventBridge } from "../panel/PanelEventBridge.ts";
import { sdkCooldownRegistry } from "../_internal/SdkCooldownRegistry.ts";
import { isCanonicalReportMarkdownFilename } from "../_internal/report-ephemeral.ts";

export interface ReportGateOpts {
  projectRoot: string;
  /** fcop/reports/ or v3 _lifecycle/review|done paths — we scan reports dir first. */
  fcopReportsDir: string;
  pythonBin?: string;
  /** When false, log only (tests). Default true. */
  autoWrite?: boolean;
  /**
   * ADR-0002: wait before reciprocity check so in-flight `write_report(status=done)`
   * can land. Default 3000ms.
   */
  settleDelayMs?: number;
  panelEvents?: PanelEventBridge;
}

export interface EnsureReciprocalReportInput {
  taskId: string;
  reporter: string;
  reportRecipient: string;
  settlementKind: "session_ended" | "session_cancelled";
  settlementNote?: string;
  sessionId?: string;
}

function normalizeTaskId(taskId: string): string {
  return taskId.replace(/\.md$/i, "").trim();
}

function taskIdMatchesReport(taskId: string, haystack: string): boolean {
  const norm = normalizeTaskId(taskId);
  const h = haystack.trim();
  if (!norm || !h) return false;
  if (h === norm || h.startsWith(norm + "-")) return true;
  if (norm.startsWith(h + "-")) return true;
  return false;
}

function reportFilenameMatches(
  filename: string,
  reporter: string,
  reportRecipient: string,
): boolean {
  const base = filename.replace(/\.md$/i, "");
  const suffix = `-${reporter}-to-${reportRecipient}`;
  return base.endsWith(suffix) || base.includes(suffix);
}

const DEFAULT_SETTLE_DELAY_MS = 3_000;
const WAITING_REPORT_TTL_MS = 60_000;

function compensatingKey(input: EnsureReciprocalReportInput): string {
  return `${normalizeTaskId(input.taskId)}:${input.reporter}:${input.reportRecipient}:${input.settlementKind}`;
}

function extractReportIdFromToolOutput(text: string): string | null {
  const m = text.match(
    /\b(REPORT-\d{8}-\d{3,}-[A-Z0-9-]+(?:-to-[A-Z0-9-]+)?)\b/i,
  );
  return m?.[1] ?? null;
}

export class ReportGate {
  readonly #projectRoot: string;
  readonly #fcopReportsDir: string;
  readonly #pythonBin: string | undefined;
  readonly #autoWrite: boolean;
  readonly #settleDelayMs: number;
  readonly #inFlight = new Set<string>();
  readonly #producedReports = new Map<string, string>();
  readonly #waitingUntil = new Map<string, number>();
  readonly #panelEvents: PanelEventBridge | undefined;

  constructor(opts: ReportGateOpts) {
    this.#projectRoot = opts.projectRoot;
    this.#fcopReportsDir = opts.fcopReportsDir;
    this.#pythonBin = opts.pythonBin;
    // TASK-20260606-001: default off — log waiting_report only; no compensating write_report.
    this.#autoWrite = opts.autoWrite === true;
    this.#settleDelayMs = opts.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS;
    this.#panelEvents = opts.panelEvents;
  }

  /**
   * Clear in-flight waiting_report TTL entries after ADMIN reject / rework.
   * Optional `reporter` limits clears to that role segment of compensatingKey.
   */
  clearWaitingForTask(taskId: string, reporter?: string): void {
    const norm = normalizeTaskId(taskId);
    const reporterUp = reporter?.trim().toUpperCase();
    for (const key of [...this.#waitingUntil.keys()]) {
      if (!key.startsWith(`${norm}:`)) continue;
      if (reporterUp) {
        const seg = key.split(":");
        if (seg[1]?.toUpperCase() !== reporterUp) continue;
      }
      this.#waitingUntil.delete(key);
    }
  }

  /** Fire-and-forget — same posture as LifecycleGovernor. */
  scheduleEnsureReciprocalReport(input: EnsureReciprocalReportInput): void {
    if (sdkCooldownRegistry.active) {
      const remainingMs = sdkCooldownRegistry.remainingMs();
      console.log(
        `[ReportGate] SDK cooldown — defer compensating write for ${input.taskId} (~${remainingMs}ms)`,
      );
      if (remainingMs > 0) {
        setTimeout(() => {
          this.scheduleEnsureReciprocalReport(input);
        }, remainingMs);
      }
      return;
    }
    const key = compensatingKey(input);
    if (this.#inFlight.has(key) || this.#producedReports.has(key)) return;
    this.#inFlight.add(key);
    void this.#ensure(input).finally(() => {
      this.#inFlight.delete(key);
    });
  }

  /** Test / diagnostic — whether a matching REPORT already exists on disk. */
  async hasMatchingReport(
    taskId: string,
    reporter: string,
    reportRecipient: string,
  ): Promise<boolean> {
    return this.#hasMatchingReport(taskId, reporter, reportRecipient);
  }

  /** Awaitable variant of {@link scheduleEnsureReciprocalReport} (tests). */
  async ensureReciprocalReport(input: EnsureReciprocalReportInput): Promise<void> {
    return this.#ensure(input);
  }

  async #ensure(input: EnsureReciprocalReportInput): Promise<void> {
    const taskId = normalizeTaskId(input.taskId);
    if (!taskId) return;

    const key = compensatingKey(input);
    if (this.#producedReports.has(key)) return;

    const waitingUntil = this.#waitingUntil.get(key) ?? 0;
    if (Date.now() < waitingUntil) return;

    if (this.#settleDelayMs > 0) {
      await this.#sleep(this.#settleDelayMs);
    }

    if (sdkCooldownRegistry.active) {
      const remainingMs = sdkCooldownRegistry.remainingMs();
      console.log(
        `[ReportGate] SDK cooldown after settle — defer compensating write for ${taskId} (~${remainingMs}ms)`,
      );
      if (remainingMs > 0) {
        setTimeout(() => {
          void this.#ensure(input);
        }, remainingMs);
      }
      return;
    }

    try {
      const builder = new LedgerBuilder({ projectRoot: this.#projectRoot });
      await builder.rebuild();
    } catch (err) {
      console.warn(
        `[ReportGate] ledger rebuild warning: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const doneReportPath = await this.#findDoneReportPath(
      taskId,
      input.reporter,
      input.reportRecipient,
    );
    if (doneReportPath) {
      this.#waitingUntil.delete(key);
      console.log(
        `[ReportGate] valid done REPORT for ${taskId}; running ledger settlement`,
      );
      try {
        await resolveReportAfterWrite(this.#projectRoot, doneReportPath, {
          panelEvents: this.#panelEvents,
        });
      } catch (err) {
        console.warn(
          `[ReportGate] resolveReportAfterWrite warning: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return;
    }

    const hasReport = await this.#hasMatchingReport(
      taskId,
      input.reporter,
      input.reportRecipient,
    );
    if (hasReport) {
      this.#waitingUntil.delete(key);
      console.log(
        `[ReportGate] reciprocal report already present for ${taskId} (${input.reporter}→${input.reportRecipient})`,
      );
      return;
    }

    const status =
      input.settlementKind === "session_cancelled" ? "aborted" : "blocked";
    const body = this.#buildAutoReportBody(input, status);
    const nextCheckAt = Date.now() + WAITING_REPORT_TTL_MS;

    console.warn(
      `[ReportGate] waiting_report: task=${taskId} no_report_yet next_check_at=${new Date(nextCheckAt).toISOString()}`,
    );
    this.#waitingUntil.set(key, nextCheckAt);
    this.#panelEvents?.emit("codeflowmu.report_gate.waiting_report", {
      event: "report_gate_waiting_report",
      task_id: taskId,
      reporter: input.reporter,
      report_recipient: input.reportRecipient,
      settlement_kind: input.settlementKind,
      settlement_note: input.settlementNote ?? "",
      session_id: input.sessionId ?? "",
      compensating_status: status,
      auto_write: this.#autoWrite,
      next_check_at: nextCheckAt,
      message: `waiting REPORT for ${taskId} (${input.reporter}→${input.reportRecipient})`,
    });

    if (!this.#autoWrite) return;

    const hasReportBeforeWrite = await this.#hasMatchingReport(
      taskId,
      input.reporter,
      input.reportRecipient,
    );
    if (hasReportBeforeWrite) {
      console.log(
        `[ReportGate] reciprocal report appeared before auto write for ${taskId}`,
      );
      return;
    }

    try {
      const text = await invokeFcopToolOnce(
        this.#pythonBin ?? "python",
        this.#projectRoot,
        "write_report",
        {
          task_id: taskId,
          reporter: input.reporter,
          recipient: input.reportRecipient,
          status,
          body,
        },
      );
      const producedId = extractReportIdFromToolOutput(text);
      if (producedId) {
        this.#producedReports.set(key, producedId);
      }
      console.log(
        `[ReportGate] auto write_report ok for ${taskId}: ${text.slice(0, 200)}`,
      );
    } catch (err) {
      console.error(
        `[ReportGate] auto write_report error for ${taskId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async #findDoneReportPath(
    taskId: string,
    reporter: string,
    reportRecipient: string,
  ): Promise<string | null> {
    try {
      const builder = new LedgerBuilder({ projectRoot: this.#projectRoot });
      const reports = await builder.listReportsForTask(taskId);
      for (const r of reports) {
        if (!reportFilenameMatches(r.filename, reporter, reportRecipient)) {
          continue;
        }
        const st = (r.status ?? "").toLowerCase();
        if (st === "done" || st === "completed") {
          return r.path ?? join(this.#fcopReportsDir, r.filename);
        }
      }
    } catch {
      /* fall through to disk scan */
    }

    const dirs = [this.#fcopReportsDir];
    const lifecycleReview = join(
      this.#projectRoot,
      "fcop",
      "_lifecycle",
      "review",
    );
    const lifecycleDone = join(
      this.#projectRoot,
      "fcop",
      "_lifecycle",
      "done",
    );
    dirs.push(lifecycleReview, lifecycleDone);

    for (const dir of dirs) {
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!isCanonicalReportMarkdownFilename(name)) continue;
        if (!reportFilenameMatches(name, reporter, reportRecipient)) continue;
        const fullPath = join(dir, name);
        const content = await fs.readFile(fullPath, "utf8").catch(() => "");
        if (!this.#reportReferencesTask(content, taskId)) continue;
        const fm = parseMarkdownFrontmatter(content);
        const st = (strField(fm, "status") || "").toLowerCase();
        if (st === "done" || st === "completed") return fullPath;
      }
    }
    return null;
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async #hasMatchingReport(
    taskId: string,
    reporter: string,
    reportRecipient: string,
  ): Promise<boolean> {
    const dirs = [this.#fcopReportsDir];
    const lifecycleReview = join(
      this.#projectRoot,
      "fcop",
      "_lifecycle",
      "review",
    );
    const lifecycleDone = join(
      this.#projectRoot,
      "fcop",
      "_lifecycle",
      "done",
    );
    dirs.push(lifecycleReview, lifecycleDone);

    for (const dir of dirs) {
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!isCanonicalReportMarkdownFilename(name)) continue;
        if (!reportFilenameMatches(name, reporter, reportRecipient)) continue;
        const content = await fs.readFile(join(dir, name), "utf8").catch(() => "");
        if (this.#reportReferencesTask(content, taskId)) return true;
      }
    }
    return false;
  }

  #reportReferencesTask(content: string, taskId: string): boolean {
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

  #buildAutoReportBody(
    input: EnsureReciprocalReportInput,
    status: string,
  ): string {
    const lines = [
      "## Runtime 自动补写 / Auto-generated reciprocal report",
      "",
      "本报告由 CodeFlow runtime **ReportGate** 在 worker 会话结束时自动写入，",
      "因为磁盘上未找到针对该 TASK 的 `REPORT-*` 回执（FCoP Rule 6：沉默 = 违约）。",
      "",
      `- **task_id**: \`${normalizeTaskId(input.taskId)}\``,
      `- **reporter**: ${input.reporter}`,
      `- **recipient**: ${input.reportRecipient}`,
      `- **settlement**: ${input.settlementKind}`,
      `- **status**: ${status}`,
    ];
    if (input.sessionId) {
      lines.push(`- **session_id**: ${input.sessionId}`);
    }
    if (input.settlementNote?.trim()) {
      lines.push("", "## Settlement 详情", "", input.settlementNote.trim());
    }
    lines.push(
      "",
      "## 下一步 / Next step",
      "",
      "请 PM 审阅并决定是否重派 TASK 或升级 ISSUE。",
    );
    return lines.join("\n");
  }
}
