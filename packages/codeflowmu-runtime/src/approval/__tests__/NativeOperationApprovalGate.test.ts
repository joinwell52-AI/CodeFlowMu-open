import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { evaluateNativeOperationBoundary } from "../NativeOperationApprovalGate.ts";
import { GovernanceApprovalService } from "../GovernanceApprovalService.ts";

const base = {
  toolName: "shell",
  projectRoot: "D:/work/project",
  projectId: "project",
  agentId: "DEV-01",
  sessionId: "session-1",
};

test("native boundary allows ordinary local programming and does not implement cost approval", async () => {
  const localCommit = await evaluateNativeOperationBoundary({
    ...base,
    args: { command: "git commit -m local-change" },
  });
  assert.equal(localCommit.decision, "ALLOW");

  const expensiveLocalTest = await evaluateNativeOperationBoundary({
    ...base,
    args: { command: "npm run test -- --very-expensive" },
  });
  assert.equal(expensiveLocalTest.decision, "ALLOW");
});

test("native boundary denies unmigrated production, security, external and destructive adapters", async () => {
  const commands = [
    "gh pr merge 12 --squash",
    "kubectl apply -f production.yaml",
    "git remote set-url origin https://example.invalid/repo.git",
    "git reset --hard HEAD~1",
  ];
  for (const command of commands) {
    const decision = await evaluateNativeOperationBoundary({ ...base, args: { command } });
    assert.equal(decision.decision, "DENY", command);
  }
});

test("native boundary denies live governance source edits but allows approval tests", async () => {
  const live = await evaluateNativeOperationBoundary({
    ...base,
    toolName: "edit",
    args: { path: "packages/codeflowmu-runtime/src/approval/OperationApprovalService.ts" },
  });
  assert.equal(live.decision, "DENY");

  const testFile = await evaluateNativeOperationBoundary({
    ...base,
    toolName: "edit",
    args: { path: "packages/codeflowmu-runtime/src/approval/__tests__/service.test.ts" },
  });
  assert.equal(testFile.decision, "ALLOW");
});

test("governance storage is readable but not directly mutable by agents", async () => {
  for (const [toolName, args] of [
    ["read_file", { path: "fcop/_lifecycle/inbox/TASK-006.md" }],
    ["read_text_file", { path: "fcop/reports/REPORT-006.md" }],
    ["grep_files", { path: "fcop/reports", pattern: "status: done" }],
    ["list_directory", { path: "fcop/_lifecycle/inbox" }],
    ["list_issues", { path: "fcop/issues" }],
    ["shell", { command: "rg -n status fcop/reports" }],
  ] as const) {
    const decision = await evaluateNativeOperationBoundary({ ...base, toolName, args });
    assert.equal(decision.decision, "ALLOW", toolName);
  }

  for (const [toolName, args] of [
    ["edit", { path: "fcop/reports/REPORT-006.md" }],
    ["delete_file", { path: "fcop/issues/ISSUE-002.md" }],
    ["apply_patch", { path: "fcop/_lifecycle/inbox/TASK-006.md" }],
    ["shell", { command: "del fcop\\reports\\REPORT-006.md" }],
    ["shell", { command: "echo changed > fcop\\reports\\REPORT-006.md" }],
    ["shell", { command: "Set-Content fcop\\reports\\REPORT-006.md changed" }],
    ["shell", { command: "python rewrite.py fcop\\reports\\REPORT-006.md" }],
    ["shell", { command: "git checkout -- fcop\\reports\\REPORT-006.md" }],
  ] as const) {
    const decision = await evaluateNativeOperationBoundary({ ...base, toolName, args });
    assert.equal(decision.decision, "DENY", toolName);
    if (decision.decision === "DENY") {
      assert.match(decision.reason, /governance_storage_boundary/);
    }
  }
});

test("Runtime protocol writes remain allowed", async () => {
  for (const toolName of ["write_task", "write_report", "write_issue", "write_review", "submit_review"]) {
    const decision = await evaluateNativeOperationBoundary({
      ...base,
      toolName,
      args: { path: "fcop/reports/managed-by-runtime.md" },
    });
    assert.equal(decision.decision, "ALLOW", toolName);
  }
});

test("ordinary docs remain writable outside governance storage", async () => {
  const decision = await evaluateNativeOperationBoundary({
    ...base,
    toolName: "write_file",
    args: { path: "docs/new-design-note.md" },
  });
  assert.equal(decision.decision, "ALLOW");
});

test("structured cleanup routes directories to approval and allows exact task temp cleanup", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "cfm-native-cleanup-"));
  try {
    const cache = join(projectRoot, "cache");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "runtime.log"), "log");
    const cleanup = await evaluateNativeOperationBoundary({
      ...base,
      projectRoot,
      toolName: "filesystem.cleanup",
      args: { targets: [cache], mode: "quarantine" },
    });
    assert.equal(cleanup.decision, "REQUIRE_APPROVAL");
    if (cleanup.decision === "REQUIRE_APPROVAL") {
      assert.equal(cleanup.input.request.action.executor, "filesystem.cleanup");
      assert.equal(cleanup.input.request.snapshot["file_count"], 1);
    }

    const taskDir = join(projectRoot, "workspace", "core-refactor-plan");
    mkdirSync(taskDir, { recursive: true });
    const source = join(taskDir, "_qa_wp00_spotcheck.py");
    writeFileSync(source, "print('spotcheck')\n");
    const allowed = await evaluateNativeOperationBoundary({
      ...base,
      projectRoot,
      toolName: "delete_file",
      args: { path: source },
    });
    assert.equal(allowed.decision, "ALLOW");
    if (allowed.decision === "ALLOW") {
      assert.equal(allowed.outcome?.classification, "allowed_cleanup");
      assert.equal(allowed.outcome?.changed, true);
    }
    rmSync(source);
    const absent = await evaluateNativeOperationBoundary({
      ...base,
      projectRoot,
      toolName: "delete_file",
      args: { path: source },
    });
    assert.equal(absent.decision, "ALLOW");
    if (absent.decision === "ALLOW") {
      assert.deepEqual(absent.outcome, {
        ok: true,
        changed: false,
        reason: "already_absent",
        targets: [source],
        classification: "already_absent",
      });
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("format text is harmless but a real disk format command is denied", async () => {
  for (const command of [
    "echo format appears in documentation",
    "node cli.js --format json",
    "rg format docs",
  ]) {
    const decision = await evaluateNativeOperationBoundary({ ...base, args: { command } });
    assert.equal(decision.decision, "ALLOW", command);
  }
  const destructive = await evaluateNativeOperationBoundary({
    ...base,
    args: { command: "format.exe X:" },
  });
  assert.equal(destructive.decision, "DENY");
});

test("Windows PowerShell 5 && chains are stopped before native execution", async () => {
  const denied = await evaluateNativeOperationBoundary({
    ...base,
    toolName: "shell",
    args: {
      command: "command1 && command2",
      shell: "powershell.exe",
    },
  });
  assert.deepEqual(denied, {
    decision: "DENY",
    reason: "powershell5_unsupported_and_chain",
    next_safe_action:
      "Run the commands as separate tool calls, or use '; if ($LASTEXITCODE -eq 0) { ... }'.",
  });

  for (const args of [
    { command: "command1 && command2", shell: "pwsh.exe" },
    { command: "cmd.exe /c command1 && command2" },
  ]) {
    const allowed = await evaluateNativeOperationBoundary({
      ...base,
      toolName: "shell",
      args,
    });
    assert.equal(allowed.decision, "ALLOW");
  }
});

test("an exact effective governance authorization is consumed before a high-risk tool call", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "cfm-native-governance-"));
  try {
    mkdirSync(join(projectRoot, "fcop", "_lifecycle", "active"), {
      recursive: true,
    });
    writeFileSync(
      join(
        projectRoot,
        "fcop",
        "_lifecycle",
        "active",
        "TASK-20260731-500-ADMIN-to-PM.md",
      ),
      "---\ntask_id: TASK-20260731-500-ADMIN-to-PM\n---\n# Task\n",
    );
    const service = new GovernanceApprovalService({
      projectRoot,
      governanceIdFactory: () => "GOV-NATIVE-1",
      approvalIdFactory: () => "APPROVAL-NATIVE-1",
      decisionIdFactory: () => "DECISION-NATIVE-1",
    });
    const draft = service.writeDraft({
      type: "AUTHORIZATION",
      issued_by: "ADMIN",
      authored_by: "PM",
      recipient: "DEV",
      target_task_id: "TASK-20260731-500-ADMIN-to-PM",
      thread_key: "native-governance",
      project_id: "native-project",
      source_kind: "pm_request",
      intent_summary: "允许推送指定分支",
      boundary_summary: "一次且仅限 origin/codex/native-auth",
      allowed_actions: ["git.remote.push"],
      prohibited_actions: ["git.remote.force_push"],
      targets: ["origin/codex/native-auth"],
      effective_conditions: ["scope matches"],
      usage_limit: 1,
      risk_and_rollback: "失败即停止",
      revocation_conditions: ["ADMIN revokes"],
      evidence_requirements: ["remote ref"],
      blocks_task: true,
    });
    const pending = service.submit(draft.governance_id, 1, "PM");
    const approved = service.decide({
      governanceId: pending.governance_id,
      revision: 1,
      approvalId: pending.approval_id!,
      actor: "ADMIN",
      decision: "approved",
      reason: "精确范围已确认",
      sourceUiActionId: "native-test-ui",
      idempotencyKey: "native-test-decision",
    });
    const authorization = {
      governance_id: approved.governance.governance_id,
      approval_id: approved.governance.approval_id,
      decision_id: approved.decision.decision_id,
      scope_digest: approved.governance.scope_digest,
      content_hash: approved.governance.content_hash,
      idempotency_key: "native-tool-consume-1",
    };
    const call = {
      toolName: "shell",
      projectRoot,
      projectId: "native-project",
      agentId: "DEV-01",
      taskId: "TASK-20260731-500-ADMIN-to-PM",
      args: {
        command: "git push origin codex/native-auth",
        governance_authorization: authorization,
      },
    };
    const allowed = await evaluateNativeOperationBoundary(call);
    assert.equal(allowed.decision, "ALLOW");
    if (allowed.decision === "ALLOW") {
      assert.equal(
        allowed.outcome?.classification,
        "governance_authorized",
      );
    }
    const replay = await evaluateNativeOperationBoundary({
      ...call,
      args: {
        ...call.args,
        governance_authorization: {
          ...authorization,
          idempotency_key: "native-tool-consume-2",
        },
      },
    });
    assert.equal(replay.decision, "DENY");
    if (replay.decision === "DENY") {
      assert.equal(replay.code, "APPROVAL_ALREADY_CONSUMED");
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
