import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReportDispatcher } from "../ReportDispatcher.ts";
import type { AgentRegistry } from "../../registry/AgentRegistry.ts";
import type { SessionManager, SessionStartPayload } from "../../session/SessionManager.ts";
import type { RuntimeEvent } from "../../types/state.ts";
import type { LifecycleGovernor } from "../LifecycleGovernor.ts";

function reportEvent(filename: string, senderRole: string, threadKey: string) {
  return {
    filepath: `/tmp/${filename}`,
    filename,
    senderRole,
    content: `---
thread_key: ${threadKey}
task_id: TASK-20260605-001-PM-to-${senderRole}
---

${senderRole} report body`,
  };
}

describe("ReportDispatcher", () => {
  it("wakes PM from a DEV receipt without redispatching the PM-to-DEV TASK", async () => {
    const starts: Array<{
      agentId: string;
      taskId: string;
      payload: SessionStartPayload;
    }> = [];
    const registry = {
      list: async () => [{
        protocol: { agent_id: "PM-01", role: "PM", status: "idle" },
      }],
    } as unknown as AgentRegistry;
    const sessionManager = {
      onEvent: () => () => undefined,
      startSession: async (
        agentId: string,
        taskId: string,
        payload: SessionStartPayload,
      ) => {
        starts.push({ agentId, taskId, payload });
        return {};
      },
    } as unknown as SessionManager;
    let lifecycleMoves = 0;
    const lifecycleGovernor = {
      scheduleTaskToReviewOnReport: () => {
        lifecycleMoves += 1;
      },
    } as unknown as LifecycleGovernor;
    const dispatcher = new ReportDispatcher({
      registry,
      sessionManager,
      lifecycleGovernor,
      logger: {},
    });

    await dispatcher.handle(
      reportEvent("REPORT-20260805-021-DEV-to-PM.md", "DEV", "thread-receipt"),
      { skipLifecycleTransition: true },
    );

    assert.equal(lifecycleMoves, 0, "report_intake must not move the source TASK");
    assert.equal(starts.length, 1);
    assert.equal(starts[0]!.agentId, "PM-01");
    assert.match(starts[0]!.taskId, /^consolidate-thread-receipt-/);
    assert.equal(
      (starts[0]!.payload.context?.frontmatter as Record<string, unknown>)?.recipient,
      "PM",
    );
    assert.match(
      starts[0]!.payload.text,
      /REPORT-20260805-021-DEV-to-PM\.md/,
    );
    assert.equal(starts[0]!.payload.context?.wake_kind, "report_intake");
    assert.equal(
      starts[0]!.payload.context?.source_task_id,
      "TASK-20260605-001-PM-to-DEV",
    );
    assert.equal(
      starts[0]!.payload.context?.report_id,
      "REPORT-20260805-021-DEV-to-PM",
    );
    assert.doesNotMatch(starts[0]!.taskId, /PM-to-DEV/i);
  });

  it("wakes PM from a QA receipt without redispatching the PM-to-QA TASK", async () => {
    const starts: Array<{ agentId: string; taskId: string; payload: SessionStartPayload }> = [];
    const registry = {
      list: async () => [{ protocol: { agent_id: "PM-01", role: "PM", status: "idle" } }],
    } as unknown as AgentRegistry;
    const sessionManager = {
      onEvent: () => () => undefined,
      startSession: async (agentId: string, taskId: string, payload: SessionStartPayload) => {
        starts.push({ agentId, taskId, payload });
        return {};
      },
    } as unknown as SessionManager;
    const dispatcher = new ReportDispatcher({ registry, sessionManager, logger: {} });

    const intake = await dispatcher.handle(
      reportEvent("REPORT-20260805-022-QA-to-PM.md", "QA", "thread-qa-receipt"),
    );

    assert.equal(intake.wake_kind, "report_intake");
    assert.equal(intake.status, "started");
    assert.equal(starts.length, 1);
    assert.equal(starts[0]!.agentId, "PM-01");
    assert.doesNotMatch(starts[0]!.taskId, /PM-to-QA/i);
  });

  it("queues one report-intake request when PM is busy and deduplicates repeats", async () => {
    const registry = {
      list: async () => [{ protocol: { agent_id: "PM-01", role: "PM", status: "running" } }],
    } as unknown as AgentRegistry;
    const sessionManager = {
      onEvent: () => () => undefined,
      startSession: async () => {
        throw new Error("busy PM must not start");
      },
    } as unknown as SessionManager;
    const dispatcher = new ReportDispatcher({ registry, sessionManager, logger: {} });
    const event = reportEvent(
      "REPORT-20260805-023-DEV-to-PM.md",
      "DEV",
      "thread-busy-intake",
    );

    const first = await dispatcher.handle(event);
    const duplicate = await dispatcher.handle(event);

    assert.equal(first.status, "queued");
    assert.equal(duplicate.status, "duplicate");
    assert.equal(dispatcher.queueSnapshot().length, 1);
  });

  it("writes one durable wake_kind=report_intake audit record", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "report-intake-audit-"));
    try {
      const registry = {
        list: async () => [{ protocol: { agent_id: "PM-01", role: "PM", status: "running" } }],
      } as unknown as AgentRegistry;
      const sessionManager = {
        onEvent: () => () => undefined,
        startSession: async () => ({}),
      } as unknown as SessionManager;
      const dispatcher = new ReportDispatcher({
        registry,
        sessionManager,
        projectRoot,
        logger: {},
      });
      const event = reportEvent(
        "REPORT-20260805-025-DEV-to-PM.md",
        "DEV",
        "thread-audit-intake",
      );

      await dispatcher.handle(event);
      await dispatcher.handle(event);

      const raw = await readFile(join(projectRoot, "fcop", "ledger", "journal.jsonl"), "utf-8");
      const records = raw.trim().split(/\r?\n/).map((line) => JSON.parse(line));
      assert.equal(records.length, 1);
      assert.equal(records[0].wake_kind, "report_intake");
      assert.equal(records[0].task_id, "TASK-20260605-001-PM-to-DEV");
      assert.equal(records[0].report_id, "REPORT-20260805-025-DEV-to-PM");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("starts one PM session for a same-thread report batch", async () => {
    let pmStatus = "running";
    const registry = {
      list: async () => [
        {
          protocol: {
            agent_id: "PM-01",
            role: "PM",
            status: pmStatus,
          },
        },
      ],
    } as unknown as AgentRegistry;

    const starts: Array<{
      agentId: string;
      taskId: string;
      payload: SessionStartPayload;
    }> = [];
    let listener: ((event: RuntimeEvent) => void) | null = null;
    const sessionManager = {
      onEvent: (fn: (event: RuntimeEvent) => void) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
      startSession: async (
        agentId: string,
        taskId: string,
        payload: SessionStartPayload,
      ) => {
        starts.push({ agentId, taskId, payload });
        return {};
      },
    } as unknown as SessionManager;

    const dispatcher = new ReportDispatcher({
      registry,
      sessionManager,
      logger: {},
    });

    await dispatcher.handle(
      reportEvent("REPORT-20260605-001-DEV-to-PM.md", "DEV", "thread-a"),
    );
    await dispatcher.handle(
      reportEvent("REPORT-20260605-002-QA-to-PM.md", "QA", "thread-a"),
    );

    assert.equal(starts.length, 0, "PM is busy, reports should stay queued");

    pmStatus = "idle";
    const emit = listener as ((event: RuntimeEvent) => void) | null;
    emit?.({
      event_id: "ended",
      at: new Date().toISOString(),
      event_type: "runtime.session_ended",
      agent_id: "PM-01",
      payload: {},
    } as RuntimeEvent);

    await new Promise((resolve) => setTimeout(resolve, 350));

    assert.equal(starts.length, 1);
    assert.equal(starts[0]!.agentId, "PM-01");
    assert.match(starts[0]!.taskId, /^consolidate-thread-a-/);
    assert.match(starts[0]!.payload.text, /Report count\*\*: 2/);
    assert.match(starts[0]!.payload.text, /REPORT-20260605-001-DEV-to-PM\.md/);
    assert.match(starts[0]!.payload.text, /REPORT-20260605-002-QA-to-PM\.md/);
  });
});
