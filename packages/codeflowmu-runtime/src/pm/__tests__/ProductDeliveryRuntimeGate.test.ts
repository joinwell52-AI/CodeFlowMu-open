import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  guardLandedPmProductWorkerTask,
  guardPmProductWorkerWriteTask,
  pinPmWorkerTaskLineage,
} from "../ProductDeliveryRuntimeGate.ts";
import type { ParsedTask } from "../../scheduler/TaskParser.ts";

test("PM worker task uses the current child task as direct lineage", () => {
  const result = pinPmWorkerTaskLineage(
    {
      sender: "PM",
      recipient: "QA",
      references: ["TASK-20260712-910", "TASK-20260713-011"],
    },
    "TASK-20260712-911-ADMIN-to-PM",
  );
  assert.deepEqual(result.references, [
    "TASK-20260712-911",
    "TASK-20260712-910",
    "TASK-20260713-011",
  ]);
});

test("PM implementation task creation is blocked before a planning root can be verified", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-pm-write-gate-"));
  try {
    const result = await guardPmProductWorkerWriteTask({
      projectRoot: root,
      agentId: "PM-01",
      args: {
        sender: "PM",
        recipient: "DEV",
        subject: "实现新产品",
        body: "实现一个新的移动端 PWA 产品与 UI/UX",
      },
    });
    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.equal(result.code, "PRODUCT_BRIEF_REQUIRED");
      assert.equal(result.required_action, "resolve_root_task_before_planning_validation");
      assert.deepEqual(result.findings, ["product_root_context_missing"]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Level 0 PM coordination is not blocked by Product Brief", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-pm-write-gate-"));
  try {
    const result = await guardPmProductWorkerWriteTask({
      projectRoot: root,
      agentId: "PM-01",
      args: {
        sender: "PM",
        recipient: "OPS",
        subject: "状态查询",
        body: "只读查询当前状态并汇总，不做实现",
      },
    });
    assert.equal(result.allowed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orphan fallback task resolves Python-list root reference and stops when root is archived", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-pm-orphan-gate-"));
  try {
    const ledger = join(root, "fcop", "ledger");
    await mkdir(ledger, { recursive: true });
    const rootTask = {
      task_id: "TASK-20260712-908",
      filename: "TASK-20260712-908-ADMIN-to-PM.md",
      sender: "ADMIN",
      recipient: "PM",
      bucket: "archive",
      thread_key: "panel-task-908",
      yaml: { archive_mode: "force", task_type: "force_archive" },
    };
    await writeFile(join(ledger, "tasks.jsonl"), `${JSON.stringify(rootTask)}\n`, "utf-8");
    await writeFile(join(ledger, "reports.jsonl"), "", "utf-8");
    await writeFile(
      join(ledger, "threads.jsonl"),
      `${JSON.stringify({
        thread_key: "panel-task-908",
        root_task_id: "TASK-20260712-908",
        task_ids: ["TASK-20260712-908"],
        report_ids: [],
        pending_pm_review: [],
      })}\n`,
      "utf-8",
    );
    const parsed = {
      filepath: "TASK-20260713-002-PM-to-QA.md",
      filename: "TASK-20260713-002-PM-to-QA.md",
      sender: "PM",
      recipient: "QA",
      thread_key: "_orphan_TASK-20260712-908",
      frontmatter: {
        sender: "PM",
        recipient: "QA",
        thread_key: "_orphan_TASK-20260712-908",
        parent: "",
        references: "['TASK-20260712-908-ADMIN-to-PM', 'TASK-20260713-001-PM-to-DEV']",
      },
      body: "实现并验收产品 UI",
    } satisfies ParsedTask;
    const result = await guardLandedPmProductWorkerTask(root, parsed);
    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.equal(result.reason, "cancelled");
      assert.deepEqual(result.findings, ["root_task_closed"]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
