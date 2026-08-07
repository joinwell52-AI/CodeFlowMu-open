/** Runtime adapters for the shared product-delivery governance policy. */

import type { ParsedTask } from "../scheduler/TaskParser.ts";
import { resolveRoleFromAgentId } from "../registry/ToolAuthorityGuard.ts";
import { classifyProductTask, evaluateProductDeliveryGate, type ProductDeliveryGateStatus } from "./ProductDeliveryGovernance.ts";
import { resolveThreadContext } from "./PmGovernanceActions.ts";
import { currentPlanningGrants, planningGrantsAllow } from "./PlanningGrantStore.ts";

export type ProductDispatchGateResult =
  | { allowed: true; status?: ProductDeliveryGateStatus }
  | {
      allowed: false;
      code: "ROOT_TASK_CLOSED";
      reason: "cancelled";
      required_action: "none";
      findings: string[];
    }
  | {
      allowed: false;
      code: "PRODUCT_BRIEF_REQUIRED" | "PLANNING_GRANT_REQUIRED";
      reason: "product_brief_required" | "planning_grant_required";
      required_action: string;
      findings: string[];
      status?: ProductDeliveryGateStatus;
    };

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((v) => v.trim()).filter(Boolean);
  if (typeof value === "string") {
    const taskRefs = value.match(/TASK-\d{8}-\d{3,}(?:-[A-Za-z0-9]+)*/gi);
    if (taskRefs?.length) return [...new Set(taskRefs)];
    return value.split(/[,\n]/).map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

function taskPrefix(value: unknown): string {
  return String(value ?? "").trim().match(/^(TASK-\d{8}-\d{3,})/i)?.[1] ?? "";
}

function declaredWpId(frontmatter: Record<string, unknown>, body: string): string {
  const direct = [frontmatter["wp_id"], frontmatter["work_package"], frontmatter["phase"]]
    .map((value) => String(value ?? "").trim().toUpperCase())
    .find((value) => /^WP-\d+$/i.test(value));
  return direct ?? body.match(/\bWP-\d+\b/i)?.[0]?.toUpperCase() ?? "";
}

/** Pin a new PM worker task to the TASK owned by the current PM session. */
export function pinPmWorkerTaskLineage(
  args: Record<string, unknown>,
  pinnedTaskId: string | null | undefined,
): Record<string, unknown> {
  const pinned = taskPrefix(pinnedTaskId);
  const sender = String(args["sender"] ?? "PM").trim().toUpperCase();
  const recipient = String(args["recipient"] ?? "").trim().toUpperCase();
  if (!pinned || sender !== "PM" || !["DEV", "QA", "OPS"].includes(recipient)) {
    return args;
  }
  const related = list(args["references"]).filter(
    (ref) => taskPrefix(ref) !== pinned,
  );
  return { ...args, references: [pinned, ...related] };
}

function firstTaskReference(args: Record<string, unknown>): string | undefined {
  const direct = [args["parent"], args["parent_task_id"], args["root_task_id"]]
    .find((value) => typeof value === "string" && /^TASK-/i.test(value.trim()));
  const raw =
    typeof direct === "string"
      ? direct.trim()
      : list(args["references"]).find((value) => /^TASK-/i.test(value));
  if (!raw) return undefined;
  return raw.match(/^(TASK-\d{8}-\d{3,})/i)?.[1] ?? raw;
}

async function evaluateRootGate(
  projectRoot: string,
  lookup: { task_id?: string; thread_key?: string },
  fallbackBody: string,
  childFrontmatter: Record<string, unknown> = {},
): Promise<ProductDispatchGateResult> {
  const ctx = await resolveThreadContext(projectRoot, lookup);
  if (!ctx || !ctx.root_task_id) {
    if (!classifyProductTask(fallbackBody).product_design_required) {
      return { allowed: true };
    }
    return {
      allowed: false,
      code: "PRODUCT_BRIEF_REQUIRED",
      reason: "product_brief_required",
      required_action: "resolve_root_task_before_planning_validation",
      findings: ["product_root_context_missing"],
    };
  }
  const root = ctx.tasks.find((task) => task.task_id === ctx.root_task_id);
  if (root) {
    const row = root as unknown as Record<string, unknown>;
    const yaml =
      row["yaml"] && typeof row["yaml"] === "object"
        ? (row["yaml"] as Record<string, unknown>)
        : {};
    const bucket = String(
      row["physical_scope"] ?? row["bucket"] ?? row["lifecycle_projection"] ?? "",
    ).toLowerCase();
    const display = String(row["display_status"] ?? row["state"] ?? "").toLowerCase();
    const forceClosed =
      String(yaml["archive_mode"] ?? "").toLowerCase() === "force" ||
      String(yaml["task_type"] ?? "").toLowerCase() === "force_archive";
    if (
      bucket === "archive" ||
      forceClosed ||
      ["cancelled", "canceled", "force_archived", "archived"].includes(display)
    ) {
      return {
        allowed: false,
        code: "ROOT_TASK_CLOSED",
        reason: "cancelled",
        required_action: "none",
        findings: ["root_task_closed"],
      };
    }
  }
  const productStatus = await evaluateProductDeliveryGate({
    projectRoot,
    taskId: ctx.root_task_id,
    taskBody: ctx.root_body ?? "",
    taskFrontmatter: root?.yaml,
  });
  const planningGrants = await currentPlanningGrants(projectRoot, ctx.root_task_id, {
    briefRevision: productStatus.planning_artifact_revision ?? undefined,
    briefDigest: productStatus.body_digest ?? undefined,
    validationDigest: productStatus.validation_digest ?? undefined,
  });
  const planningGrant = [...planningGrants].reverse().find((grant) => grant.status === "active") ?? null;
  if (planningGrant) {
    let wpId = declaredWpId(childFrontmatter, fallbackBody);
    if (!wpId) {
      const reworkOf = String(childFrontmatter["rework_of"] ?? "").trim();
      const parent = reworkOf
        ? ctx.tasks.find((task) => task.task_id === reworkOf)
        : undefined;
      if (parent) wpId = declaredWpId(parent.yaml ?? {}, "");
    }
    if (!wpId || !planningGrantsAllow(planningGrants, wpId)) {
      return {
        allowed: false,
        code: "PLANNING_GRANT_REQUIRED",
        reason: "planning_grant_required",
        required_action: !wpId
          ? "declare_wp_id_and_child_acceptance_contract"
          : `obtain_admin_planning_grant_for_${wpId.toLowerCase()}`,
        findings: [
          !wpId ? "child_wp_id_missing" : `planning_grant_scope_missing:${wpId}`,
          `planning_grant_id:${planningGrant.grant_id}`,
        ],
      };
    }
    return { allowed: true };
  }
  if (productStatus.classification.long_horizon_required) {
    return {
      allowed: false,
      code: "PLANNING_GRANT_REQUIRED",
      reason: "planning_grant_required",
      required_action: "obtain_current_admin_planning_grant",
      findings: ["no_active_current_revision_planning_grant"],
      status: productStatus,
    };
  }
  return productStatus.allowed
    ? { allowed: true, status: productStatus }
    : {
        allowed: false,
        code: "PRODUCT_BRIEF_REQUIRED",
        reason: "product_brief_required",
        required_action: productStatus.next_action ?? "complete_pm_planning_before_dispatch",
        findings: productStatus.findings,
        status: productStatus,
      };
}

/** Guard PM write_task before the MCP/fallback write happens. */
export async function guardPmProductWorkerWriteTask(input: {
  projectRoot: string;
  agentId: string;
  args: Record<string, unknown>;
}): Promise<ProductDispatchGateResult> {
  if (resolveRoleFromAgentId(input.agentId) !== "PM") return { allowed: true };
  const sender = String(input.args["sender"] ?? "PM").trim().toUpperCase();
  const recipient = String(input.args["recipient"] ?? "").trim().toUpperCase();
  if (sender !== "PM" || !["DEV", "QA", "OPS"].includes(recipient)) {
    return { allowed: true };
  }
  const taskId = firstTaskReference(input.args);
  const threadKey = String(input.args["thread_key"] ?? "").trim() || undefined;
  return evaluateRootGate(input.projectRoot, {
    ...(taskId ? { task_id: taskId } : {}),
    ...(threadKey ? { thread_key: threadKey } : {}),
  }, String(input.args["body"] ?? ""), input.args);
}

/** Fail-safe dispatch guard for TASK files already landed through another path. */
export async function guardLandedPmProductWorkerTask(
  projectRoot: string,
  parsed: ParsedTask,
): Promise<ProductDispatchGateResult> {
  const sender = String(parsed.sender ?? parsed.frontmatter["sender"] ?? "")
    .trim()
    .toUpperCase();
  const recipient = String(parsed.recipient ?? parsed.frontmatter["recipient"] ?? "")
    .trim()
    .toUpperCase();
  if (sender !== "PM" || !["DEV", "QA", "OPS"].includes(recipient)) {
    return { allowed: true };
  }
  const taskId = firstTaskReference(parsed.frontmatter);
  const rawThreadKey = parsed.thread_key?.trim() || undefined;
  const threadKey = rawThreadKey && !/^_orphan_/i.test(rawThreadKey)
    ? rawThreadKey
    : undefined;
  return evaluateRootGate(projectRoot, {
    ...(taskId ? { task_id: taskId } : {}),
    ...(threadKey ? { thread_key: threadKey } : {}),
  }, parsed.body, parsed.frontmatter);
}
