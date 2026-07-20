/**
 * Named error classes for the AgentRegistry / RuntimeBootstrap surface.
 *
 * Why named classes (instead of one generic `Error`):
 *
 * - Tests `assert.throws(fn, ValidationError)` — class identity is the
 *   only stable assertion handle (message strings drift over time).
 * - Callers (Mobile push, audit log, stdout summary) switch on `instanceof`
 *   to choose user-facing wording without parsing strings.
 * - `crash-recovery.md` decision 2 mandates "HARD FAIL on agents.json
 *   corruption" — distinguishing `RuntimeBootstrapError` from a normal
 *   per-record `RegistryWriteError` is what makes that mandate testable.
 *
 * All error classes here are `@codeflowmu/runtime`-private. No FCoP schema
 * leakage. Per design doc §8.0 hard rule #4, schema-level error types
 * (if any are ever needed) live in `@codeflowmu/protocol`.
 */

/**
 * Thrown when an input fails ajv validation against a `@codeflowmu/protocol`
 * schema. The message is the human-readable summary; structured detail
 * lives on the `errors` field.
 *
 * Used by: `AgentRegistry.register` (rejecting bad `agentSpec`).
 */
export class ValidationError extends Error {
  override readonly name = "ValidationError";
  /** Raw ajv error objects, in the order ajv returned them. */
  readonly errors: unknown[];

  constructor(message: string, errors: unknown[]) {
    super(message);
    this.errors = errors;
  }
}

/**
 * Thrown when a caller tries to `register({ layer: "admin" })`. Admin-layer
 * agents are spawned by the human ADMIN entry only — never by the runtime
 * (§0.9.1 + design doc §3.2 layer enforcement).
 *
 * Implementation MUST throw this BEFORE calling the SDK adapter, otherwise
 * we leak SDK quota to a request the runtime is going to refuse. Test
 * scenario 3 in TASK-009 checks exactly this property.
 */
export class LayerViolationError extends Error {
  override readonly name = "LayerViolationError";
  readonly attemptedLayer: string;

  constructor(attemptedLayer: string, message?: string) {
    super(
      message ??
        `agents with layer="${attemptedLayer}" cannot be spawned via the runtime; ` +
          "admin-layer agents are reserved for the human ADMIN entry (see design doc §0.9.1).",
    );
    this.attemptedLayer = attemptedLayer;
  }
}

/**
 * Thrown when `resume`, `updateRuntimeBinding`, or `markFailed` is called
 * with an `agent_id` not present in `agents.json`.
 *
 * `AgentRegistry.get` deliberately does NOT throw this — it returns `null`
 * for the "is this agent registered yet?" probe. Throwing is reserved for
 * methods where the missing record is a contract violation, not a query.
 */
export class AgentNotFoundError extends Error {
  override readonly name = "AgentNotFoundError";
  readonly agentId: string;

  constructor(agentId: string) {
    super(`agent_id="${agentId}" is not registered in agents.json`);
    this.agentId = agentId;
  }
}

/**
 * Thrown when the persistent store cannot make a write durable.
 *
 * NOTE: by atomic-rename design (decision 1), the on-disk `agents.json`
 * is NEVER half-written when this throws — the temp file may linger as
 * a diagnostic but the active `agents.json` is exactly what it was
 * before the failed write. Tests rely on that property (scenario 4 +
 * scenario 10).
 */
export class RegistryWriteError extends Error {
  override readonly name = "RegistryWriteError";
  override readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * Thrown when `RuntimeBootstrap.run()` cannot proceed past step 1
 * (`PersistentStore.loadAll()`). Examples: `agents.json` is corrupt
 * JSON, the schema-validation phase failed catastrophically, etc.
 *
 * `crash-recovery.md` decision 2 explicitly forbids "half-started"
 * states — the caller (typically `bin/codeflowmu-runtime`) must
 * `process.exit(1)` and let the operator triage manually.
 */
export class RuntimeBootstrapError extends Error {
  override readonly name = "RuntimeBootstrapError";
  override readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * Thrown when `AgentRegistry.register` is called while
 * `RuntimeBootstrap.run()` is still in progress. This is the explicit
 * race-defense from `crash-recovery.md` decision 2 ("Reconciliation is
 * synchronous — must finish before accepting new requests").
 *
 * Callers should retry after the bootstrap report is observed (or, more
 * commonly, structure their startup so register() simply isn't called
 * inside `RuntimeBootstrap.run()`).
 */
export class RuntimeNotReadyError extends Error {
  override readonly name = "RuntimeNotReadyError";

  constructor(message?: string) {
    super(
      message ??
        "RuntimeBootstrap.run() is in progress; AgentRegistry.register() is not allowed until reconciliation finishes.",
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Session-layer errors (Sprint S3 Phase B)
//
// Co-located with the registry error file deliberately: same governance
// rationale (named-class identity for `assert.rejects` + `instanceof`
// dispatch in Mobile push / audit log), and consumers tend to import a
// single error module rather than two. If the session layer ever grows a
// large error vocabulary we can split, but Phase B (3 deliverables) keeps
// the count low — see decision J in REPORT-20260509-013.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Thrown when `SessionManager.cancelSession` (or any other session op
 * that requires an existing record) is called with a `session_id` not
 * present in the SessionStore.
 *
 * `getSession` deliberately does NOT throw this — it returns `null` for
 * the "is this session known?" probe (symmetric with `AgentRegistry.get`).
 * Throwing is reserved for methods where the missing record is a contract
 * violation, not a query.
 */
export class SessionNotFoundError extends Error {
  override readonly name = "SessionNotFoundError";
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`session_id="${sessionId}" is not present in SessionStore`);
    this.sessionId = sessionId;
  }
}

/**
 * Thrown when `SessionManager.startSession` is invoked against an agent
 * whose protocol-level `status` is not in the allow-list (`idle | error`).
 *
 * Phase B default = serial sessions per agent (TASK-013 §主交付 1
 * key invariant: "不允许 startSession on running, 除非 §3.2 explicit
 * concurrency 允许"). `_attemptedStatus` lets callers route the error
 * to a useful Mobile push message ("agent is still running task X" vs.
 * "agent is in failed state, requires manual reset").
 */
export class InvalidAgentStatusError extends Error {
  override readonly name = "InvalidAgentStatusError";
  readonly agentId: string;
  readonly attemptedStatus: string;
  readonly allowedStatuses: readonly string[];

  constructor(
    agentId: string,
    attemptedStatus: string,
    allowedStatuses: readonly string[],
  ) {
    super(
      `agent_id="${agentId}" is in status="${attemptedStatus}"; ` +
        `startSession requires status ∈ {${allowedStatuses.join(", ")}} ` +
        `(see TASK-20260509-013 §主交付 1 invariant: serial sessions per agent).`,
    );
    this.agentId = agentId;
    this.attemptedStatus = attemptedStatus;
    this.allowedStatuses = allowedStatuses;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Scheduler-layer errors (Sprint S3 Phase C)
//
// Co-located with the registry/session error file per Phase B decision J:
// callers tend to import a single error module; keeping the scheduler error
// surface here means downstream code (Mobile push, audit log) only needs one
// `import { ... } from "@codeflowmu/runtime/registry/errors"` line.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Thrown when `TaskParser.parse` cannot read or interpret a Task file.
 *
 * Two failure modes:
 *
 * 1. The YAML front-matter exists but is malformed (e.g. unbalanced quotes,
 *    duplicate keys). The `cause` is the underlying yaml-parser error.
 * 2. A field that's expected to be typed (e.g. `priority`, `recipient`)
 *    has a wrong shape and the caller asked for strict mode (Phase C
 *    default = lenient — see `TaskParser.parse` doc).
 *
 * Note that "no front-matter at all" is NOT an error — `TaskParser` returns
 * `frontmatter: {}` and the full body in that case (per TASK-018 §主交付 2
 * implementation point: "tolerate files without front-matter").
 */
export class TaskParseError extends Error {
  override readonly name = "TaskParseError";
  readonly filepath: string;
  override readonly cause?: unknown;

  constructor(filepath: string, message: string, options?: { cause?: unknown }) {
    super(`TaskParser failed for "${filepath}": ${message}`);
    this.filepath = filepath;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * Thrown when `StateHistoryWriter.append` is asked to append to a Task file
 * that no longer exists on disk (the watcher may have seen it briefly during
 * a `git checkout` flicker, or the file was unlinked between dispatch and
 * settlement).
 *
 * The dispatcher MUST catch this and degrade to a logger.warn — it's never
 * a runtime-fatal error (a missing file just means we lost the audit trail
 * for that one task; the next chokidar add re-creates the dispatch path).
 */
export class TaskFileNotFoundError extends Error {
  override readonly name = "TaskFileNotFoundError";
  readonly filepath: string;
  override readonly cause?: unknown;

  constructor(filepath: string, options?: { cause?: unknown }) {
    super(`Task file not found at "${filepath}" (expected for state_history append)`);
    this.filepath = filepath;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Review-layer errors (Sprint S4 — TASK-022 §主交付 1/3 + 错误类清单)
//
// Co-located per Phase B/C decision J: same governance rationale (single
// import surface for Mobile push / audit log dispatch). Three classes pin
// the three failure modes the v0.1 ReviewEngine must distinguish:
//
//   * `ReviewWriteError`        — fs / atomic-write failed for REVIEW-*.md
//   * `ReviewerNotFoundError`   — pickReviewer resolved a role with no agent
//   * `VerdictParseError`       — reviewer's stdout did not match the v0.1
//                                 "VERDICT: <decision>; RATIONALE: <text>"
//                                 contract (NeedsHumanGate fallback fires)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Thrown when `ReviewWriter.write` cannot persist a `REVIEW-*.md` file.
 *
 * Mirrors `RegistryWriteError` semantics: by atomic-rename design the
 * on-disk REVIEW-*.md file is NEVER half-written when this throws — the
 * `.tmp` staging file may linger as a diagnostic but no other consumer
 * can ever read a partial REVIEW. Tests rely on this property (TS-6.3).
 *
 * Caller (typically `ReviewEngine`) MUST surface as a logger.error +
 * fall back to NeedsHumanGate ("verdict cannot be persisted"), so the
 * audit trail records the gap explicitly.
 */
export class ReviewWriteError extends Error {
  override readonly name = "ReviewWriteError";
  readonly reviewId: string;
  override readonly cause?: unknown;

  constructor(reviewId: string, message: string, options?: { cause?: unknown }) {
    super(`ReviewWriter failed for review_id="${reviewId}": ${message}`);
    this.reviewId = reviewId;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * Thrown when `ReviewEngine`'s policy resolves a reviewer role
 * (e.g. `"REVIEW"`) but the AgentRegistry has no matching agent.
 *
 * Per TASK-022 §主交付 3 step 3, the `ReviewEngine` catches this and
 * falls back to `NeedsHumanGate.push({ trigger_reason: "reviewer_not_found" })`
 * — the engine NEVER lets a missing reviewer drop a verdict on the floor.
 * The class identity is what TS-6.8 asserts on.
 */
export class ReviewerNotFoundError extends Error {
  override readonly name = "ReviewerNotFoundError";
  readonly reviewerRole: string;
  readonly subjectRef: string;

  constructor(reviewerRole: string, subjectRef: string) {
    super(
      `no agent registered for reviewer_role="${reviewerRole}" ` +
        `(reviewing subject_ref="${subjectRef}")`,
    );
    this.reviewerRole = reviewerRole;
    this.subjectRef = subjectRef;
  }
}

/**
 * Thrown when `ReviewEngine` cannot extract a valid `decision` from the
 * reviewer agent's stdout.
 *
 * v0.1 contract is the simplest thing that can possibly work — the
 * reviewer is expected to emit a single line matching:
 *
 *   `VERDICT: <approved|rejected|needs_changes|abstained|needs_human>;` +
 *   `[RATIONALE: <text>]`
 *
 * v0.2 will replace this with the reviewer agent writing a full REVIEW-*.md
 * file directly. Until then, a parse failure routes to NeedsHumanGate
 * with `trigger_reason: "verdict_parse_failed"` (TS-6.9).
 */
export class VerdictParseError extends Error {
  override readonly name = "VerdictParseError";
  readonly subjectRef: string;
  readonly rawOutput: string;

  constructor(subjectRef: string, rawOutput: string, message?: string) {
    super(
      message ??
        `failed to parse reviewer verdict for subject_ref="${subjectRef}"; ` +
          `expected line matching "VERDICT: <decision>; [RATIONALE: ...]" ` +
          `(got ${rawOutput.length} chars; first 80: ${rawOutput.slice(0, 80).replace(/\s+/g, " ")})`,
    );
    this.subjectRef = subjectRef;
    this.rawOutput = rawOutput;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Skill-runtime errors (Sprint S5 — TASK-024 §主交付 1/2/3 + 错误类清单)
//
// Co-located here per decision J (Phase B → C → D → E sequence): named
// errors for each subsystem live in this single file rather than a
// per-subsystem `*-errors.ts`. Adds 3 classes — final count is 17
// (Phase A 6 + B 2 + C 2 + D 4 + E 3).
// ───────────────────────────────────────────────────────────────────────────

/**
 * Thrown by `AgentRegistry.register` when the agent's `skills` list does
 * not satisfy the v0.1 fcop-mcp hard-dependency rule (design doc §0.5 +
 * §0.7.5 + skill.schema.json `required_kernel.contains: "^fcop@.+"`).
 *
 * Three sub-reasons are carried via the `reason` field — callers
 * (Mobile, audit log, stdout summary) switch on `instanceof` first then
 * read `reason` for user-facing wording. Per decision S, the throw
 * happens AFTER agent-schema validation but BEFORE `SDK.create`, so SDK
 * quota is preserved on failed registers (mirrors the layer=admin
 * preflight check in TS-2.3 / register scenario 3).
 */
export class KernelDependencyError extends Error {
  override readonly name = "KernelDependencyError";
  readonly agentId: string;
  readonly reason:
    | "no_fcop_skill"
    | "skill_not_found"
    | "no_compatible_runtime";
  readonly detail: string;

  constructor(
    agentId: string,
    reason:
      | "no_fcop_skill"
      | "skill_not_found"
      | "no_compatible_runtime",
    detail: string,
  ) {
    super(
      `agent_id="${agentId}" rejected by KernelDependencyValidator ` +
        `(reason=${reason}): ${detail}`,
    );
    this.agentId = agentId;
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Thrown by `MCPInjector` constructor when a caller asks for `mode: "live"`
 * before v0.2 wires the real `@cursor/sdk` MCP runtime (decision T:
 * eager-throw at ctor-time, not at first `mount` call).
 *
 * Same posture as `UnsupportedHumanPushSinkError` (decision O): we'd
 * rather fail loud at composition time than have a silent v0.1 deployment
 * call `mount()` and discover later that no MCP server was actually
 * spawned.
 */
export class MCPInjectorLiveModeNotImplementedError extends Error {
  override readonly name = "MCPInjectorLiveModeNotImplementedError";

  constructor(message?: string) {
    super(
      message ??
        `MCPInjector mode="live" is reserved for v0.2 (real @cursor/sdk MCP runtime). ` +
          `v0.1 only supports mode="stub". See design doc §0.7.5 + §10.2 S5 row + TASK-024 §主交付 3.`,
    );
  }
}

/**
 * Thrown by `SkillRegistry.load` when a single skill file fails ajv
 * validation against `@codeflowmu/protocol` `skill` schema.
 *
 * Tolerant-read contract (TASK-024 §主交付 1 line 73): the registry does
 * NOT propagate this — it logs `logger.warn` and pushes the file to the
 * `skipped[]` audit list. The class is exported so tests
 * (TS-7.2) can `assert.throws(() => loadOne(badJson), SkillSchemaError)`
 * against the inner helper, mirroring `ReviewWriteError`'s test posture.
 */
export class SkillSchemaError extends Error {
  override readonly name = "SkillSchemaError";
  readonly file: string;
  readonly errors: unknown[];

  constructor(file: string, errors: unknown[], message?: string) {
    super(
      message ??
        `skill file ${file} failed @codeflowmu/protocol skill schema ` +
          `(${errors.length} error(s))`,
    );
    this.file = file;
    this.errors = errors;
  }
}

