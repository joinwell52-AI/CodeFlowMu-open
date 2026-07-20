import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LedgerBuilder } from "../../ledger/LedgerBuilder.ts";
import { resolveLedgerLayout } from "../../ledger/paths.ts";
import {
  PM_STOP_POLICY,
  clearPmAbnormalWindow,
  evaluateSequentialDispatchGuard,
  markPmStop,
  resetPmExecutionGovernanceForTests,
  shouldEscalateAdminForceRecovery,
  tryBeginPmRecover,
} from "../pmExecutionGovernance.ts";

function doc(frontmatter: Record<string, unknown>, body = "# fixture\n"): string {
  const yaml = Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n");
  return `---\n${yaml}\n---\n${body}`;
}

async function withChain(
  doneRoles: string[],
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pm-execution-governance-"));
  try {
    const layout = resolveLedgerLayout(root);
    const active = join(layout.lifecycleRoot, "active");
    await mkdir(active, { recursive: true });
    await mkdir(layout.reportsDir, { recursive: true });
    const rootTask = "TASK-20260615-100";
    await writeFile(
      join(active, `${rootTask}-ADMIN-to-PM.md`),
      doc({ protocol: "fcop", version: 1, kind: "task", sender: "ADMIN", recipient: "PM", task_id: rootTask, thread_key: "chain" }),
      "utf8",
    );
    for (const [index, role] of ["DEV", "OPS", "QA"].entries()) {
      const taskId = `TASK-20260615-10${index + 1}`;
      await writeFile(
        join(active, `${taskId}-PM-to-${role}.md`),
        doc({ protocol: "fcop", version: 1, kind: "task", sender: "PM", recipient: role, task_id: taskId, parent: rootTask, thread_key: "chain" }),
        "utf8",
      );
      if (doneRoles.includes(role)) {
        await writeFile(
          join(layout.reportsDir, `REPORT-20260615-10${index + 1}-${role}-to-PM.md`),
          doc({ protocol: "fcop", version: 1, kind: "report", sender: role, recipient: "PM", task_id: taskId, status: "done", thread_key: "chain" }),
          "utf8",
        );
      }
    }
    await new LedgerBuilder({ projectRoot: root }).rebuild();
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("PM execution governance", () => {
  beforeEach(() => resetPmExecutionGovernanceForTests());

  it("blocks OPS and QA until DEV is done", async () => {
    await withChain([], async (root) => {
      for (const [taskId, role] of [["TASK-20260615-102", "OPS"], ["TASK-20260615-103", "QA"]] as const) {
        const result = await evaluateSequentialDispatchGuard({ projectRoot: root, taskId, targetRole: role });
        assert.equal(result.allow, false);
        assert.equal(result.reason, "sequential_dispatch_guarded");
        assert.equal(result.current_leg, "DEV");
        assert.equal(result.next_allowed_agent, "DEV");
        assert.equal(result.current_leg, "DEV");
        assert.equal(result.blocked_target, role);
      }
    });
  });

  it("allows OPS only after DEV is done", async () => {
    await withChain(["DEV"], async (root) => {
      const ops = await evaluateSequentialDispatchGuard({ projectRoot: root, taskId: "TASK-20260615-102", targetRole: "OPS" });
      const qa = await evaluateSequentialDispatchGuard({ projectRoot: root, taskId: "TASK-20260615-103", targetRole: "QA" });
      assert.equal(ops.allow, true);
      assert.equal(ops.current_leg, "OPS");
      assert.equal(qa.allow, false);
      assert.equal(qa.current_leg, "OPS");
    });
  });

  it("allows QA only after OPS is done", async () => {
    await withChain(["DEV", "OPS"], async (root) => {
      const qa = await evaluateSequentialDispatchGuard({ projectRoot: root, taskId: "TASK-20260615-103", targetRole: "QA" });
      assert.equal(qa.allow, true);
      assert.equal(qa.current_leg, "QA");
    });
  });

  it("treats a blocked worker REPORT as a settled sequential leg", async () => {
    await withChain(["DEV"], async (root) => {
      const layout = resolveLedgerLayout(root);
      await writeFile(
        join(layout.reportsDir, "REPORT-20260615-102-OPS-to-PM.md"),
        doc({
          protocol: "fcop",
          version: 1,
          kind: "report",
          sender: "OPS",
          recipient: "PM",
          task_id: "TASK-20260615-102",
          status: "blocked",
          thread_key: "chain",
        }),
        "utf8",
      );
      await writeFile(
        join(layout.lifecycleRoot, "active", "TASK-20260614-099-PM-to-OPS.md"),
        doc({
          protocol: "fcop",
          version: 1,
          kind: "task",
          sender: "PM",
          recipient: "OPS",
          task_id: "TASK-20260614-099",
          parent: "TASK-20260614-090",
          thread_key: "chain",
        }),
        "utf8",
      );
      await new LedgerBuilder({ projectRoot: root }).rebuild();

      const qa = await evaluateSequentialDispatchGuard({
        projectRoot: root,
        taskId: "TASK-20260615-103",
        targetRole: "QA",
      });
      assert.equal(qa.allow, true);
      assert.equal(qa.current_leg, "QA");
    });
  });

  it("stops PM after wake throttle and denies recover", () => {
    const stopped = markPmStop({ taskId: "TASK-1", agentId: "DEV-01", reason: "wake_throttled", remainingMs: 2500, cooldownReason: "SDK_CIRCUIT_OPEN" });
    assert.equal(stopped.policy, PM_STOP_POLICY);
    assert.equal(stopped.remainingMs, 2500);
    assert.equal(stopped.cooldownReason, "SDK_CIRCUIT_OPEN");
    const recover = tryBeginPmRecover({ taskId: "TASK-1", agentId: "DEV-01" });
    assert.equal(recover.allow, false);
    assert.equal(recover.reason, "wake_throttled");
  });

  it("allows at most one recover in an abnormal window", () => {
    assert.equal(tryBeginPmRecover({ taskId: "TASK-2", agentId: "DEV-01" }).allow, true);
    const second = tryBeginPmRecover({ taskId: "TASK-2", agentId: "DEV-01" });
    assert.equal(second.allow, false);
    assert.equal(second.reason, "recover_limit_reached");
  });

  it("continues the original task window after ADMIN force recovery clears it", () => {
    markPmStop({ taskId: "TASK-3", agentId: "DEV-01", reason: "session_unsettled" });
    assert.equal(tryBeginPmRecover({ taskId: "TASK-3", agentId: "DEV-01" }).allow, false);
    clearPmAbnormalWindow("TASK-3", "DEV-01");
    assert.equal(tryBeginPmRecover({ taskId: "TASK-3", agentId: "DEV-01" }).allow, true);
  });

  it("escalates stale/session and agent-running inbox states", () => {
    assert.equal(shouldEscalateAdminForceRecovery({ reason: "stale_busy_no_session", wakeThrottled: true }), true);
    assert.equal(shouldEscalateAdminForceRecovery({ reason: "session_unsettled" }), true);
    assert.equal(shouldEscalateAdminForceRecovery({ reason: "agent_running", taskBucket: "inbox" }), true);
    assert.equal(shouldEscalateAdminForceRecovery({ reason: "wake_throttled" }), false);
  });
});
