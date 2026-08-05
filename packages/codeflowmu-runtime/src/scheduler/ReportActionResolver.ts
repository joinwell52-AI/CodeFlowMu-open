import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";

import {
  listField,
  parseMarkdownFrontmatter,
  resolveReportTaskId,
  resolveReportTaskIdFromContent,
  strField,
} from "../ledger/frontmatter.ts";
import { LedgerBuilder } from "../ledger/LedgerBuilder.ts";
import { resolveLedgerLayout } from "../ledger/paths.ts";
import type { PanelEventBridge } from "../panel/PanelEventBridge.ts";
import { findTaskLocationById } from "../lifecycle/taskPathUtils.ts";
import { TaskFrontmatterStore } from "../lifecycle/TaskFrontmatterStore.ts";
import { LifecycleKernel } from "../lifecycle/LifecycleKernel.ts";
import { bodyAfterFrontmatter } from "../ledger/leaderLedgerContextPack.ts";
import { resolveReviewEvidence } from "../review/ReviewEvidenceResolver.ts";
import { detectReportClaims, evaluateReviewFactGate } from "../review/ReviewFactGate.ts";
import {
  compileAcceptanceContract,
  evaluateAcceptanceContract,
} from "../review/AcceptanceContract.ts";
import {
  buildPmAttentionReason,
  writeFactCheckReview,
} from "../review/writeFactCheckReview.ts";
import type { FactCheckResult } from "../review/ReviewFactGate.ts";
import type { LifecycleGovernor } from "./LifecycleGovernor.ts";
import { tryApplyLateReportIntake } from "../pm/lateReportIntake.ts";
import { isWorkerReportToPm } from "../fcop/governance.ts";
import { buildReportIssueDoc } from "./reportIssueTemplate.ts";
import { evaluateQaReportAcceptance } from "../pm/qaAcceptanceFromReport.ts";
import { allocateTaskSequence } from "./TaskIdentityAllocator.ts";
import {
  DispatchAttemptStore,
  type TaskExecutionDecision,
} from "./DispatchAttemptStore.ts";
import {
  assertProjectExecutionContext,
  createProjectExecutionContext,
  type ProjectExecutionContext,
} from "../project/ProjectExecutionContext.ts";

export type ReportActionRequest =
  | "submit_task"
  | "request_rework"
  | "raise_issue"
  | "none";

export type ReportActionOutcome =
  | "submitted"
  | "reconciled"
  | "rework_created"
  | "issue_created"
  | "fact_check_needs_admin"
  | "waiting_pm_attention"
  | "noop"
  | "duplicate"
  | "invalid"
  | "late_intake";

export interface ReportActionResolverOpts {
  projectRoot: string;
  projectContext?: ProjectExecutionContext;
  lifecycleGovernor: LifecycleGovernor;
  logger?: {
    info?(msg: string): void;
    warn?(msg: string): void;
  };
  panelEvents?: PanelEventBridge;
  now?: () => Date;
}

const VALID_ACTIONS = new Set<ReportActionRequest>([
  "submit_task",
  "request_rework",
  "raise_issue",
  "none",
]);
const MAX_REWORKS_PER_PARENT = 3;

function normalizeId(id: string): string {
  return id.replace(/\.md$/i, "").trim();
}

function reportIdFromPath(path: string, fm: Record<string, unknown>): string {
  return normalizeId(strField(fm, "report_id") || basename(path, ".md"));
}

function inferAction(fm: Record<string, unknown>): ReportActionRequest {
  const explicit = strField(fm, "action_request").toLowerCase();
  if (VALID_ACTIONS.has(explicit as ReportActionRequest)) {
    return explicit as ReportActionRequest;
  }
  const status = strField(fm, "status").toLowerCase();
  if (status === "done" || status === "completed") return "submit_task";
  if (status === "blocked" || status === "aborted" || status === "failed") {
    return "raise_issue";
  }
  return "none";
}

function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9_.:/@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function renderFrontmatter(fm: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fm)) {
    if (value == null || value === "") continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlScalar(String(item))}`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${yamlScalar(String(value))}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

async function nextSequencedPath(
  dir: string,
  prefix: "TASK" | "ISSUE",
  dateKey: string,
  suffix: string,
  collisionDirs: string[] = [dir],
): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  if (prefix === "TASK") {
    const projectRoot = join(dir, "..", "..", "..");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const seq = allocateTaskSequence(projectRoot, dateKey);
      const path = join(dir, `${prefix}-${dateKey}-${seq}${suffix}.md`);
      try {
        const handle = await fs.open(path, "wx");
        await handle.close();
        return path;
      } catch (error) {
        if ((error as { code?: string }).code === "EEXIST") continue;
        throw error;
      }
    }
    throw new Error(`no ${prefix} identity available for ${dateKey}`);
  }
  for (let i = 1; i <= 999; i += 1) {
    const seq = String(i).padStart(3, "0");
    const filename = `${prefix}-${dateKey}-${seq}${suffix}.md`;
    const sequencePrefix = `${prefix}-${dateKey}-${seq}`;
    const occupied = await Promise.all(
      collisionDirs.map(async (candidateDir) => {
        try {
          const names = await fs.readdir(candidateDir);
          return names.some((name) => name.startsWith(sequencePrefix));
        } catch {
          return false;
        }
      }),
    );
    if (occupied.some(Boolean)) continue;
    const path = join(dir, filename);
    try {
      const handle = await fs.open(path, "wx");
      await handle.close();
      return path;
    } catch (err) {
      if ((err as { code?: string }).code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error(`no ${prefix} sequence available for ${dateKey}`);
}

async function writeExclusive(path: string, content: string): Promise<void> {
  await fs.writeFile(path, content, { encoding: "utf-8", flag: "w" });
}

function bodyPreview(markdown: string): string {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const line = body
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  return (line ?? "No report body provided").slice(0, 240);
}

export class ReportActionResolver {
  readonly #projectRoot: string;
  readonly #layout: ReturnType<typeof resolveLedgerLayout>;
  readonly #lifecycleGovernor: LifecycleGovernor;
  readonly #log: NonNullable<ReportActionResolverOpts["logger"]>;
  readonly #panelEvents: PanelEventBridge | undefined;
  readonly #now: () => Date;
  readonly #processed = new Set<string>();
  readonly #store = new TaskFrontmatterStore();
  readonly #projectContext: ProjectExecutionContext;
  readonly #decisionStore: DispatchAttemptStore;

  constructor(opts: ReportActionResolverOpts) {
    this.#projectRoot = opts.projectContext?.project_root ?? opts.projectRoot;
    this.#projectContext = opts.projectContext ?? createProjectExecutionContext({ projectRoot: opts.projectRoot });
    assertProjectExecutionContext(this.#projectContext, opts.projectRoot);
    this.#layout = resolveLedgerLayout(opts.projectRoot);
    this.#lifecycleGovernor = opts.lifecycleGovernor;
    this.#log = opts.logger ?? {};
    this.#panelEvents = opts.panelEvents;
    this.#now = opts.now ?? (() => new Date());
    this.#decisionStore = new DispatchAttemptStore({ projectRoot: this.#projectRoot, now: this.#now });
  }

  scheduleResolve(reportFilePath: string): void {
    void this.resolve(reportFilePath).catch((err) => {
      this.#log.warn?.(
        `[ReportActionResolver] failed for ${basename(reportFilePath)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  async resolve(reportFilePath: string): Promise<ReportActionOutcome> {
    assertProjectExecutionContext(this.#projectContext, this.#projectRoot);
    const raw = await fs.readFile(reportFilePath, "utf-8");
    const fm = parseMarkdownFrontmatter(raw);
    const reportId = reportIdFromPath(reportFilePath, fm);
    const action = inferAction(fm);
    const sourceProcessingKey = createHash("sha256")
      .update(reportId)
      .update("\n")
      .update(raw)
      .digest("hex");
    // submit_task must reach the fact/evidence gate on every observation:
    // external evidence can be revised without mutating the immutable REPORT.
    // The fact review and rework-key stores provide durable idempotency after
    // evidence resolution. Other explicit actions remain source-revision
    // idempotent here.
    if (action !== "submit_task") {
      if (this.#processed.has(sourceProcessingKey)) return "duplicate";
      if (await this.#hasProcessedArtifact(reportId)) {
        this.#processed.add(sourceProcessingKey);
        return "duplicate";
      }
    }
    if (action === "none") {
      this.#processed.add(sourceProcessingKey);
      return "noop";
    }

    const reportName = basename(reportFilePath);
    const reportSender = strField(fm, "sender");
    const reportRecipient = strField(fm, "recipient");
    let taskId = normalizeId(resolveReportTaskId(fm));
    if (!taskId && isWorkerReportToPm(reportName, reportSender, reportRecipient)) {
      taskId = await this.#resolveReportTaskIdFromLedger(reportId);
    }
    if (!taskId) {
      taskId = normalizeId(resolveReportTaskIdFromContent(fm, raw, reportName));
    }
    if (!taskId) {
      taskId = await this.#resolveReportTaskIdFromLedger(reportId);
    }
    if (!taskId) {
      return this.#writeIssueForInvalidReport(
        reportFilePath,
        reportId,
        "REPORT is missing task_id/references",
      );
    }

    const references = listField(fm, "references").map(normalizeId);
    const hasExplicitTaskLink = Boolean(
      strField(fm, "source_task_id") || strField(fm, "task_id"),
    );
    if (
      !hasExplicitTaskLink &&
      references.length > 0 &&
      !references.some((ref) => ref === taskId || taskId.startsWith(`${ref}-`))
    ) {
      return this.#writeIssueForInvalidReport(
        reportFilePath,
        reportId,
        `REPORT references do not include task_id ${taskId}`,
      );
    }

    const located = await findTaskLocationById(
      this.#layout.lifecycleRoot,
      taskId,
      { hotTasksDir: this.#layout.tasksDir },
    );
    if (!located) {
      return this.#writeIssueForInvalidReport(
        reportFilePath,
        reportId,
        `linked TASK not found: ${taskId}`,
      );
    }

    if (action === "submit_task") {
      const sender = strField(fm, "sender");
      const recipient = strField(fm, "recipient");
      if (isWorkerReportToPm(reportName, sender, recipient)) {
        const late = await tryApplyLateReportIntake({
          projectRoot: this.#projectRoot,
          reportId,
          reportFilePath,
          filename: basename(reportFilePath),
          taskId,
          reportFm: fm,
          sender,
          recipient,
          logger: this.#log,
          now: this.#now,
        });
        if (late) {
          return "late_intake";
        }
      }
      const outcome = await this.#submitWithFactCheck(
        reportFilePath,
        reportId,
        raw,
        fm,
        located,
        taskId,
      );
      return outcome;
    }
    if (action === "request_rework") {
      const outcome = await this.#createReworkTask(
        reportFilePath,
        reportId,
        raw,
        fm,
        located,
      );
      this.#processed.add(sourceProcessingKey);
      return outcome;
    }
    if (action === "raise_issue") {
      const outcome = await this.#writeIssue(
        reportFilePath,
        reportId,
        "REPORT requested issue escalation",
        taskId,
        strField(fm, "sender") || "runtime",
        undefined,
        raw,
        fm,
      );
      this.#processed.add(sourceProcessingKey);
      return outcome;
    }
    this.#processed.add(sourceProcessingKey);
    return "noop";
  }

  async #resolveReportTaskIdFromLedger(reportId: string): Promise<string> {
    await new LedgerBuilder({ projectRoot: this.#projectRoot }).rebuild();
    const target = normalizeId(reportId);
    let raw = "";
    try {
      raw = await fs.readFile(join(this.#layout.ledgerDir, "reports.jsonl"), "utf-8");
    } catch {
      return "";
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as {
          report_id?: string;
          filename?: string;
          task_id?: string;
          parent_task_id?: string;
        };
        const rid = normalizeId(String(row.report_id || row.filename || ""));
        if (rid !== target) continue;
        return normalizeId(String(row.task_id || row.parent_task_id || ""));
      } catch {
        /* skip malformed ledger row */
      }
    }
    return "";
  }

  async #submitWithFactCheck(
    reportFilePath: string,
    reportId: string,
    raw: string,
    fm: Record<string, unknown>,
    located: NonNullable<Awaited<ReturnType<typeof findTaskLocationById>>>,
    taskId: string,
  ): Promise<ReportActionOutcome> {
    const sessionId = strField(fm, "session_id");
    const runId = strField(fm, "run_id");
    const reporterRole = strField(fm, "sender") || strField(fm, "reporter");
    const evidence = resolveReviewEvidence({
      projectRoot: this.#projectRoot,
      task_id: taskId,
      report_id: reportId,
      session_id: sessionId || undefined,
      run_id: runId || undefined,
      evidence_refs: listField(fm, "evidence_refs"),
      agent_id: strField(fm, "agent_id") || undefined,
      role: reporterRole || undefined,
      thread_key: strField(fm, "thread_key") || undefined,
    });
    const reportBody = bodyAfterFrontmatter(raw);
    const taskRaw = await fs.readFile(located.path, "utf-8");
    const taskFm = parseMarkdownFrontmatter(taskRaw);
    const contract = compileAcceptanceContract({
      taskId,
      taskFrontmatter: taskFm,
      taskBody: bodyAfterFrontmatter(taskRaw),
    });
    const qaBusiness = evaluateQaReportAcceptance({
      status: strField(fm, "status") || undefined,
      body: reportBody,
      sender: reporterRole || undefined,
      recipient: strField(fm, "recipient") || undefined,
    });
    let contractEvaluation: Awaited<ReturnType<typeof evaluateAcceptanceContract>> | null = null;
    let factResult: FactCheckResult;
    if (qaBusiness?.verdict === "fail") {
      factResult = {
        verdict: "needs_admin",
        review_state: "needs_pm",
        reason_code: "qa_business_fail",
        unsupported_claims: [],
        required_changes: [qaBusiness.reason],
        claims: detectReportClaims(reportBody),
        acceptance_contract_digest: contract.contract_digest,
      };
    } else if (contract.source === "task") {
      contractEvaluation = await evaluateAcceptanceContract({
        projectRoot: this.#projectRoot,
        contract,
        evidence,
        reportId,
        reportRevision: Number(fm["report_revision"] ?? fm["revision"] ?? 1) || 1,
        sessionId: sessionId || undefined,
        runId: runId || undefined,
        producer: reporterRole || "runtime",
      });
      factResult = {
        verdict: contractEvaluation.state === "pass"
          ? "pass"
          : contractEvaluation.state === "deterministic_fail"
            ? "fail"
            : "needs_admin",
        review_state: contractEvaluation.state,
        reason_code: contractEvaluation.state === "deterministic_fail"
          ? "acceptance_contract_failed"
          : contractEvaluation.state === "needs_pm"
            ? "acceptance_contract_needs_pm"
            : "evidence_verified",
        unsupported_claims: contractEvaluation.findings,
        required_changes: contractEvaluation.state === "pass"
          ? []
          : contractEvaluation.findings,
        claims: detectReportClaims(reportBody),
        acceptance_contract_digest: contract.contract_digest,
        evidence_digest: contractEvaluation.evidence_digest,
        failed_item_ids: contractEvaluation.failed_item_ids,
      };
    } else {
      // Legacy compatibility only validates explicit factual claims made by
      // this REPORT. Deliberately omit reporter_role so the former universal
      // QA/browser checklist cannot invent acceptance items.
      factResult = evaluateReviewFactGate(evidence, reportBody, {
        session_id: sessionId || undefined,
        report_status: strField(fm, "status") || undefined,
      });
      factResult.acceptance_contract_digest = contract.contract_digest;
    }

    const reviewWrite = await writeFactCheckReview({
      projectRoot: this.#projectRoot,
      taskId,
      reportId,
      evidence,
      result: factResult,
      now: this.#now,
    });
    const duplicateReview = !reviewWrite.created;

    const reviewState = factResult.review_state ??
      (factResult.verdict === "pass" ? "pass" : factResult.verdict === "fail" ? "deterministic_fail" : "needs_pm");
    let executionDecision: TaskExecutionDecision;
    try {
      executionDecision = await this.#decisionStore.recordDecision({
        operation_id: `report-settlement:${reportId}`,
        task_id: taskId,
        input_digest: reviewWrite.review_input_digest,
        decision:
          reviewState === "pass"
            ? "ALLOW"
            : reviewState === "deterministic_fail"
              ? "REJECT"
              : "NEEDS_PM",
        reason: factResult.reason_code || reviewState,
        source: "ReportActionResolver",
      });
    } catch (error) {
      this.#panelEvents?.emit("codeflowmu.state_decision_conflict", {
        event: "STATE_DECISION_CONFLICT",
        priority: "high",
        task_id: taskId,
        report_id: reportId,
        operation_id: `report-settlement:${reportId}`,
        input_digest: reviewWrite.review_input_digest,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (reviewState === "deterministic_fail") {
      if (contract.source === "task" || reporterRole.toUpperCase() === "QA") {
        await this.#markQaReworkRequired(located, taskId, reportId, factResult);
        const outcome = await this.#createReworkTask(
          reportFilePath,
          reportId,
          raw,
          {
            ...fm,
            sender: "PM",
            recipient: reporterRole || "QA",
            rework_reason: buildPmAttentionReason(factResult),
            report_revision: Number(fm["report_revision"] ?? fm["revision"] ?? 1) || 1,
            acceptance_contract_digest: contract.contract_digest,
            evidence_digest: contractEvaluation?.evidence_digest ?? "",
            failed_item_ids: contractEvaluation?.failed_item_ids ?? [],
          },
          located,
        );
        return duplicateReview ? "duplicate" : outcome;
      }
      await this.#markWaitingPmAttention(located, taskId, reportId, factResult);
      return duplicateReview ? "duplicate" : "waiting_pm_attention";
    }

    if (reviewState === "needs_pm") {
      await this.#markWaitingPmAttention(located, taskId, reportId, factResult);
      this.#panelEvents?.emit("codeflowmu.review.fact_check_needs_admin", {
        event: "fact_check_needs_admin",
        report_id: reportId,
        task_id: taskId,
        reason_code: factResult.reason_code,
      });
      return duplicateReview ? "duplicate" : "waiting_pm_attention";
    }

    await this.#clearPmAttentionIfStale(located);
    const settled =
      await this.#lifecycleGovernor.resolveReportSettlement(reportFilePath, executionDecision);
    if (duplicateReview) return "duplicate";
    if (settled === "reconciled") return "reconciled";
    return "submitted";
  }

  async #markWaitingPmAttention(
    located: NonNullable<Awaited<ReturnType<typeof findTaskLocationById>>>,
    taskId: string,
    reportId: string,
    factResult: FactCheckResult,
  ): Promise<void> {
    const { fm, body } = await this.#store.read(located.path);
    fm.display_status = "waiting_pm_attention";
    fm.pm_attention_reason = buildPmAttentionReason(factResult);
    fm.pm_attention_report_id = reportId;
    await this.#store.write(located.path, fm, body);
    await new LedgerBuilder({ projectRoot: this.#projectRoot }).rebuild();
    this.#log.warn?.(
      `[ReportActionResolver] fact check ${factResult.verdict} for ${reportId}: ${factResult.reason_code} → waiting_pm_attention`,
    );
    this.#panelEvents?.emit("codeflowmu.pm.waiting_pm_attention", {
      event: "waiting_pm_attention",
      report_id: reportId,
      task_id: taskId,
      reason_code: factResult.reason_code,
      findings: [
        ...factResult.unsupported_claims,
        ...factResult.required_changes,
      ].filter(Boolean),
    });
  }

  async #markQaReworkRequired(
    located: NonNullable<Awaited<ReturnType<typeof findTaskLocationById>>>,
    taskId: string,
    reportId: string,
    factResult: FactCheckResult,
  ): Promise<void> {
    const { fm, body } = await this.#store.read(located.path);
    fm.display_status = "waiting_rework";
    fm.review_status = "rejected";
    fm.pm_attention_reason = buildPmAttentionReason(factResult);
    await this.#store.write(located.path, fm, body);
    await new LedgerBuilder({ projectRoot: this.#projectRoot }).rebuild();
    this.#panelEvents?.emit("codeflowmu.qa.rework_required", {
      event: "qa_rework_required",
      report_id: reportId,
      task_id: taskId,
      reason_code: factResult.reason_code,
    });
  }

  /** Remove stale fact-gate attention markers after a passing re-check. */
  async #clearPmAttentionIfStale(
    located: NonNullable<Awaited<ReturnType<typeof findTaskLocationById>>>,
  ): Promise<void> {
    const { fm, body } = await this.#store.read(located.path);
    if (String(fm.display_status ?? "").toLowerCase() !== "waiting_pm_attention") {
      return;
    }
    delete fm.display_status;
    delete fm.pm_attention_reason;
    delete fm.pm_attention_report_id;
    await this.#store.write(located.path, fm, body);
    await new LedgerBuilder({ projectRoot: this.#projectRoot }).rebuild();
    this.#log.info?.(
      `[ReportActionResolver] cleared stale waiting_pm_attention on ${basename(located.path, ".md")}`,
    );
  }

  async #createReworkTask(
    reportFilePath: string,
    reportId: string,
    reportRaw: string,
    reportFm: Record<string, unknown>,
    located: NonNullable<Awaited<ReturnType<typeof findTaskLocationById>>>,
  ): Promise<ReportActionOutcome> {
    const taskId = basename(located.path, ".md");
    const { fm: taskFm } = await this.#store.read(located.path);
    const parent = normalizeId(
      strField(reportFm, "parent") ||
        strField(taskFm, "parent") ||
        strField(taskFm, "parent_task") ||
      taskId,
    );
    const failedItemIds = listField(reportFm, "failed_item_ids").sort();
    const reworkKey = createHash("sha256").update(JSON.stringify({
      source_report_id: reportId,
      report_revision: Number(reportFm["report_revision"] ?? reportFm["revision"] ?? 1) || 1,
      acceptance_contract_digest: strField(reportFm, "acceptance_contract_digest"),
      evidence_digest: strField(reportFm, "evidence_digest"),
      failed_item_ids: failedItemIds,
    })).digest("hex");
    if (await this.#hasReworkKey(reworkKey)) return "duplicate";
    const existingCount = await this.#countReworksForParent(parent);
    const requestedIndex = Number(strField(reportFm, "rework_index"));
    const reworkIndex =
      Number.isFinite(requestedIndex) && requestedIndex > 0
        ? requestedIndex
        : existingCount + 1;

    if (existingCount >= MAX_REWORKS_PER_PARENT) {
      const { fm, body } = await this.#store.read(located.path);
      fm.display_status = "waiting_pm_attention";
      fm.pm_attention_reason = `rework limit reached for parent ${parent}; PM decision required`;
      fm.pm_attention_report_id = reportId;
      await this.#store.write(located.path, fm, body);
      await new LedgerBuilder({ projectRoot: this.#projectRoot }).rebuild();
      this.#panelEvents?.emit("codeflowmu.alert.rework_limit_reached", {
        event: "REWORK_LIMIT_REACHED",
        parent,
        task_id: taskId,
        report_id: reportId,
        max_reworks: MAX_REWORKS_PER_PARENT,
      });
      return "waiting_pm_attention";
    }

    const dateKey = this.#dateKey();
    const recipient = strField(taskFm, "recipient") || strField(reportFm, "sender") || "PM";
    const sender = strField(reportFm, "sender") || "PM";
    const path = await nextSequencedPath(
      join(this.#layout.lifecycleRoot, "inbox"),
      "TASK",
      dateKey,
      `-${sender}-to-${recipient}-rework-${reworkIndex}`,
      ["inbox", "active", "review", "done", "archive"].map((stage) =>
        join(this.#layout.lifecycleRoot, stage),
      ),
    );
    const filename = basename(path);
    const fileStem = basename(path, ".md");
    const newTaskId = fileStem;
    const reason =
      strField(reportFm, "rework_reason") ||
      strField(reportFm, "rework_reason_detail") ||
      bodyPreview(reportRaw);
    const taskDoc = [
      renderFrontmatter({
        protocol: "fcop",
        version: 1,
        kind: "task",
        task_id: newTaskId,
        sender,
        recipient,
        parent,
        rework_of: taskId,
        rework_index: reworkIndex,
        rework_reason: reason,
        source_report: reportId,
        source_report_revision: Number(reportFm["report_revision"] ?? reportFm["revision"] ?? 1) || 1,
        rework_key: reworkKey,
        acceptance_contract_digest: strField(reportFm, "acceptance_contract_digest"),
        evidence_digest: strField(reportFm, "evidence_digest"),
        failed_item_ids: failedItemIds,
        references: [taskId, reportId],
        thread_key: strField(taskFm, "thread_key") || strField(reportFm, "thread_key"),
        priority: strField(taskFm, "priority") || "P1",
        state: "inbox",
      }),
      "",
      "## QA 返工任务",
      "",
      `Source report: ${reportId}`,
      `Original task: ${taskId}`,
      `Parent task: ${parent}`,
      "",
      "## 返工原因",
      "",
      reason,
      "",
    ].join("\n");
    await writeExclusive(path, taskDoc);
    await new LifecycleKernel({
      lifecycleRoot: this.#layout.lifecycleRoot,
    }).runtimeSupersedeForRework({
      taskId,
      supersededBy: newTaskId,
      reason,
    });
    await new LedgerBuilder({ projectRoot: this.#projectRoot }).rebuild();
    this.#log.info?.(
      `[ReportActionResolver] created rework task ${filename} from ${reportId}`,
    );
    this.#panelEvents?.emit("codeflowmu.lifecycle.rework_task_created", {
      event: "rework_task_created",
      task_id: newTaskId,
      parent,
      rework_of: taskId,
      rework_index: reworkIndex,
      report_id: reportId,
    });
    return "rework_created";
  }

  async #writeIssueForInvalidReport(
    reportFilePath: string,
    reportId: string,
    reason: string,
  ): Promise<ReportActionOutcome> {
    if (await this.#hasProcessedArtifact(reportId)) return "duplicate";
    let reportRaw = "";
    try {
      reportRaw = await fs.readFile(reportFilePath, "utf-8");
    } catch {
      reportRaw = "";
    }
    const reportFm = parseMarkdownFrontmatter(reportRaw);
    return this.#writeIssue(
      reportFilePath,
      reportId,
      reason,
      "",
      "runtime",
      undefined,
      reportRaw,
      reportFm,
    );
  }

  async #writeIssue(
    reportFilePath: string,
    reportId: string,
    reason: string,
    taskId: string,
    sender: string,
    alertCode?: string,
    reportRaw?: string,
    reportFm?: Record<string, unknown>,
  ): Promise<ReportActionOutcome> {
    const dateKey = this.#dateKey();
    const path = await nextSequencedPath(
      this.#layout.issuesDir,
      "ISSUE",
      dateKey,
      "-REPORT-action",
    );
    const issueId = basename(path, ".md");
    const { frontmatter, bodyMarkdown } = buildReportIssueDoc({
      issueId,
      reportId,
      reportFilePath,
      reportRaw: reportRaw ?? "",
      reportFm: reportFm ?? {},
      taskId,
      sender,
      alertCode,
      runtimeReason: reason,
      createdAt: this.#now(),
    });
    const body = `${renderFrontmatter(frontmatter)}\n\n${bodyMarkdown}`;
    await writeExclusive(path, body);
    if (taskId) {
      const located = await findTaskLocationById(
        this.#layout.lifecycleRoot,
        taskId,
        { hotTasksDir: this.#layout.tasksDir },
      );
      if (located) {
        const { fm: taskFm, body: taskBody } = await this.#store.read(located.path);
        taskFm.display_status = "blocked";
        taskFm.dispatch_state = "blocked";
        taskFm.issue_blocking = true;
        taskFm.blocking_issue_id = issueId;
        taskFm.blocking_issue_reason = reason;
        await this.#store.write(located.path, taskFm, taskBody);
      }
    }
    await new LedgerBuilder({ projectRoot: this.#projectRoot }).rebuild();
    this.#log.warn?.(
      `[ReportActionResolver] wrote issue ${basename(path)} for ${reportId}: ${reason}`,
    );
    this.#panelEvents?.emit("codeflowmu.issue.created", {
      event: "issue_created",
      issue_id: issueId,
      report_id: reportId,
      task_id: taskId,
      reason,
      owner: "PM",
      handling_role: "PM",
      blocking: Boolean(taskId),
      blocking_level: taskId ? "blocking" : "warning",
      ...(alertCode ? { alert_code: alertCode } : {}),
    });
    return "issue_created";
  }

  async #countReworksForParent(parent: string): Promise<number> {
    const dirs = [
      join(this.#layout.lifecycleRoot, "inbox"),
      join(this.#layout.lifecycleRoot, "active"),
      join(this.#layout.lifecycleRoot, "review"),
      join(this.#layout.lifecycleRoot, "done"),
      join(this.#layout.lifecycleRoot, "archive"),
      this.#layout.tasksDir,
    ];
    let count = 0;
    for (const dir of dirs) {
      let names: string[] = [];
      try {
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!/^TASK-/i.test(name) || !name.endsWith(".md")) continue;
        const raw = await fs.readFile(join(dir, name), "utf-8").catch(() => "");
        const fm = parseMarkdownFrontmatter(raw);
        if (normalizeId(strField(fm, "parent")) !== parent) continue;
        if (strField(fm, "rework_of")) count += 1;
      }
    }
    return count;
  }

  async #hasReworkKey(reworkKey: string): Promise<boolean> {
    const dirs = [
      join(this.#layout.lifecycleRoot, "inbox"),
      join(this.#layout.lifecycleRoot, "active"),
      join(this.#layout.lifecycleRoot, "review"),
      join(this.#layout.lifecycleRoot, "done"),
      join(this.#layout.lifecycleRoot, "archive"),
      this.#layout.tasksDir,
    ];
    for (const dir of dirs) {
      const names = await fs.readdir(dir).catch(() => [] as string[]);
      for (const name of names) {
        if (!/^TASK-/i.test(name) || !name.endsWith(".md")) continue;
        const raw = await fs.readFile(join(dir, name), "utf-8").catch(() => "");
        if (strField(parseMarkdownFrontmatter(raw), "rework_key") === reworkKey) return true;
      }
    }
    return false;
  }

  async #hasProcessedArtifact(reportId: string): Promise<boolean> {
    const dirs = [
      this.#layout.issuesDir,
      join(this.#layout.lifecycleRoot, "inbox"),
      join(this.#layout.lifecycleRoot, "active"),
      join(this.#layout.lifecycleRoot, "review"),
      join(this.#layout.lifecycleRoot, "done"),
      join(this.#layout.lifecycleRoot, "archive"),
      this.#layout.tasksDir,
    ];
    for (const dir of dirs) {
      let names: string[] = [];
      try {
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!/^(TASK|ISSUE)-/i.test(name) || !name.endsWith(".md")) continue;
        const raw = await fs.readFile(join(dir, name), "utf-8").catch(() => "");
        const fm = parseMarkdownFrontmatter(raw);
        if (normalizeId(strField(fm, "source_report")) === reportId) {
          return true;
        }
      }
    }
    return false;
  }

  #dateKey(): string {
    const d = this.#now();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}${m}${day}`;
  }
}
