import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface PlanningGrant {
  record_type: "planning_grant";
  grant_id: string;
  root_task_id: string;
  brief_revision: number;
  brief_digest: string;
  validation_digest: string;
  approved_wp_scope: string[];
  child_contract_digest: string;
  decision_id: string;
  approved_at: string;
  approver: "ADMIN";
  status: "active" | "revoked" | "stale";
  grant_kind?: "initial_wp00" | "stage";
  approval_reason?: string;
  prerequisite_evidence?: string[];
}

export interface PlanningGrantRevocation {
  record_type: "planning_grant_revocation";
  revocation_id: string;
  root_task_id: string;
  revoked_grant_ids: string[];
  reason: string;
  revoked_at: string;
  approver: "ADMIN";
}

export type PlanningGrantRecord = PlanningGrant | PlanningGrantRevocation;

function safeTaskId(taskId: string): string {
  return taskId.trim().replace(/[^A-Za-z0-9._-]/g, "-");
}

export function planningGrantHistoryPath(projectRoot: string, taskId: string): string {
  return join(projectRoot, ".codeflowmu", "pm-governance", "planning-grants", `${safeTaskId(taskId)}.jsonl`);
}

export async function readPlanningGrantHistory(projectRoot: string, taskId: string): Promise<PlanningGrantRecord[]> {
  try {
    const raw = await readFile(planningGrantHistoryPath(projectRoot, taskId), "utf8");
    return raw.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as PlanningGrantRecord]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

export async function issuePlanningGrant(input: {
  projectRoot: string;
  rootTaskId: string;
  briefRevision: number;
  briefDigest: string;
  validationDigest: string;
  approvedWpScope: string[];
  childContractDigest: string;
  decisionId: string;
  approvedAt: string;
  grantKind?: "initial_wp00" | "stage";
  approvalReason?: string;
  prerequisiteEvidence?: string[];
}): Promise<PlanningGrant> {
  const history = await readPlanningGrantHistory(input.projectRoot, input.rootTaskId);
  const existing = history.find((row): row is PlanningGrant => row.record_type === "planning_grant" && row.decision_id === input.decisionId);
  if (existing) return existing;
  const scope = [...new Set(input.approvedWpScope.map((value) => value.trim().toUpperCase()).filter(Boolean))];
  if (!scope.length || scope.includes("*")) throw new Error("Planning Grant requires an explicit non-wildcard WP scope");
  if (scope.some((value) => !/^WP-\d+$/i.test(value))) throw new Error("Planning Grant scope contains an invalid WP id");
  const grant: PlanningGrant = {
    record_type: "planning_grant",
    grant_id: `PLANNING-GRANT-${input.decisionId}`,
    root_task_id: input.rootTaskId,
    brief_revision: input.briefRevision,
    brief_digest: input.briefDigest,
    validation_digest: input.validationDigest,
    approved_wp_scope: scope,
    child_contract_digest: input.childContractDigest,
    decision_id: input.decisionId,
    approved_at: input.approvedAt,
    approver: "ADMIN",
    status: "active",
    grant_kind: input.grantKind ?? "stage",
    ...(input.approvalReason?.trim() ? { approval_reason: input.approvalReason.trim() } : {}),
    ...(input.prerequisiteEvidence?.length ? { prerequisite_evidence: [...new Set(input.prerequisiteEvidence.map(String).filter(Boolean))] } : {}),
  };
  const path = planningGrantHistoryPath(input.projectRoot, input.rootTaskId);
  await mkdir(join(path, ".."), { recursive: true });
  await appendFile(path, `${JSON.stringify(grant)}\n`, "utf8");
  return grant;
}

export async function revokePlanningGrants(input: {
  projectRoot: string;
  rootTaskId: string;
  grantIds: string[];
  reason: string;
  revokedAt?: string;
}): Promise<PlanningGrantRevocation> {
  const ids = [...new Set(input.grantIds.map((value) => value.trim()).filter(Boolean))];
  if (!ids.length || !input.reason.trim()) throw new Error("grant ids and revocation reason are required");
  const row: PlanningGrantRevocation = {
    record_type: "planning_grant_revocation",
    revocation_id: `PLANNING-REVOCATION-${Date.now()}`,
    root_task_id: input.rootTaskId,
    revoked_grant_ids: ids,
    reason: input.reason.trim(),
    revoked_at: input.revokedAt ?? new Date().toISOString(),
    approver: "ADMIN",
  };
  const path = planningGrantHistoryPath(input.projectRoot, input.rootTaskId);
  await mkdir(join(path, ".."), { recursive: true });
  await appendFile(path, `${JSON.stringify(row)}\n`, "utf8");
  return row;
}

export async function currentPlanningGrants(
  projectRoot: string,
  rootTaskId: string,
  current?: { briefRevision?: number; briefDigest?: string; validationDigest?: string },
): Promise<PlanningGrant[]> {
  const history = await readPlanningGrantHistory(projectRoot, rootTaskId);
  const revoked = new Set(history.flatMap((row) => row.record_type === "planning_grant_revocation" ? row.revoked_grant_ids : []));
  return history
    .filter((row): row is PlanningGrant => row.record_type === "planning_grant")
    .filter((grant) => grant.status === "active" && !revoked.has(grant.grant_id))
    .map((grant) => (
      (current?.briefRevision != null && grant.brief_revision !== current.briefRevision) ||
      (current?.briefDigest && grant.brief_digest !== current.briefDigest) ||
      (current?.validationDigest && grant.validation_digest !== current.validationDigest)
        ? { ...grant, status: "stale" as const }
        : grant
    ));
}

export async function currentPlanningGrant(
  projectRoot: string,
  rootTaskId: string,
  current?: { briefRevision?: number; briefDigest?: string; validationDigest?: string },
): Promise<PlanningGrant | null> {
  const grant = [...await currentPlanningGrants(projectRoot, rootTaskId, current)].reverse()[0] ?? null;
  if (!grant) return null;
  return grant;
}

export function planningGrantAllows(grant: PlanningGrant, wpId: string): boolean {
  if (grant.status !== "active") return false;
  const target = wpId.trim().toUpperCase();
  return grant.approved_wp_scope.includes("*") || grant.approved_wp_scope.includes(target);
}

export function planningGrantsAllow(grants: PlanningGrant[], wpId: string): boolean {
  return grants.some((grant) => planningGrantAllows(grant, wpId));
}
