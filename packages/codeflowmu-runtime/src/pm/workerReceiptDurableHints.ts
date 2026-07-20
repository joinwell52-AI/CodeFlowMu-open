/**
 * Durable worker receipt hints from runtime-events + persisted failed marks.
 * Survives shell/panel restart (in-memory PmQueueGuard state does not).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { taskIdMatchesPrefix } from "../ledger/reportParenting.ts";
import type { LedgerReportRecord, LedgerTaskRecord } from "../ledger/types.ts";
import { listRuntimeEventLogPaths } from "../logs/runtimeEventLogPaths.ts";
import { pmGovernanceDir } from "./PmGovernancePlanner.ts";
import {
  isRecoverableSessionFailure,
  type SessionEventSummary,
} from "./sessionReceiptReconcile.ts";
import { evaluateWorkerReceiptWaiting } from "./workerReceiptWaiting.ts";

export interface WorkerReceiptDurableHints {
  nudgeCount: number;
  sessionFailed: boolean;
  workerFailedPersisted: boolean;
  lastSessionStatus: string | null;
  lastSessionId: string | null;
  lastFailureCode: string | null;
  lastFailureCategory: string | null;
  isFirstTurnAbort: boolean;
  sessionUnsettled: boolean;
  recoverable: boolean;
  summary: SessionEventSummary;
}

export interface DownstreamReceiptStateFile {
  version: "1.0.0";
  updated_at: string;
  failed_tasks: Record<
    string,
    { task_id: string; reason: string; marked_at: string }
  >;
}

export function downstreamReceiptStatePath(projectRoot: string): string {
  return join(pmGovernanceDir(projectRoot), "downstream-receipt-state.json");
}

export function emptyDownstreamReceiptState(
  now = new Date().toISOString(),
): DownstreamReceiptStateFile {
  return { version: "1.0.0", updated_at: now, failed_tasks: {} };
}

export async function loadDownstreamReceiptState(
  projectRoot: string,
): Promise<DownstreamReceiptStateFile> {
  const path = downstreamReceiptStatePath(projectRoot);
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as DownstreamReceiptStateFile;
    if (parsed?.version === "1.0.0" && parsed.failed_tasks) return parsed;
  } catch {
    /* fall through */
  }
  return emptyDownstreamReceiptState();
}

export async function persistWorkerReceiptFailed(
  projectRoot: string,
  taskId: string,
  reason: string,
): Promise<void> {
  const norm = taskId.replace(/\.md$/i, "").trim();
  if (!norm) return;
  const state = await loadDownstreamReceiptState(projectRoot);
  state.failed_tasks[norm] = {
    task_id: norm,
    reason,
    marked_at: new Date().toISOString(),
  };
  state.updated_at = new Date().toISOString();
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(pmGovernanceDir(projectRoot), { recursive: true });
  await writeFile(
    downstreamReceiptStatePath(projectRoot),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf-8",
  );
}

async function writeDownstreamReceiptState(
  projectRoot: string,
  state: DownstreamReceiptStateFile,
): Promise<void> {
  state.updated_at = new Date().toISOString();
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(pmGovernanceDir(projectRoot), { recursive: true });
  await writeFile(
    downstreamReceiptStatePath(projectRoot),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf-8",
  );
}

export async function clearWorkerReceiptFailed(
  projectRoot: string,
  taskId: string,
): Promise<boolean> {
  const norm = taskId.replace(/\.md$/i, "").trim();
  if (!norm) return false;
  const state = await loadDownstreamReceiptState(projectRoot);
  let changed = false;
  for (const key of Object.keys(state.failed_tasks)) {
    if (taskIdMatchesPrefix(key, norm)) {
      delete state.failed_tasks[key];
      changed = true;
    }
  }
  if (changed) await writeDownstreamReceiptState(projectRoot, state);
  return changed;
}

/** Drop stale failed_tasks entries that no longer warrant worker_receipt_failed. */
export async function pruneStaleDownstreamReceiptFailures(
  projectRoot: string,
  tasks: LedgerTaskRecord[],
  reports: LedgerReportRecord[],
): Promise<number> {
  const state = await loadDownstreamReceiptState(projectRoot);
  let pruned = 0;

  for (const key of Object.keys(state.failed_tasks)) {
    const worker =
      tasks.find((t) => taskIdMatchesPrefix(t.task_id, key)) ??
      tasks.find((t) => taskIdMatchesPrefix(key, t.task_id));
    if (!worker) {
      delete state.failed_tasks[key];
      pruned += 1;
      continue;
    }
    const role = String(worker.recipient ?? "").trim().toUpperCase();
    const ev = evaluateWorkerReceiptWaiting({
      tasks,
      reports,
      targetRole: role,
      focusTaskId: worker.task_id,
      workerFailed: true,
    });
    if (ev.phase !== "worker_receipt_failed") {
      delete state.failed_tasks[key];
      pruned += 1;
    }
  }

  if (pruned > 0) await writeDownstreamReceiptState(projectRoot, state);
  return pruned;
}

function taskIdFromRecord(rec: Record<string, unknown>): string {
  const payload = (rec.payload ?? {}) as Record<string, unknown>;
  return String(rec.task_id ?? payload.task_id ?? "").trim();
}

function recordMatchesTask(
  rec: Record<string, unknown>,
  taskId: string,
): boolean {
  const tid = taskIdFromRecord(rec);
  if (!tid) return false;
  return taskIdMatchesPrefix(tid, taskId) || taskIdMatchesPrefix(taskId, tid);
}

async function readRuntimeEventRecords(
  projectRoot: string,
): Promise<Record<string, unknown>[]> {
  const paths = listRuntimeEventLogPaths(projectRoot);
  const out: Record<string, unknown>[] = [];
  for (const p of paths) {
    let raw = "";
    try {
      raw = await readFile(p, "utf-8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

/** Scan fcop/logs/runtime for nudge + session failure truth. */
export async function resolveWorkerReceiptDurableHints(
  projectRoot: string,
  taskId: string,
): Promise<WorkerReceiptDurableHints> {
  const norm = taskId.replace(/\.md$/i, "").trim();
  const state = await loadDownstreamReceiptState(projectRoot);
  const workerFailedPersisted = Object.keys(state.failed_tasks).some((k) =>
    taskIdMatchesPrefix(k, norm),
  );

  let nudgeCount = 0;
  let sessionFailed = false;
  let lastSessionStatus: string | null = null;
  let lastSessionEndedMs = 0;
  let lastSessionId: string | null = null;
  let lastFailureCode: string | null = null;
  let lastFailureCategory: string | null = null;
  let isFirstTurnAbort = false;
  let lastStartedAt: string | null = null;
  let lastEndedAt: string | null = null;
  let reportWrittenOnEnd = false;
  const openSessions = new Map<string, { startedAt: string; ts: number }>();

  const records = await readRuntimeEventRecords(projectRoot);
  for (const rec of records) {
    if (!recordMatchesTask(rec, norm)) continue;
    const et = String(rec.event_type ?? "");
    const payload = (rec.payload ?? {}) as Record<string, unknown>;
    const sessionId = String(
      rec.session_id ?? payload.session_id ?? "",
    ).trim();

    if (et === "codeflowmu.downstream_auto_nudge") {
      nudgeCount += 1;
    }

    if (et === "runtime.session_started" && sessionId) {
      const at = String(rec.at ?? payload.started_at ?? "");
      openSessions.set(sessionId, {
        startedAt: at,
        ts: Number(rec.ts ?? 0),
      });
      lastSessionId = sessionId;
      lastStartedAt = at || lastStartedAt;
    }

    if (et === "runtime.session_ended") {
      if (sessionId) openSessions.delete(sessionId);
      const ts = Number(rec.ts ?? 0);
      const st = String(payload.status ?? "").toLowerCase();
      const reportWritten = payload.report_written === true;
      const fc = String(payload.failure_code ?? payload.reason ?? "").trim();
      const failureCategory =
        String(payload.failure_category ?? "").trim() || null;
      const firstTurnAbort =
        payload.is_first_turn_abort === true ||
        failureCategory === "cursor_sdk_first_turn_abort";
      if (ts >= lastSessionEndedMs) {
        lastSessionEndedMs = ts;
        lastSessionStatus = st || null;
        lastSessionId = sessionId || null;
        lastEndedAt = String(rec.at ?? payload.ended_at ?? "") || lastEndedAt;
        lastFailureCode = fc || null;
        lastFailureCategory = failureCategory;
        isFirstTurnAbort = firstTurnAbort;
        reportWrittenOnEnd = reportWritten;
        if ((st === "failed" || st === "timeout") && !reportWritten) {
          sessionFailed = true;
        } else if (reportWritten || st === "completed" || st === "done") {
          sessionFailed = false;
        }
      }
    }

    if (et === "runtime.session_cancelled" && sessionId) {
      openSessions.delete(sessionId);
    }
  }

  const sessionUnsettled = openSessions.size > 0;
  const recoverable =
    sessionUnsettled ||
    (sessionFailed &&
      !reportWrittenOnEnd &&
      isRecoverableSessionFailure(lastFailureCode, lastSessionStatus, {
        failureCategory: lastFailureCategory,
        isFirstTurnAbort,
      }));

  const summary: SessionEventSummary = {
    lastSessionId,
    lastStartedAt,
    lastEndedAt,
    lastSessionStatus,
    lastFailureCode,
    lastFailureCategory,
    isFirstTurnAbort,
    reportWrittenOnEnd,
    sessionUnsettled,
    agentRunning: false,
  };

  return {
    nudgeCount,
    sessionFailed,
    workerFailedPersisted,
    lastSessionStatus,
    lastSessionId,
    lastFailureCode,
    lastFailureCategory,
    isFirstTurnAbort,
    sessionUnsettled,
    recoverable,
    summary,
  };
}

export function mergeWorkerReceiptSignals(
  inMemory: { nudgeCount: number; workerFailed: boolean },
  durable: WorkerReceiptDurableHints,
  extras?: { agentRunning?: boolean },
): {
  nudgeCount: number;
  workerFailed: boolean;
  sessionFailed: boolean;
  sessionUnsettled: boolean;
  recoverable: boolean;
  lastSessionId: string | null;
  lastFailureCode: string | null;
  lastFailureCategory: string | null;
  isFirstTurnAbort: boolean;
  summary: SessionEventSummary;
} {
  const summary: SessionEventSummary = {
    ...durable.summary,
    agentRunning: extras?.agentRunning ?? durable.summary.agentRunning,
  };
  return {
    nudgeCount: Math.max(inMemory.nudgeCount, durable.nudgeCount),
    workerFailed:
      (inMemory.workerFailed || durable.workerFailedPersisted) &&
      !durable.recoverable,
    sessionFailed: durable.sessionFailed,
    sessionUnsettled: durable.sessionUnsettled,
    recoverable: durable.recoverable,
    lastSessionId: durable.lastSessionId,
    lastFailureCode: durable.lastFailureCode,
    lastFailureCategory: durable.lastFailureCategory,
    isFirstTurnAbort: durable.isFirstTurnAbort,
    summary,
  };
}
