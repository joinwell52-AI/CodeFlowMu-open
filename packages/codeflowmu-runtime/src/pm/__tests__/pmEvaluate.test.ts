import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pmEvaluate } from "../pmEvaluate.ts";
import type { ExecutionGateContext } from "../taskDispatchContext.ts";
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

describe("pmEvaluate", () => {
  it("returns OK when QA report done", () => {
    const dev = task("DEV", { lifecycleBucket: "done", taskId: "TASK-1" });
    const qa = task("QA", { taskId: "TASK-2", dependsOn: ["TASK-1"] });
    const thread = [dev, qa];
    const gateCtx = ctx(
      thread,
      [
        report("DEV", "done", "TASK-1"),
        report("QA", "done", "TASK-2"),
      ],
      { "TASK-1": { artifactPath: "out/ok.txt" } },
    );
    assert.equal(pmEvaluate(qa, gateCtx, thread).action, "OK");
  });

  it("returns WAKE_DEV when DEV not settled", () => {
    const dev = task("DEV", { lifecycleBucket: "active", taskId: "TASK-1" });
    const qa = task("QA", { taskId: "TASK-2", dependsOn: ["TASK-1"] });
    const thread = [dev, qa];
    const gateCtx = ctx(thread, [], { "TASK-1": { artifactPath: "out/ok.txt" } });
    assert.equal(pmEvaluate(qa, gateCtx, thread).action, "WAKE_DEV");
  });

  it("returns WAIT when task superseded", () => {
    const qa = task("QA", { taskId: "TASK-OLD" });
    const gateCtx = ctx([qa], [], { "TASK-OLD": { supersededBy: "TASK-NEW" } });
    assert.equal(pmEvaluate(qa, gateCtx).action, "WAIT");
  });

  it("returns WAIT when task cancelled", () => {
    const qa = task("QA", { displayStatus: "cancelled" });
    const gateCtx = ctx(
      [qa],
      [],
      { "TASK-20260610-001-PM-to-QA": { cancelled: true } },
    );
    assert.equal(pmEvaluate(qa, gateCtx).action, "WAIT");
  });

  it("returns ESCALATE_ADMIN when display_status indicates qa_fail", () => {
    const dev = task("DEV", { lifecycleBucket: "done", taskId: "TASK-1" });
    const qa = task("QA", {
      taskId: "TASK-2",
      displayStatus: "qa_fail",
    });
    const thread = [dev, qa];
    const gateCtx = ctx(
      thread,
      [report("DEV", "done", "TASK-1")],
      { "TASK-1": { artifactPath: "out/ok.txt" } },
    );
    assert.equal(pmEvaluate(qa, gateCtx, thread).action, "ESCALATE_ADMIN");
  });

  it("returns RETRY_QA when QA runnable in inbox", () => {
    const dev = task("DEV", { lifecycleBucket: "done", taskId: "TASK-1" });
    const qa = task("QA", { taskId: "TASK-2", lifecycleBucket: "inbox" });
    const thread = [dev, qa];
    const gateCtx = ctx(
      thread,
      [report("DEV", "done", "TASK-1")],
      { "TASK-1": { artifactPath: "out/ok.txt" } },
    );
    assert.equal(pmEvaluate(qa, gateCtx, thread).action, "RETRY_QA");
  });

  it("returns RETRY_QA when no artifact path declared on thread", () => {
    const dev = task("DEV", { lifecycleBucket: "done", taskId: "TASK-1" });
    const qa = task("QA", { taskId: "TASK-2", lifecycleBucket: "inbox" });
    const thread = [dev, qa];
    const gateCtx = ctx(thread, [report("DEV", "done", "TASK-1")]);
    assert.equal(pmEvaluate(qa, gateCtx, thread).action, "RETRY_QA");
  });

  it("returns RESOLVE_BLOCKED for a formal worker blocked report", () => {
    const ops = task("OPS", {
      taskId: "TASK-OPS-BLOCKED",
      lifecycleBucket: "active",
      fmState: "active",
      displayStatus: "worker_report_blocked",
    });
    assert.equal(pmEvaluate(ops, ctx([ops], []), [ops]).action, "RESOLVE_BLOCKED");
  });

  it("keeps a completed QA rework terminal even when an older QA round was rejected", () => {
    const oldQa = task("QA", {
      taskId: "TASK-20260712-906-PM-to-QA",
      lifecycleBucket: "active",
      fmState: "active",
      displayStatus: "waiting_rework",
    });
    const completedQa = task("QA", {
      taskId: "TASK-20260712-002-PM-to-QA-rework-2",
      lifecycleBucket: "done",
      fmState: "done",
      displayStatus: "done",
    });
    const thread = [oldQa, completedQa];
    const result = pmEvaluate(completedQa, ctx(thread, []), thread);
    assert.equal(result.action, "OK");
    assert.equal(result.execution_state, "completed");
  });

  it("matches a QA report to the current rework task instead of the first QA task", () => {
    const oldQa = task("QA", { taskId: "TASK-OLD", lifecycleBucket: "active" });
    const currentQa = task("QA", { taskId: "TASK-NEW", lifecycleBucket: "inbox" });
    const thread = [oldQa, currentQa];
    const result = pmEvaluate(
      currentQa,
      ctx(thread, [report("QA", "done", "TASK-NEW")]),
      thread,
    );
    assert.equal(result.action, "OK");
  });
});
