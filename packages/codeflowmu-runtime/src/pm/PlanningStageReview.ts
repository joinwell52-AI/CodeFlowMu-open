import type { LedgerReportRecord, LedgerTaskRecord } from "../ledger/types.ts";
import type { PlanningReviewSnapshot } from "./LongHorizonPlanning.ts";
import type { PlanningGrant } from "./PlanningGrantStore.ts";

export type PlanningWpReviewStatus =
  | "completed"
  | "executing"
  | "authorized"
  | "available"
  | "condition_unmet"
  | "dependency_unmet"
  | "unauthorized";

export interface PlanningWpReviewRow {
  wp_id: string;
  title: string;
  dependencies: string[];
  status: PlanningWpReviewStatus;
  authorized: boolean;
  completed: boolean;
  selectable: boolean;
  recommended: boolean;
  condition: string | null;
  missing_conditions: string[];
  task_ids: string[];
  report_ids: string[];
  test_conclusion: string;
  risk: string;
  suggested_action: string;
}

export interface PlanningStageReview {
  review_mode: "planning" | "stage";
  pending_label: "待规划审批" | "待阶段审批" | null;
  stage_pending: boolean;
  work_packages: PlanningWpReviewRow[];
  active_grant_ids: string[];
  authorized_wp_scope: string[];
  completed_wp_scope: string[];
  selectable_wp_scope: string[];
  recommended_wp_scope: string[];
  prerequisite_evidence: string[];
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function wpIdFromTask(task: LedgerTaskRecord): string {
  const yaml = task.yaml ?? {};
  return [yaml["wp_id"], yaml["work_package"], yaml["phase"]]
    .map((value) => String(value ?? "").trim().toUpperCase())
    .find((value) => /^WP-\d+$/.test(value)) ?? "";
}

function taskCompleted(task: LedgerTaskRecord): boolean {
  return [task.bucket, task.state, task.lifecycle_projection, task.display_status]
    .some((value) => /^(?:done|archive|archived|completed|approved|accepted)$/i.test(String(value ?? "").trim()));
}

function reportAccepted(report: LedgerReportRecord): boolean {
  if (report.valid === false || report.qa_verdict === "fail" || report.qa_verdict === "blocked") return false;
  return /^(?:done|pass|passed|approved|accepted|completed)$/i.test(String(report.status ?? "").trim()) || report.qa_verdict === "pass";
}

export function evaluatePlanningStageReview(input: {
  snapshot: PlanningReviewSnapshot | null;
  tasks: LedgerTaskRecord[];
  reports: LedgerReportRecord[];
  grants: PlanningGrant[];
}): PlanningStageReview {
  const activeGrants = input.grants.filter((grant) => grant.status === "active");
  const authorized = new Set(activeGrants.flatMap((grant) => grant.approved_wp_scope));
  const tasksByWp = new Map<string, LedgerTaskRecord[]>();
  for (const task of input.tasks) {
    const wpId = wpIdFromTask(task);
    if (!wpId) continue;
    tasksByWp.set(wpId, [...(tasksByWp.get(wpId) ?? []), task]);
  }
  const acceptedReportsByWp = new Map<string, LedgerReportRecord[]>();
  for (const [wpId, tasks] of tasksByWp) {
    const taskIds = new Set(tasks.map((task) => task.task_id));
    acceptedReportsByWp.set(wpId, input.reports.filter((report) =>
      reportAccepted(report) && (
        taskIds.has(report.task_id) ||
        Boolean(report.parent_task_id && taskIds.has(report.parent_task_id)) ||
        Boolean(report.linked_task_ids?.some((id) => taskIds.has(id)))
      )
    ));
  }
  const completed = new Set<string>();
  for (const [wpId, tasks] of tasksByWp) {
    if (tasks.some(taskCompleted) && (acceptedReportsByWp.get(wpId)?.length ?? 0) > 0) completed.add(wpId);
  }
  const rows = (input.snapshot?.work_packages ?? []).map((wp): PlanningWpReviewRow => {
    const wpId = String(wp["id"] ?? "").trim().toUpperCase();
    const dependencies = stringList(wp["dependencies"]).map((value) => value.toUpperCase());
    const wpTasks = tasksByWp.get(wpId) ?? [];
    const reports = acceptedReportsByWp.get(wpId) ?? [];
    const isCompleted = completed.has(wpId);
    const isAuthorized = authorized.has(wpId);
    const isExecuting = isAuthorized && wpTasks.some((task) => /^(?:active|review)$/i.test(String(task.bucket ?? "")));
    const missingDependencies = dependencies.filter((dependency) => !completed.has(dependency));
    const condition = String(wp["trigger_condition"] ?? wp["condition"] ?? "").trim();
    const conditional = Boolean(condition) || wp["conditional"] === true;
    const conditionMet = !conditional || wp["condition_met"] === true || wp["trigger_satisfied"] === true;
    const selectable = !isCompleted && !isAuthorized && missingDependencies.length === 0 && conditionMet;
    const recommendation = String(wp["recommendation"] ?? "").trim().toLowerCase();
    const recommended = selectable && (wp["recommended_next"] === true || wp["pm_recommended"] === true || ["enter", "approve", "recommended", "进入", "建议进入"].includes(recommendation));
    let status: PlanningWpReviewStatus = "unauthorized";
    if (isCompleted) status = "completed";
    else if (isExecuting) status = "executing";
    else if (isAuthorized) status = "authorized";
    else if (missingDependencies.length) status = "dependency_unmet";
    else if (!conditionMet) status = "condition_unmet";
    else if (selectable) status = "available";
    return {
      wp_id: wpId,
      title: String(wp["title"] ?? wpId),
      dependencies,
      status,
      authorized: isAuthorized,
      completed: isCompleted,
      selectable,
      recommended,
      condition: condition || null,
      missing_conditions: [
        ...missingDependencies.map((dependency) => `依赖 ${dependency} 尚未完成并通过报告验收`),
        ...(!conditionMet ? [`条件尚未满足：${condition || "缺少条件证据"}`] : []),
      ],
      task_ids: wpTasks.map((task) => task.task_id),
      report_ids: reports.map((report) => report.report_id ?? report.filename),
      test_conclusion: reports.length ? "前置报告有效，验收状态通过" : "尚无有效通过报告",
      risk: stringList(wp["risks"] ?? wp["risk"]).join("；") || "未单列风险",
      suggested_action: recommended ? "PM 建议进入" : selectable ? "可由 ADMIN 选择" : "保持关闭",
    };
  }).filter((row) => Boolean(row.wp_id));
  const authorizedRows = rows.filter((row) => row.authorized);
  const stagePending = activeGrants.length > 0 && authorizedRows.length > 0 && authorizedRows.every((row) => row.completed) && rows.some((row) => row.selectable);
  const prerequisiteEvidence = [...new Set(rows.filter((row) => row.completed).flatMap((row) => row.report_ids))];
  return {
    review_mode: activeGrants.length ? "stage" : "planning",
    pending_label: activeGrants.length ? (stagePending ? "待阶段审批" : null) : "待规划审批",
    stage_pending: stagePending,
    work_packages: rows,
    active_grant_ids: activeGrants.map((grant) => grant.grant_id),
    authorized_wp_scope: [...authorized],
    completed_wp_scope: [...completed],
    selectable_wp_scope: rows.filter((row) => row.selectable).map((row) => row.wp_id),
    recommended_wp_scope: rows.filter((row) => row.recommended).map((row) => row.wp_id),
    prerequisite_evidence: prerequisiteEvidence,
  };
}
