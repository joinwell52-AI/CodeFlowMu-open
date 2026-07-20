/**
 * DownstreamAutoNudge — runtime track: auto wake_downstream when PM worker
 * sub-tasks stay active without REPORT past idle threshold.
 *
 * Does NOT mutate TASK/REPORT files or lifecycle directories.
 */

import { isAbsolute, join, resolve } from "node:path";
import { readFile } from "node:fs/promises";

import { findReportForTaskOnDisk } from "../_internal/report-reconcile.ts";
import { isWorkerReportToPm } from "../fcop/governance.ts";
import { readLedgerTasksJsonl, resolveLedgerLayout } from "../ledger/index.ts";
import type { LedgerReportRecord, LedgerTaskRecord } from "../ledger/types.ts";
import { taskIdMatchesPrefix } from "../ledger/reportParenting.ts";
import { buildWakeDownstreamRequest } from "../pm/PmGovernanceActions.ts";
import { getTaskDispatchStatus } from "../pm/agentTaskQueue.ts";
import {
  evaluateWorkerReceiptWaiting,
  MAX_DOWNSTREAM_AUTO_NUDGES,
} from "../pm/workerReceiptWaiting.ts";
import {
  mergeWorkerReceiptSignals,
  persistWorkerReceiptFailed,
  resolveWorkerReceiptDurableHints,
} from "../pm/workerReceiptDurableHints.ts";
import type { WakeDownstreamExecutor } from "../pm/PmGovernancePlanner.ts";
import type { PanelEventBridge } from "../panel/PanelEventBridge.ts";
import type { PmQueueGuard } from "./PmQueueGuard.ts";
import { isPmToWorkerDispatch } from "./PmQueueGuard.ts";
import { evaluateTaskDependencyGate } from "./TaskDependencyGate.ts";
import { TaskParser } from "./TaskParser.ts";

export const DEFAULT_DOWNSTREAM_NUDGE_IDLE_MS = 5 * 60_000;
export const DEFAULT_DOWNSTREAM_NUDGE_DEBOUNCE_MS = 6 * 60_000;
export const DEFAULT_DOWNSTREAM_NUDGE_POLL_MS = 30_000;

export const DOWNSTREAM_AUTO_NUDGE_EVENT = "codeflowmu.downstream_auto_nudge";

export interface DownstreamAutoNudgeLogger {
  warn?(msg: string): void;
  info?(msg: string): void;
}

export interface DownstreamAutoNudgeOpts {
  projectRoot: () => string;
  wakeExecutor: () => WakeDownstreamExecutor | null;
  pmQueueGuard: PmQueueGuard;
  panelEventBridge?: PanelEventBridge;
  logger?: DownstreamAutoNudgeLogger;
  now?: () => number;
  idleMs?: number;
  debounceMs?: number;
  pollMs?: number;
}

function isOpenLifecycleBucket(bucket: string | undefined): boolean {
  const b = String(bucket ?? "").toLowerCase();
  return b === "active" || b === "review" || b === "tasks" || b === "inbox";
}

function parseLedgerTimeMs(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

async function readLedgerReportsJsonl(
  filePath: string,
): Promise<LedgerReportRecord[]> {
  let raw = "";
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return [];
  }
  const out: LedgerReportRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LedgerReportRecord);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

function parentTaskId(task: LedgerTaskRecord): string | null {
  const fromYaml = task.yaml?.parent;
  if (typeof fromYaml === "string" && fromYaml.trim()) return fromYaml.trim();
  if (task.parent?.trim()) return task.parent.trim();
  return null;
}

function hasActivePmMainline(
  tasks: LedgerTaskRecord[],
  child: LedgerTaskRecord,
): boolean {
  const threadKey = child.thread_key?.trim() || null;
  const adminPmOpen = tasks.some(
    (t) =>
      t.sender === "ADMIN" &&
      t.recipient === "PM" &&
      isOpenLifecycleBucket(t.bucket) &&
      (!threadKey || t.thread_key === threadKey),
  );
  if (adminPmOpen) return true;

  const pid = parentTaskId(child);
  if (!pid) return false;
  const parent = tasks.find((t) => taskIdMatchesPrefix(t.task_id, pid));
  return Boolean(parent && isOpenLifecycleBucket(parent.bucket));
}

function isForceArchivedOrPaused(task: LedgerTaskRecord): boolean {
  const yaml = task.yaml ?? {};
  if (String(task.state ?? yaml["state"] ?? "").toLowerCase() === "paused") return true;
  if (String(yaml["archive_mode"] ?? "").toLowerCase() === "force") return true;
  if (String(yaml["task_type"] ?? "").toLowerCase() === "force_archive") return true;
  const transitions = Array.isArray(task.transitions)
    ? task.transitions
    : Array.isArray(yaml["transitions"])
      ? (yaml["transitions"] as unknown[])
      : [];
  return transitions.some((item) => {
    const action =
      item && typeof item === "object"
        ? String((item as Record<string, unknown>)["action"] ?? "").toLowerCase()
        : "";
    return action === "force_archive_task" || action === "force_archive";
  });
}

function hasTrustedInboxParent(
  tasks: LedgerTaskRecord[],
  task: LedgerTaskRecord,
): boolean {
  const pid = parentTaskId(task);
  if (!pid) return false;
  return tasks.some(
    (parent) =>
      parent.sender === "ADMIN" &&
      parent.recipient === "PM" &&
      isOpenLifecycleBucket(parent.bucket) &&
      taskIdMatchesPrefix(parent.task_id, pid),
  );
}

export function isPmWorkerTaskOpen(
  task: LedgerTaskRecord,
  tasks: LedgerTaskRecord[],
): boolean {
  const bucket = String(task.bucket ?? "").toLowerCase();
  const role = task.recipient.trim().toUpperCase();
  return (
    isPmToWorkerDispatch(task.sender, task.recipient, task.filename) &&
    ["DEV", "OPS", "QA"].includes(role) &&
    (bucket === "active" || bucket === "review" || bucket === "tasks" || bucket === "inbox") &&
    !isForceArchivedOrPaused(task) &&
    (bucket !== "inbox" || hasTrustedInboxParent(tasks, task))
  );
}

export class DownstreamAutoNudge {
  readonly #projectRoot: () => string;
  readonly #wakeExecutor: () => WakeDownstreamExecutor | null;
  readonly #pmQueueGuard: PmQueueGuard;
  readonly #panel: PanelEventBridge | undefined;
  readonly #log: NonNullable<DownstreamAutoNudgeLogger>;
  readonly #now: () => number;
  readonly #idleMs: number;
  readonly #debounceMs: number;
  readonly #pollMs: number;

  #timer: ReturnType<typeof setInterval> | null = null;
  #ticking = false;
  #lastNudgeAtByTask = new Map<string, number>();

  constructor(opts: DownstreamAutoNudgeOpts) {
    this.#projectRoot = opts.projectRoot;
    this.#wakeExecutor = opts.wakeExecutor;
    this.#pmQueueGuard = opts.pmQueueGuard;
    this.#panel = opts.panelEventBridge;
    this.#log = opts.logger ?? {};
    this.#now = opts.now ?? (() => Date.now());
    this.#idleMs = opts.idleMs ?? DEFAULT_DOWNSTREAM_NUDGE_IDLE_MS;
    this.#debounceMs = opts.debounceMs ?? DEFAULT_DOWNSTREAM_NUDGE_DEBOUNCE_MS;
    this.#pollMs = opts.pollMs ?? DEFAULT_DOWNSTREAM_NUDGE_POLL_MS;
  }

  start(): void {
    if (this.#timer) return;
    void this.tick();
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#pollMs);
    if (typeof this.#timer === "object" && "unref" in this.#timer) {
      this.#timer.unref();
    }
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      await this.#runTick();
    } finally {
      this.#ticking = false;
    }
  }

  async #runTick(): Promise<void> {
    const root = this.#projectRoot();
    if (!root?.trim()) return;

    const layout = resolveLedgerLayout(root);
    let tasks: LedgerTaskRecord[];
    let reports: LedgerReportRecord[];
    try {
      tasks = await readLedgerTasksJsonl(join(layout.ledgerDir, "tasks.jsonl"));
      reports = await readLedgerReportsJsonl(
        join(layout.ledgerDir, "reports.jsonl"),
      );
    } catch {
      return;
    }

    const openWorkers = tasks.filter(
      (t) => isPmWorkerTaskOpen(t, tasks) && hasActivePmMainline(tasks, t),
    );
    if (!openWorkers.length) {
      this.#pmQueueGuard.clearAutoNudge();
      this.#pmQueueGuard.clearWaitingDownstream();
      return;
    }

    const now = this.#now();
    let trackedWaiting = false;

    for (const task of openWorkers) {
      if ((await getTaskDispatchStatus(root, task.task_id)) === "paused") continue;
      const taskPath = isAbsolute(task.path) ? task.path : resolve(root, task.path);
      try {
        const parsedTask = await TaskParser.parse(taskPath);
        const dependencyGate = await evaluateTaskDependencyGate(parsedTask, root);
        if (!dependencyGate.allowed) {
          this.#lastNudgeAtByTask.delete(task.task_id);
          this.#log.info?.(
            `[DownstreamAutoNudge] dependency pending ${task.task_id}: ${dependencyGate.reason ?? "waiting"}`,
          );
          continue;
        }
      } catch (err) {
        this.#log.warn?.(
          `[DownstreamAutoNudge] task preflight unavailable ${task.task_id}: ${String(err)}`,
        );
        continue;
      }
      const role = task.recipient.trim().toUpperCase();
      const hasReport = await findReportForTaskOnDisk({
        projectRoot: root,
        taskId: task.task_id,
        reporter: role,
        reportRecipient: "PM",
      });

      const durable = await resolveWorkerReceiptDurableHints(root, task.task_id);
      const merged = mergeWorkerReceiptSignals(
        {
          nudgeCount: this.#pmQueueGuard.nudgeCountForTask(task.task_id),
          workerFailed: this.#pmQueueGuard.isDownstreamWorkerFailed(task.task_id),
        },
        durable,
      );

      const receipt = evaluateWorkerReceiptWaiting({
        tasks,
        reports,
        targetRole: role,
        focusTaskId: task.task_id,
        nudgeCount: merged.nudgeCount,
        workerFailed: merged.workerFailed,
        sessionFailed: merged.sessionFailed,
        sessionUnsettled: merged.sessionUnsettled,
        recoverable: merged.recoverable,
        lastSessionId: merged.lastSessionId,
        lastFailureCode: merged.lastFailureCode,
        lastFailureCategory: merged.lastFailureCategory,
        isFirstTurnAbort: merged.isFirstTurnAbort,
        lastSessionStatus: durable.lastSessionStatus,
        hasReportOnDisk: hasReport,
      });

      if (
        receipt.phase === "session_recoverable" ||
        receipt.phase === "session_running"
      ) {
        continue;
      }

      if (receipt.shouldClearGuard) {
        this.#lastNudgeAtByTask.delete(task.task_id);
        if (
          receipt.phase === "worker_receipt_failed" &&
          receipt.workerTaskId &&
          !merged.recoverable
        ) {
          this.#pmQueueGuard.markDownstreamWorkerFailed(receipt.workerTaskId);
          void persistWorkerReceiptFailed(
            root,
            receipt.workerTaskId,
            receipt.reason,
          );
        }
        continue;
      }

      if (!receipt.shouldShowWaiting) {
        this.#lastNudgeAtByTask.delete(task.task_id);
        continue;
      }

      if (!trackedWaiting) {
        this.#pmQueueGuard.markWaitingDownstream(role, "downstream_watch");
        trackedWaiting = true;
      }

      const updatedMs =
        parseLedgerTimeMs(task.updated_at) ??
        parseLedgerTimeMs(task.created_at) ??
        now;
      const idleFor = now - updatedMs;
      if (idleFor < this.#idleMs) continue;

      const lastNudge = this.#lastNudgeAtByTask.get(task.task_id) ?? 0;
      if (lastNudge > 0 && now - lastNudge < this.#debounceMs) {
        this.#pmQueueGuard.recordAutoNudge({
          task_id: task.task_id,
          role,
          nudged_at: lastNudge,
          next_nudge_at: lastNudge + this.#debounceMs,
        });
        continue;
      }

      const nudgeCount = merged.nudgeCount;
      if (nudgeCount >= MAX_DOWNSTREAM_AUTO_NUDGES) {
        this.#pmQueueGuard.markDownstreamWorkerFailed(task.task_id);
        void persistWorkerReceiptFailed(root, task.task_id, "max_nudges_exceeded");
        continue;
      }

      const wake = this.#wakeExecutor();
      if (!wake) {
        this.#log.warn?.(
          `[DownstreamAutoNudge] wake executor not ready for ${task.task_id}`,
        );
        continue;
      }

      const plan = buildWakeDownstreamRequest({
        task_id: task.task_id,
        role,
        reason: "downstream_auto_nudge",
        thread_key: task.thread_key ?? null,
        source: "downstream_auto_nudge",
        caller: "runtime",
      });

      let result: Awaited<ReturnType<WakeDownstreamExecutor>>;
      try {
        result = await wake(plan);
      } catch (err) {
        const msg = String(err);
        this.#log.warn?.(
          `[DownstreamAutoNudge] wake failed ${task.task_id}: ${msg}`,
        );
        this.#panel?.emit(DOWNSTREAM_AUTO_NUDGE_EVENT, {
          task_id: task.task_id,
          role,
          ok: false,
          error: msg,
          thread_key: task.thread_key ?? null,
          ts: now,
        });
        const nextCount = this.#pmQueueGuard.bumpNudgeCount(task.task_id);
        if (nextCount >= MAX_DOWNSTREAM_AUTO_NUDGES) {
          this.#pmQueueGuard.markDownstreamWorkerFailed(task.task_id);
          void persistWorkerReceiptFailed(root, task.task_id, "max_nudges_exceeded");
        }
        continue;
      }

      if (result.skipped || result.delayed) {
        this.#log.info?.(
          `[DownstreamAutoNudge] wake skipped/delayed ${task.task_id}: ${result.reason ?? result.error ?? "unknown"}`,
        );
        continue;
      }

      if (!result.ok) {
        this.#log.warn?.(
          `[DownstreamAutoNudge] wake not ok ${task.task_id}: ${result.error ?? "unknown"}`,
        );
        this.#panel?.emit(DOWNSTREAM_AUTO_NUDGE_EVENT, {
          task_id: task.task_id,
          role,
          ok: false,
          error: result.error ?? "wake_failed",
          agent_id: result.agent_id ?? null,
          thread_key: task.thread_key ?? null,
          ts: now,
        });
        const nextCount = this.#pmQueueGuard.bumpNudgeCount(task.task_id);
        if (nextCount >= MAX_DOWNSTREAM_AUTO_NUDGES) {
          this.#pmQueueGuard.markDownstreamWorkerFailed(task.task_id);
          void persistWorkerReceiptFailed(root, task.task_id, "max_nudges_exceeded");
        }
        continue;
      }

      this.#lastNudgeAtByTask.set(task.task_id, now);
      const nextAt = now + this.#debounceMs;
      this.#pmQueueGuard.bumpNudgeCount(task.task_id);
      this.#pmQueueGuard.recordAutoNudge({
        task_id: task.task_id,
        role,
        nudged_at: now,
        next_nudge_at: nextAt,
        session_id: result.session_id ?? null,
      });
      this.#panel?.emit(DOWNSTREAM_AUTO_NUDGE_EVENT, {
        task_id: task.task_id,
        role,
        ok: true,
        session_id: result.session_id ?? null,
        agent_id: result.agent_id ?? null,
        thread_key: task.thread_key ?? null,
        next_nudge_at: nextAt,
        ts: now,
      });
      this.#log.info?.(
        `[DownstreamAutoNudge] nudged ${role} for ${task.task_id} session=${result.session_id ?? "?"}`,
      );
    }

    const anyStillWaiting = await (async () => {
      for (const t of openWorkers) {
        const role = t.recipient.trim().toUpperCase();
        const durable = await resolveWorkerReceiptDurableHints(root, t.task_id);
        const merged = mergeWorkerReceiptSignals(
          {
            nudgeCount: this.#pmQueueGuard.nudgeCountForTask(t.task_id),
            workerFailed: this.#pmQueueGuard.isDownstreamWorkerFailed(t.task_id),
          },
          durable,
        );
        const ev = evaluateWorkerReceiptWaiting({
          tasks,
          reports,
          targetRole: role,
          focusTaskId: t.task_id,
          nudgeCount: merged.nudgeCount,
          workerFailed: merged.workerFailed,
          sessionFailed: merged.sessionFailed,
        });
        if (ev.shouldShowWaiting) return true;
      }
      return false;
    })();
    if (!anyStillWaiting) {
      this.#pmQueueGuard.clearAutoNudge();
      this.#pmQueueGuard.clearWaitingDownstream();
    }
  }
}

export function ledgerHasWorkerReportForTask(
  reports: { task_id?: string; filename: string; sender: string; recipient: string }[],
  taskId: string,
): boolean {
  return reports.some(
    (r) =>
      isWorkerReportToPm(r.filename, r.sender, r.recipient) &&
      r.task_id &&
      taskIdMatchesPrefix(r.task_id, taskId),
  );
}
