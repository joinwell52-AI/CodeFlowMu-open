import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifyProductTask,
  evaluateProductDeliveryGate,
  planningArtifactPath,
  recordPlanningLevelOverride,
  writePlanningArtifact,
  productBriefPath,
  PRODUCT_DESIGN_REQUIRED_SKILLS,
} from "../ProductDeliveryGovernance.ts";
import {
  recordPlanningSkillEvidence,
  recordSkillInvocation,
  skillInvocationJournalPath,
} from "../SkillInvocationJournal.ts";
import { appendFile } from "node:fs/promises";

const TASK_ID = "TASK-20260712-001";

function completeBrief(): string {
  return `---
task_id: ${TASK_ID}
pm: PM
status: ready
revision: 1
created_at: 2026-07-12T00:00:00+08:00
playbooks:
${PRODUCT_DESIGN_REQUIRED_SKILLS.map((skill) => `  - ${skill}`).join("\n")}
---
# Product Design Brief
## 产品目标
## 目标用户
## 使用场景
## 问题与价值
## 功能范围
## 明确不做什么
## 页面与信息架构
## 核心用户流程
## 交互规则
## 状态与异常场景
## 视觉方向
## 响应式要求
## 技术候选方案比较
## 数据方案
## 测试数据
## DEV / QA / OPS 交付计划
## QA 测试计划
## 验收标准
## 风险和依赖
`;
}

test("classifies Level 0-3 without over-planning", () => {
  const product = classifyProductTask("创建一个中文名言名句 Web 应用，包含 UI、交互和手机响应式布局");
  assert.equal(product.task_class, "product_delivery");
  assert.equal(product.product_design_required, true);
  assert.equal(product.qa_required, true);
  assert.equal(product.planning_level, 3);

  const patch = classifyProductTask("仅修改一个明确的按钮文案");
  assert.equal(patch.planning_level, 1);
  assert.equal(patch.product_design_required, true);
  assert.equal(patch.qa_required, false);

  assert.equal(classifyProductTask("为现有模块新增普通导出功能").planning_level, 2);
  assert.equal(classifyProductTask("查询当前运行状态，不做实现").planning_level, 0);
});

test("ADMIN override is scoped and audited in classification", () => {
  const result = classifyProductTask("修复 Web 应用", {
    task_class: "product_delivery",
    product_design_required: false,
    qa_required: false,
    override_by: "ADMIN",
    override_reason: "仅修改现有按钮文案",
  });
  assert.equal(result.product_design_required, false);
  assert.equal(result.qa_required, false);
  assert.equal(result.override_by, "ADMIN");
  assert.match(result.override_reason ?? "", /按钮文案/);
});

test("PM writes planning artifacts through the controlled Runtime writer", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-planning-writer-"));
  try {
    const body = completeBrief().replace(/^---[\s\S]*?---\r?\n/, "").trim();
    const first = await writePlanningArtifact({
      projectRoot: root,
      taskId: TASK_ID,
      planningLevel: 3,
      bodyMarkdown: body,
      status: "ready",
      callerRole: "PM-01",
      sessionId: "session-pm-writer-1",
    });
    assert.equal(first.path, productBriefPath(root, TASK_ID));
    assert.equal(first.revision, 1);
    const raw = await readFile(first.path, "utf8");
    assert.match(raw, new RegExp(`task_id: ${TASK_ID}`));
    assert.match(raw, /source: pm\.write_planning_artifact/);
    assert.match(raw, /status: ready/);

    const second = await writePlanningArtifact({
      projectRoot: root,
      taskId: TASK_ID,
      planningLevel: 3,
      bodyMarkdown: `${body}\n\n## 修订说明\n补充验收证据。`,
      status: "draft",
      callerRole: "PM-01",
      sessionId: "session-pm-writer-2",
    });
    assert.equal(second.revision, 2);
    assert.match(await readFile(second.path, "utf8"), /status: draft/);

    await assert.rejects(
      writePlanningArtifact({
        projectRoot: root,
        taskId: TASK_ID,
        planningLevel: 3,
        bodyMarkdown: "---\nstatus: ready\n---\n# forged",
        callerRole: "PM-01",
        sessionId: "session-pm-writer-3",
      }),
      /must not contain YAML frontmatter/,
    );
    await assert.rejects(
      writePlanningArtifact({
        projectRoot: root,
        taskId: TASK_ID,
        planningLevel: 3,
        bodyMarkdown: body,
        callerRole: "DEV-01",
        sessionId: "session-dev-writer-1",
      }),
      /PM-only/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brief is not ready without file and real per-task skill evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-product-gate-"));
  try {
    const input = {
      projectRoot: root,
      taskId: TASK_ID,
      taskBody: "创建一个中文 Web 应用，包含 UI 与响应式交互",
    };
    const missing = await evaluateProductDeliveryGate(input);
    assert.equal(missing.allowed, false);
    assert.deepEqual(missing.findings, ["product_brief_missing"]);

    const path = productBriefPath(root, TASK_ID);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, completeBrief(), "utf8");
    const forged = await evaluateProductDeliveryGate(input);
    assert.equal(forged.allowed, false);
    assert.match(forged.findings.join("\n"), /product_skills_missing/);

    for (const skillId of PRODUCT_DESIGN_REQUIRED_SKILLS) {
      await recordSkillInvocation(root, {
        skill_id: skillId,
        channel: "auto_inject",
        caller_role: "PM",
        task_id: TASK_ID,
        outcome: "ok",
        summary: "test evidence",
      });
    }
    const autoInjected = await evaluateProductDeliveryGate(input);
    assert.equal(autoInjected.allowed, false);

    for (const skillId of PRODUCT_DESIGN_REQUIRED_SKILLS) {
      await recordPlanningSkillEvidence(root, {
        skill_id: skillId,
        caller_role: "PM-01",
        task_id: TASK_ID,
        session_id: "session-pm-planning-1",
        input_context: "ADMIN 主任务、既有架构与目标用户约束",
        output_summary: `${skillId} 已应用到方案`,
        brief_section: "产品目标与交付计划",
        product_decisions: [`采用 ${skillId} 产出的范围决策`],
      });
    }
    const ready = await evaluateProductDeliveryGate(input);
    assert.equal(ready.allowed, true);
    assert.equal(ready.product_brief_ready, true);
    assert.deepEqual(ready.missing_skills, []);

    const issuesDir = join(root, "fcop", "issues");
    await mkdir(issuesDir, { recursive: true });
    await writeFile(
      join(issuesDir, "ISSUE-20260712-001-QA-to-PM.md"),
      `---\nstatus: open\nreferences:\n  - ${TASK_ID}\n---\n# Browser failure\n`,
      "utf8",
    );
    const blockedByIssue = await evaluateProductDeliveryGate(input);
    assert.equal(blockedByIssue.allowed, true);
    assert.deepEqual(blockedByIssue.open_issues, ["ISSUE-20260712-001-QA-to-PM.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hand-written JSONL cannot unlock planning gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-product-forged-"));
  try {
    const path = productBriefPath(root, TASK_ID);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, completeBrief(), "utf8");
    await mkdir(join(root, ".codeflowmu"), { recursive: true });
    for (const skillId of PRODUCT_DESIGN_REQUIRED_SKILLS) {
      await appendFile(
        skillInvocationJournalPath(root),
        `${JSON.stringify({
          invocation_id: `forged-${skillId}`,
          at: new Date().toISOString(),
          skill_id: skillId,
          channel: "mcp",
          caller_role: "PM-01",
          task_id: TASK_ID,
          session_id: "forged-session",
          outcome: "ok",
          summary: "forged",
          evidence_version: 1,
          evidence_source: "pm_runtime_control",
          triggered_by: "pm.record_planning_skill_evidence",
          input_context: "forged",
          output_summary: "forged",
          brief_section: "forged",
          product_decisions: ["forged"],
        })}\n`,
        "utf8",
      );
    }
    const status = await evaluateProductDeliveryGate({
      projectRoot: root,
      taskId: TASK_ID,
      taskBody: "创建新产品与移动端 PWA",
    });
    assert.equal(status.allowed, false);
    assert.equal(status.invalid_skill_evidence.length, PRODUCT_DESIGN_REQUIRED_SKILLS.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Level 1/2 use lightweight PLAN while Level 0 and historical tasks stay compatible", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-planning-levels-"));
  try {
    const level1Id = "TASK-20260712-101";
    const level1Path = planningArtifactPath(root, level1Id, 1);
    await mkdir(join(level1Path, ".."), { recursive: true });
    await writeFile(
      level1Path,
      `---\ntask_id: ${level1Id}\nstatus: ready\nrevision: 1\n---\n# Level 1\n## 问题现象\n## 根因或待验证假设\n## 修改范围\n## 风险\n## 回归测试\n`,
      "utf8",
    );
    const level1 = await evaluateProductDeliveryGate({
      projectRoot: root,
      taskId: level1Id,
      taskBody: "修复单点兼容性问题",
    });
    assert.equal(level1.planning_level, 1);
    assert.equal(level1.allowed, true);
    assert.deepEqual(level1.required_skills, []);

    const level2Id = "TASK-20260712-102";
    const level2Path = planningArtifactPath(root, level2Id, 2);
    await writeFile(
      level2Path,
      `---\ntask_id: ${level2Id}\nstatus: ready\nrevision: 1\n---\n# Level 2\n## 目标\n## 范围\n## 技术方案\n## 影响面\n## 验收标准\n## 测试数据\n## 交付顺序\n`,
      "utf8",
    );
    const level2 = await evaluateProductDeliveryGate({
      projectRoot: root,
      taskId: level2Id,
      taskBody: "新增普通 API 功能并调整数据结构",
    });
    assert.equal(level2.planning_level, 2);
    assert.equal(level2.allowed, true);

    const level0 = await evaluateProductDeliveryGate({
      projectRoot: root,
      taskId: "TASK-20260712-103",
      taskBody: "巡检并汇总当前状态，不做实现",
    });
    assert.equal(level0.planning_status, "not_required");
    assert.equal(level0.allowed, true);

    const historical = await evaluateProductDeliveryGate({
      projectRoot: root,
      taskId: "TASK-20260101-001",
      taskBody: "创建一个新产品移动端 PWA",
    });
    assert.equal(historical.planning_status, "legacy_compatible");
    assert.equal(historical.allowed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ADMIN planning-level override is persisted and visible to classification", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-planning-override-"));
  try {
    const taskId = "TASK-20260712-777";
    await recordPlanningLevelOverride({
      projectRoot: root,
      taskId,
      planningLevel: 0,
      reason: "仅做紧急止损，不创建实现任务",
    });
    const status = await evaluateProductDeliveryGate({
      projectRoot: root,
      taskId,
      taskBody: "创建一个新移动端 PWA 产品",
    });
    assert.equal(status.planning_level, 0);
    assert.equal(status.classification.override_by, "ADMIN");
    assert.match(status.classification.classification_reason, /紧急止损/);
    assert.equal(status.allowed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
