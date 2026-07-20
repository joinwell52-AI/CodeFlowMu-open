import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { AgentRegistry } from "../../registry/AgentRegistry.ts";
import type { SessionManager } from "../../session/SessionManager.ts";
import type { LedgerReportRecord, LedgerTaskRecord } from "../../ledger/types.ts";
import { reconcileAgentTaskState } from "../reconcileAgentTaskState.ts";

function mockRegistry(
  agentId: string,
  role: string,
  status: string,
): AgentRegistry {
  return {
    get: async () => ({
      protocol: {
        agent_id: agentId,
        role,
        status,
        last_active_at: "2026-06-10T10:00:00+08:00",
      },
      runtime_binding_mode: "local",
      runtime_last_reconciled_at: "2026-06-10T10:00:00+08:00",
    }),
    list: async () => [],
  } as unknown as AgentRegistry;
}

function mockSession(active: boolean, sessionId = "session-1"): SessionManager {
  return {
    listActive: async () =>
      active
        ? [{ agent_id: "DEV-01", session_id: sessionId }]
        : [],
  } as unknown as SessionManager;
}

function workerTask(overrides: Partial<LedgerTaskRecord> = {}): LedgerTaskRecord {
  return {
    task_id: "TASK-20260610-029-PM-to-DEV",
    filename: "TASK-20260610-029-PM-to-DEV.md",
    recipient: "DEV",
    sender: "PM",
    bucket: "active",
    physical_scope: "active",
    path: "fcop/_lifecycle/active/TASK-20260610-029-PM-to-DEV.md",
    ...overrides,
  } as LedgerTaskRecord;
}

describe("reconcileAgentTaskState", () => {
  it("scenario 1: running — active session, no report", async () => {
    const r = await reconcileAgentTaskState({
      projectRoot: "/tmp",
      agentId: "DEV-01",
      taskId: "TASK-20260610-029-PM-to-DEV",
      registry: mockRegistry("DEV-01", "DEV", "running"),
      sessionManager: mockSession(true),
      tasks: [workerTask()],
      reports: [],
    });
    assert.equal(r.state, "running");
    assert.match(r.admin_hint, /正在执行/);
    assert.notEqual(r.admin_hint, /回执失败/);
  });

  it("scenario 5: latest REPORT blocked → PM decision, not receipt failure", async () => {
    const reports: LedgerReportRecord[] = [
      {
        report_id: "REPORT-20260610-029-DEV-to-PM",
        filename: "REPORT-20260610-029-DEV-to-PM.md",
        task_id: "TASK-20260610-029-PM-to-DEV",
        sender: "DEV",
        recipient: "PM",
        status: "blocked",
        updated_at: "2026-06-10T12:00:00+08:00",
      } as LedgerReportRecord,
    ];
    const r = await reconcileAgentTaskState({
      projectRoot: "/tmp",
      agentId: "DEV-01",
      taskId: "TASK-20260610-029-PM-to-DEV",
      registry: mockRegistry("DEV-01", "DEV", "idle"),
      sessionManager: mockSession(false),
      tasks: [workerTask()],
      reports,
    });
    assert.equal(r.state, "blocked");
    assert.match(r.admin_hint, /决策/);
  });

  it("scenario 6: latest REPORT done → done", async () => {
    const reports: LedgerReportRecord[] = [
      {
        report_id: "REPORT-20260610-029-DEV-to-PM",
        task_id: "TASK-20260610-029-PM-to-DEV",
        status: "done",
        updated_at: "2026-06-10T12:00:00+08:00",
      } as LedgerReportRecord,
    ];
    const r = await reconcileAgentTaskState({
      projectRoot: "/tmp",
      agentId: "DEV-01",
      taskId: "TASK-20260610-029-PM-to-DEV",
      registry: mockRegistry("DEV-01", "DEV", "idle"),
      sessionManager: mockSession(false),
      tasks: [workerTask({ physical_scope: "done", bucket: "done" })],
      reports,
    });
    assert.equal(r.state, "done");
  });

  it("scenario 7: agent busy + session missing → recoverable", async () => {
    const r = await reconcileAgentTaskState({
      projectRoot: "/tmp",
      agentId: "DEV-01",
      taskId: "TASK-20260610-029-PM-to-DEV",
      registry: mockRegistry("DEV-01", "DEV", "running"),
      sessionManager: mockSession(false),
      tasks: [workerTask()],
      reports: [],
    });
    assert.equal(r.state, "recoverable");
    assert.equal(r.reason_code, "stale_busy_no_session");
    assert.match(r.admin_hint, /可恢复/);
  });
});
