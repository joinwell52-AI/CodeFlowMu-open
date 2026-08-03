import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { evaluateNativeOperationBoundary } from "../NativeOperationApprovalGate.ts";
import { UniversalApprovalStore } from "../UniversalApprovalStore.ts";
import {
  UNIFIED_OPERATION_POLICY_FEATURE_FLAG,
  evaluateUnifiedOperationPolicy,
} from "../UnifiedOperationPolicy.ts";

function base(projectRoot: string) {
  return {
    toolName: "shell",
    args: {},
    projectRoot,
    projectId: "policy-test",
    agentId: "PM-01",
    sessionId: "session-policy-test",
    taskId: "TASK-20260802-001",
    threadKey: "thread-20260802-001",
  };
}

test("PM task scratch mkdir/write is ALLOW across PowerShell, Python, and Node", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "cfm-policy-scratch-"));
  try {
    const scratch = join(projectRoot, "workspace", "core-refactor-plan", "_m0-doc-extract");
    const file = join(scratch, "doc-01-outline.md");
    const commands = [
      `New-Item -ItemType Directory -Path "${scratch}"; Set-Content -Path "${file}" -Value outline`,
      `python -c "import os; os.makedirs(r'${scratch}', exist_ok=True); open(r'${file}', 'w', encoding='utf-8').write('outline')"`,
      `node -e "require('fs').mkdirSync('${scratch.replace(/\\/g, "/")}',{recursive:true}); require('fs').writeFileSync('${file.replace(/\\/g, "/")}','outline')"`,
    ];
    for (const command of commands) {
      const policy = evaluateUnifiedOperationPolicy({ ...base(projectRoot), args: { command } });
      const boundary = await evaluateNativeOperationBoundary({ ...base(projectRoot), args: { command } });
      assert.equal(policy.decision, "ALLOW", command);
      assert.equal(boundary.decision, "ALLOW", command);
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("read-only Python mentioning a .md file is not classified as mkdir", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "cfm-policy-md-read-"));
  try {
    const result = evaluateUnifiedOperationPolicy({
      ...base(projectRoot),
      args: { command: "python -c \"print('PRODUCT-BRIEF-TASK-20260802-001.md')\"" },
    });
    assert.equal(result.facts.operation.kind, "read");
    assert.equal(result.facts.confidence.detector_ids.includes("shell.cmd.mkdir"), false);
    assert.equal(result.decision, "ALLOW");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("bounded reversible task-local product writes stay in the default allow domain", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "cfm-policy-product-"));
  try {
    for (const call of [
      { ...base(projectRoot), toolName: "write_file", args: { path: "src/product.ts", content: "ok" } },
      { ...base(projectRoot), args: { command: `Set-Content -Path "${join(projectRoot, "src", "product.ts")}" -Value x` } },
      { ...base(projectRoot), agentId: "DEV-01", toolName: "write_file", args: { path: "src/app.ts", content: "ok" } },
    ]) {
      assert.equal(evaluateUnifiedOperationPolicy(call).decision, "ALLOW");
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("caller self-attestation, governance mutation, and scope escape only route to approval", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "cfm-policy-negative-"));
  try {
    const cases = [
      {
        call: { ...base(projectRoot), toolName: "write_file", args: { path: "src/product.ts", content: "x", pm_implementation_override: true, approved_by: "ADMIN" } },
        rule: "NEG.GOVERNANCE.BYPASS",
      },
      {
        call: { ...base(projectRoot), toolName: "write_file", args: { path: join(projectRoot, "fcop", "reports", "REPORT-forged.md"), content: "x" } },
        rule: "NEG.GOVERNANCE.BYPASS",
      },
      {
        call: { ...base(projectRoot), toolName: "write_file", args: { path: join(projectRoot, "..", "other-project", "src", "app.ts"), content: "x" } },
        rule: "NEG.SCOPE.ESCAPE",
      },
    ];
    for (const { call, rule } of cases) {
      const result = evaluateUnifiedOperationPolicy(call);
      assert.equal(result.decision, "REQUIRE_APPROVAL");
      if (result.decision === "REQUIRE_APPROVAL") assert.ok(result.rule_ids.includes(rule as never));
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("opaque encoded commands route to a pending-information approval", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "cfm-policy-encoded-"));
  try {
    const result = evaluateUnifiedOperationPolicy({
      ...base(projectRoot),
      args: { command: "powershell -EncodedCommand ZgBvAHIAZwBlAGQ=" },
    });
    assert.equal(result.decision, "REQUIRE_APPROVAL");
    if (result.decision === "REQUIRE_APPROVAL") {
      assert.ok(result.rule_ids.includes("NEG.OPAQUE.EFFECT"));
      assert.equal(result.input.executor_status, "missing");
      assert.ok((result.input.missing_information ?? []).length > 0);
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("feature rollback safely routes non-read effects to approval", () => {
  const previous = process.env[UNIFIED_OPERATION_POLICY_FEATURE_FLAG];
  process.env[UNIFIED_OPERATION_POLICY_FEATURE_FLAG] = "0";
  try {
    const projectRoot = mkdtempSync(join(tmpdir(), "cfm-policy-disabled-"));
    const result = evaluateUnifiedOperationPolicy({
      ...base(projectRoot),
      toolName: "write_file",
      args: { path: "src/app.ts", content: "x" },
    });
    assert.equal(result.decision, "REQUIRE_APPROVAL");
    if (result.decision === "REQUIRE_APPROVAL") assert.deepEqual(result.rule_ids, ["NEG.OPAQUE.EFFECT"]);
    rmSync(projectRoot, { recursive: true, force: true });
  } finally {
    if (previous === undefined) delete process.env[UNIFIED_OPERATION_POLICY_FEATURE_FLAG];
    else process.env[UNIFIED_OPERATION_POLICY_FEATURE_FLAG] = previous;
  }
});

test("a multi-target controlled write creates pending_executor instead of silently executing targets[0]", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "cfm-policy-multi-target-"));
  try {
    const result = evaluateUnifiedOperationPolicy({
      ...base(projectRoot),
      toolName: "write_file",
      args: {
        targets: [
          "packages/codeflowmu-runtime/src/approval/a.ts",
          "packages/codeflowmu-runtime/src/approval/b.ts",
        ],
        content: "x",
      },
    });
    assert.equal(result.decision, "REQUIRE_APPROVAL");
    if (result.decision !== "REQUIRE_APPROVAL") throw new Error("approval expected");
    assert.equal(result.input.executor_status, "incompatible");
    assert.match(result.input.suggested_executor ?? "", /ONE_EXACT_TARGET/);

    const created = new UniversalApprovalStore(projectRoot).createPending(result.input);
    assert.equal(created.outcome, "APPROVAL_REQUIRED");
    if (created.outcome === "APPROVAL_REQUIRED") {
      assert.equal(created.approval.status, "pending_executor");
      assert.equal(created.approval.request.resource.targets.length, 2);
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
