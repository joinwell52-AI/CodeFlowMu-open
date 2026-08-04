import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LONG_HORIZON_SKILL_ID,
  classifyLongHorizonPlanning,
  persistPlanningValidation,
  readPlanningValidation,
  sha256Digest,
  validateLongHorizonPlan,
} from "../LongHorizonPlanning.ts";
import {
  currentPlanningGateState,
  decidePlanningGate,
  submitPlanningGate,
} from "../PlanningGateStore.ts";
import {
  PRODUCT_DESIGN_REQUIRED_SKILLS,
  evaluateProductDeliveryGate,
  writePlanningArtifact,
} from "../ProductDeliveryGovernance.ts";
import { recordPlanningSkillEvidence } from "../SkillInvocationJournal.ts";
import { authorizePlanningRuntimeIdentity } from "../PlanningRuntimeIdentity.ts";
import { SessionStore } from "../../session/SessionStore.ts";

const TASK_ID = "TASK-20260803-900";
const THREAD_KEY = "planning-thread-900";

function taskbookText(): string {
  return [
    "# Scope",
    "Must preserve task execution context",
    ...Array.from({ length: 298 }, (_, i) => `reference line ${i + 3}`),
  ].join("\n");
}

async function planningAuthority(root: string, sessionId: string) {
  const store = new SessionStore({ dir: join(root, ".codeflowmu", "state", "sessions") });
  await store.save({
    protocol: {
      session_id: sessionId,
      agent_id: "PM-01",
      task_id: TASK_ID,
      started_at: new Date().toISOString(),
      status: "running",
      runs: [],
    },
    runtime_root_task_id: TASK_ID,
    runtime_thread_key: THREAD_KEY,
  });
  return authorizePlanningRuntimeIdentity({
    sessionStore: store,
    projectRoot: root,
    sessionId,
    callerRole: "PM-01",
    taskId: TASK_ID,
    threadKey: THREAD_KEY,
  });
}

function completeBody(): string {
  return `# Product Brief
## 产品目标
## 目标用户
## 问题与价值
## 功能范围
## 明确不做什么
## 用户流程
## 信息架构
## 交互规则
## 视觉与响应式
## 技术候选方案比较
## 数据方案
## 测试数据
## QA 验收方法
## 风险与依赖
## DEV / QA / OPS 交付计划
## 验收标准
## 总体规划
## WP 任务树
## 依赖矩阵
## 日程与 Gate
## 测试与实验计划
## 风险登记
## 恢复与回滚计划
## 规划状态与变更记录
## Requirement Coverage Appendix
## Validation Summary
`;
}

function planningIr(body: string, now: Date): Record<string, unknown> {
  const sourceDigest = sha256Digest(taskbookText());
  return {
    source: {
      path: "D:/taskbook.md",
      version: "v1",
      digest: sourceDigest,
      line_count: 300,
      read_at: now.toISOString(),
      read_complete: true,
      read_ranges: ["1-300"],
      references: ["D:/taskbook.md"],
    },
    requirements: [{
      id: "REQ-0001",
      modality: "MUST",
      coverage_status: "covered",
      brief_section: "总体规划",
      responsible_role: "DEV",
      acceptor: "PM",
      wp_ids: ["WP-00"],
      gate_ids: ["Gate-A"],
      tests: ["unit"],
      evidence: ["test-log"],
      source_line: "2",
      source_section: "Scope",
      source_text: "Must preserve task execution context",
    }],
    findings: [],
    facts: [{ fact_id: "FACT-0001", observed_at: now.toISOString(), source: "runtime" }],
    work_packages: [{
      id: "WP-00",
      title: "Freeze contracts",
      recipient: "DEV",
      parent: TASK_ID,
      dependencies: [],
      inputs: ["taskbook"],
      outputs: ["contracts"],
      allowed_files: ["packages/**"],
      forbidden_files: ["fcop/**"],
      tests: ["unit"],
      evidence: ["test-log"],
      acceptor: "PM",
      budget: { ai_days_low: 1, ai_days_high: 2, tokens: 10_000, tool_calls: 20 },
      max_rework: 1,
      failure_conditions: ["tests fail"],
      rollback: ["revert patch"],
      start_at: "2026-08-04T09:00:00+08:00",
      end_at: "2026-08-05T18:00:00+08:00",
      parallel_with: [],
      parallel_reason: "none",
      includes_admin_wait: false,
    }],
    gates: [{ id: "Gate-A", prerequisites: ["WP-00"], evidence: ["test-log"], failure_action: "rework" }],
    budget: { ai_days_low: 1, ai_days_high: 2, tokens: 10_000, tool_calls: 20 },
    schedule: {
      t0: "2026-08-04T09:00:00+08:00",
      timezone: "Asia/Shanghai",
      d7_health_check_at: "2026-08-10T18:00:00+08:00",
      d10_disposition_at: "2026-08-13T18:00:00+08:00",
      delay_threshold: "0.5 AI day",
      reschedule_rule: "recompute DAG",
    },
    experiment_data_plan: { applicable: false, rationale: "not research" },
    recovery_plan: { preservation_steps: ["git status"], continuity_cases: ["runtime restart"] },
    stop_conditions: ["digest mismatch"],
    body_markdown: body,
  };
}

test("long-horizon trigger is deterministic and does not catch an ordinary UI task", () => {
  assert.equal(classifyLongHorizonPlanning("ordinary UI page", {}, 3).required, false);
  assert.equal(classifyLongHorizonPlanning("anything", { planning_method: "long_horizon" }, 1).required, true);
  assert.equal(
    classifyLongHorizonPlanning("跨模块架构重构，包含 WP 任务树、Gate 人工决策和恢复回滚", {}, 3).required,
    true,
  );
  assert.equal(
    classifyLongHorizonPlanning("跨模块架构重构，包含 WP、Gate 与恢复", { long_horizon_required: false, override_by: "ADMIN", override_reason: "normal plan" }, 3).required,
    false,
  );
});

test("validator blocks current-state contradictions and false source citations", () => {
  const now = new Date("2026-08-04T09:00:00+08:00");
  const body = `${completeBody()}\nPlanning Gate is pending.\nPlanning Gate is approved.\nT0: 2026-08-04T09:00:00+08:00\nT0: 2026-08-05T09:00:00+08:00\ncandidate clean\ncandidate dirty\ndispatch open\ndispatch closed\ncurrent waiting ADMIN\ncurrent executing implementation started\n`;
  const ir = planningIr(body, now);
  const sourceDigest = String((ir["source"] as Record<string, unknown>)["digest"]);
  const result = validateLongHorizonPlan({
    taskId: TASK_ID,
    rootTaskId: TASK_ID,
    threadKey: THREAD_KEY,
    sessionId: "session-pm-conflict",
    sourceDigest,
    observedSourceDigest: sourceDigest,
    observedSourceLineCount: 300,
    observedSourceText: taskbookText(),
    bodyMarkdown: body,
    planningIr: ir,
    factSnapshotAt: now.toISOString(),
    now,
  });
  assert.equal(result.ready_for_review, false);
  assert.ok(result.blocking_findings.filter((row) => row.code === "PB.BODY.STATE_CONFLICT").length >= 4);
  assert.ok(result.blocking_findings.some((row) => row.code === "PB.BODY.T0_CONFLICT"));

  const falseCitation = planningIr(completeBody(), now);
  (falseCitation["requirements"] as Array<Record<string, unknown>>)[0]!["source_text"] = "not present on line two";
  const sourceMismatch = validateLongHorizonPlan({
    taskId: TASK_ID,
    rootTaskId: TASK_ID,
    threadKey: THREAD_KEY,
    sessionId: "session-pm-source",
    sourceDigest,
    observedSourceDigest: sourceDigest,
    observedSourceLineCount: 300,
    observedSourceText: taskbookText(),
    bodyMarkdown: completeBody(),
    planningIr: falseCitation,
    factSnapshotAt: now.toISOString(),
    now,
  });
  assert.ok(sourceMismatch.blocking_findings.some((row) => row.code === "PB.SOURCE.REFERENCE_MISMATCH"));
});

test("validation, atomic revision history, and Planning Gate keep separate states", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-long-horizon-"));
  try {
    const now = new Date("2026-08-03T20:00:00+08:00");
    const body = completeBody();
    const ir = planningIr(body, now);
    const sourceDigest = String((ir["source"] as Record<string, unknown>)["digest"]);
    const validation = validateLongHorizonPlan({
      taskId: TASK_ID,
      rootTaskId: TASK_ID,
      threadKey: THREAD_KEY,
      sessionId: "session-pm-900",
      sourceDigest,
      observedSourceDigest: sourceDigest,
      observedSourceLineCount: 300,
      observedSourceText: taskbookText(),
      bodyMarkdown: body,
      planningIr: ir,
      factSnapshotAt: now.toISOString(),
      now,
    });
    assert.equal(validation.ready_for_review, true);
    const tamperedSource = validateLongHorizonPlan({
      taskId: TASK_ID,
      rootTaskId: TASK_ID,
      threadKey: THREAD_KEY,
      sessionId: "session-pm-900",
      sourceDigest,
      observedSourceDigest: sha256Digest("tampered-source"),
      observedSourceLineCount: 300,
      observedSourceText: taskbookText(),
      bodyMarkdown: body,
      planningIr: ir,
      factSnapshotAt: now.toISOString(),
      now,
    });
    assert.equal(tamperedSource.ready_for_review, false);
    assert.ok(tamperedSource.blocking_findings.some((row) => row.code === "PB.SOURCE.DIGEST_MISMATCH"));
    await persistPlanningValidation(root, validation);
    assert.equal((await readPlanningValidation(root, TASK_ID))?.validation_digest, validation.validation_digest);

    const authority = await planningAuthority(root, "session-pm-900");
    const artifact = await writePlanningArtifact({
      projectRoot: root,
      taskId: TASK_ID,
      rootTaskId: TASK_ID,
      threadKey: THREAD_KEY,
      planningLevel: 3,
      bodyMarkdown: body,
      status: "ready_for_review",
      callerRole: "PM-01",
      sessionId: "session-pm-900",
      sourceDigest,
      validationDigest: validation.validation_digest,
      validationPassed: true,
      longHorizon: true,
      authority,
    });
    assert.equal(artifact.revision, 1);
    assert.equal(artifact.body_digest, validation.body_digest);

    const second = await writePlanningArtifact({
      projectRoot: root,
      taskId: TASK_ID,
      rootTaskId: TASK_ID,
      threadKey: THREAD_KEY,
      planningLevel: 3,
      bodyMarkdown: `${body}\n## 修订补充\n完整。`,
      status: "draft",
      callerRole: "PM-01",
      sessionId: "session-pm-900",
      longHorizon: true,
      authority,
    });
    assert.equal(second.revision, 2);
    assert.ok(second.history_path);
    assert.match(await readFile(second.history_path!, "utf8"), /history_status: superseded_non_authoritative/);

    const submission = await submitPlanningGate({
      projectRoot: root,
      taskId: TASK_ID,
      threadKey: THREAD_KEY,
      revision: artifact.revision,
      bodyDigest: artifact.body_digest,
      validationDigest: validation.validation_digest,
      sourceDigest,
      submittedBy: "PM-01",
      now,
    });
    const stale = await currentPlanningGateState(root, TASK_ID, { revision: second.revision, body_digest: second.body_digest, validation_digest: "" });
    assert.equal(stale.status, "stale");
    await assert.rejects(
      decidePlanningGate({
        projectRoot: root,
        taskId: TASK_ID,
        threadKey: THREAD_KEY,
        revision: second.revision,
        bodyDigest: second.body_digest,
        validationDigest: validation.validation_digest,
        decision: "approve_wp00",
        reason: "wrong revision",
      }),
      /missing or stale/,
    );
    assert.equal(submission.record_type, "submission");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dispatch opens only after matching semantic validation and ADMIN approve_wp00", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-long-gate-"));
  try {
    const now = new Date();
    const body = completeBody();
    const ir = planningIr(body, now);
    const sourceDigest = String((ir["source"] as Record<string, unknown>)["digest"]);
    const validation = validateLongHorizonPlan({
      taskId: TASK_ID, rootTaskId: TASK_ID, threadKey: THREAD_KEY, sessionId: "session-pm-901",
      sourceDigest, observedSourceDigest: sourceDigest, observedSourceLineCount: 300,
      observedSourceText: taskbookText(),
      bodyMarkdown: body, planningIr: ir, factSnapshotAt: now.toISOString(), now,
    });
    await persistPlanningValidation(root, validation);
    const authority = await planningAuthority(root, "session-pm-901");
    const artifact = await writePlanningArtifact({
      projectRoot: root, taskId: TASK_ID, rootTaskId: TASK_ID, threadKey: THREAD_KEY,
      planningLevel: 3, bodyMarkdown: body, status: "ready_for_review", callerRole: "PM-01",
      sessionId: "session-pm-901", sourceDigest, validationDigest: validation.validation_digest,
      validationPassed: true, longHorizon: true,
      authority,
    });
    const required = [...PRODUCT_DESIGN_REQUIRED_SKILLS, LONG_HORIZON_SKILL_ID];
    for (const skillId of required) {
      await recordPlanningSkillEvidence(root, {
        skill_id: skillId,
        caller_role: "PM-01",
        task_id: TASK_ID,
        session_id: "session-pm-901",
        input_context: "complete taskbook and live facts",
        output_summary: `${skillId} applied`,
        brief_section: "总体规划",
        product_decisions: [`decision from ${skillId}`],
        thread_key: THREAD_KEY,
        authority,
      });
    }
    const gateInput = {
      projectRoot: root,
      taskId: TASK_ID,
      taskBody: "长期跨模块架构重构，包含 WP 任务树、Gate、恢复回滚和实验数据",
      taskFrontmatter: { planning_method: "long_horizon", thread_key: THREAD_KEY },
    };
    const before = await evaluateProductDeliveryGate(gateInput);
    assert.equal(before.product_brief_ready, true);
    assert.equal(before.validation_status, "passed");
    assert.equal(before.dispatch_open, false);
    assert.equal(before.planning_gate_status, "not_submitted");

    await submitPlanningGate({
      projectRoot: root, taskId: TASK_ID, threadKey: THREAD_KEY, revision: artifact.revision,
      bodyDigest: artifact.body_digest, validationDigest: validation.validation_digest,
      sourceDigest, submittedBy: "PM-01",
    });
    await decidePlanningGate({
      projectRoot: root, taskId: TASK_ID, threadKey: THREAD_KEY, revision: artifact.revision,
      bodyDigest: artifact.body_digest, validationDigest: validation.validation_digest,
      decision: "approve_wp00", reason: "validated plan accepted",
    });
    const after = await evaluateProductDeliveryGate(gateInput);
    assert.equal(after.dispatch_open, true);
    assert.equal(after.planning_gate_status, "approved");
    assert.equal(after.dispatch_scope, "wp00_only");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
