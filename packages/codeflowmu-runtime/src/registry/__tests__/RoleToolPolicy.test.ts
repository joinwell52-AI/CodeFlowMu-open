/**
 * Migration regression for the retired RoleToolPolicy decision engine.
 *
 * These fixtures intentionally exercise the current immutable-facts policy.
 * Production and tests must not revive the historical command allow/block
 * evaluator as an authorization source.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evaluateUnifiedOperationPolicy } from "../../approval/UnifiedOperationPolicy.ts";
import { evaluateRoleToolCall } from "../RoleToolPolicy.ts";

function input(projectRoot: string, overrides: Record<string, unknown> = {}) {
  return {
    toolName: "shell",
    args: {},
    projectRoot,
    projectId: "role-tool-policy-migration",
    agentId: "PM-01",
    sessionId: "session-role-tool-policy-migration",
    taskId: "TASK-20260803-001",
    threadKey: "thread-role-tool-policy-migration",
    ...overrides,
  };
}

test("historical PM PowerShell directory probe is a normal read", () => {
  const root = mkdtempSync(join(tmpdir(), "cfm-role-policy-read-"));
  try {
    const result = evaluateUnifiedOperationPolicy({
      ...input(root),
      args: { command: "Get-ChildItem -Path ." },
    });
    assert.equal(result.decision, "ALLOW");
    assert.equal(result.facts.operation.kind, "read");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown shell with no positive negative evidence is allowed", () => {
  const root = mkdtempSync(join(tmpdir(), "cfm-role-policy-opaque-"));
  try {
    const result = evaluateUnifiedOperationPolicy({
      ...input(root),
      args: { command: "Get-Date" },
    });
    assert.equal(result.decision, "ALLOW");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("caller self-attestation and formal ledger mutation route to approval, never ABSOLUTELY_PROHIBITED", () => {
  const root = mkdtempSync(join(tmpdir(), "cfm-role-policy-governance-"));
  try {
    for (const args of [
      { path: "src/app.ts", content: "x", pm_implementation_override: true },
      { path: "fcop/_lifecycle/active/TASK-forged.md", content: "x" },
    ]) {
      const result = evaluateUnifiedOperationPolicy({
        ...input(root, { toolName: "write_file" }),
        args,
      });
      assert.equal(result.decision, "REQUIRE_APPROVAL");
      if (result.decision === "REQUIRE_APPROVAL") {
        assert.ok(result.rule_ids.includes("NEG.GOVERNANCE.BYPASS"));
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("active-project write is allowed while a cross-project write is approval-routed", () => {
  const root = mkdtempSync(join(tmpdir(), "cfm-role-policy-scope-"));
  try {
    const local = evaluateUnifiedOperationPolicy({
      ...input(root, { toolName: "write_file", agentId: "DEV-01" }),
      args: { path: "src/app.ts", content: "x" },
    });
    assert.equal(local.decision, "ALLOW");

    const escaped = evaluateUnifiedOperationPolicy({
      ...input(root, { toolName: "write_file", agentId: "DEV-01" }),
      args: { path: join(root, "..", "another-project", "src", "app.ts"), content: "x" },
    });
    assert.equal(escaped.decision, "REQUIRE_APPROVAL");
    if (escaped.decision === "REQUIRE_APPROVAL") {
      assert.ok(escaped.rule_ids.includes("NEG.SCOPE.ESCAPE.WRITE"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("role tool gate checks exact capability only and does not inspect effects", () => {
  assert.deepEqual(
    evaluateRoleToolCall({ agentId: "PM-01", toolName: "shell", args: { command: "Get-Date" } }),
    { allow: true },
  );
  const denied = evaluateRoleToolCall({ agentId: "EVAL-01", toolName: "write_file", args: { path: "result.md" } });
  assert.equal(denied.allow, false);
  assert.match(denied.reason ?? "", /^ROLE_CAPABILITY_DENIED:/);
});
