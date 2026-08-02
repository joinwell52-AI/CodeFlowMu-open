import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DoorbellBuffer, DOORBELL_BUCKET_FAILURES } from "../doorbell-buffer.ts";
import { queryLogCenter } from "../log-center.ts";
import {
  buildRootFaultFields,
  buildRootFaultId,
  classifyRootFault,
  extractStableFailureCode,
} from "../root-fault.ts";

describe("root fault identity and doorbell dedupe", () => {
  it("preserves approval lifecycle codes instead of collapsing them into a generic policy block", () => {
    for (const code of [
      "OPERATION_APPROVAL_REQUIRED",
      "APPROVAL_REJECTED",
      "APPROVAL_EXPIRED",
      "APPROVAL_REVOKED",
      "APPROVAL_SCOPE_MISMATCH",
      "APPROVAL_ALREADY_CONSUMED",
      "APPROVAL_STALE",
      "APPROVAL_ADAPTER_REQUIRED",
      "ABSOLUTELY_PROHIBITED",
    ]) {
      assert.equal(extractStableFailureCode(`failure: ${code}`), code);
    }
    assert.deepEqual(classifyRootFault("OPERATION_APPROVAL_REQUIRED"), {
      category: "governance",
      severity: "P3",
      retry_policy: "manual",
    });
    assert.deepEqual(classifyRootFault("APPROVAL_STALE"), {
      category: "governance",
      severity: "P3",
      retry_policy: "none",
    });
  });

  it("collapses root and derived events in live and hydration paths", () => {
    const buffer = new DoorbellBuffer();
    const rootId = buildRootFaultId({
      session_id: "session-1",
      task_id: "TASK-1",
      agent_id: "DEV-01",
      failure_code: "CODEFLOWMU_POLICY_BLOCKED",
    });
    const root = buildRootFaultFields({
      event_id: "event-sdk-status",
      session_id: "session-1",
      task_id: "TASK-1",
      agent_id: "DEV-01",
      failure_code: "CODEFLOWMU_POLICY_BLOCKED",
      root_fault_id: rootId,
      is_root: true,
    });
    const derived = buildRootFaultFields({
      event_id: "event-session-ended",
      parent_event_id: "event-sdk-status",
      session_id: "session-1",
      task_id: "TASK-1",
      agent_id: "DEV-01",
      failure_code: "CODEFLOWMU_POLICY_BLOCKED",
      root_fault_id: rootId,
      is_root: false,
    });

    buffer.push("codeflowmu.failure", {
      ...root,
      failure_type: "tool_error",
      message: "guard worked",
    });
    buffer.hydrateFromDisk(
      "codeflowmu.failure",
      {
        ...derived,
        failure_type: "session_failed",
        message: "derived settlement",
      },
      Date.now() + 1,
    );

    const result = buffer.query({ types: DOORBELL_BUCKET_FAILURES });
    assert.equal(result.total, 1);
    assert.equal(result.events[0]?.root_fault_id, rootId);
    assert.equal(result.events[0]?.is_root, true);
    const payload = result.events[0]?.payload as Record<string, unknown>;
    assert.equal(payload["occurrence_count"], 1);
    assert.equal(
      (payload["derived_events"] as unknown[] | undefined)?.length,
      1,
    );
  });

  it("keeps five independent sessions as five root incidents", () => {
    const buffer = new DoorbellBuffer();
    for (let index = 0; index < 5; index += 1) {
      const sessionId = `session-${index}`;
      const fields = buildRootFaultFields({
        event_id: `event-${index}`,
        session_id: sessionId,
        task_id: "TASK-SAME",
        agent_id: "DEV-01",
        failure_code: "ERR_MODULE_NOT_FOUND",
        is_root: true,
      });
      buffer.push("codeflowmu.failure", {
        ...fields,
        failure_type: "session_failed",
        message: "missing dependency",
      });
    }
    assert.equal(
      buffer.query({ types: DOORBELL_BUCKET_FAILURES }).total,
      5,
    );
  });

  it("log center counts one row per root fault", () => {
    const buffer = new DoorbellBuffer();
    const common = {
      root_fault_id: "root-fault-fixed",
      session_id: "session-fixed",
      agent_id: "DEV-01",
      failure_code: "ERR_MODULE_NOT_FOUND",
      category: "dependency",
      severity: "P1",
    };
    buffer.push("codeflowmu.failure", {
      ...common,
      fault_id: "fault-root",
      is_root: true,
      failure_type: "tool_error",
    });
    buffer.push("codeflowmu.failure_recorded", {
      ...common,
      fault_id: "fault-derived",
      is_root: false,
      parent_event_id: "event-root",
      failure_type: "session_failed",
    });
    const result = queryLogCenter(buffer, null, {
      tab: "alerts",
      limit: 20,
    });
    assert.equal(result.total, 1);
    assert.equal(result.rows[0]?.root_fault_id, "root-fault-fixed");
  });
});
