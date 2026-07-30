import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  agentSkillsManifestProjectionPath,
  agentSkillsManifestSourcePath,
  plantAgentSkillsManifestIfMissing,
  syncAgentPlaybookAssets,
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

  it("syncAgentPlaybookAssets plants every manifest-declared public package into a new project", async () => {
    const hostRoot = await mkdtemp(join(tmpdir(), "cfm-agent-host-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "cfm-agent-project-"));
    try {
      const publicManifest = {
        version: 1,
        kind: "agent_skills_manifest",
        public_skill_package_policy: "all_referenced_packages_required",
        filtered_missing_private_skill_packages: 0,
        common_skills: [
          {
            id: "web-search",
            skill_package: "skills/web-search/SKILL.md",
          },
        ],
        dev_playbook_skills: [
          {
            id: "dev-code-location",
            skill_package: "skills/dev-code-location/SKILL.md",
          },
        ],
      };
      await mkdir(join(hostRoot, "docs", "skills"), { recursive: true });
      await mkdir(join(hostRoot, "skills", "web-search"), { recursive: true });
      await mkdir(join(hostRoot, "skills", "dev-code-location"), { recursive: true });
      await writeFile(
        agentSkillsManifestSourcePath(hostRoot),
        `${JSON.stringify(publicManifest, null, 2)}\n`,
        "utf8",
      );
      await writeFile(join(hostRoot, "skills", "web-search", "SKILL.md"), "# Web Search\n", "utf8");
      await writeFile(
        join(hostRoot, "skills", "dev-code-location", "SKILL.md"),
        "# DEV Code Location\n",
        "utf8",
      );

      const result = await syncAgentPlaybookAssets(projectRoot, { sourceRoot: hostRoot });

      assert.deepEqual(result.copiedSkillPackages, [
        "skills/dev-code-location/SKILL.md",
        "skills/web-search/SKILL.md",
      ]);
      assert.match(
        await readFile(join(projectRoot, "skills", "web-search", "SKILL.md"), "utf8"),
        /Web Search/,
      );
      const docsManifest = JSON.parse(
        await readFile(agentSkillsManifestSourcePath(projectRoot), "utf8"),
      );
      const projectionManifest = JSON.parse(
        await readFile(agentSkillsManifestProjectionPath(projectRoot), "utf8"),
      );
      assert.deepEqual(docsManifest, publicManifest);
      assert.deepEqual(projectionManifest, publicManifest);
    } finally {
      await rm(hostRoot, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("syncAgentPlaybookAssets upgrades old projects without overwriting local skills or entries", async () => {
    const hostRoot = await mkdtemp(join(tmpdir(), "cfm-agent-host-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "cfm-agent-project-"));
    try {
      const publicManifest = {
        version: 2,
        kind: "agent_skills_manifest",
        public_skill_package_policy: "all_referenced_packages_required",
        filtered_missing_private_skill_packages: 0,
        common_skills: [
          {
            id: "shared-skill",
            display_name: "Published shared skill",
            skill_package: "skills/shared-skill/SKILL.md",
          },
          {
            id: "new-public-skill",
            skill_package: "skills/new-public-skill/SKILL.md",
          },
        ],
      };
      const oldProjectManifest = {
        version: 1,
        kind: "agent_skills_manifest",
        filtered_missing_private_skill_packages: 40,
        common_skills: [
          {
            id: "shared-skill",
            display_name: "User-customized shared skill",
            skill_package: "skills/shared-skill/SKILL.md",
          },
          {
            id: "user-local-skill",
            skill_package: "skills/user-local-skill/SKILL.md",
          },
        ],
      };
      await mkdir(join(hostRoot, "docs", "skills"), { recursive: true });
      await mkdir(join(hostRoot, "skills", "shared-skill"), { recursive: true });
      await mkdir(join(hostRoot, "skills", "new-public-skill"), { recursive: true });
      await writeFile(
        agentSkillsManifestSourcePath(hostRoot),
        `${JSON.stringify(publicManifest, null, 2)}\n`,
        "utf8",
      );
      await writeFile(join(hostRoot, "skills", "shared-skill", "SKILL.md"), "host copy\n", "utf8");
      await writeFile(
        join(hostRoot, "skills", "new-public-skill", "SKILL.md"),
        "new public copy\n",
        "utf8",
      );

      await mkdir(join(projectRoot, "docs", "skills"), { recursive: true });
      await mkdir(join(projectRoot, ".codeflowmu"), { recursive: true });
      await mkdir(join(projectRoot, "skills", "shared-skill"), { recursive: true });
      await mkdir(join(projectRoot, "skills", "user-local-skill"), { recursive: true });
      await writeFile(
        agentSkillsManifestSourcePath(projectRoot),
        `${JSON.stringify(oldProjectManifest, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        agentSkillsManifestProjectionPath(projectRoot),
        `${JSON.stringify(oldProjectManifest, null, 2)}\n`,
        "utf8",
      );
      await writeFile(join(projectRoot, "skills", "shared-skill", "SKILL.md"), "user copy\n", "utf8");
      await writeFile(
        join(projectRoot, "skills", "user-local-skill", "SKILL.md"),
        "user local\n",
        "utf8",
      );

      const result = await syncAgentPlaybookAssets(projectRoot, { sourceRoot: hostRoot });

      assert.deepEqual(result.copiedSkillPackages, ["skills/new-public-skill/SKILL.md"]);
      assert.deepEqual(result.preservedSkillPackages, ["skills/shared-skill/SKILL.md"]);
      assert.equal(
        await readFile(join(projectRoot, "skills", "shared-skill", "SKILL.md"), "utf8"),
        "user copy\n",
      );
      assert.equal(
        await readFile(join(projectRoot, "skills", "new-public-skill", "SKILL.md"), "utf8"),
        "new public copy\n",
      );

      const upgraded = JSON.parse(
        await readFile(agentSkillsManifestProjectionPath(projectRoot), "utf8"),
      );
      assert.equal(upgraded.version, 2);
      assert.equal(upgraded.filtered_missing_private_skill_packages, 0);
      assert.equal(upgraded.common_skills.length, 3);
      assert.equal(upgraded.common_skills[0].display_name, "User-customized shared skill");
      assert.ok(upgraded.common_skills.some((entry: { id?: string }) => entry.id === "user-local-skill"));
      assert.ok(upgraded.common_skills.some((entry: { id?: string }) => entry.id === "new-public-skill"));
    } finally {
      await rm(hostRoot, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
