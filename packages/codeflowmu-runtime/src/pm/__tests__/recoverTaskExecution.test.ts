import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recoverTaskExecution } from "../recoverTaskExecution.ts";
import { persistWorkerReceiptFailed } from "../workerReceiptDurableHints.ts";
import { resetPmExecutionGovernanceForTests } from "../pmExecutionGovernance.ts";

describe("recoverTaskExecution", () => {
  it("clears durable failed mark and in-memory guard callback", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeflowmu-recover-"));
    const taskId = "TASK-20260611-003";
    let guardCleared: string | null = null;
    try {
      await persistWorkerReceiptFailed(root, taskId, "worker_failed_mark");

      const result = await recoverTaskExecution({
        projectRoot: root,
        taskId,
        role: "DEV",
        registry: {
          list: async () => [
            {
              protocol: { agent_id: "DEV-01", role: "DEV", status: "idle" },
            },
          ],
          get: async () => ({
            protocol: { agent_id: "DEV-01", role: "DEV", status: "idle" },
          }),
        } as never,
        sessionManager: {
          listActive: async () => [],
        } as never,
        wakeExecutor: async () => ({ ok: false, error: "stub_wake_failed" }),
        clearInMemoryWorkerFailed: (tid) => {
          guardCleared = tid;
        },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, "failed");
      assert.equal(guardCleared, taskId);
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("does not recover repeatedly after wake_throttled", async () => {
    resetPmExecutionGovernanceForTests();
    const root = await mkdtemp(join(tmpdir(), "codeflowmu-recover-throttle-"));
    let wakeCalls = 0;
    const opts = {
      projectRoot: root,
      taskId: "TASK-20260615-201",
      role: "DEV",
      registry: {
        list: async () => [{ protocol: { agent_id: "DEV-01", role: "DEV", status: "idle" } }],
        get: async () => ({ protocol: { agent_id: "DEV-01", role: "DEV", status: "idle" } }),
      } as never,
      sessionManager: { listActive: async () => [] } as never,
      wakeExecutor: async () => {
        wakeCalls += 1;
        return { ok: false, delayed: true, remainingMs: 3000, delayedReason: "wake_throttled", reason: "wake_throttled" };
      },
    };
    try {
      const first = await recoverTaskExecution(opts);
      const second = await recoverTaskExecution(opts);
      assert.equal(first.policy, "PM_STOP");
      assert.equal(first.remainingMs, 3000);
      assert.equal(first.cooldownReason, "wake_throttled");
      assert.equal(second.policy, "PM_STOP");
      assert.equal(second.reason, "wake_throttled");
      assert.equal(wakeCalls, 1);
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
      resetPmExecutionGovernanceForTests();
    }
  });
});
