/**
 * ReviewEngine tests — Sprint S4 TS-6.6 ~ 6.11.
 *
 * Coverage (full integration with InMemorySdkAdapter / SessionManager):
 *   - TS-6.6 : subject session_ended → ReviewEngine starts a reviewer session
 *   - TS-6.7 : policy.shouldReview=false → state_history `review_skipped`
 *   - TS-6.8 : reviewer role not registered → NeedsHumanGate fallback +
 *              REVIEW-*.md with decision="needs_human"
 *   - TS-6.9 : reviewer output without VERDICT line → needs_human +
 *              trigger_reason="verdict_parse_failed"
 *   - TS-6.10: approved end-to-end → REVIEW-*.md landed + state_history
 *              appended on the original task
 *   - TS-6.11: needs_changes end-to-end → required_changes populated +
 *              schema-valid frontmatter
 *
 *   ── BUG-SDK-004 (TASK-013 / REPORT-013) ─────────────────────────────
 *   - TS-6.12: SDKAssistantMessage real shape (`content[].text`) +
 *              markdown-decorated `**VERDICT:` line → buffer accumulates
 *              correctly + decision=rejected (NOT needs_human)
 *   - TS-6.13: SDKAssistantMessage with mixed TextBlock + ToolUseBlock →
 *              only TextBlock.text lands in buffer; tool_use args are
 *              silently skipped (no JSON.stringify pollution)
 *   - TS-6.15: PLAN-* synthetic task_id → engine skips (PlanScheduler path)
 *
 * The pipeline construction here mirrors `TaskDispatcher.test.ts` so a
 * future maintainer can swap pieces without re-deriving the wiring.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validate } from "@codeflowmu/protocol";
import type { Agent } from "@codeflowmu/protocol";

import { AgentRegistry } from "../../registry/AgentRegistry.ts";
import {
  InMemoryRunHandle,
  InMemorySdkAdapter,
  type AgentSendSpec,
} from "../../registry/AgentSdkAdapter.ts";
import { JsonFileStore } from "../../registry/PersistentStore.ts";
import { SessionManager } from "../../session/SessionManager.ts";
import { SessionStore } from "../../session/SessionStore.ts";
import { TranscriptWriter } from "../../session/TranscriptWriter.ts";
import { StateHistoryWriter } from "../../scheduler/StateHistoryWriter.ts";
import {
  ReviewEngine,
  type ReviewPolicy,
  type TaskReference,
} from "../ReviewEngine.ts";
import { NeedsHumanGate } from "../NeedsHumanGate.ts";
import { ReviewWriter } from "../ReviewWriter.ts";
import {
  quietLogger,
  readReviewFile,
  waitFor,
  withTempReview,
} from "./helpers.ts";

const SUBJECT_TASK_ID = "TASK-20260509-001-PM-to-DEV";
const SUBJECT_FILENAME = `${SUBJECT_TASK_ID}.md`;

const SUBJECT_TASK_BODY = `---
protocol: fcop
task_id: ${SUBJECT_TASK_ID}
sender: PM
recipient: DEV
priority: P2
status: pending
---

# Body of ${SUBJECT_TASK_ID}
`;

function devSpec(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: "DEV-01",
    role: "DEV",
    layer: "worker",
    node: "local",
    runtime: "local",
    skills: ["fcop"],
    status: "idle",
    ...overrides,
  };
}

function reviewerSpec(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: "REVIEW-01",
    role: "REVIEW",
    layer: "governance",
    node: "local",
    runtime: "local",
    skills: ["fcop"],
    status: "idle",
    ...overrides,
  };
}

interface Pipeline {
  registry: AgentRegistry;
  sessionManager: SessionManager;
  sessionStore: SessionStore;
  reviewEngine: ReviewEngine;
  reviewWriter: ReviewWriter;
  needsHumanGate: NeedsHumanGate;
  historyWriter: StateHistoryWriter;
  sdk: InMemorySdkAdapter;
  logger: ReturnType<typeof quietLogger>;
  shutdown: () => Promise<void>;
}

interface BuildOpts {
  inboxDir: string;
  stateDir: string;
  reviewsDir: string;
  policy?: ReviewPolicy;
  /**
   * Override the reviewer's RunHandle so tests can plant the verdict line.
   * Falls back to `null` (default InMemoryRunHandle, immediate settle).
   */
  reviewerHandleFactory?: (
    spec: AgentSendSpec,
    sdkAgentId: string,
  ) => InMemoryRunHandle;
}

async function buildPipeline(opts: BuildOpts): Promise<Pipeline> {
  const sdk = new InMemorySdkAdapter();
  if (opts.reviewerHandleFactory) {
    sdk.sendHandleFactory = opts.reviewerHandleFactory;
  }
  const agentStore = new JsonFileStore({
    path: join(opts.stateDir, "agents.json"),
  });
  const registry = new AgentRegistry({ store: agentStore, sdk });
  const sessionStore = new SessionStore({
    dir: join(opts.stateDir, "sessions"),
  });
  const transcriptWriter = new TranscriptWriter({
    dir: join(opts.stateDir, "transcripts"),
  });
  const sessionManager = new SessionManager({
    registry,
    sdk,
    sessionStore,
    transcriptWriter,
  });
  const logger = quietLogger();
  const historyWriter = new StateHistoryWriter();
  const reviewWriter = new ReviewWriter({ reviewsDir: opts.reviewsDir });
  const needsHumanGate = new NeedsHumanGate({ sink: "cli", logger });
  const reviewEngine = new ReviewEngine({
    sessionManager,
    registry,
    sessionStore,
    historyWriter,
    reviewWriter,
    needsHumanGate,
    inboxDir: opts.inboxDir,
    ...(opts.policy ? { policy: opts.policy } : {}),
    logger,
  });

  reviewEngine.start();

  return {
    registry,
    sessionManager,
    sessionStore,
    reviewEngine,
    reviewWriter,
    needsHumanGate,
    historyWriter,
    sdk,
    logger,
    shutdown: async () => {
      await reviewEngine.stop().catch(() => undefined);
      await transcriptWriter.closeAll().catch(() => undefined);
    },
  };
}

/**
 * Produce a RunHandle factory that, ONLY for the REVIEW-01 reviewer agent,
 * emits a single `sdk.assistant` event carrying the canonical verdict line
 * before auto-settling. The subject agent (DEV-01) gets a vanilla handle
 * — otherwise its synthetic `sdk.assistant` would race ReviewEngine's
 * orphan-buffer machinery and trip `_isMaybePendingReviewerSession` on
 * the subject session itself.
 */
function reviewerHandleWith(verdictLine: string) {
  return (spec: AgentSendSpec, _sdkAgentId: string): InMemoryRunHandle => {
    if (spec.agentId !== "REVIEW-01") {
      return new InMemoryRunHandle({
        sessionId: spec.sessionId,
        agentId: spec.agentId,
      });
    }
    return new InMemoryRunHandle({
      sessionId: spec.sessionId,
      agentId: spec.agentId,
      emitEvents: [
        {
          event_id: `${spec.sessionId}-asst-1`,
          at: new Date().toISOString(),
          event_type: "sdk.assistant",
          session_id: spec.sessionId,
          run_id: "run-fake",
          agent_id: spec.agentId,
          payload: { text: verdictLine },
        },
      ],
    });
  };
}

/**
 * TS-6.12 ~ TS-6.14 helper — emits a reviewer `sdk.assistant` event whose
 * payload mirrors the REAL `SDKAssistantMessage` shape produced by
 * `@cursor/sdk` in production:
 *
 *   payload = {
 *     raw: {
 *       type: "assistant",
 *       agent_id, run_id,
 *       message: {
 *         role: "assistant",
 *         content: Array<TextBlock | ToolUseBlock>
 *       }
 *     }
 *   }
 *
 * (See `node_modules/@cursor/sdk/dist/cjs/messages.d.ts:23-31`.)
 *
 * BUG-SDK-004 fix (TASK-013) guards against `extractText()` regressing on
 * this real shape — without the `content[]` probe, the reviewer's buffer
 * stays empty and every real-SDK review collapses to
 * `decision=needs_human` regardless of what the LLM actually said.
 *
 * @param contentBlocks  Mix of TextBlock and ToolUseBlock dicts. Only
 *                       `type:"text"` entries should land in the reviewer
 *                       buffer; `type:"tool_use"` must be silently
 *                       skipped (tool args are never verdict text).
 */
function reviewerHandleWithSdkContent(
  contentBlocks: Array<Record<string, unknown>>,
) {
  return (spec: AgentSendSpec, _sdkAgentId: string): InMemoryRunHandle => {
    if (spec.agentId !== "REVIEW-01") {
      return new InMemoryRunHandle({
        sessionId: spec.sessionId,
        agentId: spec.agentId,
      });
    }
    return new InMemoryRunHandle({
      sessionId: spec.sessionId,
      agentId: spec.agentId,
      emitEvents: [
        {
          event_id: `${spec.sessionId}-asst-1`,
          at: new Date().toISOString(),
          event_type: "sdk.assistant",
          session_id: spec.sessionId,
          run_id: "run-fake",
          agent_id: spec.agentId,
          payload: {
            raw: {
              type: "assistant",
              agent_id: `agent-${spec.sessionId}`,
              run_id: "run-fake",
              message: {
                role: "assistant",
                content: contentBlocks,
              },
            },
          },
        },
      ],
    });
  };
}

/** Plant a subject task file so state_history appends find a target. */
async function plantTaskFile(inboxDir: string): Promise<string> {
  const filepath = join(inboxDir, SUBJECT_FILENAME);
  await writeFile(filepath, SUBJECT_TASK_BODY, "utf-8");
  return filepath;
}

/**
 * Wait until the reviewer session has been dispatched (sdk.send was called
 * with `agent_id="REVIEW-01"`), then drain the engine's in-flight pipelines.
 *
 * Using `engine.whenSettled()` alone is racy: it returns immediately when
 * the engine hasn't yet seen `runtime.session_ended` for the subject
 * session (so `_inflight` is empty). Tests must first observe that the
 * pipeline has actually started before they can wait on its termination.
 */
async function awaitReviewSettled(pipe: Pipeline): Promise<void> {
  await waitFor(
    () =>
      pipe.sdk.calls.send.some((c) => c.spec.agentId === "REVIEW-01")
        ? true
        : null,
    { what: "reviewer.send dispatch", timeoutMs: 3000 },
  );
  await pipe.reviewEngine.whenSettled();
}

describe("ReviewEngine", () => {
  it("TS-6.6: subject session_ended → ReviewEngine starts a reviewer session", async () => {
    await withTempReview(async ({ inboxDir, stateDir, reviewsDir }) => {
      await plantTaskFile(inboxDir);
      const pipe = await buildPipeline({
        inboxDir,
        stateDir,
        reviewsDir,
        reviewerHandleFactory: reviewerHandleWith(
          "VERDICT: approved; RATIONALE: looks good",
        ),
      });
      try {
        await pipe.registry.register(devSpec());
        await pipe.registry.register(reviewerSpec());

        // Fire the subject session.
        await pipe.sessionManager.startSession("DEV-01", SUBJECT_TASK_ID, {
          text: "do the thing",
        });

        // Wait for the reviewer's startSession to land. The InMemorySdkAdapter
        // records every `send` call, so we wait for a 2nd call (1st = subject,
        // 2nd = reviewer).
        await waitFor(() => pipe.sdk.calls.send.length >= 2, {
          what: "reviewer session start",
          timeoutMs: 3000,
        });

        const reviewerCall = pipe.sdk.calls.send[1]!;
        assert.equal(reviewerCall.spec.agentId, "REVIEW-01");
        assert.match(
          reviewerCall.spec.sessionId,
          /^session-/,
          "reviewer session_id should be a fresh session",
        );

        // Wait for the review pipeline to settle.
        await pipe.reviewEngine.whenSettled();

        // REVIEW-*.md was written.
        const expectedReviewId = `REVIEW-20260509-001-REVIEW-on-${SUBJECT_TASK_ID}`;
        const reviewFilepath = join(reviewsDir, `${expectedReviewId}.md`);
        const { frontmatter } = await readReviewFile(reviewFilepath);
        assert.equal(frontmatter["decision"], "approved");
        assert.equal(frontmatter["review_id"], expectedReviewId);
        const result = await validate("review", frontmatter);
        assert.equal(result.valid, true, JSON.stringify(result.errors));
      } finally {
        await pipe.shutdown();
      }
    });
  });

  it("TS-6.15: synthetic PLAN-* task_id → ReviewEngine skips (no reviewer / no inbox append)", async () => {
    await withTempReview(async ({ inboxDir, stateDir, reviewsDir }) => {
      const pipe = await buildPipeline({
        inboxDir,
        stateDir,
        reviewsDir,
      });
      try {
        await pipe.registry.register(devSpec());
        await pipe.registry.register(reviewerSpec());
        const planTaskId = `PLAN-P4-P4-D3-${Date.now()}`;
        await pipe.sessionManager.startSession("DEV-01", planTaskId, {
          text: "plan sprint",
        });
        await pipe.reviewEngine.whenSettled();
        assert.equal(
          pipe.sdk.calls.send.length,
          1,
          "only subject session send — no reviewer dispatch for synthetic task_id",
        );
        assert.equal(pipe.sdk.calls.send[0]!.spec.agentId, "DEV-01");
      } finally {
        await pipe.shutdown();
      }
    });
  });

  it("TS-6.7: policy.shouldReview=false → state_history review_skipped + no REVIEW-*.md", async () => {
    await withTempReview(async ({ inboxDir, stateDir, reviewsDir }) => {
      const subjectFilepath = await plantTaskFile(inboxDir);
      const skipPolicy: ReviewPolicy = {
        shouldReview: () => false,
        pickReviewer: () => "REVIEW",
      };
      const pipe = await buildPipeline({
        inboxDir,
        stateDir,
        reviewsDir,
        policy: skipPolicy,
      });
      try {
        await pipe.registry.register(devSpec());

        await pipe.sessionManager.startSession("DEV-01", SUBJECT_TASK_ID, {
          text: "skip me",
        });

        // Wait for ReviewEngine to settle.
        await waitFor(
          async () => {
            const txt = await readFile(subjectFilepath, "utf-8");
            return txt.includes("review_skipped") ? txt : null;
          },
          { what: "review_skipped state_history append", timeoutMs: 3000 },
        );

        const txt = await readFile(subjectFilepath, "utf-8");
        assert.match(
          txt,
          /policy\.shouldReview=false/,
          "review_skipped note should record the reason",
        );
        assert.match(txt, /by `review-engine`/);

        // No reviewer session was started.
        assert.equal(
          pipe.sdk.calls.send.filter((c) => c.spec.agentId === "REVIEW-01").length,
          0,
          "skip path should NOT call reviewer.send",
        );

        // No REVIEW-*.md exists.
        const expectedReviewId = `REVIEW-20260509-001-REVIEW-on-${SUBJECT_TASK_ID}`;
        await assert.rejects(
          () => readFile(join(reviewsDir, `${expectedReviewId}.md`), "utf-8"),
          /ENOENT/,
        );
      } finally {
        await pipe.shutdown();
      }
    });
  });

  it("TS-6.8: reviewer not registered → NeedsHumanGate fallback + REVIEW-*.md with decision=needs_human", async () => {
    await withTempReview(async ({ inboxDir, stateDir, reviewsDir }) => {
      const subjectFilepath = await plantTaskFile(inboxDir);
      const pipe = await buildPipeline({ inboxDir, stateDir, reviewsDir });
      try {
        await pipe.registry.register(devSpec());
        // Note: NO reviewer agent registered.

        await pipe.sessionManager.startSession("DEV-01", SUBJECT_TASK_ID, {
          text: "no reviewer",
        });

        await pipe.reviewEngine.whenSettled();
        // The fallback path is async — wait for the file to land.
        await waitFor(
          async () => {
            const txt = await readFile(subjectFilepath, "utf-8");
            return txt.includes("review_needs_human") ? txt : null;
          },
          { what: "fallback state_history append", timeoutMs: 3000 },
        );

        // NeedsHumanGate logged the push.
        assert.ok(
          pipe.logger.logs.some((l) =>
            /trigger_reason="reviewer_not_found"/.test(l),
          ),
          `expected NeedsHumanGate log; got: ${pipe.logger.logs.join("\n")}`,
        );

        // REVIEW-*.md exists with decision=needs_human.
        const expectedReviewId = `REVIEW-20260509-001-REVIEW-on-${SUBJECT_TASK_ID}`;
        const { frontmatter } = await readReviewFile(
          join(reviewsDir, `${expectedReviewId}.md`),
        );
        assert.equal(frontmatter["decision"], "needs_human");
        const ha = frontmatter["human_approval"] as Record<string, unknown>;
        assert.equal(ha["trigger_reason"], "reviewer_not_found");
        assert.equal(ha["pushed_to"], "cli");

        // Schema check.
        const result = await validate("review", frontmatter);
        assert.equal(result.valid, true, JSON.stringify(result.errors));
      } finally {
        await pipe.shutdown();
      }
    });
  });

  it("TS-6.9: reviewer output without VERDICT line → decision=needs_human + trigger_reason=verdict_parse_failed", async () => {
    await withTempReview(async ({ inboxDir, stateDir, reviewsDir }) => {
      await plantTaskFile(inboxDir);
      const pipe = await buildPipeline({
        inboxDir,
        stateDir,
        reviewsDir,
        // Reviewer emits a chatty assistant message but never a VERDICT line.
        reviewerHandleFactory: reviewerHandleWith(
          "I think this looks fine but I won't commit to a verdict.",
        ),
      });
      try {
        await pipe.registry.register(devSpec());
        await pipe.registry.register(reviewerSpec());

        await pipe.sessionManager.startSession("DEV-01", SUBJECT_TASK_ID, {
          text: "ambiguous",
        });

        await awaitReviewSettled(pipe);

        const expectedReviewId = `REVIEW-20260509-001-REVIEW-on-${SUBJECT_TASK_ID}`;
        const { frontmatter } = await readReviewFile(
          join(reviewsDir, `${expectedReviewId}.md`),
        );
        assert.equal(frontmatter["decision"], "needs_human");
        const ha = frontmatter["human_approval"] as Record<string, unknown>;
        assert.equal(ha["trigger_reason"], "verdict_parse_failed");

        const result = await validate("review", frontmatter);
        assert.equal(result.valid, true, JSON.stringify(result.errors));
      } finally {
        await pipe.shutdown();
      }
    });
  });

  it("TS-6.10: approved end-to-end → REVIEW-*.md landed + state_history appended on subject", async () => {
    await withTempReview(async ({ inboxDir, stateDir, reviewsDir }) => {
      const subjectFilepath = await plantTaskFile(inboxDir);
      const pipe = await buildPipeline({
        inboxDir,
        stateDir,
        reviewsDir,
        reviewerHandleFactory: reviewerHandleWith(
          "VERDICT: approved; RATIONALE: implementation matches the brief",
        ),
      });
      try {
        await pipe.registry.register(devSpec());
        await pipe.registry.register(reviewerSpec());

        await pipe.sessionManager.startSession("DEV-01", SUBJECT_TASK_ID, {
          text: "approve me",
        });

        await awaitReviewSettled(pipe);

        // REVIEW-*.md content.
        const expectedReviewId = `REVIEW-20260509-001-REVIEW-on-${SUBJECT_TASK_ID}`;
        const { frontmatter, body } = await readReviewFile(
          join(reviewsDir, `${expectedReviewId}.md`),
        );
        assert.equal(frontmatter["decision"], "approved");
        assert.equal(frontmatter["reviewer_role"], "REVIEW");
        assert.equal(frontmatter["reviewer_agent"], "REVIEW-01");
        assert.equal(frontmatter["subject_ref"], SUBJECT_TASK_ID);
        assert.equal(
          frontmatter["rationale"],
          "implementation matches the brief",
        );
        assert.match(body, /Decision: \*\*approved\*\*/);

        // state_history was appended on the subject task.
        const subjectTxt = await readFile(subjectFilepath, "utf-8");
        assert.match(subjectTxt, /state_history \(auto-appended by runtime\)/);
        assert.match(subjectTxt, /`ended` → `review_pending`/);
        assert.match(subjectTxt, /`review_pending` → `review_approved`/);

        const result = await validate("review", frontmatter);
        assert.equal(result.valid, true, JSON.stringify(result.errors));
      } finally {
        await pipe.shutdown();
      }
    });
  });

  it("TS-6.11: needs_changes end-to-end → required_changes populated + schema-valid", async () => {
    await withTempReview(async ({ inboxDir, stateDir, reviewsDir }) => {
      await plantTaskFile(inboxDir);
      const pipe = await buildPipeline({
        inboxDir,
        stateDir,
        reviewsDir,
        reviewerHandleFactory: reviewerHandleWith(
          "VERDICT: needs_changes; RATIONALE: missing tests for the failure path",
        ),
      });
      try {
        await pipe.registry.register(devSpec());
        await pipe.registry.register(reviewerSpec());

        await pipe.sessionManager.startSession("DEV-01", SUBJECT_TASK_ID, {
          text: "needs_changes",
        });

        await awaitReviewSettled(pipe);

        const expectedReviewId = `REVIEW-20260509-001-REVIEW-on-${SUBJECT_TASK_ID}`;
        const { frontmatter } = await readReviewFile(
          join(reviewsDir, `${expectedReviewId}.md`),
        );
        assert.equal(frontmatter["decision"], "needs_changes");
        assert.ok(
          frontmatter["required_changes"] !== undefined,
          "needs_changes must populate required_changes (schema allOf #2)",
        );
        // Synthesized from rationale per v0.1 ReviewEngine semantics.
        assert.match(
          String(frontmatter["required_changes"]),
          /missing tests/,
        );

        const result = await validate("review", frontmatter);
        assert.equal(
          result.valid,
          true,
          `needs_changes verdict must satisfy schema (errors: ${
            JSON.stringify(result.errors, null, 2)
          })`,
        );
      } finally {
        await pipe.shutdown();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // BUG-SDK-004 fixes (TASK-013 / REPORT-013) — extractText() must
  // recognize the REAL `SDKAssistantMessage.message.content[]` shape
  // (TextBlock | ToolUseBlock array). Without these tests, a regression
  // in `extractText` could re-introduce the v0.2.0-beta.2 production
  // bug where every real-SDK review collapsed to `decision=needs_human`
  // because the reviewer buffer never accumulated a single character.
  // ─────────────────────────────────────────────────────────────────────

  it("TS-6.12: SDK content[]+markdown-bold VERDICT → decision=rejected (NOT needs_human)", async () => {
    await withTempReview(async ({ inboxDir, stateDir, reviewsDir }) => {
      await plantTaskFile(inboxDir);
      const pipe = await buildPipeline({
        inboxDir,
        stateDir,
        reviewsDir,
        // Real SDK shape: payload.raw.message.content[] with one TextBlock
        // whose `.text` is markdown-decorated (`**VERDICT: rejected; ...`).
        // VERDICT_REGEX is unanchored so the leading `**` does not block
        // the match — but only IF extractText() walked into content[] in
        // the first place. (Pre-fix it short-circuited at probe 3 and
        // returned null.)
        reviewerHandleFactory: reviewerHandleWithSdkContent([
          {
            type: "text",
            text:
              "**VERDICT: rejected; RATIONALE: cannot find subject task body**",
          },
        ]),
      });
      try {
        await pipe.registry.register(devSpec());
        await pipe.registry.register(reviewerSpec());

        await pipe.sessionManager.startSession("DEV-01", SUBJECT_TASK_ID, {
          text: "real SDK shape please",
        });

        await awaitReviewSettled(pipe);

        const expectedReviewId =
          `REVIEW-20260509-001-REVIEW-on-${SUBJECT_TASK_ID}`;
        const { frontmatter } = await readReviewFile(
          join(reviewsDir, `${expectedReviewId}.md`),
        );
        assert.equal(
          frontmatter["decision"],
          "rejected",
          "BUG-SDK-004 regression: real SDK content[] shape must drive " +
            "decision=rejected, not the verdict_parse_failed → needs_human " +
            "fallback observed in v0.2.0-beta.2 smoke #1.",
        );
        const result = await validate("review", frontmatter);
        assert.equal(result.valid, true, JSON.stringify(result.errors));
      } finally {
        await pipe.shutdown();
      }
    });
  });

  it("TS-6.13: SDK content[] mixed TextBlock+ToolUseBlock → only text lands in buffer", async () => {
    await withTempReview(async ({ inboxDir, stateDir, reviewsDir }) => {
      await plantTaskFile(inboxDir);
      const pipe = await buildPipeline({
        inboxDir,
        stateDir,
        reviewsDir,
        // Reviewer emits a tool_use call (e.g. glob), then the verdict
        // text. extractText must skip the tool_use block entirely;
        // otherwise its JSON-stringified args could match VERDICT_REGEX
        // garbage or, worse, hide the real verdict line.
        reviewerHandleFactory: reviewerHandleWithSdkContent([
          {
            type: "tool_use",
            id: "tool-call-1",
            name: "glob",
            input: { pattern: "**/VERDICT*", verdict: "rejected" }, // adversarial: value contains "rejected"
          },
          {
            type: "text",
            text: "VERDICT: approved; RATIONALE: implementation looks fine",
          },
        ]),
      });
      try {
        await pipe.registry.register(devSpec());
        await pipe.registry.register(reviewerSpec());

        await pipe.sessionManager.startSession("DEV-01", SUBJECT_TASK_ID, {
          text: "tool then verdict",
        });

        await awaitReviewSettled(pipe);

        const expectedReviewId =
          `REVIEW-20260509-001-REVIEW-on-${SUBJECT_TASK_ID}`;
        const { frontmatter } = await readReviewFile(
          join(reviewsDir, `${expectedReviewId}.md`),
        );
        assert.equal(
          frontmatter["decision"],
          "approved",
          "tool_use blocks must NOT pollute the reviewer buffer; the " +
            "trailing TextBlock's verdict line is the only signal that " +
            "should drive decision.",
        );
        const result = await validate("review", frontmatter);
        assert.equal(result.valid, true, JSON.stringify(result.errors));
      } finally {
        await pipe.shutdown();
      }
    });
  });

  it("TS-6.14: SDK content[] multiple TextBlocks → concatenated in order before parseVerdict", async () => {
    await withTempReview(async ({ inboxDir, stateDir, reviewsDir }) => {
      await plantTaskFile(inboxDir);
      const pipe = await buildPipeline({
        inboxDir,
        stateDir,
        reviewsDir,
        // Streaming responses arrive as many small TextBlocks. The
        // verdict line is split mid-keyword across two blocks; only by
        // joining them in order does VERDICT_REGEX find a hit.
        reviewerHandleFactory: reviewerHandleWithSdkContent([
          { type: "text", text: "Reviewing the task body now…\n\nVERD" },
          {
            type: "text",
            text: "ICT: needs_changes; RATIONALE: missing tests for path X",
          },
        ]),
      });
      try {
        await pipe.registry.register(devSpec());
        await pipe.registry.register(reviewerSpec());

        await pipe.sessionManager.startSession("DEV-01", SUBJECT_TASK_ID, {
          text: "streaming chunks",
        });

        await awaitReviewSettled(pipe);

        const expectedReviewId =
          `REVIEW-20260509-001-REVIEW-on-${SUBJECT_TASK_ID}`;
        const { frontmatter } = await readReviewFile(
          join(reviewsDir, `${expectedReviewId}.md`),
        );
        assert.equal(
          frontmatter["decision"],
          "needs_changes",
          "multi-chunk streaming TextBlocks must be concatenated in arrival " +
            "order so a verdict split mid-keyword is still parseable.",
        );
        const result = await validate("review", frontmatter);
        assert.equal(result.valid, true, JSON.stringify(result.errors));
      } finally {
        await pipe.shutdown();
      }
    });
  });
});

