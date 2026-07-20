import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  loadProjectRegistry,
  resolveActiveProjectRoot,
  resolveRuntimeStartupProjectRoot,
  saveProjectRegistry,
} from "../project-registry.ts";

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

test("Open restart uses persisted external project instead of install bootstrap root", () => {
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

    assert.equal(
      resolveRuntimeStartupProjectRoot(installRoot, null, regPath),
      externalEmptyProject,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
