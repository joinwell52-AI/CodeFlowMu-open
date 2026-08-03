import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { withProjectWriteLeaseSync } from "../project/ProjectWriteBarrier.ts";

export const GOVERNANCE_RECORD_TYPES = [
  "DIRECTIVE",
  "AUTHORIZATION",
  "DECISION",
  "AMENDMENT",
  "APPROVAL_REQUEST",
  "REVOCATION",
  "SUPERSEDE",
] as const;

export type GovernanceRecordType = (typeof GOVERNANCE_RECORD_TYPES)[number];
export type GovernanceStatus =
  | "draft"
  | "pending_approval"
  | "changes_requested"
  | "rejected"
  | "effective"
  | "consumed"
  | "expired"
  | "revoked"
  | "superseded"
  | "legacy_unverified";
export type GovernanceDecision =
  | "approved"
  | "rejected"
  | "changes_requested"
  | "revoked";

export const GOVERNANCE_APPROVAL_CODES = [
  "APPROVAL_REQUIRED",
  "APPROVAL_PENDING",
  "APPROVAL_REJECTED",
  "APPROVAL_EXPIRED",
  "APPROVAL_REVOKED",
  "APPROVAL_SCOPE_MISMATCH",
  "APPROVAL_ALREADY_CONSUMED",
  "ABSOLUTELY_PROHIBITED",
] as const;

export type GovernanceApprovalCode =
  (typeof GOVERNANCE_APPROVAL_CODES)[number];

export class GovernanceApprovalError extends Error {
  constructor(
    public readonly code: GovernanceApprovalCode | string,
    message: string,
    public readonly httpStatus = 409,
    public readonly evidence: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "GovernanceApprovalError";
  }
}

export interface GovernanceSourceVerification {
  exists: boolean;
  sender: string;
  project_id?: string;
  task_ids?: string[];
  immutable?: boolean;
}

export type GovernanceSourceVerifier = (input: {
  source_message_id: string;
  source_session_id: string;
  project_id: string;
  target_task_id: string;
}) => GovernanceSourceVerification;

export interface GovernanceRecordInput {
  type: GovernanceRecordType;
  issued_by: "ADMIN";
  authored_by: "PM";
  recipient: string;
  target_task_id: string;
  thread_key: string;
  project_id: string;
  source_kind: "admin_chat" | "pm_request" | "legacy";
  source_message_id?: string;
  source_session_id?: string;
  intent_summary: string;
  boundary_summary: string;
  allowed_actions: string[];
  prohibited_actions: string[];
  targets: string[];
  effective_conditions: string[];
  expires_at?: string | null;
  usage_limit?: number | null;
  retry_semantics?: "never" | "if_no_side_effect" | "explicit_new_approval";
  risk_and_rollback: string;
  revocation_conditions: string[];
  evidence_requirements: string[];
  references?: string[];
  supersedes?: string | null;
  blocks_task?: boolean;
}

export interface GovernanceRecord {
  protocol: "fcop";
  version: 1;
  type: GovernanceRecordType;
  governance_id: string;
  revision: number;
  status: GovernanceStatus;
  approval_id: string | null;
  issued_by: "ADMIN";
  authored_by: "PM";
  recipient: string;
  target_task_id: string;
  thread_key: string;
  project_id: string;
  source_kind: GovernanceRecordInput["source_kind"];
  source_message_id: string | null;
  source_session_id: string | null;
  scope_digest: string;
  content_hash: string;
  created_at: string;
  submitted_at: string | null;
  expires_at: string | null;
  usage_limit: number | null;
  usage_count: number;
  approval_required: true;
  supersedes: string | null;
  blocks_task: boolean;
  retry_semantics: NonNullable<GovernanceRecordInput["retry_semantics"]>;
  intent_summary: string;
  boundary_summary: string;
  allowed_actions: string[];
  prohibited_actions: string[];
  targets: string[];
  effective_conditions: string[];
  risk_and_rollback: string;
  revocation_conditions: string[];
  evidence_requirements: string[];
  references: string[];
  source_verified: boolean;
  source_alignment: "admin_confirmation_required";
  path: string;
}

export interface GovernanceDecisionRecord {
  protocol: "fcop";
  version: 1;
  type: "APPROVAL_DECISION";
  decision_id: string;
  lease_id: string | null;
  approval_id: string;
  governance_id: string;
  governance_revision: number;
  decided_by: "ADMIN";
  decision: GovernanceDecision;
  scope_digest: string;
  content_hash: string;
  created_at: string;
  source_ui_action_id: string;
  reason: string;
  conditions: string[];
  references: string[];
  path: string;
}

export interface GovernanceAuthorizationReference {
  governance_id: string;
  revision: number;
  approval_id: string;
  decision_id: string;
  scope_digest: string;
  content_hash: string;
  lease_id: string;
  idempotency_key: string;
}

export interface GovernanceApprovalServiceOptions {
  projectRoot: string;
  now?: () => Date;
  governanceIdFactory?: () => string;
  approvalIdFactory?: () => string;
  decisionIdFactory?: () => string;
  verifySourceMessage?: GovernanceSourceVerifier;
  featureEnabled?: boolean;
}

type ParsedFormalFile = {
  frontmatter: Record<string, unknown>;
  body: string;
};

const TERMINAL_STATUSES = new Set<GovernanceStatus>([
  "rejected",
  "consumed",
  "expired",
  "revoked",
  "superseded",
]);

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, stable(object[key])]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex")}`;
}

function normalizeList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function isPmActor(value: unknown): boolean {
  return /^PM(?:[-_.]|$)/i.test(normalizeText(value));
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function parseFormal(raw: string): ParsedFormalFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) {
    throw new GovernanceApprovalError(
      "GOVERNANCE_FILE_CORRUPT",
      "formal governance file is missing YAML frontmatter",
      500,
    );
  }
  const parsed = parseYaml(match[1] ?? "");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GovernanceApprovalError(
      "GOVERNANCE_FILE_CORRUPT",
      "formal governance frontmatter is not an object",
      500,
    );
  }
  return {
    frontmatter: parsed as Record<string, unknown>,
    body: match[2] ?? "",
  };
}

function renderFormal(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  return `---\n${stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n${body.trim()}\n`;
}

function recordBody(input: GovernanceRecordInput): string {
  const bullets = (values: string[]) =>
    values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : "- None";
  return [
    "# Governance Record",
    "",
    "## ADMIN intent summary",
    "",
    input.intent_summary,
    "",
    "## PM boundary restatement",
    "",
    input.boundary_summary,
    "",
    "## Allowed",
    "",
    bullets(input.allowed_actions),
    "",
    "## Prohibited",
    "",
    bullets(input.prohibited_actions),
    "",
    "## Targets",
    "",
    bullets(input.targets),
    "",
    "## Effective conditions",
    "",
    bullets(input.effective_conditions),
    "",
    "## Risk and rollback",
    "",
    input.risk_and_rollback,
    "",
    "## Revocation conditions",
    "",
    bullets(input.revocation_conditions),
    "",
    "## Required execution evidence",
    "",
    bullets(input.evidence_requirements),
    "",
    "## Relationship to existing formal objects",
    "",
    bullets(input.references ?? []),
    "",
  ].join("\n");
}

function contentPayload(input: GovernanceRecordInput): Record<string, unknown> {
  return {
    type: input.type,
    issued_by: input.issued_by,
    authored_by: input.authored_by,
    recipient: input.recipient,
    target_task_id: input.target_task_id,
    thread_key: input.thread_key,
    project_id: input.project_id,
    source_kind: input.source_kind,
    source_message_id: input.source_message_id ?? null,
    source_session_id: input.source_session_id ?? null,
    intent_summary: input.intent_summary,
    boundary_summary: input.boundary_summary,
    allowed_actions: normalizeList(input.allowed_actions),
    prohibited_actions: normalizeList(input.prohibited_actions),
    targets: normalizeList(input.targets),
    effective_conditions: normalizeList(input.effective_conditions),
    expires_at: input.expires_at ?? null,
    usage_limit: input.usage_limit ?? null,
    retry_semantics: input.retry_semantics ?? "explicit_new_approval",
    risk_and_rollback: input.risk_and_rollback,
    revocation_conditions: normalizeList(input.revocation_conditions),
    evidence_requirements: normalizeList(input.evidence_requirements),
    references: normalizeList(input.references ?? []),
    supersedes: input.supersedes ?? null,
    blocks_task: input.blocks_task === true,
  };
}

function scopePayload(input: GovernanceRecordInput): Record<string, unknown> {
  return {
    type: input.type,
    project_id: input.project_id,
    target_task_id: input.target_task_id,
    recipient: input.recipient,
    targets: normalizeList(input.targets),
    allowed_actions: normalizeList(input.allowed_actions),
    prohibited_actions: normalizeList(input.prohibited_actions),
    effective_conditions: normalizeList(input.effective_conditions),
    expires_at: input.expires_at ?? null,
    usage_limit: input.usage_limit ?? null,
  };
}

function validateInput(input: GovernanceRecordInput): void {
  if (!GOVERNANCE_RECORD_TYPES.includes(input.type)) {
    throw new GovernanceApprovalError(
      "GOVERNANCE_TYPE_INVALID",
      `unsupported governance type: ${input.type}`,
      400,
    );
  }
  if (input.issued_by !== "ADMIN" || input.authored_by !== "PM") {
    throw new GovernanceApprovalError(
      "ABSOLUTELY_PROHIBITED",
      "governance identity forgery is prohibited",
      403,
    );
  }
  for (const [field, value] of [
    ["recipient", input.recipient],
    ["target_task_id", input.target_task_id],
    ["thread_key", input.thread_key],
    ["project_id", input.project_id],
    ["intent_summary", input.intent_summary],
    ["boundary_summary", input.boundary_summary],
    ["risk_and_rollback", input.risk_and_rollback],
  ]) {
    if (!normalizeText(value)) {
      throw new GovernanceApprovalError(
        "GOVERNANCE_SCHEMA_INVALID",
        `${field} is required`,
        400,
      );
    }
  }
  if (normalizeList(input.allowed_actions).length === 0) {
    throw new GovernanceApprovalError(
      "GOVERNANCE_SCHEMA_INVALID",
      "allowed_actions must be explicit",
      400,
    );
  }
  if (normalizeList(input.prohibited_actions).length === 0) {
    throw new GovernanceApprovalError(
      "GOVERNANCE_SCHEMA_INVALID",
      "prohibited_actions must be explicit",
      400,
    );
  }
  if (normalizeList(input.targets).length === 0) {
    throw new GovernanceApprovalError(
      "GOVERNANCE_SCHEMA_INVALID",
      "targets must be exact and non-empty",
      400,
    );
  }
  if (
    input.usage_limit != null &&
    (!Number.isSafeInteger(input.usage_limit) || input.usage_limit < 1)
  ) {
    throw new GovernanceApprovalError(
      "GOVERNANCE_SCHEMA_INVALID",
      "usage_limit must be a positive integer or null",
      400,
    );
  }
  if (input.expires_at && !Number.isFinite(Date.parse(input.expires_at))) {
    throw new GovernanceApprovalError(
      "GOVERNANCE_SCHEMA_INVALID",
      "expires_at must be ISO-8601 or null",
      400,
    );
  }
}

export class GovernanceApprovalService {
  private readonly root: string;
  private readonly formalRoot: string;
  private readonly runtimeRoot: string;
  private readonly now: () => Date;
  private readonly governanceIdFactory: () => string;
  private readonly approvalIdFactory: () => string;
  private readonly decisionIdFactory: () => string;
  private readonly verifySourceMessage?: GovernanceSourceVerifier;
  private readonly featureEnabled: boolean;

  constructor(options: GovernanceApprovalServiceOptions) {
    this.root = resolve(options.projectRoot);
    this.formalRoot = join(this.root, "fcop", "governance");
    this.runtimeRoot = join(this.root, ".codeflowmu", "governance");
    this.now = options.now ?? (() => new Date());
    const dateId = (prefix: string) => {
      const date = this.now().toISOString().slice(0, 10).replace(/-/g, "");
      return `${prefix}-${date}-${randomBytes(6).toString("hex")}`;
    };
    this.governanceIdFactory =
      options.governanceIdFactory ?? (() => dateId("GOV"));
    this.approvalIdFactory =
      options.approvalIdFactory ?? (() => dateId("APPROVAL"));
    this.decisionIdFactory =
      options.decisionIdFactory ?? (() => dateId("DECISION"));
    this.verifySourceMessage = options.verifySourceMessage;
    this.featureEnabled =
      options.featureEnabled ??
      process.env["CODEFLOWMU_GOVERNANCE_APPROVALS_ENABLED"] !== "0";
  }

  writeDraft(
    input: GovernanceRecordInput,
    options: {
      governanceId?: string;
      revision?: number;
      idempotencyKey?: string;
    } = {},
  ): GovernanceRecord {
    return withProjectWriteLeaseSync(this.root, "governance-approval.draft", () =>
      this.writeDraftWithLease(input, options));
  }

  private writeDraftWithLease(
    input: GovernanceRecordInput,
    options: {
      governanceId?: string;
      revision?: number;
      idempotencyKey?: string;
    } = {},
  ): GovernanceRecord {
    this.assertEnabled();
    validateInput(input);
    if (!isPmActor(input.authored_by)) {
      throw new GovernanceApprovalError(
        "AUTHOR_NOT_AUTHORIZED",
        "only PM may author governance records",
        403,
      );
    }
    const idempotency = options.idempotencyKey
      ? this.readIdempotency(options.idempotencyKey)
      : null;
    if (idempotency) {
      this.assertIdempotencyAction(idempotency.action, "draft");
      return this.get(idempotency.governance_id, idempotency.revision);
    }

    const governanceId = sanitizeId(
      options.governanceId ?? this.governanceIdFactory(),
    );
    const revision = options.revision ?? 1;
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new GovernanceApprovalError(
        "GOVERNANCE_REVISION_INVALID",
        "revision must be a positive integer",
        400,
      );
    }
    if (this.findRecordPath(governanceId, revision)) {
      throw new GovernanceApprovalError(
        "GOVERNANCE_REVISION_CONFLICT",
        `${governanceId} revision ${revision} already exists`,
      );
    }
    const createdAt = this.now().toISOString();
    const contentHash = digest(contentPayload(input));
    const scopeDigest = digest(scopePayload(input));
    const frontmatter: Record<string, unknown> = {
      protocol: "fcop",
      version: 1,
      type: input.type,
      governance_id: governanceId,
      revision,
      status: "draft",
      approval_id: null,
      issued_by: "ADMIN",
      authored_by: "PM",
      recipient: normalizeText(input.recipient),
      target_task_id: normalizeText(input.target_task_id),
      thread_key: normalizeText(input.thread_key),
      project_id: normalizeText(input.project_id),
      source_kind: input.source_kind,
      source_message_id: normalizeText(input.source_message_id) || null,
      source_session_id: normalizeText(input.source_session_id) || null,
      scope_digest: scopeDigest,
      content_hash: contentHash,
      created_at: createdAt,
      submitted_at: null,
      expires_at: input.expires_at ?? null,
      usage_limit: input.usage_limit ?? null,
      usage_count: 0,
      approval_required: true,
      supersedes: input.supersedes ?? null,
      blocks_task: input.blocks_task === true,
      retry_semantics: input.retry_semantics ?? "explicit_new_approval",
      intent_summary: normalizeText(input.intent_summary),
      boundary_summary: normalizeText(input.boundary_summary),
      allowed_actions: normalizeList(input.allowed_actions),
      prohibited_actions: normalizeList(input.prohibited_actions),
      targets: normalizeList(input.targets),
      effective_conditions: normalizeList(input.effective_conditions),
      risk_and_rollback: normalizeText(input.risk_and_rollback),
      revocation_conditions: normalizeList(input.revocation_conditions),
      evidence_requirements: normalizeList(input.evidence_requirements),
      references: normalizeList([
        input.target_task_id,
        ...(input.references ?? []),
      ]),
      source_verified: false,
      source_alignment: "admin_confirmation_required",
    };
    const path = this.recordPath("draft", governanceId, revision);
    this.writeCreateOnly(path, renderFormal(frontmatter, recordBody(input)));
    this.audit("governance.drafted", {
      governance_id: governanceId,
      revision,
      content_hash: contentHash,
      scope_digest: scopeDigest,
      authored_by: "PM",
    });
    if (options.idempotencyKey) {
      this.writeIdempotency(options.idempotencyKey, {
        governance_id: governanceId,
        revision,
        action: "draft",
      });
    }
    return this.readRecord(path);
  }

  submit(
    governanceId: string,
    revision: number,
    actor: string,
    idempotencyKey?: string,
  ): GovernanceRecord {
    this.assertEnabled();
    if (!isPmActor(actor)) {
      throw new GovernanceApprovalError(
        "SUBMITTER_NOT_AUTHORIZED",
        "only PM may submit governance for approval",
        403,
      );
    }
    return this.withLock(governanceId, revision, () => {
      const priorIdempotency = idempotencyKey
        ? this.readIdempotency(idempotencyKey)
        : null;
      if (priorIdempotency) {
        this.assertIdempotencyAction(priorIdempotency.action, "submit");
        return this.get(
          priorIdempotency.governance_id,
          priorIdempotency.revision,
        );
      }
      const record = this.get(governanceId, revision);
      if (record.status === "pending_approval") return record;
      if (record.status !== "draft") {
        throw new GovernanceApprovalError(
          "GOVERNANCE_NOT_DRAFT",
          `cannot submit governance in status ${record.status}`,
        );
      }
      this.verifySource(record);
      const approvalId = sanitizeId(this.approvalIdFactory());
      const submittedAt = this.now().toISOString();
      const parsed = parseFormal(readFileSync(record.path, "utf-8"));
      const nextFm = {
        ...parsed.frontmatter,
        status: "pending_approval",
        approval_id: approvalId,
        submitted_at: submittedAt,
        source_verified: true,
      };
      const pendingPath = this.recordPath(
        "pending_approval",
        governanceId,
        revision,
      );
      this.writeAtomic(pendingPath, renderFormal(nextFm, parsed.body));
      unlinkSync(record.path);
      this.audit("governance.validated", {
        governance_id: governanceId,
        revision,
        source_verified: true,
        content_hash: record.content_hash,
        scope_digest: record.scope_digest,
      });
      this.audit("governance.submitted", {
        governance_id: governanceId,
        revision,
        approval_id: approvalId,
      });
      if (idempotencyKey) {
        this.writeIdempotency(idempotencyKey, {
          governance_id: governanceId,
          revision,
          approval_id: approvalId,
          action: "submit",
        });
      }
      this.rebuildIndex();
      return this.readRecord(pendingPath);
    });
  }

  revise(
    governanceId: string,
    revision: number,
    input: GovernanceRecordInput,
    actor: string,
    idempotencyKey?: string,
  ): GovernanceRecord {
    if (!isPmActor(actor)) {
      throw new GovernanceApprovalError(
        "AUTHOR_NOT_AUTHORIZED",
        "only PM may revise governance records",
        403,
      );
    }
    const current = this.get(governanceId, revision);
    if (current.status !== "changes_requested") {
      throw new GovernanceApprovalError(
        "REVISION_NOT_ALLOWED",
        "a new revision is allowed only after changes_requested",
      );
    }
    return this.writeDraft(input, {
      governanceId,
      revision: revision + 1,
      idempotencyKey,
    });
  }

  decide(input: {
    governanceId: string;
    revision: number;
    approvalId: string;
    actor: string;
    decision: Exclude<GovernanceDecision, "revoked">;
    reason: string;
    conditions?: string[];
    sourceUiActionId: string;
    idempotencyKey: string;
  }): { governance: GovernanceRecord; decision: GovernanceDecisionRecord } {
    this.assertEnabled();
    if (normalizeText(input.actor).toUpperCase() !== "ADMIN") {
      throw new GovernanceApprovalError(
        "APPROVER_NOT_AUTHORIZED",
        "only ADMIN may decide governance approvals",
        403,
      );
    }
    if (!normalizeText(input.reason)) {
      throw new GovernanceApprovalError(
        "APPROVAL_REASON_REQUIRED",
        "decision reason is required",
        400,
      );
    }
    if (!normalizeText(input.sourceUiActionId)) {
      throw new GovernanceApprovalError(
        "FORMAL_UI_ACTION_REQUIRED",
        "a formal approval UI action id is required; ordinary chat text is not approval",
        400,
      );
    }
    return this.withLock(input.governanceId, input.revision, () => {
      const prior = this.readIdempotency(input.idempotencyKey);
      if (prior?.decision_id) {
        this.assertIdempotencyAction(prior.action, input.decision);
        return {
          governance: this.get(input.governanceId, input.revision),
          decision: this.getDecision(prior.decision_id),
        };
      }
      const governance = this.get(input.governanceId, input.revision);
      if (
        governance.status !== "pending_approval" ||
        governance.approval_id !== input.approvalId
      ) {
        const existing = this.findDecisionForRevision(
          input.governanceId,
          input.revision,
        );
        if (existing && existing.decision === input.decision) {
          return { governance, decision: existing };
        }
        throw new GovernanceApprovalError(
          "APPROVAL_STATE_CONFLICT",
          `governance is ${governance.status} or approval id does not match`,
        );
      }
      this.assertHashes(governance);
      const decisionId = sanitizeId(this.decisionIdFactory());
      const leaseId = input.decision === "approved"
        ? `LEASE-${digest({
            governance_id: governance.governance_id,
            revision: governance.revision,
            decision_id: decisionId,
          }).slice("sha256:".length, "sha256:".length + 24)}`
        : null;
      const createdAt = this.now().toISOString();
      const decisionFm: Record<string, unknown> = {
        protocol: "fcop",
        version: 1,
        type: "APPROVAL_DECISION",
        decision_id: decisionId,
        lease_id: leaseId,
        approval_id: governance.approval_id,
        governance_id: governance.governance_id,
        governance_revision: governance.revision,
        decided_by: "ADMIN",
        decision: input.decision,
        scope_digest: governance.scope_digest,
        content_hash: governance.content_hash,
        created_at: createdAt,
        source_ui_action_id: normalizeText(input.sourceUiActionId),
        reason: normalizeText(input.reason),
        conditions: normalizeList(input.conditions ?? []),
        references: [
          governance.governance_id,
          governance.target_task_id,
        ],
      };
      const decisionPath = join(
        this.formalRoot,
        "decisions",
        `${decisionId}.md`,
      );
      const decisionBody = [
        "# Governance Approval Decision",
        "",
        `Decision: ${input.decision}`,
        "",
        `Reason: ${normalizeText(input.reason)}`,
        "",
        "## Conditions",
        "",
        ...(normalizeList(input.conditions ?? []).length > 0
          ? normalizeList(input.conditions ?? []).map((value) => `- ${value}`)
          : ["- None"]),
        "",
        `Approved content hash: ${governance.content_hash}`,
        `Approved scope digest: ${governance.scope_digest}`,
        ...(leaseId ? [`Capability lease: ${leaseId}`] : []),
        "",
      ].join("\n");
      this.writeCreateOnly(
        decisionPath,
        renderFormal(decisionFm, decisionBody),
      );
      this.writeTransaction({
        transaction_id: `TX-${decisionId}`,
        governance_id: governance.governance_id,
        revision: governance.revision,
        decision_id: decisionId,
        target_status:
          input.decision === "approved" ? "effective" : input.decision,
        state: "decision_written",
        created_at: createdAt,
      });

      const parsed = parseFormal(readFileSync(governance.path, "utf-8"));
      const nextStatus: GovernanceStatus =
        input.decision === "approved" ? "effective" : input.decision;
      const nextFm = {
        ...parsed.frontmatter,
        status: nextStatus,
        decision_id: decisionId,
        ...(leaseId ? { lease_id: leaseId } : {}),
        decided_at: createdAt,
      };
      const destination = this.recordPath(
        nextStatus,
        governance.governance_id,
        governance.revision,
      );
      this.writeAtomic(destination, renderFormal(nextFm, parsed.body));
      unlinkSync(governance.path);
      this.finishTransaction(`TX-${decisionId}`);
      this.writeIdempotency(input.idempotencyKey, {
        governance_id: governance.governance_id,
        revision: governance.revision,
        approval_id: governance.approval_id,
        decision_id: decisionId,
        action: input.decision,
      });
      this.audit(`governance.${input.decision}`, {
        governance_id: governance.governance_id,
        revision: governance.revision,
        approval_id: governance.approval_id,
        decision_id: decisionId,
        scope_digest: governance.scope_digest,
        content_hash: governance.content_hash,
      });
      this.rebuildIndex();
      return {
        governance: this.readRecord(destination),
        decision: this.readDecision(decisionPath),
      };
    });
  }

  revoke(input: {
    governanceId: string;
    revision: number;
    actor: string;
    reason: string;
    sourceUiActionId: string;
    idempotencyKey: string;
  }): { governance: GovernanceRecord; decision: GovernanceDecisionRecord } {
    if (normalizeText(input.actor).toUpperCase() !== "ADMIN") {
      throw new GovernanceApprovalError(
        "APPROVER_NOT_AUTHORIZED",
        "only ADMIN may revoke effective governance",
        403,
      );
    }
    return this.withLock(input.governanceId, input.revision, () => {
      const prior = this.readIdempotency(input.idempotencyKey);
      if (prior?.decision_id) {
        this.assertIdempotencyAction(prior.action, "revoked");
        return {
          governance: this.get(input.governanceId, input.revision),
          decision: this.getDecision(prior.decision_id),
        };
      }
      const governance = this.get(input.governanceId, input.revision);
      if (governance.status !== "effective") {
        throw new GovernanceApprovalError(
          "APPROVAL_STATE_CONFLICT",
          `only effective governance can be revoked; got ${governance.status}`,
        );
      }
      this.assertHashes(governance);
      const decisionId = sanitizeId(this.decisionIdFactory());
      const createdAt = this.now().toISOString();
      const decisionPath = join(
        this.formalRoot,
        "decisions",
        `${decisionId}.md`,
      );
      const fm: Record<string, unknown> = {
        protocol: "fcop",
        version: 1,
        type: "APPROVAL_DECISION",
        decision_id: decisionId,
        lease_id: null,
        approval_id: governance.approval_id,
        governance_id: governance.governance_id,
        governance_revision: governance.revision,
        decided_by: "ADMIN",
        decision: "revoked",
        scope_digest: governance.scope_digest,
        content_hash: governance.content_hash,
        created_at: createdAt,
        source_ui_action_id: input.sourceUiActionId,
        reason: input.reason,
        conditions: [],
        references: [governance.governance_id, governance.target_task_id],
      };
      this.writeCreateOnly(
        decisionPath,
        renderFormal(
          fm,
          `# Governance Revocation\n\nReason: ${normalizeText(input.reason)}\n`,
        ),
      );
      const parsed = parseFormal(readFileSync(governance.path, "utf-8"));
      const destination = this.recordPath(
        "revoked",
        governance.governance_id,
        governance.revision,
      );
      this.writeAtomic(
        destination,
        renderFormal(
          {
            ...parsed.frontmatter,
            status: "revoked",
            revoked_at: createdAt,
            revocation_decision_id: decisionId,
          },
          parsed.body,
        ),
      );
      unlinkSync(governance.path);
      this.writeIdempotency(input.idempotencyKey, {
        governance_id: governance.governance_id,
        revision: governance.revision,
        approval_id: governance.approval_id ?? undefined,
        decision_id: decisionId,
        action: "revoked",
      });
      this.audit("governance.revoked", {
        governance_id: governance.governance_id,
        revision: governance.revision,
        decision_id: decisionId,
      });
      this.rebuildIndex();
      return {
        governance: this.readRecord(destination),
        decision: this.readDecision(decisionPath),
      };
    });
  }

  validateAuthorization(
    reference: GovernanceAuthorizationReference,
    expected: {
      project_id: string;
      target_task_id: string;
      scope_digest: string;
      content_hash?: string;
    },
  ): {
    ok: true;
    governance: GovernanceRecord;
    decision: GovernanceDecisionRecord;
  } {
    const governance = this.latest(reference.governance_id);
    if (!governance) {
      throw new GovernanceApprovalError(
        "APPROVAL_REQUIRED",
        "governance approval is required",
      );
    }
    this.expireIfNeeded(governance);
    const refreshed = this.get(governance.governance_id, governance.revision);
    const statusCode: Partial<Record<GovernanceStatus, GovernanceApprovalCode>> = {
      draft: "APPROVAL_REQUIRED",
      pending_approval: "APPROVAL_PENDING",
      changes_requested: "APPROVAL_REQUIRED",
      rejected: "APPROVAL_REJECTED",
      expired: "APPROVAL_EXPIRED",
      revoked: "APPROVAL_REVOKED",
      consumed: "APPROVAL_ALREADY_CONSUMED",
      superseded: "APPROVAL_REVOKED",
    };
    if (refreshed.status !== "effective") {
      throw new GovernanceApprovalError(
        statusCode[refreshed.status] ?? "APPROVAL_REQUIRED",
        `governance authorization is ${refreshed.status}`,
      );
    }
    if (governance.revision !== reference.revision) {
      throw new GovernanceApprovalError(
        "APPROVAL_SCOPE_MISMATCH",
        "governance revision does not match the capability lease",
      );
    }
    this.assertHashes(refreshed);
    if (
      refreshed.project_id !== expected.project_id ||
      refreshed.target_task_id !== expected.target_task_id ||
      refreshed.scope_digest !== expected.scope_digest ||
      refreshed.scope_digest !== reference.scope_digest ||
      refreshed.content_hash !== reference.content_hash ||
      (expected.content_hash &&
        refreshed.content_hash !== expected.content_hash)
    ) {
      throw new GovernanceApprovalError(
        "APPROVAL_SCOPE_MISMATCH",
        "governance scope or content hash does not match the requested action",
        409,
        {
          expected_scope_digest: expected.scope_digest,
          actual_scope_digest: refreshed.scope_digest,
        },
      );
    }
    const decision = this.getDecision(reference.decision_id);
    if (
      decision.decision !== "approved" ||
      decision.approval_id !== reference.approval_id ||
      decision.governance_id !== reference.governance_id ||
      decision.governance_revision !== reference.revision ||
      decision.lease_id !== reference.lease_id ||
      decision.scope_digest !== reference.scope_digest ||
      decision.content_hash !== reference.content_hash
    ) {
      throw new GovernanceApprovalError(
        "APPROVAL_SCOPE_MISMATCH",
        "approval decision does not match governance revision",
      );
    }
    return { ok: true, governance: refreshed, decision };
  }

  authorizeAction(
    reference: GovernanceAuthorizationReference,
    expected: {
      project_id: string;
      target_task_id: string;
      action: string;
      targets: string[];
    },
    evidence: Record<string, unknown>,
  ): GovernanceRecord {
    const validated = this.validateAuthorization(reference, {
      project_id: expected.project_id,
      target_task_id: expected.target_task_id,
      scope_digest: reference.scope_digest,
      content_hash: reference.content_hash,
    });
    const normalizeScopeValue = (value: string) =>
      value.trim().replace(/\\/g, "/").toLowerCase();
    const allowedActions = new Set(
      validated.governance.allowed_actions.map(normalizeScopeValue),
    );
    const approvedTargets = new Set(
      validated.governance.targets.map(normalizeScopeValue),
    );
    const action = normalizeScopeValue(expected.action);
    const targets = expected.targets.map(normalizeScopeValue);
    if (
      !allowedActions.has(action) ||
      targets.some((target) => !approvedTargets.has(target))
    ) {
      throw new GovernanceApprovalError(
        "APPROVAL_SCOPE_MISMATCH",
        "requested action or target is outside the approved governance scope",
        409,
        {
          requested_action: expected.action,
          requested_targets: expected.targets,
          approved_actions: validated.governance.allowed_actions,
          approved_targets: validated.governance.targets,
        },
      );
    }
    return this.consume(
      reference,
      {
        project_id: expected.project_id,
        target_task_id: expected.target_task_id,
        scope_digest: reference.scope_digest,
        content_hash: reference.content_hash,
      },
      {
        ...evidence,
        action: expected.action,
        targets: expected.targets,
      },
    );
  }

  consume(
    reference: GovernanceAuthorizationReference,
    expected: {
      project_id: string;
      target_task_id: string;
      scope_digest: string;
      content_hash?: string;
    },
    evidence: Record<string, unknown>,
  ): GovernanceRecord {
    const priorIdempotency = this.readIdempotency(reference.idempotency_key);
    if (priorIdempotency?.action === "consume") {
      return this.get(
        priorIdempotency.governance_id,
        priorIdempotency.revision,
      );
    }
    const validated = this.validateAuthorization(reference, expected);
    return this.withLock(
      validated.governance.governance_id,
      validated.governance.revision,
      () => {
        const idempotency = this.readIdempotency(reference.idempotency_key);
        if (idempotency?.action === "consume") {
          return this.get(
            validated.governance.governance_id,
            validated.governance.revision,
          );
        }
        const current = this.get(
          validated.governance.governance_id,
          validated.governance.revision,
        );
        if (current.status !== "effective") {
          throw new GovernanceApprovalError(
            "APPROVAL_ALREADY_CONSUMED",
            `governance is ${current.status}`,
          );
        }
        const usageCount = current.usage_count + 1;
        const consumed =
          current.usage_limit != null && usageCount >= current.usage_limit;
        const parsed = parseFormal(readFileSync(current.path, "utf-8"));
        const destination = this.recordPath(
          consumed ? "consumed" : "effective",
          current.governance_id,
          current.revision,
        );
        this.writeAtomic(
          destination,
          renderFormal(
            {
              ...parsed.frontmatter,
              status: consumed ? "consumed" : "effective",
              usage_count: usageCount,
              last_consumed_at: this.now().toISOString(),
            },
            parsed.body,
          ),
        );
        if (destination !== current.path) unlinkSync(current.path);
        this.writeIdempotency(reference.idempotency_key, {
          governance_id: current.governance_id,
          revision: current.revision,
          approval_id: current.approval_id ?? undefined,
          decision_id: validated.decision.decision_id,
          action: "consume",
        });
        this.audit("governance.consumed", {
          governance_id: current.governance_id,
          revision: current.revision,
          usage_count: usageCount,
          terminal: consumed,
          evidence,
        });
        this.rebuildIndex();
        return this.readRecord(destination);
      },
    );
  }

  list(options: {
    status?: GovernanceStatus;
    targetTaskId?: string;
    limit?: number;
  } = {}): GovernanceRecord[] {
    this.recoverTransactions();
    const rows = this.allRecordPaths()
      .map((path) => this.readRecord(path))
      .map((record) => this.expireIfNeeded(record))
      .filter((record) => !options.status || record.status === options.status)
      .filter(
        (record) =>
          !options.targetTaskId ||
          record.target_task_id === options.targetTaskId,
      )
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
    return rows.slice(0, Math.max(1, Math.min(options.limit ?? 200, 1000)));
  }

  get(governanceId: string, revision: number): GovernanceRecord {
    const path = this.findRecordPath(governanceId, revision);
    if (!path) {
      throw new GovernanceApprovalError(
        "GOVERNANCE_NOT_FOUND",
        `${governanceId} revision ${revision}`,
        404,
      );
    }
    return this.expireIfNeeded(this.readRecord(path));
  }

  latest(governanceId: string): GovernanceRecord | null {
    const rows = this.list({ limit: 1000 }).filter(
      (record) => record.governance_id === governanceId,
    );
    return rows.sort((left, right) => right.revision - left.revision)[0] ?? null;
  }

  listDecisions(governanceId?: string): GovernanceDecisionRecord[] {
    const dir = join(this.formalRoot, "decisions");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => this.readDecision(join(dir, name)))
      .filter(
        (decision) =>
          !governanceId || decision.governance_id === governanceId,
      )
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  getDecision(decisionId: string): GovernanceDecisionRecord {
    const path = join(
      this.formalRoot,
      "decisions",
      `${sanitizeId(decisionId)}.md`,
    );
    if (!existsSync(path)) {
      throw new GovernanceApprovalError(
        "APPROVAL_DECISION_NOT_FOUND",
        decisionId,
        404,
      );
    }
    return this.readDecision(path);
  }

  rebuildIndex(): { count: number; path: string } {
    const rows = this.allRecordPaths()
      .map((path) => this.readRecord(path))
      .sort((left, right) =>
        `${left.governance_id}:${left.revision}`.localeCompare(
          `${right.governance_id}:${right.revision}`,
        ),
      );
    const indexPath = join(this.runtimeRoot, "index.jsonl");
    mkdirSync(dirname(indexPath), { recursive: true });
    const content = rows
      .map((record) =>
        JSON.stringify({
          governance_id: record.governance_id,
          revision: record.revision,
          status: record.status,
          type: record.type,
          approval_id: record.approval_id,
          target_task_id: record.target_task_id,
          thread_key: record.thread_key,
          project_id: record.project_id,
          scope_digest: record.scope_digest,
          content_hash: record.content_hash,
          blocks_task: record.blocks_task,
          path: record.path,
        }),
      )
      .join("\n");
    this.writeAtomic(indexPath, content ? `${content}\n` : "");
    return { count: rows.length, path: indexPath };
  }

  private assertEnabled(): void {
    if (!this.featureEnabled) {
      throw new GovernanceApprovalError(
        "GOVERNANCE_FEATURE_DISABLED",
        "new governance writes are disabled; existing formal records remain readable",
        503,
      );
    }
  }

  private verifySource(record: GovernanceRecord): void {
    if (!this.targetTaskExists(record.target_task_id)) {
      throw new GovernanceApprovalError(
        "APPROVAL_CREATION_FAILED",
        `target TASK does not exist in the active project: ${record.target_task_id}`,
        409,
      );
    }
    if (record.source_kind !== "admin_chat") return;
    if (!record.source_message_id || !record.source_session_id) {
      throw new GovernanceApprovalError(
        "APPROVAL_CREATION_FAILED",
        "admin_chat source requires source_message_id and source_session_id",
        400,
      );
    }
    if (!this.verifySourceMessage) {
      throw new GovernanceApprovalError(
        "APPROVAL_CREATION_FAILED",
        "no trusted ADMIN chat source verifier is available",
        503,
      );
    }
    const verified = this.verifySourceMessage({
      source_message_id: record.source_message_id,
      source_session_id: record.source_session_id,
      project_id: record.project_id,
      target_task_id: record.target_task_id,
    });
    if (!verified.exists || normalizeText(verified.sender).toUpperCase() !== "ADMIN") {
      this.audit("governance.source_rejected", {
        governance_id: record.governance_id,
        revision: record.revision,
        source_message_id: record.source_message_id,
        sender: verified.sender,
      });
      throw new GovernanceApprovalError(
        "ABSOLUTELY_PROHIBITED",
        "ADMIN source message is missing or forged",
        403,
      );
    }
    if (
      verified.project_id &&
      verified.project_id !== record.project_id &&
      !(verified.task_ids ?? []).includes(record.target_task_id)
    ) {
      throw new GovernanceApprovalError(
        "APPROVAL_CREATION_FAILED",
        "source message is outside the target project and task context",
        409,
      );
    }
    if (verified.immutable === false) {
      throw new GovernanceApprovalError(
        "APPROVAL_CREATION_FAILED",
        "source message is not available through an immutable chat evidence store",
        409,
      );
    }
  }

  private targetTaskExists(taskId: string): boolean {
    const normalized = sanitizeId(taskId).toLowerCase();
    const roots = [
      join(this.root, "fcop", "_lifecycle"),
      join(this.root, "fcop", "tasks"),
    ];
    const pending = roots.filter((path) => existsSync(path));
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) {
          pending.push(path);
          continue;
        }
        if (!entry.name.toLowerCase().endsWith(".md")) continue;
        const base = entry.name.slice(0, -3).toLowerCase();
        if (base === normalized || base.startsWith(`${normalized}-`)) return true;
        try {
          const fm = parseFormal(readFileSync(path, "utf-8")).frontmatter;
          const declared = sanitizeId(
            normalizeText(fm["task_id"]),
          ).toLowerCase();
          if (declared === normalized) return true;
        } catch {
          // Non-governance TASK parsing can fall back to filename matching.
        }
      }
    }
    return false;
  }

  private assertHashes(record: GovernanceRecord): void {
    const parsed = parseFormal(readFileSync(record.path, "utf-8"));
    const fm = parsed.frontmatter;
    const input: GovernanceRecordInput = {
      type: normalizeText(fm["type"]) as GovernanceRecordType,
      issued_by: "ADMIN",
      authored_by: "PM",
      recipient: normalizeText(fm["recipient"]),
      target_task_id: normalizeText(fm["target_task_id"]),
      thread_key: normalizeText(fm["thread_key"]),
      project_id: normalizeText(fm["project_id"]),
      source_kind: normalizeText(
        fm["source_kind"],
      ) as GovernanceRecordInput["source_kind"],
      source_message_id: normalizeText(fm["source_message_id"]) || undefined,
      source_session_id: normalizeText(fm["source_session_id"]) || undefined,
      intent_summary: normalizeText(fm["intent_summary"]),
      boundary_summary: normalizeText(fm["boundary_summary"]),
      allowed_actions: normalizeList(fm["allowed_actions"]),
      prohibited_actions: normalizeList(fm["prohibited_actions"]),
      targets: normalizeList(fm["targets"]),
      effective_conditions: normalizeList(fm["effective_conditions"]),
      expires_at: normalizeText(fm["expires_at"]) || null,
      usage_limit:
        fm["usage_limit"] == null ? null : Number(fm["usage_limit"]),
      retry_semantics: normalizeText(
        fm["retry_semantics"],
      ) as GovernanceRecordInput["retry_semantics"],
      risk_and_rollback: normalizeText(fm["risk_and_rollback"]),
      revocation_conditions: normalizeList(fm["revocation_conditions"]),
      evidence_requirements: normalizeList(fm["evidence_requirements"]),
      references: normalizeList(fm["references"]).filter(
        (value) => value !== normalizeText(fm["target_task_id"]),
      ),
      supersedes: normalizeText(fm["supersedes"]) || null,
      blocks_task: fm["blocks_task"] === true,
    };
    const currentContentHash = digest(contentPayload(input));
    const currentScopeDigest = digest(scopePayload(input));
    if (
      currentContentHash !== record.content_hash ||
      currentScopeDigest !== record.scope_digest
    ) {
      this.audit("governance.tamper_detected", {
        governance_id: record.governance_id,
        revision: record.revision,
        expected_content_hash: record.content_hash,
        actual_content_hash: currentContentHash,
        expected_scope_digest: record.scope_digest,
        actual_scope_digest: currentScopeDigest,
      });
      throw new GovernanceApprovalError(
        "APPROVAL_SCOPE_MISMATCH",
        "formal governance file hash or scope digest changed after submission",
        409,
      );
    }
  }

  private expireIfNeeded(record: GovernanceRecord): GovernanceRecord {
    if (
      !record.expires_at ||
      !["pending_approval", "effective"].includes(record.status) ||
      this.now().getTime() < Date.parse(record.expires_at)
    ) {
      return record;
    }
    return this.withLock(record.governance_id, record.revision, () => {
      const current = this.readRecord(record.path);
      if (!["pending_approval", "effective"].includes(current.status)) {
        return current;
      }
      const parsed = parseFormal(readFileSync(current.path, "utf-8"));
      const destination = this.recordPath(
        "expired",
        current.governance_id,
        current.revision,
      );
      this.writeAtomic(
        destination,
        renderFormal(
          {
            ...parsed.frontmatter,
            status: "expired",
            expired_at: this.now().toISOString(),
          },
          parsed.body,
        ),
      );
      unlinkSync(current.path);
      this.audit("governance.expired", {
        governance_id: current.governance_id,
        revision: current.revision,
      });
      this.rebuildIndex();
      return this.readRecord(destination);
    });
  }

  private readRecord(path: string): GovernanceRecord {
    const parsed = parseFormal(readFileSync(path, "utf-8"));
    const fm = parsed.frontmatter;
    const record: GovernanceRecord = {
      protocol: "fcop",
      version: 1,
      type: normalizeText(fm["type"]) as GovernanceRecordType,
      governance_id: normalizeText(fm["governance_id"]),
      revision: Number(fm["revision"]),
      status: normalizeText(fm["status"]) as GovernanceStatus,
      approval_id: normalizeText(fm["approval_id"]) || null,
      issued_by: "ADMIN",
      authored_by: "PM",
      recipient: normalizeText(fm["recipient"]),
      target_task_id: normalizeText(fm["target_task_id"]),
      thread_key: normalizeText(fm["thread_key"]),
      project_id: normalizeText(fm["project_id"]),
      source_kind: normalizeText(
        fm["source_kind"],
      ) as GovernanceRecordInput["source_kind"],
      source_message_id: normalizeText(fm["source_message_id"]) || null,
      source_session_id: normalizeText(fm["source_session_id"]) || null,
      scope_digest: normalizeText(fm["scope_digest"]),
      content_hash: normalizeText(fm["content_hash"]),
      created_at: normalizeText(fm["created_at"]),
      submitted_at: normalizeText(fm["submitted_at"]) || null,
      expires_at: normalizeText(fm["expires_at"]) || null,
      usage_limit:
        fm["usage_limit"] == null ? null : Number(fm["usage_limit"]),
      usage_count: Number(fm["usage_count"] ?? 0),
      approval_required: true,
      supersedes: normalizeText(fm["supersedes"]) || null,
      blocks_task: fm["blocks_task"] === true,
      retry_semantics:
        (normalizeText(
          fm["retry_semantics"],
        ) as GovernanceRecord["retry_semantics"]) ||
        "explicit_new_approval",
      intent_summary: normalizeText(fm["intent_summary"]),
      boundary_summary: normalizeText(fm["boundary_summary"]),
      allowed_actions: normalizeList(fm["allowed_actions"]),
      prohibited_actions: normalizeList(fm["prohibited_actions"]),
      targets: normalizeList(fm["targets"]),
      effective_conditions: normalizeList(fm["effective_conditions"]),
      risk_and_rollback: normalizeText(fm["risk_and_rollback"]),
      revocation_conditions: normalizeList(fm["revocation_conditions"]),
      evidence_requirements: normalizeList(fm["evidence_requirements"]),
      references: normalizeList(fm["references"]),
      source_verified: fm["source_verified"] === true,
      source_alignment: "admin_confirmation_required",
      path,
    };
    if (
      !record.governance_id ||
      !Number.isSafeInteger(record.revision) ||
      !record.status
    ) {
      throw new GovernanceApprovalError(
        "GOVERNANCE_FILE_CORRUPT",
        `invalid governance file: ${path}`,
        500,
      );
    }
    return record;
  }

  private readDecision(path: string): GovernanceDecisionRecord {
    const fm = parseFormal(readFileSync(path, "utf-8")).frontmatter;
    return {
      protocol: "fcop",
      version: 1,
      type: "APPROVAL_DECISION",
      decision_id: normalizeText(fm["decision_id"]),
      lease_id: normalizeText(fm["lease_id"]) || null,
      approval_id: normalizeText(fm["approval_id"]),
      governance_id: normalizeText(fm["governance_id"]),
      governance_revision: Number(fm["governance_revision"]),
      decided_by: "ADMIN",
      decision: normalizeText(fm["decision"]) as GovernanceDecision,
      scope_digest: normalizeText(fm["scope_digest"]),
      content_hash: normalizeText(fm["content_hash"]),
      created_at: normalizeText(fm["created_at"]),
      source_ui_action_id: normalizeText(fm["source_ui_action_id"]),
      reason: normalizeText(fm["reason"]),
      conditions: normalizeList(fm["conditions"]),
      references: normalizeList(fm["references"]),
      path,
    };
  }

  private findDecisionForRevision(
    governanceId: string,
    revision: number,
  ): GovernanceDecisionRecord | null {
    return (
      this.listDecisions(governanceId).find(
        (decision) => decision.governance_revision === revision,
      ) ?? null
    );
  }

  private recordPath(
    status: GovernanceStatus,
    governanceId: string,
    revision: number,
  ): string {
    const bucket =
      status === "draft"
        ? "draft"
        : status === "pending_approval"
          ? "pending"
          : status === "effective"
            ? "effective"
            : "closed";
    return join(
      this.formalRoot,
      bucket,
      `${sanitizeId(governanceId)}-r${revision}.md`,
    );
  }

  private allRecordPaths(): string[] {
    const paths: string[] = [];
    for (const bucket of ["draft", "pending", "effective", "closed"]) {
      const dir = join(this.formalRoot, bucket);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (name.endsWith(".md")) paths.push(join(dir, name));
      }
    }
    return paths;
  }

  private findRecordPath(
    governanceId: string,
    revision: number,
  ): string | null {
    const suffix = `${sanitizeId(governanceId)}-r${revision}.md`;
    return (
      this.allRecordPaths().find((path) => basename(path) === suffix) ?? null
    );
  }

  private writeCreateOnly(path: string, content: string): void {
    withProjectWriteLeaseSync(this.root, "governance-approval.create", () => {
      mkdirSync(dirname(path), { recursive: true });
      let fd: number;
      try {
        fd = openSync(path, "wx");
      } catch {
        throw new GovernanceApprovalError(
          "IMMUTABLE_FILE_CONFLICT",
          `formal file already exists: ${path}`,
        );
      }
      try {
        writeFileSync(fd, content, "utf-8");
      } finally {
        closeSync(fd);
      }
    });
  }

  private writeAtomic(path: string, content: string): void {
    withProjectWriteLeaseSync(this.root, "governance-approval.update", () => {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(tmp, content, "utf-8");
      renameSync(tmp, path);
    });
  }

  private withLock<T>(
    governanceId: string,
    revision: number,
    fn: () => T,
  ): T {
    return withProjectWriteLeaseSync(this.root, "governance-approval.transaction", () => {
      const lockDir = join(this.runtimeRoot, "locks");
      mkdirSync(lockDir, { recursive: true });
      const path = join(
        lockDir,
        `${sanitizeId(governanceId)}-r${revision}.lock`,
      );
      let fd: number;
      try {
        fd = openSync(path, "wx");
      } catch {
        throw new GovernanceApprovalError(
          "APPROVAL_BUSY",
          `${governanceId} revision ${revision} is being updated`,
          423,
        );
      }
      try {
        return fn();
      } finally {
        closeSync(fd);
        try {
          unlinkSync(path);
        } catch {
          // A stale lock remains fail-closed and is visible to diagnostics.
        }
      }
    });
  }

  private idempotencyPath(key: string): string {
    return join(
      this.runtimeRoot,
      "idempotency",
      `${createHash("sha256").update(key).digest("hex")}.json`,
    );
  }

  private assertIdempotencyAction(actual: string, expected: string): void {
    if (actual !== expected) {
      throw new GovernanceApprovalError(
        "IDEMPOTENCY_CONFLICT",
        `idempotency key belongs to ${actual}, not ${expected}`,
      );
    }
  }

  private readIdempotency(key: string): {
    governance_id: string;
    revision: number;
    approval_id?: string;
    decision_id?: string;
    action: string;
  } | null {
    const path = this.idempotencyPath(key);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as {
      governance_id: string;
      revision: number;
      approval_id?: string;
      decision_id?: string;
      action: string;
    };
  }

  private writeIdempotency(
    key: string,
    value: {
      governance_id: string;
      revision: number;
      approval_id?: string;
      decision_id?: string;
      action: string;
    },
  ): void {
    const path = this.idempotencyPath(key);
    if (existsSync(path)) {
      const existing = readFileSync(path, "utf-8");
      if (existing.trim() !== JSON.stringify(value)) {
        throw new GovernanceApprovalError(
          "IDEMPOTENCY_CONFLICT",
          "idempotency key was already used for another governance action",
        );
      }
      return;
    }
    this.writeCreateOnly(path, `${JSON.stringify(value)}\n`);
  }

  private writeTransaction(value: Record<string, unknown>): void {
    const id = sanitizeId(normalizeText(value["transaction_id"]));
    this.writeAtomic(
      join(this.runtimeRoot, "transactions", `${id}.json`),
      `${JSON.stringify(value, null, 2)}\n`,
    );
  }

  private finishTransaction(transactionId: string): void {
    const path = join(
      this.runtimeRoot,
      "transactions",
      `${sanitizeId(transactionId)}.json`,
    );
    if (existsSync(path)) unlinkSync(path);
  }

  private recoverTransactions(): void {
    const dir = join(this.runtimeRoot, "transactions");
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).filter((item) => item.endsWith(".json"))) {
      const path = join(dir, name);
      const tx = JSON.parse(readFileSync(path, "utf-8")) as Record<
        string,
        unknown
      >;
      const governanceId = normalizeText(tx["governance_id"]);
      const revision = Number(tx["revision"]);
      const decisionId = normalizeText(tx["decision_id"]);
      const decision = this.getDecision(decisionId);
      const current = this.get(governanceId, revision);
      const targetStatus: GovernanceStatus =
        decision.decision === "approved" ? "effective" : decision.decision;
      if (current.status !== targetStatus) {
        const parsed = parseFormal(readFileSync(current.path, "utf-8"));
        const destination = this.recordPath(
          targetStatus,
          governanceId,
          revision,
        );
        this.writeAtomic(
          destination,
          renderFormal(
            {
              ...parsed.frontmatter,
              status: targetStatus,
              decision_id: decisionId,
              decided_at: decision.created_at,
            },
            parsed.body,
          ),
        );
        if (destination !== current.path) unlinkSync(current.path);
      }
      unlinkSync(path);
      this.audit("governance.transaction_recovered", {
        governance_id: governanceId,
        revision,
        decision_id: decisionId,
      });
    }
  }

  private audit(event: string, payload: Record<string, unknown>): void {
    withProjectWriteLeaseSync(this.root, "governance-approval.audit", () => {
      const path = join(this.runtimeRoot, "audit.jsonl");
      mkdirSync(dirname(path), { recursive: true });
      let previousHash = "GENESIS";
      if (existsSync(path)) {
        const lines = readFileSync(path, "utf-8").trim().split(/\r?\n/);
        const last = lines.at(-1);
        if (last) {
          previousHash = normalizeText(
            (JSON.parse(last) as Record<string, unknown>)["entry_hash"],
          );
        }
      }
      const base = {
        event,
        at: this.now().toISOString(),
        project_root: this.root,
        previous_hash: previousHash,
        ...payload,
      };
      const entry = { ...base, entry_hash: digest(base) };
      appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
    });
  }
}
