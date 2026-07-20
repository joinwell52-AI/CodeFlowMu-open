/**
 * 端到端验收：LOG / REPORT / REVIEW / EVAL 四层接线闭环（临时目录，不污染仓库 fcop/）。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  taskMarkdown,
  withTempLifecycle,
  writeTaskAt,
} from "../lifecycle/__tests__/helpers.ts";
import { ensureLedgerLayout } from "../ledger/paths.ts";
import { parseMarkdownFrontmatter } from "../ledger/frontmatter.ts";
import {
  appendActionEvidence,
  readActionEvidenceLines,
  resetActionEventIdCounterForTests,
} from "../logs/ActionEvidenceLogger.ts";
import {
  maybeRecordActionEvidenceFromToolCall,
  resetActionEvidenceToolCallDedupeForTests,
} from "../logs/ActionEvidenceFromToolCall.ts";
import {
  maybeRecordReportWriteAction,
  resetReportWriteActionDedupeForTests,
} from "../logs/ActionEvidenceFromReport.ts";
import {
  actionEvidenceLogPath,
  actionLogsDateKey,
} from "../logs/actionLogPaths.ts";
import { maybeWriteEvalObservation } from "../eval/EvalObservationGenerator.ts";
import { PanelEventBridge } from "../panel/PanelEventBridge.ts";
import type { LifecycleGovernor } from "../scheduler/LifecycleGovernor.ts";
import {
  ReportActionResolver,
  type ReportActionOutcome,
} from "../scheduler/ReportActionResolver.ts";

const FIXED_NOW = () => new Date("2026-06-07T12:00:00Z");
const PM_TO_ADMIN_RE =
  /^REPORT-\d{8}-\d{3,}-PM-to-ADMIN(-[a-z][a-z0-9-]*)?\.md$/i;

async function writeReportAt(
  lifecycleRoot: string,
  filename: string,
  fm: Record<string, string | string[] | number>,
  bodyMarkdown = "# Report\n",
): Promise<string> {
  const dir = join(lifecycleRoot, "..", "reports");
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  const path = join(dir, filename);
  const body = taskMarkdown(
    {
      protocol: "fcop",
      version: 1,
      kind: "report",
      sender: fm.sender ?? "PM",
      recipient: fm.recipient ?? "ADMIN",
      ...fm,
    } as Parameters<typeof taskMarkdown>[0],
    bodyMarkdown,
  );
  await writeFile(path, body, "utf-8");
  return path;
}

function mockGovernor(): LifecycleGovernor & { scheduled: string[] } {
  const scheduled: string[] = [];
  return {
    scheduled,
    scheduleTaskToReviewOnReport(reportFilePath: string) {
      scheduled.push(reportFilePath);
    },
    async resolveReportSettlement(reportFilePath: string) {
      scheduled.push(reportFilePath);
      return "reconciled";
    },
  } as unknown as LifecycleGovernor & { scheduled: string[] };
}

/** 镜像 Runtime.ts ReportWatcher 热路径（emit 省略）。 */
async function runRuntimeReportHotPath(opts: {
  rootDir: string;
  reportPath: string;
  filename: string;
  content: string;
  senderRole?: string;
  lifecycleGovernor: LifecycleGovernor;
  panelEvents?: PanelEventBridge;
}): Promise<ReportActionOutcome> {
  maybeRecordReportWriteAction({
    projectRoot: opts.rootDir,
    filepath: opts.reportPath,
    filename: opts.filename,
    senderRole: opts.senderRole,
    content: opts.content,
    detected_at: FIXED_NOW().toISOString(),
  });

  const resolver = new ReportActionResolver({
    projectRoot: opts.rootDir,
    lifecycleGovernor: opts.lifecycleGovernor,
    panelEvents: opts.panelEvents,
    now: FIXED_NOW,
  });
  const outcome = await resolver.resolve(opts.reportPath);

  if (PM_TO_ADMIN_RE.test(opts.filename)) {
    const fm = parseMarkdownFrontmatter(opts.content) as Record<string, unknown>;
    await maybeWriteEvalObservation({
      projectRoot: opts.rootDir,
      pmReportPath: opts.reportPath,
      pmReportFilename: opts.filename,
      pmReportContent: opts.content,
      pmReportFm: fm,
      now: FIXED_NOW,
    });
  }

  return outcome;
}

describe("E2E: LOG / REPORT / REVIEW / EVAL acceptance", () => {
  beforeEach(() => {
    resetActionEvidenceToolCallDedupeForTests();
    resetReportWriteActionDedupeForTests();
    resetActionEventIdCounterForTests();
  });

  afterEach(() => {
    resetActionEvidenceToolCallDedupeForTests();
    resetReportWriteActionDedupeForTests();
    resetActionEventIdCounterForTests();
  });

  it("1 Action Evidence — AgentSdkAdapter 形态工具调用写入 actions jsonl", async () => {
    await withTempLifecycle(async ({ rootDir }) => {
      const taskId = "TASK-20260607-101-ADMIN-to-DEV";
      const callId = "gemini-e2e-call-1";
      const payload = {
        raw: {
          name: "run_terminal_cmd",
          args: { command: "npm test -w codeflowmu-runtime" },
          status: "completed",
          call_id: callId,
          id: callId,
          result: { exit_code: 0, stdout: "27 passed" },
        },
      };

      maybeRecordActionEvidenceFromToolCall({
        projectRoot: rootDir,
        agent_id: "DEV",
        session_id: "sess-gemini-e2e",
        task_id: taskId,
        payload,
      });

      const dateKey = actionLogsDateKey();
      const logPath = actionEvidenceLogPath(rootDir, dateKey);
      assert.match(logPath.replace(/\\/g, "/"), new RegExp(`actions-${dateKey}\\.jsonl$`));
      const raw = await readFile(logPath, "utf-8");
      assert.ok(raw.length > 0);

      const records = readActionEvidenceLines(rootDir);
      assert.equal(records.length, 1);
      const rec = records[0]!;
      assert.equal(rec.event_type, "command.run");
      assert.equal(rec.agent_id, "DEV");
      assert.equal(rec.task_id, "TASK-20260607-101");
      assert.equal(rec.call_id, callId);
      assert.equal(rec.status, "success");
      assert.match(rec.command, /npm test/);
    });
  });

  it("2 REPORT 写入证据 — ReportWatcher 热路径产生 report.write", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      await ensureLedgerLayout(rootDir);
      const parentId = "TASK-20260607-102-ADMIN-to-DEV";
      await writeTaskAt(lifecycleRoot, "active", `${parentId}.md`, {
        protocol: "fcop",
        version: 1,
        kind: "task",
        sender: "ADMIN",
        recipient: "DEV",
        to: "DEV",
      });

      const filename = "REPORT-20260607-102-DEV-to-PM.md";
      const reportPath = await writeReportAt(
        lifecycleRoot,
        filename,
        {
          sender: "DEV",
          recipient: "PM",
          action_request: "none",
          task_id: parentId,
          session_id: "sess-report-write",
        },
        "# 进度汇报\n",
      );
      const content = await readFile(reportPath, "utf-8");
      const gov = mockGovernor();

      const outcome = await runRuntimeReportHotPath({
        rootDir,
        reportPath,
        filename,
        content,
        senderRole: "DEV",
        lifecycleGovernor: gov,
      });

      assert.equal(outcome, "noop");
      const records = readActionEvidenceLines(rootDir);
      const reportWrites = records.filter((r) => r.event_type === "report.write");
      assert.equal(reportWrites.length, 1);
      assert.equal(reportWrites[0]!.task_id, parentId);
      assert.match(reportWrites[0]!.report_id ?? "", /REPORT-20260607-102/);
    });
  });

  it("3 Review Fact Gate — pass：有 command 证据则 submit + REVIEW-GATE", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      await ensureLedgerLayout(rootDir);
      const parentId = "TASK-20260607-103-ADMIN-to-DEV";
      await writeTaskAt(lifecycleRoot, "active", `${parentId}.md`, {
        protocol: "fcop",
        version: 1,
        kind: "task",
        sender: "ADMIN",
        recipient: "DEV",
        to: "DEV",
      });

      appendActionEvidence(rootDir, {
        event_type: "command.run",
        at: FIXED_NOW().toISOString(),
        task_id: parentId,
        session_id: "sess-fact-pass",
        agent_id: "DEV",
        role: "DEV",
        status: "success",
        command: "npm test",
        exit_code: 0,
        call_id: "e2e-cmd-pass",
      });

      const filename = "REPORT-20260607-103-DEV-to-PM.md";
      const reportPath = await writeReportAt(
        lifecycleRoot,
        filename,
        {
          sender: "DEV",
          recipient: "PM",
          action_request: "submit_task",
          task_id: parentId,
        },
        "# Report\n\n单元测试全部通过。\n",
      );
      const content = await readFile(reportPath, "utf-8");
      const gov = mockGovernor();

      const outcome = await runRuntimeReportHotPath({
        rootDir,
        reportPath,
        filename,
        content,
        lifecycleGovernor: gov,
      });

      assert.equal(outcome, "reconciled");
      assert.equal(gov.scheduled.length, 1);

      const reviewNames = await readdir(join(rootDir, "fcop", "reviews"));
      const gateReview = reviewNames.find((n) =>
        n.includes(`REVIEW-GATE-on-${parentId}`),
      );
      assert.ok(gateReview, `expected REVIEW-GATE-on-${parentId} in reviews/`);
      const reviewRaw = await readFile(
        join(rootDir, "fcop", "reviews", gateReview!),
        "utf-8",
      );
      assert.match(reviewRaw, /decision:\s*approved|verdict:\s*pass/i);
    });
  });

  it("4a Review Fact Gate — fail：缺证据则 waiting_pm_attention、不 submit、不返工", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      await ensureLedgerLayout(rootDir);
      const parentId = "TASK-20260607-104-ADMIN-to-DEV";
      await writeTaskAt(lifecycleRoot, "active", `${parentId}.md`, {
        protocol: "fcop",
        version: 1,
        kind: "task",
        sender: "ADMIN",
        recipient: "DEV",
        to: "DEV",
      });

      const filename = "REPORT-20260607-104-DEV-to-PM.md";
      const reportPath = await writeReportAt(
        lifecycleRoot,
        filename,
        {
          sender: "DEV",
          recipient: "PM",
          action_request: "submit_task",
          task_id: parentId,
        },
        "# Report\n\n单元测试全部通过。\n",
      );
      const content = await readFile(reportPath, "utf-8");
      const gov = mockGovernor();

      const outcome = await runRuntimeReportHotPath({
        rootDir,
        reportPath,
        filename,
        content,
        lifecycleGovernor: gov,
      });

      assert.equal(outcome, "waiting_pm_attention");
      assert.equal(gov.scheduled.length, 0);

      const inboxNames = await readdir(join(lifecycleRoot, "inbox"));
      assert.ok(!inboxNames.some((n) => n.includes("rework-")));

      const reviewNames = await readdir(join(rootDir, "fcop", "reviews"));
      assert.ok(reviewNames.some((n) => n.includes("REVIEW-GATE")));
    });
  });

  it("4b Review Fact Gate — references 与 task_id 不匹配则 issue、不 submit", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      await ensureLedgerLayout(rootDir);
      const parentId = "TASK-20260607-105-ADMIN-to-DEV";
      const otherId = "TASK-20260607-099-ADMIN-to-DEV";
      await writeTaskAt(lifecycleRoot, "active", `${parentId}.md`, {
        protocol: "fcop",
        version: 1,
        kind: "task",
        sender: "ADMIN",
        recipient: "DEV",
        to: "DEV",
      });

      const filename = "REPORT-20260607-105-DEV-to-PM.md";
      const reportPath = await writeReportAt(
        lifecycleRoot,
        filename,
        {
          sender: "DEV",
          recipient: "PM",
          action_request: "submit_task",
          task_id: parentId,
          references: [otherId],
        },
        "# Report\n\n无测试声称。\n",
      );
      const content = await readFile(reportPath, "utf-8");
      const gov = mockGovernor();

      const outcome = await runRuntimeReportHotPath({
        rootDir,
        reportPath,
        filename,
        content,
        lifecycleGovernor: gov,
      });

      assert.equal(outcome, "issue_created");
      assert.equal(gov.scheduled.length, 0);

      const issueNames = await readdir(join(rootDir, "fcop", "issues"));
      assert.ok(issueNames.some((n) => n.startsWith("ISSUE-")));
    });
  });

  it("5 Review Fact Gate — needs_admin：session 证据缺口、不推进 lifecycle", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      await ensureLedgerLayout(rootDir);
      const parentId = "TASK-20260607-106-ADMIN-to-DEV";
      await writeTaskAt(lifecycleRoot, "active", `${parentId}.md`, {
        protocol: "fcop",
        version: 1,
        kind: "task",
        sender: "ADMIN",
        recipient: "DEV",
        to: "DEV",
      });

      const filename = "REPORT-20260607-106-DEV-to-PM.md";
      const reportPath = await writeReportAt(
        lifecycleRoot,
        filename,
        {
          sender: "DEV",
          recipient: "PM",
          action_request: "submit_task",
          task_id: parentId,
          session_id: "sess-needs-admin-e2e",
        },
        "# Report\n\n单元测试全部通过。\n",
      );
      const content = await readFile(reportPath, "utf-8");
      const gov = mockGovernor();
      const panel = new PanelEventBridge();
      const emitted: Array<{ type: string; payload: Record<string, unknown> }> =
        [];
      panel.setSink((type, payload) => {
        emitted.push({ type, payload });
      });

      const outcome = await runRuntimeReportHotPath({
        rootDir,
        reportPath,
        filename,
        content,
        lifecycleGovernor: gov,
        panelEvents: panel,
      });

      assert.equal(outcome, "waiting_pm_attention");
      assert.equal(gov.scheduled.length, 0);
      assert.ok(
        emitted.some(
          (e) =>
            e.type === "codeflowmu.review.fact_check_needs_admin" &&
            e.payload.reason_code === "session_evidence_gap",
        ),
      );

      const activePath = join(lifecycleRoot, "active", `${parentId}.md`);
      const taskRaw = await readFile(activePath, "utf-8");
      const taskFm = parseMarkdownFrontmatter(taskRaw);
      assert.equal(taskFm.display_status, "waiting_pm_attention");
      const attn = String(taskFm.pm_attention_reason ?? "");
      assert.match(attn, /事实核查需人工裁定/);
      assert.ok(!attn.startsWith("fact_check:"));

      const reviewNames = await readdir(join(rootDir, "fcop", "reviews"));
      const gateName = reviewNames.find((n) => n.includes("REVIEW-GATE"));
      assert.ok(gateName);
      const reviewRaw = await readFile(
        join(rootDir, "fcop", "reviews", gateName!),
        "utf-8",
      );
      assert.match(reviewRaw, /## 判定说明/);
      assert.match(reviewRaw, /需 ADMIN 人工裁定|需人工裁定/);
    });
  });

  it("6 EVAL 旁路 — PM-to-ADMIN 写 OBSERVATION、EVAL 不改 lifecycle", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      await ensureLedgerLayout(rootDir);
      const parentId = "TASK-20260607-107-ADMIN-to-PM";
      const e2eThread = "e2e-eval-thread-107";
      await writeTaskAt(lifecycleRoot, "active", `${parentId}.md`, {
        protocol: "fcop",
        version: 1,
        kind: "task",
        sender: "ADMIN",
        recipient: "PM",
        to: "PM",
        task_id: parentId,
        thread_key: e2eThread,
      });

      const lifecycleSnapshot = async (): Promise<string[]> => {
        const stages = ["inbox", "active", "review", "done", "archive"] as const;
        const names: string[] = [];
        for (const stage of stages) {
          const dir = join(lifecycleRoot, stage);
          try {
            const entries = await readdir(dir);
            for (const n of entries) {
              if (n.endsWith(".md")) names.push(`${stage}/${n}`);
            }
          } catch {
            /* stage dir may be absent */
          }
        }
        return names.sort();
      };
      const lifecycleBefore = await lifecycleSnapshot();

      const filename = "REPORT-20260607-107-PM-to-ADMIN-e2e-eval.md";
      const reportPath = await writeReportAt(
        lifecycleRoot,
        filename,
        {
          sender: "PM",
          recipient: "ADMIN",
          task_id: parentId,
          thread_key: e2eThread,
          status: "done",
        },
        "# PM 汇总\n\n端到端 EVAL 旁路验收。\n",
      );
      const content = await readFile(reportPath, "utf-8");
      const gov = mockGovernor();

      const outcome = await runRuntimeReportHotPath({
        rootDir,
        reportPath,
        filename,
        content,
        senderRole: "PM",
        lifecycleGovernor: gov,
      });

      // ReportActionResolver 仍会对 PM-to-ADMIN done 走 settlement；EVAL 旁路不额外改 lifecycle。
      assert.equal(outcome, "reconciled");
      assert.ok(gov.scheduled.length >= 1);
      assert.deepEqual(await lifecycleSnapshot(), lifecycleBefore);

      const evalDir = join(rootDir, "fcop", "internal", "eval");
      const obsNames = await readdir(evalDir);
      assert.ok(obsNames.some((n) => n.startsWith("OBSERVATION-20260607-")));

      const obsPath = join(
        evalDir,
        obsNames.find((n) => n.startsWith("OBSERVATION-"))!,
      );
      const obsRaw = await readFile(obsPath, "utf-8");
      assert.match(obsRaw, /INTERNAL ONLY/);
      assert.match(obsRaw, /source_report: REPORT-20260607-107-PM-to-ADMIN/);
    });
  });
});
