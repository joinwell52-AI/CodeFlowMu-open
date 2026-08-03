import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  FcopInitTransaction,
  buildFcopInitPlan,
  createFcopBootstrapManifest,
  verifyFcopBootstrapManifest,
} from "../fcop-bootstrap-transaction.ts";

function write(root: string, rel: string, content: string): void {
  const target = join(root, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function sourceFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "cfm-bootstrap-source-"));
  write(root, "package.json", '{"version":"1.2.9"}\n');
  write(root, "codeflowmu-shell/package.json", '{"version":"1.2.9"}\n');
  write(root, "packages/codeflowmu-runtime/package.json", '{"version":"1.2.9"}\n');
  write(root, ".cursor/rules/fcop-rules.mdc", "> Rules version: `3.2.5`\n");
  write(root, ".cursor/rules/fcop-protocol.mdc", "> Rules version: `3.2.5` · Protocol commentary version: `3.2.5`\n");
  write(root, "AGENTS.md", "rules 3.2.5\n");
  write(root, "CLAUDE.md", "rules 3.2.5\n");
  write(root, "fcop/LETTER-TO-ADMIN.md", "admin guide\n");
  write(root, "fcop/shared/TEAM-README.md", "team\n");
  write(root, "fcop/shared/TEAM-ROLES.md", "roles\n");
  write(root, "fcop/shared/TEAM-OPERATING-RULES.md", "ops\n");
  write(root, "fcop/shared/roles/PM.md", "PM\n");
  write(root, "fcop/shared/roles/DEV.md", "DEV\n");
  write(root, "fcop/shared/roles/QA.md", "QA\n");
  write(root, "fcop/shared/roles/OPS.md", "OPS\n");
  write(root, "workspace/README.md", "workspace contract\n");
  write(root, "adoptedSource/runtime-contract.md", "adopted\n");
  return root;
}

function compatiblePlan(sourceRoot: string, targetRoot: string) {
  return buildFcopInitPlan({
    sourceRoot,
    targetRoot,
    sourceReleaseSha: "release-sha-1",
    installedFcopVersion: "3.2.5",
    installedFcopMcpVersion: "3.2.5",
    bundledRulesVersion: "3.2.5",
    bundledProtocolVersion: "3.2.5",
    initializationProfile: { mode: "project", team: "dev-team", workspaceMode: "root" },
  });
}

test("new initialization writes only the confirmed signed plan and passes digest postflight", () => {
  const source = sourceFixture();
  const target = join(mkdtempSync(join(tmpdir(), "cfm-bootstrap-parent-")), "new-project");
  try {
    const manifest = createFcopBootstrapManifest({ sourceRoot: source, sourceReleaseSha: "release-sha-1" });
    assert.equal(manifest.rules_version, "3.2.5");
    assert.equal(manifest.files.some((file) => /secret|instance\.json|runtime\.lock|mobile-gateway/i.test(file.target_rel)), false);
    const plan = compatiblePlan(source, target);
    assert.equal(plan.mode, "new");
    assert.deepEqual(plan.conflict, []);
    assert.throws(() => new FcopInitTransaction(plan).execute("wrong-digest"), /FCOP_INIT_PLAN_STALE/);
    const result = new FcopInitTransaction(plan).execute(plan.plan_digest);
    assert.equal(result.plan_digest, plan.plan_digest);
    assert.equal(result.rolled_back.length, 0);
    assert.equal(verifyFcopBootstrapManifest(target).ok, true);
    assert.equal(existsSync(join(target, ".codeflowmu", "instance.json")), false);
    assert.equal(existsSync(join(target, ".codeflowmu", "mobile-gateway.json")), false);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(dirname(target), { recursive: true, force: true });
  }
});

test("older installed or bundled packages produce a read-only conflict plan", () => {
  const source = sourceFixture();
  const target = join(mkdtempSync(join(tmpdir(), "cfm-bootstrap-preflight-")), "target");
  try {
    const plan = buildFcopInitPlan({
      sourceRoot: source,
      targetRoot: target,
      installedFcopVersion: "3.2.4",
      installedFcopMcpVersion: "3.2.4",
      bundledRulesVersion: "3.2.3",
      bundledProtocolVersion: "3.2.3",
    });
    assert.equal(plan.conflict.filter((item) => item.target_rel.startsWith("@package/")).length, 4);
    assert.equal(plan.package_upgrade_actions.length, 4);
    assert.equal(existsSync(target), false);
    assert.throws(() => new FcopInitTransaction(plan).execute(plan.plan_digest), /FCOP_INIT_PLAN_CONFLICT/);
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(dirname(target), { recursive: true, force: true });
  }
});

test("takeover preserves formal ledgers, workspace products, approvals, and host identity", () => {
  const source = sourceFixture();
  const target = mkdtempSync(join(tmpdir(), "cfm-bootstrap-takeover-"));
  try {
    write(target, "fcop/fcop.json", '{"mode":"preset","team":"dev-team","leader":"PM","roles":["PM","DEV","QA","OPS"],"created_at":"original"}\n');
    write(target, ".cursor/rules/fcop-rules.mdc", "> Rules version: `3.2.3`\n");
    write(target, ".cursor/rules/fcop-protocol.mdc", "> Rules version: `3.2.3` · Protocol commentary version: `3.2.3`\n");
    write(target, "fcop/tasks/TASK-1.md", "formal task\n");
    write(target, "fcop/reports/REPORT-1.md", "formal report\n");
    write(target, "workspace/product/result.md", "product\n");
    write(target, ".codeflowmu/operation-approvals/records/APPROVAL-1.json", '{"status":"pending"}\n');
    write(target, ".codeflowmu/instance.json", '{"instance_id":"stable-id"}\n');
    const preserved = [
      "fcop/tasks/TASK-1.md",
      "fcop/reports/REPORT-1.md",
      "workspace/product/result.md",
      ".codeflowmu/operation-approvals/records/APPROVAL-1.json",
      ".codeflowmu/instance.json",
    ].map((rel) => [rel, readFileSync(join(target, rel), "utf8")] as const);
    const plan = compatiblePlan(source, target);
    assert.equal(plan.mode, "takeover");
    assert.deepEqual(plan.conflict, []);
    new FcopInitTransaction(plan).execute(plan.plan_digest);
    for (const [rel, before] of preserved) assert.equal(readFileSync(join(target, rel), "utf8"), before, rel);
    assert.match(readFileSync(join(target, ".cursor/rules/fcop-rules.mdc"), "utf8"), /3\.2\.5/);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("a staging digest failure rolls back every applied bootstrap file", () => {
  const source = sourceFixture();
  const target = mkdtempSync(join(tmpdir(), "cfm-bootstrap-rollback-"));
  try {
    write(target, "fcop/fcop.json", '{"mode":"preset","team":"dev-team","leader":"PM","roles":["PM","DEV","QA","OPS"]}\n');
    write(target, ".cursor/rules/fcop-rules.mdc", "> Rules version: `3.2.3`\n");
    write(target, ".cursor/rules/fcop-protocol.mdc", "> Rules version: `3.2.3` · Protocol commentary version: `3.2.3`\n");
    write(target, "fcop/tasks/TASK-ROLLBACK.md", "must survive\n");
    const originalRules = readFileSync(join(target, ".cursor/rules/fcop-rules.mdc"), "utf8");
    const plan = compatiblePlan(source, target);
    assert.deepEqual(plan.conflict, []);
    write(source, "workspace/README.md", "tampered after confirmation\n");
    assert.throws(() => new FcopInitTransaction(plan).execute(plan.plan_digest), /staging digest mismatch/);
    assert.equal(readFileSync(join(target, ".cursor/rules/fcop-rules.mdc"), "utf8"), originalRules);
    assert.equal(readFileSync(join(target, "fcop/tasks/TASK-ROLLBACK.md"), "utf8"), "must survive\n");
    assert.equal(existsSync(join(target, "fcop", "bootstrap-manifest.json")), false);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("an extended postflight failure restores every bootstrap update and keeps formal artifacts", () => {
  const source = sourceFixture();
  const target = mkdtempSync(join(tmpdir(), "cfm-bootstrap-postflight-"));
  try {
    write(target, "fcop/fcop.json", '{"mode":"preset","team":"dev-team","leader":"PM","roles":["PM","DEV","QA","OPS"]}\n');
    write(target, ".cursor/rules/fcop-rules.mdc", "> Rules version: `3.2.3`\n");
    write(target, ".cursor/rules/fcop-protocol.mdc", "> Rules version: `3.2.3` · Protocol commentary version: `3.2.3`\n");
    write(target, "fcop/issues/ISSUE-KEEP.md", "formal issue\n");
    write(target, "workspace/product/result.md", "product\n");
    const originalRules = readFileSync(join(target, ".cursor/rules/fcop-rules.mdc"), "utf8");
    const plan = compatiblePlan(source, target);
    assert.deepEqual(plan.conflict, []);
    assert.throws(
      () => new FcopInitTransaction(plan).execute(plan.plan_digest, () => ({
        ok: false,
        failures: ["injected identity-isolation postflight failure"],
      })),
      /extended bootstrap postflight failed/,
    );
    assert.equal(readFileSync(join(target, ".cursor/rules/fcop-rules.mdc"), "utf8"), originalRules);
    assert.equal(readFileSync(join(target, "fcop/issues/ISSUE-KEEP.md"), "utf8"), "formal issue\n");
    assert.equal(readFileSync(join(target, "workspace/product/result.md"), "utf8"), "product\n");
    assert.equal(existsSync(join(target, "fcop", "bootstrap-manifest.json")), false);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
