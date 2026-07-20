import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateDispatchEligibility,
  isTaskRunnableForWake,
  isTrustedInternalDispatch,
  prerequisiteWorkerRoles,
  requiresExplicitDispatch,
  resolveExplicitDispatchHoldReason,
  type DispatchGateReportRef,
  type DispatchGateTaskRef,
} from "../taskDispatchGate.ts";

function task(
  overrides: Partial<DispatchGateTaskRef> & Pick<DispatchGateTaskRef, "recipient">,
): DispatchGateTaskRef {
  const recipient = overrides.recipient;
  return {
    ...overrides,
    taskId: overrides.taskId ?? `TASK-20260610-001-PM-to-${recipient}`,
    filename:
      overrides.filename ?? `TASK-20260610-001-PM-to-${recipient}.md`,
    recipient,
    threadKey: overrides.threadKey ?? "panel-task-111",
    lifecycleBucket: overrides.lifecycleBucket ?? "inbox",
    fmState: overrides.fmState ?? "inbox",
  };
}

function report(
  reporter: string,
  status = "done",
  threadKey = "panel-task-111",
  taskId = `TASK-20260610-001-PM-to-${reporter}`,
): DispatchGateReportRef {
  return {
    taskId,
    reporter,
    status,
    threadKey,
  };
}

describe("taskDispatchGate", () => {
  it("prerequisite chain DEV→QA→EVAL", () => {
    assert.deepEqual(prerequisiteWorkerRoles("DEV"), []);
    assert.deepEqual(prerequisiteWorkerRoles("QA"), []);
    assert.deepEqual(prerequisiteWorkerRoles("EVAL"), []);
    assert.deepEqual(prerequisiteWorkerRoles("PM"), []);
  });

  it("PM prewrites DEV+QA+EVAL — only DEV may dispatch", () => {
    const thread = "panel-task-111";
    const tasks = [
      task({ recipient: "DEV", taskId: "TASK-1" }),
      task({ recipient: "QA", taskId: "TASK-2" }),
      task({ recipient: "EVAL", taskId: "TASK-3" }),
    ].map((t) => ({ ...t, threadKey: thread }));

    const devGate = evaluateDispatchEligibility(tasks[0]!, tasks, []);
    assert.equal(devGate.allowed, true);

    const qaGate = evaluateDispatchEligibility(tasks[1]!, tasks, []);
    assert.equal(qaGate.allowed, true);

    const evalGate = evaluateDispatchEligibility(tasks[2]!, tasks, []);
    assert.equal(evalGate.allowed, true);
  });

  it("DEV done report unlocks QA dispatch", () => {
    const thread = "panel-task-111";
    const tasks = [
      task({
        recipient: "DEV",
        taskId: "TASK-20260610-001-PM-to-DEV",
        lifecycleBucket: "done",
      }),
      task({
        recipient: "QA",
        taskId: "TASK-20260610-002-PM-to-QA",
        dependsOn: ["TASK-20260610-001-PM-to-DEV"],
      }),
      task({
        recipient: "EVAL",
        taskId: "TASK-20260610-003-PM-to-EVAL",
        dependsOn: ["TASK-20260610-002-PM-to-QA"],
      }),
    ].map((t) => ({ ...t, threadKey: thread }));
    const reports = [report("DEV", "done", thread)];

    const qaGate = evaluateDispatchEligibility(tasks[1]!, tasks, reports);
    assert.equal(qaGate.allowed, true);

    const evalGate = evaluateDispatchEligibility(tasks[2]!, tasks, reports);
    assert.equal(evalGate.allowed, false);
    assert.equal(evalGate.waitingOn, "TASK-20260610-002");
  });

  it("C/D: old DEV report cannot release rework QA until the current DEV reports done", () => {
    const thread = "panel-task-rework";
    const oldDev = task({
      recipient: "DEV",
      taskId: "TASK-20260712-001-PM-to-DEV",
      lifecycleBucket: "done",
      threadKey: thread,
    });
    const reworkDev = task({
      recipient: "DEV",
      taskId: "TASK-20260712-003-PM-to-DEV",
      lifecycleBucket: "active",
      threadKey: thread,
    });
    const reworkQa = task({
      recipient: "QA",
      taskId: "TASK-20260712-004-PM-to-QA",
      threadKey: thread,
      dependsOn: [reworkDev.taskId],
    });
    const tasks = [oldDev, reworkDev, reworkQa];
    const oldReport = report("DEV", "done", thread, oldDev.taskId);

    const blocked = evaluateDispatchEligibility(reworkQa, tasks, [oldReport]);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, "waiting_dependency");
    assert.equal(blocked.waitingOn, "TASK-20260712-003");

    const currentReport = report("DEV", "done", thread, reworkDev.taskId);
    const released = evaluateDispatchEligibility(reworkQa, tasks, [
      oldReport,
      currentReport,
    ]);
    assert.equal(released.allowed, true);
  });

  it("F: explicit dependency selects the intended DEV among multiple DEV tasks", () => {
    const thread = "panel-task-multi-dev";
    const unrelatedDev = task({
      recipient: "DEV",
      taskId: "TASK-20260712-010-PM-to-DEV",
      lifecycleBucket: "done",
      threadKey: thread,
    });
    const requiredDev = task({
      recipient: "DEV",
      taskId: "TASK-20260712-011-PM-to-DEV",
      lifecycleBucket: "active",
      threadKey: thread,
    });
    const qa = task({
      recipient: "QA",
      taskId: "TASK-20260712-012-PM-to-QA",
      threadKey: thread,
      dependsOn: [requiredDev.taskId],
    });
    const gate = evaluateDispatchEligibility(
      qa,
      [unrelatedDev, requiredDev, qa],
      [report("DEV", "done", thread, unrelatedDev.taskId)],
    );
    assert.equal(gate.allowed, false);
    assert.equal(gate.waitingOn, "TASK-20260712-011");
  });

  it("explicit dependency requires the upstream TASK even if a forged done report exists", () => {
    const dependencyId = "TASK-20260712-099-PM-to-DEV";
    const qa = task({
      recipient: "QA",
      taskId: "TASK-20260712-100-PM-to-QA",
      dependsOn: [dependencyId],
    });
    const gate = evaluateDispatchEligibility(
      qa,
      [qa],
      [report("DEV", "done", qa.threadKey, dependencyId)],
    );
    assert.equal(gate.allowed, false);
    assert.equal(gate.reason, "waiting_dependency");
    assert.equal(gate.waitingOn, "TASK-20260712-099");
  });

  it("legacy fallback uses the newest unfinished DEV instead of any old report", () => {
    const thread = "panel-task-legacy-rework";
    const oldDev = task({
      recipient: "DEV",
      taskId: "TASK-20260712-001-PM-to-DEV",
      lifecycleBucket: "done",
      threadKey: thread,
    });
    const currentDev = task({
      recipient: "DEV",
      taskId: "TASK-20260712-003-PM-to-DEV",
      lifecycleBucket: "active",
      threadKey: thread,
    });
    const qa = task({
      recipient: "QA",
      taskId: "TASK-20260712-004-PM-to-QA",
      threadKey: thread,
    });
    const gate = evaluateDispatchEligibility(
      qa,
      [oldDev, currentDev, qa],
      [report("DEV", "done", thread, oldDev.taskId)],
    );
    assert.equal(gate.allowed, true);
  });

  it("independent QA without a DEV task or explicit DEV dependency remains runnable", () => {
    const qa = task({
      recipient: "QA",
      taskId: "TASK-20260712-020-PM-to-QA",
      threadKey: "panel-task-independent-qa",
    });
    const gate = evaluateDispatchEligibility(qa, [qa], []);
    assert.equal(gate.allowed, true);
  });

  it("QA pass unlocks EVAL dispatch", () => {
    const thread = "panel-task-111";
    const tasks = [
      task({ recipient: "DEV", lifecycleBucket: "done" }),
      task({ recipient: "QA", lifecycleBucket: "done" }),
      task({ recipient: "EVAL" }),
    ].map((t) => ({ ...t, threadKey: thread }));
    const reports = [
      report("DEV", "done", thread),
      report("QA", "pass", thread),
    ];

    const evalGate = evaluateDispatchEligibility(tasks[2]!, tasks, reports);
    assert.equal(evalGate.allowed, true);
  });

  it("inbox-held untrusted task is not runnable for wake", () => {
    const held = task({
      recipient: "EVAL",
      sender: "PM",
      filename: "TASK-20260610-001-PM-to-EVAL.md",
      taskId: "TASK-20260610-001-PM-to-EVAL",
    });
    assert.equal(requiresExplicitDispatch(held), true);
    const wake = isTaskRunnableForWake(held);
    assert.equal(wake.runnable, false);
    assert.equal(wake.reason, "task_not_dispatched");
  });

  it("ADMIN→PM inbox is runnable for wake (auto-dispatch entry)", () => {
    const adminPm = task({
      recipient: "PM",
      sender: "ADMIN",
      filename: "TASK-20260610-200-ADMIN-to-PM.md",
      taskId: "TASK-20260610-200-ADMIN-to-PM",
    });
    assert.equal(requiresExplicitDispatch(adminPm), false);
    const wake = isTaskRunnableForWake(adminPm);
    assert.equal(wake.runnable, true);
  });

  it("ADMIN→PM child subtask requires explicit dispatch (child_subtask hold)", () => {
    const adminPmChild = task({
      recipient: "PM",
      sender: "ADMIN",
      filename: "TASK-20260610-201-ADMIN-to-PM.md",
      taskId: "TASK-20260610-201-ADMIN-to-PM",
      parent: "TASK-20260610-200-ADMIN-to-PM",
      parentTaskId: "TASK-20260610-200-ADMIN-to-PM",
    });
    assert.equal(requiresExplicitDispatch(adminPmChild), true);
    assert.equal(
      resolveExplicitDispatchHoldReason(adminPmChild),
      "child_subtask",
    );
    const wake = isTaskRunnableForWake(adminPmChild);
    assert.equal(wake.runnable, false);
    assert.equal(wake.reason, "task_not_dispatched");
  });

  it("ADMIN→PM child with rework_of still auto-dispatches", () => {
    const reworkChild = task({
      recipient: "PM",
      sender: "ADMIN",
      filename: "TASK-20260610-202-ADMIN-to-PM.md",
      taskId: "TASK-20260610-202-ADMIN-to-PM",
      parent: "TASK-20260610-200-ADMIN-to-PM",
      reworkOf: "TASK-20260610-201-ADMIN-to-PM",
    });
    assert.equal(requiresExplicitDispatch(reworkChild), false);
    assert.equal(resolveExplicitDispatchHoldReason(reworkChild), null);
  });

  it("trusted internal routes auto-dispatch (no explicit hold)", () => {
    assert.equal(isTrustedInternalDispatch("ADMIN", "PM"), true);
    assert.equal(isTrustedInternalDispatch("PM", "DEV"), true);
    assert.equal(isTrustedInternalDispatch("PM", "QA"), true);
    assert.equal(isTrustedInternalDispatch("PM", "OPS"), true);

    for (const recipient of ["DEV", "QA", "OPS"] as const) {
      const ref = task({ recipient, sender: "PM" });
      assert.equal(requiresExplicitDispatch(ref), false);
      assert.equal(resolveExplicitDispatchHoldReason(ref), null);
    }

    const adminPm = task({
      recipient: "PM",
      sender: "ADMIN",
      filename: "TASK-20260610-200-ADMIN-to-PM.md",
      taskId: "TASK-20260610-200-ADMIN-to-PM",
    });
    assert.equal(requiresExplicitDispatch(adminPm), false);
  });

  it("PM→EVAL and unknown routes require explicit dispatch hold", () => {
    const pmEval = task({
      recipient: "EVAL",
      sender: "PM",
      filename: "TASK-20260610-001-PM-to-EVAL.md",
      taskId: "TASK-20260610-001-PM-to-EVAL",
      protocol: "fcop",
    });
    assert.equal(requiresExplicitDispatch(pmEval), true);
    assert.equal(
      resolveExplicitDispatchHoldReason(pmEval),
      "untrusted_source",
    );

    assert.equal(
      resolveExplicitDispatchHoldReason({
        sender: "VENDOR",
        recipient: "DEV",
        filename: "TASK-20260610-050-VENDOR-to-DEV.md",
        protocol: "fcop",
      }),
      "untrusted_source",
    );

    assert.equal(
      resolveExplicitDispatchHoldReason({
        sender: "PM",
        recipient: "DEV",
        filename: "TASK-20260610-051-PM-to-DEV.md",
        protocol: "",
      }),
      null,
    );

    assert.equal(
      resolveExplicitDispatchHoldReason({
        sender: "PM",
        recipient: "DEV",
        filename: "TASK-20260610-052-PM-to-DEV.md",
        protocol: "fcop",
        fmSender: "ADMIN",
      }),
      "missing_provenance",
    );
  });

  it("PM→QA inbox is runnable for wake (trusted auto-dispatch)", () => {
    const pmQa = task({ recipient: "QA", sender: "PM" });
    assert.equal(requiresExplicitDispatch(pmQa), false);
    const wake = isTaskRunnableForWake(pmQa);
    assert.equal(wake.runnable, true);
  });

  it("active task is runnable for wake", () => {
    const active = task({ recipient: "DEV", lifecycleBucket: "active" });
    const wake = isTaskRunnableForWake(active);
    assert.equal(wake.runnable, true);
  });
});
