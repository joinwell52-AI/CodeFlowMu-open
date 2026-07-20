#!/usr/bin/env npx tsx
/**
 * CLI for ADR-0002 ledger operations (invoked from Python fcop_invoke_once).
 *
 * Usage:
 *   ledger_cli.ts rebuild <projectRoot>
 *   ledger_cli.ts list_tasks <projectRoot> [recipient]
 *   ledger_cli.ts resolve_report <projectRoot> <reportFilePath>
 *   ledger_cli.ts verify_thread <projectRoot> <TASK_ID>
 *   ledger_cli.ts verify_237 <projectRoot>   (thin wrapper → verify_thread TASK-20260531-237)
 *   ledger_cli.ts summarize_thread <projectRoot> <thread_key>
 *   ledger_cli.ts detect_thread_stall <projectRoot> <thread_key>
 *   ledger_cli.ts close_admin_task <projectRoot> <thread_key|task_id>
 *   ledger_cli.ts wake_downstream_plan <projectRoot> <task_id> <role> [reason]
 *   ledger_cli.ts review_check <projectRoot> [--task_id=] [--report_id=]
 */
import { LedgerBuilder } from "../src/ledger/LedgerBuilder.ts";
import { verifyRegression237, verifyThread } from "../src/ledger/LedgerVerifier.ts";
import { ReportResolver } from "../src/ledger/ReportResolver.ts";
import {
  summarizeThread,
  detectThreadStall,
  closeAdminTaskDraft,
  buildWakeDownstreamRequest,
  resolveThreadContext,
  reviewCheck,
} from "../src/pm/PmGovernanceActions.ts";
import { join } from "node:path";

async function main(): Promise<void> {
  const [cmd, projectRoot, arg2] = process.argv.slice(2);
  if (!cmd || !projectRoot) {
    console.error(
      "usage: ledger_cli.ts <rebuild|list_tasks|resolve_report|verify_237|verify_thread|summarize_thread|detect_thread_stall|close_admin_task|wake_downstream_plan|review_check> <projectRoot> [arg...]",
    );
    process.exit(2);
  }

  if (cmd === "summarize_thread") {
    const threadKey = arg2?.trim();
    if (!threadKey) {
      console.error("summarize_thread requires thread_key");
      process.exit(2);
    }
    const result = await summarizeThread(projectRoot, threadKey);
    console.log(JSON.stringify(result, null, 2));
    if (!result) process.exit(1);
    return;
  }

  if (cmd === "detect_thread_stall") {
    const threadKey = arg2?.trim();
    if (!threadKey) {
      console.error("detect_thread_stall requires thread_key");
      process.exit(2);
    }
    const result = await detectThreadStall(projectRoot, threadKey);
    console.log(JSON.stringify(result, null, 2));
    if (!result) process.exit(1);
    return;
  }

  if (cmd === "close_admin_task") {
    const keyOrTask = arg2?.trim();
    if (!keyOrTask) {
      console.error("close_admin_task requires thread_key or task_id");
      process.exit(2);
    }
    const input =
      keyOrTask.includes("panel-") || !keyOrTask.startsWith("TASK-")
        ? { thread_key: keyOrTask }
        : { task_id: keyOrTask };
    const result = await closeAdminTaskDraft(projectRoot, input);
    console.log(JSON.stringify(result, null, 2));
    if (!result) process.exit(1);
    return;
  }

  if (cmd === "wake_downstream_plan") {
    const taskId = arg2?.trim();
    const role = process.argv[4]?.trim();
    const reason = process.argv[5]?.trim() || "nudge";
    if (!taskId || !role) {
      console.error("wake_downstream_plan requires task_id and role");
      process.exit(2);
    }
    const ctx = await resolveThreadContext(projectRoot, { task_id: taskId });
    const plan = buildWakeDownstreamRequest({
      task_id: taskId,
      role,
      reason,
      thread_key: ctx?.thread_key ?? null,
    });
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  if (cmd === "review_check") {
    let taskId = "";
    let reportId = "";
    for (const arg of process.argv.slice(3)) {
      const mTask = arg.match(/^--task_id=(.+)$/);
      const mReport = arg.match(/^--report_id=(.+)$/);
      if (mTask) taskId = mTask[1]!.trim();
      if (mReport) reportId = mReport[1]!.trim();
    }
    if (!taskId && !reportId && arg2) {
      if (arg2.startsWith("REPORT-")) reportId = arg2.trim();
      else taskId = arg2.trim();
    }
    if (!taskId && !reportId) {
      console.error("review_check requires --task_id= and/or --report_id=");
      process.exit(2);
    }
    const result = await reviewCheck(projectRoot, {
      task_id: taskId || undefined,
      report_id: reportId || undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result) process.exit(1);
    if (!result.ok) process.exit(1);
    return;
  }

  if (cmd === "verify_thread") {
    const taskId = arg2?.trim();
    if (!taskId) {
      console.error("verify_thread requires task_id (e.g. TASK-20260531-237)");
      process.exit(2);
    }
    const result = await verifyThread(projectRoot, taskId);
    console.log(JSON.stringify(result, null, 2));
    if (result.findings.length > 0) process.exit(1);
    return;
  }

  if (cmd === "verify_237") {
    const result = await verifyRegression237(projectRoot);
    console.log(JSON.stringify(result, null, 2));
    if (result.findings.length > 0) process.exit(1);
    return;
  }

  if (cmd === "rebuild") {
    const builder = new LedgerBuilder({ projectRoot });
    const result = await builder.rebuild();
    console.log(JSON.stringify(result));
    return;
  }

  if (cmd === "list_tasks") {
    const builder = new LedgerBuilder({ projectRoot });
    const tasks = await builder.listTasks(arg2?.trim() || undefined);
    console.log(JSON.stringify(tasks, null, 0));
    return;
  }

  if (cmd === "resolve_report") {
    const reportPath = arg2;
    if (!reportPath) {
      console.error("resolve_report requires report file path");
      process.exit(2);
    }
    const lifecycleRoot = join(projectRoot, "fcop", "_lifecycle");
    const resolver = new ReportResolver({ projectRoot, lifecycleRoot });
    await resolver.resolve(reportPath);
    console.log(JSON.stringify({ ok: true }));
    return;
  }

  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
