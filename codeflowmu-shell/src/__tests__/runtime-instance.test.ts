import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ensureRuntimeInstance,
  parseRuntimeLaunchArgs,
  runtimeInstancePath,
  runtimeInstanceRegistryPath,
  runtimeInstanceStateRoot,
  runtimeScopedAgentKey,
} from "../runtime-instance.ts";
import { acquireRuntimeWriterLocks } from "../runtime-writer-lock.ts";

test("runtime instance survives restart but rotates after clone/copy", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-runtime-stable-"));
  const copiedRoot = mkdtempSync(join(tmpdir(), "cf-runtime-candidate-"));
  const previousMachine = process.env.CODEFLOWMU_MACHINE_ID;
  try {
    process.env.CODEFLOWMU_MACHINE_ID = "machine-a";
    const first = ensureRuntimeInstance({
      hostRoot: root,
      projectRoot: root,
      panelPort: 18766,
      instanceRole: "stable",
    });
    const restarted = ensureRuntimeInstance({
      hostRoot: root,
      projectRoot: root,
      panelPort: 18766,
    });
    assert.equal(restarted.instance_id, first.instance_id);

    mkdirSync(join(copiedRoot, ".codeflowmu"), { recursive: true });
    copyFileSync(
      runtimeInstancePath(root),
      runtimeInstancePath(copiedRoot),
    );
    const candidate = ensureRuntimeInstance({
      hostRoot: copiedRoot,
      projectRoot: copiedRoot,
      panelPort: 18768,
      instanceRole: "candidate",
    });
    assert.notEqual(candidate.instance_id, first.instance_id);
    assert.equal(candidate.instance_role, "candidate");
    assert.equal(candidate.panel_port, 18768);
    assert.equal(candidate.project_root, copiedRoot);

    const saved = JSON.parse(readFileSync(runtimeInstancePath(copiedRoot), "utf8"));
    assert.equal(saved.instance_id, candidate.instance_id);
  } finally {
    if (previousMachine === undefined) delete process.env.CODEFLOWMU_MACHINE_ID;
    else process.env.CODEFLOWMU_MACHINE_ID = previousMachine;
    rmSync(root, { recursive: true, force: true });
    rmSync(copiedRoot, { recursive: true, force: true });
  }
});

test("runtime instance state, registry, agents and sessions share one isolated root", () => {
  const home = mkdtempSync(join(tmpdir(), "cf-runtime-home-"));
  try {
    const rootA = runtimeInstanceStateRoot("cfm-a", home);
    const rootB = runtimeInstanceStateRoot("cfm-b", home);
    assert.notEqual(rootA, rootB);
    assert.equal(runtimeInstanceRegistryPath("cfm-a", home), join(rootA, "projects-registry.json"));
    assert.equal(join(rootA, "agents.json").startsWith(rootA), true);
    assert.equal(join(rootA, "sessions").startsWith(rootA), true);
    assert.notEqual(
      runtimeScopedAgentKey("cfm-a", "PM-01"),
      runtimeScopedAgentKey("cfm-b", "PM-01"),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("different projects cannot share one Runtime data root", () => {
  const rootA = mkdtempSync(join(tmpdir(), "cf-runtime-project-a-"));
  const rootB = mkdtempSync(join(tmpdir(), "cf-runtime-project-b-"));
  const dataRoot = mkdtempSync(join(tmpdir(), "cf-runtime-shared-data-"));
  const first = acquireRuntimeWriterLocks({
    instanceId: "cfm-data-a",
    panelPort: 18766,
    projectRoot: rootA,
    dataDir: dataRoot,
    includeFcopLock: false,
  });
  try {
    assert.throws(
      () =>
        acquireRuntimeWriterLocks({
          instanceId: "cfm-data-b",
          panelPort: 18768,
          projectRoot: rootB,
          dataDir: dataRoot,
          includeFcopLock: false,
        }),
      /already owned/,
    );
  } finally {
    first.release();
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("runtime launch args expose first-class isolation controls", () => {
  const cwd = join(tmpdir(), "cf-cli-root");
  const parsed = parseRuntimeLaunchArgs(
    [
      "--instance",
      "candidate",
      "--project-root",
      "candidate-project",
      "--panel-port=18768",
      "--data-dir",
      "runtime-data",
      "--registry",
      "registry.json",
      "--no-gateway",
    ],
    cwd,
  );
  assert.equal(parsed.instanceRole, "candidate");
  assert.equal(parsed.projectRoot, join(cwd, "candidate-project"));
  assert.equal(parsed.panelPort, 18768);
  assert.equal(parsed.dataDir, join(cwd, "runtime-data"));
  assert.equal(parsed.registryPath, join(cwd, "registry.json"));
  assert.equal(parsed.noGateway, true);
});

test("same project and FCoP root reject a second live writer", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-runtime-lock-"));
  mkdirSync(join(root, "fcop"), { recursive: true });
  const first = acquireRuntimeWriterLocks({
    instanceId: "cfm-lock-a",
    panelPort: 18766,
    projectRoot: root,
    includeFcopLock: true,
  });
  try {
    assert.throws(
      () =>
        acquireRuntimeWriterLocks({
          instanceId: "cfm-lock-b",
          panelPort: 18768,
          projectRoot: root,
          includeFcopLock: true,
        }),
      /already owned/,
    );
  } finally {
    first.release();
  }
  const second = acquireRuntimeWriterLocks({
    instanceId: "cfm-lock-b",
    panelPort: 18768,
    projectRoot: root,
    includeFcopLock: true,
  });
  second.release();
  rmSync(root, { recursive: true, force: true });
});
