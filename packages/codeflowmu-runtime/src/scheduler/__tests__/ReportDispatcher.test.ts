import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ReportDispatcher } from "../ReportDispatcher.ts";
import type { AgentRegistry } from "../../registry/AgentRegistry.ts";
import type { SessionManager, SessionStartPayload } from "../../session/SessionManager.ts";
import type { RuntimeEvent } from "../../types/state.ts";

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
