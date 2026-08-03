import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  OperationApprovalService,
  isPendingApprovalStatus,
  type OperationApprovalRecord,
  type PrepareOperationInput,
} from "./OperationApprovalService.ts";

export const APPROVAL_CREATION_PENDING = "APPROVAL_CREATION_PENDING";

export type AgentApprovalNotice = {
  outcome: "APPROVAL_REQUIRED";
  operation_executed: false;
  approval_id: string;
  status: "pending" | "pending_information" | "pending_executor";
  rule_ids: string[];
  reason_zh: string;
  operation_summary_zh: string;
  exact_targets: string[];
  approver: "ADMIN";
  project_id: string;
  task_id: string;
  thread_key: string;
  role: string;
  operation_fingerprint: string;
  task_execution_blocked: true;
  required_agent_action: "WAIT_FOR_APPROVAL_RESULT";
  prohibited_while_waiting: string[];
  resume_on: "approval_decision_event";
};

export type ApprovalCreationResult =
  | { outcome: "ALLOW"; operation_digest: string; reason: string }
  | { outcome: "APPROVAL_REQUIRED"; approval: OperationApprovalRecord; notice: AgentApprovalNotice }
  | {
      outcome: "APPROVAL_CREATION_PENDING";
      code: typeof APPROVAL_CREATION_PENDING;
      request_id: string;
      operation_fingerprint: string;
      retry_path: string;
      error: string;
    };

function stableRequestId(input: PrepareOperationInput): string {
  const payload = JSON.stringify({
    project: input.request.subject.project_id,
    task: input.request.subject.task_id ?? "",
    thread: input.thread_key ?? "",
    fingerprint: input.operation_fingerprint ?? "",
    rules: input.rule_ids ?? [],
  });
  return createHash("sha256").update(payload).digest("hex");
}

function noticeStatus(record: OperationApprovalRecord): AgentApprovalNotice["status"] {
  if (record.status === "pending_information") return "pending_information";
  if (record.status === "pending_executor") return "pending_executor";
  return "pending";
}

function buildNotice(record: OperationApprovalRecord): AgentApprovalNotice {
  const facts = record.operation_facts;
  return {
    outcome: "APPROVAL_REQUIRED",
    operation_executed: false,
    approval_id: record.approval_id,
    status: noticeStatus(record),
    rule_ids: record.rule_ids ?? [],
    reason_zh: record.reason,
    operation_summary_zh: `${facts?.operation.kind ?? record.request.action.operation}：${record.request.action.capability}`,
    exact_targets: facts?.operation.canonical_targets ?? record.request.resource.targets,
    approver: "ADMIN",
    project_id: record.project_id,
    task_id: String(record.task_id ?? ""),
    thread_key: String(record.thread_key ?? ""),
    role: String(record.request.subject.role ?? "").toUpperCase(),
    operation_fingerprint: String(record.operation_fingerprint ?? ""),
    task_execution_blocked: true,
    required_agent_action: "WAIT_FOR_APPROVAL_RESULT",
    prohibited_while_waiting: [
      "retry_same_operation",
      "change_command_to_bypass_approval",
      "switch_channel_to_bypass_approval",
      "dispatch_task",
      "write_report",
      "archive_or_advance_gate",
    ],
    resume_on: "approval_decision_event",
  };
}

export class UniversalApprovalStore {
  private readonly root: string;
  private readonly service: OperationApprovalService;

  constructor(projectRoot: string) {
    this.root = resolve(projectRoot);
    this.service = new OperationApprovalService({ projectRoot: this.root });
  }

  createPending(input: PrepareOperationInput): ApprovalCreationResult {
    try {
      const prepared = this.service.prepare(input);
      if (prepared.decision === "ALLOW") {
        return {
          outcome: "ALLOW",
          operation_digest: prepared.operation_digest,
          reason: prepared.reason,
        };
      }
      const persisted = this.service.get(prepared.approval.approval_id);
      if (!persisted.approval_id || !isPendingApprovalStatus(persisted.status)) {
        throw new Error(`approval record is not pending: ${persisted.status}`);
      }
      return {
        outcome: "APPROVAL_REQUIRED",
        approval: persisted,
        notice: buildNotice(persisted),
      };
    } catch (error) {
      const requestId = stableRequestId(input);
      const path = join(
        this.root,
        ".codeflowmu",
        "operation-approvals",
        "creation-pending",
        `${requestId}.json`,
      );
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      const payload = {
        schema_version: "1.0",
        status: "approval_creation_pending",
        request_id: requestId,
        operation_fingerprint: input.operation_fingerprint ?? "",
        requested_at: new Date().toISOString(),
        retry_count: 0,
        input,
        error: error instanceof Error ? error.message : String(error),
      };
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      renameSync(tmp, path);
      return {
        outcome: "APPROVAL_CREATION_PENDING",
        code: APPROVAL_CREATION_PENDING,
        request_id: requestId,
        operation_fingerprint: input.operation_fingerprint ?? "",
        retry_path: path,
        error: payload.error,
      };
    }
  }

  deliverAgentNotice(notice: AgentApprovalNotice): OperationApprovalRecord {
    return this.service.markAgentNoticeDelivered(notice.approval_id, {
      project_id: notice.project_id,
      task_id: notice.task_id,
      thread_key: notice.thread_key,
      role: notice.role,
      operation_fingerprint: notice.operation_fingerprint,
    });
  }

  validateWaitingProjection(notice: AgentApprovalNotice): OperationApprovalRecord {
    const record = this.service.get(notice.approval_id);
    if (
      !isPendingApprovalStatus(record.status) ||
      record.agent_notice_delivered !== true ||
      record.project_id !== notice.project_id ||
      record.project_id !== record.request.subject.project_id ||
      String(record.task_id ?? "") !== notice.task_id ||
      String(record.thread_key ?? "") !== notice.thread_key ||
      String(record.request.subject.role ?? "").toUpperCase() !== notice.role.toUpperCase() ||
      String(record.operation_fingerprint ?? "") !== notice.operation_fingerprint
    ) {
      throw new Error("INVALID_POLICY_FREEZE: approval waiting projection is not backed by a matching pending record and delivered notice");
    }
    return record;
  }
}
