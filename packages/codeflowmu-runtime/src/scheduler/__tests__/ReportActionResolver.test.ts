import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  taskMarkdown,
  withTempLifecycle,
  writeTaskAt,
} from "../../lifecycle/__tests__/helpers.ts";
import { ensureLedgerLayout } from "../../ledger/paths.ts";
import { parseMarkdownFrontmatter } from "../../ledger/frontmatter.ts";
import {
  appendActionEvidence,
  resetActionEventIdCounterForTests,
} from "../../logs/ActionEvidenceLogger.ts";
import type { LifecycleGovernor } from "../LifecycleGovernor.ts";
import { ReportActionResolver } from "../ReportActionResolver.ts";

const FIXED_NOW = () => new Date("2026-06-05T12:00:00Z");

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

function mockGovernor(): LifecycleGovernor & {
  scheduled: string[];
} {
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

function resolver(rootDir: string, gov: LifecycleGovernor): ReportActionResolver {
  return new ReportActionResolver({
    projectRoot: rootDir,
    lifecycleGovernor: gov,
    now: FIXED_NOW,
  });
}

describe("ReportActionResolver", () => {
  it("status=done schedules active task to review", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      await ensureLedgerLayout(rootDir);
      await writeTaskAt(lifecycleRoot, "active", "TASK-20260605-001-ADMIN-to-PM.md", {
        protocol: "fcop",
        version: 1,
        kind: "task",
        sender: "ADMIN",
        recipient: "PM",
        to: "PM",
      });
      const reportPath = await writeReportAt(
        lifecycleRoot,
        "REPORT-20260605-001-PM-to-ADMIN.md",
        {
          sender: "PM",
          recipient: "ADMIN",
          status: "done",
          task_id: "TASK-20260605-001-ADMIN-to-PM",
        },
      );
      const gov = mockGovernor();
      const r = resolver(rootDir, gov);
      const outcome = await r.resolve(reportPath);
      assert.equal(outcome, "reconciled");
      assert.equal(gov.scheduled.length, 1);
      assert.equal(gov.scheduled[0], reportPath);
    });
  });

  it("worker report without task_id is resolved through ledger parenting", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      await ensureLedgerLayout(rootDir);
      await writeTaskAt(lifecycleRoot, "active", "TASK-20260605-012-PM-to-DEV.md", {
        protocol: "fcop",
        version: 1,
        kind: "task",
        sender: "PM",
        recipient: "DEV",
        parent: "TASK-20260605-001-ADMIN-to-PM",
        thread_key: "panel-task-012",
      });
      const reportPath = await writeReportAt(
        lifecycleRoot,
        "REPORT-20260605-012-DEV-to-PM.md",
        {
          sender: "DEV",
          recipient: "PM",
          status: "done",
        },
        "# Report\n\nDone. Root TASK-20260605-001, child TASK-20260605-012.\n",
      );
      const gov = mockGovernor();
      const outcome = await resolver(rootDir, gov).resolve(reportPath);
      assert.equal(outcome, "reconciled");
      assert.equal(gov.scheduled.length, 1);
      assert.equal(gov.scheduled[0], reportPath);
    });
  });

  it("action_request=submit_task schedules review", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      await ensureLedgerLayout(rootDir);
      await writeTaskAt(lifecycleRoot, "active", "TASK-20260605-002-ADMIN-to-DEV.md", {
        protocol: "fcop",
        version: 1,
        kind: "task",
        sender: "ADMIN",
        recipient: "DEV",
        to: "DEV",
      });
      const reportPath = await writeReportAt(
        lifecycleRoot,
        "REPORT-20260605-002-DEV-to-PM.md",
        {
          sender: "DEV",
          recipient: "PM",
          action_request: "submit_task",
          task_id: "TASK-20260605-002-ADMIN-to-DEV",
        },
      );
      const gov = mockGovernor();
      const outcome = await resolver(rootDir, gov).resolve(reportPath);
      assert.equal(outcome, "reconciled");
      assert.equal(gov.scheduled.length, 1);
    });
  });

  it("request_rework creates child TASK in inbox", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      await ensureLedgerLayout(rootDir);
      await writeTaskAt(
        lifecycleRoot,
        "done",
        "TASK-20260605-001-ADMIN-to-PM.md",
        {
          protocol: "fcop",
          version: 1,
          kind: "task",
          sender: "ADMIN",
          recipient: "PM",
          state: "done",
        },
      );
      const parentId = "TASK-20260605-003-ADMIN-to-DEV";
      await writeTaskAt(lifecycleRoot, "active", `${parentId}.md`, {
        protocol: "fcop",
        version: 1,
        kind: "task",
        sender: "ADMIN",
        recipient: "DEV",
        to: "DEV",
        thread_key: "thread-rework",
      });
      const reportPath = await writeReportAt(
        lifecycleRoot,
        "REPORT-20260605-003-PM-to-DEV-rework.md",
        {
          sender: "PM",
          recipient: "DEV",
          action_request: "request_rework",
          task_id: parentId,
          rework_reason: "missing unit tests",
        },
      );
      const gov = mockGovernor();
      const outcome = await resolver(rootDir, gov).resolve(reportPath);
      assert.equal(outcome, "rework_created");
      assert.equal(gov.scheduled.length, 0);

      const inboxNames = await readdir(join(lifecycleRoot, "inbox"));
      const reworkFile = inboxNames.find((n) => n.includes("-rework-"));
      assert.ok(reworkFile, "expected rework TASK in inbox");
      assert.match(reworkFile!, /^TASK-20260605-002-/);
      const raw = await readFile(join(lifecycleRoot, "inbox", reworkFile!), "utf-8");
      const fm = parseMarkdownFrontmatter(raw);
      assert.match(
        String(fm.task_id),
        /^TASK-\d{8}-\d{3}-PM-to-DEV-rework-1$/,
      );
      assert.equal(fm.parent, parentId);
      assert.equal(fm.rework_of, parentId);
      assert.equal(fm.rework_index, 1);
      assert.equal(fm.rework_reason, "missing unit tests");
      assert.equal(fm.source_report, "REPORT-20260605-003-PM-to-DEV-rework");
    });
  });

  it("rework limit reached writes ISSUE with REWORK_LIMIT_REACHED", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      await ensureLedgerLayout(rootDir);
      const parentId = "TASK-20260605-004-ADMIN-to-DEV";
      await writeTaskAt(lifecycleRoot, "active", `${parentId}.md`, {
        protocol: "fcop",
        version: 1,
        kind: "task",
        sender: "ADMIN",
        recipient: "DEV",
        to: "DEV",
      });
      for (let i = 1; i <= 3; i += 1) {
        await writeTaskAt(
          lifecycleRoot,
          "inbox",
          `TASK-20260605-00${4 + i}-PM-to-DEV-rework-${i}.md`,
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "DEV",
            parent: parentId,
            rework_of: parentId,
            rework_index: i,
          },
        );
      }
      const reportPath = await writeReportAt(
        lifecycleRoot,
        "REPORT-20260605-004-PM-rework-limit.md",
        {
          sender: "PM",
          recipient: "DEV",
          action_request: "request_rework",
          task_id: parentId,
          rework_reason: "fourth attempt",
        },
      );
      const gov = mockGovernor();
      const outcome = await resolver(rootDir, gov).resolve(reportPath);
      assert.equal(outcome, "issue_created");

      const issueNames = await readdir(join(rootDir, "fcop", "issues"));
      const issueFile = issueNames.find((n) => n.startsWith("ISSUE-"));
      assert.ok(issueFile);
      const issueRaw = await readFile(
        join(rootDir, "fcop", "issues", issueFile!),
        "utf-8",
      );
      const issueFm = parseMarkdownFrontmatter(issueRaw);
      assert.equal(issueFm.alert_code, "REWORK_LIMIT_REACHED");
    });
  });

  it("duplicate report returns duplicate", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      await ensureLedgerLayout(rootDir);
      const parentId = "TASK-20260605-005-ADMIN-to-PM";
      await writeTaskAt(lifecycleRoot, "active", `${parentId}.md`, {
        protocol: "fcop",
        version: 1,
        kind: "task",
        sender: "ADMIN",
        recipient: "PM",
        to: "PM",
      });
      const reportPath = await writeReportAt(
        lifecycleRoot,
        "REPORT-20260605-005-PM-done.md",
        {
          sender: "PM",
          recipient: "ADMIN",
          status: "done",
          task_id: parentId,
        },
      );
      const gov = mockGovernor();
      const r = resolver(rootDir, gov);
      assert.equal(await r.resolve(reportPath), "reconciled");
      assert.equal(await r.resolve(reportPath), "duplicate");
    });
  });

  it("invalid report missing task_id creates issue", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      await ensureLedgerLayout(rootDir);
      const reportPath = await writeReportAt(
        lifecycleRoot,
        "REPORT-20260605-006-PM-invalid.md",
        {
          sender: "PM",
          recipient: "ADMIN",
          status: "done",
        },
      );
      const gov = mockGovernor();
      const outcome = await resolver(rootDir, gov).resolve(reportPath);
      assert.equal(outcome, "issue_created");
      assert.equal(gov.scheduled.length, 0);
    });
  });

  it("fact gate fail marks waiting_pm_attention without rework", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      resetActionEventIdCounterForTests();
      await ensureLedgerLayout(rootDir);
      const parentId = "TASK-20260605-008-ADMIN-to-DEV";
      await writeTaskAt(lifecycleRoot, "active", `${parentId}.md`, {
        protocol: "fcop",
        version: 1,
        kind: "task",
        sender: "ADMIN",
        recipient: "DEV",
        to: "DEV",
      });
      const reportPath = await writeReportAt(
        lifecycleRoot,
        "REPORT-20260605-008-DEV-to-PM.md",
        {
          sender: "DEV",
          recipient: "PM",
          action_request: "submit_task",
          task_id: parentId,
        },
        "# Report\n\n单元测试全部通过。\n",
      );
      const gov = mockGovernor();
      const outcome = await resolver(rootDir, gov).resolve(reportPath);
      assert.equal(outcome, "waiting_pm_attention");
      assert.equal(gov.scheduled.length, 0);

      const activePath = join(lifecycleRoot, "active", `${parentId}.md`);
      const taskRaw = await readFile(activePath, "utf-8");
      const taskFm = parseMarkdownFrontmatter(taskRaw);
      assert.equal(taskFm.display_status, "waiting_pm_attention");

      const inboxNames = await readdir(join(lifecycleRoot, "inbox"));
      assert.ok(
        !inboxNames.some((n) => n.includes("rework-")),
        "must not create OPS-to-OPS rework",
      );

      const reviewNames = await readdir(join(rootDir, "fcop", "reviews"));
      const gateName = reviewNames.find((n) => n.includes("REVIEW-GATE"));
      assert.ok(gateName, "must write REVIEW-GATE artefact");
      const reviewRaw = await readFile(
        join(rootDir, "fcop", "reviews", gateName!),
        "utf-8",
      );
      const reviewFm = parseMarkdownFrontmatter(reviewRaw);
      assert.equal(reviewFm.decision, "changes_requested");
      assert.match(reviewRaw, /## 判定说明/);
      assert.match(reviewRaw, /自动退回整改/);
      const attn = String(taskFm.pm_attention_reason ?? "");
      assert.match(attn, /事实核查未通过/);
      assert.ok(!attn.startsWith("fact_check:"), "pm_attention_reason must be human-readable");
    });
  });

  it("fact gate needs_admin marks waiting_pm_attention with human-readable reason", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      resetActionEventIdCounterForTests();
      await ensureLedgerLayout(rootDir);
      const parentId = "TASK-20260605-010-ADMIN-to-DEV";
      await writeTaskAt(lifecycleRoot, "active", `${parentId}.md`, {
        protocol: "fcop",
        version: 1,
        kind: "task",
        sender: "ADMIN",
        recipient: "DEV",
        to: "DEV",
      });
      const reportPath = await writeReportAt(
        lifecycleRoot,
        "REPORT-20260605-010-DEV-to-PM.md",
        {
          sender: "DEV",
          recipient: "PM",
          action_request: "submit_task",
          task_id: parentId,
          session_id: "sess-needs-admin-unit",
        },
        "# Report\n\n单元测试全部通过。\n",
      );
      const gov = mockGovernor();
      const outcome = await resolver(rootDir, gov).resolve(reportPath);
      assert.equal(outcome, "waiting_pm_attention");
      assert.equal(gov.scheduled.length, 0);

      const taskRaw = await readFile(
        join(lifecycleRoot, "active", `${parentId}.md`),
        "utf-8",
      );
      const taskFm = parseMarkdownFrontmatter(taskRaw);
      assert.equal(taskFm.display_status, "waiting_pm_attention");
      const attn = String(taskFm.pm_attention_reason ?? "");
      assert.match(attn, /事实核查需人工裁定/);
      assert.ok(!attn.startsWith("fact_check:"));
    });
  });

  it("QA missing acceptance evidence is rejected and creates a QA rework task", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      resetActionEventIdCounterForTests();
      await ensureLedgerLayout(rootDir);
      const taskId = "TASK-20260712-003-PM-to-QA";
      await writeTaskAt(lifecycleRoot, "active", `${taskId}.md`, {
        protocol: "fcop",
        version: 1,
        kind: "task",
        task_id: "TASK-20260712-003",
        sender: "PM",
        recipient: "QA",
        to: "QA",
        parent: "TASK-20260712-001",
        thread_key: "panel-task-001",
      });
      const reportPath = await writeReportAt(
        lifecycleRoot,
        "REPORT-20260712-003-QA-to-PM.md",
        {
          sender: "QA",
          recipient: "PM",
          status: "done",
          action_request: "submit_task",
          task_id: "TASK-20260712-003",
        },
        "# QA Report\n\nAll tests passed.\n",
      );
      const outcome = await resolver(rootDir, mockGovernor()).resolve(reportPath);
      assert.equal(outcome, "rework_created");

      const rejectedReport = parseMarkdownFrontmatter(
        await readFile(reportPath, "utf-8"),
      );
      assert.equal(rejectedReport.status, "rejected");
      assert.equal(rejectedReport.valid, false);
      assert.equal(rejectedReport.invalidated_by, "REVIEW-GATE");

      const sourceTask = parseMarkdownFrontmatter(
        await readFile(join(lifecycleRoot, "done", `${taskId}.md`), "utf-8"),
      );
      assert.equal(sourceTask.display_status, "rejected_superseded");
      assert.equal(sourceTask.review_status, "rejected");

      const inboxNames = await readdir(join(lifecycleRoot, "inbox"));
      const reworkFile = inboxNames.find((name) => name.includes("-rework-"));
      assert.ok(reworkFile);
      const reworkFm = parseMarkdownFrontmatter(
        await readFile(join(lifecycleRoot, "inbox", reworkFile!), "utf-8"),
      );
      assert.equal(reworkFm.recipient, "QA");
      assert.equal(reworkFm.thread_key, "panel-task-001");
      assert.equal(sourceTask.superseded_by, reworkFm.task_id);
      assert.equal(rejectedReport.superseded_by, reworkFm.task_id);
      assert.match(
        String(reworkFm.task_id),
        /^TASK-\d{8}-\d{3}-PM-to-QA-rework-1$/,
      );
    });
  });

  it("fact gate pass clears stale waiting_pm_attention on task", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      resetActionEventIdCounterForTests();
      await ensureLedgerLayout(rootDir);
      const parentId = "TASK-20260605-011-ADMIN-to-DEV";
      await writeTaskAt(lifecycleRoot, "active", `${parentId}.md`, {
        protocol: "fcop",
        version: 1,
        kind: "task",
        sender: "ADMIN",
        recipient: "DEV",
        to: "DEV",
        display_status: "waiting_pm_attention",
        pm_attention_reason: "事实核查未通过：旧脏状态",
      });
      appendActionEvidence(rootDir, {
        event_type: "command.run",
        at: "2026-06-05T12:00:00.000Z",
        task_id: parentId,
        session_id: "sess-clear-attn",
        agent_id: "DEV",
        role: "DEV",
        status: "success",
        command: "npm test",
        exit_code: 0,
        call_id: "fg-cmd-clear",
      });
      const reportPath = await writeReportAt(
        lifecycleRoot,
        "REPORT-20260605-011-DEV-to-PM.md",
        {
          sender: "DEV",
          recipient: "PM",
          action_request: "submit_task",
          task_id: parentId,
        },
        "# Report\n\n单元测试全部通过。\n",
      );
      const gov = mockGovernor();
      const outcome = await resolver(rootDir, gov).resolve(reportPath);
      assert.equal(outcome, "reconciled");

      const taskRaw = await readFile(
        join(lifecycleRoot, "active", `${parentId}.md`),
        "utf-8",
      );
      const taskFm = parseMarkdownFrontmatter(taskRaw);
      assert.equal(taskFm.display_status, undefined);
      assert.equal(taskFm.pm_attention_reason, undefined);
    });
  });

  it("fact gate pass when test claims backed by command.run evidence", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      resetActionEventIdCounterForTests();
      await ensureLedgerLayout(rootDir);
      const parentId = "TASK-20260605-009-ADMIN-to-DEV";
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
        at: "2026-06-05T12:00:00.000Z",
        task_id: parentId,
        session_id: "sess-fact-gate",
        agent_id: "DEV",
        role: "DEV",
        status: "success",
        command: "npm test",
        exit_code: 0,
        call_id: "fg-cmd-1",
      });
      const reportPath = await writeReportAt(
        lifecycleRoot,
        "REPORT-20260605-009-DEV-to-PM.md",
        {
          sender: "DEV",
          recipient: "PM",
          action_request: "submit_task",
          task_id: parentId,
        },
        "# Report\n\n单元测试全部通过。\n",
      );
      const gov = mockGovernor();
      const outcome = await resolver(rootDir, gov).resolve(reportPath);
      assert.equal(outcome, "reconciled");
      assert.equal(gov.scheduled.length, 1);
    });
  });

  it("legacy status=blocked creates issue with structured content", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      await ensureLedgerLayout(rootDir);
      const taskId = "TASK-20260605-007-ADMIN-to-PM";
      const threadKey = "thread-blocked-007";
      await writeTaskAt(lifecycleRoot, "active", `${taskId}.md`, {
        protocol: "fcop",
        version: 1,
        kind: "task",
        sender: "ADMIN",
        recipient: "PM",
        to: "PM",
        thread_key: threadKey,
      });
      const reportPath = await writeReportAt(
        lifecycleRoot,
        "REPORT-20260605-007-PM-blocked.md",
        {
          sender: "PM",
          recipient: "ADMIN",
          status: "blocked",
          task_id: taskId,
          thread_key: threadKey,
        },
        [
          "# Report",
          "",
          "## 结论",
          "",
          "QA 验证未通过，当前 blocked 不建议直接 approve。",
          "",
          "## 证据",
          "",
          "- EVAL 观察报告缺少 DEV 回执",
          "- QA 结论：request_rework",
        ].join("\n"),
      );
      const gov = mockGovernor();
      const outcome = await resolver(rootDir, gov).resolve(reportPath);
      assert.equal(outcome, "issue_created");

      const issueNames = await readdir(join(rootDir, "fcop", "issues"));
      const issueFile = issueNames.find((n) => n.startsWith("ISSUE-"));
      assert.ok(issueFile);
      const issueRaw = await readFile(
        join(rootDir, "fcop", "issues", issueFile!),
        "utf-8",
      );
      const issueFm = parseMarkdownFrontmatter(issueRaw);
      assert.equal(issueFm.reason, "blocked_report");
      assert.equal(issueFm.source_report, "REPORT-20260605-007-PM-blocked");
      assert.equal(issueFm.source_task, taskId);
      assert.equal(issueFm.thread_key, threadKey);
      assert.equal(issueFm.owner, "ADMIN");
      assert.equal(issueFm.severity, "medium");
      assert.match(issueRaw, /## 问题摘要/);
      assert.match(issueRaw, /QA 验证未通过/);
      assert.match(issueRaw, /## 影响范围/);
      assert.match(issueRaw, /## 证据/);
      assert.match(issueRaw, /request_rework/);
      assert.match(issueRaw, /## 建议动作/);
      assert.match(issueRaw, /request_rework/);
      assert.match(issueRaw, /EVAL/);
      assert.match(issueRaw, /不建议直接 approve/);
    });
  });

  it("status=failed creates issue with failed remediation guidance", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      await ensureLedgerLayout(rootDir);
      const taskId = "TASK-20260605-012-ADMIN-to-DEV";
      await writeTaskAt(lifecycleRoot, "active", `${taskId}.md`, {
        protocol: "fcop",
        version: 1,
        kind: "task",
        sender: "ADMIN",
        recipient: "DEV",
        to: "DEV",
      });
      const reportPath = await writeReportAt(
        lifecycleRoot,
        "REPORT-20260605-012-DEV-failed.md",
        {
          sender: "DEV",
          recipient: "PM",
          status: "failed",
          task_id: taskId,
        },
        [
          "# Report",
          "",
          "## 执行结果",
          "",
          "构建 failed，DEV 无法继续，需 ADMIN 介入。",
        ].join("\n"),
      );
      const gov = mockGovernor();
      const outcome = await resolver(rootDir, gov).resolve(reportPath);
      assert.equal(outcome, "issue_created");

      const issueNames = await readdir(join(rootDir, "fcop", "issues"));
      const issueFile = issueNames.find((n) => n.startsWith("ISSUE-"));
      assert.ok(issueFile);
      const issueRaw = await readFile(
        join(rootDir, "fcop", "issues", issueFile!),
        "utf-8",
      );
      const issueFm = parseMarkdownFrontmatter(issueRaw);
      assert.equal(issueFm.reason, "failed_report");
      assert.match(issueRaw, /构建 failed/);
      assert.match(issueRaw, /ADMIN 介入/);
      assert.match(issueRaw, /重新派发/);
      assert.match(issueRaw, /不建议直接 approve/);
    });
  });

  it("empty report body still produces fallback issue content", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      await ensureLedgerLayout(rootDir);
      const taskId = "TASK-20260605-013-ADMIN-to-PM";
      await writeTaskAt(lifecycleRoot, "active", `${taskId}.md`, {
        protocol: "fcop",
        version: 1,
        kind: "task",
        sender: "ADMIN",
        recipient: "PM",
        to: "PM",
      });
      const reportPath = await writeReportAt(
        lifecycleRoot,
        "REPORT-20260605-013-PM-blocked-empty.md",
        {
          sender: "PM",
          recipient: "ADMIN",
          status: "blocked",
          task_id: taskId,
        },
        "# Report\n",
      );
      const gov = mockGovernor();
      const outcome = await resolver(rootDir, gov).resolve(reportPath);
      assert.equal(outcome, "issue_created");

      const issueNames = await readdir(join(rootDir, "fcop", "issues"));
      const issueFile = issueNames.find((n) => n.startsWith("ISSUE-"));
      assert.ok(issueFile);
      const issueRaw = await readFile(
        join(rootDir, "fcop", "issues", issueFile!),
        "utf-8",
      );
      assert.match(issueRaw, /源 REPORT 请求升级为 ISSUE，但未提供明确摘要/);
      assert.match(issueRaw, /Source report: REPORT-20260605-013-PM-blocked-empty\.md/);
      assert.match(issueRaw, /Source task: TASK-20260605-013-ADMIN-to-PM/);
    });
  });

  it("DEV-to-PM report on archived task returns late_intake without scheduling governor", async () => {
    await withTempLifecycle(async ({ lifecycleRoot, rootDir }) => {
      await ensureLedgerLayout(rootDir);
      const taskId = "TASK-20260610-027-PM-to-DEV";
      await writeTaskAt(lifecycleRoot, "archive", `${taskId}.md`, {
        protocol: "fcop",
        version: 1,
        kind: "task",
        sender: "PM",
        recipient: "DEV",
        to: "DEV",
        thread_key: "panel-task-209",
        display_status: "archived",
      });
      const reportPath = await writeReportAt(
        lifecycleRoot,
        "REPORT-20260610-074-DEV-to-PM.md",
        {
          sender: "DEV",
          recipient: "PM",
          status: "done",
          task_id: taskId,
          thread_key: "panel-task-209",
        },
      );
      const gov = mockGovernor();
      const outcome = await resolver(rootDir, gov).resolve(reportPath);
      assert.equal(outcome, "late_intake");
      assert.equal(gov.scheduled.length, 0);

      const intakePath = join(
        rootDir,
        ".codeflowmu",
        "pm-governance",
        "late-report-intake.jsonl",
      );
      const intakeRaw = await readFile(intakePath, "utf-8");
      assert.match(intakeRaw, /REPORT-20260610-074-DEV-to-PM/);
      assert.match(intakeRaw, /noted_only/);
      assert.match(intakeRaw, /closed_thread_supplemental_report/);
    });
  });
});
