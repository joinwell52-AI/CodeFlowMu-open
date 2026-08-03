import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import {
  acquireProjectWriteLease,
  projectInitializationLockPath,
  withProjectWriteLease,
} from "../../../packages/codeflowmu-runtime/src/project/ProjectWriteBarrier.ts";
import { flushScheduledLedgerRebuild } from "../../../packages/codeflowmu-runtime/src/ledger/scheduleLedgerRebuild.ts";

function write(root: string, rel: string, content: string): void {
  const target = join(root, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for test condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
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

test("new initialization writes only the confirmed signed plan and passes digest postflight", async () => {
  const source = sourceFixture();
  const target = join(mkdtempSync(join(tmpdir(), "cfm-bootstrap-parent-")), "new-project");
  try {
    const manifest = createFcopBootstrapManifest({ sourceRoot: source, sourceReleaseSha: "release-sha-1" });
    assert.equal(manifest.rules_version, "3.2.5");
    assert.equal(manifest.files.some((file) => /secret|instance\.json|runtime\.lock|mobile-gateway/i.test(file.target_rel)), false);
    const plan = compatiblePlan(source, target);
    assert.equal(plan.mode, "new");
    assert.deepEqual(plan.conflict, []);
    await assert.rejects(() => new FcopInitTransaction(plan).execute("wrong-digest"), /FCOP_INIT_PLAN_STALE/);
    const result = await new FcopInitTransaction(plan).execute(plan.plan_digest);
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

test("older installed or bundled packages produce a read-only conflict plan", async () => {
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
    await assert.rejects(() => new FcopInitTransaction(plan).execute(plan.plan_digest), /FCOP_INIT_PLAN_CONFLICT/);
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(dirname(target), { recursive: true, force: true });
  }
});

test("frontmatter protocol versions are parsed and never become an unknown minimum", () => {
  const source = sourceFixture();
  const target = join(mkdtempSync(join(tmpdir(), "cfm-bootstrap-frontmatter-")), "target");
  try {
    write(source, ".cursor/rules/fcop-rules.mdc", "---\nfcop_rules_version: 3.2.5\n---\n");
    write(source, ".cursor/rules/fcop-protocol.mdc", "---\nfcop_protocol_version: 3.2.5\n---\n");
    const plan = buildFcopInitPlan({
      sourceRoot: source,
      targetRoot: target,
      installedFcopVersion: "3.2.5",
      installedFcopMcpVersion: "3.2.5",
      bundledRulesVersion: "3.2.5",
      bundledProtocolVersion: "3.2.5",
    });
    assert.equal(plan.source_versions.mother_rules, "3.2.5");
    assert.equal(plan.source_versions.mother_protocol, "3.2.5");
    assert.equal(plan.package_upgrade_actions.some((item) => item.includes("unknown")), false);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(dirname(target), { recursive: true, force: true });
  }
});

test("partial uninitialized project preserves local bootstrap files and completes initialization", async () => {
  const source = sourceFixture();
  const target = mkdtempSync(join(tmpdir(), "cfm-bootstrap-partial-"));
  try {
    write(target, "AGENTS.md", "local project instructions must survive\n");
    write(target, "fcop/shared/TEAM-README.md", "local team notes must survive\n");
    write(target, ".cursor/rules/fcop-rules.mdc", "---\nfcop_rules_version: 3.2.5\n---\nlocal rules\n");
    const plan = compatiblePlan(source, target);
    assert.equal(plan.mode, "new");
    assert.deepEqual(plan.conflict, []);
    assert.ok(plan.preserve.some((row) => row.target_rel === "AGENTS.md"));
    await new FcopInitTransaction(plan).execute(plan.plan_digest);
    assert.equal(readFileSync(join(target, "AGENTS.md"), "utf8"), "local project instructions must survive\n");
    assert.equal(readFileSync(join(target, "fcop/shared/TEAM-README.md"), "utf8"), "local team notes must survive\n");
    assert.equal(verifyFcopBootstrapManifest(target).ok, true);
    assert.equal(JSON.parse(readFileSync(join(target, "fcop/fcop.json"), "utf8")).protocol_version, 3);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("same-repository initialization restores deleted Rule 4.5 templates from the signed git baseline", async () => {
  const root = sourceFixture();
  const requiredTemplates = [
    "fcop/shared/TEAM-ROLES.md",
    "fcop/shared/TEAM-OPERATING-RULES.md",
    "fcop/shared/roles/PM.md",
    "fcop/shared/roles/DEV.md",
    "fcop/shared/roles/QA.md",
    "fcop/shared/roles/OPS.md",
  ];
  try {
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "bootstrap-test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Bootstrap Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "bootstrap baseline"], { cwd: root, stdio: "ignore" });
    for (const rel of requiredTemplates) rmSync(join(root, rel));

    const plan = compatiblePlan(root, root);
    assert.equal(plan.mode, "new");
    assert.deepEqual(plan.conflict, []);
    for (const rel of requiredTemplates) {
      assert.ok(plan.create.some((entry) => entry.target_rel === rel), `${rel} must be restored`);
      assert.equal(plan.manifest.files.find((file) => file.target_rel === rel)?.source_origin, "git_head");
    }

    await new FcopInitTransaction(plan).execute(plan.plan_digest);
    for (const rel of requiredTemplates) assert.equal(existsSync(join(root, rel)), true);
    assert.equal(verifyFcopBootstrapManifest(root).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-repository initialization keeps working after root templates are deleted from HEAD", async () => {
  const root = sourceFixture();
  const requiredTemplates = [
    "fcop/shared/TEAM-ROLES.md",
    "fcop/shared/TEAM-OPERATING-RULES.md",
    "fcop/shared/roles/PM.md",
    "fcop/shared/roles/DEV.md",
    "fcop/shared/roles/QA.md",
    "fcop/shared/roles/OPS.md",
  ];
  try {
    for (const rel of requiredTemplates) {
      write(
        root,
        `codeflowmu-shell/resources/fcop-bootstrap/${rel}`,
        readFileSync(join(root, rel), "utf8"),
      );
      rmSync(join(root, rel));
    }

    const plan = compatiblePlan(root, root);
    assert.deepEqual(plan.conflict, []);
    for (const rel of requiredTemplates) {
      assert.equal(
        plan.manifest.files.find((file) => file.target_rel === rel)?.source_origin,
        "bundled_shell_resource",
      );
    }

    await new FcopInitTransaction(plan).execute(plan.plan_digest);
    for (const rel of requiredTemplates) assert.equal(existsSync(join(root, rel)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("takeover preserves formal ledgers, workspace products, approvals, and host identity", async () => {
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
    await new FcopInitTransaction(plan).execute(plan.plan_digest);
    for (const [rel, before] of preserved) assert.equal(readFileSync(join(target, rel), "utf8"), before, rel);
    assert.match(readFileSync(join(target, ".cursor/rules/fcop-rules.mdc"), "utf8"), /3\.2\.5/);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("a staging digest failure rolls back every applied bootstrap file", async () => {
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
    await assert.rejects(() => new FcopInitTransaction(plan).execute(plan.plan_digest), /staging digest mismatch/);
    assert.equal(readFileSync(join(target, ".cursor/rules/fcop-rules.mdc"), "utf8"), originalRules);
    assert.equal(readFileSync(join(target, "fcop/tasks/TASK-ROLLBACK.md"), "utf8"), "must survive\n");
    assert.equal(existsSync(join(target, "fcop", "bootstrap-manifest.json")), false);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("an extended postflight failure restores every bootstrap update and keeps formal artifacts", async () => {
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
    await assert.rejects(
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

test("initialization coordinates live writers and ignores rebuildable projections", async () => {
  const source = sourceFixture();
  const target = mkdtempSync(join(tmpdir(), "cfm-bootstrap-concurrent-"));
  try {
    write(target, "fcop/fcop.json", '{"mode":"preset","team":"dev-team","leader":"PM","roles":["PM","DEV","QA","OPS"]}\n');
    write(target, ".cursor/rules/fcop-rules.mdc", "> Rules version: `3.2.3`\n");
    write(target, ".cursor/rules/fcop-protocol.mdc", "> Rules version: `3.2.3` · Protocol commentary version: `3.2.3`\n");
    write(target, "fcop/ledger/views/ADMIN.closed_parent_residue.md", "old projection\n");
    write(target, "fcop/logs/runtime/runtime-events.jsonl", '{"event":"before"}\n');
    const plan = compatiblePlan(source, target);
    const activeLedger = await acquireProjectWriteLease(target, "ledger.rebuild");
    const transactionPromise = new FcopInitTransaction(plan).execute(
      plan.plan_digest,
      () => {
        write(target, "fcop/ledger/views/ADMIN.closed_parent_residue.md", "projection rebuilt during postflight\n");
        write(target, "fcop/logs/runtime/runtime-events.jsonl", '{"event":"during"}\n');
        return { ok: true };
      },
    );
    await waitUntil(() => existsSync(projectInitializationLockPath(target)));

    const taskWriter = withProjectWriteLease(target, "task-arrival", () => {
      write(target, "fcop/tasks/TASK-20260803-999-ADMIN-to-PM.md", "---\ntask_id: TASK-20260803-999\nfrom: ADMIN\nto: PM\nstatus: pending\n---\n\nConcurrent task\n");
    });
    const reportWriter = withProjectWriteLease(target, "approval-and-report", () => {
      write(target, "fcop/reports/REPORT-20260803-999-PM-to-ADMIN.md", "---\nreport_id: REPORT-20260803-999\ntask_id: TASK-20260803-999\nfrom: PM\nto: ADMIN\nstatus: done\n---\n\nConcurrent report\n");
      write(target, ".codeflowmu/operation-approvals/records/APPROVAL-CONCURRENT.json", '{"status":"approved"}\n');
    });
    activeLedger.release();

    const result = await transactionPromise;
    await Promise.all([taskWriter, reportWriter]);
    await flushScheduledLedgerRebuild(target);
    assert.equal(result.rolled_back.length, 0);
    assert.equal(existsSync(projectInitializationLockPath(target)), false);
    assert.equal(existsSync(join(target, "fcop/tasks/TASK-20260803-999-ADMIN-to-PM.md")), true);
    assert.equal(existsSync(join(target, "fcop/reports/REPORT-20260803-999-PM-to-ADMIN.md")), true);
    assert.equal(existsSync(join(target, ".codeflowmu/operation-approvals/records/APPROVAL-CONCURRENT.json")), true);
    assert.equal(readFileSync(join(target, "fcop/logs/runtime/runtime-events.jsonl"), "utf8"), '{"event":"during"}\n');
    assert.match(readFileSync(join(target, "fcop/ledger/tasks.jsonl"), "utf8"), /TASK-20260803-999/);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
