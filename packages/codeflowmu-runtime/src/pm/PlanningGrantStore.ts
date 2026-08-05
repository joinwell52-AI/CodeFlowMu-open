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
}

function safeTaskId(taskId: string): string {
  return taskId.trim().replace(/[^A-Za-z0-9._-]/g, "-");
}

export function planningGrantHistoryPath(projectRoot: string, taskId: string): string {
  return join(projectRoot, ".codeflowmu", "pm-governance", "planning-grants", `${safeTaskId(taskId)}.jsonl`);
}

export async function readPlanningGrantHistory(projectRoot: string, taskId: string): Promise<PlanningGrant[]> {
  try {
    const raw = await readFile(planningGrantHistoryPath(projectRoot, taskId), "utf8");
    return raw.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as PlanningGrant]; } catch { return []; }
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
}): Promise<PlanningGrant> {
  const history = await readPlanningGrantHistory(input.projectRoot, input.rootTaskId);
  const existing = history.find((row) => row.decision_id === input.decisionId);
  if (existing) return existing;
  const grant: PlanningGrant = {
    record_type: "planning_grant",
    grant_id: `PLANNING-GRANT-${input.decisionId}`,
    root_task_id: input.rootTaskId,
    brief_revision: input.briefRevision,
    brief_digest: input.briefDigest,
    validation_digest: input.validationDigest,
    approved_wp_scope: [...new Set(input.approvedWpScope.map((value) => value.trim().toUpperCase()).filter(Boolean))],
    child_contract_digest: input.childContractDigest,
    decision_id: input.decisionId,
    approved_at: input.approvedAt,
    approver: "ADMIN",
    status: "active",
  };
  const path = planningGrantHistoryPath(input.projectRoot, input.rootTaskId);
  await mkdir(join(path, ".."), { recursive: true });
  await appendFile(path, `${JSON.stringify(grant)}\n`, "utf8");
  return grant;
}

export async function currentPlanningGrant(
  projectRoot: string,
  rootTaskId: string,
  current?: { briefRevision?: number; briefDigest?: string; validationDigest?: string },
): Promise<PlanningGrant | null> {
  const grant = [...await readPlanningGrantHistory(projectRoot, rootTaskId)]
    .reverse()
    .find((row) => row.status === "active") ?? null;
  if (!grant) return null;
  if (
    (current?.briefRevision != null && grant.brief_revision !== current.briefRevision) ||
    (current?.briefDigest && grant.brief_digest !== current.briefDigest) ||
    (current?.validationDigest && grant.validation_digest !== current.validationDigest)
  ) return { ...grant, status: "stale" };
  return grant;
}

export function planningGrantAllows(grant: PlanningGrant, wpId: string): boolean {
  if (grant.status !== "active") return false;
  const target = wpId.trim().toUpperCase();
  return grant.approved_wp_scope.includes("*") || grant.approved_wp_scope.includes(target);
}
