import { existsSync, readFileSync } from "node:fs";

import type { Express, Request, Response } from "express";
import {
  GovernanceApprovalError,
  GovernanceApprovalService,
  type GovernanceAuthorizationReference,
  type GovernanceDecision,
  type GovernanceRecordInput,
  type GovernanceStatus,
} from "@codeflowmu/runtime";

import { listChatReadPaths } from "./chat-paths.ts";

type ChatEvidenceRow = {
  id?: string;
  role?: string;
  session_id?: string;
  project_id?: string;
  task_ids?: string[];
};

export interface GovernanceApprovalRouteOptions {
  projectRoot: () => string;
  projectId: () => string;
  emit?: (event: string, payload: Record<string, unknown>) => void;
}

function sendGovernanceError(res: Response, error: unknown): void {
  if (error instanceof GovernanceApprovalError) {
    res.status(error.httpStatus).json({
      ok: false,
      code: error.code,
      error: error.message,
      evidence: error.evidence,
    });
    return;
  }
  res.status(500).json({
    ok: false,
    code: "GOVERNANCE_APPROVAL_FAILED",
    error: error instanceof Error ? error.message : String(error),
  });
}

function requiredString(value: unknown, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new GovernanceApprovalError(
      "GOVERNANCE_SCHEMA_INVALID",
      `${field} is required`,
      400,
    );
  }
  return normalized;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.map((item) => String(item ?? "").trim()).filter(Boolean),
    ),
  ];
}

function governanceInput(body: Record<string, unknown>): GovernanceRecordInput {
  const expiresAt = String(body["expires_at"] ?? "").trim();
  const usageRaw = body["usage_limit"];
  return {
    type: requiredString(body["type"], "type") as GovernanceRecordInput["type"],
    issued_by: "ADMIN",
    authored_by: "PM",
    recipient: requiredString(body["recipient"], "recipient"),
    target_task_id: requiredString(body["target_task_id"], "target_task_id"),
    thread_key: requiredString(body["thread_key"], "thread_key"),
    project_id: requiredString(body["project_id"], "project_id"),
    source_kind: requiredString(
      body["source_kind"],
      "source_kind",
    ) as GovernanceRecordInput["source_kind"],
    source_message_id: String(body["source_message_id"] ?? "").trim() || undefined,
    source_session_id: String(body["source_session_id"] ?? "").trim() || undefined,
    intent_summary: requiredString(body["intent_summary"], "intent_summary"),
    boundary_summary: requiredString(
      body["boundary_summary"],
      "boundary_summary",
    ),
    allowed_actions: stringList(body["allowed_actions"]),
    prohibited_actions: stringList(body["prohibited_actions"]),
    targets: stringList(body["targets"]),
    effective_conditions: stringList(body["effective_conditions"]),
    expires_at: expiresAt || null,
    usage_limit:
      usageRaw == null || usageRaw === "" ? null : Number(usageRaw),
    retry_semantics:
      (String(body["retry_semantics"] ?? "").trim() as GovernanceRecordInput["retry_semantics"]) ||
      "explicit_new_approval",
    risk_and_rollback: requiredString(
      body["risk_and_rollback"],
      "risk_and_rollback",
    ),
    revocation_conditions: stringList(body["revocation_conditions"]),
    evidence_requirements: stringList(body["evidence_requirements"]),
    references: stringList(body["references"]),
    supersedes: String(body["supersedes"] ?? "").trim() || null,
    blocks_task: body["blocks_task"] === true,
  };
}

function readChatEvidence(
  projectRoot: string,
  messageId: string,
): ChatEvidenceRow | null {
  let found: ChatEvidenceRow | null = null;
  for (const chatPath of listChatReadPaths(projectRoot)) {
    if (!existsSync(chatPath)) continue;
    for (const line of readFileSync(chatPath, "utf-8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as ChatEvidenceRow;
        if (String(row.id ?? "") === messageId) found = row;
      } catch {
        // Malformed historical lines are not trusted evidence.
      }
    }
  }
  return found;
}

function approvalCard(
  service: GovernanceApprovalService,
  governanceId: string,
  revision: number,
): Record<string, unknown> {
  const record = service.get(governanceId, revision);
  const decision =
    service.listDecisions(governanceId).find(
      (row) => row.governance_revision === revision,
    ) ?? null;
  return {
    kind: "governance_approval",
    governance_id: record.governance_id,
    revision: record.revision,
    approval_id: record.approval_id,
    status: record.status,
    title: record.intent_summary,
    target_task_id: record.target_task_id,
    source_message_id: record.source_message_id,
    scope_digest: record.scope_digest,
    content_hash: record.content_hash,
    blocks_task: record.blocks_task,
    can_decide: record.status === "pending_approval",
    decision,
  };
}

export function registerGovernanceApprovalRoutes(
  app: Express,
  options: GovernanceApprovalRouteOptions,
): void {
  const service = () =>
    new GovernanceApprovalService({
      projectRoot: options.projectRoot(),
      verifySourceMessage: ({
        source_message_id,
        source_session_id,
        project_id,
        target_task_id,
      }) => {
        const row = readChatEvidence(
          options.projectRoot(),
          source_message_id,
        );
        const evidenceSession = String(row?.session_id ?? row?.id ?? "");
        const rowTasks = Array.isArray(row?.task_ids)
          ? row!.task_ids!.map(String)
          : [];
        return {
          exists:
            Boolean(row) &&
            evidenceSession === source_session_id,
          sender: String(row?.role ?? "").toUpperCase(),
          project_id: String(row?.project_id ?? ""),
          task_ids: rowTasks,
          immutable: Boolean(row),
        };
      },
    });

  app.post("/api/v2/pm/governance/records", (req: Request, res: Response) => {
    try {
      const body = req.body as Record<string, unknown>;
      if (!/^PM(?:[-_.]|$)/i.test(String(body["actor"] ?? "PM"))) {
        throw new GovernanceApprovalError(
          "AUTHOR_NOT_AUTHORIZED",
          "only PM may write governance records",
          403,
        );
      }
      const approvalService = service();
      const record = approvalService.writeDraft(governanceInput(body), {
        idempotencyKey:
          String(req.get("Idempotency-Key") ?? body["idempotency_key"] ?? "").trim() ||
          undefined,
      });
      if (body["submit_immediately"] === true) {
        const governance = approvalService.submit(
          record.governance_id,
          record.revision,
          String(body["actor"] ?? "PM"),
          `${String(body["idempotency_key"] ?? record.governance_id)}:submit`,
        );
        const card = approvalCard(
          approvalService,
          governance.governance_id,
          governance.revision,
        );
        options.emit?.("codeflowmu.governance_approval_pending", card);
        res.status(202).json({
          ok: true,
          governance,
          approval_card: card,
        });
        return;
      }
      res.status(201).json({ ok: true, record });
    } catch (error) {
      sendGovernanceError(res, error);
    }
  });

  app.post(
    "/api/v2/pm/governance/records/:governanceId/:revision/submit",
    (req: Request, res: Response) => {
      try {
        const governance = service().submit(
          String(req.params["governanceId"] ?? ""),
          Number(req.params["revision"]),
          String(req.body?.actor ?? "PM"),
          String(
            req.get("Idempotency-Key") ??
              req.body?.idempotency_key ??
              "",
          ).trim() || undefined,
        );
        const card = approvalCard(
          service(),
          governance.governance_id,
          governance.revision,
        );
        options.emit?.("codeflowmu.governance_approval_pending", card);
        res.status(202).json({ ok: true, governance, approval_card: card });
      } catch (error) {
        sendGovernanceError(res, error);
      }
    },
  );

  app.post(
    "/api/v2/pm/governance/records/:governanceId/:revision/revise",
    (req: Request, res: Response) => {
      try {
        const body = req.body as Record<string, unknown>;
        const record = service().revise(
          String(req.params["governanceId"] ?? ""),
          Number(req.params["revision"]),
          governanceInput(body),
          String(body["actor"] ?? "PM"),
          String(
            req.get("Idempotency-Key") ?? body["idempotency_key"] ?? "",
          ).trim() || undefined,
        );
        res.status(201).json({ ok: true, record });
      } catch (error) {
        sendGovernanceError(res, error);
      }
    },
  );

  app.get("/api/v2/governance/records", (req: Request, res: Response) => {
    try {
      const status = String(req.query["status"] ?? "").trim() as GovernanceStatus;
      const targetTaskId = String(req.query["task_id"] ?? "").trim();
      const rows = service().list({
        ...(status ? { status } : {}),
        ...(targetTaskId ? { targetTaskId } : {}),
        limit: Number(req.query["limit"] ?? 200),
      });
      res.json({
        ok: true,
        records: rows,
        approval_cards: rows.map((row) =>
          approvalCard(service(), row.governance_id, row.revision),
        ),
      });
    } catch (error) {
      sendGovernanceError(res, error);
    }
  });

  app.get(
    "/api/v2/governance/records/:governanceId/:revision",
    (req: Request, res: Response) => {
      try {
        const governanceId = String(req.params["governanceId"] ?? "");
        const revision = Number(req.params["revision"]);
        const approvalService = service();
        res.json({
          ok: true,
          record: approvalService.get(governanceId, revision),
          decisions: approvalService
            .listDecisions(governanceId)
            .filter((row) => row.governance_revision === revision),
          approval_card: approvalCard(
            approvalService,
            governanceId,
            revision,
          ),
        });
      } catch (error) {
        sendGovernanceError(res, error);
      }
    },
  );

  app.post(
    "/api/v2/admin/governance/approvals/:governanceId/:revision/decide",
    (req: Request, res: Response) => {
      try {
        const decision = requiredString(
          req.body?.decision,
          "decision",
        ) as Exclude<GovernanceDecision, "revoked">;
        if (!["approved", "rejected", "changes_requested"].includes(decision)) {
          throw new GovernanceApprovalError(
            "APPROVAL_DECISION_INVALID",
            "decision must be approved, rejected or changes_requested",
            400,
          );
        }
        const result = service().decide({
          governanceId: String(req.params["governanceId"] ?? ""),
          revision: Number(req.params["revision"]),
          approvalId: requiredString(req.body?.approval_id, "approval_id"),
          actor: String(req.body?.actor ?? "ADMIN"),
          decision,
          reason: requiredString(req.body?.reason, "reason"),
          conditions: stringList(req.body?.conditions),
          sourceUiActionId: requiredString(
            req.body?.source_ui_action_id,
            "source_ui_action_id",
          ),
          idempotencyKey: requiredString(
            req.get("Idempotency-Key") ?? req.body?.idempotency_key,
            "idempotency_key",
          ),
        });
        const card = approvalCard(
          service(),
          result.governance.governance_id,
          result.governance.revision,
        );
        options.emit?.("codeflowmu.governance_approval_decided", card);
        res.json({ ok: true, ...result, approval_card: card });
      } catch (error) {
        sendGovernanceError(res, error);
      }
    },
  );

  app.post(
    "/api/v2/admin/governance/approvals/:governanceId/:revision/revoke",
    (req: Request, res: Response) => {
      try {
        const result = service().revoke({
          governanceId: String(req.params["governanceId"] ?? ""),
          revision: Number(req.params["revision"]),
          actor: String(req.body?.actor ?? "ADMIN"),
          reason: requiredString(req.body?.reason, "reason"),
          sourceUiActionId: requiredString(
            req.body?.source_ui_action_id,
            "source_ui_action_id",
          ),
          idempotencyKey: requiredString(
            req.get("Idempotency-Key") ?? req.body?.idempotency_key,
            "idempotency_key",
          ),
        });
        const card = approvalCard(
          service(),
          result.governance.governance_id,
          result.governance.revision,
        );
        options.emit?.("codeflowmu.governance_approval_decided", card);
        res.json({ ok: true, ...result, approval_card: card });
      } catch (error) {
        sendGovernanceError(res, error);
      }
    },
  );

  app.post(
    "/api/v2/governance/authorizations/validate",
    (req: Request, res: Response) => {
      try {
        const reference = req.body?.reference as GovernanceAuthorizationReference;
        const expected = req.body?.expected as {
          project_id: string;
          target_task_id: string;
          scope_digest: string;
          content_hash?: string;
        };
        res.json(service().validateAuthorization(reference, expected));
      } catch (error) {
        sendGovernanceError(res, error);
      }
    },
  );

  app.post(
    "/api/v2/governance/authorizations/consume",
    (req: Request, res: Response) => {
      try {
        const reference = req.body?.reference as GovernanceAuthorizationReference;
        const expected = req.body?.expected as {
          project_id: string;
          target_task_id: string;
          scope_digest: string;
          content_hash?: string;
        };
        const governance = service().consume(
          reference,
          expected,
          (req.body?.evidence ?? {}) as Record<string, unknown>,
        );
        options.emit?.("codeflowmu.governance_authorization_consumed", {
          governance_id: governance.governance_id,
          revision: governance.revision,
          status: governance.status,
          usage_count: governance.usage_count,
        });
        res.json({ ok: true, governance });
      } catch (error) {
        sendGovernanceError(res, error);
      }
    },
  );
}
