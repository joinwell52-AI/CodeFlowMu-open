/**
 * ReviewWriter — persist `ReviewVerdict` records as `REVIEW-*.md` files
 * whose YAML front-matter conforms to `@codeflowmu/protocol/schemas/review.schema.json`.
 *
 * Scope (TASK-20260509-022 §主交付 1):
 *
 * - Filename format: `REVIEW-{date}-{seq}-{REVIEWER}-on-TASK-{date}-{seq}.md`,
 *   matching the schema's `review_id.pattern` regex
 *   (`^REVIEW-\d{8}-\d{3,}-[A-Z]+-on-TASK-\d{8}-\d{3,}.*$`).
 * - Front-matter is the YAML serialization of `ReviewVerdict` — the runtime
 *   contract mirrors the schema 1:1; we DO NOT redeclare schema fields here
 *   (per `types/state.ts` governance rule #1 — schema-mirrored fields come
 *   from `@codeflowmu/protocol`).
 * - Body is a free-form markdown blob (rationale + reviewer notes); the
 *   `additionalProperties: true` schema allows future extension fields,
 *   but v0.1 only writes the schema-defined fields verbatim.
 * - Writes use `atomicWriteJson` from `_internal/atomic-write.ts` (Phase A
 *   helper) — the helper writes utf-8 bodies as atomically as JSON despite
 *   the historical "Json" name; see helper docstring §"body any utf-8 string".
 * - Refuses to overwrite an existing `REVIEW-*.md` file with the same
 *   `review_id` (TS-6.2 + TASK-022 §主交付 1 implementation point).
 *
 * Reference:
 *   - `packages/codeflowmu-protocol/schemas/review.schema.json`
 *   - design doc §3.4 Review Schema
 *   - TASK-20260509-022 §主交付 1
 *
 * Ownership: `ReviewWriter` only knows about *persisting* verdicts. Deciding
 * the verdict shape (decision enum, rationale wording) belongs to
 * `ReviewEngine`; running the human-approval gate belongs to `NeedsHumanGate`.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { stringify as stringifyYaml } from "yaml";

import {
  FcopClientError,
  type FcopProjectClient,
} from "../_external/fcop-client.ts";
import { atomicWriteJson, cleanupTmp } from "../_internal/atomic-write.ts";
import { ReviewWriteError } from "../registry/errors.ts";

// ───────────────────────────────────────────────────────────────────────────
// Public types — mirror review.schema.json properties.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Subject of the review — what's being approved/rejected.
 * Mirrors `review.schema.json#properties.subject_type.enum`.
 */
export type ReviewSubjectType =
  | "task"
  | "code_change"
  | "report"
  | "role_switch";

/**
 * Verdict outcome enum.
 * Mirrors `review.schema.json#properties.decision.enum`.
 */
export type ReviewDecision =
  | "approved"
  | "rejected"
  | "needs_changes"
  | "abstained"
  | "needs_human";

/**
 * Human-approval block. Mirrors `review.schema.json#properties.human_approval`.
 *
 * Schema is `additionalProperties: false`, so the YAML emitter MUST NOT
 * leak any extra keys. Required: `pushed_to + pushed_at + trigger_reason`.
 */
export interface HumanApproval {
  pushed_to: "mobile" | "cli";
  pushed_at: string;
  approved_by?: string | null;
  approved_at?: string | null;
  trigger_reason: string;
}

/**
 * The verdict record that lands as YAML front-matter in `REVIEW-*.md`.
 *
 * Mirrors `review.schema.json#properties` (minus `$schema` and the v0.5+
 * `review_board` nested object, which v0.1 does not populate). The
 * `protocol` field is auto-stamped to `"fcop"` by the writer — callers
 * should NOT pass it.
 */
export interface ReviewVerdict {
  /** Pattern: `^REVIEW-\d{8}-\d{3,}-[A-Z]+-on-TASK-\d{8}-\d{3,}.*$`. */
  review_id: string;
  subject_type: ReviewSubjectType;
  /** ID of the object being reviewed (e.g. task_id). */
  subject_ref: string;
  /** Single-reviewer mode (v0.1 default). v0.5+ `review_board` lives in schema. */
  reviewer_role: string | null;
  reviewer_agent: string | null;
  decision: ReviewDecision;
  rationale?: string;
  /** Required when `decision === "needs_changes"` (schema allOf). */
  required_changes?: string | string[];
  /** Required when `decision === "needs_human"` (schema allOf). */
  human_approval?: HumanApproval;
  decided_at: string;
  decision_duration_ms?: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────────────

/**
 * Filename regex: must satisfy review.schema.json `review_id.pattern`.
 * The trailing `.md` is appended by the writer; the regex matches the bare
 * review_id (without extension).
 */
const REVIEW_ID_PATTERN = /^REVIEW-\d{8}-\d{3,}-[A-Z]+-on-TASK-\d{8}-\d{3,}.*$/;

/**
 * The schema field-set a v0.1 ReviewWriter emits. Future schema additions
 * (review_board, $schema URI) live here so an `unknown`-typed extension
 * field never silently leaks past the typed surface.
 */
const FRONTMATTER_FIELD_ORDER: (keyof Record<string, unknown>)[] = [
  "protocol",
  "review_id",
  "subject_type",
  "subject_ref",
  "reviewer_role",
  "reviewer_agent",
  "decision",
  "rationale",
  "required_changes",
  "human_approval",
  "decided_at",
  "decision_duration_ms",
];

// ───────────────────────────────────────────────────────────────────────────
// ReviewWriter
// ───────────────────────────────────────────────────────────────────────────

export interface ReviewWriterOptions {
  /**
   * Directory to write `REVIEW-*.md` files into. Created on first write
   * via the atomic-write helper (which calls `mkdir -p` for the parent).
   *
   * Honored on the YAML path AND when fcop falls back. On the fcop-first
   * path, fcop owns directory placement (typically
   * `<projectRoot>/<workspaceDir>/reviews/`) and `reviewsDir` is ignored.
   */
  reviewsDir: string;
  /**
   * P4 sprint Day 3 (TASK-20260511-011 §3.1.1) — optional fcop bridge.
   *
   * When supplied, `write(verdict, body)` first attempts to persist via
   * `fcopClient.writeReview()` (fcop owns review_id generation + directory
   * placement). On `FcopClientError`, the writer falls back to the v0.1
   * YAML path so that a degraded fcop bridge never breaks reviews — same
   * model as Day 2 `TaskParser`'s "Path A 改良" pattern.
   *
   * When omitted (default), the writer keeps the v0.1 YAML-only behavior
   * and the schema-mirrored, schema-validated, atomic-write contract that
   * Sprint S4 / BUG-SDK-001..007 baked into 197 regression tests.
   */
  fcopClient?: FcopProjectClient;
}

export class ReviewWriter {
  private readonly _reviewsDir: string;
  private readonly _fcopClient: FcopProjectClient | null;

  constructor(opts: ReviewWriterOptions) {
    this._reviewsDir = opts.reviewsDir;
    this._fcopClient = opts.fcopClient ?? null;
  }

  /**
   * Write a verdict + markdown body and return the absolute filepath the
   * REVIEW landed at.
   *
   * Routing (P4 Day 3):
   *   - If a `fcopClient` was supplied: try `fcopClient.writeReview()`
   *     first. The returned `FcopReview.path` is what we return. On
   *     `FcopClientError`, **fall back** to the v0.1 YAML path so a
   *     degraded fcop bridge never breaks reviews.
   *   - Otherwise: take the v0.1 YAML path directly (legacy contract,
   *     Sprint S4 197 tests).
   *
   * On the fcop path:
   *   - `verdict.review_id` is **discarded** — fcop owns id generation.
   *     The caller should treat the returned filepath as authoritative.
   *   - `verdict.human_approval` is **discarded** — fcop's schema
   *     forbids the v0.1 stub ack block; v0.3 routes through
   *     `NeedsHumanGate.markApproved()` → `fcopClient.markHumanApproved()`
   *     after the human acks.
   *   - `verdict.decision_duration_ms` is **discarded** — fcop schema
   *     doesn't carry it.
   *
   * @throws `ReviewWriteError` when:
   *   - `verdict.review_id` does not match the schema pattern
   *   - YAML path: the target file already exists (refuse to overwrite)
   *   - YAML path: schema allOf if/then violated (`needs_human` without
   *     `human_approval`, `needs_changes` without `required_changes`)
   *   - YAML path: the underlying atomic-write helper throws
   *   - fcop path AND fallback YAML path BOTH throw
   */
  async write(verdict: ReviewVerdict, body: string): Promise<string> {
    this._validate(verdict);

    if (this._fcopClient !== null) {
      try {
        return await this._writeViaFcop(verdict, body);
      } catch (err) {
        if (err instanceof FcopClientError) {
          // fcop is degraded — fall through to YAML path so reviews still
          // land somewhere durable. The fcop error is preserved as `cause`
          // when the YAML path ALSO fails (see _writeYaml).
          return this._writeYaml(verdict, body, err);
        }
        throw err;
      }
    }

    return this._writeYaml(verdict, body);
  }

  /**
   * Convenience: directory the writer is currently configured to use.
   * Exposed so tests / Runtime.start() can log it.
   */
  get reviewsDir(): string {
    return this._reviewsDir;
  }

  /**
   * Convenience: whether this writer has an active fcop bridge wire-up.
   * Tests + Runtime.start() can log it; v0.3 `Task parser:` banner uses
   * the same idiom for transparency.
   */
  get fcopClientWired(): boolean {
    return this._fcopClient !== null;
  }

  // ── private ──────────────────────────────────────────────────────────

  /**
   * fcop-first path. Forwards the verdict + body through
   * `FcopProjectClient.writeReview()`. fcop owns id generation +
   * directory placement, so the returned `FcopReview.path` is what we
   * give back to the caller (instead of `<reviewsDir>/<review_id>.md`).
   *
   * v0.1 fields fcop's `write_review` does NOT accept are discarded:
   *   - `verdict.review_id` — fcop generates its own
   *   - `verdict.human_approval` — fcop ack goes through
   *     `mark_human_approved()` post-write
   *   - `verdict.decision_duration_ms` — not in fcop schema
   */
  private async _writeViaFcop(
    verdict: ReviewVerdict,
    body: string,
  ): Promise<string> {
    if (this._fcopClient === null) {
      // Guarded by caller (`write`) — defensive only.
      throw new ReviewWriteError(
        verdict.review_id,
        "internal: _writeViaFcop called without a fcopClient",
      );
    }
    const reviewerRole = verdict.reviewer_role ?? "UNKNOWN";
    const requiredChanges = normalizeRequiredChanges(verdict.required_changes);
    const review = await this._fcopClient.writeReview({
      reviewer_role: reviewerRole,
      subject_type: verdict.subject_type,
      subject_ref: verdict.subject_ref,
      decision: verdict.decision,
      ...(verdict.rationale !== undefined
        ? { rationale: verdict.rationale }
        : {}),
      ...(requiredChanges !== undefined
        ? { required_changes: requiredChanges }
        : {}),
      ...(verdict.reviewer_agent !== undefined &&
      verdict.reviewer_agent !== null
        ? { reviewer_agent: verdict.reviewer_agent }
        : {}),
      body,
    });
    return review.path;
  }

  /**
   * v0.1 YAML path — the legacy `<reviewsDir>/<review_id>.md` writer.
   * Used directly when `fcopClient` is null, and as a fallback when the
   * fcop path raises `FcopClientError`.
   *
   * @param fcopCause When called as a fallback, the original
   *   `FcopClientError` that triggered the fallback. Preserved as
   *   `cause` on any subsequent `ReviewWriteError` so postmortems see
   *   both failures.
   */
  private async _writeYaml(
    verdict: ReviewVerdict,
    body: string,
    fcopCause?: unknown,
  ): Promise<string> {
    const filename = `${verdict.review_id}.md`;
    const filepath = join(this._reviewsDir, filename);

    // Refuse-to-overwrite check. We use stat+ENOENT instead of access(F_OK)
    // because `fs.access` returns void on success — we need the negative
    // signal ("file does not exist") which stat exposes via ENOENT.
    try {
      await fs.stat(filepath);
      throw new ReviewWriteError(
        verdict.review_id,
        `target file already exists at "${filepath}"; ReviewWriter refuses to overwrite` +
          (fcopCause
            ? ` (fcop fallback path; fcop error: ${
                fcopCause instanceof Error ? fcopCause.message : String(fcopCause)
              })`
            : ""),
        fcopCause !== undefined ? { cause: fcopCause } : undefined,
      );
    } catch (err) {
      if (err instanceof ReviewWriteError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw new ReviewWriteError(
          verdict.review_id,
          `stat probe failed for "${filepath}": ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
      // ENOENT = OK to write. fall through.
    }

    // v0.1 schema enforces `needs_human → human_approval` and
    // `needs_changes → required_changes`. The fcop-first path discards
    // both of those fields (fcop has its own ack flow) — so v0.1 schema
    // checks belong HERE, on the YAML path, not in the shared validate.
    if (verdict.decision === "needs_human" && !verdict.human_approval) {
      throw new ReviewWriteError(
        verdict.review_id,
        `decision="needs_human" requires human_approval (schema allOf #1)`,
        fcopCause !== undefined ? { cause: fcopCause } : undefined,
      );
    }
    if (
      verdict.decision === "needs_changes" &&
      verdict.required_changes === undefined
    ) {
      throw new ReviewWriteError(
        verdict.review_id,
        `decision="needs_changes" requires required_changes (schema allOf #2)`,
        fcopCause !== undefined ? { cause: fcopCause } : undefined,
      );
    }

    // Build the file contents: `---\n<yaml>\n---\n\n<body>\n`.
    const fileBody = renderReviewMarkdown(verdict, body);

    try {
      await atomicWriteJson(filepath, fileBody);
    } catch (err) {
      // Best-effort: clean the .tmp staging file so a later retry is clean.
      await cleanupTmp(filepath);
      throw new ReviewWriteError(
        verdict.review_id,
        `atomic write failed: ${err instanceof Error ? err.message : String(err)}` +
          (fcopCause
            ? ` (fcop fallback path; fcop error: ${
                fcopCause instanceof Error ? fcopCause.message : String(fcopCause)
              })`
            : ""),
        { cause: fcopCause ?? err },
      );
    }

    return filepath;
  }

  /**
   * Schema-light validation that mirrors review.schema.json's `if/then`
   * + pattern constraints. We deliberately do NOT pull ajv here — the
   * writer is in a fast path (one ReviewEngine emits → one write per
   * settled session), and the runtime's pattern is "validate at the
   * protocol boundary, trust internally" (see types/state.ts rule #1).
   *
   * P4 Day 3 split: the `needs_human → human_approval` and
   * `needs_changes → required_changes` schema-allOf checks moved into
   * `_writeYaml` because the fcop path enforces them server-side and
   * happily writes `needs_human` verdicts without a v0.1 stub
   * human_approval block (the fcop ack flow handles it post-write).
   */
  private _validate(verdict: ReviewVerdict): void {
    if (!REVIEW_ID_PATTERN.test(verdict.review_id)) {
      throw new ReviewWriteError(
        verdict.review_id,
        `review_id="${verdict.review_id}" does not match the schema pattern ` +
          `"^REVIEW-\\d{8}-\\d{3,}-[A-Z]+-on-TASK-\\d{8}-\\d{3,}.*$" ` +
          `(see review.schema.json)`,
      );
    }

    // Sanity: the parent directory of reviewsDir is consistent. This
    // sanity check still runs on the fcop path because `reviewsDir` is
    // the YAML-fallback target — a misconfigured runtime would lose
    // reviews on a degraded fcop bridge if we skipped it.
    if (!this._reviewsDir || dirname(this._reviewsDir) === this._reviewsDir) {
      throw new ReviewWriteError(
        verdict.review_id,
        `reviewsDir="${this._reviewsDir}" is invalid`,
      );
    }
  }
}

/**
 * fcop's `write_review` takes `required_changes: Sequence[str]`. The v0.1
 * verdict shape allows either `string` (when a caller forgot it was a
 * list) or `string[]` (schema-correct). Normalize to `string[]` for the
 * fcop path; `undefined` stays `undefined` so we don't accidentally
 * write an empty list when the caller never set the field.
 */
function normalizeRequiredChanges(
  rc: string | string[] | undefined,
): string[] | undefined {
  if (rc === undefined) return undefined;
  if (Array.isArray(rc)) return rc;
  return [rc];
}

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers — exported for tests + the schema-light front-matter shape
// can be unit-tested without filesystem.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build a YAML-front-matter + markdown-body file body.
 *
 * Output shape:
 *   ---
 *   <yaml>
 *   ---
 *
 *   <body>
 *
 * Trailing newline guaranteed (so `state_history`-style appenders never
 * have to second-guess whether the file ends in `\n`).
 */
export function renderReviewMarkdown(
  verdict: ReviewVerdict,
  body: string,
): string {
  const frontmatter: Record<string, unknown> = { protocol: "fcop" };

  // Stamp fields in stable order so diffs across runs read predictably.
  for (const key of FRONTMATTER_FIELD_ORDER) {
    if (key === "protocol") continue;
    const value = (verdict as unknown as Record<string, unknown>)[key as string];
    if (value !== undefined) frontmatter[key as string] = value;
  }

  const yamlBody = stringifyYaml(frontmatter, {
    // Plain-style strings whenever possible; quote when needed (e.g. ISO
    // timestamps that contain a colon — yaml@^2 handles this automatically).
    lineWidth: 0,
  });

  // yaml.stringify always ends with `\n`; we still defensively strip and
  // re-add to keep `---\n<yaml>\n---` invariant under future yaml versions.
  const yamlBodyTrimmed = yamlBody.replace(/\n+$/, "");

  const mdBody = body.endsWith("\n") ? body : `${body}\n`;

  return `---\n${yamlBodyTrimmed}\n---\n\n${mdBody}`;
}

