/**
 * ReviewEngine — v0.1 review main loop.
 *
 * Subscribes to `SessionManager.onEvent` and orchestrates the full
 * task → reviewer → verdict → REVIEW-*.md → state_history pipeline,
 * with `NeedsHumanGate` as the structured fallback for parse / agent
 * lookup failures.
 *
 * Scope (TASK-20260509-022 §主交付 3, lines 140-159):
 *
 *   1. session ended (subject) → resolve task_ref via sessionStore
 *      (sessionStore.load(sessionId).protocol.task_id — the
 *      session_ended event payload deliberately does NOT include task_id
 *      per Phase B SessionManager contract)
 *   2. policy.shouldReview(taskRef)
 *        false → state_history `from: ended → review_skipped` and exit
 *        true  → step 3
 *   3. policy.pickReviewer(taskRef) → reviewerRole; registry.list
 *      filter for that role
 *        not found → state_history `from: ended → reviewer_not_found`
 *                  + NeedsHumanGate.push (fallback) and exit
 *        found     → step 4
 *   4. SessionManager.startSession(reviewerAgentId, reviewSubtaskId, payload)
 *      — payload carries the subject task_id + body excerpt, so the
 *      reviewer can produce a verdict.
 *   5. As reviewer streams `sdk.assistant` events, accumulate text;
 *      when the reviewer session_ended fires, parse the accumulated
 *      text against the v0.1 contract:
 *        `VERDICT: <decision>; [RATIONALE: <text>]`
 *      Parse failure → decision=needs_human + trigger_reason=verdict_parse_failed
 *   6. ReviewWriter.write(verdict, body) → REVIEW-*.md
 *   7. If decision === "needs_human" → NeedsHumanGate.push() + stamp
 *      human_approval into the verdict before persistence.
 *   8. Append `from: review_pending → review_<decision>` to original
 *      task's state_history.
 *
 * Two important subtleties:
 *
 *   - The engine MUST distinguish "subject session" (the original
 *     task being executed, whose end triggers a review) from "reviewer
 *     session" (the review subtask itself, whose end produces the
 *     verdict). They both fire `runtime.session_ended`. We track
 *     a per-session map; reviewer sessions DO NOT recurse into a new
 *     review (avoiding the v0.1 chokidar-loop trap from TASK-022 line 151).
 *
 *   - We do NOT replace `TaskDispatcher`'s state_history append for
 *     `dispatched → ended`. ReviewEngine's appends are downstream of
 *     that — they begin with `from: ended` (or `from: review_pending`)
 *     after the dispatcher has already recorded the natural settle.
 *     This keeps Phase C semantics intact.
 *
 *   - Synthetic subject ids minted outside the inbox TASK envelope contract
 *     (`PlanScheduler` PLAN-*, `FixedTaskRunner` FIXED-*, …) are skipped:
 *     there is no `inbox/<task_id>.md` subject file and no compatible
 *     `defaultMakeReviewId` / REVIEW-*.md mint path.
 *
 * Reference:
 *   - design doc §3.4 + §0.9.4
 *   - TASK-20260509-022 §主交付 3
 *   - REPORT-20260509-018 §五决策 B' (rationale for AgentStatusReconciler companion)
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  ReviewerNotFoundError,
  ReviewWriteError,
  VerdictParseError,
} from "../registry/errors.ts";
import type { AgentRegistry } from "../registry/AgentRegistry.ts";
import type {
  SessionManager,
  SessionStartPayload,
} from "../session/SessionManager.ts";
import type { SessionStore } from "../session/SessionStore.ts";
import type { RuntimeEvent, Unsubscribe } from "../types/state.ts";
import type { StateHistoryWriter } from "../scheduler/StateHistoryWriter.ts";
import { NeedsHumanGate, type HumanPushRequest } from "./NeedsHumanGate.ts";
import {
  ReviewWriter,
  type HumanApproval,
  type ReviewDecision,
  type ReviewVerdict,
} from "./ReviewWriter.ts";
import {
  type ReviewDecisionPolicy,
  renderReviewDecisionPolicyPromptBlock,
} from "./ReviewDecisionPolicyLoader.ts";

// ───────────────────────────────────────────────────────────────────────────
// Public types
// ───────────────────────────────────────────────────────────────────────────

/**
 * Slim reference to a Task that the policy receives. Carries enough info
 * to make policy decisions (skip vs. who-to-pick) without the full
 * Task body — keeps policies cheap and easy to plant in tests.
 */
export interface TaskReference {
  task_id: string;
  agent_id: string;
  /** May be `null` for tasks that ended before reaching a settled status. */
  status: "completed" | "failed" | "cancelled" | "running" | null;
}

/**
 * Strategy interface for the review main loop. v0.1 ships
 * `DefaultReviewPolicy`; production deployments override.
 */
export interface ReviewPolicy {
  /** True if this task should trigger a review. v0.1 default = always true. */
  shouldReview(taskRef: TaskReference): boolean;
  /**
   * Role name (e.g. `"REVIEW"`) the engine should look up in the
   * registry. Returning `null` means "no reviewer" — engine appends
   * `review_skipped` (alternate path to shouldReview=false; useful when
   * policy wants to record why it's skipping).
   */
  pickReviewer(taskRef: TaskReference): string | null;
}

/** Default policy: review everything, always pick `"REVIEW"`. */
export class DefaultReviewPolicy implements ReviewPolicy {
  shouldReview(_taskRef: TaskReference): boolean {
    return true;
  }
  pickReviewer(_taskRef: TaskReference): string | null {
    return "REVIEW";
  }
}

export interface ReviewEngineLogger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

export interface ReviewEngineOptions {
  sessionManager: SessionManager;
  registry: AgentRegistry;
  sessionStore: SessionStore;
  historyWriter: StateHistoryWriter;
  reviewWriter: ReviewWriter;
  needsHumanGate: NeedsHumanGate;
  /**
   * Where the original Task files live, so the engine can append
   * state_history to `<inboxDir>/<task_id>.md`. Mirrors `Runtime.create`
   * `opts.inboxDir`.
   */
  inboxDir: string;
  policy?: ReviewPolicy;
  logger?: ReviewEngineLogger;
  /** Wall clock — tests inject. */
  now?: () => Date;
  /** Test seam: synthesize the review_id for a task. Defaults to
   * `${REVIEWER}-on-${task_id}` with the reviewer role uppercased. */
  makeReviewId?: (
    reviewerRole: string,
    taskRef: TaskReference,
  ) => string;
  /**
   * Optional team review decision policy. When provided, the policy block
   * is injected into the REVIEW agent prompt (task doc §8.3).
   * Production wires this via `loadReviewDecisionPolicy()`;
   * tests can inject a pre-built policy object directly.
   */
  reviewDecisionPolicy?: ReviewDecisionPolicy | (() => Promise<ReviewDecisionPolicy>);
}

// ───────────────────────────────────────────────────────────────────────────
// Internal session tracking
// ───────────────────────────────────────────────────────────────────────────

interface SubjectContext {
  kind: "subject";
  task_id: string;
  task_filepath: string;
}

interface ReviewerContext {
  kind: "reviewer";
  /** Of the underlying subject (the task being reviewed). */
  subject_task_id: string;
  /** Of the underlying subject (used to append history). */
  subject_filepath: string;
  /** Pre-allocated review_id (we mint it before the reviewer session starts). */
  review_id: string;
  reviewer_role: string;
  reviewer_agent_id: string;
  /** Accumulated `sdk.assistant` text for the v0.1 verdict-parsing path. */
  buffer: string;
  /** Wall-clock at `startSession` time, used to compute `decision_duration_ms`. */
  started_at: Date;
}

type SessionContext = SubjectContext | ReviewerContext;

// ───────────────────────────────────────────────────────────────────────────
// ReviewEngine
// ───────────────────────────────────────────────────────────────────────────

/**
 * v0.1 verdict line regex. Loose on whitespace, strict on the leading
 * keyword + decision enum. Examples that match:
 *
 *   `VERDICT: approved; RATIONALE: looks good`
 *   `VERDICT: needs_changes`
 *   `verdict: REJECTED ; rationale: see comment`
 *
 * Capture groups:
 *   1: decision (case-insensitive — normalized to lowercase by parser)
 *   2: rationale (optional)
 */
const VERDICT_REGEX =
  /VERDICT\s*:\s*(approved|rejected|needs_changes|abstained|needs_human)\s*(?:;\s*RATIONALE\s*:\s*([\s\S]*?))?(?:\n|$)/i;

const REVIEW_DECISIONS: readonly ReviewDecision[] = [
  "approved",
  "rejected",
  "needs_changes",
  "abstained",
  "needs_human",
];

export class ReviewEngine {
  private readonly _sessionManager: SessionManager;
  private readonly _registry: AgentRegistry;
  private readonly _sessionStore: SessionStore;
  private readonly _historyWriter: StateHistoryWriter;
  private readonly _reviewWriter: ReviewWriter;
  private readonly _needsHumanGate: NeedsHumanGate;
  private readonly _inboxDir: string;
  private readonly _policy: ReviewPolicy;
  private readonly _logger: ReviewEngineLogger;
  private readonly _now: () => Date;
  private readonly _makeReviewId: (
    reviewerRole: string,
    taskRef: TaskReference,
  ) => string;
  private readonly _reviewDecisionPolicy:
    | ReviewDecisionPolicy
    | (() => Promise<ReviewDecisionPolicy>)
    | undefined;

  private _unsubscribe: Unsubscribe | null = null;
  private _started = false;

  /** session_id → context for sessions the engine cares about. */
  private readonly _contexts = new Map<string, SessionContext>();

  /**
   * Reviewer-session events that arrived BEFORE the engine could finish
   * `_contexts.set` (race: SessionManager.startSession returns AFTER an
   * `await sessionStore.save` macrotask, during which InMemoryRunHandle's
   * `setImmediate` auto-drive may already have fanned `sdk.assistant`
   * (and even `runtime.session_ended` on fast paths) through to the
   * `onEvent` listeners). Keyed by session_id; flushed when the matching
   * context is registered.
   */
  private readonly _orphanEvents = new Map<
    string,
    { buffer: string; ended?: RuntimeEvent }
  >();

  /**
   * In-flight review pipelines (kept awaitable for tests). Keyed by
   * subject_task_id so duplicates can be detected. Each promise resolves
   * to the produced filepath of the REVIEW-*.md file (or `null` if the
   * pipeline ended without writing — e.g. `review_skipped`).
   */
  private readonly _inflight = new Set<Promise<string | null>>();
  /**
   * task_id strings the engine is currently treating as REVIEWER subtasks.
   * Used to recognize a `session_ended` on the reviewer side even when the
   * `_contexts` map has not been populated yet (race-defense).
   */
  private readonly _pendingReviewerTaskIds = new Set<string>();

  constructor(opts: ReviewEngineOptions) {
    this._sessionManager = opts.sessionManager;
    this._registry = opts.registry;
    this._sessionStore = opts.sessionStore;
    this._historyWriter = opts.historyWriter;
    this._reviewWriter = opts.reviewWriter;
    this._needsHumanGate = opts.needsHumanGate;
    this._inboxDir = opts.inboxDir;
    this._policy = opts.policy ?? new DefaultReviewPolicy();
    this._logger = opts.logger ?? {
      info: (m, ...a) => console.log(m, ...a),
      warn: (m, ...a) => console.warn(m, ...a),
      error: (m, ...a) => console.error(m, ...a),
    };
    this._now = opts.now ?? (() => new Date());
    this._makeReviewId = opts.makeReviewId ?? defaultMakeReviewId;
    this._reviewDecisionPolicy = opts.reviewDecisionPolicy;
  }

  /** Resolve the review decision policy — called once per review pipeline. */
  private async _resolvePolicy(): Promise<ReviewDecisionPolicy | null> {
    if (!this._reviewDecisionPolicy) return null;
    if (typeof this._reviewDecisionPolicy === "function") {
      try {
        return await this._reviewDecisionPolicy();
      } catch (err) {
        this._logger.warn(
          `[ReviewEngine] failed to load review decision policy: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return null;
      }
    }
    return this._reviewDecisionPolicy;
  }

  start(): void {
    if (this._started) {
      throw new Error("ReviewEngine.start() already called");
    }
    this._started = true;
    this._unsubscribe = this._sessionManager.onEvent((event) =>
      this._onEvent(event),
    );
  }

  async stop(): Promise<void> {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    this._started = false;
    if (this._inflight.size > 0) {
      await Promise.allSettled([...this._inflight]);
    }
    this._contexts.clear();
    this._orphanEvents.clear();
    this._pendingReviewerTaskIds.clear();
  }

  /**
   * Test/diagnostic helper — wait for any in-flight review pipelines to
   * settle. Used by integration tests so they can observe the produced
   * REVIEW-*.md without polling.
   *
   * Subtlety: `_reviewSubjectSession` returns *as soon as* it has fired
   * `startSession` for the reviewer agent — it does NOT await the
   * reviewer's eventual `session_ended` (that would require parking the
   * promise on every dispatched review). So when the subject promise
   * resolves and leaves `_inflight`, the reviewer's `_finalizeReview`
   * promise has not yet been registered. We therefore loop until all
   * three "pending review work" indicators are clear:
   *
   *   - `_inflight` is the explicit set of subject + finalize promises
   *   - `_contexts` holds reviewer sessions that we've started but
   *     haven't finalized yet
   *   - `_pendingReviewerTaskIds` is set the moment we decide to start
   *     a reviewer session (covers the brief window between subject
   *     pipeline returning and the reviewer's session_ended landing).
   *
   * This lets tests reliably `await whenSettled()` after firing a
   * subject session_ended, without having to count `sdk.calls.send`
   * by hand.
   */
  async whenSettled(): Promise<void> {
    // Loop until every signal of pending review work clears. The poll
    // sleep yields to the macrotask queue so InMemoryRunHandle's
    // setImmediate-scheduled emits can land.
    // Cap at ~5s so a stuck reviewer (test bug) fails loudly via
    // surrounding test timeout rather than hanging forever.
    const deadline = Date.now() + 5_000;
    while (
      this._inflight.size > 0 ||
      this._contexts.size > 0 ||
      this._pendingReviewerTaskIds.size > 0
    ) {
      if (Date.now() > deadline) {
        throw new Error(
          `[ReviewEngine.whenSettled] timed out after 5s; ` +
            `inflight=${this._inflight.size}, ` +
            `contexts=${this._contexts.size}, ` +
            `pending=${this._pendingReviewerTaskIds.size}`,
        );
      }
      if (this._inflight.size > 0) {
        await Promise.allSettled([...this._inflight]);
      } else {
        // Yield to the macrotask queue so reviewer events can land.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  // ── private ──────────────────────────────────────────────────────────

  private _onEvent(event: RuntimeEvent): void {
    // Reviewer-session text accumulation. If the context is not yet
    // registered (race with startSession's await chain), buffer to
    // `_orphanEvents` and flush when the context lands.
    if (event.event_type === "sdk.assistant") {
      const text = extractText(event.payload);
      if (!text) return;
      const ctx = this._contexts.get(event.session_id);
      if (ctx?.kind === "reviewer") {
        ctx.buffer += text + "\n";
      } else {
        const slot = this._orphanEvents.get(event.session_id) ?? { buffer: "" };
        slot.buffer += text + "\n";
        this._orphanEvents.set(event.session_id, slot);
      }
      return;
    }

    if (
      event.event_type !== "runtime.session_ended" &&
      event.event_type !== "runtime.session_cancelled"
    ) {
      return;
    }

    const ctx = this._contexts.get(event.session_id);
    if (ctx?.kind === "reviewer") {
      // Reviewer session terminated → produce the verdict.
      this._contexts.delete(event.session_id);
      this._pendingReviewerTaskIds.delete(ctx.review_id);
      this._orphanEvents.delete(event.session_id);
      const work = this._finalizeReview(ctx, event).catch((err) => {
        this._logger.error(
          `[ReviewEngine] finalize failed for review_id="${ctx.review_id}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return null;
      });
      this._inflight.add(work);
      void work.finally(() => this._inflight.delete(work));
      return;
    }

    // Race-defense: this might be a reviewer session_ended that arrived
    // before `_reviewSubjectSession` finished setting the context. Look
    // it up via `_pendingReviewerTaskIds` (we know reviewer task_id =
    // reviewSubtaskId = review_id; the SessionManager session_started
    // payload carries `task_id`, but ended does not — so we stash the
    // event and let the subject pipeline pick it up).
    if (this._isMaybePendingReviewerSession(event.session_id)) {
      const slot = this._orphanEvents.get(event.session_id) ?? { buffer: "" };
      slot.ended = event;
      this._orphanEvents.set(event.session_id, slot);
      return;
    }

    // Otherwise the session is a SUBJECT session — kick off a review.
    // We don't pre-register subject contexts (we'd have to subscribe to
    // session_started); we resolve the task_id lazily here from the
    // sessionStore. That avoids racing the dispatcher's own session
    // registration for the same session_id.
    const work = this._reviewSubjectSession(event)
      .catch((err) => {
        this._logger.error(
          `[ReviewEngine] subject review failed for session_id="${
            event.session_id
          }": ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      });
    this._inflight.add(work);
    void work.finally(() => this._inflight.delete(work));
  }

  /**
   * Heuristic: a session_ended event might belong to a reviewer session
   * the engine is in the middle of registering. Returns true if the
   * orphan-events map has the session keyed (means we already buffered
   * sdk.assistant chatter for it). This is a best-effort guard — the
   * real authoritative recovery happens in `_reviewSubjectSession` when
   * it finishes registering the context and finds the orphan ended event.
   */
  private _isMaybePendingReviewerSession(sessionId: string): boolean {
    if (this._orphanEvents.has(sessionId)) return true;
    return false;
  }

  /** Resolve a canonical session task id to its physical routed envelope. */
  private async _resolveSubjectTaskId(taskId: string): Promise<string | null> {
    try {
      const names = await readdir(this._inboxDir);
      const exact = `${taskId}.md`;
      if (names.includes(exact)) return taskId;
      const prefix = `${taskId}-`.toUpperCase();
      const routed = names
        .filter(
          (name) =>
            name.toUpperCase().startsWith(prefix) && /\.md$/i.test(name),
        )
        .sort((a, b) => a.localeCompare(b, "en"))[0];
      return routed ? routed.replace(/\.md$/i, "") : null;
    } catch {
      return null;
    }
  }

  private async _reviewSubjectSession(
    event: RuntimeEvent,
  ): Promise<string | null> {
    // Step 1: resolve task_id via sessionStore.
    const sessionRecord = await this._sessionStore.load(event.session_id);
    if (!sessionRecord) {
      this._logger.warn(
        `[ReviewEngine] session_id="${event.session_id}" not found in store; ` +
          `cannot resolve task_id (race or already cleaned up).`,
      );
      return null;
    }
    const storedTaskId = sessionRecord.protocol.task_id;
    if (!storedTaskId) {
      this._logger.warn(
        `[ReviewEngine] session_id="${event.session_id}" has no task_id; skipping review.`,
      );
      return null;
    }
    if (!REVIEW_ELIGIBLE_TASK_ID_RE.test(storedTaskId)) {
      return null;
    }
    const taskId = await this._resolveSubjectTaskId(storedTaskId);
    if (!taskId) return null;
    const subjectFilepath = join(this._inboxDir, `${taskId}.md`);

    const taskRef: TaskReference = {
      task_id: taskId,
      agent_id: sessionRecord.protocol.agent_id,
      status:
        (sessionRecord.protocol.status as TaskReference["status"]) ?? null,
    };

    // Step 2: shouldReview gate.
    if (!this._policy.shouldReview(taskRef)) {
      await this._safeAppend(subjectFilepath, {
        at: this._now().toISOString(),
        by: "review-engine",
        from: "ended",
        to: "review_skipped",
        note: `reason=policy.shouldReview=false`,
      });
      return null;
    }

    // Step 3: pickReviewer.
    const reviewerRole = this._policy.pickReviewer(taskRef);
    if (!reviewerRole) {
      await this._safeAppend(subjectFilepath, {
        at: this._now().toISOString(),
        by: "review-engine",
        from: "ended",
        to: "review_skipped",
        note: `reason=policy.pickReviewer=null`,
      });
      return null;
    }

    // Step 4: resolve reviewer agent.
    const candidates = await this._registry.list({ role: reviewerRole });
    const reviewer = candidates[0];
    if (!reviewer) {
      // Fallback: state_history + NeedsHumanGate (so the audit trail
      // explicitly captures the missing reviewer).
      const error = new ReviewerNotFoundError(reviewerRole, taskId);
      this._logger.warn(`[ReviewEngine] ${error.message}`);
      await this._safeAppend(subjectFilepath, {
        at: this._now().toISOString(),
        by: "review-engine",
        from: "ended",
        to: "reviewer_not_found",
        note: `reviewer_role=${reviewerRole}`,
      });
      const reviewId = this._makeReviewId(reviewerRole, taskRef);
      await this._fallbackToHumanGate({
        reviewId,
        taskRef,
        subjectFilepath,
        reviewerRole,
        triggerReason: "reviewer_not_found",
        rationale: error.message,
      });
      return null;
    }

    // Step 5: pre-allocate review_id and start the reviewer session.
    const reviewId = this._makeReviewId(reviewerRole, taskRef);

    // Mark `from: ended → review_pending` BEFORE we start the reviewer
    // session — so even if startSession crashes, the audit trail shows
    // that the engine got far enough to attempt a review.
    await this._safeAppend(subjectFilepath, {
      at: this._now().toISOString(),
      by: "review-engine",
      from: "ended",
      to: "review_pending",
      note: `review_id=${reviewId}, reviewer_role=${reviewerRole}, reviewer_agent=${reviewer.protocol.agent_id}`,
    });

    const reviewSubtaskId = reviewId;

    // Inject team review decision policy into the reviewer prompt (task doc §8.3).
    const decisionPolicy = await this._resolvePolicy();
    const policyBlock = decisionPolicy
      ? renderReviewDecisionPolicyPromptBlock(decisionPolicy)
      : "";

    const reviewerPayload: SessionStartPayload = {
      text:
        `Review the following task and emit a verdict line.\n\n` +
        `subject_task_id: ${taskId}\n` +
        `subject_agent: ${taskRef.agent_id}\n` +
        `subject_status: ${taskRef.status ?? "unknown"}\n\n` +
        policyBlock +
        `Required verdict line format:\n` +
        `  VERDICT: <approved|rejected|needs_changes|abstained|needs_human>; ` +
        `RATIONALE: <one-line rationale>\n`,
      context: {
        review_id: reviewId,
        subject_task_id: taskId,
        subject_filepath: subjectFilepath,
      },
    };

    // Mark BEFORE startSession so a reviewer session_ended that races us
    // here can be recognized as belonging to a reviewer session via the
    // orphan path (see `_isMaybePendingReviewerSession`).
    this._pendingReviewerTaskIds.add(reviewId);

    let reviewerSessionId: string;
    try {
      const handle = await this._sessionManager.startSession(
        reviewer.protocol.agent_id,
        reviewSubtaskId,
        reviewerPayload,
      );
      reviewerSessionId = handle.session_id;
    } catch (err) {
      this._pendingReviewerTaskIds.delete(reviewId);
      // Reviewer agent is busy or otherwise refused — fallback to human.
      this._logger.warn(
        `[ReviewEngine] startSession on reviewer="${reviewer.protocol.agent_id}" ` +
          `failed for review_id="${reviewId}": ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
      await this._fallbackToHumanGate({
        reviewId,
        taskRef,
        subjectFilepath,
        reviewerRole,
        triggerReason: "reviewer_start_failed",
        rationale: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    // Step 6: register the reviewer-session context. Drain any orphan
    // events (sdk.assistant text or even an early session_ended) that
    // arrived during the await chain above.
    const ctx: ReviewerContext = {
      kind: "reviewer",
      subject_task_id: taskId,
      subject_filepath: subjectFilepath,
      review_id: reviewId,
      reviewer_role: reviewerRole,
      reviewer_agent_id: reviewer.protocol.agent_id,
      buffer: "",
      started_at: this._now(),
    };
    const orphan = this._orphanEvents.get(reviewerSessionId);
    if (orphan) {
      ctx.buffer = orphan.buffer;
      this._orphanEvents.delete(reviewerSessionId);
    }
    this._contexts.set(reviewerSessionId, ctx);

    // If the reviewer ended event already came in, finalize immediately.
    if (orphan?.ended) {
      this._contexts.delete(reviewerSessionId);
      this._pendingReviewerTaskIds.delete(reviewId);
      const finalize = this._finalizeReview(ctx, orphan.ended).catch((err) => {
        this._logger.error(
          `[ReviewEngine] finalize failed for review_id="${reviewId}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return null;
      });
      this._inflight.add(finalize);
      void finalize.finally(() => this._inflight.delete(finalize));
    }

    return null; // Subject pipeline doesn't write a REVIEW directly.
  }

  private async _finalizeReview(
    ctx: ReviewerContext,
    endEvent: RuntimeEvent,
  ): Promise<string | null> {
    const decidedAt = this._now();
    const durationMs = decidedAt.getTime() - ctx.started_at.getTime();

    let decision: ReviewDecision;
    let rationale: string | undefined;
    let parseError: VerdictParseError | undefined;
    try {
      const parsed = parseVerdict(ctx.buffer, ctx.subject_task_id);
      decision = parsed.decision;
      if (parsed.rationale !== undefined) rationale = parsed.rationale;
    } catch (err) {
      if (err instanceof VerdictParseError) {
        parseError = err;
        decision = "needs_human";
        rationale = `(verdict parse failed) ${err.message}`;
      } else {
        throw err;
      }
    }

    if (endEvent.event_type === "runtime.session_cancelled") {
      // Reviewer session was cancelled → treat as needs_human.
      decision = "needs_human";
      rationale = "(reviewer session cancelled before producing a verdict)";
    }

    let humanApproval: HumanApproval | undefined;
    if (decision === "needs_human") {
      const triggerReason =
        parseError !== undefined
          ? "verdict_parse_failed"
          : endEvent.event_type === "runtime.session_cancelled"
            ? "reviewer_cancelled"
            : "reviewer_decided_needs_human";

      // Parse matched_rules from RATIONALE when REVIEW agent decided needs_human.
      // Expected format: "...matched_rules=[rule_id1,rule_id2];..."
      let matchedRules: string[] | undefined;
      const humanRequestType: "risk_approval" | "fallback_to_human" =
        triggerReason === "reviewer_decided_needs_human"
          ? "risk_approval"
          : "fallback_to_human";
      if (triggerReason === "reviewer_decided_needs_human" && rationale) {
        const m = rationale.match(/matched_rules=\[([^\]]+)\]/);
        if (m?.[1]) {
          matchedRules = m[1]
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }
      }

      const pushReq: HumanPushRequest = {
        review_id: ctx.review_id,
        task_id: ctx.subject_task_id,
        reviewer_role: ctx.reviewer_role,
        trigger_reason: triggerReason,
        human_request_type: humanRequestType,
        ...(matchedRules !== undefined ? { matched_rules: matchedRules } : {}),
        ...(rationale !== undefined ? { rationale } : {}),
      };
      humanApproval = await this._needsHumanGate.push(pushReq);
    }

    // For decision="needs_changes" v0.1 we synthesize a placeholder
    // required_changes from the rationale. The reviewer is supposed to
    // emit a richer message (v0.2 will swap to direct REVIEW-*.md
    // authorship); for v0.1 we ensure schema validity.
    let requiredChanges: string | undefined;
    if (decision === "needs_changes") {
      requiredChanges = rationale ?? "(no rationale supplied)";
    }

    const verdict: ReviewVerdict = {
      review_id: ctx.review_id,
      subject_type: "task",
      subject_ref: ctx.subject_task_id,
      reviewer_role: ctx.reviewer_role,
      reviewer_agent: ctx.reviewer_agent_id,
      decision,
      ...(rationale !== undefined ? { rationale } : {}),
      ...(requiredChanges !== undefined
        ? { required_changes: requiredChanges }
        : {}),
      ...(humanApproval !== undefined ? { human_approval: humanApproval } : {}),
      decided_at: decidedAt.toISOString(),
      decision_duration_ms: durationMs,
    };

    const body = renderVerdictBody(verdict, ctx.buffer.trim());

    let filepath: string | null = null;
    try {
      filepath = await this._reviewWriter.write(verdict, body);
    } catch (err) {
      if (err instanceof ReviewWriteError) {
        this._logger.error(
          `[ReviewEngine] ReviewWriter failed for review_id="${ctx.review_id}": ${err.message}`,
        );
      } else {
        throw err;
      }
    }

    // Append final state_history transition to the SUBJECT task.
    await this._safeAppend(ctx.subject_filepath, {
      at: decidedAt.toISOString(),
      by: "review-engine",
      from: "review_pending",
      to: `review_${decision}`,
      note:
        `review_id=${ctx.review_id}` +
        (filepath ? `, review_file=${filepath}` : ", review_file=(write_failed)"),
    });

    return filepath;
  }

  private async _fallbackToHumanGate(opts: {
    reviewId: string;
    taskRef: TaskReference;
    subjectFilepath: string;
    reviewerRole: string;
    triggerReason: string;
    rationale: string;
  }): Promise<void> {
    const decidedAt = this._now();
    const humanApproval = await this._needsHumanGate.push({
      review_id: opts.reviewId,
      task_id: opts.taskRef.task_id,
      reviewer_role: opts.reviewerRole,
      trigger_reason: opts.triggerReason,
      human_request_type: "fallback_to_human",
      matched_rules: [],
      rationale: opts.rationale,
    });

    const verdict: ReviewVerdict = {
      review_id: opts.reviewId,
      subject_type: "task",
      subject_ref: opts.taskRef.task_id,
      reviewer_role: opts.reviewerRole,
      reviewer_agent: null,
      decision: "needs_human",
      rationale: opts.rationale,
      human_approval: humanApproval,
      decided_at: decidedAt.toISOString(),
    };
    const body = renderVerdictBody(verdict, opts.rationale);

    let filepath: string | null = null;
    try {
      filepath = await this._reviewWriter.write(verdict, body);
    } catch (err) {
      if (err instanceof ReviewWriteError) {
        this._logger.error(
          `[ReviewEngine] fallback ReviewWriter failed for review_id="${opts.reviewId}": ${err.message}`,
        );
      } else {
        throw err;
      }
    }

    await this._safeAppend(opts.subjectFilepath, {
      at: decidedAt.toISOString(),
      by: "review-engine",
      from: "ended",
      to: "review_needs_human",
      note:
        `review_id=${opts.reviewId}, trigger=${opts.triggerReason}` +
        (filepath ? `, review_file=${filepath}` : ", review_file=(write_failed)"),
    });
  }

  private async _safeAppend(
    filepath: string,
    entry: import("../scheduler/StateHistoryWriter.ts").StateHistoryEntry,
  ): Promise<void> {
    try {
      await this._historyWriter.append(filepath, entry);
    } catch (err) {
      this._logger.warn(
        `[ReviewEngine] state_history append failed for "${filepath}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers — exported for unit testing.
// ───────────────────────────────────────────────────────────────────────────

/**
 * TASK ids eligible for inbox-backed review + `defaultMakeReviewId` minting
 * (`TASK-YYYYMMDD-NNN-...`). Anything else (e.g. `PlanScheduler` PLAN-*)
 * must not enter the review pipeline.
 */
export const REVIEW_ELIGIBLE_TASK_ID_RE = /^TASK-(\d{8})-(\d{3})/;

/**
 * Default `review_id` minter. Format:
 *   `REVIEW-{date}-{seq}-{REVIEWER}-on-{task_id}`
 * where {date} and {seq} are extracted from the task_id pattern
 * (`TASK-YYYYMMDD-NNN-...`). Throws if the pattern does not match.
 *
 * Result must satisfy review.schema.json `review_id.pattern`:
 *   `^REVIEW-\d{8}-\d{3,}-[A-Z]+-on-TASK-\d{8}-\d{3,}.*$`
 */
export function defaultMakeReviewId(
  reviewerRole: string,
  taskRef: TaskReference,
): string {
  const taskMatch = taskRef.task_id.match(REVIEW_ELIGIBLE_TASK_ID_RE);
  const date = taskMatch?.[1] ?? "";
  const seq = taskMatch?.[2] ?? "";
  if (!date || !seq) {
    throw new Error(
      `defaultMakeReviewId: task_id="${taskRef.task_id}" does not match TASK-YYYYMMDD-NNN-... pattern`,
    );
  }
  const role = reviewerRole.toUpperCase().replace(/[^A-Z]/g, "");
  if (!role) {
    throw new Error(
      `defaultMakeReviewId: reviewerRole="${reviewerRole}" did not yield ` +
        `any A-Z chars for the review_id`,
    );
  }
  return `REVIEW-${date}-${seq}-${role}-on-${taskRef.task_id}`;
}

/**
 * Parse the v0.1 verdict contract from accumulated reviewer text.
 * Throws `VerdictParseError` if no matching line is found.
 */
export function parseVerdict(
  buffer: string,
  subjectRef: string,
): { decision: ReviewDecision; rationale?: string } {
  const match = buffer.match(VERDICT_REGEX);
  if (!match || !match[1]) {
    throw new VerdictParseError(subjectRef, buffer);
  }
  const decision = match[1].toLowerCase() as ReviewDecision;
  if (!REVIEW_DECISIONS.includes(decision)) {
    throw new VerdictParseError(
      subjectRef,
      buffer,
      `decision="${match[1]}" is not in the allowlist`,
    );
  }
  const rationale = match[2]?.trim();
  return rationale ? { decision, rationale } : { decision };
}

/**
 * Try to extract human-readable text from an `sdk.assistant` event payload.
 *
 * Probe order (first match wins):
 *   1. `payload.text`                       (InMemoryRunHandle test fixture
 *                                            style — flat string)
 *   2. `payload.raw.text`                   (SDKThinkingMessage / SDKTaskMessage
 *                                            style — direct `text: string`)
 *   3. `payload.raw.message.text`           (defensive: hypothetical alternate
 *                                            SDK shape with flat string —
 *                                            currently unused by SDK 0.x but
 *                                            kept for forward-compat)
 *   4. `payload.raw.message.content[]`      (REAL SDKAssistantMessage shape;
 *                                            see node_modules/@cursor/sdk/
 *                                            dist/cjs/messages.d.ts:
 *                                              SDKAssistantMessage.message.content
 *                                              = Array<TextBlock | ToolUseBlock>
 *                                            where TextBlock = {type: "text",
 *                                            text: string} and ToolUseBlock =
 *                                            {type: "tool_use", ...}.
 *                                            We concatenate every TextBlock.text
 *                                            and skip ToolUseBlock entirely.
 *
 *                                            BUG-SDK-004 fix (TASK-013 /
 *                                            REPORT-013): without this branch,
 *                                            the ReviewEngine reviewer-buffer
 *                                            stays empty even when the LLM
 *                                            streamed a full verdict, causing
 *                                            `verdict_parse_failed` →
 *                                            decision=needs_human on every
 *                                            real-SDK review.)
 *
 * Returns `null` when the payload yields no extractable text — the caller
 * (`_onEvent`) treats that as "not interesting" and silently drops the
 * event. Tool-use blocks correctly produce `null` here because the
 * reviewer's verdict text never lives inside a tool_use block.
 */
function extractText(payload: unknown): string | null {
  if (payload === null || payload === undefined) return null;
  if (typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p["text"] === "string") return p["text"];
  const raw = p["raw"];
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (typeof r["text"] === "string") return r["text"];
    const message = r["message"];
    if (message && typeof message === "object") {
      const m = message as Record<string, unknown>;
      if (typeof m["text"] === "string") return m["text"];
      // Probe 4 — SDKAssistantMessage real shape: message.content[] array.
      const content = m["content"];
      if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
          if (block && typeof block === "object") {
            const b = block as Record<string, unknown>;
            if (b["type"] === "text" && typeof b["text"] === "string") {
              parts.push(b["text"] as string);
            }
            // ToolUseBlock and any unknown block types fall through;
            // we deliberately do NOT stringify tool args into the
            // reviewer buffer (would pollute parseVerdict).
          }
        }
        if (parts.length > 0) {
          return parts.join("");
        }
      }
    }
  }
  return null;
}

/** Render the markdown body of a REVIEW-*.md file. */
function renderVerdictBody(verdict: ReviewVerdict, rawText: string): string {
  const lines: string[] = [
    `# Review: ${verdict.review_id}`,
    "",
    `Decision: **${verdict.decision}**`,
  ];
  if (verdict.rationale) {
    lines.push("", "## Rationale", "", verdict.rationale);
  }
  if (verdict.required_changes !== undefined) {
    lines.push(
      "",
      "## Required changes",
      "",
      Array.isArray(verdict.required_changes)
        ? verdict.required_changes.map((c) => `- ${c}`).join("\n")
        : `- ${verdict.required_changes}`,
    );
  }
  if (verdict.human_approval) {
    lines.push(
      "",
      "## Human approval",
      "",
      `pushed_to=${verdict.human_approval.pushed_to}`,
      `pushed_at=${verdict.human_approval.pushed_at}`,
      `trigger_reason=${verdict.human_approval.trigger_reason}`,
    );
  }
  if (rawText) {
    lines.push("", "## Reviewer raw output", "", "```", rawText, "```");
  }
  return lines.join("\n");
}
