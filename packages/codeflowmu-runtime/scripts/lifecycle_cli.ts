#!/usr/bin/env npx tsx
/**
 * LifecycleKernel CLI — MCP/Python invoke path must not bypass Kernel MV.
 *
 * Usage:
 *   lifecycle_cli.ts <action> <projectRoot> '<jsonArgs>'
 *
 * Actions: submit_review | approve_review | reject_review | archive_task | finish_task
 */
import { join } from "node:path";

import { LedgerBuilder } from "../src/ledger/LedgerBuilder.ts";
import { flushScheduledLedgerRebuild } from "../src/ledger/scheduleLedgerRebuild.ts";
import { LifecycleKernel } from "../src/lifecycle/LifecycleKernel.ts";
import { AuthorityError } from "../src/lifecycle/LifecycleStateMachine.ts";

type LifecycleAction =
  | "submit_review"
  | "approve_review"
  | "reject_review"
  | "archive_task"
  | "finish_task";

function pickStr(args: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function taskIdFromArgs(args: Record<string, unknown>): string {
  let id = pickStr(args, "task_id", "taskId", "id", "filename");
  if (id.endsWith(".md")) id = id.replace(/\.md$/i, "");
  return id;
}

async function resolveReportId(
  projectRoot: string,
  taskId: string,
  explicit: string,
): Promise<string> {
  if (explicit.trim()) return explicit.trim().replace(/\.md$/i, "");
  const builder = new LedgerBuilder({ projectRoot });
  const reports = await builder.listReportsForTask(taskId);
  const done = reports
    .filter((r) => r.status === "done" || r.status === "completed")
    .sort((a, b) => b.report_id.localeCompare(a.report_id));
  return done[0]?.report_id ?? "";
}

async function main(): Promise<void> {
  const [action, projectRoot, argsJson] = process.argv.slice(2);
  if (!action || !projectRoot) {
    console.error(
      "usage: lifecycle_cli.ts <submit_review|approve_review|reject_review|archive_task|finish_task> <projectRoot> '<jsonArgs>'",
    );
    process.exit(2);
  }

  let args: Record<string, unknown> = {};
  if (argsJson?.trim()) {
    try {
      args = JSON.parse(argsJson) as Record<string, unknown>;
    } catch {
      console.error("invalid json args");
      process.exit(2);
    }
  }

  const taskId = taskIdFromArgs(args);
  if (!taskId) {
    console.log(JSON.stringify({ ok: false, error: "task_id is required" }));
    process.exit(1);
  }

  const actor = pickStr(args, "actor", "sender", "role", "reviewer") || "agent";
  const lifecycleRoot = join(projectRoot, "fcop", "_lifecycle");
  const kernel = new LifecycleKernel({ lifecycleRoot });

  try {
    let result;
    switch (action as LifecycleAction) {
      case "submit_review": {
        const reportId = await resolveReportId(
          projectRoot,
          taskId,
          pickStr(args, "report_id", "reportId", "report"),
        );
        if (!reportId) {
          console.log(
            JSON.stringify({
              ok: false,
              error:
                "submit_review denied: report_id required (no done REPORT found for task)",
              kernel: true,
            }),
          );
          process.exit(1);
        }
        result = await kernel.submitReview({
          taskId,
          actor,
          reportId,
          ...(pickStr(args, "reason", "note")
            ? { reason: pickStr(args, "reason", "note") }
            : {}),
        });
        break;
      }
      case "approve_review":
        result = await kernel.approveReview({
          taskId,
          actor,
          ...(pickStr(args, "note", "reason")
            ? { note: pickStr(args, "note", "reason") }
            : {}),
        });
        break;
      case "reject_review":
        result = await kernel.rejectReview({
          taskId,
          actor,
          reason:
            pickStr(args, "reason", "note") || "LifecycleKernel.reject_review",
        });
        break;
      case "archive_task":
        result = await kernel.archiveTask({
          taskId,
          actor,
          reason:
            pickStr(args, "reason", "note") || "LifecycleKernel.archive_task",
        });
        break;
      case "finish_task":
        result = await kernel.stateMachine.finishTaskLegacy({
          taskId,
          actor,
          ...(pickStr(args, "note", "reason")
            ? { note: pickStr(args, "note", "reason") }
            : {}),
        });
        break;
      default:
        console.error(`unknown action: ${action}`);
        process.exit(2);
    }
    await flushScheduledLedgerRebuild(projectRoot);
    console.log(JSON.stringify({ ok: true, kernel: true, ...result }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const authority = err instanceof AuthorityError;
    console.log(JSON.stringify({ ok: false, error: message, authority, kernel: true }));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
