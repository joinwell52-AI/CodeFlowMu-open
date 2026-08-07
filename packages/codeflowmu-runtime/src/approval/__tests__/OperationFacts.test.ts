import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  NEGATIVE_PREDICATES,
  NEGATIVE_RULE_IDS,
  buildOperationFacts,
  evaluateNegativePredicates,
  type NegativeRuleId,
  type OperationFacts,
} from "../OperationFacts.ts";
import { UniversalApprovalStore } from "../UniversalApprovalStore.ts";
import type { PrepareOperationInput } from "../OperationApprovalService.ts";

function baseFacts(): OperationFacts {
  return {
    subject: { role: "PM", agent_id: "PM-01", session_id: "session-1" },
    context: {
      project_id: "project-1",
      project_root_realpath: "D:\\project",
      task_id: "TASK-1",
      thread_key: "thread-1",
      task_scope_digest: "sha256:scope",
    },
    tool: { canonical_tool_id: "write_file", adapter_id: "structured.tool.v1", source_channel: "test" },
    operation: {
      kind: "write",
      exact_targets: ["D:\\project\\src\\app.ts"],
      canonical_targets: ["D:\\project\\src\\app.ts"],
      target_set_stable: true,
      recursive: false,
      dynamic_or_wildcard: false,
    },
    target_state: { lifecycle_class: "product", locked_or_in_use: false, link_boundary: "none" },
    impact: {
      persistent: true,
      external: false,
      shared: false,
      reversible: true,
      recovery_evidence: "exact pre-image",
      privilege_change: false,
      runtime_change: false,
      governance_change: false,
    },
    confidence: { complete: true, unresolved_fields: [], detector_ids: ["test.structured"] },
  };
}

function cloneFacts(mutator: (facts: OperationFacts) => void): OperationFacts {
  const facts = structuredClone(baseFacts());
  mutator(facts);
  return facts;
}

const CASES: Array<[NegativeRuleId, OperationFacts]> = [
  ["NEG.SCOPE.ESCAPE.WRITE", cloneFacts((f) => { f.operation.exact_targets = ["D:\\outside\\app.ts"]; f.operation.canonical_targets = ["D:\\outside\\app.ts"]; f.target_state.lifecycle_class = "external"; })],
  ["NEG.PROTECTED.BOUNDARY.WRITE", cloneFacts((f) => { f.target_state.lifecycle_class = "protected"; })],
  ["NEG.GOVERNANCE.BYPASS", cloneFacts((f) => { f.impact.governance_change = true; f.target_state.lifecycle_class = "governance"; })],
  ["NEG.SHARED.STATE.WRITE", cloneFacts((f) => { f.impact.shared = true; f.target_state.lifecycle_class = "shared"; })],
  ["NEG.TRACKED.DELETE", cloneFacts((f) => { f.operation.kind = "delete"; f.target_state.git_tracked = true; })],
  ["NEG.BULK.CLEANUP", cloneFacts((f) => { f.operation.kind = "delete"; f.operation.recursive = true; })],
  ["NEG.IRREVERSIBLE.EFFECT", cloneFacts((f) => { f.impact.reversible = false; delete f.impact.recovery_evidence; })],
  ["NEG.EXTERNAL.WRITE", cloneFacts((f) => { f.impact.external = true; f.operation.kind = "network_write"; })],
  ["NEG.SECURITY.AUTHORITY", cloneFacts((f) => { f.impact.privilege_change = true; })],
  ["NEG.RUNTIME.CONTROL", cloneFacts((f) => { f.impact.runtime_change = true; f.operation.kind = "process_control"; })],
  ["NEG.REMOTE.GIT.WRITE", cloneFacts((f) => { f.operation.kind = "remote_git"; })],
  ["NEG.RELEASE.PRODUCTION", cloneFacts((f) => { f.operation.kind = "publish"; })],
  ["NEG.SOFTWARE.SYSTEM.CHANGE", cloneFacts((f) => { f.confidence.detector_ids = ["structured.software_system_change"]; })],
  ["NEG.TASK.CONTRACT.CHANGE", cloneFacts((f) => { f.tool.canonical_tool_id = "change_task_scope"; })],
  ["NEG.CONCURRENCY.CONFLICT", cloneFacts((f) => { f.target_state.locked_or_in_use = true; })],
];

test("negative rule catalog is exactly the frozen 15-item order", () => {
  assert.equal(NEGATIVE_RULE_IDS.length, 15);
  assert.equal(NEGATIVE_PREDICATES.length, 15);
  assert.deepEqual(CASES.map(([rule]) => rule), [...NEGATIVE_RULE_IDS]);
});

for (const [ruleId, facts] of CASES) {
  test(`${ruleId} matches and creates one real pending approval before execution`, () => {
    const matches = evaluateNegativePredicates(facts);
    assert.ok(matches.some((item) => item.rule_id === ruleId));
    const root = mkdtempSync(join(tmpdir(), "cfm-negative-approval-"));
    try {
      const input: PrepareOperationInput = {
        request: {
          subject: {
            actor: facts.subject.agent_id,
            role: facts.subject.role,
            project_id: facts.context.project_id,
            agent_id: facts.subject.agent_id,
            session_id: facts.subject.session_id,
            task_id: facts.context.task_id,
          },
          action: { capability: facts.tool.canonical_tool_id, operation: facts.operation.kind, executor: "agent.retry" },
          resource: { type: facts.target_state.lifecycle_class, targets: facts.operation.canonical_targets },
          context: { workspace: root, environment: "test", initiated_by: "agent", authorization_source: "none" },
          effect: { governance_change: true },
          snapshot: { rule_id: ruleId },
        },
        reason: matches.map((item) => item.reason_zh).join("；"),
        effects: matches.map((item) => item.rule_id),
        non_effects: ["operation not executed"],
        recovery: "wait for a decision on the same record",
        rule_ids: matches.map((item) => item.rule_id),
        operation_facts: facts,
        operation_fingerprint: `fingerprint:${ruleId}`,
        thread_key: facts.context.thread_key,
      };
      const store = new UniversalApprovalStore(root);
      const created = store.createPending(input);
      assert.equal(created.outcome, "APPROVAL_REQUIRED");
      if (created.outcome !== "APPROVAL_REQUIRED") assert.fail("approval record required");
      assert.ok(created.approval.approval_id);
      assert.equal(created.approval.status, "pending_approval");
      assert.ok(created.approval.rule_ids?.includes(ruleId));
      assert.equal(created.notice.operation_executed, false);
      assert.equal(created.notice.required_agent_action, "WAIT_FOR_APPROVAL_RESULT");
      store.deliverAgentNotice(created.notice);
      assert.equal(store.validateWaitingProjection(created.notice).agent_notice_delivered, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("unknown or incomplete facts are not a synthetic negative rule", () => {
  const facts = cloneFacts((f) => {
    f.operation.kind = "unknown";
    f.confidence.complete = false;
    f.confidence.unresolved_fields = ["operation.effects"];
  });
  assert.deepEqual(evaluateNegativePredicates(facts), []);
});

function shellFacts(root: string, command: string): OperationFacts {
  return buildOperationFacts({
    toolName: "shell",
    args: { command },
    projectRoot: root,
    projectId: "project-shell-lex",
    agentId: "PM-01",
    sessionId: "session-shell-1",
    taskId: "TASK-SHELL-1",
    threadKey: "thread-shell-1",
  });
}

test("shell lexical adapter ignores comparisons and external-write words inside payloads", () => {
  const root = mkdtempSync(join(tmpdir(), "cfm-shell-facts-"));
  try {
    const commands = [
      `python -c "x = 1; print(x > 0); print('version > 1.0; upload forbidden')"`,
      `node -e "console.log(JSON.stringify({action:'send_message', note:'submit_form upload'}))"`,
      `echo "Markdown says send_message, upload, submit_form and threshold > 0"`,
    ];
    for (const command of commands) {
      const facts = shellFacts(root, command);
      assert.notEqual(facts.operation.kind, "network_write", command);
      assert.equal(facts.impact.external, false, command);
      assert.deepEqual(
        facts.operation.exact_targets.filter((target) => ["0", "1.0", "=50"].includes(target)),
        [],
        command,
      );
      assert.ok(!evaluateNegativePredicates(facts).some((item) => item.rule_id === "NEG.EXTERNAL.WRITE"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shell lexical adapter distinguishes local redirects from real external writes", () => {
  const root = mkdtempSync(join(tmpdir(), "cfm-shell-targets-"));
  try {
    const local = shellFacts(root, `echo hi > ${join(root, "out.txt")}`);
    assert.equal(local.operation.kind, "write");
    assert.equal(local.impact.external, false);
    assert.equal(local.operation.canonical_targets[0], join(root, "out.txt"));

    const curl = shellFacts(root, "curl -X POST https://example.test/api --data payload");
    assert.equal(curl.operation.kind, "network_write");
    assert.deepEqual(curl.operation.canonical_targets, ["https://example.test/api"]);
    assert.ok(evaluateNegativePredicates(curl).some((item) => item.rule_id === "NEG.EXTERNAL.WRITE"));

    const invoke = shellFacts(root, "Invoke-RestMethod -Method Post -Uri https://example.test/items -Body payload");
    assert.equal(invoke.operation.kind, "network_write");
    assert.deepEqual(invoke.operation.canonical_targets, ["https://example.test/items"]);

    const push = shellFacts(root, "git push origin feature/fifo-fix");
    assert.equal(push.operation.kind, "remote_git");
    assert.deepEqual(push.operation.canonical_targets, ["git:origin/feature/fifo-fix"]);
    assert.ok(evaluateNegativePredicates(push).some((item) => item.rule_id === "NEG.REMOTE.GIT.WRITE"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external action without a validated target stays incomplete and cannot create external-write approval", () => {
  const root = mkdtempSync(join(tmpdir(), "cfm-shell-incomplete-"));
  try {
    const facts = shellFacts(root, "curl -X POST --data payload");
    assert.notEqual(facts.operation.kind, "network_write");
    assert.equal(facts.impact.external, false);
    assert.equal(facts.confidence.complete, false);
    assert.ok(facts.confidence.detector_ids.includes("shell.external_write_target_missing"));
    assert.ok(!evaluateNegativePredicates(facts).some((item) => item.rule_id === "NEG.EXTERNAL.WRITE"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
