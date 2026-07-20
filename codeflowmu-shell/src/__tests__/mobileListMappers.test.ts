import assert from "node:assert/strict";
import { test } from "node:test";

import {
  slimMobileTask,
  titleFromReportDoc,
  titleFromTaskDoc,
} from "../mobile/mobileListMappers.ts";

test("slimMobileTask projects parent and parent_task_id from row", () => {
  const slim = slimMobileTask({
    filename: "TASK-20260618-002-ADMIN-to-PM.md",
    task_id: "TASK-20260618-002-ADMIN-to-PM",
    sender: "ADMIN",
    recipient: "PM",
    parent_task_id: "TASK-20260618-001-ADMIN-to-PM",
  });
  assert.equal(slim.parent, "TASK-20260618-001-ADMIN-to-PM");
  assert.equal(slim.parent_task_id, "TASK-20260618-001-ADMIN-to-PM");
});

test("slimMobileTask falls back to yaml.parent", () => {
  const slim = slimMobileTask({
    filename: "TASK-20260618-003-ADMIN-to-PM.md",
    yaml: { parent: "TASK-20260618-001-ADMIN-to-PM" },
  });
  assert.equal(slim.parent_task_id, "TASK-20260618-001-ADMIN-to-PM");
});

test("titleFromTaskDoc prefers subject then markdown heading", () => {
  assert.equal(
    titleFromTaskDoc({ subject: "应急调度台", body: "# Other" }),
    "应急调度台",
  );
  assert.equal(titleFromTaskDoc({ body: "# 城市应急物资调度台\n\n正文" }), "城市应急物资调度台");
});

test("titleFromReportDoc prefers subject then heading then status line", () => {
  assert.equal(
    titleFromReportDoc({ subject: "DEV 完成回执", body: "# ignore" }),
    "DEV 完成回执",
  );
  assert.equal(
    titleFromReportDoc({
      body: "## 状态\n\n[进行中] 已拆解并派发手机端 PWA 修复子任务。",
    }),
    "[进行中] 已拆解并派发手机端 PWA 修复子任务。",
  );
});

test("titleFromReportDoc extracts ## 结论 first line like REPORT-20260620-005", () => {
  const title = titleFromReportDoc({
    body:
      "## 结论\n\n**done** — 手机端 PWA **V1.0.45** 关联/标题/聊天换行修复已完成，A–F 验收项落地。",
  });
  assert.match(title, /^done — 手机端 PWA/);
  assert.ok(title.includes("关联/标题/聊天换行修复"));
});
