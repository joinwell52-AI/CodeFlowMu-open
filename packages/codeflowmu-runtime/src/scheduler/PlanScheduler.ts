/**
 * PlanScheduler — reads PLAN-*.md files and automatically advances sprints.
 *
 * Responsibilities:
 *   1. Scan planDir for PLAN-*.md on start and periodically.
 *   2. Parse the sprint table from each file.
 *   3. Auto-dispatch the first PENDING sprint when no sprint is RUNNING
 *      by calling runtime.sessionManager.startSession() directly.
 *   4. Timeout detection: estimatedHours × 1.5 → nudge PM role.
 *   5. Expose status / backlog / markSprintDone for external callers.
 *
 * Sprint-G (TASK-20260514-968).
 */

import { promises as fsPromises } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Runtime } from "../Runtime.ts";
import type { SessionStartPayload } from "../session/SessionManager.ts";
import { InvalidAgentStatusError } from "../registry/errors.ts";

// ─── public types ────────────────────────────────────────────────────────────

export type SprintState = "PENDING" | "RUNNING" | "DONE" | "BLOCKED";

export interface SprintItem {
  /** Sprint identifier, e.g. "Sprint-G". */
  id: string;
  /** One-line description extracted from the plan table. */
  description: string;
  /** Role the sprint is dispatched to, e.g. "DEV", "OPS". */
  recipient: string;
  state: SprintState;
  startedAt?: string;
  doneAt?: string;
  /** Estimated hours (default 2). Used for timeout = estimatedHours × 1.5. */
  estimatedHours: number;
}

export interface PlanStatus {
  planFile: string;
  planId: string;
  sprints: SprintItem[];
  currentSprint: SprintItem | null;
}

export interface PlanSchedulerLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface PlanSchedulerOptions {
  runtime: Runtime;
  planDir: string;
  /** Re-scan interval in ms. Default: 60_000. */
  scanIntervalMs?: number;
  /** Default estimated hours per sprint when not specified in the plan. Default: 2. */
  defaultEstimatedHours?: number;
  logger?: PlanSchedulerLogger;
}

// ─── internal ────────────────────────────────────────────────────────────────

interface PlanEntry {
  file: string;
  sprints: SprintItem[];
}

// ─── class ───────────────────────────────────────────────────────────────────

export class PlanScheduler {
  private readonly _runtime: Runtime;
  private readonly _planDir: string;
  private readonly _scanIntervalMs: number;
  private readonly _defaultEstimatedHours: number;
  private readonly _logger: PlanSchedulerLogger;

  private readonly _plans = new Map<string, PlanEntry>();
  /** Maps planId → absolute path of the PLAN-*.md file for status write-back. */
  private readonly _planFiles = new Map<string, string>();
  private readonly _timeoutHandles = new Map<string, ReturnType<typeof setTimeout>>();
  private _scanTimer: ReturnType<typeof setInterval> | null = null;
  private _stopped = false;
  /** Monotonic seq for plan-dispatched synthetic TASK ids (ReviewEngine expects TASK-*). */
  private _planDispatchSeq = 0;

  constructor(opts: PlanSchedulerOptions) {
    this._runtime = opts.runtime;
    this._planDir = opts.planDir;
    this._scanIntervalMs = opts.scanIntervalMs ?? 60_000;
    this._defaultEstimatedHours = opts.defaultEstimatedHours ?? 2;
    this._logger = opts.logger ?? {
      info: (msg) => console.log(msg),
      warn: (msg) => console.warn(msg),
    };
  }

  /** Start scanning and auto-advancing plans. */
  async start(): Promise<void> {
    this._stopped = false;
    await this._scanPlans();
    await this._advanceAll();

    this._scanTimer = setInterval(async () => {
      if (!this._stopped) {
        await this._scanPlans();
        await this._advanceAll();
      }
    }, this._scanIntervalMs);
  }

  /** Stop all timers. Idempotent. */
  stop(): void {
    this._stopped = true;
    if (this._scanTimer !== null) {
      clearInterval(this._scanTimer);
      this._scanTimer = null;
    }
    for (const h of this._timeoutHandles.values()) {
      clearTimeout(h);
    }
    this._timeoutHandles.clear();
  }

  /** Force-advance a specific plan to its next PENDING sprint. */
  async advancePlan(planId: string): Promise<void> {
    await this._advancePlan(planId);
  }

  /** Return current RUNNING sprint across all plans, or null. */
  getCurrentSprint(): SprintItem | null {
    for (const entry of this._plans.values()) {
      const running = entry.sprints.find((s) => s.state === "RUNNING");
      if (running) return running;
    }
    return null;
  }

  /** Mark a sprint as DONE, persist status to the PLAN file, and advance. */
  async markSprintDone(sprintId: string): Promise<void> {
    for (const [planId, entry] of this._plans) {
      const sprint = entry.sprints.find((s) => s.id === sprintId);
      if (sprint) {
        sprint.state = "DONE";
        sprint.doneAt = new Date().toISOString();
        const handle = this._timeoutHandles.get(sprintId);
        if (handle !== undefined) {
          clearTimeout(handle);
          this._timeoutHandles.delete(sprintId);
        }
        this._logger.info(`[PlanScheduler] sprint ${sprintId} marked DONE`);
        // Persist DONE status back to the PLAN file.
        await this._writePlanStatus(planId, sprintId, "✅ DONE");
        await this._advancePlan(planId);
        return;
      }
    }
    this._logger.warn(`[PlanScheduler] markSprintDone: unknown sprint "${sprintId}"`);
  }

  /** Mark a sprint as BLOCKED and persist to the PLAN file. */
  markSprintBlocked(sprintId: string, reason: string): void {
    for (const [planId, entry] of this._plans) {
      const sprint = entry.sprints.find((s) => s.id === sprintId);
      if (sprint) {
        sprint.state = "BLOCKED";
        const handle = this._timeoutHandles.get(sprintId);
        if (handle !== undefined) {
          clearTimeout(handle);
          this._timeoutHandles.delete(sprintId);
        }
        this._logger.warn(`[PlanScheduler] sprint ${sprintId} BLOCKED: ${reason}`);
        // Persist BLOCKED status back to the PLAN file (fire-and-forget).
        void this._writePlanStatus(planId, sprintId, "BLOCKED");
        return;
      }
    }
  }

  /** All PENDING sprints across all plans. */
  getBacklog(): SprintItem[] {
    const backlog: SprintItem[] = [];
    for (const entry of this._plans.values()) {
      backlog.push(...entry.sprints.filter((s) => s.state === "PENDING"));
    }
    return backlog;
  }

  /** Full status snapshot of all plans. */
  getStatus(): PlanStatus[] {
    return Array.from(this._plans.entries()).map(([planId, entry]) => ({
      planFile: entry.file,
      planId,
      sprints: entry.sprints,
      currentSprint: entry.sprints.find((s) => s.state === "RUNNING") ?? null,
    }));
  }

  // ── private ───────────────────────────────────────────────────────────────

  private async _scanPlans(): Promise<void> {
    if (!existsSync(this._planDir)) return;
    let files: string[];
    try {
      files = await fsPromises.readdir(this._planDir);
    } catch {
      return;
    }
    const planFiles = files.filter((f) => /^PLAN-.*\.md$/.test(f));
    for (const file of planFiles) {
      const filepath = join(this._planDir, file);
      const planId = _planIdFromFilename(file);
      if (!this._plans.has(planId)) {
        const sprints = await this._parsePlanFile(filepath);
        this._plans.set(planId, { file: filepath, sprints });
        this._planFiles.set(planId, filepath);
        this._logger.info(
          `[PlanScheduler] loaded plan ${planId} (${sprints.length} sprints)`,
        );
      }
    }
  }

  private async _parsePlanFile(filepath: string): Promise<SprintItem[]> {
    let content: string;
    try {
      content = await fsPromises.readFile(filepath, "utf-8");
    } catch {
      return [];
    }

    const sprints: SprintItem[] = [];
    const lines = content.split("\n");
    let inTable = false;
    let headerParsed = false;

    let idxId = 0;
    let idxDesc = 1;
    let idxRecipient = 2;
    let idxStatus = 3;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("|")) {
        inTable = false;
        headerParsed = false;
        continue;
      }

      const cells = trimmed
        .split("|")
        .map((c) => c.trim())
        .slice(1, -1);

      if (cells.length < 3) continue;

      // Header row: contains "Sprint" or "sprint"
      if (!inTable && cells.some((c) => /sprint/i.test(c))) {
        inTable = true;
        headerParsed = false;
        cells.forEach((c, i) => {
          const lower = c.toLowerCase();
          if (/^sprint|^id/.test(lower)) idxId = i;
          else if (/描述|desc/.test(lower)) idxDesc = i;
          else if (/接收|recipient|接收方/.test(lower)) idxRecipient = i;
          else if (/状态|status/.test(lower)) idxStatus = i;
        });
        headerParsed = true;
        continue;
      }

      // Separator row
      if (cells.every((c) => /^[-: ]+$/.test(c))) continue;
      if (!inTable || !headerParsed) continue;

      const rawId = _stripMd(cells[idxId] ?? "");
      const desc = _stripMd(cells[idxDesc] ?? "");
      const recipient = _stripMd(cells[idxRecipient] ?? "DEV").trim() || "DEV";
      const statusRaw = _stripMd(cells[idxStatus] ?? "").toUpperCase().trim();

      let state: SprintState = "PENDING";
      if (statusRaw.includes("DONE")) state = "DONE";
      else if (statusRaw.includes("RUNNING")) state = "RUNNING";
      else if (statusRaw.includes("BLOCKED")) state = "BLOCKED";

      if (rawId) {
        sprints.push({
          id: rawId,
          description: desc,
          recipient,
          state,
          estimatedHours: this._defaultEstimatedHours,
        });
      }
    }

    return sprints;
  }

  private async _advanceAll(): Promise<void> {
    for (const planId of this._plans.keys()) {
      await this._advancePlan(planId);
    }
  }

  private async _advancePlan(planId: string): Promise<void> {
    if (this._stopped) return;
    const entry = this._plans.get(planId);
    if (!entry) return;
    if (entry.sprints.some((s) => s.state === "RUNNING")) return;
    const next = entry.sprints.find((s) => s.state === "PENDING");
    if (!next) {
      const allDone = entry.sprints.every(
        (s) => s.state === "DONE" || s.state === "BLOCKED",
      );
      if (allDone) {
        this._logger.info(`[PlanScheduler] plan ${planId} — all sprints complete`);
      }
      return;
    }
    await this._dispatchSprint(planId, next);
  }

  private async _dispatchSprint(planId: string, sprint: SprintItem): Promise<void> {
    const agents = await this._runtime.registry.list({ role: sprint.recipient });
    const agent = agents[0];
    if (!agent) {
      this._logger.warn(
        `[PlanScheduler] no agent for role="${sprint.recipient}", sprint=${sprint.id} stays PENDING`,
      );
      return;
    }

    sprint.state = "RUNNING";
    sprint.startedAt = new Date().toISOString();

    const taskId = this._makePlanSyntheticTaskId(sprint.recipient);
    const payload: SessionStartPayload = {
      text: [
        `# Plan Sprint: ${sprint.id}`,
        "",
        sprint.description,
        "",
        `**Plan ID**: ${planId}`,
        "",
        `完成后请写 REPORT 到 \`fcop/reports/\` 回执。`,
      ].join("\n"),
      context: {
        planId,
        sprintId: sprint.id,
        source: "PlanScheduler",
      },
    };

    try {
      await this._runtime.sessionManager.startSession(
        agent.protocol.agent_id,
        taskId,
        payload,
      );
      this._logger.info(
        `[PlanScheduler] dispatched sprint ${sprint.id} → agent ${agent.protocol.agent_id}`,
      );
    } catch (err) {
      sprint.state = "PENDING";
      sprint.startedAt = undefined;
      if (err instanceof InvalidAgentStatusError) {
        this._logger.warn(
          `[PlanScheduler] agent ${agent.protocol.agent_id} busy, sprint ${sprint.id} stays PENDING`,
        );
      } else {
        this._logger.warn(
          `[PlanScheduler] dispatch failed for sprint ${sprint.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return;
    }

    // Timeout detection
    const timeoutMs = sprint.estimatedHours * 1.5 * 60 * 60 * 1000;
    const handle = setTimeout(() => {
      if (sprint.state === "RUNNING") {
        void this._nudgePm(planId, sprint);
      }
    }, timeoutMs);
    this._timeoutHandles.set(sprint.id, handle);
  }

  /**
   * Build a TASK-shaped id so ReviewEngine / TaskParser invariants accept
   * plan-dispatched sessions (legacy `PLAN-*` ids were rejected downstream).
   */
  private _makePlanSyntheticTaskId(recipient: string): string {
    const d = new Date();
    const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    this._planDispatchSeq += 1;
    const seq = String(this._planDispatchSeq % 1000).padStart(3, "0");
    return `TASK-${dateStr}-${seq}-PM-to-${recipient}`;
  }

  /**
   * Rewrite the status column for a given sprint inside its PLAN-*.md file.
   * Replaces PENDING / RUNNING / 🔄 RUNNING with the provided `status` string.
   * Best-effort: any I/O error is swallowed so the scheduler never crashes.
   */
  private async _writePlanStatus(
    planId: string,
    sprintId: string,
    status: "✅ DONE" | "BLOCKED",
  ): Promise<void> {
    const entry = this._plans.get(planId);
    if (!entry) return;
    try {
      let content = await fsPromises.readFile(entry.file, "utf-8");
      // Match a table row that has `sprintId` in the first cell and replace
      // the status cell (PENDING / RUNNING / 🔄 RUNNING).
      content = content.replace(
        new RegExp(
          `(\\|\\s*${_escapeRegex(sprintId)}\\s*\\|[^|]+\\|[^|]+\\|)\\s*(?:PENDING|RUNNING|🔄\\s*RUNNING)\\s*(\\|)`,
          "g",
        ),
        `$1 ${status} $2`,
      );
      await fsPromises.writeFile(entry.file, content, "utf-8");
      this._logger.info(
        `[PlanScheduler] wrote ${status} for sprint ${sprintId} → ${entry.file}`,
      );
    } catch {
      // Best-effort — don't crash the scheduler if the file is unwritable.
    }
  }

  private async _nudgePm(_planId: string, sprint: SprintItem): Promise<void> {
    this._logger.warn(`[PlanScheduler] sprint ${sprint.id} timeout — nudging PM`);
    const pmAgents = await this._runtime.registry.list({ role: "PM" });
    const pm = pmAgents[0];
    if (!pm) return;

    const taskId = this._makePlanSyntheticTaskId("PM");
    const payload: SessionStartPayload = {
      text: [
        `# Sprint 超时提醒`,
        "",
        `Sprint **${sprint.id}** (${sprint.description}) 已超过预估工时 × 1.5，`,
        `当前状态仍为 RUNNING。`,
        "",
        `请检查进度并决策是否标记为 BLOCKED。`,
      ].join("\n"),
      context: { sprintId: sprint.id, source: "PlanScheduler.timeout" },
    };

    try {
      await this._runtime.sessionManager.startSession(pm.protocol.agent_id, taskId, payload);
    } catch {
      // Non-fatal: PM may itself be busy
    }
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function _planIdFromFilename(filename: string): string {
  return filename.replace(/^PLAN-/, "").replace(/\.md$/, "");
}

/** Escape a string for safe use inside `new RegExp(...)`. */
function _escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strip common markdown decorators and emoji from a table cell string. */
function _stripMd(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/✅|⬜|🔴|🟡|🟢/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}
