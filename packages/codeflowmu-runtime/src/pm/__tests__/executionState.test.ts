import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveExecutionState } from "../executionState.ts";
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

describe("resolveExecutionState", () => {
  it("QA with settled DEV report and artifact is runnable", () => {
    const dev = task("DEV", { lifecycleBucket: "done", taskId: "TASK-1" });
    const qa = task("QA", { taskId: "TASK-2" });
    const thread = [dev, qa];
    const gateCtx = ctx(
      thread,
      [report("DEV", "done", "TASK-1")],
      { "TASK-1": { artifactPath: "out/ok.txt" } },
    );
    assert.equal(resolveExecutionState(qa, gateCtx, thread), "runnable");
  });

  it("QA with DEV done and no artifact path is runnable", () => {
    const dev = task("DEV", { lifecycleBucket: "done", taskId: "TASK-1" });
    const qa = task("QA", { taskId: "TASK-2" });
    const thread = [dev, qa];
    const gateCtx = ctx(thread, [report("DEV", "done", "TASK-1")]);
    assert.equal(resolveExecutionState(qa, gateCtx, thread), "runnable");
  });

  it("QA without DEV done report is waiting_dependency", () => {
    const dev = task("DEV", { lifecycleBucket: "active", taskId: "TASK-1" });
    const qa = task("QA", { taskId: "TASK-2", dependsOn: ["TASK-1"] });
    const thread = [dev, qa];
    const gateCtx = ctx(thread, [], { "TASK-1": { artifactPath: "out/ok.txt" } });
    assert.equal(resolveExecutionState(qa, gateCtx, thread), "waiting_dependency");
  });

  it("QA with DEV done but missing artifact is blocked", () => {
    const dev = task("DEV", { lifecycleBucket: "done", taskId: "TASK-1" });
    const qa = task("QA", { taskId: "TASK-2", dependsOn: ["TASK-1"] });
    const thread = [dev, qa];
    const gateCtx = ctx(
      thread,
      [report("DEV", "done", "TASK-1")],
      { "TASK-1": { artifactPath: "missing.txt" } },
    );
    assert.equal(resolveExecutionState(qa, gateCtx, thread), "blocked");
  });

  it("cancelled task is blocked", () => {
    const qa = task("QA", { displayStatus: "cancelled" });
    const gateCtx = ctx([qa], [], { "TASK-20260610-001-PM-to-QA": { cancelled: true } });
    assert.equal(resolveExecutionState(qa, gateCtx), "blocked");
  });

  it("superseded task is superseded", () => {
    const qa = task("QA", { taskId: "TASK-OLD" });
    const gateCtx = ctx([qa], [], { "TASK-OLD": { supersededBy: "TASK-NEW" } });
    assert.equal(resolveExecutionState(qa, gateCtx), "superseded");
  });
});
