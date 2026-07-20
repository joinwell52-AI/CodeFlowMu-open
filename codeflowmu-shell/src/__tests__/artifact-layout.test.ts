import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  executeSingleWorkspaceMigration,
  inferWorkspaceMode,
  planSingleWorkspaceMigration,
  resolveArtifactRoot,
  writeWorkspaceMode,
} from "../artifact-layout.ts";

function writeFcopConfig(root: string, workspaceMode?: "root" | "multi"): void {
  mkdirSync(join(root, "fcop"), { recursive: true });
  writeFileSync(join(root, "fcop", "fcop.json"), JSON.stringify({
    mode: "preset",
    team: "dev-team",
    leader: "PM",
    roles: ["PM", "DEV", "QA", "OPS"],
    lang: "zh",
    version: 3,
    ...(workspaceMode ? { workspace_mode: workspaceMode } : {}),
  }), "utf-8");
}

test("root mode resolves a Chinese project path as the code root", () => {
  const parent = mkdtempSync(join(tmpdir(), "cf-layout-"));
  const root = join(parent, "名言 名句");
  mkdirSync(root, { recursive: true });
  writeFcopConfig(root, "root");
  try {
    const result = resolveArtifactRoot(root, "ignored-slug");
    assert.equal(result.mode, "root");
    assert.equal(result.artifactRoot, root);
    assert.equal(result.relativeArtifactRoot, ".");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("legacy workspace projects remain multi while existing source roots infer root", () => {
  const parent = mkdtempSync(join(tmpdir(), "cf-layout-"));
  const legacy = join(parent, "Famous sayings");
  const existing = join(parent, "existing app");
  mkdirSync(join(legacy, "workspace", "famous-sayings"), { recursive: true });
  mkdirSync(join(existing, "src"), { recursive: true });
  try {
    assert.equal(inferWorkspaceMode(legacy).mode, "multi");
    assert.equal(inferWorkspaceMode(existing).mode, "root");
    assert.equal(resolveArtifactRoot(legacy, "famous-sayings").relativeArtifactRoot, "workspace/famous-sayings");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("newproject keeps the multi-product fallback", () => {
  const parent = mkdtempSync(join(tmpdir(), "cf-layout-"));
  const root = join(parent, "newproject");
  mkdirSync(root, { recursive: true });
  try {
    assert.equal(inferWorkspaceMode(root).mode, "multi");
    assert.equal(inferWorkspaceMode(root).inferredFrom, "default-newproject");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("single-workspace migration dry-run rejects conflicts and execution updates active paths", () => {
  const parent = mkdtempSync(join(tmpdir(), "cf-layout-"));
  const root = join(parent, "Famous sayings");
  const source = join(root, "workspace", "famous-sayings");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "index.html"), "ok", "utf-8");
  writeFcopConfig(root, "multi");
  mkdirSync(join(root, "fcop", "tasks"), { recursive: true });
  const task = join(root, "fcop", "tasks", "TASK-20260712-001-PM-to-DEV.md");
  writeFileSync(task, "artifact: workspace/famous-sayings/index.html", "utf-8");
  try {
    const preview = planSingleWorkspaceMigration(root);
    assert.equal(preview.ok, true);
    const result = executeSingleWorkspaceMigration(root);
    assert.equal(result.moved, 1);
    assert.equal(readFileSync(join(root, "index.html"), "utf-8"), "ok");
    assert.match(readFileSync(task, "utf-8"), /artifact: \.\/index\.html/);
    assert.equal(inferWorkspaceMode(root).mode, "root");
    writeWorkspaceMode(root, "multi");
    assert.equal(inferWorkspaceMode(root).mode, "multi");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
