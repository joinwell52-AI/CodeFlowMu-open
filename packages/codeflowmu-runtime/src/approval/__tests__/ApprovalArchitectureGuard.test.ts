import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

test("role capability and negative behavior policy remain separate layers", () => {
  const rolePolicy = source("../../registry/RoleToolPolicy.ts");
  assert.doesNotMatch(rolePolicy, /import\s+\{[^}]*evaluateUnifiedOperationPolicy/);
  assert.match(rolePolicy, /evaluateRoleToolCapability\s*\(/);

  const nativeGate = source("../NativeOperationApprovalGate.ts");
  const capabilityAt = nativeGate.indexOf("evaluateRoleToolCapability(");
  const negativeAt = nativeGate.indexOf("evaluateUnifiedOperationPolicy(");
  assert.ok(capabilityAt >= 0 && negativeAt > capabilityAt);
});

test("formal negative policy has no opaque, unknown, or executor fallback", () => {
  const policy = source("../UnifiedOperationPolicy.ts");
  assert.doesNotMatch(policy, /NEG\.OPAQUE\.EFFECT/);
  assert.doesNotMatch(policy, /pending_(?:executor|information)/);
  assert.doesNotMatch(policy, /controlled_execute/);
  assert.match(policy, /resume_strategy:\s*"agent_retry"/);
});

test("Google approval waiting is a pause signal rather than a failed tool result", () => {
  const adapter = source("../../registry/GoogleGenAiAdapter.ts");
  assert.match(adapter, /isApprovalWait \? "waiting_approval" : "failed"/);
  assert.match(adapter, /status:\s*"waiting_approval"/);
  assert.doesNotMatch(
    adapter,
    /if \(isApprovalWait\)[\s\S]{0,500}hadToolFailure = true/,
  );
});
