/**
 * NeedsHumanGate — the v0.1 fallback when a `decision === "needs_human"`
 * verdict needs to leave the runtime and go to a human.
 *
 * Scope (TASK-20260509-022 §主交付 2):
 *
 * - v0.1 sink = `"cli"` only. The gate prints a single structured line
 *   to the configured `logger.info` so any tail-following operator (or
 *   the `codeflowmu-shell` daemon's stderr → log file) sees it.
 * - v0.2 will replace the sink with a `MobilePushAdapter` (out of scope
 *   here per TASK-022 §不做 line 238 + design doc §0.9.3 第 4 屏 +
 *   §0.9.4). The constructor signature already accepts `sink: "mobile"`
 *   to lock in the surface — but v0.1 throws if asked to push to mobile
 *   so a regression PR can't accidentally ship a half-implemented push.
 * - The returned `HumanApproval` is a STUB: only `pushed_to + pushed_at +
 *   trigger_reason` are populated (the `additionalProperties: false` schema
 *   for `human_approval` accepts these three plus `approved_by` /
 *   `approved_at`, which v0.1 leaves as `null` until a real human ack
 *   lands via Mobile in v0.2+).
 *
 * Why a stub at all (instead of "wait for ack"):
 *
 * - v0.1's `ReviewEngine` settles synchronously at session_ended time —
 *   blocking on a real human is what v0.2 Mobile push is for. The stub
 *   gives the audit trail a complete `human_approval` block that says
 *   "we pushed; nobody approved yet", which is the truth at v0.1 stage.
 * - The schema's `additionalProperties: false` on `human_approval` means
 *   we MUST NOT invent extra fields here.
 *
 * Reference:
 *   - design doc §0.9.4 high-risk red lines
 *   - design doc §0.9.3 (Mobile Audit screen — v0.2)
 *   - review.schema.json#properties.human_approval
 *   - TASK-20260509-022 §主交付 2
 */

import {
  FcopClientError,
  type FcopProjectClient,
  type HumanApprovalChannel,
  type HumanApprovalDecision,
} from "../_external/fcop-client.ts";
import type { HumanApproval } from "./ReviewWriter.ts";

/**
 * What the engine pushes through the gate when a verdict requires a human.
 * Carries enough context that `ReviewWriter` can fill in `human_approval`
 * fields AND the future Mobile push notification can render a meaningful
 * "approve this" screen.
 */
export interface HumanPushRequest {
  /** Pattern: `^REVIEW-\d{8}-\d{3,}-...$`. */
  review_id: string;
  /** The Task this review belongs to (for cross-link in the Mobile UI). */
  task_id: string;
  /** Reviewer role that produced the original verdict. */
  reviewer_role: string;
  /**
   * Why human approval was triggered. Free-form short string. Examples:
   *   - "high_risk_skill_invocation"
   *   - "review_board_consensus_failed"
   *   - "verdict_parse_failed"
   *   - "reviewer_not_found"
   */
  trigger_reason: string;
  /** Optional rationale forwarded from the reviewer (for context). */
  rationale?: string;
  /**
   * Team rule IDs matched by the REVIEW agent (task doc §9.1).
   * Only present when `human_request_type === "risk_approval"`.
   * Empty array for fallback_to_human.
   */
  matched_rules?: string[];
  /**
   * Distinguishes the two categories of human approval (task doc §3):
   *   - "risk_approval"    — REVIEW agent triggered by an enabled team rule
   *   - "fallback_to_human" — Runtime fallback (reviewer not found, etc.)
   */
  human_request_type?: "risk_approval" | "fallback_to_human";
}

export interface NeedsHumanGateLogger {
  info: (msg: string, ...args: unknown[]) => void;
}

export interface NeedsHumanGateOptions {
  /**
   * v0.1 strict allowlist = `"cli"`. Construction with `"mobile"` throws
   * eagerly so a future regression can't ship a half-implemented push.
   *
   * v0.2 will widen this: `"mobile"` will route through MobilePushAdapter
   * (a stable interface defined in §10.3 of the design doc).
   */
  sink?: "cli" | "mobile";
  /** Defaults to `console`. */
  logger?: NeedsHumanGateLogger;
  /** Wall clock — tests inject. */
  now?: () => Date;
  /**
   * P4 sprint Day 3 (TASK-20260511-011 §3.1.2) — optional fcop bridge
   * for audit-trail writeback.
   *
   * `push()` is unchanged when this is set or unset — v0.1 push is still
   * a non-blocking stub that returns immediately with
   * `approved_by/approved_at = null`. The fcop wire-up is only used by
   * the new `markApproved()` method: when a real human ack arrives (v0.2
   * Mobile or v0.5 ack-after-push), upstream code calls
   * `gate.markApproved(reviewId, spec)` which forwards to
   * `fcopClient.markHumanApproved()` and lands the audit block onto the
   * REVIEW file's front-matter.
   *
   * v0.1 / v0.3-without-fcopClient mode: `markApproved()` is a degraded
   * stub that only returns the in-memory approval block (no fcop audit).
   * Same shape so callers don't branch.
   */
  fcopClient?: FcopProjectClient;
}

/**
 * Spec for `NeedsHumanGate.markApproved()`. Mirrors fcop's
 * `mark_human_approved()` kwargs (DEV-005 §S4 实证 + Day 3 reconnaissance).
 *
 * The set of fields is a strict subset of fcop's signature — v0.3 doesn't
 * surface `device_id` / `ip` / `auth_method` yet (those land with Mobile
 * v0.2 + auth v0.5). Optional `pushed_at` / `trigger_reason` mirror v0.1
 * stub semantics for the returned `HumanApproval` shape.
 */
export interface HumanApprovedSpec {
  approver: string;
  decision: HumanApprovalDecision;
  channel: HumanApprovalChannel;
  comment?: string;
  /**
   * Carried from the original `push()` so the returned `HumanApproval`
   * round-trips the full v0.1 stub shape (caller sees the same
   * `trigger_reason` as before the ack).
   */
  trigger_reason?: string;
  /**
   * Carried from the original `push()` (same rationale as
   * `trigger_reason`).
   */
  pushed_at?: string;
}

/**
 * v0.1 thrown when caller asks the gate to push to a sink the runtime
 * does not yet support. Defined as a plain Error subclass (instead of
 * promoting to `registry/errors.ts`) because v0.2 will replace the gate
 * implementation entirely; this error is intentionally short-lived.
 */
export class UnsupportedHumanPushSinkError extends Error {
  override readonly name = "UnsupportedHumanPushSinkError";
  readonly sink: string;

  constructor(sink: string) {
    super(
      `NeedsHumanGate sink="${sink}" is not implemented in v0.1; ` +
        `only "cli" is supported (Mobile push is v0.2 — see design doc §0.9.3).`,
    );
    this.sink = sink;
  }
}

export class NeedsHumanGate {
  private readonly _sink: "cli" | "mobile";
  private readonly _logger: NeedsHumanGateLogger;
  private readonly _now: () => Date;
  private readonly _fcopClient: FcopProjectClient | null;

  constructor(opts: NeedsHumanGateOptions = {}) {
    this._sink = opts.sink ?? "cli";
    if (this._sink !== "cli") {
      // Eager fail: catching at construction time means a misconfigured
      // Runtime never even starts to dispatch reviews — better than
      // discovering the missing implementation only when the first
      // needs_human verdict fires.
      throw new UnsupportedHumanPushSinkError(this._sink);
    }
    this._logger = opts.logger ?? { info: (m, ...a) => console.log(m, ...a) };
    this._now = opts.now ?? (() => new Date());
    this._fcopClient = opts.fcopClient ?? null;
  }

  /**
   * v0.1 sink semantics: print a one-line marker to the logger's `info`
   * stream so any operator (or the `codeflowmu-shell` daemon's log file)
   * sees the request. **Does NOT block** — v0.1 is fire-and-forget; the
   * returned `HumanApproval` carries `approved_by: null + approved_at: null`
   * to signal "pushed, awaiting human" in the audit trail.
   *
   * v0.2 will replace the body with `MobilePushAdapter.push(...)` and
   * the returned promise will resolve only after the human acks (or a
   * configured SLO timer fires).
   */
  async push(req: HumanPushRequest): Promise<HumanApproval> {
    const pushedAt = this._now().toISOString();

    // One structured line — designed to be `grep`-able and unique enough
    // for the future Mobile push observer to pivot on.
    this._logger.info(
      `[NeedsHumanGate] human approval required: ` +
        `review_id="${req.review_id}" task_id="${req.task_id}" ` +
        `reviewer_role="${req.reviewer_role}" ` +
        `trigger_reason="${req.trigger_reason}" ` +
        (req.human_request_type ? `human_request_type="${req.human_request_type}" ` : "") +
        (req.matched_rules?.length
          ? `matched_rules=[${req.matched_rules.join(",")}] `
          : "") +
        `(sink=${this._sink}, pushed_at=${pushedAt})` +
        (req.rationale ? ` rationale="${truncate(req.rationale, 200)}"` : ""),
    );

    return {
      pushed_to: this._sink,
      pushed_at: pushedAt,
      approved_by: null,
      approved_at: null,
      trigger_reason: req.trigger_reason,
    };
  }

  /**
   * P4 Day 3 (TASK-20260511-011 §3.1.2) — record a real human ack.
   *
   * Called after `push()` returns (potentially long after, when the human
   * actually replied on Mobile / CLI). Updates the REVIEW file's
   * front-matter via `fcopClient.markHumanApproved()` so the audit trail
   * carries `approver / approved_at / channel / comment / evidence`.
   *
   * v0.1 / v0.3-without-fcopClient mode: returns a *fully populated*
   * `HumanApproval` block in memory but does NOT touch any file — fcop
   * is the only writeback path and is intentionally optional. The
   * returned block reflects what the file WOULD have said if a real
   * fcopClient were wired; an upstream caller can choose to bridge it
   * (e.g. v0.5 secondary audit) but the v0.3 contract is "no fcop = no
   * persisted audit".
   *
   * @returns The full v0.1 `HumanApproval` shape with `approved_by` /
   *   `approved_at` populated from `spec.approver` and the wall clock.
   *
   * @throws Bubbles `FcopClientError` from `fcopClient.markHumanApproved`
   *   when the fcop bridge is wired AND fcop refuses the ack (e.g.
   *   `review_id` doesn't exist, or fcop's own schema validator says no).
   *   v0.1 / v0.3-without-fcopClient mode never throws.
   */
  async markApproved(
    reviewId: string,
    spec: HumanApprovedSpec,
  ): Promise<HumanApproval> {
    const ackedAt = this._now().toISOString();

    // Log marker — same `[NeedsHumanGate]` prefix as push() so operators
    // grep one pattern for the whole HITL flow.
    const fcopWired = this._fcopClient !== null ? "yes" : "no";
    this._logger.info(
      `[NeedsHumanGate] human ack received: ` +
        `review_id="${reviewId}" ` +
        `approver="${spec.approver}" decision="${spec.decision}" ` +
        `channel="${spec.channel}" ` +
        `(sink=${this._sink}, fcop_audit=${fcopWired}, acked_at=${ackedAt})` +
        (spec.comment
          ? ` comment="${truncate(spec.comment, 200)}"`
          : ""),
    );

    if (this._fcopClient !== null) {
      try {
        const review = await this._fcopClient.markHumanApproved(reviewId, {
          approver: spec.approver,
          decision: spec.decision,
          channel: spec.channel,
          ...(spec.comment !== undefined ? { comment: spec.comment } : {}),
        });
        // Hand back the v0.1 HumanApproval shape, populated from fcop's
        // truth (so callers get the actual `approved_at` fcop minted,
        // not our wall-clock guess).
        return {
          pushed_to: this._sink,
          pushed_at: spec.pushed_at ?? ackedAt,
          approved_by: spec.approver,
          approved_at:
            review.human_approval?.approved_at !== undefined &&
            review.human_approval?.approved_at !== ""
              ? review.human_approval.approved_at
              : ackedAt,
          trigger_reason: spec.trigger_reason ?? "(post-ack)",
        };
      } catch (err) {
        // Rethrow as-is — FcopClientError carries the actionable stack
        // for upstream callers (v0.2 Mobile / v0.5 audit will catch +
        // retry). v0.1 callers don't construct gates with fcopClient
        // wired, so this branch is unreachable for them.
        if (err instanceof FcopClientError) throw err;
        throw err;
      }
    }

    // v0.1 / v0.3-without-fcopClient degraded mode: in-memory only.
    return {
      pushed_to: this._sink,
      pushed_at: spec.pushed_at ?? ackedAt,
      approved_by: spec.approver,
      approved_at: ackedAt,
      trigger_reason: spec.trigger_reason ?? "(post-ack)",
    };
  }

  /** Read-only accessor — for diagnostic logging in Runtime.start(). */
  get sink(): "cli" | "mobile" {
    return this._sink;
  }

  /**
   * P4 Day 3 (TASK-20260511-011) — whether this gate has an active fcop
   * bridge wire-up. Runtime.start() / `Task parser:` banner can log it.
   */
  get fcopClientWired(): boolean {
    return this._fcopClient !== null;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

