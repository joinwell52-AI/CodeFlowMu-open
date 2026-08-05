import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildRuntimeProjectBindingPlan,
  diagnoseRuntimeProjectBinding,
  enforceOpenEditionStartupProjectBoundary,
  ensureOpenEditionDefaultProjectRoot,
  loadProjectRegistry,
  projectsRegistryPath,
  resolveActiveProjectRoot,
  resolveRuntimeStartupProjectRoot,
  resolveRuntimeStartupProjectRootDetailed,
  saveProjectRegistry,
} from "../project-registry.ts";
import { buildFcopMcpServer } from "../sdk-factory.ts";

test("project-registry round-trip and switch active id", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-proj-reg-"));
  const regPath = join(dir, "projects-registry.json");
  const bootstrap = join(dir, "bootstrap");
  const chess = join(dir, "xiangqi");
  const go = join(dir, "weiqi");
  for (const p of [bootstrap, chess, go]) {
    mkdirSync(p, { recursive: true });
  }

  saveProjectRegistry(
    "default",
    [
      { id: "default", name: "bootstrap", root: bootstrap },
      { id: "chess", name: "象棋", root: chess },
      { id: "go", name: "围棋", root: go },
    ],
    regPath,
  );

  const loaded = loadProjectRegistry(bootstrap, regPath);
  assert.equal(loaded.loadedFromDisk, true);
  assert.equal(loaded.activeProjectId, "default");
  assert.equal(loaded.projects.length, 3);

  saveProjectRegistry("go", loaded.projects, regPath);
  const again = loadProjectRegistry(bootstrap, regPath);
  assert.equal(again.activeProjectId, "go");
  assert.equal(resolveActiveProjectRoot(bootstrap, regPath), go);
  assert.ok(existsSync(regPath));
  const raw = JSON.parse(readFileSync(regPath, "utf-8")) as {
    activeProjectId: string;
  };
  assert.equal(raw.activeProjectId, "go");

  rmSync(dir, { recursive: true, force: true });
});

test("Open first run creates newproject and never binds Runtime to the install root", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-open-first-run-"));
  const hostRoot = join(dir, "CodeFlowMu-open");
  mkdirSync(hostRoot, { recursive: true });
  try {
    const defaultRoot = ensureOpenEditionDefaultProjectRoot(hostRoot);
    assert.equal(defaultRoot, join(hostRoot, "projects", "newproject"));
    assert.equal(existsSync(defaultRoot), true);

    const resolution = enforceOpenEditionStartupProjectBoundary(
      {
        root: hostRoot,
        source: "instance_project_root",
        activeProjectId: null,
        diagnostics: [],
      },
      hostRoot,
      defaultRoot,
    );
    assert.equal(resolution.root, defaultRoot);
    assert.equal(resolution.source, "open_edition_bootstrap_root");
    assert.ok(resolution.diagnostics.some(({ code }) => code === "OPEN_INSTALL_ROOT_REJECTED"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Open startup reuses an existing newproject without changing its contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-open-existing-default-"));
  const hostRoot = join(dir, "CodeFlowMu-open");
  const existingRoot = join(hostRoot, "projects", "newproject");
  const marker = join(existingRoot, "existing-project-proof.txt");
  mkdirSync(existingRoot, { recursive: true });
  writeFileSync(marker, "preserve-existing-project\n", "utf8");
  try {
    const defaultRoot = ensureOpenEditionDefaultProjectRoot(hostRoot);
    assert.equal(defaultRoot, existingRoot);
    assert.equal(readFileSync(marker, "utf8"), "preserve-existing-project\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Open startup preserves a valid external active project", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-open-external-"));
  const hostRoot = join(dir, "CodeFlowMu-open");
  const externalRoot = join(dir, "external-project");
  mkdirSync(hostRoot, { recursive: true });
  mkdirSync(externalRoot, { recursive: true });
  try {
    const defaultRoot = ensureOpenEditionDefaultProjectRoot(hostRoot);
    const original = {
      root: externalRoot,
      source: "instance_registry_active" as const,
      activeProjectId: "external",
      diagnostics: [],
    };
    assert.equal(
      enforceOpenEditionStartupProjectBoundary(original, hostRoot, defaultRoot),
      original,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("valid instance registry active project wins over stale instance root", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-open-switch-"));
  const regPath = join(dir, "projects-registry.json");
  const installRoot = join(dir, "codeflowmu-shell");
  const externalEmptyProject = join(dir, "workspace", "Famous sayings");
  mkdirSync(installRoot, { recursive: true });
  mkdirSync(externalEmptyProject, { recursive: true });

  try {
    saveProjectRegistry(
      "external",
      [
        { id: "default", name: "shell", root: installRoot },
        { id: "external", name: "Famous sayings", root: externalEmptyProject },
      ],
      regPath,
    );

    const resolution = resolveRuntimeStartupProjectRootDetailed({
        instanceProjectRoot: installRoot,
        openEditionBootstrapRoot: installRoot,
        registryPath: regPath,
        registryBelongsToRuntimeInstance: true,
      });
    assert.equal(resolution.root, externalEmptyProject);
    assert.equal(resolution.source, "instance_registry_active");
    assert.equal(resolution.activeProjectId, "external");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("current code root wins over a global registry from another clone", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-candidate-root-"));
  const regPath = join(dir, "projects-registry.json");
  const stableRoot = join(dir, "stable");
  const candidateRoot = join(dir, "candidate");
  mkdirSync(stableRoot, { recursive: true });
  mkdirSync(candidateRoot, { recursive: true });
  saveProjectRegistry(
    "stable",
    [{ id: "stable", name: "stable", root: stableRoot }],
    regPath,
  );
  assert.equal(
    resolveRuntimeStartupProjectRoot({
      discoveredBootstrapRoot: candidateRoot,
      globalBootstrapRoot: stableRoot,
      registryPath: regPath,
      registryBelongsToRuntimeInstance: false,
    }),
    candidateRoot,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("explicit project root remains the highest startup priority", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-explicit-root-"));
  const explicitRoot = join(dir, "explicit");
  const instanceRoot = join(dir, "instance");
  const registryRoot = join(dir, "registry-active");
  const regPath = join(dir, "projects-registry.json");
  for (const root of [explicitRoot, instanceRoot, registryRoot]) {
    mkdirSync(root, { recursive: true });
  }
  saveProjectRegistry(
    "active",
    [{ id: "active", name: "active", root: registryRoot }],
    regPath,
  );
  const resolution = resolveRuntimeStartupProjectRootDetailed({
    explicitProjectRoot: explicitRoot,
    instanceProjectRoot: instanceRoot,
    registryPath: regPath,
    registryBelongsToRuntimeInstance: true,
  });
  assert.equal(resolution.root, explicitRoot);
  assert.equal(resolution.source, "explicit_project_root");
  rmSync(dir, { recursive: true, force: true });
});

test("missing or corrupt instance registry safely falls back to instance root", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-registry-fallback-"));
  const instanceRoot = join(dir, "instance");
  const missingPath = join(dir, "missing.json");
  const corruptPath = join(dir, "corrupt.json");
  mkdirSync(instanceRoot, { recursive: true });
  writeFileSync(corruptPath, "{ broken", "utf8");

  const missing = resolveRuntimeStartupProjectRootDetailed({
    instanceProjectRoot: instanceRoot,
    registryPath: missingPath,
    registryBelongsToRuntimeInstance: true,
  });
  assert.equal(missing.root, instanceRoot);
  assert.equal(missing.source, "instance_project_root");
  assert.ok(missing.diagnostics.some(({ code }) => code === "INSTANCE_REGISTRY_MISSING"));

  const corrupt = resolveRuntimeStartupProjectRootDetailed({
    instanceProjectRoot: instanceRoot,
    registryPath: corruptPath,
    registryBelongsToRuntimeInstance: true,
  });
  assert.equal(corrupt.root, instanceRoot);
  assert.ok(corrupt.diagnostics.some(({ code }) => code === "INSTANCE_REGISTRY_INVALID"));
  rmSync(dir, { recursive: true, force: true });
});

test("disappeared active project falls back and emits a startup diagnostic", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-active-missing-"));
  const instanceRoot = join(dir, "instance");
  const missingRoot = join(dir, "gone");
  const regPath = join(dir, "projects-registry.json");
  mkdirSync(instanceRoot, { recursive: true });
  saveProjectRegistry(
    "missing",
    [
      { id: "instance", name: "instance", root: instanceRoot },
      { id: "missing", name: "missing", root: missingRoot },
    ],
    regPath,
  );
  const resolution = resolveRuntimeStartupProjectRootDetailed({
    instanceProjectRoot: instanceRoot,
    registryPath: regPath,
    registryBelongsToRuntimeInstance: true,
  });
  assert.equal(resolution.root, instanceRoot);
  assert.ok(resolution.diagnostics.some(({ code }) => code === "ACTIVE_PROJECT_ROOT_MISSING"));
  rmSync(dir, { recursive: true, force: true });
});

test("foreign candidate ignores a stable instance registry", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-foreign-registry-"));
  const stableRoot = join(dir, "stable");
  const candidateRoot = join(dir, "candidate");
  const regPath = join(dir, "stable-registry.json");
  mkdirSync(stableRoot, { recursive: true });
  mkdirSync(candidateRoot, { recursive: true });
  saveProjectRegistry(
    "stable",
    [{ id: "stable", name: "stable", root: stableRoot }],
    regPath,
  );
  const resolution = resolveRuntimeStartupProjectRootDetailed({
    discoveredBootstrapRoot: candidateRoot,
    registryPath: regPath,
    registryBelongsToRuntimeInstance: false,
  });
  assert.equal(resolution.root, candidateRoot);
  assert.equal(resolution.source, "discovered_bootstrap_root");
  assert.ok(resolution.diagnostics.some(({ code }) => code === "INSTANCE_REGISTRY_NOT_OWNED"));
  rmSync(dir, { recursive: true, force: true });
});

test("one active-root binding plan drives Runtime, MCP, watchers and Cursor cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-binding-plan-"));
  const plan = buildRuntimeProjectBindingPlan(root);
  assert.deepEqual(new Set(Object.values(plan)), new Set([root]));

  const mcp = buildFcopMcpServer("python", plan.mcpProjectRoot, ["write_report"]);
  const fcopServer = mcp.fcop as {
    cwd?: string;
    env?: Record<string, string>;
  };
  assert.equal(fcopServer.cwd, root);
  assert.equal(fcopServer.env?.FCOP_PROJECT_DIR, root);

  const ok = diagnoseRuntimeProjectBinding({
    expectedRoot: root,
    instanceProjectRoot: root,
    writerLockProjectRoot: root,
    plan,
  });
  assert.equal(ok.ok, true);
  const mismatch = diagnoseRuntimeProjectBinding({
    expectedRoot: root,
    instanceProjectRoot: join(root, "stale"),
    writerLockProjectRoot: root,
    plan,
  });
  assert.equal(mismatch.code, "ACTIVE_PROJECT_BINDING_MISMATCH");
  assert.ok(mismatch.mismatches.some(({ binding }) => binding === "instance.project_root"));
  rmSync(root, { recursive: true, force: true });
});

test("default registry path is isolated by runtime instance id", () => {
  const previous = process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID;
  try {
    process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID = "cfm-a";
    const a = projectsRegistryPath();
    process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID = "cfm-b";
    const b = projectsRegistryPath();
    assert.notEqual(a, b);
    assert.match(a.replaceAll("\\", "/"), /instances\/cfm-a\/projects-registry\.json$/);
    assert.match(b.replaceAll("\\", "/"), /instances\/cfm-b\/projects-registry\.json$/);
  } finally {
    if (previous === undefined) delete process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID;
    else process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID = previous;
  }
});

test("resolveActiveProjectRoot falls back when persisted active root disappeared", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-proj-reg-missing-"));
  const regPath = join(dir, "projects-registry.json");
  const bootstrap = join(dir, "bootstrap");
  mkdirSync(bootstrap, { recursive: true });
  saveProjectRegistry(
    "missing",
    [
      { id: "default", name: "bootstrap", root: bootstrap },
      { id: "missing", name: "missing", root: join(dir, "gone") },
    ],
    regPath,
  );

  assert.equal(resolveActiveProjectRoot(bootstrap, regPath), bootstrap);
  rmSync(dir, { recursive: true, force: true });
});

test("loaded registry does not invent a duplicate default from the active project root", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-proj-reg-no-default-"));
  const regPath = join(dir, "projects-registry.json");
  const activeRoot = join(dir, "projects", "Luniva");
  mkdirSync(activeRoot, { recursive: true });
  saveProjectRegistry(
    "luniva",
    [{ id: "luniva", name: "Luniva", root: activeRoot }],
    regPath,
  );

  const loaded = loadProjectRegistry(activeRoot, regPath);
  assert.equal(loaded.activeProjectId, "luniva");
  assert.deepEqual(loaded.projects.map((project) => project.id), ["luniva"]);

  rmSync(dir, { recursive: true, force: true });
});
