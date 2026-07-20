/**
 * ReportDispatcher — turns a ReportEvent (report from worker to PM) into
 * a new PM-01 session that consolidates results and reports to ADMIN.
 *
 * v0.3.1 — Added mailbox queue to handle simultaneous reports from multiple
 * workers (DEV + OPS + QA all finishing at once). Previously the second and
 * third reports were silently dropped with InvalidAgentStatusError when PM
 * was busy. Now they wait in a FIFO queue and are drained automatically when
 * PM finishes each session.
 *
 * Queue design:
 *   - `handle(evt)` always enqueues. Drain is attempted immediately.
 *   - Drain starts one PM session per settled thread batch, not per report.
 *   - `_drain()` is called: (a) on every handle(), (b) on every
 *     runtime.session_ended / runtime.session_cancelled event whose
 *     agent_id starts with the PM role prefix.
 *   - A single `_draining` guard prevents concurrent drains.
 *   - Max queue depth: MAX_QUEUE (default 50). Oldest items are dropped
 *     when the queue is full to avoid unbounded memory growth.
 */

import type { AgentRegistry } from "../registry/AgentRegistry.ts";
import type { SessionManager } from "../session/SessionManager.ts";
import type { ReportEvent } from "./ReportWatcher.ts";
import type { LifecycleGovernor } from "./LifecycleGovernor.ts";
import { shouldIgnoreCoordinationWatchPath } from "../_internal/report-ephemeral.ts";
import { isGovernanceReportToPm } from "../fcop/governance.ts";
import {
  TransientSdkDelayedError,
} from "../_internal/transient-sdk-error.ts";
import {
  sdkCooldownRegistry,
  SdkCooldownActiveError,
} from "../_internal/SdkCooldownRegistry.ts";
import { formatPmBuiltinSkillsPlaybookBlock } from "../pm/PmSkillManifest.ts";
import type { PmQueueGuard } from "./PmQueueGuard.ts";

const MAX_QUEUE = 50;

export interface ReportDispatcherOpts {
  registry: AgentRegistry;
  sessionManager: SessionManager;
  /** FCoP v3 inbox — fcop/_lifecycle/inbox/ */
  fcopTasksDir?: string;
  /** fcop/reports/ */
  fcopReportsDir?: string;
  /** Async TASK inbox/active → review when a worker REPORT arrives. */
  lifecycleGovernor?: LifecycleGovernor;
  /** PM queue busy guard — releases stale/failed drain states. */
  pmQueueGuard?: PmQueueGuard;
  logger?: {
    info?(msg: string): void;
    warn?(msg: string): void;
    error?(msg: string): void;
  };
}

export class ReportDispatcher {
  private readonly _registry: AgentRegistry;
  private readonly _session: SessionManager;
  private readonly _fcopTasksDir: string | undefined;
  private readonly _fcopReportsDir: string | undefined;
  private readonly _lifecycleGovernor: LifecycleGovernor | undefined;
  private readonly _pmQueueGuard: PmQueueGuard | undefined;
  private readonly _log: NonNullable<ReportDispatcherOpts["logger"]>;

  /** FIFO mailbox — reports waiting for PM to become idle. */
  private readonly _queue: ReportEvent[] = [];
  /** Reports received while PM session is running — drained into _queue on session end. */
  private readonly _nextBatch: ReportEvent[] = [];
  /** Parallel metadata array for monitoring (filename + queuedAt timestamp). */
  private readonly _queueMeta: Array<{ filename: string; senderRole: string; queuedAt: number }> = [];
  private readonly _nextBatchMeta: Array<{ filename: string; senderRole: string; queuedAt: number }> = [];
  /** Prevents concurrent drains racing each other. */
  private _draining = false;

  constructor(opts: ReportDispatcherOpts) {
    this._registry = opts.registry;
    this._session = opts.sessionManager;
    this._fcopTasksDir = opts.fcopTasksDir;
    this._fcopReportsDir = opts.fcopReportsDir;
    this._lifecycleGovernor = opts.lifecycleGovernor;
    this._pmQueueGuard = opts.pmQueueGuard;
    this._log = opts.logger ?? {};

    // When any PM session ends, automatically drain the queue.
    this._session.onEvent((event) => {
      if (
        event.event_type === "runtime.session_ended" ||
        event.event_type === "runtime.session_cancelled"
      ) {
        // Only react to PM agent sessions ending.
        if (event.agent_id && /^PM/i.test(event.agent_id)) {
          this._setPmRunning(
            false,
            event.event_type === "runtime.session_cancelled"
              ? "session_cancelled"
              : "session_ended",
          );
          this._mergeNextBatchIntoQueue();
          // Small delay so AgentStatusReconciler can flip status→idle first.
          setTimeout(() => void this._drain(), 300);
        }
      }
    });
  }

  /** Read-only snapshot of the current queue (for monitoring/UI). */
  queueSnapshot(): ReadonlyArray<{ filename: string; senderRole: string; queuedAt: number }> {
    return [...this._queueMeta, ...this._nextBatchMeta];
  }

  isPmRunning(): boolean {
    return this._pmQueueGuard?.snapshot().processing ?? false;
  }

  private _setPmRunning(
    running: boolean,
    reason:
      | "session_started"
      | "session_ended"
      | "session_cancelled"
      | "start_failed",
  ): void {
    if (running) {
      this._pmQueueGuard?.acquire(`report_dispatcher:${reason}`);
    } else {
      const releaseReason =
        reason === "session_cancelled"
          ? "session_cancelled"
          : reason === "start_failed"
            ? "start_failed"
            : "session_ended";
      this._pmQueueGuard?.release(releaseReason);
    }
  }

  private _isDuplicateQueued(filename: string): boolean {
    return (
      this._queue.some((q) => q.filename === filename) ||
      this._nextBatch.some((q) => q.filename === filename)
    );
  }

  private _mergeNextBatchIntoQueue(): void {
    if (this._nextBatch.length === 0) return;
    for (const evt of this._nextBatch) {
      if (!this._queue.some((q) => q.filename === evt.filename)) {
        this._queue.push(evt);
      }
    }
    for (const meta of this._nextBatchMeta) {
      if (!this._queueMeta.some((m) => m.filename === meta.filename)) {
        this._queueMeta.push(meta);
      }
    }
    this._nextBatch.length = 0;
    this._nextBatchMeta.length = 0;
  }

  private _enqueueReport(evt: ReportEvent): void {
    const targetQueue = this.isPmRunning() ? this._nextBatch : this._queue;
    const targetMeta = this.isPmRunning() ? this._nextBatchMeta : this._queueMeta;
    if (targetQueue.length >= MAX_QUEUE) {
      const dropped = targetQueue.shift()!;
      targetMeta.shift();
      this._log.warn?.(
        `[ReportDispatcher] queue full (${MAX_QUEUE}); dropped oldest: ${dropped.filename}`,
      );
    }
    targetQueue.push(evt);
    targetMeta.push({
      filename: evt.filename,
      senderRole: evt.senderRole,
      queuedAt: Date.now(),
    });
  }

  /** Enqueue a report and immediately attempt to drain. */
  async handle(evt: ReportEvent): Promise<void> {
    if (shouldIgnoreCoordinationWatchPath(evt.filepath)) {
      this._log.info?.(
        `[ReportDispatcher] ignore ephemeral report path: ${evt.filename}`,
      );
      return;
    }
    if (isGovernanceReportToPm(evt.filename, evt.senderRole)) {
      this._log.info?.(
        `[ReportDispatcher] skip governance report (not for PM): ${evt.filename}`,
      );
      return;
    }
    if (this._isDuplicateQueued(evt.filename)) {
      this._log.info?.(
        `[ReportDispatcher] skip duplicate queued report: ${evt.filename}`,
      );
      return;
    }
    this._enqueueReport(evt);
    if (/^(DEV|OPS|QA)$/i.test(evt.senderRole)) {
      this._pmQueueGuard?.clearWaitingDownstream();
      this._pmQueueGuard?.clearAutoNudge();
    }
    this._lifecycleGovernor?.scheduleTaskToReviewOnReport(evt.filepath);
    const depth = this._queue.length + this._nextBatch.length;
    this._log.info?.(
      `[ReportDispatcher] queued ${evt.filename} (queue depth: ${depth}${this.isPmRunning() ? ", PM running → next batch" : ""})`,
    );
    await this._drain();
  }

  /** Process as many queued reports as PM can accept right now. */
  private async _drain(): Promise<void> {
    if (this._draining) return;
    if (sdkCooldownRegistry.active) {
      const depth = this._queue.length + this._nextBatch.length;
      this._log.info?.(
        `[ReportDispatcher] SDK cooldown active; ${depth} report(s) queued only`,
      );
      return;
    }
    if (this.isPmRunning()) {
      return;
    }
    this._draining = true;
    try {
      while (this._queue.length > 0) {
        const agents = await this._registry.list({ role: "PM" });
        const pm = agents.find((a) => a.protocol.status === "idle");
        if (!pm) {
          // PM is busy or not found — stop draining; will retry on next session_ended.
          const busy = agents[0];
          if (busy) {
            this._log.info?.(
              `[ReportDispatcher] PM-01 busy (${busy.protocol.status}); ` +
                `${this._queue.length} report(s) queued, will retry when idle`,
            );
          } else {
            this._log.warn?.(`[ReportDispatcher] no PM agent registered`);
          }
          break;
        }

        const batch = this._takeNextThreadBatch();
        const evt = batch[0];
        if (!evt) break;
        const pmId = pm.protocol.agent_id;
        const batchKey = _batchKey(batch);
        const taskId = `consolidate-${batchKey}-${Date.now()}`;
        const payload = {
          text: _buildConsolidationPrompt(batch, this._fcopTasksDir, this._fcopReportsDir),
          context: {
            task_filepath: evt.filepath,
            task_filename: batch.map((b) => b.filename).join(","),
            frontmatter: {
              sender: [...new Set(batch.map((b) => b.senderRole))].join(","),
              recipient: "PM",
              thread_key: _threadKeyForEvent(evt),
              batch_size: batch.length,
            },
          },
        };

        try {
          await this._session.startSession(pmId, taskId, payload);
          this._setPmRunning(true, "session_started");
          this._log.info?.(
            `[ReportDispatcher] PM-01 batch session started for ${batch.length} report(s) ` +
              `(${this._queue.length} pending, ${this._nextBatch.length} next batch)`,
          );
          // PM is now running — stop loop; next item will be handled after session ends.
          break;
        } catch (err: unknown) {
          if (err instanceof SdkCooldownActiveError) {
            this._log.warn?.(
              `[ReportDispatcher] SDK cooldown for batch ${batchKey}: ${err.message} — re-queuing`,
            );
            this._requeueBatchFront(batch);
            const delay = Math.max(0, sdkCooldownRegistry.untilMs - Date.now());
            setTimeout(() => void this._drain(), delay || 5_000);
            break;
          }
          if (err instanceof TransientSdkDelayedError) {
            this._log.warn?.(
              `[ReportDispatcher] transient SDK delayed for batch ${batchKey}: ${err.message} — re-queuing`,
            );
            this._requeueBatchFront(batch);
            setTimeout(() => void this._drain(), 15_000);
            break;
          }
          this._log.error?.(
            `[ReportDispatcher] startSession failed for batch ${batchKey}: ${String(err)} — re-queuing`,
          );
          this._requeueBatchFront(batch);
          this._setPmRunning(false, "start_failed");
          break;
        }
      }
    } finally {
      this._draining = false;
    }
  }

  private _takeNextThreadBatch(): ReportEvent[] {
    const first = this._queue[0];
    if (!first) return [];
    const threadKey = _threadKeyForEvent(first);
    const batch: ReportEvent[] = [];
    const keepQueue: ReportEvent[] = [];
    const keepMeta: Array<{ filename: string; senderRole: string; queuedAt: number }> = [];

    for (let i = 0; i < this._queue.length; i++) {
      const evt = this._queue[i]!;
      const meta = this._queueMeta[i]!;
      if (_threadKeyForEvent(evt) === threadKey) {
        batch.push(evt);
      } else {
        keepQueue.push(evt);
        keepMeta.push(meta);
      }
    }

    this._queue.length = 0;
    this._queue.push(...keepQueue);
    this._queueMeta.length = 0;
    this._queueMeta.push(...keepMeta);
    return batch;
  }

  private _requeueBatchFront(batch: ReportEvent[]): void {
    const now = Date.now();
    this._queue.unshift(...batch);
    this._queueMeta.unshift(
      ...batch.map((evt) => ({
        filename: evt.filename,
        senderRole: evt.senderRole,
        queuedAt: now,
      })),
    );
  }
}

function _buildConsolidationPrompt(
  batch: ReportEvent[],
  fcopTasksDir?: string,
  fcopReportsDir?: string,
): string {
  const tasksDir = fcopTasksDir ?? "fcop/_lifecycle/inbox";
  const reportsDir = fcopReportsDir ?? "fcop/reports";
  const threadKey = batch[0] ? _threadKeyForEvent(batch[0]) : "unknown";
  const reportList = batch
    .map((evt, idx) => {
      const reportId = evt.filename.replace(/\.md$/i, "");
      const guessedTaskId = _extractTaskIdFromReport(evt.content);
      return `## Incoming report ${idx + 1}
**From**: ${evt.senderRole} | **File**: ${evt.filename}
**Report ID**: ${reportId}
**Guessed task_id**: ${guessedTaskId ?? "(not found in body; infer from content)"}

${evt.content}`;
    })
    .join("\n\n---\n\n");

  return `\
You are **PM-01**. This is a REPORT-intake doorbell session (downstream -> PM).

## Batch
**Thread key**: ${threadKey}
**Report count**: ${batch.length}

${reportList}

---

## Goal
Process this report strictly under FCoP Rule 6 and PM governance flow:
1) Validate callback quality and evidence.
2) Interpret the actual result and decide the next PM-owned transition.
3) If ready, close to ADMIN with a single PM summary report; otherwise create only the new task justified by this report.

## Must-do checklist (in order)
1. Read \`fcop/ledger/views/PM.todo.md\` first.
2. Run \`pm.review_check\` against this report (\`task_id\` or \`report_id\`).
3. If all required downstream reports are settled, run \`pm.close_admin_task\` draft.
4. Use MCP \`write_report\` to land PM->ADMIN summary when closure conditions are met.

## Guardrails
- This session is **report intake**. PM is the sole coordination hub: workers receive PM TASKs and return REPORTs to PM.
- Do not hard-code a role sequence. Read the REPORT, then decide whether the next new TASK belongs to DEV, QA, OPS, another role, or nobody.
- A QA REPORT may have \`status=done\` and product verdict FAIL. That means the QA work is complete and can settle; the product root remains open. Create a new PM->DEV correction TASK only when the evidence identifies corrective work, referencing the QA task, QA REPORT, and root task. Decide separately whether a later QA retest task is needed.
- A dependency that is merely pending is not a failure. Do not create rework, ISSUE, or blocked summary for "not ready yet"; leave it queued for Runtime release.
- Never overwrite or reuse an old worker TASK/REPORT. Every iteration is a new TASK and every handoff returns to PM.
- Call \`write_task\` only for an explicit next action supported by the incoming REPORT.
- **Do not** shell/IDE move lifecycle files directly.
- Prefer evidence from ledger + report files; avoid speculative conclusions.
- Output should be minimal and auditable.

## PM builtin skills (must follow)
${formatPmBuiltinSkillsPlaybookBlock()}

## Output target
- Task inbox reference: \`${tasksDir}\`
- Worker report source dir: \`${reportsDir}\`
- If closure is achieved: one PM->ADMIN \`write_report\`
- If a terminal blocker must be escalated: one PM->ADMIN \`write_report(status=blocked)\`
- Otherwise: **do not call write_report**. Return a concise session conclusion only; Runtime already persists report-intake and patrol decisions in the PM governance journal.`;
}

function _threadKeyForEvent(evt: ReportEvent): string {
  return _extractScalarField(evt.content, "thread_key") ?? "unknown";
}

function _batchKey(batch: ReportEvent[]): string {
  const threadKey = batch[0] ? _threadKeyForEvent(batch[0]) : "unknown";
  return threadKey.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function _extractTaskIdFromReport(content: string): string | null {
  return _extractScalarField(content, "task_id") ?? _extractScalarField(content, "re");
}

function _extractScalarField(content: string, field: string): string | null {
  const re = new RegExp(`(?:^|\\n)\\s*${field}\\s*:\\s*([^\\n\\r]+)`, "i");
  const hit = re.exec(content);
  if (hit?.[1]) return hit[1].trim().replace(/^["']|["']$/g, "");
  return null;
}

