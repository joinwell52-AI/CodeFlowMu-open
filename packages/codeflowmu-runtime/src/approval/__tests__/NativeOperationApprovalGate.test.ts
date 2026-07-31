import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { evaluateNativeOperationBoundary } from "../NativeOperationApprovalGate.ts";

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

test("structured cleanup creates an approval while source deletion is denied", async () => {
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

    const source = join(projectRoot, "new-source.ts");
    writeFileSync(source, "export const value = 1;\n");
    const denied = await evaluateNativeOperationBoundary({
      ...base,
      projectRoot,
      toolName: "delete_file",
      args: { path: source },
    });
    assert.equal(denied.decision, "DENY");
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
