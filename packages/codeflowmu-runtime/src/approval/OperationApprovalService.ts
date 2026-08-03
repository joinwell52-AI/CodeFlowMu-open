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
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { withProjectWriteLeaseSync } from "../project/ProjectWriteBarrier.ts";

import {
  evaluateNegativePredicates,
  type NegativeRuleId,
  type OperationFacts,
} from "./OperationFacts.ts";

export const OPERATION_APPROVAL_KINDS = [
  "destructive_operation",
  "external_write",
  "production_release",
  "security_authority_change",
  "governance_boundary_change",
  "software_change",
  "process_control",
  "high_cost_operation",
] as const;

export type OperationApprovalKind = (typeof OPERATION_APPROVAL_KINDS)[number];
export type CapabilityDecision = "ALLOW" | "REQUIRE_APPROVAL";

function approvalKindForNegativeRule(ruleId: NegativeRuleId): OperationApprovalKind {
  if (/^(?:NEG\.TRACKED\.DELETE|NEG\.BULK\.CLEANUP|NEG\.IRREVERSIBLE\.EFFECT)$/.test(ruleId)) {
    return "destructive_operation";
  }
  if (/^(?:NEG\.EXTERNAL\.WRITE|NEG\.REMOTE\.GIT\.WRITE)$/.test(ruleId)) {
    return "external_write";
  }
  if (ruleId === "NEG.SECURITY.AUTHORITY") return "security_authority_change";
  if (ruleId === "NEG.RUNTIME.CONTROL") return "process_control";
  if (ruleId === "NEG.RELEASE.PRODUCTION") return "production_release";
  if (ruleId === "NEG.SOFTWARE.SYSTEM.CHANGE") return "software_change";
  return "governance_boundary_change";
}
export type OperationApprovalStatus =
  | "pending"
  | "pending_information"
  | "pending_executor"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "cancelled"
  | "expired"
  | "stale"
  | "executing"
  | "succeeded"
  | "partial_failed"
  | "failed"
  | "revoked"
  | "executed"
  | "execution_failed";

export type OperationEffects = {
  destructive?: boolean;
  external_write?: boolean;
  production?: boolean;
  security_change?: boolean;
  governance_change?: boolean;
  software_change?: boolean;
  process_control?: boolean;
  high_cost?: boolean;
  prohibited?: boolean;
  target_unbounded?: boolean;
  credential_exposure?: boolean;
  governance_bypass?: boolean;
  force_push?: boolean;
  out_of_scope?: boolean;
  unknown?: boolean;
};

export type CapabilityRequest = {
  subject: {
    actor: string;
    role: string;
    project_id: string;
    agent_id?: string;
    session_id?: string;
    task_id?: string;
  };
  action: {
    capability: string;
    operation: string;
    executor: string;
  };
  resource: {
    type: string;
    targets: string[];
    scope?: Record<string, unknown>;
  };
  context: {
    workspace: string;
    environment: string;
    initiated_by: "agent" | "user" | "system";
    authorization_source: "none" | "trusted_ui_confirmation" | "operation_approval";
    human_confirmation_id?: string | null;
  };
  effect: OperationEffects;
  snapshot: Record<string, unknown>;
};

export type OperationApprovalRecord = {
  approval_id: string;
  schema_version: "1.0";
  primary_kind: OperationApprovalKind;
  risk_tags: OperationApprovalKind[];
  project_id: string;
  project_root: string;
  requested_by: string;
  initiator_type: CapabilityRequest["context"]["initiated_by"];
  agent_id?: string;
  session_id?: string;
  task_id?: string;
  authorization_source: CapabilityRequest["context"]["authorization_source"];
  human_confirmation_id?: string | null;
  requested_at: string;
  expires_at: string;
  status: OperationApprovalStatus;
  approval_type?: "OPERATION_APPROVAL";
  decision_mode?: "AUTO" | "ADMIN_MANUAL";
  rule_ids?: string[];
  operation_facts?: OperationFacts;
  operation_fingerprint?: string;
  thread_key?: string;
  missing_information?: string[];
  executor_status?: "ready" | "missing" | "incompatible";
  suggested_executor?: string;
  agent_notice_delivered?: boolean;
  agent_notice_delivered_at?: string | null;
  authorization?: {
    status: "available" | "consumed" | "invalid";
    issued_at: string | null;
    consumed_at: string | null;
    consumed_by?: {
      agent_id: string;
      session_id: string;
      task_id: string;
      thread_key: string;
      role: string;
    };
  };
  decision_delivery?: {
    status: "pending" | "delivered";
    event_id: string | null;
    delivered_at: string | null;
    wake_id: string | null;
    wake_session_id: string | null;
    attempts: number;
    last_error?: string;
  };
  invalid_legacy_rule?: boolean;
  legacy_recovery?: {
    original_status: OperationApprovalStatus;
    migrated_at: string;
    migration_version: "agent-retry-v1";
    reason: string;
  };
  request: CapabilityRequest;
  operation_digest: string;
  reason: string;
  effects: string[];
  non_effects: string[];
  recovery: string;
  approval_policy: {
    approver_roles: string[];
    batch_approvable: false;
    comment_required: boolean;
    expires_in_seconds: number;
  };
  decision: null | {
    result: "approved" | "rejected" | "cancelled" | "expired" | "stale" | "revoked";
    actor: string;
    at: string;
    reason: string;
  };
  execution: {
    status: "not_started" | "executing" | "succeeded" | "partial_failed" | "failed";
    started_at: string | null;
    finished_at: string | null;
    executor_pid?: number;
    evidence: Array<Record<string, unknown>>;
    error?: string;
  };
  token_hash?: string;
  updated_at: string;
};

export type PrepareOperationInput = {
  request: CapabilityRequest;
  reason: string;
  effects: string[];
  non_effects: string[];
  recovery: string;
  expires_in_seconds?: number;
  comment_required?: boolean;
  rule_ids?: string[];
  operation_facts?: OperationFacts;
  operation_fingerprint?: string;
  thread_key?: string;
  missing_information?: string[];
  executor_status?: "ready" | "missing" | "incompatible";
  suggested_executor?: string;
  decision_mode?: "AUTO" | "ADMIN_MANUAL";
};

export type PrepareOperationResult =
  | { decision: "ALLOW"; executed: false; operation_digest: string; reason: string }
  | { decision: "REQUIRE_APPROVAL"; executed: false; approval: OperationApprovalRecord };

export type HumanConfirmationVerifier = (input: {
  confirmation_id: string;
  operation_digest: string;
  request: CapabilityRequest;
}) => boolean;

export type OperationAuthorizationContext = {
  project_id: string;
  operation_fingerprint: string;
  agent_id: string;
  session_id: string;
  task_id: string;
  thread_key: string;
  role: string;
};

export class OperationApprovalError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 409,
  ) {
    super(message);
    this.name = "OperationApprovalError";
  }
}

const KIND_PRIORITY: OperationApprovalKind[] = [
  "governance_boundary_change",
  "security_authority_change",
  "production_release",
  "destructive_operation",
  "external_write",
  "software_change",
  "process_control",
  "high_cost_operation",
];

function normalizeString(value: unknown): string {
  return String(value ?? "").trim();
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((key) => [key, stable(obj[key])]),
    );
  }
  return value;
}

export function computeOperationDigest(request: CapabilityRequest): string {
  const payload = JSON.stringify(stable({
    ...request,
    subject: {
      ...request.subject,
      session_id: undefined,
    },
  }));
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function matchedKinds(effect: OperationEffects): OperationApprovalKind[] {
  const kinds: OperationApprovalKind[] = [];
  if (effect.destructive) kinds.push("destructive_operation");
  if (effect.external_write) kinds.push("external_write");
  if (effect.production) kinds.push("production_release");
  if (effect.security_change) kinds.push("security_authority_change");
  if (effect.governance_change) kinds.push("governance_boundary_change");
  if (effect.software_change) kinds.push("software_change");
  if (effect.process_control) kinds.push("process_control");
  if (effect.high_cost) kinds.push("high_cost_operation");
  return kinds;
}

export function classifyCapabilityRequest(request: CapabilityRequest): {
  decision: CapabilityDecision;
  primary_kind?: OperationApprovalKind;
  risk_tags: OperationApprovalKind[];
  reason: string;
} {
  const targets = request.resource?.targets?.map(normalizeString).filter(Boolean) ?? [];
  if (
    !normalizeString(request.subject?.actor) ||
    !normalizeString(request.subject?.role) ||
    !normalizeString(request.subject?.project_id) ||
    !normalizeString(request.action?.capability) ||
    !normalizeString(request.action?.operation) ||
    !normalizeString(request.action?.executor) ||
    !normalizeString(request.resource?.type) ||
    !normalizeString(request.context?.workspace) ||
    targets.length === 0
  ) {
    return { decision: "ALLOW", risk_tags: [], reason: "no_positive_negative_rule_evidence" };
  }
  if (request.effect?.unknown) {
    return { decision: "ALLOW", risk_tags: [], reason: "unknown_is_not_negative_evidence" };
  }
  for (const [field, reason] of [
    ["prohibited", "operation_permanently_prohibited"],
    ["target_unbounded", "target_set_unbounded"],
    ["credential_exposure", "credential_exposure_prohibited"],
    ["governance_bypass", "governance_bypass_prohibited"],
    ["force_push", "force_push_prohibited"],
    ["out_of_scope", "operation_out_of_scope"],
  ] as const) {
    if (request.effect?.[field]) {
      const tags = matchedKinds(request.effect ?? {});
      const primary = KIND_PRIORITY.find((kind) => tags.includes(kind)) ??
        "governance_boundary_change";
      return {
        decision: "REQUIRE_APPROVAL",
        primary_kind: primary,
        risk_tags: tags.length > 0 ? tags : [primary],
        reason,
      };
    }
  }
  const tags = matchedKinds(request.effect ?? {});
  if (tags.length === 0) {
    return { decision: "ALLOW", risk_tags: [], reason: "within_default_local_reversible_boundary" };
  }
  const primary = KIND_PRIORITY.find((kind) => tags.includes(kind)) ?? tags[0];
  return {
    decision: "REQUIRE_APPROVAL",
    primary_kind: primary,
    risk_tags: tags,
    reason: `capability_boundary:${primary}`,
  };
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function cloneRecord(record: OperationApprovalRecord): OperationApprovalRecord {
  const copy = JSON.parse(JSON.stringify(record)) as OperationApprovalRecord;
  delete copy.token_hash;
  return copy;
}

export function isPendingApprovalStatus(
  status: OperationApprovalStatus | undefined,
): status is "pending" | "pending_information" | "pending_executor" | "pending_approval" {
  return status === "pending" || status === "pending_information" ||
    status === "pending_executor" || status === "pending_approval";
}

export type OperationApprovalServiceOptions = {
  projectRoot: string;
  now?: () => Date;
  idFactory?: () => string;
  verifyHumanConfirmation?: HumanConfirmationVerifier;
};

export class OperationApprovalService {
  private readonly root: string;
  private readonly recordsDir: string;
  private readonly auditPath: string;
  private readonly locksDir: string;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly verifyHumanConfirmation?: HumanConfirmationVerifier;

  constructor(options: OperationApprovalServiceOptions) {
    this.root = resolve(options.projectRoot);
    this.recordsDir = join(this.root, ".codeflowmu", "operation-approvals", "records");
    this.auditPath = join(this.root, ".codeflowmu", "operation-approvals", "audit.jsonl");
    this.locksDir = join(this.root, ".codeflowmu", "operation-approvals", "locks");
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => {
      const d = this.now();
      const ymd = d.toISOString().slice(0, 10).replace(/-/g, "");
      return `APPROVAL-${ymd}-${randomBytes(6).toString("hex")}`;
    });
    this.verifyHumanConfirmation = options.verifyHumanConfirmation;
  }

  prepare(input: PrepareOperationInput): PrepareOperationResult {
    return withProjectWriteLeaseSync(this.root, "operation-approval.prepare", () =>
      this.prepareWithLease(input));
  }

  private prepareWithLease(input: PrepareOperationInput): PrepareOperationResult {
    let classification = classifyCapabilityRequest(input.request);
    const verifiedRuleIds = input.operation_facts
      ? evaluateNegativePredicates(input.operation_facts).map((item) => item.rule_id)
      : [];
    if (verifiedRuleIds.length > 0) {
      const riskTags = [...new Set(verifiedRuleIds.map(approvalKindForNegativeRule))];
      classification = {
        decision: "REQUIRE_APPROVAL",
        primary_kind: riskTags[0] ?? "governance_boundary_change",
        risk_tags: riskTags,
        reason: `verified_negative_rules:${verifiedRuleIds.join(",")}`,
      };
    }
    const operationDigest = computeOperationDigest(input.request);
    this.audit("operation.requested", {
      operation_digest: operationDigest,
      requested_by: input.request.subject.actor,
      request: input.request,
    });
    const confirmationId = normalizeString(input.request.context.human_confirmation_id);
    if (
      input.request.context.initiated_by === "user" &&
      input.request.context.authorization_source === "trusted_ui_confirmation" &&
      confirmationId &&
      this.verifyHumanConfirmation?.({
        confirmation_id: confirmationId,
        operation_digest: operationDigest,
        request: input.request,
      }) === true
    ) {
      this.audit("operation.frontend_confirmation_accepted", {
        operation_digest: operationDigest,
        confirmation_id: confirmationId,
      });
      return {
        decision: "ALLOW",
        executed: false,
        operation_digest: operationDigest,
        reason: "trusted_frontend_confirmation_matches",
      };
    }

    if (classification.decision === "ALLOW") {
      this.audit("operation.classified", {
        decision: "ALLOW",
        operation_digest: operationDigest,
        request: input.request,
      });
      return {
        decision: "ALLOW",
        executed: false,
        operation_digest: operationDigest,
        reason: classification.reason,
      };
    }

    const prior = this.list({ limit: 1000 }).find(
      (row) => row.project_id === input.request.subject.project_id && row.operation_digest === operationDigest,
    );
    if (
      isPendingApprovalStatus(prior?.status) ||
      (prior?.status === "approved" && prior.authorization?.status === "available")
    ) {
      this.audit("approval.request_deduplicated", {
        approval_id: prior.approval_id,
        operation_digest: operationDigest,
        status: prior.status,
      });
      return { decision: "REQUIRE_APPROVAL", executed: false, approval: cloneRecord(prior) };
    }
    if (prior?.status === "approved" && prior.authorization?.status === "consumed") {
      throw new OperationApprovalError(
        "APPROVAL_ALREADY_CONSUMED",
        "the matching one-time authorization has already been consumed",
        409,
      );
    }
    if (prior?.status === "rejected") {
      this.audit("approval.rejected_replay_blocked", {
        approval_id: prior.approval_id,
        operation_digest: operationDigest,
      });
      throw new OperationApprovalError(
        "APPROVAL_REJECTED_REPLAY",
        "the same operation digest was rejected; a materially different request or explicit human resubmission is required",
        409,
      );
    }

    const now = this.now();
    const expiresSeconds = Math.max(30, Math.min(input.expires_in_seconds ?? 900, 86_400));
    const approvalId = sanitizeId(this.idFactory());
    const record: OperationApprovalRecord = {
      approval_id: approvalId,
      schema_version: "1.0",
      primary_kind: classification.primary_kind!,
      risk_tags: classification.risk_tags,
      project_id: input.request.subject.project_id,
      project_root: this.root,
      requested_by: input.request.subject.actor,
      initiator_type: input.request.context.initiated_by,
      ...(input.request.subject.agent_id ? { agent_id: input.request.subject.agent_id } : {}),
      ...(input.request.subject.session_id ? { session_id: input.request.subject.session_id } : {}),
      ...(input.request.subject.task_id ? { task_id: input.request.subject.task_id } : {}),
      authorization_source: input.request.context.authorization_source,
      human_confirmation_id: input.request.context.human_confirmation_id,
      requested_at: now.toISOString(),
      expires_at: new Date(now.getTime() + expiresSeconds * 1000).toISOString(),
      status: "pending_approval",
      approval_type: "OPERATION_APPROVAL",
      decision_mode: input.decision_mode ?? "ADMIN_MANUAL",
      rule_ids: verifiedRuleIds.length > 0
        ? verifiedRuleIds
        : [...new Set(input.rule_ids ?? input.effects.filter((item) => item.startsWith("NEG.")))],
      ...(input.operation_facts ? { operation_facts: input.operation_facts } : {}),
      ...(input.operation_fingerprint ? { operation_fingerprint: input.operation_fingerprint } : {}),
      ...(input.thread_key ? { thread_key: input.thread_key } : {}),
      missing_information: [...new Set(input.missing_information ?? [])],
      executor_status: input.executor_status ?? "ready",
      ...(input.suggested_executor ? { suggested_executor: input.suggested_executor } : {}),
      agent_notice_delivered: false,
      agent_notice_delivered_at: null,
      decision_delivery: {
        status: "pending",
        event_id: null,
        delivered_at: null,
        wake_id: null,
        wake_session_id: null,
        attempts: 0,
      },
      request: input.request,
      operation_digest: operationDigest,
      reason: normalizeString(input.reason) || classification.reason,
      effects: input.effects.map(normalizeString).filter(Boolean),
      non_effects: input.non_effects.map(normalizeString).filter(Boolean),
      recovery: normalizeString(input.recovery),
      approval_policy: {
        approver_roles: ["ADMIN"],
        batch_approvable: false,
        comment_required: input.comment_required !== false,
        expires_in_seconds: expiresSeconds,
      },
      decision: null,
      execution: {
        status: "not_started",
        started_at: null,
        finished_at: null,
        evidence: [],
      },
      updated_at: now.toISOString(),
    };
    this.audit("operation.blocked_for_approval", {
      approval_id: approvalId,
      operation_digest: operationDigest,
      primary_kind: record.primary_kind,
    });
    this.writeRecord(record, true);
    this.audit("approval.created", {
      approval_id: approvalId,
      operation_digest: operationDigest,
      primary_kind: record.primary_kind,
      risk_tags: record.risk_tags,
    });
    return { decision: "REQUIRE_APPROVAL", executed: false, approval: cloneRecord(record) };
  }

  list(options: { status?: OperationApprovalStatus; limit?: number } = {}): OperationApprovalRecord[] {
    if (!existsSync(this.recordsDir)) return [];
    const rows = readdirSync(this.recordsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.readRecord(name.slice(0, -5)))
      .filter((row): row is OperationApprovalRecord => row !== null)
      .map((row) => this.expireIfNeeded(row))
      .map((row) => this.recoverInterruptedIfNeeded(row))
      .filter((row) => !options.status || row.status === options.status)
      .sort((a, b) => b.requested_at.localeCompare(a.requested_at));
    return rows.slice(0, Math.max(1, Math.min(options.limit ?? 200, 1000))).map(cloneRecord);
  }

  get(approvalId: string): OperationApprovalRecord {
    const record = this.readRecord(approvalId);
    if (!record) throw new OperationApprovalError("APPROVAL_NOT_FOUND", approvalId, 404);
    const current = this.recoverInterruptedIfNeeded(this.expireIfNeeded(record));
    this.audit("approval.viewed", {
      approval_id: current.approval_id,
      operation_digest: current.operation_digest,
      status: current.status,
    });
    return cloneRecord(current);
  }

  migrateLegacyRecords(): OperationApprovalRecord[] {
    if (!existsSync(this.recordsDir)) return [];
    const migrated: OperationApprovalRecord[] = [];
    for (const name of readdirSync(this.recordsDir).filter((item) => item.endsWith(".json"))) {
      const approvalId = name.slice(0, -5);
      const current = this.readRecord(approvalId);
      if (!current || current.legacy_recovery) continue;
      const opaque = (current.rule_ids ?? []).includes("NEG.OPAQUE.EFFECT");
      const executorBlocked = current.status === "approved" && (
        current.executor_status === "missing" ||
        current.executor_status === "incompatible" ||
        /^(?:unresolved\.|missing\.|adapter_required)/i.test(current.request.action.executor)
      );
      if (!opaque && !executorBlocked) continue;
      migrated.push(this.withLock(approvalId, () => {
        const record = this.getMutable(approvalId);
        if (record.legacy_recovery) return cloneRecord(record);
        const now = this.now().toISOString();
        const originalStatus = record.status;
        const reason = opaque
          ? "legacy NEG.OPAQUE.EFFECT is not a valid negative rule"
          : "legacy approved record depended on a missing controlled executor";
        record.invalid_legacy_rule = opaque;
        record.legacy_recovery = {
          original_status: originalStatus,
          migrated_at: now,
          migration_version: "agent-retry-v1",
          reason,
        };
        record.status = "revoked";
        record.decision = {
          result: "revoked",
          actor: "SYSTEM",
          at: now,
          reason,
        };
        record.authorization = {
          status: "invalid",
          issued_at: record.authorization?.issued_at ?? null,
          consumed_at: null,
        };
        record.decision_delivery = {
          status: "pending",
          event_id: null,
          delivered_at: null,
          wake_id: null,
          wake_session_id: null,
          attempts: 0,
        };
        delete record.token_hash;
        record.updated_at = now;
        this.writeRecord(record);
        this.audit("approval.legacy_record_revoked", {
          approval_id: record.approval_id,
          original_status: originalStatus,
          invalid_legacy_rule: opaque,
          reason,
        });
        return cloneRecord(record);
      }));
    }
    return migrated;
  }

  markAgentNoticeDelivered(approvalId: string, context: {
    project_id: string;
    task_id: string;
    thread_key: string;
    role: string;
    operation_fingerprint: string;
  }): OperationApprovalRecord {
    return this.withLock(approvalId, () => {
      const record = this.requirePending(approvalId);
      const mismatches = [
        record.project_id === context.project_id ? "" : "project_id",
        String(record.task_id ?? "") === context.task_id ? "" : "task_id",
        String(record.thread_key ?? "") === context.thread_key ? "" : "thread_key",
        String(record.request.subject.role ?? "").toUpperCase() === context.role.toUpperCase() ? "" : "role",
        String(record.operation_fingerprint ?? "") === context.operation_fingerprint ? "" : "operation_fingerprint",
      ].filter(Boolean);
      if (mismatches.length > 0) {
        throw new OperationApprovalError(
          "APPROVAL_SCOPE_MISMATCH",
          `approval context mismatch: ${mismatches.join(", ")}`,
        );
      }
      const now = this.now().toISOString();
      record.agent_notice_delivered = true;
      record.agent_notice_delivered_at = now;
      record.updated_at = now;
      this.writeRecord(record);
      this.audit("approval.agent_notice_delivered", {
        approval_id: record.approval_id,
        operation_fingerprint: record.operation_fingerprint,
      });
      return cloneRecord(record);
    });
  }

  approve(approvalId: string, actor: string, reason: string): {
    approval: OperationApprovalRecord;
    execution_token: string;
  } {
    return this.withLock(approvalId, () => {
      const record = this.requirePending(approvalId);
      const note = normalizeString(reason);
      if (record.approval_policy.comment_required && !note) {
        throw new OperationApprovalError("APPROVAL_REASON_REQUIRED", "approval reason is required", 400);
      }
      if (normalizeString(actor).toUpperCase() !== "ADMIN") {
        throw new OperationApprovalError("APPROVER_NOT_AUTHORIZED", "only ADMIN may approve", 403);
      }
      const token = randomBytes(32).toString("base64url");
      const now = this.now().toISOString();
      record.status = "approved";
      record.decision = { result: "approved", actor: "ADMIN", at: now, reason: note };
      record.authorization = {
        status: "available",
        issued_at: now,
        consumed_at: null,
      };
      record.decision_delivery = {
        status: "pending",
        event_id: null,
        delivered_at: null,
        wake_id: null,
        wake_session_id: null,
        attempts: 0,
      };
      record.token_hash = hashToken(token);
      record.updated_at = now;
      this.writeRecord(record);
      this.audit("approval.approved", {
        approval_id: record.approval_id,
        actor: "ADMIN",
        operation_digest: record.operation_digest,
      });
      const copy = cloneRecord(record);
      delete copy.token_hash;
      return { approval: copy, execution_token: token };
    });
  }

  reject(approvalId: string, actor: string, reason: string): OperationApprovalRecord {
    return this.decideTerminal(approvalId, actor, reason, "rejected");
  }

  cancel(approvalId: string, actor: string, reason: string): OperationApprovalRecord {
    return this.decideTerminal(approvalId, actor, reason, "cancelled");
  }

  consumeApprovedAuthorization(
    currentRequest: CapabilityRequest,
    context: OperationAuthorizationContext,
  ): OperationApprovalRecord | null {
    const operationDigest = computeOperationDigest(currentRequest);
    const candidate = this.list({ limit: 1000 }).find((row) =>
      row.project_id === context.project_id &&
      row.operation_digest === operationDigest &&
      row.operation_fingerprint === context.operation_fingerprint &&
      row.status === "approved"
    );
    if (!candidate) return null;
    return this.withLock(candidate.approval_id, () => {
      const record = this.getMutable(candidate.approval_id);
      this.expireIfNeeded(record);
      if (record.status !== "approved") return null;
      if (record.authorization?.status === "consumed") {
        throw new OperationApprovalError(
          "APPROVAL_ALREADY_CONSUMED",
          `approval ${record.approval_id} authorization has already been consumed`,
        );
      }
      if (record.authorization?.status !== "available") return null;
      const mismatches = [
        record.project_id === context.project_id ? "" : "project_id",
        String(record.operation_fingerprint ?? "") === context.operation_fingerprint ? "" : "operation_fingerprint",
        String(record.agent_id ?? record.request.subject.agent_id ?? "") === context.agent_id ? "" : "agent_id",
        String(record.task_id ?? "") === context.task_id ? "" : "task_id",
        String(record.thread_key ?? "") === context.thread_key ? "" : "thread_key",
        String(record.request.subject.role ?? "").toUpperCase() === context.role.toUpperCase() ? "" : "role",
        String(record.session_id ?? "") && context.session_id ? "" : "session_binding",
      ].filter(Boolean);
      if (mismatches.length > 0) return null;
      const now = this.now().toISOString();
      record.authorization = {
        status: "consumed",
        issued_at: record.authorization.issued_at,
        consumed_at: now,
        consumed_by: {
          agent_id: context.agent_id,
          session_id: context.session_id,
          task_id: context.task_id,
          thread_key: context.thread_key,
          role: context.role,
        },
      };
      record.updated_at = now;
      delete record.token_hash;
      this.writeRecord(record);
      this.audit("approval.authorization_consumed", {
        approval_id: record.approval_id,
        operation_digest: record.operation_digest,
        operation_fingerprint: record.operation_fingerprint,
        consumed_by: record.authorization.consumed_by,
      });
      return cloneRecord(record);
    });
  }

  markDecisionDelivered(approvalId: string, input: {
    event_id: string;
    wake_id: string;
    wake_session_id: string;
  }): OperationApprovalRecord {
    return this.withLock(approvalId, () => {
      const record = this.getMutable(approvalId);
      if (!record.decision) {
        throw new OperationApprovalError("APPROVAL_NOT_DECIDED", `approval ${approvalId} has no decision`);
      }
      if (record.decision_delivery?.status === "delivered") return cloneRecord(record);
      const now = this.now().toISOString();
      record.decision_delivery = {
        status: "delivered",
        event_id: input.event_id,
        delivered_at: now,
        wake_id: input.wake_id,
        wake_session_id: input.wake_session_id,
        attempts: (record.decision_delivery?.attempts ?? 0) + 1,
      };
      record.updated_at = now;
      this.writeRecord(record);
      this.audit("approval.decision_delivered", {
        approval_id: record.approval_id,
        decision: record.decision.result,
        event_id: input.event_id,
        wake_id: input.wake_id,
        wake_session_id: input.wake_session_id,
      });
      return cloneRecord(record);
    });
  }

  markDecisionDeliveryFailed(approvalId: string, error: string): OperationApprovalRecord {
    return this.withLock(approvalId, () => {
      const record = this.getMutable(approvalId);
      const now = this.now().toISOString();
      record.decision_delivery = {
        status: "pending",
        event_id: record.decision_delivery?.event_id ?? null,
        delivered_at: null,
        wake_id: record.decision_delivery?.wake_id ?? null,
        wake_session_id: null,
        attempts: (record.decision_delivery?.attempts ?? 0) + 1,
        last_error: normalizeString(error),
      };
      record.updated_at = now;
      this.writeRecord(record);
      this.audit("approval.decision_delivery_failed", {
        approval_id: record.approval_id,
        decision: record.decision?.result ?? null,
        error: record.decision_delivery.last_error,
      });
      return cloneRecord(record);
    });
  }

  async execute(
    approvalId: string,
    executionToken: string,
    currentRequest: CapabilityRequest,
    executor: (record: OperationApprovalRecord) => Promise<{
      status?: "succeeded" | "partial_failed";
      evidence?: Array<Record<string, unknown>>;
    }>,
  ): Promise<OperationApprovalRecord> {
    const executing = this.withLock(approvalId, () => {
      const record = this.getMutable(approvalId);
      this.expireIfNeeded(record);
      if (record.status !== "approved") {
        const code = record.status === "succeeded" || record.status === "executing"
          ? "APPROVAL_ALREADY_CONSUMED"
          : "PRE_APPROVAL_REQUIRED";
        throw new OperationApprovalError(code, `approval is ${record.status}`);
      }
      if (!record.token_hash || hashToken(executionToken) !== record.token_hash) {
        throw new OperationApprovalError("APPROVAL_TOKEN_INVALID", "execution token does not match", 403);
      }
      const currentDigest = computeOperationDigest(currentRequest);
      if (currentDigest !== record.operation_digest) {
        const now = this.now().toISOString();
        record.status = "stale";
        record.updated_at = now;
        delete record.token_hash;
        this.writeRecord(record);
        this.audit("approval.stale", {
          approval_id: record.approval_id,
          expected_digest: record.operation_digest,
          current_digest: currentDigest,
        });
        throw new OperationApprovalError("APPROVAL_STALE", "operation digest changed");
      }
      const now = this.now().toISOString();
      record.status = "executing";
      record.execution.status = "executing";
      record.execution.started_at = now;
      record.execution.executor_pid = process.pid;
      record.updated_at = now;
      delete record.token_hash;
      this.writeRecord(record);
      this.audit("operation.execution_started", {
        approval_id: record.approval_id,
        operation_digest: record.operation_digest,
      });
      return cloneRecord(record);
    });

    try {
      const result = await executor(executing);
      return this.withLock(approvalId, () => {
        const record = this.getMutable(approvalId);
        if (record.status !== "executing") {
          throw new OperationApprovalError("APPROVAL_STATE_CONFLICT", `approval is ${record.status}`);
        }
        const now = this.now().toISOString();
        const status = result.status ?? "succeeded";
        record.status = status;
        record.execution.status = status;
        record.execution.finished_at = now;
        record.execution.evidence = result.evidence ?? [];
        record.updated_at = now;
        this.writeRecord(record);
        this.audit("operation.execution_finished", {
          approval_id: record.approval_id,
          status,
          evidence: record.execution.evidence,
        });
        for (const evidence of record.execution.evidence) {
          this.audit("operation.target_succeeded", {
            approval_id: record.approval_id,
            evidence,
          });
        }
        return cloneRecord(record);
      });
    } catch (error) {
      return this.withLock(approvalId, () => {
        const record = this.getMutable(approvalId);
        const now = this.now().toISOString();
        record.status = "failed";
        record.execution.status = "failed";
        record.execution.finished_at = now;
        record.execution.error = error instanceof Error ? error.message : String(error);
        record.updated_at = now;
        this.writeRecord(record);
        this.audit("operation.execution_finished", {
          approval_id: record.approval_id,
          status: "failed",
          error: record.execution.error,
        });
        this.audit("operation.target_failed", {
          approval_id: record.approval_id,
          error: record.execution.error,
        });
        return cloneRecord(record);
      });
    }
  }

  private decideTerminal(
    approvalId: string,
    actor: string,
    reason: string,
    result: "rejected" | "cancelled",
  ): OperationApprovalRecord {
    return this.withLock(approvalId, () => {
      const record = this.requirePending(approvalId);
      const normalizedActor = normalizeString(actor);
      if (result === "rejected" && normalizedActor.toUpperCase() !== "ADMIN") {
        throw new OperationApprovalError("APPROVER_NOT_AUTHORIZED", "only ADMIN may reject", 403);
      }
      if (result === "rejected" && !normalizeString(reason)) {
        throw new OperationApprovalError("REJECTION_REASON_REQUIRED", "rejection reason is required", 400);
      }
      if (
        result === "cancelled" &&
        normalizedActor.toUpperCase() !== "ADMIN" &&
        normalizedActor !== record.requested_by
      ) {
        throw new OperationApprovalError(
          "CANCELLER_NOT_AUTHORIZED",
          "only ADMIN or the original requester may cancel",
          403,
        );
      }
      const now = this.now().toISOString();
      record.status = result;
      record.decision = {
        result,
        actor: normalizedActor,
        at: now,
        reason: normalizeString(reason),
      };
      record.authorization = {
        status: "invalid",
        issued_at: null,
        consumed_at: null,
      };
      record.decision_delivery = {
        status: "pending",
        event_id: null,
        delivered_at: null,
        wake_id: null,
        wake_session_id: null,
        attempts: 0,
      };
      record.updated_at = now;
      delete record.token_hash;
      this.writeRecord(record);
      this.audit(`approval.${result}`, {
        approval_id: record.approval_id,
        actor: record.decision.actor,
        operation_digest: record.operation_digest,
      });
      return cloneRecord(record);
    });
  }

  private requirePending(approvalId: string): OperationApprovalRecord {
    const record = this.getMutable(approvalId);
    this.expireIfNeeded(record);
    if (!isPendingApprovalStatus(record.status)) {
      throw new OperationApprovalError("APPROVAL_NOT_PENDING", `approval is ${record.status}`);
    }
    return record;
  }

  private getMutable(approvalId: string): OperationApprovalRecord {
    const record = this.readRecord(approvalId);
    if (!record) throw new OperationApprovalError("APPROVAL_NOT_FOUND", approvalId, 404);
    return record;
  }

  private expireIfNeeded(record: OperationApprovalRecord): OperationApprovalRecord {
    if (
      (isPendingApprovalStatus(record.status) || record.status === "approved") &&
      this.now().getTime() >= Date.parse(record.expires_at)
    ) {
      const now = this.now().toISOString();
      record.status = "expired";
      record.decision = {
        result: "expired",
        actor: "SYSTEM",
        at: now,
        reason: "approval expired before authorization was consumed",
      };
      record.authorization = {
        status: "invalid",
        issued_at: record.authorization?.issued_at ?? null,
        consumed_at: null,
      };
      record.decision_delivery = {
        status: "pending",
        event_id: record.decision_delivery?.event_id ?? null,
        delivered_at: null,
        wake_id: record.decision_delivery?.wake_id ?? null,
        wake_session_id: null,
        attempts: record.decision_delivery?.attempts ?? 0,
      };
      record.updated_at = now;
      delete record.token_hash;
      this.writeRecord(record);
      this.audit("approval.expired", {
        approval_id: record.approval_id,
        operation_digest: record.operation_digest,
      });
    }
    return record;
  }

  private recoverInterruptedIfNeeded(record: OperationApprovalRecord): OperationApprovalRecord {
    if (
      record.status === "executing" &&
      typeof record.execution.executor_pid === "number" &&
      record.execution.executor_pid !== process.pid &&
      !isProcessAlive(record.execution.executor_pid)
    ) {
      const now = this.now().toISOString();
      record.status = "partial_failed";
      record.execution.status = "partial_failed";
      record.execution.finished_at = now;
      record.execution.error = "executor_process_interrupted; target outcome requires inspection";
      record.updated_at = now;
      delete record.token_hash;
      this.writeRecord(record);
      this.audit("operation.execution_interrupted", {
        approval_id: record.approval_id,
        previous_executor_pid: record.execution.executor_pid,
        operation_digest: record.operation_digest,
      });
    }
    return record;
  }

  private recordPath(approvalId: string): string {
    return join(this.recordsDir, `${sanitizeId(approvalId)}.json`);
  }

  private readRecord(approvalId: string): OperationApprovalRecord | null {
    const path = this.recordPath(approvalId);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as OperationApprovalRecord;
    } catch {
      throw new OperationApprovalError("APPROVAL_STORE_CORRUPT", `cannot read ${approvalId}`, 500);
    }
  }

  private writeRecord(record: OperationApprovalRecord, createOnly = false): void {
    withProjectWriteLeaseSync(this.root, "operation-approval.record", () => {
      mkdirSync(this.recordsDir, { recursive: true });
      const path = this.recordPath(record.approval_id);
      if (createOnly && existsSync(path)) {
        throw new OperationApprovalError("APPROVAL_ID_CONFLICT", record.approval_id, 500);
      }
      const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
      renameSync(tmp, path);
    });
  }

  private audit(event: string, payload: Record<string, unknown>): void {
    withProjectWriteLeaseSync(this.root, "operation-approval.audit", () => {
      mkdirSync(dirname(this.auditPath), { recursive: true });
      appendFileSync(
        this.auditPath,
        `${JSON.stringify({ event, at: this.now().toISOString(), project_root: this.root, ...payload })}\n`,
        "utf-8",
      );
    });
  }

  private withLock<T>(approvalId: string, fn: () => T): T {
    return withProjectWriteLeaseSync(this.root, "operation-approval.transaction", () => {
      mkdirSync(this.locksDir, { recursive: true });
      const lockPath = join(this.locksDir, `${sanitizeId(approvalId)}.lock`);
      let fd: number;
      try {
        fd = openSync(lockPath, "wx");
      } catch {
        throw new OperationApprovalError("APPROVAL_BUSY", `approval ${approvalId} is being updated`, 423);
      }
      try {
        return fn();
      } finally {
        closeSync(fd);
        try {
          unlinkSync(lockPath);
        } catch {
          // A stale lock is fail-closed and can be inspected by an operator.
        }
      }
    });
  }
}
