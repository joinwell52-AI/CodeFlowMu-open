/**
 * FixedTaskRunner — interval-based task dispatcher.
 *
 * Fires periodic tasks based on wall-clock intervals, completely independent
 * of file-system events (contrast with InboxWatcher).
 *
 * Default rules (constructed by the shell's main.ts):
 *   - health-check      : DISABLED — was every 30 min → OPS via LLM; use
 *                         `fcop/scripts/ops-healthbeat.ps1` for no-LLM patrol
 *   - milestone-commit  : every 3 sprints completed → OPS (triggered externally)
 *   - restart-recovery  : once on start → PM (reads PLAN, resumes progress)
 *
 * Sprint-G (TASK-20260514-968).
 */

import type { Runtime } from "../Runtime.ts";
import type { SessionStartPayload } from "../session/SessionManager.ts";

// ─── public types ────────────────────────────────────────────────────────────

/** A single scheduling rule. */
export interface ScheduleRule {
  /** Unique identifier used as the setInterval key. */
  id: string;
  /** Human-readable description (shown in banner / getSchedule()). */
  description: string;
  /**
   * Interval in milliseconds.
   * Use `0` for "fire once immediately on start" (restart-recovery style).
   * Use `> 0` for repeating intervals.
   */
  intervalMs: number;
  /** Role to dispatch to (e.g. "OPS", "PM"). */
  role: string;
  /** Builds the session payload when the rule fires. */
  buildPayload: () => SessionStartPayload;
  /**
   * Optional guard. If provided and returns false, the rule is skipped
   * this cycle without logging. Useful for milestone rules that need
   * a counter to be at the right value.
   */
  condition?: () => boolean;
}

export interface ScheduleEntry {
  rule: ScheduleRule;
  /** Best estimate of when this rule will fire next. null for immediate rules. */
  nextFireAt: Date | null;
  /** How many times this rule has fired since start. */
  fireCount: number;
}

export interface FixedTaskRunnerLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

// ─── class ───────────────────────────────────────────────────────────────────

export class FixedTaskRunner {
  private readonly _runtime: Runtime;
  private readonly _logger: FixedTaskRunnerLogger;
  private readonly _rules: ScheduleRule[];

  private readonly _handles = new Map<string, ReturnType<typeof setInterval>>();
  private readonly _fireCount = new Map<string, number>();
  private readonly _lastFireAt = new Map<string, Date>();

  private _started = false;

  constructor(runtime: Runtime, rules: ScheduleRule[], logger?: FixedTaskRunnerLogger) {
    this._runtime = runtime;
    this._rules = [...rules];
    this._logger = logger ?? {
      info: (msg) => console.log(msg),
      warn: (msg) => console.warn(msg),
    };
  }

  /** Start all scheduled rules. Idempotent. */
  start(): void {
    if (this._started) return;
    this._started = true;

    for (const rule of this._rules) {
      this._arm(rule);
    }
  }

  /** Stop all intervals. Idempotent. */
  stop(): void {
    this._started = false;
    for (const h of this._handles.values()) {
      clearInterval(h);
    }
    this._handles.clear();
  }

  /** Dynamically add a rule. If already started, the interval is armed immediately. */
  addRule(rule: ScheduleRule): void {
    // De-dup by id
    const existing = this._rules.findIndex((r) => r.id === rule.id);
    if (existing !== -1) {
      this._rules[existing] = rule;
      // Re-arm: clear old interval
      const old = this._handles.get(rule.id);
      if (old !== undefined) {
        clearInterval(old);
        this._handles.delete(rule.id);
      }
    } else {
      this._rules.push(rule);
    }
    if (this._started) {
      this._arm(rule);
    }
  }

  /**
   * Manually trigger a specific rule by id.
   * Useful for milestone-commit which is fired on sprint count increments.
   */
  async triggerRule(ruleId: string): Promise<void> {
    const rule = this._rules.find((r) => r.id === ruleId);
    if (!rule) {
      this._logger.warn(`[FixedTaskRunner] triggerRule: unknown rule "${ruleId}"`);
      return;
    }
    await this._fireRule(rule);
  }

  /** Return current schedule snapshot. */
  getSchedule(): ScheduleEntry[] {
    return this._rules.map((rule) => {
      const last = this._lastFireAt.get(rule.id);
      const nextFireAt =
        rule.intervalMs > 0 && last !== undefined
          ? new Date(last.getTime() + rule.intervalMs)
          : rule.intervalMs > 0
            ? new Date(Date.now() + rule.intervalMs)
            : null;
      return {
        rule,
        nextFireAt,
        fireCount: this._fireCount.get(rule.id) ?? 0,
      };
    });
  }

  // ── private ───────────────────────────────────────────────────────────────

  private _arm(rule: ScheduleRule): void {
    if (rule.intervalMs === 0) {
      // One-shot immediate
      void this._fireRule(rule);
    } else if (rule.intervalMs > 0) {
      const handle = setInterval(() => void this._fireRule(rule), rule.intervalMs);
      this._handles.set(rule.id, handle);
    }
  }

  private async _fireRule(rule: ScheduleRule): Promise<void> {
    if (rule.condition !== undefined && !rule.condition()) return;

    const agents = await this._runtime.registry.list({ role: rule.role });
    const agent = agents[0];
    if (!agent) {
      this._logger.warn(
        `[FixedTaskRunner] no agent for role="${rule.role}" (rule=${rule.id}) — skipping`,
      );
      return;
    }

    const payload = rule.buildPayload();
    const taskId = `FIXED-${rule.id}-${Date.now()}`;

    try {
      await this._runtime.sessionManager.startSession(
        agent.protocol.agent_id,
        taskId,
        payload,
      );
      this._fireCount.set(rule.id, (this._fireCount.get(rule.id) ?? 0) + 1);
      this._lastFireAt.set(rule.id, new Date());
      this._logger.info(
        `[FixedTaskRunner] fired rule "${rule.id}" → agent ${agent.protocol.agent_id}`,
      );
    } catch (err) {
      // Non-fatal: agent may be busy; skip this cycle
      // Transient HTTP/2 errors are logged but don't block the runner
      const errorMsg = (err as Error).message || String(err);
      if (errorMsg.includes('NGHTTP2_ENHANCE_YOUR_CALM') || errorMsg.includes('Stream closed')) {
        this._logger.warn(
          `[FixedTaskRunner] rule "${rule.id}" deferred — transient SDK connection error for agent ${agent.protocol.agent_id}`,
        );
      } else {
        this._logger.warn(
          `[FixedTaskRunner] rule "${rule.id}" skipped — agent ${agent.protocol.agent_id} unavailable`,
        );
      }
    }
  }
}

// ─── default rules factory ───────────────────────────────────────────────────

/**
 * Build the default rule set used by the shell.
 * `sprintCount` is a getter so the milestone-commit rule can check the live
 * value each time without capturing a stale reference.
 */
export function buildDefaultRules(
  getSprintCount: () => number,
): ScheduleRule[] {
  return [
    {
      // mode: fire-and-forget — dispatches OPS task and does NOT wait for a
      // reply report. The OPS agent writes its own REPORT back to PM when done.
      // This rule must never block the scheduler waiting for acknowledgement.
      id: "health-check",
      description: "OPS 健康检查（已禁用 — 改用 ops-healthbeat.ps1，不调 LLM）",
      intervalMs: 30 * 60 * 1_000,
      role: "OPS",
      // Disabled: each fire was a full Cursor Agent session (~500k tokens / 30 min).
      // CursorUsageSyncer / Web Panel recycle / SSE heartbeat do NOT call models.
      condition: () => false,
      buildPayload: () => ({
        text: [
          "# 定时健康检查",
          "",
          "请执行系统健康检查：",
          "- `git status` — 确认工作区干净",
          "- 磁盘空间检查",
          "- 当前进程列表",
          "",
          "完成后写 REPORT-*-OPS-to-PM.md 到 `fcop/reports/` 回执。",
        ].join("\n"),
        context: { source: "FixedTaskRunner.health-check" },
      }),
    },
    {
      id: "milestone-commit",
      description: "里程碑 git commit（每完成 3 个 Sprint 触发一次）",
      intervalMs: 0, // triggered manually via triggerRule()
      role: "OPS",
      // Only fires when sprint count is a nonzero multiple of 3
      condition: () => {
        const n = getSprintCount();
        return n > 0 && n % 3 === 0;
      },
      buildPayload: () => ({
        text: [
          "# 里程碑 Git Commit",
          "",
          `已完成 ${getSprintCount()} 个 Sprint，请执行里程碑提交：`,
          "```",
          "git add -A",
          'git commit -m "chore: milestone commit after sprint completion"',
          "```",
          "",
          "完成后写 REPORT-*-OPS-to-PM.md 到 `fcop/reports/` 回执。",
        ].join("\n"),
        context: { source: "FixedTaskRunner.milestone-commit", sprintCount: getSprintCount() },
      }),
    },
    {
      id: "restart-recovery",
      description: "重启恢复进度（服务启动后立即执行一次）",
      intervalMs: 0, // one-shot on start
      role: "PM",
      condition: () => false, // TEMPORARILY DISABLED due to transient Cursor SDK HTTP/2 errors
      buildPayload: () => ({
        text: [
          "# 重启恢复",
          "",
          "服务刚重启。请读取 `fcop/_lifecycle/inbox/PLAN-*.md`，恢复当前进度并继续推进下一个 PENDING Sprint。",
          "",
          "1. 找到第一个状态为 PENDING 的 Sprint",
          "2. 派发给对应角色",
          "3. 更新 PLAN 文件中的状态",
        ].join("\n"),
        context: { source: "FixedTaskRunner.restart-recovery" },
      }),
    },
  ];
}
