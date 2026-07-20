import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canDispatchQA, qaGateToDispatchSkipReason } from "../qaDispatchGate.ts";
import { pmEvaluate } from "../pmEvaluate.ts";
import { evaluateDispatchEligibility } from "../taskDispatchGate.ts";
import {
  extractArtifactPathFromTaskContent,
  type ExecutionGateContext,
} from "../taskDispatchContext.ts";
import type {
  DispatchGateReportRef,
  DispatchGateTaskRef,
} from "../taskDispatchGate.ts";

const THREAD = "panel-task-111";

function task(
  recipient: string,
  overrides: Partial<DispatchGateTaskRef> = {},
): DispatchGateTaskRef {
  const taskId = overrides.taskId ?? `TASK-20260610-001-PM-to-${recipient}`;
  return {
    taskId,
    filename: overrides.filename ?? `${taskId}.md`,
    recipient,
    threadKey: THREAD,
    lifecycleBucket: "inbox",
    fmState: "inbox",
    ...overrides,
  };
}

function report(
  reporter: string,
  status = "done",
  taskId?: string,
): DispatchGateReportRef {
  const id = taskId ?? `TASK-20260610-010-PM-to-${reporter}`;
  return { taskId: id, reporter, status, threadKey: THREAD };
}

function ctx(
  tasks: DispatchGateTaskRef[],
  reports: DispatchGateReportRef[],
  meta: Record<string, { artifactPath?: string; cancelled?: boolean; supersededBy?: string }> = {},
): ExecutionGateContext {
  const taskMeta = new Map(
    Object.entries(meta).map(([id, m]) => [id, { ...m }]),
  );
  return {
    tasks,
    reports,
    taskMeta,
    projectRoot: "/proj",
    artifactExists: (rel) => rel === "out/ok.txt",
  };
}

describe("canDispatchQA", () => {
  it("preserves file extensions in backticked workspace artifacts", () => {
    const raw = [
      "---",
      "state: inbox",
      "---",
      "Check `workspace/open-v110-smoke/index.html` before approval.",
    ].join("\n");
    assert.equal(
      extractArtifactPathFromTaskContent(raw),
      "workspace/open-v110-smoke/index.html",
    );
  });

  it("allows QA when DEV report done and artifact exists", () => {
    const dev = task("DEV", { lifecycleBucket: "done", taskId: "TASK-1" });
    const qa = task("QA", { taskId: "TASK-2" });
    const thread = [dev, qa];
    const gateCtx = ctx(
      thread,
      [report("DEV", "done", "TASK-1")],
      { "TASK-1": { artifactPath: "out/ok.txt" } },
    );
    const result = canDispatchQA(qa, gateCtx, thread);
    assert.equal(result.allowed, true);
    assert.equal(result.reason, undefined);
    assert.equal(result.execution_state, "runnable");
  });

  it("allows QA when artifact path includes workspace/project prefix", () => {
    const dev = task("DEV", { lifecycleBucket: "done", taskId: "TASK-1" });
    const qa = task("QA", { taskId: "TASK-2" });
    const thread = [dev, qa];
    const gateCtx = {
      ...ctx(thread, [report("DEV", "done", "TASK-1")], {
        "TASK-1": { artifactPath: "workspace/newproject/smoke-tetris-12" },
      }),
      projectRoot: "/apps/CodeFlowMu-open/workspace/newproject",
      artifactExists: (rel: string) => rel === "smoke-tetris-12",
    };
    const result = canDispatchQA(qa, gateCtx, thread);
    assert.equal(result.allowed, true);
    assert.equal(result.execution_state, "runnable");
  });

  it("allows QA when DEV done and thread has no artifact path", () => {
    const dev = task("DEV", { lifecycleBucket: "done", taskId: "TASK-1" });
    const qa = task("QA", { taskId: "TASK-2" });
    const thread = [dev, qa];
    const gateCtx = ctx(thread, [report("DEV", "done", "TASK-1")]);
    const result = canDispatchQA(qa, gateCtx, thread);
    assert.equal(result.allowed, true);
    assert.equal(result.execution_state, "runnable");
  });

  it("blocks QA when DEV report pending", () => {
    const dev = task("DEV", { lifecycleBucket: "active", taskId: "TASK-1" });
    const qa = task("QA", { taskId: "TASK-2", dependsOn: ["TASK-1"] });
    const thread = [dev, qa];
    const gateCtx = ctx(thread, [], { "TASK-1": { artifactPath: "out/ok.txt" } });
    const result = canDispatchQA(qa, gateCtx, thread);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "dev_report_pending");
    assert.equal(result.waiting_on, "TASK-1");
    assert.equal(qaGateToDispatchSkipReason(result.reason), "waiting_dependency");
  });

  it("E: inbox auto-dispatch and PM wake agree on the same rework dependency", () => {
    const oldDev = task("DEV", {
      taskId: "TASK-20260712-001-PM-to-DEV",
      lifecycleBucket: "done",
    });
    const currentDev = task("DEV", {
      taskId: "TASK-20260712-003-PM-to-DEV",
      lifecycleBucket: "active",
    });
    const qa = task("QA", {
      taskId: "TASK-20260712-004-PM-to-QA",
      dependsOn: [currentDev.taskId],
    });
    const tasks = [oldDev, currentDev, qa];
    const gateCtx = ctx(tasks, [report("DEV", "done", oldDev.taskId)]);

    const inboxDecision = evaluateDispatchEligibility(qa, tasks, gateCtx.reports);
    const qaDecision = canDispatchQA(qa, gateCtx, tasks);
    const pmWakeDecision = pmEvaluate(qa, gateCtx, tasks);

    assert.equal(inboxDecision.allowed, false);
    assert.equal(inboxDecision.reason, "waiting_dependency");
    assert.equal(qaDecision.allowed, false);
    assert.equal(qaDecision.execution_state, "waiting_dependency");
    assert.equal(pmWakeDecision.action, "WAKE_DEV");
    assert.equal(pmWakeDecision.execution_state, "waiting_dependency");
  });

  it("blocks QA when artifact missing", () => {
    const dev = task("DEV", { lifecycleBucket: "done", taskId: "TASK-1" });
    const qa = task("QA", { taskId: "TASK-2", dependsOn: ["TASK-1"] });
    const thread = [dev, qa];
    const gateCtx = ctx(
      thread,
      [report("DEV", "done", "TASK-1")],
      { "TASK-1": { artifactPath: "missing.txt" } },
    );
    const result = canDispatchQA(qa, gateCtx, thread);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "artifact_missing");
    assert.equal(qaGateToDispatchSkipReason(result.reason), "execution_blocked");
  });

  it("blocks QA when task cancelled", () => {
    const qa = task("QA", { displayStatus: "cancelled" });
    const gateCtx = ctx(
      [qa],
      [],
      { "TASK-20260610-001-PM-to-QA": { cancelled: true } },
    );
    const result = canDispatchQA(qa, gateCtx);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "cancelled");
    assert.equal(qaGateToDispatchSkipReason(result.reason), "cancelled");
  });

  it("blocks QA when task superseded", () => {
    const qa = task("QA", { taskId: "TASK-OLD" });
    const gateCtx = ctx([qa], [], { "TASK-OLD": { supersededBy: "TASK-NEW" } });
    const result = canDispatchQA(qa, gateCtx);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "superseded");
    assert.equal(qaGateToDispatchSkipReason(result.reason), "superseded");
  });

  it("blocks non-QA task with not_qa_task", () => {
    const dev = task("DEV");
    const gateCtx = ctx([dev], []);
    const result = canDispatchQA(dev, gateCtx);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "not_qa_task");
  });
});
