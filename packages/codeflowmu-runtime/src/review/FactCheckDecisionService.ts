import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { parseMarkdownFrontmatter, strField } from "../ledger/frontmatter.ts";
import { resolveLedgerLayout } from "../ledger/paths.ts";
import { TaskFrontmatterStore } from "../lifecycle/TaskFrontmatterStore.ts";
import { findTaskLocationById } from "../lifecycle/taskPathUtils.ts";
import type { TaskFm } from "../lifecycle/types.ts";

export type FactCheckDecisionAction =
  | "return_for_evidence"
  | "confirm_fact_false"
  | "overrule_auto_review"
  | "retry_fact_check";

export interface FactCheckDecisionRecord {
  event: `fact_check.${FactCheckDecisionAction}`;
  at: string;
  task_id: string;
  action: FactCheckDecisionAction;
  actor: "PM" | "ADMIN";
  reason: string;
  review_id: string;
  report_id: string;
  review_state: string;
  idempotency_key: string;
}

export interface FactCheckProjectionReconciliation {
  root_projection_updated: boolean;
  rework_tasks_cancelled: string[];
  blocking_issues_resolved: string[];
}

export class FactCheckDecisionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FactCheckDecisionError";
  }
}

async function latestReview(projectRoot: string, taskId: string, expectedReviewId?: string): Promise<Record<string, unknown> | null> {
  const dir = resolveLedgerLayout(projectRoot).reviewsDir;
  const names = (await readdir(dir).catch(() => [] as string[]))
    .filter((name) => name.startsWith("REVIEW-") && name.endsWith(".md"))
    .sort()
    .reverse();
  const canonical = (value: string): string =>
    (/^TASK-\d{8}-\d{3,}/i.exec(value.replace(/\.md$/i, "").trim())?.[0] ?? value)
      .toUpperCase();
  for (const name of names) {
    const fm = parseMarkdownFrontmatter(await readFile(join(dir, name), "utf8").catch(() => ""));
    if (expectedReviewId && strField(fm, "review_id") !== expectedReviewId) continue;
    if (canonical(strField(fm, "task_id")) !== canonical(taskId)) continue;
    return fm;
  }
  return null;
}

export class FactCheckDecisionService {
  constructor(private readonly projectRoot: string, private readonly now: () => Date = () => new Date()) {}

  async decide(input: {
    taskId: string;
    action: FactCheckDecisionAction;
    actor: "PM" | "ADMIN";
    reason: string;
    idempotencyKey: string;
    expectedReviewId?: string;
  }): Promise<{
    record: FactCheckDecisionRecord;
    idempotent: boolean;
    projection: FactCheckProjectionReconciliation;
  }> {
    if (!input.taskId || !input.idempotencyKey) {
      throw new FactCheckDecisionError("FACT_CHECK_DECISION_INVALID", "taskId and idempotencyKey are required");
    }
    const review = await latestReview(this.projectRoot, input.taskId, input.expectedReviewId);
    if (!review) throw new FactCheckDecisionError("FACT_CHECK_REVIEW_NOT_FOUND", input.taskId);
    const reviewState = strField(review, "review_state") ||
      (strField(review, "fact_check_verdict") === "fail" ? "deterministic_fail" : "needs_pm");
    if (input.action === "overrule_auto_review" && reviewState === "deterministic_fail") {
      throw new FactCheckDecisionError(
        "FACT_CHECK_DETERMINISTIC_FAILURE_NOT_OVERRULABLE",
        "PM cannot overrule missing evidence, non-zero commands, content contradictions, or digest/provenance mismatches",
      );
    }
    if (input.action === "overrule_auto_review" && !input.reason.trim()) {
      throw new FactCheckDecisionError("FACT_CHECK_REASON_REQUIRED", "overrule requires a durable reason");
    }
    const dir = join(this.projectRoot, ".codeflowmu", "fact-check-decisions");
    const path = join(dir, `${input.taskId.replace(/[^A-Za-z0-9._-]/g, "_")}.jsonl`);
    const priorRaw = await readFile(path, "utf8").catch(() => "");
    for (const line of priorRaw.split(/\r?\n/).filter(Boolean)) {
      try {
        const prior = JSON.parse(line) as FactCheckDecisionRecord;
        if (prior.idempotency_key === input.idempotencyKey) {
          return {
            record: prior,
            idempotent: true,
            projection: await this.reconcileProjection(prior),
          };
        }
      } catch { /* retain valid append-only records */ }
    }
    const record: FactCheckDecisionRecord = {
      event: `fact_check.${input.action}`,
      at: this.now().toISOString(),
      task_id: input.taskId,
      action: input.action,
      actor: input.actor,
      reason: input.reason.trim(),
      review_id: strField(review, "review_id"),
      report_id: strField(review, "report_id") || strField(review, "subject_id"),
      review_state: reviewState,
      idempotency_key: input.idempotencyKey,
    };
    await mkdir(dir, { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
    return {
      record,
      idempotent: false,
      projection: await this.reconcileProjection(record),
    };
  }

  private async reconcileProjection(
    record: FactCheckDecisionRecord,
  ): Promise<FactCheckProjectionReconciliation> {
    const result: FactCheckProjectionReconciliation = {
      root_projection_updated: false,
      rework_tasks_cancelled: [],
      blocking_issues_resolved: [],
    };
    if (record.action !== "overrule_auto_review") return result;
    const layout = resolveLedgerLayout(this.projectRoot);
    const store = new TaskFrontmatterStore();
    const rootTask = await findTaskLocationById(layout.lifecycleRoot, record.task_id, {
      hotTasksDir: layout.tasksDir,
    });
    if (rootTask) {
      const { fm, body } = await store.read(rootTask.path);
      const projection = fm as Record<string, unknown>;
      delete projection.pm_attention_reason;
      delete projection.pm_attention_report_id;
      delete projection.issue_blocking;
      delete projection.blocking_issue_id;
      delete projection.blocking_issue_reason;
      projection.fact_check_exception = true;
      projection.fact_check_exception_by = record.actor;
      projection.fact_check_exception_at = record.at;
      projection.fact_check_exception_reason = record.reason;
      projection.fact_check_decision_id = record.idempotency_key;
      projection.fact_check_exception_review_id = record.review_id;
      projection.fact_check_exception_report_id = record.report_id;
      await store.write(rootTask.path, fm, body);
      result.root_projection_updated = true;
    }

    const lifecycleDirs = ["inbox", "active", "review"].map((stage) =>
      join(layout.lifecycleRoot, stage));
    for (const dir of lifecycleDirs) {
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const name of names) {
        if (!/^TASK-.*\.md$/i.test(name)) continue;
        const path = join(dir, name);
        const { fm, body } = await store.read(path).catch(() => ({ fm: {} as TaskFm, body: "" }));
        if (
          strField(fm, "source_report") !== record.report_id ||
          !strField(fm, "rework_key")
        ) continue;
        const projection = fm as Record<string, unknown>;
        projection.display_status = "cancelled";
        projection.dispatch_state = "cancelled";
        projection.fact_check_correction_id = record.idempotency_key;
        projection.fact_check_correction_reason = record.reason;
        await store.write(path, fm, body);
        result.rework_tasks_cancelled.push(strField(fm, "task_id") || name.replace(/\.md$/i, ""));
      }
    }

    const issueNames = await readdir(layout.issuesDir).catch(() => [] as string[]);
    for (const name of issueNames) {
      if (!/^ISSUE-.*\.md$/i.test(name)) continue;
      const path = join(layout.issuesDir, name);
      const { fm, body } = await store.read(path).catch(() => ({ fm: {} as TaskFm, body: "" }));
      if (strField(fm, "report_id") !== record.report_id &&
        strField(fm, "source_report") !== record.report_id) continue;
      const projection = fm as Record<string, unknown>;
      projection.resolution_status = "resolved";
      projection.blocking = false;
      projection.resolved_by = record.actor;
      projection.resolved_at = record.at;
      projection.fact_check_correction_id = record.idempotency_key;
      await store.write(path, fm, body);
      result.blocking_issues_resolved.push(strField(fm, "issue_id") || name.replace(/\.md$/i, ""));
    }
    return result;
  }
}
