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

export const OPERATION_APPROVAL_KINDS = [
  "destructive_operation",
  "external_write",
  "production_release",
  "security_authority_change",
  "governance_boundary_change",
] as const;

export type OperationApprovalKind = (typeof OPERATION_APPROVAL_KINDS)[number];
export type CapabilityDecision = "ALLOW" | "REQUIRE_APPROVAL" | "DENY";
export type OperationApprovalStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "cancelled"
  | "expired"
  | "stale"
  | "executing"
  | "succeeded"
  | "partial_failed"
  | "failed";

export type OperationEffects = {
  destructive?: boolean;
  external_write?: boolean;
  production?: boolean;
  security_change?: boolean;
  governance_change?: boolean;
  /** Observation only in this release; it MUST NOT create or deny approval without a quota model. */
  high_cost?: boolean;
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
    result: "approved" | "rejected" | "cancelled";
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
};

export type HumanConfirmationVerifier = (input: {
  confirmation_id: string;
  operation_digest: string;
  request: CapabilityRequest;
}) => boolean;

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
  const payload = JSON.stringify(stable(request));
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function matchedKinds(effect: OperationEffects): OperationApprovalKind[] {
  const kinds: OperationApprovalKind[] = [];
  if (effect.destructive) kinds.push("destructive_operation");
  if (effect.external_write) kinds.push("external_write");
  if (effect.production) kinds.push("production_release");
  if (effect.security_change) kinds.push("security_authority_change");
  if (effect.governance_change) kinds.push("governance_boundary_change");
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
    return { decision: "DENY", risk_tags: [], reason: "impact_unknown_or_request_incomplete" };
  }
  if (request.effect?.unknown) {
    return { decision: "DENY", risk_tags: [], reason: "impact_unknown" };
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

  prepare(input: PrepareOperationInput):
    | { decision: "ALLOW"; executed: false; operation_digest: string; reason: string }
    | { decision: "REQUIRE_APPROVAL"; executed: false; approval: OperationApprovalRecord } {
    const classification = classifyCapabilityRequest(input.request);
    const operationDigest = computeOperationDigest(input.request);
    this.audit("operation.requested", {
      operation_digest: operationDigest,
      requested_by: input.request.subject.actor,
      request: input.request,
    });
    if (classification.decision === "DENY") {
      this.audit("operation.denied", {
        operation_digest: operationDigest,
        reason: classification.reason,
        request: input.request,
      });
      throw new OperationApprovalError("OPERATION_DENIED", classification.reason, 403);
    }

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
    if (prior?.status === "pending_approval" || prior?.status === "approved") {
      this.audit("approval.request_deduplicated", {
        approval_id: prior.approval_id,
        operation_digest: operationDigest,
        status: prior.status,
      });
      return { decision: "REQUIRE_APPROVAL", executed: false, approval: cloneRecord(prior) };
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
    if (record.status !== "pending_approval") {
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
      (record.status === "pending_approval" || record.status === "approved") &&
      this.now().getTime() >= Date.parse(record.expires_at)
    ) {
      const now = this.now().toISOString();
      record.status = "expired";
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
    mkdirSync(this.recordsDir, { recursive: true });
    const path = this.recordPath(record.approval_id);
    if (createOnly && existsSync(path)) {
      throw new OperationApprovalError("APPROVAL_ID_CONFLICT", record.approval_id, 500);
    }
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
    renameSync(tmp, path);
  }

  private audit(event: string, payload: Record<string, unknown>): void {
    mkdirSync(dirname(this.auditPath), { recursive: true });
    appendFileSync(
      this.auditPath,
      `${JSON.stringify({ event, at: this.now().toISOString(), project_root: this.root, ...payload })}\n`,
      "utf-8",
    );
  }

  private withLock<T>(approvalId: string, fn: () => T): T {
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
  }
}
