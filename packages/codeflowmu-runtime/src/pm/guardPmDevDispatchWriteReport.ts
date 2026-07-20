/**
 * Gate PM write_report to ADMIN on dev cold dispatch before routeGoogleToolCall.
 */

import type { AgentRunMode } from "../registry/AgentSdkAdapter.ts";
import { basename } from "node:path";
import { isPmFinalSummaryTerminalStatus } from "../ledger/reportParenting.ts";
import type {
  LedgerReportRecord,
  LedgerTaskRecord,
  LedgerThreadRecord,
} from "../ledger/types.ts";
import { evaluatePmSummaryGate } from "./PmSummaryGate.ts";
import { resolveThreadContext } from "./PmGovernanceActions.ts";
import { evaluateProductDeliveryGate } from "./ProductDeliveryGovernance.ts";

export type GuardPmDevDispatchWriteReportResult =
  | { allowed: true }
  | {
      allowed: false;
      code: string;
      message: string;
      skipped_reason?: string;
      findings?: string[];
    };

export function evaluatePmDevDispatchTerminalWriteReportGate(input: {
  reporter: string;
  recipient: string;
  status: string;
  thread: LedgerThreadRecord;
  tasks: LedgerTaskRecord[];
  reports: LedgerReportRecord[];
  root_task_id?: string | null;
  root_body?: string | null;
}): GuardPmDevDispatchWriteReportResult {
  const reporter = String(input.reporter ?? "").trim().toUpperCase();
  const recipient = String(input.recipient ?? "").trim().toUpperCase();
  if (reporter !== "PM" || recipient !== "ADMIN") {
    return { allowed: true };
  }
  if (!isPmFinalSummaryTerminalStatus(input.status)) {
    return { allowed: true };
  }

  const gate = evaluatePmSummaryGate({
    thread: input.thread,
    tasks: input.tasks,
    reports: input.reports,
    root_task_id: input.root_task_id ?? input.thread.root_task_id,
    root_body: input.root_body,
  });
  if (gate.ok) {
    return { allowed: true };
  }

  if (gate.skipped_reason === "pm_admin_final_already_exists") {
    return {
      allowed: false,
      code: "PM_ADMIN_FINAL_ALREADY_EXISTS",
      message:
        "PM-to-ADMIN final report already exists for this main task. Read the existing REPORT and stop; do not create a duplicate.",
      skipped_reason: gate.skipped_reason,
    };
  }

  return {
    allowed: false,
    code: "CLOSE_GATE_FAILED",
    message: `PM-to-ADMIN terminal write_report blocked: ${gate.skipped_reason}`,
    skipped_reason: "close_gate_failed",
    findings: [gate.skipped_reason],
  };
}

function readReporterRecipientStatus(args: Record<string, unknown>): {
  reporter: string;
  recipient: string;
  status: string;
} {
  const reporter = String(
    args.reporter ?? args.sender ?? "",
  ).trim();
  const recipient = String(args.recipient ?? "").trim();
  const status = String(args.status ?? "").trim();
  return { reporter, recipient, status };
}

export async function guardPmDevDispatchWriteReport(
  projectRoot: string,
  args: Record<string, unknown>,
  options?: {
    agentId?: string;
    promptText?: string;
    runMode?: AgentRunMode;
  },
): Promise<GuardPmDevDispatchWriteReportResult> {
  void options;

  const { reporter, recipient, status } = readReporterRecipientStatus(args);
  if (
    reporter.toUpperCase() !== "PM" ||
    recipient.toUpperCase() !== "ADMIN"
  ) {
    return { allowed: true };
  }
  if (!isPmFinalSummaryTerminalStatus(status)) {
    return { allowed: true };
  }

  const taskId = String(args.task_id ?? args.taskId ?? "").trim();
  const threadKey = String(args.thread_key ?? "").trim();
  if (!taskId && !threadKey) {
    return {
      allowed: false,
      code: "PM_DEV_DISPATCH_SUMMARY_GATE",
      message:
        "PM-to-ADMIN terminal write_report requires task_id or thread_key for summary gate.",
    };
  }

  const ctx = await resolveThreadContext(projectRoot, {
    task_id: taskId || undefined,
    thread_key: threadKey || undefined,
  });
  if (!ctx) {
    return {
      allowed: false,
      code: "PM_DEV_DISPATCH_SUMMARY_GATE",
      message:
        "PM-to-ADMIN terminal write_report blocked: ledger thread context not found.",
    };
  }

  const root = ctx.tasks.find((task) => task.task_id === ctx.root_task_id);
  const productGate = await evaluateProductDeliveryGate({
    projectRoot,
    taskId: ctx.root_task_id ?? taskId,
    taskBody: ctx.root_body ?? "",
    taskFrontmatter: root?.yaml,
  });
  if (!productGate.allowed) {
    return {
      allowed: false,
      code: "CLOSE_GATE_FAILED",
      message: `PM-to-ADMIN terminal write_report blocked: ${productGate.findings.join(",")}`,
      skipped_reason: "close_gate_failed",
      findings: productGate.findings,
    };
  }

  if (productGate.classification.product_design_required) {
    const summary = evaluatePmSummaryGate({
      thread: ctx.thread,
      tasks: ctx.tasks,
      reports: ctx.reports,
      root_task_id: ctx.root_task_id,
      root_body: ctx.root_body,
    });
    if (summary.ok) {
      const rawRefs = Array.isArray(args.references)
        ? args.references.map(String)
        : typeof args.references === "string"
          ? args.references.split(/[,\n]/)
          : [];
      const normalized = new Set(
        rawRefs.map((value) => value.trim().replace(/\.md$/i, "").toUpperCase()),
      );
      const bodyEvidence = String(args.body ?? "").toUpperCase();
      const requiredRefs = [
        ...summary.references,
        basename(productGate.product_brief_path),
        ...productGate.related_issues,
      ];
      const missing = requiredRefs.filter(
        (value) => {
          const normalizedValue = value.trim().replace(/\.md$/i, "").toUpperCase();
          return !normalized.has(normalizedValue) && !bodyEvidence.includes(normalizedValue);
        },
      );
      if (missing.length) {
        return {
          allowed: false,
          code: "CLOSE_GATE_FAILED",
          message: `PM-to-ADMIN terminal write_report blocked: final report references missing ${missing.join(",")}`,
          skipped_reason: "close_gate_failed",
          findings: [`final_report_references_missing:${missing.join(",")}`],
        };
      }
    }
  }

  return evaluatePmDevDispatchTerminalWriteReportGate({
    reporter,
    recipient,
    status,
    thread: ctx.thread,
    tasks: ctx.tasks,
    reports: ctx.reports,
    root_task_id: ctx.root_task_id,
    root_body: ctx.root_body,
  });
}
