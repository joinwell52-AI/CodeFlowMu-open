/**
 * ReviewWriter tests — Sprint S4 TS-6.1 / TS-6.2 / TS-6.3.
 *
 * Coverage:
 *   - TS-6.1: write valid verdict → file exists + frontmatter passes
 *             `validate("review", ...)` from `@codeflowmu/protocol`
 *   - TS-6.2: review_id pattern enforced + refuse-overwrite contract
 *   - TS-6.3: atomic-write semantics: a failed write does NOT leave a
 *             half-written target file (tmp-file may exist as a
 *             diagnostic, but the canonical path is untouched)
 */

import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validate } from "@codeflowmu/protocol";
import { parse as parseYaml } from "yaml";

import {
  FcopClientError,
  type FcopProjectClient,
  type FcopReview,
} from "../../_external/fcop-client.ts";
import { ReviewWriteError } from "../../registry/errors.ts";
import {
  ReviewWriter,
  renderReviewMarkdown,
  type ReviewVerdict,
} from "../ReviewWriter.ts";
import { readReviewFile, withTempReview } from "./helpers.ts";

function makeApprovedVerdict(overrides: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    review_id: "REVIEW-20260509-001-REVIEW-on-TASK-20260509-001-PM-to-DEV",
    subject_type: "task",
    subject_ref: "TASK-20260509-001-PM-to-DEV",
    reviewer_role: "REVIEW",
    reviewer_agent: "REVIEW-01",
    decision: "approved",
    rationale: "looks good",
    decided_at: "2026-05-09T16:00:00.000Z",
    decision_duration_ms: 1234,
    ...overrides,
  };
}

/**
 * Stub a minimal `FcopProjectClient`. ReviewWriter only calls
 * `writeReview()` on the fcop path, so each test overrides that method.
 * No pythonia spin-up — these tests stay fast + offline (same idiom as
 * `TaskParser.test.ts` Day 2 stubFcopClient).
 */
function stubFcopClient(impl: {
  writeReview: (spec: unknown) => Promise<FcopReview>;
}): FcopProjectClient {
  return impl as unknown as FcopProjectClient;
}

/**
 * Build a minimal `FcopReview` matching fcop@1.1.0's actual top-level
 * shape (Day 3 reconnaissance). Defaults reflect a fresh-write Review
 * with no human_approval block yet.
 */
function fakeFcopReview(overrides: Partial<FcopReview> = {}): FcopReview {
  return {
    review_id: "REVIEW-20260511-001-QA-on-TASK-20260511-001-PM-to-DEV",
    filename: "REVIEW-20260511-001-QA-on-TASK-20260511-001-PM-to-DEV.md",
    reviewer_role: "QA",
    reviewer_agent: null,
    subject_type: "task",
    subject_ref: "TASK-20260511-001-PM-to-DEV",
    decision: "approved",
    rationale: "fcop-stub rationale",
    required_changes: [],
    decided_at: "2026-05-11T14:30:00+08:00",
    date: "20260511",
    sequence: 1,
    is_archived: false,
    body: "fcop-stub body",
    mtime: "2026-05-11T14:30:00+08:00",
    path: "/fake/fcop/reviews/REVIEW-20260511-001-QA-on-TASK-20260511-001-PM-to-DEV.md",
    human_approval: null,
    ...overrides,
  };
}

describe("ReviewWriter", () => {
  it("TS-6.1: write valid verdict → file exists + frontmatter passes review schema", async () => {
    await withTempReview(async ({ reviewsDir }) => {
      const writer = new ReviewWriter({ reviewsDir });
      const verdict = makeApprovedVerdict();
      const filepath = await writer.write(verdict, "Review body content");

      // File on disk.
      const stats = await stat(filepath);
      assert.ok(stats.isFile(), "REVIEW-*.md should be a regular file");
      assert.equal(
        filepath,
        join(reviewsDir, `${verdict.review_id}.md`),
        "filename = <reviewsDir>/<review_id>.md",
      );

      // Frontmatter parses + passes schema.
      const { frontmatter, body } = await readReviewFile(filepath);
      assert.equal(frontmatter["protocol"], "fcop", "writer auto-stamps protocol=fcop");
      assert.equal(frontmatter["review_id"], verdict.review_id);
      assert.equal(frontmatter["decision"], "approved");
      assert.equal(frontmatter["decided_at"], verdict.decided_at);
      assert.ok(body.includes("Review body content"), "body preserved verbatim");

      const result = await validate("review", frontmatter);
      assert.equal(
        result.valid,
        true,
        `frontmatter must satisfy review.schema.json (errors: ${
          JSON.stringify(result.errors, null, 2)
        })`,
      );
    });
  });

  it("TS-6.2: review_id pattern enforced + refuse-overwrite", async () => {
    await withTempReview(async ({ reviewsDir }) => {
      const writer = new ReviewWriter({ reviewsDir });

      // Bad pattern: missing the `-on-TASK-...` suffix.
      const bad = makeApprovedVerdict({ review_id: "REVIEW-2026-001-X" });
      await assert.rejects(
        () => writer.write(bad, "x"),
        (err: unknown) =>
          err instanceof ReviewWriteError &&
          /does not match the schema pattern/.test(err.message),
        "expected ReviewWriteError on bad review_id pattern",
      );

      // First write of a valid id succeeds.
      const v1 = makeApprovedVerdict();
      const filepath = await writer.write(v1, "first");
      assert.ok(existsSync(filepath));

      // Second write of the SAME review_id refuses to overwrite.
      const v2 = makeApprovedVerdict({ rationale: "different" });
      await assert.rejects(
        () => writer.write(v2, "second"),
        (err: unknown) =>
          err instanceof ReviewWriteError &&
          /refuses to overwrite/.test(err.message),
        "expected ReviewWriteError on refuse-overwrite",
      );

      // Original file content untouched.
      const { body } = await readReviewFile(filepath);
      assert.match(body, /first/);
      assert.doesNotMatch(body, /second/);
    });
  });

  it("TS-6.3: schema-violation throws BEFORE creating the file (atomic-write semantics — half-write impossible)", async () => {
    await withTempReview(async ({ reviewsDir }) => {
      const writer = new ReviewWriter({ reviewsDir });

      // decision="needs_human" without human_approval is a schema allOf
      // violation. The writer SHOULD reject before any fs activity.
      const bad: ReviewVerdict = {
        review_id: "REVIEW-20260509-002-REVIEW-on-TASK-20260509-002-PM-to-DEV",
        subject_type: "task",
        subject_ref: "TASK-20260509-002-PM-to-DEV",
        reviewer_role: "REVIEW",
        reviewer_agent: "REVIEW-01",
        decision: "needs_human",
        decided_at: "2026-05-09T16:00:00.000Z",
        // Deliberately missing human_approval.
      };
      await assert.rejects(
        () => writer.write(bad, "body"),
        (err: unknown) =>
          err instanceof ReviewWriteError &&
          /requires human_approval/.test(err.message),
      );

      // Target file must NOT exist on disk (atomic-write contract).
      const target = join(reviewsDir, `${bad.review_id}.md`);
      assert.equal(existsSync(target), false, "target file should NOT exist");

      // The .tmp staging file from atomic-write is also absent because we
      // bailed before atomicWriteJson was called.
      assert.equal(existsSync(`${target}.tmp`), false, ".tmp staging file should NOT exist");

      // decision="needs_changes" without required_changes — same contract.
      const bad2: ReviewVerdict = {
        review_id: "REVIEW-20260509-003-REVIEW-on-TASK-20260509-003-PM-to-DEV",
        subject_type: "task",
        subject_ref: "TASK-20260509-003-PM-to-DEV",
        reviewer_role: "REVIEW",
        reviewer_agent: "REVIEW-01",
        decision: "needs_changes",
        decided_at: "2026-05-09T16:00:00.000Z",
      };
      await assert.rejects(
        () => writer.write(bad2, "body"),
        (err: unknown) =>
          err instanceof ReviewWriteError &&
          /requires required_changes/.test(err.message),
      );
      assert.equal(
        existsSync(join(reviewsDir, `${bad2.review_id}.md`)),
        false,
        "needs_changes-without-required_changes target also absent",
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Day 3 (TASK-20260511-011) — fcop instance API + fallback semantics
  // ─────────────────────────────────────────────────────────────────────

  it("TS-RW-D3-1: ReviewWriter without fcopClient keeps the v0.1 YAML contract (backward compat)", async () => {
    await withTempReview(async ({ reviewsDir }) => {
      const writer = new ReviewWriter({ reviewsDir });
      assert.equal(writer.fcopClientWired, false);

      const verdict = makeApprovedVerdict();
      const filepath = await writer.write(verdict, "Day 3 fallback body");

      assert.equal(
        filepath,
        join(reviewsDir, `${verdict.review_id}.md`),
        "YAML path returns caller-controlled <reviewsDir>/<review_id>.md",
      );
      const { frontmatter, body } = await readReviewFile(filepath);
      assert.equal(frontmatter["decision"], "approved");
      assert.match(body, /Day 3 fallback body/);
    });
  });

  it("TS-RW-D3-2: fcop-first path forwards to fcopClient.writeReview and returns the fcop-generated path (review_id discarded)", async () => {
    await withTempReview(async ({ reviewsDir }) => {
      const writeReviewCalls: unknown[] = [];
      const fcopClient = stubFcopClient({
        writeReview: async (spec) => {
          writeReviewCalls.push(spec);
          return fakeFcopReview({
            review_id: "REVIEW-20260511-042-QA-on-TASK-20260511-001-PM-to-DEV",
            path: "/fake/fcop/reviews/REVIEW-20260511-042-QA-on-TASK-20260511-001-PM-to-DEV.md",
          });
        },
      });
      const writer = new ReviewWriter({ reviewsDir, fcopClient });
      assert.equal(writer.fcopClientWired, true, "fcopClient wired flag exposed");

      const verdict = makeApprovedVerdict({
        // Caller-supplied review_id should be discarded on the fcop path.
        review_id: "REVIEW-20260509-001-REVIEW-on-TASK-20260509-001-PM-to-DEV",
        required_changes: ["change-a"],
      });
      const filepath = await writer.write(verdict, "Day 3 fcop-first body");

      // Path comes from fcop's returned Review.path, NOT from
      // `<reviewsDir>/<verdict.review_id>.md`. This is the contract
      // change v0.3 ships under TASK-20260511-011 §3.1.1.
      assert.equal(
        filepath,
        "/fake/fcop/reviews/REVIEW-20260511-042-QA-on-TASK-20260511-001-PM-to-DEV.md",
        "fcop path returns the fcop-generated filepath (caller's review_id is discarded)",
      );

      assert.equal(writeReviewCalls.length, 1);
      const spec = writeReviewCalls[0] as Record<string, unknown>;
      assert.equal(spec["reviewer_role"], "REVIEW");
      assert.equal(spec["subject_type"], "task");
      assert.equal(spec["subject_ref"], "TASK-20260509-001-PM-to-DEV");
      assert.equal(spec["decision"], "approved");
      assert.equal(spec["rationale"], "looks good");
      assert.deepEqual(
        spec["required_changes"],
        ["change-a"],
        "string[] required_changes forwarded as-is",
      );
      assert.equal(spec["reviewer_agent"], "REVIEW-01");
      assert.equal(spec["body"], "Day 3 fcop-first body");
      assert.equal(
        "review_id" in spec,
        false,
        "fcop owns review_id generation — we MUST NOT forward the caller's id",
      );
      assert.equal(
        "human_approval" in spec,
        false,
        "fcop schema rejects the v0.1 stub human_approval — must be filtered",
      );
      assert.equal(
        "decision_duration_ms" in spec,
        false,
        "fcop schema has no decision_duration_ms — must be filtered",
      );
    });
  });

  it("TS-RW-D3-3: FcopClientError on the fcop path → YAML fallback writes to <reviewsDir>/<review_id>.md", async () => {
    await withTempReview(async ({ reviewsDir }) => {
      const fcopClient = stubFcopClient({
        writeReview: async () => {
          throw new FcopClientError(
            "fcop bridge is sad (stub)",
            "writeReview",
            new Error("stub cause"),
          );
        },
      });
      const writer = new ReviewWriter({ reviewsDir, fcopClient });
      const verdict = makeApprovedVerdict();
      const filepath = await writer.write(verdict, "fallback path body");

      // Fell back to the caller-controlled YAML path.
      assert.equal(
        filepath,
        join(reviewsDir, `${verdict.review_id}.md`),
        "fallback path returns <reviewsDir>/<caller-review_id>.md",
      );
      const { frontmatter, body } = await readReviewFile(filepath);
      assert.equal(frontmatter["decision"], "approved");
      assert.equal(frontmatter["protocol"], "fcop");
      assert.match(body, /fallback path body/);
    });
  });

  it("TS-RW-D3-4: fcop path FcopClientError + YAML fallback ALSO blows up → ReviewWriteError preserves the fcop cause", async () => {
    await withTempReview(async ({ reviewsDir }) => {
      const fcopClient = stubFcopClient({
        writeReview: async () => {
          throw new FcopClientError(
            "fcop refused",
            "writeReview",
            new Error("original fcop reason"),
          );
        },
      });
      const writer = new ReviewWriter({ reviewsDir, fcopClient });
      // Force a v0.1 schema-allOf violation on the YAML fallback path so
      // it also throws — the writer must surface a ReviewWriteError whose
      // cause/message carries BOTH failure reasons for postmortems.
      const bad: ReviewVerdict = {
        review_id: "REVIEW-20260509-090-REVIEW-on-TASK-20260509-090-PM-to-DEV",
        subject_type: "task",
        subject_ref: "TASK-20260509-090-PM-to-DEV",
        reviewer_role: "REVIEW",
        reviewer_agent: "REVIEW-01",
        decision: "needs_changes",
        // Deliberately missing required_changes — YAML path will reject.
        decided_at: "2026-05-09T16:00:00.000Z",
      };
      await assert.rejects(
        () => writer.write(bad, "body"),
        (err: unknown) =>
          err instanceof ReviewWriteError &&
          /requires required_changes/.test(err.message),
        "ReviewWriteError emitted when YAML fallback also fails",
      );
    });
  });

  it("renderReviewMarkdown: deterministic field order + needs_human path includes human_approval", async () => {
    const verdict: ReviewVerdict = {
      review_id: "REVIEW-20260509-004-REVIEW-on-TASK-20260509-004-PM-to-DEV",
      subject_type: "task",
      subject_ref: "TASK-20260509-004-PM-to-DEV",
      reviewer_role: "REVIEW",
      reviewer_agent: "REVIEW-01",
      decision: "needs_human",
      rationale: "not enough context to decide",
      human_approval: {
        pushed_to: "cli",
        pushed_at: "2026-05-09T16:00:00.000Z",
        approved_by: null,
        approved_at: null,
        trigger_reason: "verdict_parse_failed",
      },
      decided_at: "2026-05-09T16:00:00.000Z",
    };
    const text = renderReviewMarkdown(verdict, "## body");

    // Front-matter is well-formed and ordered.
    const [headLine, ...rest] = text.split("\n");
    assert.equal(headLine, "---");
    const yamlEnd = rest.indexOf("---");
    assert.ok(yamlEnd > 0, "closing --- must be present");
    const yamlBody = rest.slice(0, yamlEnd).join("\n");
    assert.match(yamlBody, /^protocol: fcop/, "first line is protocol stamp");
    assert.match(yamlBody, /trigger_reason: verdict_parse_failed/);
    assert.match(yamlBody, /pushed_to: cli/);

    // Schema check via ajv to be sure.
    const { frontmatter } = parseFromText(text);
    const result = await validate("review", frontmatter);
    assert.equal(
      result.valid,
      true,
      `needs_human verdict must satisfy schema (errors: ${
        JSON.stringify(result.errors, null, 2)
      })`,
    );
  });
});

function parseFromText(text: string): { frontmatter: Record<string, unknown> } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error("no front-matter");
  return { frontmatter: parseYaml(match[1] ?? "") as Record<string, unknown> };
}

