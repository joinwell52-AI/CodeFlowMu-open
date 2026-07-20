import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  ADMIN_TOOLS,
  EXECUTOR_TOOLS,
  LEADER_TOOLS,
  OBSERVER_TOOLS,
  isEvalRoleAgentId,
  profileForAgent,
  profileForLayer,
  toolsForProfile,
  toolsForAgent,
  PM_RUNTIME_CONTROL_TOOLS,
} from "../FcopToolProfile.ts";

const EVAL_WAKE_REQUIRED = [
  "list_tasks",
  "read_task",
  "inspect_task",
  "list_reports",
  "read_report",
  "list_issues",
  "write_issue",
  "write_report",
  "get_team_status",
  "get_governance_summary",
  "list_governance_events",
  "write_task",
] as const;

const EVAL_WAKE_FORBIDDEN = [
  "claim_task",
  "submit_task",
  "finish_task",
  "approve_task",
  "reject_task",
  "archive_task",
  "close_issue",
  "fcop_audit",
  "fcop_check",
  "fcop_report",
  "fcop_create_alert",
  "init_project",
  "redeploy_rules",
  "archive_to_history",
  "bulk_archive_to_history",
  "mark_human_approved",
] as const;

describe("FcopToolProfile", () => {
  it("maps observer layer to observer profile", () => {
    assert.equal(profileForLayer("observer"), "observer");
    assert.deepEqual(toolsForProfile("observer"), OBSERVER_TOOLS);
  });

  it("maps EVAL agent id to observer even with legacy governance layer", () => {
    assert.equal(profileForAgent("EVAL-01", "governance"), "observer");
    assert.equal(profileForAgent("EVAL-01", "observer"), "observer");
    assert(isEvalRoleAgentId("EVAL-01"));
    assert(!isEvalRoleAgentId("PM-01"));
  });

  it("EVAL wake includes observer tools and excludes forbidden lifecycle/audit tools", () => {
    const wake = new Set(toolsForProfile(profileForAgent("EVAL-01", "observer")));
    for (const name of EVAL_WAKE_REQUIRED) {
      assert(wake.has(name), `missing observer tool: ${name}`);
    }
    for (const name of EVAL_WAKE_FORBIDDEN) {
      assert(!wake.has(name), `forbidden tool present in EVAL wake: ${name}`);
    }
  });

  it("worker executor profile remains exactly 3 hot-path tools", () => {
    assert.equal(EXECUTOR_TOOLS.length, 3);
    assert.deepEqual([...EXECUTOR_TOOLS], [
      "write_report",
      "write_issue",
      "drop_suggestion",
    ]);
    assert.equal(profileForLayer("worker"), "executor");
    assert.deepEqual(toolsForProfile("executor"), EXECUTOR_TOOLS);
  });

  it("PM leader and ADMIN tool profiles are unchanged snapshots", () => {
    assert.ok(LEADER_TOOLS.includes("write_task"));
    assert.ok(LEADER_TOOLS.includes("fcop_report"));
    assert.ok(LEADER_TOOLS.includes("new_workspace"));
    assert.ok(LEADER_TOOLS.includes("list_workspaces"));
    assert.ok(ADMIN_TOOLS.includes("approve_task"));
    assert.ok(ADMIN_TOOLS.includes("init_project"));
    assert.equal(profileForLayer("leader"), "leader");
    assert.equal(profileForLayer("admin"), "admin");
  });

  it("exposes Runtime control tools only to the PM seat", () => {
    const pm = new Set(toolsForAgent("PM-01", "leader"));
    for (const tool of PM_RUNTIME_CONTROL_TOOLS) assert(pm.has(tool));
    const planner = new Set(toolsForAgent("PLANNER-01", "leader"));
    for (const tool of PM_RUNTIME_CONTROL_TOOLS) assert(!planner.has(tool));
  });
});
