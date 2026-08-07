import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const LONG_HORIZON_SKILL_ID = "pm-long-horizon-planning" as const;

export const LONG_HORIZON_SIGNAL_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["long_term", /长期|长周期|long[- ]?(?:term|horizon|running)/i],
  ["cross_module", /跨模块|架构重构|architecture\s*(?:change|refactor)|cross[- ]?module/i],
  ["work_packages", /\bWP(?:-?\d+)?\b|工作包|任务树|work\s*package/i],
  ["human_gate", /\bGate\b|人工决策|ADMIN\s*决定|planning\s*gate/i],
  ["multi_runtime", /多\s*Runtime|多目录|端口隔离|stable.*candidate|candidate.*stable/i],
  ["recovery", /恢复|重启|回滚|rollback|restart|recovery/i],
  ["experiment", /实验数据|论文证据|可复现|experiment|reproducib/i],
  ["budget", /AI\s*日|Token|工具调用预算|tool\s*call\s*budget/i],
];

function stringField(fm: Record<string, unknown> | undefined, key: string): string {
  const value = fm?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function boolField(fm: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = fm?.[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(true|yes|1)$/i.test(value.trim())) return true;
    if (/^(false|no|0)$/i.test(value.trim())) return false;
  }
  return undefined;
}

export interface LongHorizonClassification {
  required: boolean;
  reason: string;
  matched_signals: string[];
  overridden: boolean;
}

export function classifyLongHorizonPlanning(
  body: string,
  frontmatter: Record<string, unknown> | undefined,
  planningLevel: number,
): LongHorizonClassification {
  const text = String(body ?? "");
  const method = stringField(frontmatter, "planning_method").toLowerCase();
  const overrideBy = stringField(frontmatter, "override_by").toUpperCase();
  const overrideReason = stringField(frontmatter, "override_reason");
  const explicitRequired = boolField(frontmatter, "long_horizon_required");
  const validOverride = overrideBy === "ADMIN" && overrideReason.length > 0;
  if (validOverride && (explicitRequired === false || ["standard", "off", "disabled"].includes(method))) {
    return { required: false, reason: `ADMIN override: ${overrideReason}`, matched_signals: [], overridden: true };
  }
  if (method === "long_horizon" || explicitRequired === true) {
    return { required: true, reason: "explicit_long_horizon", matched_signals: ["explicit"], overridden: validOverride };
  }
  if (/长期总体规划|完整规划书|任务书转计划|long[- ]?horizon\s*plan/i.test(text)) {
    return { required: true, reason: "admin_long_horizon_request", matched_signals: ["explicit_request"], overridden: false };
  }
  if (planningLevel !== 3) {
    return { required: false, reason: "planning_level_not_3", matched_signals: [], overridden: false };
  }
  const lineCount = text.length ? text.split(/\r?\n/).length : 0;
  if (text.length > 12_000 || lineCount > 200) {
    return { required: true, reason: "level_3_long_source", matched_signals: ["source_size"], overridden: false };
  }
  const matched = LONG_HORIZON_SIGNAL_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  return {
    required: matched.length >= 3,
    reason: matched.length >= 3 ? `level_3_complex_signals:${matched.join(",")}` : "insufficient_long_horizon_signals",
    matched_signals: matched,
    overridden: false,
  };
}

export interface PlanningFinding {
  code: string;
  severity: "blocking" | "warning" | "info";
  message: string;
  requirement_ids?: string[];
  evidence?: unknown;
}

export interface PlanningValidationResult {
  task_id: string;
  root_task_id: string;
  thread_key: string;
  session_id: string;
  source_digest: string;
  body_digest: string;
  validation_digest: string;
  requirement_count: number;
  hard_requirement_coverage: number;
  wp_count: number;
  budget_low: number;
  budget_high: number;
  token_budget: number;
  tool_call_budget: number;
  critical_path_days: number;
  fact_snapshot_at: string;
  blocking_findings: PlanningFinding[];
  warnings: PlanningFinding[];
  info_findings: PlanningFinding[];
  ready_for_review: boolean;
  validated_at: string;
  valid_until: string;
}

export interface PlanningReviewSnapshot {
  task_id: string;
  thread_key: string;
  body_digest: string;
  validation_digest: string;
  captured_at: string;
  work_packages: Array<Record<string, unknown>>;
  gates: Array<Record<string, unknown>>;
}

export interface ValidateLongHorizonPlanInput {
  taskId: string;
  rootTaskId: string;
  threadKey: string;
  sessionId: string;
  sourceDigest: string;
  bodyMarkdown: string;
  planningIr: Record<string, unknown>;
  factSnapshotAt: string;
  observedSourceDigest?: string;
  observedSourceLineCount?: number;
  observedSourceText?: string;
  sourceReadError?: string;
  now?: Date;
  ttlMs?: number;
}

export function sha256Digest(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function nonHistoricalBodyLines(body: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let historicalDepth = 0;
  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index] ?? "";
    const heading = /^(#{1,6})\s+(.+)$/.exec(text.trim());
    if (heading) {
      const depth = heading[1]!.length;
      const historical = /历史|已废弃|废弃|superseded|deprecated/i.test(heading[2]!);
      if (historical) historicalDepth = depth;
      else if (historicalDepth && depth <= historicalDepth) historicalDepth = 0;
    }
    if (!historicalDepth) out.push({ line: index + 1, text });
  }
  return out;
}

function collectBodyConsistencyFindings(body: string): PlanningFinding[] {
  const lines = nonHistoricalBodyLines(body);
  const categories: Array<{
    category: string;
    left: RegExp;
    right: RegExp;
    requirement: string;
  }> = [
    {
      category: "planning_gate",
      left: /(?:Planning\s+Gate|规划门禁|规划审批).*(?:pending|waiting|待批准|未批准|等待)/i,
      right: /(?:Planning\s+Gate|规划门禁|规划审批).*(?:approved|通过|已批准)/i,
      requirement: "retain only the current Planning Gate state outside a clearly historical section",
    },
    {
      category: "candidate_cleanliness",
      left: /candidate.*(?:clean|工作区干净|无未提交变更)|候选.*(?:干净|无变更)/i,
      right: /candidate.*(?:dirty|not\s+clean|未提交|有变更)|候选.*(?:不干净|有变更|未提交)/i,
      requirement: "reconcile candidate cleanliness from one current Git snapshot",
    },
    {
      category: "dispatch_scope",
      left: /dispatch.*(?:open|allowed|已开放|允许)|(?:允许|可以).*派发/i,
      right: /dispatch.*(?:closed|blocked|not\s+allowed|未开放|禁止)|(?:禁止|不得|尚未).*派发/i,
      requirement: "state one current dispatch scope and move superseded wording to history",
    },
    {
      category: "waiting_point",
      left: /(?:current\s+)?waiting.*(?:ADMIN|Planning\s+Gate)|当前.*等待.*(?:ADMIN|规划|审批)/i,
      right: /(?:current\s+)?(?:executing|dispatching|implementation\s+started)|当前.*(?:执行中|正在派发|已经开工)/i,
      requirement: "state one current wait/execution point",
    },
  ];
  const findings: PlanningFinding[] = [];
  for (const category of categories) {
    const left = lines.find((row) => category.left.test(row.text));
    const right = lines.find((row) => category.right.test(row.text));
    if (left && right) {
      findings.push({
        code: "PB.BODY.STATE_CONFLICT",
        severity: "blocking",
        message: `${category.category} conflicts at body lines ${left.line} and ${right.line}; ${category.requirement}`,
        evidence: { category: category.category, left, right, repair: category.requirement },
      });
    }
  }
  const t0Claims = lines
    .filter((row) => /\bT0\b/i.test(row.text))
    .flatMap((row) => [...row.text.matchAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})/g)].map((match) => ({ line: row.line, value: match[0], text: row.text })));
  const t0Values = [...new Set(t0Claims.map((claim) => claim.value))];
  if (t0Values.length > 1) {
    findings.push({
      code: "PB.BODY.T0_CONFLICT",
      severity: "blocking",
      message: `T0 has conflicting absolute timestamps: ${t0Values.join(", ")}`,
      evidence: { category: "t0", claims: t0Claims, repair: "retain one authoritative T0 outside historical sections" },
    });
  }
  return findings;
}

function requirementSourceReferenceFinding(
  row: Record<string, unknown>,
  sourceText: string | undefined,
): PlanningFinding | null {
  const id = String(row["id"] ?? "unknown");
  const lineRef = String(row["source_line"] ?? row["source_lines"] ?? "").trim();
  const section = String(row["source_section"] ?? "").trim();
  const quote = String(row["source_text"] ?? row["source_excerpt"] ?? row["source_quote"] ?? "").trim();
  if (!sourceText || !lineRef || !section || !quote) {
    return {
      code: "PB.SOURCE.REFERENCE_MISMATCH",
      severity: "blocking",
      message: `requirement ${id} must cite source_line, source_section and actual source_text`,
      requirement_ids: [id],
    };
  }
  const match = /(?:^|[^0-9])(\d+)(?:\s*[-–:]\s*(\d+))?/.exec(lineRef);
  if (!match) {
    return { code: "PB.SOURCE.REFERENCE_MISMATCH", severity: "blocking", message: `requirement ${id} has an invalid source line reference: ${lineRef}`, requirement_ids: [id] };
  }
  const lines = sourceText.split(/\r?\n/);
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (start < 1 || end < start || end > lines.length) {
    return { code: "PB.SOURCE.REFERENCE_MISMATCH", severity: "blocking", message: `requirement ${id} source lines ${start}-${end} are outside the source`, requirement_ids: [id] };
  }
  const actual = lines.slice(start - 1, end).join("\n");
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const sectionExists = sourceText.split(/\r?\n/).some((line) => normalize(line).includes(normalize(section)));
  if (!sectionExists || !normalize(actual).includes(normalize(quote))) {
    return {
      code: "PB.SOURCE.REFERENCE_MISMATCH",
      severity: "blocking",
      message: `requirement ${id} source citation does not match current taskbook text`,
      requirement_ids: [id],
      evidence: { source_line: lineRef, source_section: section, expected_text: quote, actual_text: actual },
    };
  }
  return null;
}

export function validateLongHorizonPlan(input: ValidateLongHorizonPlanInput): PlanningValidationResult {
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? 5 * 60_000;
  const blocking: PlanningFinding[] = [];
  const warnings: PlanningFinding[] = [];
  const info: PlanningFinding[] = [];
  const ir = input.planningIr;
  const source = ir["source"] as Record<string, unknown> | undefined;
  if (!source || source["read_complete"] !== true || !/^sha256:[0-9a-f]{64}$/i.test(input.sourceDigest)) {
    blocking.push({ code: "PB.SOURCE.INCOMPLETE", severity: "blocking", message: "source must be read through EOF with SHA-256" });
  }
  if (source && String(source["digest"] ?? "") !== input.sourceDigest) {
    blocking.push({ code: "PB.SOURCE.INCOMPLETE", severity: "blocking", message: "IR source digest does not match validation input" });
  }
  if (input.sourceReadError || !input.observedSourceDigest) {
    blocking.push({
      code: "PB.SOURCE.INCOMPLETE",
      severity: "blocking",
      message: `source file could not be verified${input.sourceReadError ? `: ${input.sourceReadError}` : ""}`,
    });
  } else if (input.observedSourceDigest !== input.sourceDigest) {
    blocking.push({
      code: "PB.SOURCE.DIGEST_MISMATCH",
      severity: "blocking",
      message: "declared source digest does not match the current source bytes",
      evidence: { declared: input.sourceDigest, observed: input.observedSourceDigest },
    });
  }
  if (!source || !String(source["path"] ?? "").trim() || !String(source["version"] ?? "").trim() || !String(source["read_at"] ?? "").trim() || !Number.isInteger(source["line_count"]) || Number(source["line_count"]) < 1 || stringArray(source["read_ranges"]).length === 0) {
    blocking.push({ code: "PB.SOURCE.INCOMPLETE", severity: "blocking", message: "source identity/version/line coverage is incomplete" });
  }
  if (source && input.observedSourceLineCount != null && Number(source["line_count"]) !== input.observedSourceLineCount) {
    blocking.push({
      code: "PB.SOURCE.INCOMPLETE",
      severity: "blocking",
      message: "declared source line count does not match the current source file",
      evidence: { declared: source["line_count"], observed: input.observedSourceLineCount },
    });
  }
  const requirements = Array.isArray(ir["requirements"]) ? ir["requirements"] as Array<Record<string, unknown>> : [];
  const workPackages = Array.isArray(ir["work_packages"]) ? ir["work_packages"] as Array<Record<string, unknown>> : [];
  const gates = Array.isArray(ir["gates"]) ? ir["gates"] as Array<Record<string, unknown>> : [];
  const wpIds = new Set(workPackages.map((row) => String(row["id"] ?? "")));
  const gateIds = new Set(gates.map((row) => String(row["id"] ?? "")));
  const hard = requirements.filter((row) => String(row["modality"] ?? "").toUpperCase() === "MUST");
  let hardCovered = 0;
  for (const row of hard) {
    const sourceFinding = requirementSourceReferenceFinding(row, input.observedSourceText);
    if (sourceFinding) blocking.push(sourceFinding);
    const wpRefs = stringArray(row["wp_ids"]);
    const gateRefs = stringArray(row["gate_ids"]);
    const covered = String(row["coverage_status"] ?? "") === "covered" &&
      Boolean(String(row["brief_section"] ?? "").trim()) &&
      Boolean(String(row["responsible_role"] ?? "").trim()) &&
      Boolean(String(row["acceptor"] ?? "").trim()) &&
      wpRefs.length > 0 && wpRefs.every((id) => wpIds.has(id)) &&
      gateRefs.length > 0 && gateRefs.every((id) => gateIds.has(id)) &&
      stringArray(row["tests"]).length > 0 && stringArray(row["evidence"]).length > 0;
    const authorizedNonGoal = String(row["coverage_status"] ?? "") === "non_goal" && Boolean(String(row["admin_authorization"] ?? "").trim());
    if (covered || authorizedNonGoal) hardCovered += 1;
    else blocking.push({ code: "PB.COVERAGE.MISSING", severity: "blocking", message: `hard requirement ${String(row["id"] ?? "unknown")} lacks full mapping` });
  }
  const coverage = hard.length === 0 ? 1 : hardCovered / hard.length;

  const graph = new Map<string, string[]>();
  let budgetLow = 0;
  let budgetHigh = 0;
  let tokenBudget = 0;
  let toolCallBudget = 0;
  const wpHigh = new Map<string, number>();
  for (const wp of workPackages) {
    const id = String(wp["id"] ?? "");
    const deps = stringArray(wp["dependencies"]);
    graph.set(id, deps);
    const budget = wp["budget"] as Record<string, unknown> | undefined;
    const low = finiteNumber(budget?.["ai_days_low"]);
    const high = finiteNumber(budget?.["ai_days_high"]);
    const tokens = finiteNumber(budget?.["tokens"]);
    const calls = finiteNumber(budget?.["tool_calls"]);
    if (!id || low == null || high == null || tokens == null || calls == null || low > high) {
      blocking.push({ code: "PB.BUDGET.MISMATCH", severity: "blocking", message: `invalid budget for ${id || "unnamed WP"}` });
      continue;
    }
    if (wp["includes_admin_wait"] === true) {
      blocking.push({ code: "PB.BUDGET.MISMATCH", severity: "blocking", message: `${id} includes ADMIN wait in AI time` });
    }
    budgetLow += low;
    budgetHigh += high;
    tokenBudget += tokens;
    toolCallBudget += calls;
    wpHigh.set(id, high);
    const requiredTextFields = ["title", "recipient", "parent", "acceptor"];
    const requiredArrayFields = ["inputs", "outputs", "allowed_files", "forbidden_files", "tests", "evidence", "failure_conditions", "rollback"];
    if (requiredTextFields.some((key) => !String(wp[key] ?? "").trim()) || requiredArrayFields.some((key) => stringArray(wp[key]).length === 0)) {
      blocking.push({ code: "PB.COVERAGE.MISSING", severity: "blocking", message: `${id} is missing required execution fields` });
    }
    const startAt = Date.parse(String(wp["start_at"] ?? ""));
    const endAt = Date.parse(String(wp["end_at"] ?? ""));
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) {
      blocking.push({ code: "PB.SCHEDULE.CONFLICT", severity: "blocking", message: `${id} has invalid absolute start/end timestamps` });
    }
    for (const dep of deps) {
      if (!wpIds.has(dep)) blocking.push({ code: "PB.SCHEDULE.CONFLICT", severity: "blocking", message: `${id} references missing dependency ${dep}` });
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const longest = new Map<string, number>();
  let cycle = false;
  const visit = (id: string): number => {
    if (visiting.has(id)) { cycle = true; return 0; }
    if (visited.has(id)) return longest.get(id) ?? 0;
    visiting.add(id);
    const upstream = Math.max(0, ...(graph.get(id) ?? []).map(visit));
    visiting.delete(id);
    visited.add(id);
    const total = upstream + (wpHigh.get(id) ?? 0);
    longest.set(id, total);
    return total;
  };
  for (const id of wpIds) visit(id);
  if (cycle) blocking.push({ code: "PB.SCHEDULE.CONFLICT", severity: "blocking", message: "dependency graph contains a cycle" });
  const criticalPath = cycle ? 0 : Math.max(0, ...longest.values());
  const declared = ir["budget"] as Record<string, unknown> | undefined;
  const totals: Array<[string, number]> = [["ai_days_low", budgetLow], ["ai_days_high", budgetHigh], ["tokens", tokenBudget], ["tool_calls", toolCallBudget]];
  for (const [key, actual] of totals) {
    const expected = finiteNumber(declared?.[key]);
    if (expected == null || Math.abs(expected - actual) > 1e-9) {
      blocking.push({ code: "PB.BUDGET.MISMATCH", severity: "blocking", message: `${key} declared=${String(expected)} calculated=${actual}` });
    }
  }
  for (const wp of workPackages) {
    const id = String(wp["id"] ?? "");
    const startAt = Date.parse(String(wp["start_at"] ?? ""));
    for (const dep of stringArray(wp["dependencies"])) {
      const upstream = workPackages.find((candidate) => String(candidate["id"] ?? "") === dep);
      const upstreamEnd = Date.parse(String(upstream?.["end_at"] ?? ""));
      if (Number.isFinite(startAt) && Number.isFinite(upstreamEnd) && upstreamEnd > startAt) {
        blocking.push({ code: "PB.SCHEDULE.CONFLICT", severity: "blocking", message: `${id} starts before dependency ${dep} ends` });
      }
    }
  }
  const schedule = ir["schedule"] as Record<string, unknown> | undefined;
  for (const key of ["t0", "timezone", "d7_health_check_at", "d10_disposition_at", "delay_threshold", "reschedule_rule"]) {
    if (!String(schedule?.[key] ?? "").trim()) {
      blocking.push({ code: "PB.SCHEDULE.CONFLICT", severity: "blocking", message: `schedule.${key} is required` });
    }
  }
  for (const gate of gates) {
    if (!String(gate["id"] ?? "").trim() || stringArray(gate["prerequisites"]).length === 0 || stringArray(gate["evidence"]).length === 0 || !String(gate["failure_action"] ?? "").trim()) {
      blocking.push({ code: "PB.GATE.INCOMPLETE", severity: "blocking", message: `gate ${String(gate["id"] ?? "unknown")} is incomplete` });
    }
  }
  const recovery = ir["recovery_plan"] as Record<string, unknown> | undefined;
  if (stringArray(recovery?.["preservation_steps"]).length === 0 || stringArray(recovery?.["continuity_cases"]).length === 0) {
    blocking.push({ code: "PB.RECOVERY.INCOMPLETE", severity: "blocking", message: "preservation and continuity recovery contracts are required" });
  }
  if (stringArray(ir["stop_conditions"]).length === 0) {
    blocking.push({ code: "PB.RECOVERY.INCOMPLETE", severity: "blocking", message: "immediate stop conditions are required" });
  }
  const experiment = ir["experiment_data_plan"] as Record<string, unknown> | undefined;
  if (!experiment || (experiment["applicable"] === false && !String(experiment["rationale"] ?? "").trim())) {
    blocking.push({ code: "PB.DATA.INCOMPLETE", severity: "blocking", message: "experiment plan or non-applicability rationale is required" });
  }
  if (!Array.isArray(ir["facts"]) || (ir["facts"] as unknown[]).length === 0) {
    blocking.push({ code: "PB.FACT.UNVERIFIED", severity: "blocking", message: "live fact snapshot is empty" });
  }

  const factAt = Date.parse(input.factSnapshotAt);
  if (!Number.isFinite(factAt)) {
    blocking.push({ code: "PB.FACT.UNVERIFIED", severity: "blocking", message: "fact snapshot timestamp is invalid" });
  } else if (now.getTime() - factAt > ttlMs) {
    blocking.push({ code: "PB.FACT.STALE", severity: "blocking", message: "volatile fact snapshot expired" });
  }
  const semanticFindings = Array.isArray(ir["findings"]) ? ir["findings"] as PlanningFinding[] : [];
  for (const finding of semanticFindings) {
    if (finding?.severity === "blocking") blocking.push(finding);
    else if (finding?.severity === "warning") warnings.push(finding);
    else if (finding) info.push(finding);
  }
  const canonicalBody = input.bodyMarkdown.trim();
  blocking.push(...collectBodyConsistencyFindings(canonicalBody));
  if (/\b(?:TBD|TODO)\b|详见\s*r\d+|同(?:上|前)(?:一)?(?:版|稿)|same as previous|see r\d+/i.test(canonicalBody)) {
    blocking.push({ code: "PB.REVISION.NOT_SELF_CONTAINED", severity: "blocking", message: "body depends on a placeholder or superseded revision" });
  }
  if (/\bgit\s+(?:push|tag)\b|远程\s*push|生产发布|production\s*deploy/i.test(canonicalBody)) {
    blocking.push({ code: "PB.SOURCE.UNAUTHORIZED_ACTION", severity: "blocking", message: "body contains unauthorized release action" });
  }
  const bodyDigest = sha256Digest(canonicalBody);
  const core = {
    task_id: input.taskId,
    root_task_id: input.rootTaskId,
    thread_key: input.threadKey,
    session_id: input.sessionId,
    source_digest: input.sourceDigest,
    body_digest: bodyDigest,
    requirement_count: requirements.length,
    hard_requirement_coverage: coverage,
    wp_count: workPackages.length,
    budget_low: budgetLow,
    budget_high: budgetHigh,
    token_budget: tokenBudget,
    tool_call_budget: toolCallBudget,
    critical_path_days: criticalPath,
    fact_snapshot_at: input.factSnapshotAt,
    blocking_findings: blocking,
    warnings,
    info_findings: info,
    ready_for_review: blocking.length === 0 && coverage === 1,
    validated_at: now.toISOString(),
    valid_until: new Date(now.getTime() + ttlMs).toISOString(),
  };
  return { ...core, validation_digest: sha256Digest(JSON.stringify(core)) };
}

export function planningValidationPath(projectRoot: string, taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, "-");
  return join(projectRoot, ".codeflowmu", "pm-governance", "planning-validations", `${safe}.json`);
}

export async function persistPlanningValidation(
  projectRoot: string,
  result: PlanningValidationResult,
): Promise<string> {
  const path = planningValidationPath(projectRoot, result.root_task_id);
  await mkdir(join(path, ".."), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await rename(temporary, path);
  return path;
}

export function planningReviewSnapshotPath(projectRoot: string, taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, "-");
  return join(projectRoot, ".codeflowmu", "pm-governance", "planning-review-snapshots", `${safe}.json`);
}

export async function persistPlanningReviewSnapshot(
  projectRoot: string,
  validation: PlanningValidationResult,
  planningIr: Record<string, unknown>,
): Promise<string> {
  const path = planningReviewSnapshotPath(projectRoot, validation.root_task_id);
  const snapshot: PlanningReviewSnapshot = {
    task_id: validation.root_task_id,
    thread_key: validation.thread_key,
    body_digest: validation.body_digest,
    validation_digest: validation.validation_digest,
    captured_at: validation.validated_at,
    work_packages: Array.isArray(planningIr["work_packages"])
      ? (planningIr["work_packages"] as Array<Record<string, unknown>>)
      : [],
    gates: Array.isArray(planningIr["gates"])
      ? (planningIr["gates"] as Array<Record<string, unknown>>)
      : [],
  };
  await mkdir(join(path, ".."), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await rename(temporary, path);
  return path;
}

export async function readPlanningReviewSnapshot(
  projectRoot: string,
  taskId: string,
): Promise<PlanningReviewSnapshot | null> {
  try {
    return JSON.parse(await readFile(planningReviewSnapshotPath(projectRoot, taskId), "utf8")) as PlanningReviewSnapshot;
  } catch {
    return null;
  }
}

export async function readPlanningValidation(
  projectRoot: string,
  taskId: string,
): Promise<PlanningValidationResult | null> {
  try {
    return JSON.parse(await readFile(planningValidationPath(projectRoot, taskId), "utf8")) as PlanningValidationResult;
  } catch {
    return null;
  }
}
