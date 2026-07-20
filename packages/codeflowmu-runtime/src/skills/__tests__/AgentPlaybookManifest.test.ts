import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  agentSkillsManifestProjectionPath,
  agentSkillsManifestSourcePath,
  plantAgentSkillsManifestIfMissing,
} from "../AgentPlaybookManifest.ts";

describe("AgentPlaybookManifest", () => {
  it("plantAgentSkillsManifestIfMissing copies from docs/skills when projection missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-agent-manifest-"));
    try {
      const source = agentSkillsManifestSourcePath(root);
      await mkdir(join(root, "docs", "skills"), { recursive: true });
      const payload = JSON.stringify({ version: 1, kind: "agent_skills_manifest" }, null, 2);
      await writeFile(source, `${payload}\n`, "utf-8");

      const first = await plantAgentSkillsManifestIfMissing(root);
      assert.equal(first.planted, true);
      assert.equal(first.sourceMissing, false);

      const proj = agentSkillsManifestProjectionPath(root);
      const copied = await readFile(proj, "utf-8");
      assert.equal(copied.trim(), payload);

      const second = await plantAgentSkillsManifestIfMissing(root);
      assert.equal(second.planted, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("plantAgentSkillsManifestIfMissing does not overwrite existing projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-agent-manifest-"));
    try {
      const proj = agentSkillsManifestProjectionPath(root);
      await mkdir(join(root, ".codeflowmu"), { recursive: true });
      await writeFile(proj, '{"version":1,"kind":"local-only"}\n', "utf-8");

      const result = await plantAgentSkillsManifestIfMissing(root);
      assert.equal(result.planted, false);
      const kept = await readFile(proj, "utf-8");
      assert.match(kept, /local-only/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("plantAgentSkillsManifestIfMissing can copy from a host source root into an external project", async () => {
    const hostRoot = await mkdtemp(join(tmpdir(), "cfm-agent-host-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "cfm-agent-project-"));
    try {
      const source = agentSkillsManifestSourcePath(hostRoot);
      await mkdir(join(hostRoot, "docs", "skills"), { recursive: true });
      const payload = JSON.stringify({ version: 1, kind: "agent_skills_manifest", common_skills: [] }, null, 2);
      await writeFile(source, `${payload}\n`, "utf-8");

      const result = await plantAgentSkillsManifestIfMissing(projectRoot, {
        sourceRoot: hostRoot,
      });
      assert.equal(result.planted, true);
      assert.equal(result.sourceMissing, false);
      assert.equal(result.sourcePath, source);

      const copied = await readFile(agentSkillsManifestProjectionPath(projectRoot), "utf-8");
      assert.equal(copied.trim(), payload);
    } finally {
      await rm(hostRoot, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
