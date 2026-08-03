import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const PLANNING_GATE_DECISIONS = [
  "approve_wp00",
  "request_plan_change",
  "pause",
  "replan",
  "terminate",
] as const;
export type PlanningGateDecisionValue = typeof PLANNING_GATE_DECISIONS[number];

export interface PlanningGateSubmission {
  record_type: "submission";
  submission_id: string;
  task_id: string;
  thread_key: string;
  revision: number;
  body_digest: string;
  validation_digest: string;
  source_digest: string;
  submitted_by: string;
  submitted_at: string;
}

export interface PlanningGateDecision {
  record_type: "decision";
  decision_id: string;
  task_id: string;
  thread_key: string;
  revision: number;
  body_digest: string;
  validation_digest: string;
  decision: PlanningGateDecisionValue;
  reason: string;
  decided_by: "ADMIN";
  decided_at: string;
  notice_status: "pending" | "delivered" | "failed";
  wake_status: "pending" | "started" | "failed" | "unavailable";
  notice_detail?: string;
  wake_detail?: string;
}

export type PlanningGateRecord = PlanningGateSubmission | PlanningGateDecision;

function safeTaskId(taskId: string): string {
  return taskId.trim().replace(/[^A-Za-z0-9._-]/g, "-");
}

export function planningGateHistoryPath(projectRoot: string, taskId: string): string {
  return join(projectRoot, ".codeflowmu", "pm-governance", "planning-gates", `${safeTaskId(taskId)}.jsonl`);
}

async function appendRecord(projectRoot: string, record: PlanningGateRecord): Promise<string> {
  const path = planningGateHistoryPath(projectRoot, record.task_id);
  await mkdir(join(path, ".."), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  return path;
}

export async function readPlanningGateHistory(projectRoot: string, taskId: string): Promise<PlanningGateRecord[]> {
  try {
    const raw = await readFile(planningGateHistoryPath(projectRoot, taskId), "utf8");
    return raw.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as PlanningGateRecord]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

export async function submitPlanningGate(input: {
  projectRoot: string;
  taskId: string;
  threadKey: string;
  revision: number;
  bodyDigest: string;
  validationDigest: string;
  sourceDigest: string;
  submittedBy: string;
  now?: Date;
}): Promise<PlanningGateSubmission> {
  if (!input.taskId || !input.threadKey || !Number.isInteger(input.revision) || input.revision < 1) throw new Error("task_id, thread_key and positive revision are required");
  if (!/^sha256:[0-9a-f]{64}$/i.test(input.bodyDigest) || !/^sha256:[0-9a-f]{64}$/i.test(input.validationDigest)) throw new Error("body_digest and validation_digest must be SHA-256 values");
  const now = input.now ?? new Date();
  const existing = [...await readPlanningGateHistory(input.projectRoot, input.taskId)]
    .reverse()
    .find((row): row is PlanningGateSubmission => row.record_type === "submission");
  if (existing && existing.thread_key === input.threadKey && existing.revision === input.revision && existing.body_digest === input.bodyDigest && existing.validation_digest === input.validationDigest) {
    return existing;
  }
  const row: PlanningGateSubmission = {
    record_type: "submission",
    submission_id: `PLANNING-REVIEW-${now.getTime()}`,
    task_id: input.taskId,
    thread_key: input.threadKey,
    revision: input.revision,
    body_digest: input.bodyDigest,
    validation_digest: input.validationDigest,
    source_digest: input.sourceDigest,
    submitted_by: input.submittedBy,
    submitted_at: now.toISOString(),
  };
  await appendRecord(input.projectRoot, row);
  return row;
}

export async function decidePlanningGate(input: {
  projectRoot: string;
  taskId: string;
  threadKey: string;
  revision: number;
  bodyDigest: string;
  validationDigest: string;
  decision: PlanningGateDecisionValue;
  reason: string;
  noticeStatus?: PlanningGateDecision["notice_status"];
  wakeStatus?: PlanningGateDecision["wake_status"];
  noticeDetail?: string;
  wakeDetail?: string;
  now?: Date;
}): Promise<PlanningGateDecision> {
  if (!PLANNING_GATE_DECISIONS.includes(input.decision)) throw new Error("invalid Planning Gate decision");
  if (!input.reason.trim()) throw new Error("decision reason is required");
  const history = await readPlanningGateHistory(input.projectRoot, input.taskId);
  const submission = [...history].reverse().find((row): row is PlanningGateSubmission => row.record_type === "submission");
  if (!submission || submission.thread_key !== input.threadKey || submission.revision !== input.revision || submission.body_digest !== input.bodyDigest || submission.validation_digest !== input.validationDigest) {
    throw new Error("Planning Gate submission is missing or stale for this revision/digest");
  }
  const now = input.now ?? new Date();
  const row: PlanningGateDecision = {
    record_type: "decision",
    decision_id: `PLANNING-DECISION-${now.getTime()}`,
    task_id: input.taskId,
    thread_key: input.threadKey,
    revision: input.revision,
    body_digest: input.bodyDigest,
    validation_digest: input.validationDigest,
    decision: input.decision,
    reason: input.reason.trim(),
    decided_by: "ADMIN",
    decided_at: now.toISOString(),
    notice_status: input.noticeStatus ?? "pending",
    wake_status: input.wakeStatus ?? "pending",
    ...(input.noticeDetail ? { notice_detail: input.noticeDetail } : {}),
    ...(input.wakeDetail ? { wake_detail: input.wakeDetail } : {}),
  };
  await appendRecord(input.projectRoot, row);
  return row;
}

export async function recordPlanningGateDelivery(
  projectRoot: string,
  decision: PlanningGateDecision,
  delivery: Pick<PlanningGateDecision, "notice_status" | "wake_status"> & {
    notice_detail?: string;
    wake_detail?: string;
  },
): Promise<PlanningGateDecision> {
  const row: PlanningGateDecision = {
    ...decision,
    notice_status: delivery.notice_status,
    wake_status: delivery.wake_status,
    ...(delivery.notice_detail ? { notice_detail: delivery.notice_detail } : {}),
    ...(delivery.wake_detail ? { wake_detail: delivery.wake_detail } : {}),
  };
  await appendRecord(projectRoot, row);
  return row;
}

export async function currentPlanningGateState(
  projectRoot: string,
  taskId: string,
  current?: { revision: number | null; body_digest: string; validation_digest: string },
): Promise<{
  status: "not_submitted" | "pending" | "approved" | "changes_requested" | "paused" | "replan" | "terminated" | "stale";
  submission: PlanningGateSubmission | null;
  decision: PlanningGateDecision | null;
  history: PlanningGateRecord[];
}> {
  const history = await readPlanningGateHistory(projectRoot, taskId);
  const submission = [...history].reverse().find((row): row is PlanningGateSubmission => row.record_type === "submission") ?? null;
  const decision = [...history].reverse().find((row): row is PlanningGateDecision => row.record_type === "decision") ?? null;
  if (!submission) return { status: "not_submitted", submission, decision: null, history };
  const stale = current && (submission.revision !== current.revision || submission.body_digest !== current.body_digest || submission.validation_digest !== current.validation_digest);
  if (stale) return { status: "stale", submission, decision, history };
  if (!decision || decision.revision !== submission.revision || decision.body_digest !== submission.body_digest || decision.validation_digest !== submission.validation_digest) {
    return { status: "pending", submission, decision: null, history };
  }
  const status = {
    approve_wp00: "approved",
    request_plan_change: "changes_requested",
    pause: "paused",
    replan: "replan",
    terminate: "terminated",
  }[decision.decision] as "approved" | "changes_requested" | "paused" | "replan" | "terminated";
  return { status, submission, decision, history };
}
