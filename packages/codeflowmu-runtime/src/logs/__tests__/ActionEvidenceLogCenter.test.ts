import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { actionEvidenceToLogCenterRow } from "../ActionEvidenceLogCenter.ts";
import type { CommandRunAction } from "../actionLogTypes.ts";
import {
  ACTION_LOG_SCHEMA_VERSION,
  ACTION_LOG_SOURCE,
} from "../actionLogPaths.ts";

describe("ActionEvidenceLogCenter", () => {
  it("actionEvidenceToLogCenterRow maps command.run with failed → ERROR", () => {
    const rec: CommandRunAction = {
      schema_version: ACTION_LOG_SCHEMA_VERSION,
      event_id: "evt-1",
      event_type: "command.run",
      at: "2026-06-08T10:00:00.000Z",
      task_id: "TASK-20260608-001",
      session_id: "sess-abc",
      agent_id: "agent-1",
      role: "DEV",
      source: ACTION_LOG_SOURCE,
      status: "failed",
      command: "npm test",
      duration_ms: 1200,
    };
    const row = actionEvidenceToLogCenterRow(rec);
    assert.equal(row.tab, "actions");
    assert.equal(row.event_type, "command.run");
    assert.equal(row.level, "ERROR");
    assert.equal(row.agent_id, "DEV");
    assert.equal(row.status, "failed");
    assert.equal(row.duration_ms, 1200);
    assert.match(row.message ?? "", /command\.run/);
    assert.equal(row.args_preview, "npm test");
  });

  it("actionEvidenceToLogCenterRow prefers role over agent_id", () => {
    const rec: CommandRunAction = {
      schema_version: ACTION_LOG_SCHEMA_VERSION,
      event_id: "evt-2",
      event_type: "command.run",
      at: "2026-06-08T11:00:00.000Z",
      task_id: "TASK-20260608-002",
      session_id: "sess-pm",
      agent_id: "cursor-agent",
      role: "PM",
      source: ACTION_LOG_SOURCE,
      status: "success",
      command: "echo hi",
    };
    const row = actionEvidenceToLogCenterRow(rec);
    assert.equal(row.agent_id, "PM");
    assert.equal(row.level, "INFO");
  });
});
