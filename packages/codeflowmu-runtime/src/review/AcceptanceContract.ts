import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { EvidenceSummary } from "./ReviewEvidenceResolver.ts";

export type AcceptanceEvidenceType =
  | "command"
  | "file"
  | "json"
  | "csv"
  | "git"
  | "browser"
  | "data"
  | "manual_observation";

export interface AcceptanceContractItem {
  item_id: string;
  claim: string;
  source_location: string;
  required_evidence_types: AcceptanceEvidenceType[];
  validator_id: string;
  validator_version: string;
  applicability_condition: string;
  pass_condition: string;
  fail_condition: string;
  allows_manual_observation: boolean;
  requires_browser: boolean;
  source_path_or_command?: string;
  expected_content_digest?: string;
  required_json_fields?: string[];
  required_csv_columns?: string[];
  minimum_row_count?: number;
  expected_target?: string;
}

export interface AcceptanceContract {
  contract_id: string;
  contract_revision: number;
  contract_digest: string;
  task_id: string;
  wp_id?: string;
  phase?: string;
  source: "task" | "legacy";
  status: "compiled" | "needs_pm" | "legacy";
  items: AcceptanceContractItem[];
  findings: string[];
}

export interface EvidenceEnvelope {
  evidence_id: string;
  task_id: string;
  report_id: string;
  report_revision: number;
  session_id?: string;
  run_id?: string;
  acceptance_item_id: string;
  evidence_type: AcceptanceEvidenceType;
  producer: string;
  source_path_or_command: string;
  cwd_or_target: string;
  exit_code_or_result_status: number | string | null;
  content_digest_or_output_digest: string;
  started_at?: string;
  ended_at?: string;
  provenance: {
    task_bound: boolean;
    report_bound: boolean;
    session_bound: boolean;
    run_bound: boolean;
  };
  validator_result: "pass" | "deterministic_fail" | "needs_pm";
}

export interface AcceptanceContractEvaluation {
  state: "pass" | "deterministic_fail" | "needs_pm";
  contract: AcceptanceContract;
  evidence_digest: string;
  failed_item_ids: string[];
  needs_pm_item_ids: string[];
  findings: string[];
  envelopes: EvidenceEnvelope[];
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(String).map((entry) => entry.trim()).filter(Boolean)
    : typeof value === "string"
      ? value.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean)
      : [];
}

function sha(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function canonicalTaskId(value: string | undefined): string {
  const raw = String(value ?? "").replace(/\.md$/i, "").trim();
  return (/^TASK-\d{8}-\d{3,}/i.exec(raw)?.[0] ?? raw).toUpperCase();
}

function normalizeEvidenceTypes(value: unknown): AcceptanceEvidenceType[] {
  const allowed = new Set<AcceptanceEvidenceType>([
    "command", "file", "json", "csv", "git", "browser", "data", "manual_observation",
  ]);
  return [...new Set(strings(value).map((entry) => entry.toLowerCase()))]
    .filter((entry): entry is AcceptanceEvidenceType => allowed.has(entry as AcceptanceEvidenceType));
}

export function compileAcceptanceContract(input: {
  taskId: string;
  taskFrontmatter: Record<string, unknown>;
  taskBody: string;
}): AcceptanceContract {
  let bodyContract: Record<string, unknown> | null = null;
  const fenced = input.taskBody.match(/```acceptance-contract\s*\r?\n([\s\S]*?)\r?\n```/i);
  if (fenced?.[1]) {
    try {
      bodyContract = object(JSON.parse(fenced[1]));
    } catch {
      bodyContract = { invalid_json: true };
    }
  }
  const rawContract = object(input.taskFrontmatter["acceptance_contract"]) ?? bodyContract;
  const rawItems = rawContract?.["items"] ?? input.taskFrontmatter["acceptance_items"];
  const entries = Array.isArray(rawItems) ? rawItems : [];
  if (entries.length === 0) {
    const declared = input.taskFrontmatter["acceptance_criteria"];
    const hasUnstructured = rawContract?.["invalid_json"] === true ||
      strings(declared).length > 0 ||
      /^#{1,6}\s+(?:acceptance|验收)/im.test(input.taskBody);
    const status: AcceptanceContract["status"] = hasUnstructured ? "needs_pm" : "legacy";
    const findings = hasUnstructured
      ? ["acceptance criteria exist but required_evidence_types/validator are not explicit"]
      : [];
    const base = {
      contract_id: `${input.taskId}-acceptance`,
      contract_revision: Number(rawContract?.["contract_revision"] ?? 1) || 1,
      task_id: input.taskId,
      source: status === "legacy" ? "legacy" as const : "task" as const,
      status,
      items: [],
      findings,
    };
    return { ...base, contract_digest: sha(base) };
  }

  const findings: string[] = [];
  const items = entries.flatMap((entry, index): AcceptanceContractItem[] => {
    const row = object(entry);
    if (!row) {
      findings.push(`acceptance_items[${index}] must be an object`);
      return [];
    }
    const types = normalizeEvidenceTypes(row["required_evidence_types"]);
    const itemId = String(row["item_id"] ?? `AC-${index + 1}`).trim();
    const claim = String(row["claim"] ?? "").trim();
    const validatorId = String(row["validator_id"] ?? "").trim();
    if (!claim || types.length === 0 || !validatorId) {
      findings.push(`${itemId}: claim, required_evidence_types and validator_id are required`);
    }
    const requiresBrowser = row["requires_browser"] === true;
    if (requiresBrowser && !types.includes("browser")) types.push("browser");
    return [{
      item_id: itemId,
      claim,
      source_location: String(row["source_location"] ?? "frontmatter.acceptance_items").trim(),
      required_evidence_types: types,
      validator_id: validatorId,
      validator_version: String(row["validator_version"] ?? "1").trim(),
      applicability_condition: String(row["applicability_condition"] ?? "always").trim(),
      pass_condition: String(row["pass_condition"] ?? "required evidence validates").trim(),
      fail_condition: String(row["fail_condition"] ?? "required evidence is missing or contradicts the claim").trim(),
      allows_manual_observation: row["allows_manual_observation"] === true,
      requires_browser: requiresBrowser,
      ...(row["source_path_or_command"]
        ? { source_path_or_command: String(row["source_path_or_command"]) }
        : {}),
      ...(row["expected_content_digest"]
        ? { expected_content_digest: String(row["expected_content_digest"]) }
        : {}),
      ...(strings(row["required_json_fields"]).length
        ? { required_json_fields: strings(row["required_json_fields"]) }
        : {}),
      ...(strings(row["required_csv_columns"]).length
        ? { required_csv_columns: strings(row["required_csv_columns"]) }
        : {}),
      ...(Number.isFinite(Number(row["minimum_row_count"]))
        ? { minimum_row_count: Number(row["minimum_row_count"]) }
        : {}),
      ...(row["expected_target"] ? { expected_target: String(row["expected_target"]) } : {}),
    }];
  });
  const base = {
    contract_id: String(rawContract?.["contract_id"] ?? `${input.taskId}-acceptance`).trim(),
    contract_revision: Number(rawContract?.["contract_revision"] ?? 1) || 1,
    task_id: input.taskId,
    ...(rawContract?.["wp_id"] ? { wp_id: String(rawContract["wp_id"]) } : {}),
    ...(rawContract?.["phase"] ? { phase: String(rawContract["phase"]) } : {}),
    source: "task" as const,
    status: findings.length > 0 ? "needs_pm" as const : "compiled" as const,
    items,
    findings,
  };
  return { ...base, contract_digest: sha(base) };
}

function safeProjectPath(projectRoot: string, value: string): string | null {
  if (!value.trim()) return null;
  const root = resolve(projectRoot);
  const path = resolve(isAbsolute(value) ? value : resolve(root, value));
  return path === root || path.toLowerCase().startsWith(`${root.toLowerCase()}\\`) ||
    path.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    ? path
    : null;
}

export async function evaluateAcceptanceContract(input: {
  projectRoot: string;
  contract: AcceptanceContract;
  evidence: EvidenceSummary;
  reportId: string;
  reportRevision?: number;
  sessionId?: string;
  runId?: string;
  producer?: string;
}): Promise<AcceptanceContractEvaluation> {
  const failed = new Set<string>();
  const needsPm = new Set<string>();
  const findings: string[] = [...input.contract.findings];
  const envelopes: EvidenceEnvelope[] = [];
  if (input.contract.status !== "compiled") {
    return {
      state: input.contract.status === "legacy" ? "needs_pm" : "needs_pm",
      contract: input.contract,
      evidence_digest: sha(input.evidence),
      failed_item_ids: [],
      needs_pm_item_ids: input.contract.items.map((item) => item.item_id),
      findings: findings.length ? findings : ["acceptance contract requires PM confirmation"],
      envelopes,
    };
  }

  const provenanceComplete = Boolean(
    input.sessionId &&
      input.runId &&
      canonicalTaskId(input.evidence.task_id) === canonicalTaskId(input.contract.task_id) &&
      input.evidence.report.found &&
      input.evidence.report_id === input.reportId &&
      input.evidence.session.found &&
      input.evidence.session.session_id === input.sessionId &&
      input.evidence.session.run_id === input.runId,
  );
  for (const item of input.contract.items) {
    if (!provenanceComplete) {
      failed.add(item.item_id);
      findings.push(`${item.item_id}: bound session/run evidence is unavailable`);
      continue;
    }
    for (const type of item.required_evidence_types) {
      let result: EvidenceEnvelope["validator_result"] = "pass";
      let source = item.source_path_or_command ?? "";
      let status: number | string | null = "verified";
      let digest = "";
      let startedAt = "";
      let endedAt = "";
      if (type === "command" || type === "git") {
        const commands = input.evidence.commands.filter((row) =>
          (!source || row.command.includes(source)) &&
          (type !== "git" || /(?:^|\s)git(?:\.exe)?(?:\s|$)/i.test(row.command)));
        if (commands.length === 0) result = "deterministic_fail";
        else if (commands.some((row) => row.exit_code != null && row.exit_code !== 0)) {
          result = "deterministic_fail";
        }
        const command = commands[0];
        source = command?.command ?? source;
        status = command?.exit_code ?? null;
        digest = sha(command ?? { missing: true });
        startedAt = command?.started_at ?? "";
        endedAt = command?.ended_at ?? "";
      } else if (["file", "json", "csv"].includes(type)) {
        const candidates = [...input.evidence.files.changed, ...input.evidence.files.read]
          .filter((path) => !source || path.replace(/\\/g, "/").endsWith(source.replace(/\\/g, "/")));
        const path = safeProjectPath(input.projectRoot, candidates[0] ?? source);
        source = path ?? source;
        if (!path) {
          result = "deterministic_fail";
        } else {
          try {
            await access(path);
            const content = await readFile(path);
            digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
            if (type === "json") {
              const parsed = JSON.parse(content.toString("utf8")) as unknown;
              const record = object(parsed);
              if (item.required_json_fields?.some((field) => !record || !(field in record))) {
                throw new Error("required JSON field missing");
              }
            }
            if (type === "csv") {
              const lines = content.toString("utf8").split(/\r?\n/).filter(Boolean);
              if (lines.length === 0 || !lines[0]!.includes(",")) throw new Error("invalid csv");
              const columns = lines[0]!.split(",").map((entry) => entry.trim());
              if (item.required_csv_columns?.some((column) => !columns.includes(column))) {
                throw new Error("required CSV column missing");
              }
              if (item.minimum_row_count != null && lines.length - 1 < item.minimum_row_count) {
                throw new Error("CSV row count below minimum");
              }
            }
            if (item.expected_content_digest && digest !== item.expected_content_digest) {
              result = "deterministic_fail";
            }
          } catch {
            result = "deterministic_fail";
          }
        }
      } else if (type === "browser") {
        const actions = input.evidence.browser_actions ?? [];
        if (actions.length === 0 ||
          (item.expected_target && !actions.some((row) => row.url?.includes(item.expected_target!)))) {
          result = "deterministic_fail";
        }
        source = actions[0]?.url ?? actions[0]?.action ?? source;
        digest = sha(actions);
      } else if (type === "data") {
        if (input.evidence.data_queries.length === 0 ||
          input.evidence.data_queries.some((row) => row.row_count == null) ||
          (item.minimum_row_count != null &&
            input.evidence.data_queries.every((row) => (row.row_count ?? -1) < item.minimum_row_count!))) {
          result = "deterministic_fail";
        }
        source = input.evidence.data_queries[0]?.query_summary ?? source;
        digest = sha(input.evidence.data_queries);
      } else {
        result = item.allows_manual_observation ? "needs_pm" : "deterministic_fail";
      }
      if (result === "deterministic_fail") {
        failed.add(item.item_id);
        findings.push(`${item.item_id}: ${type} evidence failed deterministic validation`);
      } else if (result === "needs_pm") {
        needsPm.add(item.item_id);
      }
      envelopes.push({
        evidence_id: `${input.reportId}:${item.item_id}:${type}`,
        task_id: input.contract.task_id,
        report_id: input.reportId,
        report_revision: input.reportRevision ?? 1,
        ...(input.sessionId ? { session_id: input.sessionId } : {}),
        ...(input.runId ? { run_id: input.runId } : {}),
        acceptance_item_id: item.item_id,
        evidence_type: type,
        producer: input.producer ?? "runtime",
        source_path_or_command: source,
        cwd_or_target: input.projectRoot,
        exit_code_or_result_status: status,
        content_digest_or_output_digest: digest,
        ...(startedAt ? { started_at: startedAt } : {}),
        ...(endedAt ? { ended_at: endedAt } : {}),
        provenance: {
          task_bound: canonicalTaskId(input.evidence.task_id) === canonicalTaskId(input.contract.task_id),
          report_bound: input.evidence.report.found && input.evidence.report_id === input.reportId,
          session_bound: !input.sessionId || input.evidence.session.session_id === input.sessionId,
          run_bound: !input.runId || input.evidence.session.run_id === input.runId,
        },
        validator_result: result,
      });
    }
  }
  return {
    state: failed.size > 0 ? "deterministic_fail" : needsPm.size > 0 ? "needs_pm" : "pass",
    contract: input.contract,
    evidence_digest: sha(envelopes),
    failed_item_ids: [...failed].sort(),
    needs_pm_item_ids: [...needsPm].sort(),
    findings,
    envelopes,
  };
}
