import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  atomicWriteFcopMarkdown,
  atomicWriteJson,
  parseMarkdownFrontmatter,
} from "@codeflowmu/runtime";
import { stringify as stringifyYaml } from "yaml";

import { findTaskFileByIdPrefix } from "./fcop-v3-paths.ts";

export const ISSUE_RESOLUTION_TYPES = [
  "fixed",
  "mitigated",
  "workaround",
  "duplicate",
  "not_reproducible",
  "invalid",
  "accepted_risk",
  "superseded",
] as const;

export const ISSUE_ROOT_CAUSE_STATUSES = [
  "unknown",
  "not_fixed",
  "partially_fixed",
  "fixed",
  "accepted_risk",
] as const;

export const ISSUE_EVENT_STATUSES = [
  "open",
  "closure_pending",
  "closed",
  "reopened",
] as const;

export const ISSUE_PROMOTION_STATUSES = [
  "not_promoted",
  "draft_created",
  "exported",
  "import_pending",
  "imported",
  "rejected",
  "published",
  "publish_failed_retryable",
] as const;

export type IssueResolutionType = (typeof ISSUE_RESOLUTION_TYPES)[number];
export type IssueRootCauseStatus = (typeof ISSUE_ROOT_CAUSE_STATUSES)[number];
export type IssueEventStatus = (typeof ISSUE_EVENT_STATUSES)[number];
export type IssuePromotionStatus = (typeof ISSUE_PROMOTION_STATUSES)[number];

export type IssueClosureEvidence = {
  type: string;
  ref: string;
  note?: string;
};

export type IssueClosureDraft = {
  actor: string;
  idempotency_key: string;
  expected_issue_digest: string;
  expected_closure_digest?: string;
  resolution_type: IssueResolutionType;
  root_cause_status: IssueRootCauseStatus;
  root_cause_category?: string;
  root_cause_summary?: string;
  reason: string;
  recovery_action?: string;
  verification_summary?: string;
  evidence: IssueClosureEvidence[];
  residual_risk?: string;
  follow_up_required: boolean;
  follow_up_target?: string;
  follow_up_reference?: string;
  replacement_target?: string;
  reopen_conditions: string[];
  unblock_task: boolean;
  unblock_reason?: string;
  fix_commit?: string;
  fix_version?: string;
  environment?: string;
  reproduction_attempts?: number;
  observation_window?: string;
  risk_decider?: string;
  risk_expires_at?: string;
  risk_review_condition?: string;
  authority_scope?: string;
  promote_to_mother: boolean;
};

export type IssueTaskUnblockPreview = {
  requested: boolean;
  task_id?: string;
  task_path?: string;
  task_digest?: string;
  lifecycle?: string;
  blocker_issue_id?: string;
  already_recovered?: boolean;
  will_write?: boolean;
  diff?: Record<string, { from: unknown; to: unknown }>;
};

export type IssueClosurePreview = {
  ok: true;
  filename: string;
  issue_id: string;
  issue_digest: string;
  attempt: number;
  closure_id: string;
  closure_record: string;
  closure_digest: string;
  request_digest: string;
  normalized: IssueClosureDraft;
  issue_frontmatter_diff: Record<string, { from: unknown; to: unknown }>;
  task_unblock: IssueTaskUnblockPreview;
  negative_candidates: string[];
  required_authority: string;
  required_approval: boolean;
  non_effects: string[];
  closure_body: string;
};

export type IssueClosureRecord = Record<string, unknown> & {
  kind: "issue_closure";
  closure_id: string;
  closure_digest: string;
  source_issue_id: string;
  source_issue_path: string;
  source_issue_digest: string;
  attempt: number;
};

export type IssueClosureResult = {
  ok: true;
  filename: string;
  status: "closed";
  closure_record: string;
  closure_digest: string;
  closure_id: string;
  attempt: number;
  idempotent: boolean;
  already_closed?: boolean;
  task_side_effect: Record<string, unknown>;
};

export type IssueClosureFault =
  | "after_closure_record"
  | "after_issue_projection"
  | "before_task_unblock"
  | "after_task_unblock"
  | "before_audit_event";

export class IssueClosureError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "IssueClosureError";
  }
}

export type IssueClosureServiceOptions = {
  projectRoot: string;
  now?: () => Date;
  faultInjector?: (point: IssueClosureFault) => void | Promise<void>;
};

const issueLocks = new Map<string, Promise<void>>();

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

function digestObject(value: unknown): string {
  return sha256Text(JSON.stringify(stable(value)));
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function bool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return /^(?:true|1|yes|on)$/i.test(text(value));
}

function stringList(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : text(value)
      ? text(value).split(/\r?\n|,/)
      : [];
  return [...new Set(values.map(text).filter(Boolean))];
}

function evidenceList(value: unknown): IssueClosureEvidence[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): IssueClosureEvidence | null => {
      if (typeof item === "string") {
        const ref = item.trim();
        return ref ? { type: "reference", ref } : null;
      }
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const type = text(row.type).toLowerCase();
      const ref = text(row.ref);
      if (!type || !ref) return null;
      const note = text(row.note);
      return { type, ref, ...(note ? { note } : {}) };
    })
    .filter((item): item is IssueClosureEvidence => item !== null);
}

function normalizeFollowUp(raw: Record<string, unknown>): {
  required: boolean;
  target: string;
  reference: string;
} {
  const nested = raw.follow_up && typeof raw.follow_up === "object"
    ? raw.follow_up as Record<string, unknown>
    : {};
  const target = text(raw.follow_up_target ?? nested.target);
  const reference = text(raw.follow_up_reference ?? nested.reference ?? nested.ref);
  return {
    required: bool(raw.follow_up_required ?? nested.required) || Boolean(target || reference),
    target,
    reference,
  };
}

export function normalizeIssueClosureDraft(raw: unknown): IssueClosureDraft {
  const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const followUp = normalizeFollowUp(row);
  return {
    actor: text(row.actor ?? row.closed_by ?? row.operator),
    idempotency_key: text(row.idempotency_key),
    expected_issue_digest: text(row.expected_issue_digest),
    expected_closure_digest: text(row.expected_closure_digest) || undefined,
    resolution_type: text(row.resolution_type).toLowerCase() as IssueResolutionType,
    root_cause_status: text(row.root_cause_status || "unknown").toLowerCase() as IssueRootCauseStatus,
    root_cause_category: text(row.root_cause_category) || undefined,
    root_cause_summary: text(row.root_cause_summary) || undefined,
    reason: text(row.reason ?? row.resolution),
    recovery_action: text(row.recovery_action) || undefined,
    verification_summary: text(row.verification_summary) || undefined,
    evidence: evidenceList(row.evidence),
    residual_risk: text(row.residual_risk) || undefined,
    follow_up_required: followUp.required,
    follow_up_target: followUp.target || undefined,
    follow_up_reference: followUp.reference || undefined,
    replacement_target: text(row.replacement_target ?? row.duplicate_target ?? row.superseded_by) || undefined,
    reopen_conditions: stringList(row.reopen_conditions),
    unblock_task: bool(row.unblock_task),
    unblock_reason: text(row.unblock_reason) || undefined,
    fix_commit: text(row.fix_commit) || undefined,
    fix_version: text(row.fix_version) || undefined,
    environment: text(row.environment) || undefined,
    reproduction_attempts: Number(row.reproduction_attempts ?? 0) || undefined,
    observation_window: text(row.observation_window) || undefined,
    risk_decider: text(row.risk_decider) || undefined,
    risk_expires_at: text(row.risk_expires_at) || undefined,
    risk_review_condition: text(row.risk_review_condition) || undefined,
    authority_scope: text(row.authority_scope) || undefined,
    promote_to_mother: bool(row.promote_to_mother),
  };
}

function bodyOf(raw: string): string {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

function yamlScalar(value: unknown): string {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const raw = String(value ?? "");
  return /^[A-Za-z0-9_.:/@+-]+$/.test(raw) && raw.length > 0
    ? raw
    : JSON.stringify(raw);
}

function patchFrontmatter(raw: string, fields: Record<string, unknown>): string {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(raw);
  if (!match) {
    const lines = Object.entries(fields).map(([key, value]) => `${key}: ${yamlScalar(value)}`);
    return `---\n${lines.join("\n")}\n---\n${raw}`;
  }
  let yamlBody = match[2] ?? "";
  for (const [key, value] of Object.entries(fields)) {
    const replacement = `${key}: ${yamlScalar(value)}`;
    const matcher = new RegExp(`^${key}:\\s*.*$`, "m");
    yamlBody = matcher.test(yamlBody)
      ? yamlBody.replace(matcher, replacement)
      : `${yamlBody.replace(/\s+$/, "")}\n${replacement}`;
  }
  return `${match[1]}${yamlBody}${match[3]}${raw.slice(match[0].length)}`;
}

function renderMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${body.trim()}\n`;
}

function relativePortable(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function safeIssueFilename(filename: string): string {
  const value = text(filename);
  if (!/^ISSUE-\d{8}-\d{3}-.+\.md$/i.test(value) || basename(value) !== value) {
    throw new IssueClosureError("INVALID_ISSUE_FILENAME", "Expected ISSUE-YYYYMMDD-NNN-*.md", 400);
  }
  return value;
}

function ensureInside(root: string, target: string): string {
  const base = resolve(root);
  const abs = resolve(target);
  if (abs !== base && !abs.startsWith(`${base}${sep}`)) {
    throw new IssueClosureError("EVIDENCE_PATH_OUTSIDE_PROJECT", "Evidence path is outside the active project", 422);
  }
  return abs;
}

function listFilesRecursively(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const result: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) result.push(...listFilesRecursively(path));
    else result.push(path);
  }
  return result;
}

function issueIdFrom(filename: string, fm: Record<string, unknown>): string {
  return text(fm.issue_id) || filename.replace(/\.md$/i, "");
}

function lifecycleFromTaskPath(path: string): string {
  return path.replace(/\\/g, "/").match(/\/fcop\/_lifecycle\/(inbox|active|review|done|archive)\//i)?.[1] ?? "tasks";
}

function buildClosureBody(draft: IssueClosureDraft): string {
  const evidence = draft.evidence.length
    ? draft.evidence.map((item) => `- ${item.type}: ${item.ref}${item.note ? ` (${item.note})` : ""}`)
    : ["- None recorded"];
  const reopen = draft.reopen_conditions.length
    ? draft.reopen_conditions.map((item) => `- ${item}`)
    : ["- None recorded"];
  return [
    "# Issue closure decision",
    "",
    "## Decision reason",
    "",
    draft.reason,
    "",
    "## Root cause",
    "",
    draft.root_cause_summary || "Not established.",
    "",
    "## Recovery or fix",
    "",
    draft.recovery_action || "No recovery action recorded.",
    "",
    "## Verification",
    "",
    draft.verification_summary || "See evidence references.",
    "",
    ...evidence,
    "",
    "## Residual risk",
    "",
    draft.residual_risk || "No residual risk recorded.",
    "",
    "## Follow-up",
    "",
    draft.follow_up_required
      ? `${draft.follow_up_target || "Unassigned"}${draft.follow_up_reference ? `: ${draft.follow_up_reference}` : ""}`
      : "No follow-up requested.",
    "",
    "## Reopen conditions",
    "",
    ...reopen,
  ].join("\n");
}

function requestDigestInput(draft: IssueClosureDraft): Record<string, unknown> {
  const { expected_issue_digest: _issue, expected_closure_digest: _closure, ...decision } = draft;
  return decision;
}

function hasEvidenceType(draft: IssueClosureDraft, matcher: RegExp): boolean {
  return draft.evidence.some((item) => matcher.test(item.type));
}

function validateDraftFields(draft: IssueClosureDraft): void {
  const missing: string[] = [];
  if (!draft.actor) missing.push("actor");
  if (!draft.idempotency_key) missing.push("idempotency_key");
  if (!draft.expected_issue_digest) missing.push("expected_issue_digest");
  if (!ISSUE_RESOLUTION_TYPES.includes(draft.resolution_type)) missing.push("resolution_type");
  if (!ISSUE_ROOT_CAUSE_STATUSES.includes(draft.root_cause_status)) missing.push("root_cause_status");
  if (!draft.reason || draft.reason.length < 8) missing.push("reason");
  if (missing.length) {
    throw new IssueClosureError(
      "ISSUE_CLOSURE_DETAILS_REQUIRED",
      `Issue closure details are incomplete: ${missing.join(", ")}`,
      422,
      { missing },
    );
  }

  if (draft.resolution_type === "fixed") {
    const changeEvidence = Boolean(draft.fix_commit || draft.fix_version) || hasEvidenceType(draft, /^(?:commit|version|runtime_version|config|change)$/i);
    const testEvidence = hasEvidenceType(draft, /^(?:test|verification|qa)$/i);
    if (draft.root_cause_status !== "fixed" || !changeEvidence || !testEvidence) {
      throw new IssueClosureError(
        "ISSUE_FIXED_EVIDENCE_REQUIRED",
        "fixed requires root_cause_status=fixed, commit/version/config evidence, and test evidence",
        422,
      );
    }
  }
  if (["mitigated", "workaround"].includes(draft.resolution_type)) {
    if (!draft.residual_risk || !(draft.follow_up_required || draft.promote_to_mother)) {
      throw new IssueClosureError(
        "ISSUE_RESIDUAL_RISK_FOLLOW_UP_REQUIRED",
        "mitigated/workaround requires residual risk and a follow-up or mother promotion",
        422,
      );
    }
    if (draft.root_cause_status === "fixed") {
      throw new IssueClosureError("ISSUE_ROOT_CAUSE_STATUS_INVALID", "mitigated/workaround cannot claim a fixed root cause", 422);
    }
  }
  if (["duplicate", "superseded"].includes(draft.resolution_type) && !draft.replacement_target && !draft.follow_up_reference) {
    throw new IssueClosureError("ISSUE_REPLACEMENT_TARGET_REQUIRED", "duplicate/superseded requires a target ISSUE or TASK", 422);
  }
  if (draft.resolution_type === "not_reproducible" && (!draft.environment || !draft.reproduction_attempts || !draft.observation_window)) {
    throw new IssueClosureError(
      "ISSUE_REPRODUCTION_CONTEXT_REQUIRED",
      "not_reproducible requires environment, reproduction attempts, and observation window",
      422,
    );
  }
  if (draft.resolution_type === "accepted_risk" && (!draft.risk_decider || !draft.risk_expires_at || !draft.risk_review_condition)) {
    throw new IssueClosureError(
      "ISSUE_RISK_ACCEPTANCE_DETAILS_REQUIRED",
      "accepted_risk requires decider, expiry, and review condition",
      422,
    );
  }
  if (draft.root_cause_status === "fixed") {
    if (!draft.root_cause_summary || !hasEvidenceType(draft, /^(?:commit|version|runtime_version|config|change|test|verification|qa)$/i)) {
      throw new IssueClosureError("ISSUE_ROOT_CAUSE_EVIDENCE_REQUIRED", "A fixed root cause requires a summary and fix evidence", 422);
    }
  }
  if (draft.unblock_task && (!draft.unblock_reason || !draft.recovery_action || !hasEvidenceType(draft, /^(?:task|report|session|test|verification|runtime_event)$/i))) {
    throw new IssueClosureError(
      "ISSUE_UNBLOCK_EVIDENCE_REQUIRED",
      "Unblocking a task requires an unblock reason, recovery action, and recovery evidence",
      422,
    );
  }
}

async function withIssueLock<T>(key: string, lockPath: string, fn: () => Promise<T>): Promise<T> {
  const previous = issueLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const tail = previous.then(() => gate);
  issueLocks.set(key, tail);
  await previous;
  mkdirSync(dirname(lockPath), { recursive: true });
  let handle: number | null = null;
  try {
    try {
      handle = openSync(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new IssueClosureError("ISSUE_CLOSURE_IN_PROGRESS", "Another issue closure transaction is in progress", 409);
      }
      throw error;
    }
    return await fn();
  } finally {
    if (handle != null) closeSync(handle);
    try { unlinkSync(lockPath); } catch { /* no stale transaction lock */ }
    release();
    if (issueLocks.get(key) === tail) issueLocks.delete(key);
  }
}

export class IssueClosureService {
  private readonly root: string;
  private readonly now: () => Date;

  constructor(private readonly options: IssueClosureServiceOptions) {
    this.root = resolve(options.projectRoot);
    this.now = options.now ?? (() => new Date());
  }

  private issuePath(filename: string): string {
    return join(this.root, "fcop", "issues", safeIssueFilename(filename));
  }

  private readIssue(filename: string): { path: string; raw: string; fm: Record<string, unknown>; digest: string; issueId: string } {
    const path = this.issuePath(filename);
    if (!existsSync(path)) throw new IssueClosureError("ISSUE_NOT_FOUND", filename, 404);
    const raw = readFileSync(path, "utf8");
    const fm = parseMarkdownFrontmatter(raw);
    return { path, raw, fm, digest: sha256Text(raw), issueId: issueIdFrom(filename, fm) };
  }

  private closureFiles(): string[] {
    return listFilesRecursively(join(this.root, "fcop", "internal", "issue-closures"))
      .filter((path) => /ISSUE-CLOSURE-.+-\d{3}\.md$/i.test(basename(path)));
  }

  private readClosurePath(path: string): { path: string; raw: string; fm: IssueClosureRecord; body: string } {
    const raw = readFileSync(path, "utf8");
    return { path, raw, fm: parseMarkdownFrontmatter(raw) as IssueClosureRecord, body: bodyOf(raw) };
  }

  private historyRows(issueId: string): Array<{ path: string; raw: string; fm: IssueClosureRecord; body: string }> {
    return this.closureFiles()
      .map((path) => this.readClosurePath(path))
      .filter((row) => text(row.fm.source_issue_id).toUpperCase() === issueId.toUpperCase())
      .sort((left, right) => Number(left.fm.attempt ?? 0) - Number(right.fm.attempt ?? 0));
  }

  private findByIdempotency(issueId: string, idempotencyKey: string) {
    if (!idempotencyKey) return null;
    return this.historyRows(issueId).find((row) => text(row.fm.idempotency_key) === idempotencyKey) ?? null;
  }

  private validateActor(issueFm: Record<string, unknown>, draft: IssueClosureDraft): string {
    const sourceTask = text(issueFm.source_task ?? issueFm.task_id);
    const mainline = /-ADMIN-to-PM(?:$|-)/i.test(sourceTask) || text(issueFm.sender).toUpperCase() === "ADMIN";
    const actor = draft.actor.toUpperCase();
    if (mainline && actor !== "ADMIN") {
      throw new IssueClosureError("ISSUE_CLOSE_AUTHORITY_REQUIRED", "Mainline issue closure requires ADMIN", 403);
    }
    if (!mainline && !["ADMIN", "PM"].includes(actor)) {
      throw new IssueClosureError("ISSUE_CLOSE_AUTHORITY_REQUIRED", "Issue closure requires ADMIN or PM", 403);
    }
    return mainline ? "admin_mainline" : actor === "ADMIN" ? "admin" : "pm_branch";
  }

  private validateEvidence(draft: IssueClosureDraft): void {
    for (const evidence of draft.evidence) {
      const ref = evidence.ref;
      if (/^(?:path|file|attachment|log)$/i.test(evidence.type)) {
        const target = ensureInside(this.root, join(this.root, ...ref.replace(/\\/g, "/").split("/")));
        if (!existsSync(target)) {
          throw new IssueClosureError("ISSUE_EVIDENCE_NOT_FOUND", `Evidence file does not exist: ${ref}`, 422, evidence);
        }
      } else if (/^task$/i.test(evidence.type)) {
        if (!findTaskFileByIdPrefix(this.root, ref)) {
          throw new IssueClosureError("ISSUE_EVIDENCE_NOT_FOUND", `TASK evidence does not exist: ${ref}`, 422, evidence);
        }
      } else if (/^report$/i.test(evidence.type)) {
        const reportDir = join(this.root, "fcop", "reports");
        const found = existsSync(reportDir) && readdirSync(reportDir).some((name) => name.replace(/\.md$/i, "").toUpperCase().startsWith(ref.replace(/\.md$/i, "").toUpperCase()));
        if (!found) throw new IssueClosureError("ISSUE_EVIDENCE_NOT_FOUND", `REPORT evidence does not exist: ${ref}`, 422, evidence);
      }
    }
  }

  private taskUnblockPreview(issue: ReturnType<IssueClosureService["readIssue"]>, draft: IssueClosureDraft): IssueTaskUnblockPreview {
    if (!draft.unblock_task) return { requested: false, will_write: false };
    const taskId = text(issue.fm.source_task ?? issue.fm.task_id);
    if (!taskId) throw new IssueClosureError("ISSUE_SOURCE_TASK_REQUIRED", "Issue has no source TASK to unblock", 422);
    const hit = findTaskFileByIdPrefix(this.root, taskId);
    if (!hit) throw new IssueClosureError("ISSUE_SOURCE_TASK_NOT_FOUND", `Source TASK not found: ${taskId}`, 422);
    const raw = readFileSync(hit.path, "utf8");
    const fm = parseMarkdownFrontmatter(raw);
    const blocker = text(fm.blocking_issue_id);
    const alreadyRecovered = !bool(fm.issue_blocking) && !blocker;
    if (!alreadyRecovered && blocker && blocker.toUpperCase() !== issue.issueId.toUpperCase()) {
      throw new IssueClosureError("ISSUE_TASK_BLOCKER_CHANGED", `TASK is blocked by another issue: ${blocker}`, 409);
    }
    const lifecycle = lifecycleFromTaskPath(hit.path);
    return {
      requested: true,
      task_id: taskId,
      task_path: relativePortable(this.root, hit.path),
      task_digest: sha256Text(raw),
      lifecycle,
      blocker_issue_id: blocker,
      already_recovered: alreadyRecovered,
      will_write: !alreadyRecovered,
      diff: alreadyRecovered ? {} : {
        issue_blocking: { from: fm.issue_blocking ?? true, to: false },
        blocking_issue_id: { from: blocker, to: "" },
        blocking_issue_reason: { from: fm.blocking_issue_reason ?? "", to: "" },
      },
    };
  }

  preview(filenameInput: string, rawDraft: unknown): IssueClosurePreview {
    const filename = safeIssueFilename(filenameInput);
    const draft = normalizeIssueClosureDraft(rawDraft);
    validateDraftFields(draft);
    const issue = this.readIssue(filename);
    if (draft.expected_issue_digest !== issue.digest) {
      throw new IssueClosureError(
        "ISSUE_CHANGED_REVIEW_AGAIN",
        "Issue changed after it was reviewed; generate a new preview",
        409,
        { expected: draft.expected_issue_digest, actual: issue.digest },
      );
    }
    const status = text(issue.fm.status || "open").toLowerCase();
    if (status === "closed") {
      throw new IssueClosureError("ISSUE_ALREADY_CLOSED", "Issue is already closed; read its closure history", 409);
    }
    const authority = this.validateActor(issue.fm, draft);
    this.validateEvidence(draft);
    const history = this.historyRows(issue.issueId);
    const attempt = (history.at(-1)?.fm.attempt ? Number(history.at(-1)!.fm.attempt) : 0) + 1;
    const date = this.now().toISOString().slice(0, 10).replace(/-/g, "");
    const closureId = `ISSUE-CLOSURE-${issue.issueId.replace(/^ISSUE-/i, "")}-${String(attempt).padStart(3, "0")}`;
    const closureRecord = `fcop/internal/issue-closures/${date}/${closureId}.md`;
    const closureBody = buildClosureBody(draft);
    const requestDigest = digestObject(requestDigestInput(draft));
    const closureDigest = digestObject({
      schema_version: 1,
      source_issue_id: issue.issueId,
      source_issue_digest: issue.digest,
      attempt,
      closure_record: closureRecord,
      decision: requestDigestInput(draft),
      body: closureBody,
    });
    if (draft.expected_closure_digest && draft.expected_closure_digest !== closureDigest) {
      throw new IssueClosureError(
        "ISSUE_CLOSURE_CHANGED_REVIEW_AGAIN",
        "Closure draft changed after preview; review the new digest",
        409,
        { expected: draft.expected_closure_digest, actual: closureDigest },
      );
    }
    const taskUnblock = this.taskUnblockPreview(issue, draft);
    const promotionStatus = draft.promote_to_mother ? "not_promoted" : text(issue.fm.promotion_status || "not_promoted");
    return {
      ok: true,
      filename,
      issue_id: issue.issueId,
      issue_digest: issue.digest,
      attempt,
      closure_id: closureId,
      closure_record: closureRecord,
      closure_digest: closureDigest,
      request_digest: requestDigest,
      normalized: { ...draft, authority_scope: draft.authority_scope || authority },
      issue_frontmatter_diff: {
        status: { from: issue.fm.status ?? "open", to: "closed" },
        resolution_type: { from: issue.fm.resolution_type ?? "", to: draft.resolution_type },
        root_cause_status: { from: issue.fm.root_cause_status ?? "unknown", to: draft.root_cause_status },
        closure_record: { from: issue.fm.closure_record ?? "", to: closureRecord },
        closure_digest: { from: issue.fm.closure_digest ?? "", to: closureDigest },
        promotion_status: { from: issue.fm.promotion_status ?? "not_promoted", to: promotionStatus },
      },
      task_unblock: taskUnblock,
      negative_candidates: [
        ...(taskUnblock.will_write ? ["NEG.GOVERNANCE.SHARED_STATE_WRITE"] : []),
        ...(draft.promote_to_mother ? ["LOCAL_EVIDENCE_ONLY_NO_EXTERNAL_WRITE"] : []),
      ],
      required_authority: authority,
      required_approval: Boolean(taskUnblock.will_write),
      non_effects: [
        "does_not_complete_or_archive_task",
        "does_not_stop_agent_session",
        "does_not_write_another_project",
        "does_not_push_git",
        "does_not_create_github_issue",
      ],
      closure_body: closureBody,
    };
  }

  async close(filenameInput: string, rawDraft: unknown): Promise<IssueClosureResult> {
    const filename = safeIssueFilename(filenameInput);
    const firstIssue = this.readIssue(filename);
    const normalized = normalizeIssueClosureDraft(rawDraft);
    if (!normalized.resolution_type || !normalized.reason || !normalized.idempotency_key) {
      validateDraftFields(normalized);
    }
    const lockPath = join(this.root, ".codeflowmu", "issue-closure-locks", `${filename}.lock`);
    return withIssueLock(firstIssue.path, lockPath, async () => {
      const issue = this.readIssue(filename);
      const prior = this.findByIdempotency(issue.issueId, normalized.idempotency_key);
      const requestDigest = digestObject(requestDigestInput(normalized));
      if (prior) {
        if (text(prior.fm.request_digest) !== requestDigest) {
          throw new IssueClosureError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for different closure details", 409);
        }
        return {
          ok: true,
          filename,
          status: "closed",
          closure_record: relativePortable(this.root, prior.path),
          closure_digest: text(prior.fm.closure_digest),
          closure_id: text(prior.fm.closure_id),
          attempt: Number(prior.fm.attempt ?? 1),
          idempotent: true,
          already_closed: true,
          task_side_effect: (prior.fm.task_side_effect as Record<string, unknown>) ?? { status: "unknown" },
        };
      }
      if (text(issue.fm.status).toLowerCase() === "closed") {
        const currentDigest = text(issue.fm.closure_digest);
        if (normalized.expected_closure_digest && normalized.expected_closure_digest === currentDigest) {
          return {
            ok: true,
            filename,
            status: "closed",
            closure_record: text(issue.fm.closure_record),
            closure_digest: currentDigest,
            closure_id: basename(text(issue.fm.closure_record)).replace(/\.md$/i, ""),
            attempt: Number(this.historyRows(issue.issueId).at(-1)?.fm.attempt ?? 1),
            idempotent: true,
            already_closed: true,
            task_side_effect: { status: "read_current_closure" },
          };
        }
        throw new IssueClosureError("ISSUE_ALREADY_CLOSED_REVIEW_HISTORY", "Issue was closed by another decision; review current closure history", 409);
      }

      const preview = this.preview(filename, rawDraft);
      const closedAt = this.now().toISOString();
      const recordAbs = join(this.root, ...preview.closure_record.split("/"));
      if (existsSync(recordAbs)) throw new IssueClosureError("ISSUE_CLOSURE_ATTEMPT_CONFLICT", "Closure attempt already exists", 409);
      const eventAbs = join(this.root, "fcop", "internal", "issue-closures", "events", `${preview.closure_id}.closed.json`);
      const beforeIssue = issue.raw;
      let beforeTask: { path: string; raw: string } | null = null;
      let wroteRecord = false;
      let wroteIssue = false;
      let wroteTask = false;
      let wroteEvent = false;
      let taskSideEffect: Record<string, unknown> = { status: "not_requested" };
      try {
        const record: IssueClosureRecord = {
          kind: "issue_closure",
          schema_version: 1,
          closure_id: preview.closure_id,
          source_issue_id: preview.issue_id,
          source_issue_path: relativePortable(this.root, issue.path),
          source_issue_digest: preview.issue_digest,
          resolution_type: preview.normalized.resolution_type,
          root_cause_status: preview.normalized.root_cause_status,
          root_cause_category: preview.normalized.root_cause_category ?? "unknown",
          root_cause_summary: preview.normalized.root_cause_summary ?? "",
          recovery_action: preview.normalized.recovery_action ?? "",
          closed_by: preview.normalized.actor,
          closed_at: closedAt,
          authority_scope: preview.normalized.authority_scope ?? preview.required_authority,
          unblock_task: preview.normalized.unblock_task,
          unblock_reason: preview.normalized.unblock_reason ?? "",
          follow_up_required: preview.normalized.follow_up_required,
          follow_up_target: preview.normalized.follow_up_target ?? "",
          follow_up_reference: preview.normalized.follow_up_reference ?? "",
          replacement_target: preview.normalized.replacement_target ?? "",
          reopen_conditions: preview.normalized.reopen_conditions,
          evidence: preview.normalized.evidence,
          residual_risk: preview.normalized.residual_risk ?? "",
          fix_commit: preview.normalized.fix_commit ?? "",
          fix_version: preview.normalized.fix_version ?? "",
          verification_summary: preview.normalized.verification_summary ?? "",
          promotion_status: "not_promoted",
          task_side_effect: preview.task_unblock.requested
            ? {
                status: preview.task_unblock.already_recovered ? "already_recovered" : "unblocked",
                task_id: preview.task_unblock.task_id,
                task_path: preview.task_unblock.task_path,
                lifecycle: preview.task_unblock.lifecycle,
                will_write: preview.task_unblock.will_write,
              }
            : { status: "not_requested" },
          attempt: preview.attempt,
          idempotency_key: preview.normalized.idempotency_key,
          request_digest: preview.request_digest,
          closure_digest: preview.closure_digest,
        };
        await atomicWriteFcopMarkdown(recordAbs, renderMarkdown(record, preview.closure_body), { skipIfExists: true });
        wroteRecord = true;
        await this.options.faultInjector?.("after_closure_record");

        const issueProjection = patchFrontmatter(issue.raw, {
          status: "closed",
          resolution_type: preview.normalized.resolution_type,
          root_cause_status: preview.normalized.root_cause_status,
          closed_at: closedAt,
          closed_by: preview.normalized.actor,
          closure_record: preview.closure_record,
          closure_digest: preview.closure_digest,
          promotion_status: "not_promoted",
        });
        await atomicWriteFcopMarkdown(issue.path, issueProjection);
        wroteIssue = true;
        await this.options.faultInjector?.("after_issue_projection");

        if (preview.task_unblock.requested) {
          await this.options.faultInjector?.("before_task_unblock");
          if (preview.task_unblock.already_recovered || !preview.task_unblock.will_write) {
            taskSideEffect = {
              status: "already_recovered",
              task_id: preview.task_unblock.task_id,
              lifecycle: preview.task_unblock.lifecycle,
              changed: false,
            };
          } else {
            const taskPath = join(this.root, ...text(preview.task_unblock.task_path).split("/"));
            const taskRaw = readFileSync(taskPath, "utf8");
            if (sha256Text(taskRaw) !== preview.task_unblock.task_digest) {
              throw new IssueClosureError("ISSUE_TASK_CHANGED_REVIEW_AGAIN", "Source TASK changed after preview", 409);
            }
            beforeTask = { path: taskPath, raw: taskRaw };
            const taskFm = parseMarkdownFrontmatter(taskRaw);
            if (text(taskFm.blocking_issue_id).toUpperCase() !== preview.issue_id.toUpperCase()) {
              throw new IssueClosureError("ISSUE_TASK_BLOCKER_CHANGED", "Source TASK blocker changed after preview", 409);
            }
            const updatedTask = patchFrontmatter(taskRaw, {
              issue_blocking: false,
              blocking_issue_id: "",
              blocking_issue_reason: "",
            });
            await atomicWriteFcopMarkdown(taskPath, updatedTask);
            wroteTask = true;
            taskSideEffect = {
              status: "unblocked",
              executor: "task_governance.issue_blocker.clear",
              task_id: preview.task_unblock.task_id,
              task_path: preview.task_unblock.task_path,
              lifecycle: preview.task_unblock.lifecycle,
              changed: true,
              before_digest: preview.task_unblock.task_digest,
              after_digest: sha256Text(updatedTask),
            };
            await this.options.faultInjector?.("after_task_unblock");
          }
        }

        await this.options.faultInjector?.("before_audit_event");
        await atomicWriteJson(eventAbs, `${JSON.stringify({
          schema_version: 1,
          event: "issue.closed",
          issue_id: preview.issue_id,
          closure_id: preview.closure_id,
          closure_digest: preview.closure_digest,
          actor: preview.normalized.actor,
          at: closedAt,
          task_side_effect: taskSideEffect,
        }, null, 2)}\n`);
        wroteEvent = true;
        return {
          ok: true,
          filename,
          status: "closed",
          closure_record: preview.closure_record,
          closure_digest: preview.closure_digest,
          closure_id: preview.closure_id,
          attempt: preview.attempt,
          idempotent: false,
          task_side_effect: taskSideEffect,
        };
      } catch (error) {
        if (wroteEvent) try { unlinkSync(eventAbs); } catch { /* rollback best effort */ }
        if (wroteTask && beforeTask) await atomicWriteFcopMarkdown(beforeTask.path, beforeTask.raw);
        if (wroteIssue) await atomicWriteFcopMarkdown(issue.path, beforeIssue);
        if (wroteRecord) try { unlinkSync(recordAbs); } catch { /* rollback best effort */ }
        throw error;
      }
    });
  }

  history(filenameInput: string): Record<string, unknown> {
    const filename = safeIssueFilename(filenameInput);
    const issue = this.readIssue(filename);
    const closures = this.historyRows(issue.issueId).map((row) => ({
      ...row.fm,
      path: relativePortable(this.root, row.path),
      body: row.body,
    }));
    const eventsDir = join(this.root, "fcop", "internal", "issue-closures", "events");
    const events = listFilesRecursively(eventsDir)
      .filter((path) => path.endsWith(".json"))
      .map((path) => {
        try { return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { return null; }
      })
      .filter((row): row is Record<string, unknown> => Boolean(row) && text(row?.issue_id).toUpperCase() === issue.issueId.toUpperCase());
    return {
      ok: true,
      filename,
      issue_id: issue.issueId,
      status: text(issue.fm.status || "open"),
      issue_digest: issue.digest,
      current_closure_record: text(issue.fm.closure_record),
      current_closure_digest: text(issue.fm.closure_digest),
      legacy_simple_closure: text(issue.fm.status).toLowerCase() === "closed" && !text(issue.fm.closure_record),
      closures,
      events,
    };
  }

  detail(filenameInput: string): Record<string, unknown> {
    const filename = safeIssueFilename(filenameInput);
    const issue = this.readIssue(filename);
    const history = this.history(filename);
    const closurePath = text(issue.fm.closure_record);
    let currentClosure: Record<string, unknown> | null = null;
    let promotion: Record<string, unknown> | null = null;
    if (closurePath) {
      const abs = ensureInside(this.root, join(this.root, ...closurePath.split("/")));
      if (existsSync(abs)) {
        const row = this.readClosurePath(abs);
        currentClosure = { ...row.fm, path: closurePath, body: row.body };
      }
    }
    const promotionPath = text(issue.fm.promotion_record);
    if (promotionPath) {
      const abs = ensureInside(this.root, join(this.root, ...promotionPath.split("/")));
      if (existsSync(abs)) {
        try {
          const parsed = JSON.parse(readFileSync(abs, "utf8"));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            promotion = { ...(parsed as Record<string, unknown>), path: promotionPath };
          }
        } catch {
          promotion = { path: promotionPath, status: "record_unreadable" };
        }
      }
    }
    return {
      filename,
      ...issue.fm,
      body: bodyOf(issue.raw),
      open: text(issue.fm.status || "open").toLowerCase() !== "closed",
      issue_digest: issue.digest,
      current_closure: currentClosure,
      promotion,
      closure_history: history.closures,
      closure_events: history.events,
      legacy_simple_closure: history.legacy_simple_closure,
    };
  }

  async updatePromotionProjection(
    filenameInput: string,
    input: { expected_closure_digest: string; status: string; promotion_record: string },
  ): Promise<{ issue_digest: string }> {
    const filename = safeIssueFilename(filenameInput);
    const status = text(input.status);
    if (!(ISSUE_PROMOTION_STATUSES as readonly string[]).includes(status)) {
      throw new IssueClosureError("ISSUE_PROMOTION_STATUS_INVALID", `Unsupported promotion status: ${status}`, 422);
    }
    const issue = this.readIssue(filename);
    if (text(issue.fm.closure_digest) !== text(input.expected_closure_digest)) {
      throw new IssueClosureError("ISSUE_CLOSURE_CHANGED_REVIEW_AGAIN", "Current closure digest no longer matches the promotion source", 409);
    }
    const updated = patchFrontmatter(issue.raw, {
      promotion_status: status,
      promotion_record: text(input.promotion_record),
    });
    await atomicWriteFcopMarkdown(issue.path, updated);
    return { issue_digest: sha256Text(updated) };
  }

  async reopen(filenameInput: string, rawInput: unknown): Promise<Record<string, unknown>> {
    const filename = safeIssueFilename(filenameInput);
    const input = rawInput && typeof rawInput === "object" ? rawInput as Record<string, unknown> : {};
    const actor = text(input.actor).toUpperCase();
    const reason = text(input.reason);
    const expected = text(input.expected_issue_digest);
    const idempotencyKey = text(input.idempotency_key);
    if (!actor || !reason || !expected || !idempotencyKey) {
      throw new IssueClosureError("ISSUE_REOPEN_DETAILS_REQUIRED", "actor, reason, expected_issue_digest, and idempotency_key are required", 422);
    }
    const initial = this.readIssue(filename);
    const lockPath = join(this.root, ".codeflowmu", "issue-closure-locks", `${filename}.lock`);
    return withIssueLock(initial.path, lockPath, async () => {
      const issue = this.readIssue(filename);
      if (issue.digest !== expected) throw new IssueClosureError("ISSUE_CHANGED_REVIEW_AGAIN", "Issue changed after review", 409);
      this.validateActor(issue.fm, normalizeIssueClosureDraft({ actor, idempotency_key: idempotencyKey, expected_issue_digest: expected, resolution_type: "invalid", root_cause_status: "unknown", reason: "reopen authority check" }));
      if (text(issue.fm.status).toLowerCase() !== "closed") {
        throw new IssueClosureError("ISSUE_NOT_CLOSED", "Only a closed issue can be reopened", 409);
      }
      const at = this.now().toISOString();
      const updated = patchFrontmatter(issue.raw, {
        status: "reopened",
        reopened_at: at,
        reopened_by: actor,
        reopen_reason: reason,
      });
      const eventAbs = join(this.root, "fcop", "internal", "issue-closures", "events", `${issue.issueId}.reopen.${sha256Text(idempotencyKey).slice(7, 19)}.json`);
      await atomicWriteFcopMarkdown(issue.path, updated);
      try {
        await atomicWriteJson(eventAbs, `${JSON.stringify({ schema_version: 1, event: "issue.reopened", issue_id: issue.issueId, actor, reason, at, prior_closure_digest: text(issue.fm.closure_digest), idempotency_key: idempotencyKey }, null, 2)}\n`);
      } catch (error) {
        await atomicWriteFcopMarkdown(issue.path, issue.raw);
        throw error;
      }
      return { ok: true, filename, status: "reopened", reopened_at: at, prior_closure_record: text(issue.fm.closure_record), prior_closure_digest: text(issue.fm.closure_digest) };
    });
  }
}

export function issueClosureErrorResponse(error: unknown): { status: number; code: string; message: string; details?: unknown } {
  if (error instanceof IssueClosureError) {
    return { status: error.httpStatus, code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
  }
  return { status: 500, code: "ISSUE_CLOSURE_FAILED", message: error instanceof Error ? error.message : String(error) };
}

export { digestObject as digestIssueClosureObject, sha256Text as digestIssueClosureText };
