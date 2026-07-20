/**
 * fcop-env-probe unit tests
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  readFcopJsonMeta,
  evaluateFcopEnvGate,
  readShellVersion,
  readFcopRulesVersion,
  readFcopProtocolVersion,
  probeFcopPythonPackages,
  buildProtocolUpgradeReport,
  __resetFcopProbeCacheForTests,
} from "../fcop-env-probe.ts";

const REPO_ROOT = join(import.meta.dirname, "../../..");

test("readShellVersion — reads codeflowmu-shell package.json", () => {
  const fromRepo = readShellVersion(REPO_ROOT);
  assert.match(fromRepo, /^\d+\.\d+/);
  const fromShellPkg = readShellVersion(join(REPO_ROOT, "codeflowmu-shell"));
  assert.equal(fromShellPkg, fromRepo);
});

test("readFcopJsonMeta — reads protocol_version from fcop/fcop.json", () => {
  const meta = readFcopJsonMeta(REPO_ROOT);
  assert.notEqual(meta.protocolVersion, null);
});

test("evaluateFcopEnvGate — codeflowmu repo should be ready", () => {
  const gate = evaluateFcopEnvGate(REPO_ROOT);
  assert.equal(gate.fcopUninitialized, false);
  assert.equal(gate.fcopReady, true);
  assert.equal(gate.fcopRepairRequired, false);
  assert.equal(gate.userMessage, null);
});

test("evaluateFcopEnvGate — incomplete existing project requires initialization repair", () => {
  const root = mkdtempSync(join(tmpdir(), "codeflowmu-fcop-repair-"));
  try {
    mkdirSync(join(root, "fcop"), { recursive: true });
    writeFileSync(join(root, "fcop", "fcop.json"), JSON.stringify({ team: "dev-team" }));
    const gate = evaluateFcopEnvGate(root);
    assert.equal(gate.fcopUninitialized, false);
    assert.equal(gate.fcopRepairRequired, true);
    assert.equal(gate.fcopReady, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readFcopProtocolVersion — reads fcop_protocol_version from fcop-protocol.mdc", () => {
  const v = readFcopProtocolVersion(REPO_ROOT);
  assert.notEqual(v, null);
  assert.match(v!, /^\d+\.\d+/);
});

test("buildProtocolUpgradeReport — structure and drift detection", async () => {
  __resetFcopProbeCacheForTests();
  const probe = await probeFcopPythonPackages();
  const report = buildProtocolUpgradeReport(REPO_ROOT, probe);
  assert.equal(typeof report.needsUpgrade, "boolean");
  assert.equal(typeof report.summary, "string");
  assert.ok(Array.isArray(report.targets));
  assert.equal(report.targets.length, 4);
  assert.ok(Array.isArray(report.adminActions));
  const localRules = readFcopRulesVersion(REPO_ROOT);
  const bundled = report.bundledRulesVersion;
  if (localRules && bundled && localRules !== bundled) {
    assert.equal(report.needsUpgrade, true);
    assert.ok(report.summary.includes("→") || report.summary.includes("待同步"));
  }
});

test("probeFcopPythonPackages — returns fcop fields when Python available", async () => {
  __resetFcopProbeCacheForTests();
  const probe = await probeFcopPythonPackages();
  assert.equal(typeof probe.pythonExecutable, "string");
  assert.equal(typeof probe.fcopMcpImportOk, "boolean");
  // fcop may be null in CI without Python packages — structure must exist
  assert.ok("fcop" in probe);
  assert.ok("fcopMcp" in probe);
});
