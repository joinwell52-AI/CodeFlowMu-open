import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  formatDevelopmentProjectContextBlock,
  readDevelopmentProjectContext,
} from "../project-context-prompt.ts";

test("只把正式注册表项目作为开发项目，忽略用户级 runtime slots", async () => {
  const root = await mkdtemp(join(tmpdir(), "codeflowmu-project-context-"));
  const hostRoot = join(root, "codeflowmu");
  const adoptedRoot = join(root, "OCRCARD");
  const runtimeDataRoot = join(root, ".codeflowmu");
  const registryPath = join(runtimeDataRoot, "v2", "projects-registry.json");
  mkdirSync(hostRoot, { recursive: true });
  mkdirSync(adoptedRoot, { recursive: true });
  mkdirSync(join(runtimeDataRoot, "projects", "flowday-sign"), {
    recursive: true,
  });
  mkdirSync(join(runtimeDataRoot, "projects", "newproject"), {
    recursive: true,
  });
  mkdirSync(join(runtimeDataRoot, "v2"), { recursive: true });
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      activeProjectId: "ocrcard",
      projects: [
        { id: "default", name: "codeflowmu", root: hostRoot },
        { id: "ocrcard", name: "OCRCARD", root: adoptedRoot },
      ],
    }),
    "utf-8",
  );

  const context = readDevelopmentProjectContext({
    hostRoot,
    activeRoot: adoptedRoot,
    runtimeDataRoot,
    registryPath,
  });
  assert.deepEqual(
    context.registeredProjects.map((project) => project.name),
    ["codeflowmu", "OCRCARD"],
  );
  assert.equal(context.activeProject?.name, "OCRCARD");
  assert.equal(context.projectsCollectionExists, false);

  const prompt = formatDevelopmentProjectContextBlock({
    hostRoot,
    activeRoot: adoptedRoot,
    runtimeDataRoot,
    registryPath,
  });
  assert.match(prompt, /OCRCARD: .*OCRCARD（当前）/);
  assert.match(prompt, /目录尚未创建/);
  assert.match(prompt, /严禁把其子目录统计或描述为开发项目/);
  assert.match(prompt, /`newproject` 仅是 Open 版/);
  assert.doesNotMatch(prompt, /flowday-sign:/);
  assert.doesNotMatch(prompt, /newproject:/);
});

test("Open 托底 newproject 不计入正式注册项目", async () => {
  const root = await mkdtemp(join(tmpdir(), "codeflowmu-open-context-"));
  const hostRoot = join(root, "CodeFlowMu-open");
  const fallbackRoot = join(hostRoot, "projects", "newproject");
  const registryPath = join(root, "projects-registry.json");
  mkdirSync(fallbackRoot, { recursive: true });
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      activeProjectId: "open-default-newproject",
      projects: [
        {
          id: "open-default-newproject",
          name: "newproject",
          root: fallbackRoot,
        },
      ],
    }),
    "utf-8",
  );

  const context = readDevelopmentProjectContext({
    hostRoot,
    activeRoot: fallbackRoot,
    registryPath,
  });
  assert.equal(context.registeredProjects.length, 0);
  assert.equal(context.activeProject, null);
});
