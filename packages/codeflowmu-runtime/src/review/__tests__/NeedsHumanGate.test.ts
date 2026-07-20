/**
 * NeedsHumanGate tests — Sprint S4 TS-6.4 / TS-6.5.
 *
 * Coverage:
 *   - TS-6.4: push("cli") → logger.info contains trigger_reason +
 *             returned HumanApproval has pushed_to="cli"
 *   - TS-6.5: returned pushed_at is a valid ISO-8601 timestamp
 *   - bonus: construction with sink="mobile" throws (eager-fail) so a
 *            future regression PR can't accidentally ship a stub push
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  FcopClientError,
  type FcopProjectClient,
  type FcopReview,
} from "../../_external/fcop-client.ts";
import {
  NeedsHumanGate,
  UnsupportedHumanPushSinkError,
} from "../NeedsHumanGate.ts";
import { quietLogger } from "./helpers.ts";

/**
 * Stub a minimal `FcopProjectClient`. `NeedsHumanGate.markApproved`
 * only ever calls `markHumanApproved()` on the bridge, so each test
 * overrides that method. No pythonia spin-up — Day 3 tests stay fast
 * + offline (same idiom as Day 2 `TaskParser` / Day 3 `ReviewWriter`
 * stubs).
 */
function stubFcopClient(impl: {
  markHumanApproved: (
    reviewId: string,
    spec: unknown,
  ) => Promise<FcopReview>;
}): FcopProjectClient {
  return impl as unknown as FcopProjectClient;
}

/** Build a minimal `FcopReview` with a fully-populated human_approval. */
function fakeAckedFcopReview(overrides: {
  approver?: string;
  approved_at?: string;
  channel?: string;
  comment?: string | null;
} = {}): FcopReview {
  return {
    review_id: "REVIEW-20260509-001-REVIEW-on-TASK-20260509-001-PM-to-DEV",
    filename:
      "REVIEW-20260509-001-REVIEW-on-TASK-20260509-001-PM-to-DEV.md",
    reviewer_role: "REVIEW",
    reviewer_agent: "REVIEW-01",
    subject_type: "task",
    subject_ref: "TASK-20260509-001-PM-to-DEV",
    decision: "needs_human",
    rationale: "verdict needed human ack",
    required_changes: [],
    decided_at: "2026-05-09T16:00:00.000Z",
    date: "20260509",
    sequence: 1,
    is_archived: false,
    body: "ack-recorded body",
    mtime: "2026-05-11T14:35:21+08:00",
    path: "/fake/fcop/reviews/REVIEW-20260509-001-REVIEW-on-TASK-20260509-001-PM-to-DEV.md",
    human_approval: {
      approver: overrides.approver ?? "ADMIN",
      decision: "approve",
      approved_at: overrides.approved_at ?? "2026-05-11T14:35:21+08:00",
      channel: overrides.channel ?? "mobile",
      comment: overrides.comment ?? null,
      evidence: null,
    },
  };
}

describe("NeedsHumanGate", () => {
  it("TS-6.4: push to cli sink → logger.info contains trigger_reason + returns stub HumanApproval", async () => {
    const logger = quietLogger();
    const gate = new NeedsHumanGate({ sink: "cli", logger });
    assert.equal(gate.sink, "cli");

    const approval = await gate.push({
      review_id:
        "REVIEW-20260509-001-REVIEW-on-TASK-20260509-001-PM-to-DEV",
      task_id: "TASK-20260509-001-PM-to-DEV",
      reviewer_role: "REVIEW",
      trigger_reason: "verdict_parse_failed",
      rationale: "reviewer output did not match VERDICT regex",
    });

    // Returned stub.
    assert.equal(approval.pushed_to, "cli");
    assert.equal(approval.trigger_reason, "verdict_parse_failed");
    assert.equal(approval.approved_by, null);
    assert.equal(approval.approved_at, null);

    // Logger captured the structured marker.
    assert.equal(logger.logs.length, 1);
    const line = logger.logs[0]!;
    assert.match(line, /\[NeedsHumanGate\]/);
    assert.match(line, /trigger_reason="verdict_parse_failed"/);
    assert.match(line, /reviewer_role="REVIEW"/);
    assert.match(line, /task_id="TASK-20260509-001-PM-to-DEV"/);
    assert.match(line, /sink=cli/);
  });

  it("TS-6.5: returned pushed_at is a valid ISO-8601 timestamp", async () => {
    const logger = quietLogger();
    const gate = new NeedsHumanGate({ sink: "cli", logger });

    const before = Date.now();
    const approval = await gate.push({
      review_id:
        "REVIEW-20260509-002-REVIEW-on-TASK-20260509-002-PM-to-DEV",
      task_id: "TASK-20260509-002-PM-to-DEV",
      reviewer_role: "REVIEW",
      trigger_reason: "reviewer_not_found",
    });
    const after = Date.now();

    // pushed_at parses as a Date.
    const ts = Date.parse(approval.pushed_at);
    assert.ok(!Number.isNaN(ts), `pushed_at="${approval.pushed_at}" must parse`);

    // Pattern is ISO-8601 (YYYY-MM-DDTHH:MM:SS.sssZ).
    assert.match(approval.pushed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);

    // Timestamp is within the wall-clock window of this test.
    assert.ok(ts >= before, `pushed_at >= before (got ${ts} vs ${before})`);
    assert.ok(ts <= after, `pushed_at <= after (got ${ts} vs ${after})`);
  });

  it("constructing with sink=\"mobile\" eagerly throws UnsupportedHumanPushSinkError (v0.1 only supports cli)", () => {
    assert.throws(
      () => new NeedsHumanGate({ sink: "mobile" }),
      (err: unknown) =>
        err instanceof UnsupportedHumanPushSinkError &&
        /not implemented in v0\.1/.test(err.message),
    );
  });

  // ─────────────────────────────────────────────────────────────────────
  // Day 3 (TASK-20260511-011 §3.1.2) — markApproved() + fcop audit
  // ─────────────────────────────────────────────────────────────────────

  it("TS-NHG-D3-1: markApproved without fcopClient → in-memory HumanApproval (no fcop call, no throw)", async () => {
    const logger = quietLogger();
    const gate = new NeedsHumanGate({ sink: "cli", logger });
    assert.equal(gate.fcopClientWired, false);

    const approval = await gate.markApproved(
      "REVIEW-20260509-001-REVIEW-on-TASK-20260509-001-PM-to-DEV",
      {
        approver: "ADMIN",
        decision: "approve",
        channel: "cli",
        comment: "looks good",
        trigger_reason: "verdict_parse_failed",
        pushed_at: "2026-05-11T14:00:00.000Z",
      },
    );

    // The returned HumanApproval reflects the ack — populated end-to-end
    // even without fcop wired (v0.3 degraded mode contract).
    assert.equal(approval.pushed_to, "cli");
    assert.equal(approval.pushed_at, "2026-05-11T14:00:00.000Z");
    assert.equal(approval.approved_by, "ADMIN");
    assert.ok(approval.approved_at, "approved_at populated from wall clock");
    assert.match(
      approval.approved_at!,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/,
    );
    assert.equal(approval.trigger_reason, "verdict_parse_failed");

    // Logger captured the ack marker (one push() would have added one,
    // but here we only called markApproved, so exactly 1 line).
    assert.equal(logger.logs.length, 1);
    const line = logger.logs[0]!;
    assert.match(line, /\[NeedsHumanGate\] human ack received/);
    assert.match(line, /approver="ADMIN"/);
    assert.match(line, /decision="approve"/);
    assert.match(line, /channel="cli"/);
    assert.match(line, /fcop_audit=no/);
  });

  it("TS-NHG-D3-2: markApproved with fcopClient forwards to markHumanApproved + reflects fcop-returned approved_at", async () => {
    const logger = quietLogger();
    const calls: Array<{ reviewId: string; spec: unknown }> = [];
    const fcopClient = stubFcopClient({
      markHumanApproved: async (reviewId, spec) => {
        calls.push({ reviewId, spec });
        return fakeAckedFcopReview({
          approver: "ADMIN",
          channel: "mobile",
          approved_at: "2026-05-11T14:35:21+08:00",
          comment: "scanned",
        });
      },
    });
    const gate = new NeedsHumanGate({ sink: "cli", logger, fcopClient });
    assert.equal(gate.fcopClientWired, true);

    const approval = await gate.markApproved(
      "REVIEW-20260509-001-REVIEW-on-TASK-20260509-001-PM-to-DEV",
      {
        approver: "ADMIN",
        decision: "approve",
        channel: "mobile",
        comment: "scanned",
        trigger_reason: "high_risk_skill_invocation",
        pushed_at: "2026-05-11T14:00:00.000Z",
      },
    );

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.reviewId,
      "REVIEW-20260509-001-REVIEW-on-TASK-20260509-001-PM-to-DEV",
      "reviewId forwarded positionally to fcopClient.markHumanApproved",
    );
    const spec = calls[0]?.spec as Record<string, unknown>;
    assert.equal(spec["approver"], "ADMIN");
    assert.equal(spec["decision"], "approve");
    assert.equal(spec["channel"], "mobile");
    assert.equal(spec["comment"], "scanned");

    // The returned HumanApproval surfaces fcop's `approved_at` truth (so
    // upstream callers persist what fcop actually wrote, not our wall
    // clock guess).
    assert.equal(approval.approved_by, "ADMIN");
    assert.equal(approval.approved_at, "2026-05-11T14:35:21+08:00");
    assert.equal(approval.pushed_to, "cli");
    assert.equal(approval.pushed_at, "2026-05-11T14:00:00.000Z");
    assert.equal(approval.trigger_reason, "high_risk_skill_invocation");

    // Logger captures fcop_audit=yes (transparency for postmortems).
    const line = logger.logs[0]!;
    assert.match(line, /fcop_audit=yes/);
  });

  it("TS-NHG-D3-3: markApproved bubbles FcopClientError from fcopClient.markHumanApproved (callers can retry)", async () => {
    const logger = quietLogger();
    const fcopClient = stubFcopClient({
      markHumanApproved: async () => {
        throw new FcopClientError(
          "fcop says review not found",
          "markHumanApproved",
          new Error("ENOENT"),
        );
      },
    });
    const gate = new NeedsHumanGate({ sink: "cli", logger, fcopClient });

    await assert.rejects(
      () =>
        gate.markApproved(
          "REVIEW-20260509-999-REVIEW-on-TASK-20260509-999-PM-to-DEV",
          { approver: "ADMIN", decision: "approve", channel: "cli" },
        ),
      (err: unknown) =>
        err instanceof FcopClientError &&
        /fcop says review not found/.test(err.message),
      "FcopClientError must bubble — callers wire retry / fallback on top",
    );
  });
});
