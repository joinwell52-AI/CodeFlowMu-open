import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AgentSkillsManifestInvalidError,
  buildAgentSkillsCatalog,
  loadAgentSkillsCatalog,
  readAgentSkillsManifestResolved,
} from "../AgentPlaybookCatalog.ts";
import { plantAgentSkillsManifestIfMissing } from "../AgentPlaybookManifest.ts";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("AgentPlaybookCatalog", () => {
  it("buildAgentSkillsCatalog groups common and role skills", () => {
    const data = {
      version: 1,
      kind: "agent_skills_manifest",
      common_skills: [
        { id: "read_task", display_name: "读任务", status: "partially_implemented" },
      ],
      pm_playbook_skills: [
        {
          id: "pm-scope-control",
          display_name: "范围控制",
          skill_package: "skills/pm-scope-control/SKILL.md",
          status: "playbook_stub",
        },
      ],
      dev_playbook_skills: [
        {
          id: "dev-code-location",
          display_name: "DEV 代码定位",
          doc: "docs/skills/dev-playbook/code-location.md",
          skill_package: "skills/dev-code-location/SKILL.md",
          status: "playbook_stub",
        },
      ],
      role_skills: {
        PM: {
          status: "implemented",
          implemented_skills: [{ id: "pm.summarize_thread", display_name: "摘要" }],
        },
        DEV: {
          status: "playbook_stub_only",
          playbook_skills: ["dev-code-location"],
        },
      },
      forbidden_v1: ["auto_archive_all"],
    };
    const catalog = buildAgentSkillsCatalog(data, {
      read_from: "source",
      path: "/tmp/manifest.json",
      source_path: "/tmp/source.json",
    });
    assert.equal(catalog.counts.total_entries, 5);
    assert.equal(catalog.counts.common, 1);
    assert.equal(catalog.counts.playbook_packages, 2);
    assert.equal(catalog.groups.length, 4);
    const roleGroup = catalog.groups.find((g) => g.id === "role_skills");
    const devRef = roleGroup?.skills.find((s) => s.id === "dev-code-location");
    assert.equal(devRef?.display_name, "DEV 代码定位");
    assert.equal(devRef?.doc, "docs/skills/dev-playbook/code-location.md");
    assert.equal(devRef?.skill_package, "skills/dev-code-location/SKILL.md");
    assert.deepEqual(catalog.forbidden_v1, ["auto_archive_all"]);
  });

  it("readAgentSkillsManifestResolved prefers projection after plant", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-catalog-"));
    try {
      await mkdir(join(root, "docs", "skills"), { recursive: true });
      const sourcePayload = {
        version: 1,
        kind: "agent_skills_manifest",
        common_skills: [{ id: "a", display_name: "A", status: "playbook_stub" }],
      };
      await writeFile(
        join(root, "docs", "skills", "agent-skills.manifest.json"),
        `${JSON.stringify(sourcePayload)}\n`,
        "utf-8",
      );
      await plantAgentSkillsManifestIfMissing(root);
      const resolved = await readAgentSkillsManifestResolved(root);
      assert.equal(resolved.read_from, "projection");
      const catalog = buildAgentSkillsCatalog(resolved.data, resolved);
      assert.equal(catalog.groups[0]?.skills[0]?.id, "a");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to the source manifest when the projection JSON is invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-catalog-invalid-projection-"));
    try {
      await mkdir(join(root, "docs", "skills"), { recursive: true });
      await mkdir(join(root, ".codeflowmu"), { recursive: true });
      await writeFile(
        join(root, ".codeflowmu", "agent-skills.manifest.json"),
        "+{\n",
        "utf-8",
      );
      await writeFile(
        join(root, "docs", "skills", "agent-skills.manifest.json"),
        `${JSON.stringify({ version: 1, kind: "agent_skills_manifest" })}\n`,
        "utf-8",
      );

      const resolved = await readAgentSkillsManifestResolved(root);
      assert.equal(resolved.read_from, "source");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports invalid JSON instead of misreporting a missing manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-catalog-invalid-both-"));
    try {
      await mkdir(join(root, "docs", "skills"), { recursive: true });
      await mkdir(join(root, ".codeflowmu"), { recursive: true });
      await writeFile(
        join(root, ".codeflowmu", "agent-skills.manifest.json"),
        "+{\n",
        "utf-8",
      );
      await writeFile(
        join(root, "docs", "skills", "agent-skills.manifest.json"),
        "+{\n",
        "utf-8",
      );

      await assert.rejects(
        () => readAgentSkillsManifestResolved(root),
        (error: unknown) => {
          assert.ok(error instanceof AgentSkillsManifestInvalidError);
          assert.match(error.message, /invalid agent skills manifest JSON/);
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enriches package descriptions from SKILL.md frontmatter", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-catalog-desc-"));
    try {
      await mkdir(join(root, "docs", "skills"), { recursive: true });
      await mkdir(join(root, "skills", "dev-code-location"), { recursive: true });
      const sourcePayload = {
        version: 1,
        kind: "agent_skills_manifest",
        dev_playbook_skills: [
          {
            id: "dev-code-location",
            display_name: "DEV 代码定位",
            skill_package: "skills/dev-code-location/SKILL.md",
            status: "playbook_stub",
          },
        ],
      };
      await writeFile(
        join(root, "docs", "skills", "agent-skills.manifest.json"),
        `${JSON.stringify(sourcePayload)}\n`,
        "utf-8",
      );
      await writeFile(
        join(root, "skills", "dev-code-location", "SKILL.md"),
        "---\nname: dev-code-location\ndescription: Locate relevant code before editing.\n---\n\n# DEV Code Location\n",
        "utf-8",
      );

      const catalog = await loadAgentSkillsCatalog(root);
      const skill = catalog.groups[0]?.skills[0];
      assert.equal(skill?.package_exists, true);
      assert.equal(skill?.description, "Locate relevant code before editing.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads common skill packages from the mother application for an adopted project", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cfm-catalog-adopted-"));
    const hostRoot = await mkdtemp(join(tmpdir(), "cfm-catalog-host-"));
    const previousHostRoot = process.env.CODEFLOWMU_HOST_ROOT;
    try {
      await mkdir(join(projectRoot, ".codeflowmu"), { recursive: true });
      await mkdir(join(hostRoot, "skills", "shared-skill"), { recursive: true });
      await writeFile(
        join(projectRoot, ".codeflowmu", "agent-skills.manifest.json"),
        JSON.stringify({
          version: 1,
          kind: "agent_skills_manifest",
          common_skills: [{
            id: "shared-skill",
            display_name: "Shared Skill",
            skill_package: "skills/shared-skill/SKILL.md",
            status: "implemented",
          }],
        }),
        "utf-8",
      );
      await writeFile(
        join(hostRoot, "skills", "shared-skill", "SKILL.md"),
        "---\nname: shared-skill\ndescription: Shared by the mother application.\n---\n",
        "utf-8",
      );
      process.env.CODEFLOWMU_HOST_ROOT = hostRoot;

      const catalog = await loadAgentSkillsCatalog(projectRoot);
      const skill = catalog.groups[0]?.skills[0];
      assert.equal(skill?.package_exists, true);
      assert.equal(skill?.description, "Shared by the mother application.");
    } finally {
      if (previousHostRoot === undefined) delete process.env.CODEFLOWMU_HOST_ROOT;
      else process.env.CODEFLOWMU_HOST_ROOT = previousHostRoot;
      await rm(projectRoot, { recursive: true, force: true });
      await rm(hostRoot, { recursive: true, force: true });
    }
  });
});
