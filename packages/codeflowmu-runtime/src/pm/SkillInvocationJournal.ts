/**
 * Skill 真实执行账本（与 pm-governance/cycle.jsonl 治理规划记录分离）。
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";

import {
  buildAgentSkillsCatalog,
  readAgentSkillsManifestResolved,
} from "../skills/AgentPlaybookCatalog.ts";

export type SkillInvocationChannel =
  | "governance_planner"
  | "api"
  | "cli"
  | "mcp"
  | "agent_runtime"
  | "auto_inject";

export type SkillInvocationOutcome = "ok" | "failed" | "skipped";

export interface SkillInvocationRecord {
  invocation_id: string;
  at: string;
  skill_id: string;
  /** 面板展示用中文名（来自 manifest；旧记录可由 enrich 补全） */
  skill_display_name?: string;
  channel: SkillInvocationChannel;
  triggered_by?: string;
  caller_role?: string;
  thread_key?: string;
  task_id?: string;
  outcome: SkillInvocationOutcome;
  duration_ms?: number;
  summary: string;
  cycle_id?: string;
  role?: string;
  agent_id?: string;
  session_id?: string;
  reason?: string;
  source?: string;
  cooldown_ms?: number;
  next_retry_at?: number;
  /** Planning evidence is optional for ordinary runtime skills. */
  evidence_version?: 1;
  input_context?: string;
  output_summary?: string;
  brief_section?: string;
  product_decisions?: string[];
  evidence_source?: "pm_runtime_control" | "sdk_tool_call" | "runtime_internal";
  /** Runtime HMAC. Unsigned or modified JSONL rows are never gate evidence. */
  integrity?: string;
}

export type RecordSkillInvocationInput = Omit<
  SkillInvocationRecord,
  "invocation_id" | "at" | "integrity"
> & {
  invocation_id?: string;
  at?: string;
};

function codeflowmuDir(projectRoot: string): string {
  return join(projectRoot, ".codeflowmu");
}

export function skillInvocationJournalPath(projectRoot: string): string {
  return join(codeflowmuDir(projectRoot), "skill-invocations.jsonl");
}

function skillInvocationKeyPath(projectRoot: string): string {
  return join(codeflowmuDir(projectRoot), "runtime", "skill-journal.key");
}

async function readOrCreateJournalKey(projectRoot: string): Promise<string> {
  const path = skillInvocationKeyPath(projectRoot);
  try {
    const existing = (await fs.readFile(path, "utf-8")).trim();
    if (existing) return existing;
  } catch {
    // Create below.
  }
  await fs.mkdir(join(codeflowmuDir(projectRoot), "runtime"), { recursive: true });
  const key = randomBytes(32).toString("hex");
  try {
    await fs.writeFile(path, `${key}\n`, { encoding: "utf-8", flag: "wx" });
    return key;
  } catch {
    return (await fs.readFile(path, "utf-8")).trim();
  }
}

function signableRecord(record: SkillInvocationRecord): string {
  const { integrity: _integrity, ...payload } = record;
  return JSON.stringify(payload);
}

async function signRecord(
  projectRoot: string,
  record: SkillInvocationRecord,
): Promise<string> {
  const key = await readOrCreateJournalKey(projectRoot);
  return createHmac("sha256", key).update(signableRecord(record)).digest("hex");
}

export async function verifySkillInvocationIntegrity(
  projectRoot: string,
  record: SkillInvocationRecord,
): Promise<boolean> {
  if (!record.integrity || !/^[a-f0-9]{64}$/i.test(record.integrity)) return false;
  let expected = "";
  try {
    expected = await signRecord(projectRoot, record);
  } catch {
    return false;
  }
  const actualBuffer = Buffer.from(record.integrity, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function channelFromGovernanceTrigger(
  triggered_by?: string,
): SkillInvocationChannel {
  if (!triggered_by) return "governance_planner";
  if (
    triggered_by === "api" ||
    triggered_by === "cli" ||
    triggered_by === "mcp"
  ) {
    return triggered_by;
  }
  return "governance_planner";
}

export async function recordSkillInvocation(
  projectRoot: string,
  input: RecordSkillInvocationInput,
): Promise<SkillInvocationRecord> {
  const record: SkillInvocationRecord = {
    invocation_id: input.invocation_id ?? randomUUID(),
    at: input.at ?? new Date().toISOString(),
    skill_id: input.skill_id,
    ...(input.skill_display_name
      ? { skill_display_name: input.skill_display_name.slice(0, 120) }
      : {}),
    channel: input.channel,
    outcome: input.outcome,
    summary: (input.summary ?? "").slice(0, 500),
    ...(input.triggered_by ? { triggered_by: input.triggered_by } : {}),
    ...(input.caller_role ? { caller_role: input.caller_role } : {}),
    ...(input.thread_key ? { thread_key: input.thread_key } : {}),
    ...(input.task_id ? { task_id: input.task_id } : {}),
    ...(input.duration_ms != null ? { duration_ms: input.duration_ms } : {}),
    ...(input.cycle_id ? { cycle_id: input.cycle_id } : {}),
    ...(input.role ? { role: input.role } : {}),
    ...(input.agent_id ? { agent_id: input.agent_id } : {}),
    ...(input.session_id ? { session_id: input.session_id } : {}),
    ...(input.reason ? { reason: input.reason.slice(0, 300) } : {}),
    ...(input.source ? { source: input.source.slice(0, 120) } : {}),
    ...(input.cooldown_ms != null ? { cooldown_ms: input.cooldown_ms } : {}),
    ...(input.next_retry_at != null ? { next_retry_at: input.next_retry_at } : {}),
    ...(input.evidence_version ? { evidence_version: input.evidence_version } : {}),
    ...(input.input_context ? { input_context: input.input_context.slice(0, 2000) } : {}),
    ...(input.output_summary ? { output_summary: input.output_summary.slice(0, 2000) } : {}),
    ...(input.brief_section ? { brief_section: input.brief_section.slice(0, 240) } : {}),
    ...(input.product_decisions?.length
      ? { product_decisions: input.product_decisions.map(String).map((v) => v.trim()).filter(Boolean).slice(0, 20) }
      : {}),
    ...(input.evidence_source ? { evidence_source: input.evidence_source } : {}),
  };
  record.integrity = await signRecord(projectRoot, record);
  const dir = codeflowmuDir(projectRoot);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(
    skillInvocationJournalPath(projectRoot),
    `${JSON.stringify(record)}\n`,
    "utf-8",
  );
  return record;
}

export async function recordPlanningSkillEvidence(
  projectRoot: string,
  input: {
    skill_id: string;
    task_id: string;
    session_id: string;
    caller_role: string;
    input_context: string;
    output_summary: string;
    brief_section: string;
    product_decisions: string[];
    thread_key?: string;
  },
): Promise<SkillInvocationRecord> {
  const required: Array<[string, string]> = [
    ["skill_id", input.skill_id],
    ["task_id", input.task_id],
    ["session_id", input.session_id],
    ["input_context", input.input_context],
    ["output_summary", input.output_summary],
    ["brief_section", input.brief_section],
  ];
  const missing = required.filter(([, value]) => !String(value ?? "").trim()).map(([key]) => key);
  if (missing.length) throw new Error(`planning skill evidence missing: ${missing.join(",")}`);
  if (!/^PM(?:[-.]|$)/i.test(input.caller_role.trim())) {
    throw new Error("planning skill evidence is PM-only");
  }
  const decisions = input.product_decisions.map(String).map((v) => v.trim()).filter(Boolean);
  if (!decisions.length) throw new Error("planning skill evidence missing: product_decisions");
  const duplicateCandidates = (await readRecentSkillInvocations(projectRoot, 5000)).filter(
    (row) =>
      row.skill_id === input.skill_id.trim() &&
      row.task_id === input.task_id.trim() &&
      row.session_id === input.session_id.trim() &&
      row.triggered_by === "pm.record_planning_skill_evidence" &&
      row.outcome === "ok",
  );
  for (const duplicate of duplicateCandidates) {
    if (
      duplicate.evidence_source === "pm_runtime_control" &&
      (await verifySkillInvocationIntegrity(projectRoot, duplicate))
    ) {
      return duplicate;
    }
  }
  return recordSkillInvocation(projectRoot, {
    skill_id: input.skill_id.trim(),
    channel: "mcp",
    outcome: "ok",
    summary: input.output_summary,
    caller_role: input.caller_role.trim(),
    task_id: input.task_id.trim(),
    session_id: input.session_id.trim(),
    ...(input.thread_key?.trim() ? { thread_key: input.thread_key.trim() } : {}),
    triggered_by: "pm.record_planning_skill_evidence",
    evidence_version: 1,
    input_context: input.input_context,
    output_summary: input.output_summary,
    brief_section: input.brief_section,
    product_decisions: decisions,
    evidence_source: "pm_runtime_control",
  });
}

export async function readRecentSkillInvocations(
  projectRoot: string,
  limit = 50,
): Promise<SkillInvocationRecord[]> {
  const path = skillInvocationJournalPath(projectRoot);
  let raw = "";
  try {
    raw = await fs.readFile(path, "utf-8");
  } catch {
    return [];
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const out: SkillInvocationRecord[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      out.push(JSON.parse(lines[i]!) as SkillInvocationRecord);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

/** 为面板/API 补全 skill_display_name（兼容旧 jsonl 无该字段）。 */
export async function enrichSkillInvocationsForDisplay(
  projectRoot: string,
  invocations: SkillInvocationRecord[],
): Promise<SkillInvocationRecord[]> {
  if (invocations.length === 0) return invocations;
  const nameById = new Map<string, string>();
  try {
    const resolved = await readAgentSkillsManifestResolved(projectRoot);
    const catalog = buildAgentSkillsCatalog(resolved.data, resolved);
    for (const group of catalog.groups) {
      for (const sk of group.skills) {
        if (sk.id) nameById.set(sk.id, sk.display_name || sk.id);
      }
    }
  } catch {
    /* manifest 缺失时仅回传原记录 */
  }
  return invocations.map((rec) => {
    if (rec.skill_display_name?.trim()) return rec;
    const filled = nameById.get(rec.skill_id);
    if (!filled || filled === rec.skill_id) return rec;
    return { ...rec, skill_display_name: filled };
  });
}

export function skillInvocationToLogCenterRow(
  rec: SkillInvocationRecord,
): {
  id: string;
  ts: number;
  at: string;
  tab: "skills";
  event_type: string;
  level: "ERROR" | "WARN" | "INFO";
  agent_id?: string;
  task_id?: string;
  status?: string;
  reason?: string;
  message?: string;
  tool_name?: string;
  skill_id?: string;
  skill_display_name?: string;
  duration_ms?: number;
  thread_key?: string;
} {
  const ts = Date.parse(rec.at);
  const level: "ERROR" | "WARN" | "INFO" =
    rec.outcome === "failed"
      ? "ERROR"
      : rec.outcome === "skipped"
        ? "WARN"
        : "INFO";
  return {
    id: `skill-${rec.invocation_id}`,
    ts: Number.isFinite(ts) ? ts : Date.now(),
    at: rec.at,
    tab: "skills",
    event_type: "skill.invocation",
    level,
    ...(rec.caller_role ? { agent_id: rec.caller_role } : {}),
    ...(rec.task_id ? { task_id: rec.task_id } : {}),
    ...(rec.thread_key ? { thread_key: rec.thread_key } : {}),
    status: rec.outcome,
    reason: rec.channel,
    message: `[${rec.skill_display_name ?? rec.skill_id}] ${rec.summary}`.slice(
      0,
      500,
    ),
    tool_name: rec.skill_display_name ?? rec.skill_id,
    skill_id: rec.skill_id,
    skill_display_name: rec.skill_display_name ?? rec.skill_id,
    ...(rec.duration_ms != null ? { duration_ms: rec.duration_ms } : {}),
  };
}

/** API / 面板路由：包装一次 skill 执行并落盘。 */
export async function invokePmSkillWithJournal<T>(
  projectRoot: string,
  meta: {
    skill_id: string;
    channel?: SkillInvocationChannel;
    thread_key?: string;
    task_id?: string;
    caller_role?: string;
    triggered_by?: string;
    cycle_id?: string;
  },
  fn: () => Promise<T>,
  mapResult: (result: T) => {
    outcome: SkillInvocationOutcome;
    summary: string;
  },
): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    const mapped = mapResult(result);
    await recordSkillInvocation(projectRoot, {
      skill_id: meta.skill_id,
      channel: meta.channel ?? "api",
      outcome: mapped.outcome,
      summary: mapped.summary,
      ...(meta.thread_key ? { thread_key: meta.thread_key } : {}),
      ...(meta.task_id ? { task_id: meta.task_id } : {}),
      ...(meta.caller_role ? { caller_role: meta.caller_role } : {}),
      ...(meta.triggered_by ? { triggered_by: meta.triggered_by } : {}),
      ...(meta.cycle_id ? { cycle_id: meta.cycle_id } : {}),
      duration_ms: Date.now() - t0,
    });
    return result;
  } catch (err) {
    await recordSkillInvocation(projectRoot, {
      skill_id: meta.skill_id,
      channel: meta.channel ?? "api",
      outcome: "failed",
      summary: String(err).slice(0, 400),
      ...(meta.thread_key ? { thread_key: meta.thread_key } : {}),
      ...(meta.task_id ? { task_id: meta.task_id } : {}),
      ...(meta.caller_role ? { caller_role: meta.caller_role } : {}),
      ...(meta.triggered_by ? { triggered_by: meta.triggered_by } : {}),
      ...(meta.cycle_id ? { cycle_id: meta.cycle_id } : {}),
      duration_ms: Date.now() - t0,
    }).catch(() => {});
    throw err;
  }
}
