/**
 * Hard gate for PM-to-ADMIN final summary — all conditions must pass before write.
 */

import { isWorkerReportToPm } from "../fcop/governance.ts";
import {
  findAdminRootTask,
  isPmAdminFinalSummaryReport,
  isPmDownstreamChildTask,
  type LedgerReportKind,
} from "../ledger/reportParenting.ts";
import {
  isChildSettledForRoot,
  reportReferencesTask,
  taskParentMatchesRoot,
} from "../ledger/lifecycleProjection.ts";
import { isTaskReopenedForReworkFromLedger } from "../ledger/taskReworkSemantics.ts";
import type { LedgerReportRecord, LedgerTaskRecord, LedgerThreadRecord } from "../ledger/types.ts";
import { evaluateReportAttribution } from "./reportAttribution.ts";
import { classifyProductTask } from "./ProductDeliveryGovernance.ts";

export type PmSummaryGateOk = {
  ok: true;
  root_task_id: string;
  references: string[];
};

export type PmSummaryGateSkip = {
  ok: false;
  skipped_reason: string;
};

export type PmSummaryGateResult = PmSummaryGateOk | PmSummaryGateSkip;

function normalizeId(id: string): string {
  return id.replace(/\.md$/i, "").trim();
}

function timeMs(value: string | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function reportCanBelongToChild(
  report: LedgerReportRecord,
  child: LedgerTaskRecord,
): boolean {
  // Files without an explicit creation timestamp inherit filesystem mtime in
  // the ledger. Lifecycle frontmatter patches update that mtime and must not
  // make an already-landed worker report look older than its task.
  const childYaml = child.yaml ?? {};
  const childHasExplicitCreatedAt = Boolean(
    childYaml["created_at"] ?? childYaml["created_at_utc"],
  );
  if (child.path && !childHasExplicitCreatedAt) return true;
  const reportTime = timeMs(report.created_at_utc) ?? timeMs(report.created_at);
  const childTime = timeMs(child.created_at_utc) ?? timeMs(child.created_at);
  return reportTime === null || childTime === null || reportTime >= childTime;
}

function finalReportBelongsToCurrentRootReview(
  report: LedgerReportRecord,
  root: LedgerTaskRecord,
): boolean {
  if (!isTaskReopenedForReworkFromLedger(root)) return true;
  const reportTime = timeMs(report.created_at_utc) ?? timeMs(report.created_at);
  const rootReviewTime =
    timeMs(root.updated_at_utc) ??
    timeMs(root.updated_at) ??
    timeMs(String((root as { mtime?: unknown }).mtime ?? ""));
  if (reportTime === null || rootReviewTime === null) return false;
  return reportTime >= rootReviewTime;
}

function requiredChildRoleMinimums(
  rootBody?: string | null,
  rootFrontmatter?: Record<string, unknown>,
): Map<string, number> {
  const body = String(rootBody ?? "");
  const out = new Map<string, number>();
  const classification = classifyProductTask(body, rootFrontmatter);
  const productDelivery = classification.product_design_required;
  for (const role of ["DEV", "QA", "OPS"] as const) {
    if (new RegExp(`\\b${role}\\b`, "i").test(body)) {
      out.set(role, 1);
    }
  }
  const productDevIntent =
    /(develop|development|implement|build|create|deliver|browser|game|app|product)/i.test(
      body,
    ) ||
    /开发|实现|创建|构建|交付|浏览器|小游戏|游戏|产品/.test(body);
  const validationFlowIntent =
    /(verify|verification|validate|validation|test|acceptance|qa|quality|handoff|delivery flow)/i.test(
      body,
    ) ||
    /验证|验收|测试|核验|质量|交付流程|完整流程|完整交付/.test(body) ||
    /需求[\s\S]{0,40}开发[\s\S]{0,40}验证[\s\S]{0,40}交付/.test(body);
  if (productDevIntent) {
    out.set("DEV", Math.max(out.get("DEV") ?? 0, 1));
  }
  if (productDelivery) {
    out.set("DEV", Math.max(out.get("DEV") ?? 0, 1));
    if (classification.qa_required) {
      out.set("QA", Math.max(out.get("QA") ?? 0, 1));
    }
  }
  if (productDevIntent && validationFlowIntent) {
    out.set("QA", Math.max(out.get("QA") ?? 0, 1));
  }
  if (/\bv2\b/i.test(body) && /\bDEV\b/i.test(body)) {
    out.set("DEV", Math.max(out.get("DEV") ?? 0, 2));
  }
  if (productDelivery && !classification.qa_required) out.delete("QA");
  return out;
}

function pmDownstreamChildren(
  rootId: string,
  tasks: LedgerTaskRecord[],
  thread?: LedgerThreadRecord,
): LedgerTaskRecord[] {
  const rootNorm = normalizeId(rootId);
  const threadTaskIds = thread?.task_ids
    ? new Set(thread.task_ids.map(normalizeId))
    : null;

  const withParent = tasks.filter(
    (t) =>
      normalizeId(t.task_id) !== rootNorm &&
      isPmDownstreamChildTask(t) &&
      taskParentMatchesRoot(t.parent, rootId),
  );
  if (withParent.length) return withParent;

  return tasks.filter(
    (t) =>
      normalizeId(t.task_id) !== rootNorm &&
      isPmDownstreamChildTask(t) &&
      (!threadTaskIds || threadTaskIds.has(normalizeId(t.task_id))),
  );
}

function isPendingEntityResolved(
  pendingId: string,
  children: LedgerTaskRecord[],
  tasks: LedgerTaskRecord[],
  reports: LedgerReportRecord[],
  thread: LedgerThreadRecord,
): boolean {
  const norm = normalizeId(pendingId);
  const childIds = new Set(children.map((c) => normalizeId(c.task_id)));
  const taskById = new Map(tasks.map((t) => [normalizeId(t.task_id), t]));

  if (/^REPORT-/i.test(norm)) {
    const report = reports.find(
      (r) => normalizeId(r.report_id ?? r.filename) === norm,
    );
    if (!report) return false;
    const st = String(report.status ?? "").trim().toLowerCase();
    if (st && st !== "done" && st !== "completed") return false;
    const linked = children.find((c) => {
      const cid = normalizeId(c.task_id);
      const parent = report.parent_task_id ? normalizeId(report.parent_task_id) : "";
      if (parent && parent === cid) return true;
      const tid = normalizeId(report.task_id ?? "");
      if (tid && (tid === cid || tid.startsWith(`${cid}-`))) return true;
      const refs = report.references ?? [];
      return refs.some((ref) => normalizeId(ref) === cid);
    });
    if (linked) {
      return isChildSettledForRoot(linked, thread, reports);
    }
    return true;
  }

  if (childIds.has(norm)) {
    const child = taskById.get(norm);
    if (!child) return false;
    return isChildSettledForRoot(child, thread, reports);
  }

  const task = taskById.get(norm);
  if (task && isPmDownstreamChildTask(task)) {
    return isChildSettledForRoot(task, thread, reports);
  }

  return false;
}

function blockingPendingPmReview(
  pending: string[],
  children: LedgerTaskRecord[],
  tasks: LedgerTaskRecord[],
  reports: LedgerReportRecord[],
  thread: LedgerThreadRecord,
): string[] {
  return pending.filter(
    (id) => !isPendingEntityResolved(id, children, tasks, reports, thread),
  );
}

function effectiveWorkerReportsToPm(
  reports: LedgerReportRecord[],
  children: LedgerTaskRecord[],
): LedgerReportRecord[] {
  const childIds = new Set(children.map((c) => normalizeId(c.task_id)));
  return reports.filter((r) => {
    if (!isWorkerReportToPm(r.filename, r.sender, r.recipient)) {
      return false;
    }
    const st = String(r.status ?? "").trim().toLowerCase();
    if (st && st !== "done" && st !== "completed") return false;
    const parent = r.parent_task_id ? normalizeId(r.parent_task_id) : "";
    if (parent && childIds.has(parent)) {
      const child = children.find((c) => normalizeId(c.task_id) === parent);
      return !!child && reportCanBelongToChild(r, child);
    }
    const tid = normalizeId(r.task_id ?? "");
    if (tid && [...childIds].some((cid) => tid === cid || tid.startsWith(`${cid}-`))) {
      const child = children.find((c) => {
        const cid = normalizeId(c.task_id);
        return tid === cid || tid.startsWith(`${cid}-`);
      });
      return !!child && reportCanBelongToChild(r, child);
    }
    return children.some((c) => {
      const refs = r.references ?? [];
      return (
        refs.some((ref) => normalizeId(ref) === normalizeId(c.task_id)) &&
        reportCanBelongToChild(r, c)
      );
    });
  });
}

function collectReviewGateRefs(
  projectRoot: string,
  threadKey: string,
  taskIds: string[],
): string[] {
  void projectRoot;
  void threadKey;
  void taskIds;
  return [];
}

function qaReportStatusOk(status: string): boolean {
  const st = status.trim().toLowerCase();
  return st === "done" || st === "completed" || st === "pass";
}

function reportIsInvalid(report: LedgerReportRecord): boolean {
  const status = String(report.status ?? "").toLowerCase();
  return (
    report.valid === false ||
    status === "invalid" ||
    status === "rejected" ||
    Boolean(report.invalidated_by) ||
    Boolean(report.superseded_by)
  );
}

function latestReportsForRole(
  role: string,
  child: LedgerTaskRecord,
  reports: LedgerReportRecord[],
): LedgerReportRecord[] {
  const childTaskId = child.task_id;
  return reports
    .filter(
      (r) =>
        String(r.sender ?? "").toUpperCase() === role &&
        String(r.recipient ?? "").toUpperCase() === "PM" &&
        reportReferencesTask(r, childTaskId) &&
        reportCanBelongToChild(r, child),
    )
    .sort((a, b) =>
      (b.report_id ?? b.filename).localeCompare(a.report_id ?? a.filename),
    );
}

function evaluateQaSummaryGate(
  children: LedgerTaskRecord[],
  reports: LedgerReportRecord[],
  requireBrowserEvidence: boolean,
): PmSummaryGateSkip | null {
  const qaChildren = children.filter(
    (c) => String(c.recipient ?? "").toUpperCase() === "QA",
  );
  for (const qa of qaChildren) {
    const qaReports = latestReportsForRole("QA", qa, reports);
    if (!qaReports.length) {
      return { ok: false, skipped_reason: "qa_missing" };
    }
    const latest = qaReports[0]!;
    const st = String(latest.status ?? "").trim().toLowerCase();
    if (
      reportIsInvalid(latest) ||
      !qaReportStatusOk(st) ||
      latest.qa_verdict === "fail" ||
      latest.qa_verdict === "blocked"
    ) {
      return { ok: false, skipped_reason: "qa_not_passed" };
    }
    if (requireBrowserEvidence && latest.qa_browser_verified !== true) {
      return { ok: false, skipped_reason: "qa_browser_evidence_missing" };
    }
  }
  return null;
}

function evaluateDevAttributionGate(
  children: LedgerTaskRecord[],
  reports: LedgerReportRecord[],
): PmSummaryGateSkip | null {
  const devChildren = children.filter(
    (c) => String(c.recipient ?? "").toUpperCase() === "DEV",
  );
  for (const dev of devChildren) {
    const devReports = reports.filter(
      (r) =>
        String(r.sender ?? "").toUpperCase() === "DEV" &&
        isWorkerReportToPm(r.filename, r.sender, r.recipient) &&
        reportReferencesTask(r, dev.task_id),
    );
    if (!devReports.length) continue;
    const hasValid = devReports.some((r) => {
      const fm = {
        task_id: r.task_id,
        references: r.references,
      };
      const attribution = evaluateReportAttribution(r.filename ?? r.report_id, fm);
      return (
        attribution.pass &&
        normalizeId(attribution.fmTaskId) === normalizeId(dev.task_id) &&
        normalizeId(attribution.refTaskId) === normalizeId(dev.task_id)
      );
    });
    if (!hasValid) {
      return { ok: false, skipped_reason: "dev_report_attribution_fail" };
    }
  }
  return null;
}

/** Evaluate whether PM may write status=done PM-to-ADMIN final summary. */
export function evaluatePmSummaryGate(input: {
  thread: LedgerThreadRecord;
  tasks: LedgerTaskRecord[];
  reports: LedgerReportRecord[];
  root_task_id?: string | null;
  root_body?: string | null;
  /** Optional pre-scanned REVIEW-GATE ids (filename stems). */
  review_gate_refs?: string[];
  /** Lifecycle reconciliation validates an already-landed final report. */
  allow_existing_final?: boolean;
}): PmSummaryGateResult {
  const { thread, tasks, reports } = input;
  const root =
    findAdminRootTask(tasks, {
      threadKey: thread.thread_key,
      rootTaskId: input.root_task_id ?? thread.root_task_id,
    }) ??
    tasks.find((t) => t.sender === "ADMIN" && t.recipient === "PM");

  if (!root || root.sender !== "ADMIN" || root.recipient !== "PM") {
    return { ok: false, skipped_reason: "root_not_admin_to_pm" };
  }

  const rootId = root.task_id;
  const children = pmDownstreamChildren(rootId, tasks, thread);
  if (!children.length) {
    return { ok: false, skipped_reason: "no_pm_downstream_children" };
  }

  const requiredRoles = requiredChildRoleMinimums(input.root_body, root.yaml);
  const missingRoles: string[] = [];
  for (const [role, min] of requiredRoles) {
    const count = children.filter(
      (c) => String(c.recipient ?? "").toUpperCase() === role,
    ).length;
    if (count < min) missingRoles.push(`${role}:${count}/${min}`);
  }
  if (missingRoles.length) {
    return {
      ok: false,
      skipped_reason: `required_child_role_missing:${missingRoles.join(",")}`,
    };
  }

  const qaGate = evaluateQaSummaryGate(
    children,
    reports,
    classifyProductTask(input.root_body ?? "", root.yaml).product_design_required,
  );
  if (qaGate) return qaGate;

  const unsettled = children.filter(
    (c) => !isChildSettledForRoot(c, thread, reports),
  );
  if (unsettled.length) {
    return {
      ok: false,
      skipped_reason: `child_tasks_not_settled:${unsettled.map((c) => c.task_id).join(",")}`,
    };
  }

  const unresolvedPending = blockingPendingPmReview(
    thread.pending_pm_review,
    children,
    tasks,
    reports,
    thread,
  );
  if (unresolvedPending.length > 0) {
    return {
      ok: false,
      skipped_reason: `pending_pm_review_nonempty:${unresolvedPending.join(",")}`,
    };
  }

  const waitingAttention = children.filter(
    (c) => String(c.display_status ?? "").trim().toLowerCase() === "waiting_pm_attention",
  );
  if (waitingAttention.length) {
    return {
      ok: false,
      skipped_reason: `waiting_pm_attention:${waitingAttention.map((c) => c.task_id).join(",")}`,
    };
  }

  const rework = children.filter((c) => isTaskReopenedForReworkFromLedger(c));
  if (rework.length) {
    return {
      ok: false,
      skipped_reason: `unresolved_rework:${rework.map((c) => c.task_id).join(",")}`,
    };
  }

  const devAttrGate = evaluateDevAttributionGate(children, reports);
  if (devAttrGate) return devAttrGate;

  const workerReports = effectiveWorkerReportsToPm(reports, children);
  if (!workerReports.length) {
    return { ok: false, skipped_reason: "no_effective_worker_to_pm_report" };
  }

  // blocked / failed PM summaries are truthful terminal outcomes, but they
  // must not permanently occupy the successful-final slot. Once the
  // underlying gate is repaired or ADMIN resolves the blocker, PM may write
  // a later done summary and submit it normally.
  const existingFinal = reports.some((r) => {
    const status = String(r.status ?? "").trim().toLowerCase();
    const successful = status === "done" || status === "completed" || status === "pass";
    return (
      successful &&
      isPmAdminFinalSummaryReport(rootId, r) &&
      finalReportBelongsToCurrentRootReview(r, root)
    );
  });
  if (existingFinal && !input.allow_existing_final) {
    return { ok: false, skipped_reason: "pm_admin_final_already_exists" };
  }

  const references: string[] = [
    rootId,
    ...children.map((c) => c.task_id),
    ...workerReports.map((r) => r.report_id ?? r.filename),
    ...(input.review_gate_refs ?? []),
  ];
  const seen = new Set<string>();
  const deduped = references.filter((id) => {
    const k = normalizeId(id);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { ok: true, root_task_id: rootId, references: deduped };
}

export function reportKindIsFinalSummary(kind: LedgerReportKind | undefined): boolean {
  return kind === "pm_to_admin_final";
}
