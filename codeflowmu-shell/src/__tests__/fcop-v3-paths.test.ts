import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  fcopV3Paths,
  detectLegacyV2Dirs,
  detectLegacyV2OnlyDirs,
  checkFcop0002WorkFolders,
  checkRoleTemplateHealth,
  detectFcopLayoutRisks,
  findTaskFile,
  countInboxTasks,
  verifyFcopProjectInit,
  checkSkillsManifestHealth,
  AGENT_SKILLS_SOURCE_REL,
} from "../fcop-v3-paths.ts";

test("fcopV3Paths returns v3 lifecycle dirs", () => {
  const p = fcopV3Paths("/proj");
  assert.equal(p.inbox, join("/proj", "fcop", "_lifecycle", "inbox"));
  assert.equal(p.archive, join("/proj", "fcop", "_lifecycle", "archive"));
  assert.equal(p.failures, join("/proj", "fcop", "internal", "failures"));
});

test("detectLegacyV2OnlyDirs flags log/ only — not 0002 tasks/", () => {
  const root = mkdtempSync(join(tmpdir(), "fcop-v3-"));
  try {
    mkdirSync(join(root, "fcop", "tasks"), { recursive: true });
    assert.deepEqual(detectLegacyV2OnlyDirs(root), []);
    assert.deepEqual(detectLegacyV2Dirs(root), []);
    mkdirSync(join(root, "fcop", "log"), { recursive: true });
    assert.deepEqual(detectLegacyV2OnlyDirs(root), ["log"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkFcop0002WorkFolders reports all five dirs", () => {
  const root = mkdtempSync(join(tmpdir(), "fcop-0002-"));
  try {
    for (const d of ["tasks", "reports", "issues", "ledger", "attachments"]) {
      mkdirSync(join(root, "fcop", d), { recursive: true });
    }
    const folders = checkFcop0002WorkFolders(root);
    assert.equal(folders.length, 5);
    assert.ok(folders.every((f) => f.exists));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectFcopLayoutRisks — protocolless fragment", () => {
  const root = mkdtempSync(join(tmpdir(), "fcop-risk-"));
  try {
    const paths = fcopV3Paths(root);
    mkdirSync(paths.inbox, { recursive: true });
    mkdirSync(join(root, "fcop", "tasks"), { recursive: true });
    mkdirSync(join(root, "fcop", "ledger"), { recursive: true });
    writeFileSync(
      join(root, "fcop", "tasks", "TASK-20260531-001-PM-to-DEV.md"),
      "# no frontmatter\n",
    );
    const risks = detectFcopLayoutRisks(root);
    assert.ok(
      risks.some((r) => r.kind === "protocolless_fragment"),
      "expected protocolless_fragment risk",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findTaskFile locates TASK in inbox", () => {
  const root = mkdtempSync(join(tmpdir(), "fcop-v3-find-"));
  try {
    const paths = fcopV3Paths(root);
    mkdirSync(paths.inbox, { recursive: true });
    writeFileSync(join(paths.inbox, "TASK-20260524-001-PM-to-OPS.md"), "---\n");
    const found = findTaskFile(paths, "TASK-20260524-001-PM-to-OPS.md");
    assert.ok(found);
    assert.equal(found!.dir, paths.inbox);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("countInboxTasks counts TASK-*.md only", () => {
  const root = mkdtempSync(join(tmpdir(), "fcop-v3-count-"));
  try {
    const paths = fcopV3Paths(root);
    mkdirSync(paths.inbox, { recursive: true });
    writeFileSync(join(paths.inbox, "TASK-20260524-001-PM-to-OPS.md"), "");
    writeFileSync(join(paths.inbox, "PLAN-20260524-001-ADMIN-to-PM.md"), "");
    assert.equal(countInboxTasks(paths.inbox), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkRoleTemplateHealth skips when fcop.json missing", () => {
  const root = mkdtempSync(join(tmpdir(), "fcop-v3-role-"));
  try {
    const h = checkRoleTemplateHealth(root);
    assert.equal(h.applicable, false);
    assert.equal(h.ok, true);
    assert.equal(h.missing.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkRoleTemplateHealth ok when Rule 4.5 docs present", () => {
  const root = mkdtempSync(join(tmpdir(), "fcop-v3-role-"));
  try {
    mkdirSync(join(root, "fcop", "shared", "roles"), { recursive: true });
    writeFileSync(join(root, "fcop", "fcop.json"), JSON.stringify({ mode: "team", team: "dev-team", leader: "PM", roles: ["PM", "DEV", "QA", "OPS"] }));
    writeFileSync(join(root, "fcop", "shared", "TEAM-ROLES.md"), "# roles");
    writeFileSync(join(root, "fcop", "shared", "TEAM-OPERATING-RULES.md"), "# rules");
    for (const code of ["PM", "DEV", "QA", "OPS"]) {
      writeFileSync(join(root, "fcop", "shared", "roles", `${code}.md`), `# ${code}`);
    }
    const h = checkRoleTemplateHealth(root, { team: "dev-team", leader: "PM", roles: ["PM", "DEV", "QA", "OPS"], mode: "team" });
    assert.equal(h.applicable, true);
    assert.equal(h.ok, true);
    assert.equal(h.missing.length, 0);
    assert.equal(h.ghostInit, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkRoleTemplateHealth fails and ghostInit when marker without docs", () => {
  const root = mkdtempSync(join(tmpdir(), "fcop-v3-role-"));
  try {
    mkdirSync(join(root, "fcop", "shared"), { recursive: true });
    writeFileSync(join(root, "fcop", "fcop.json"), JSON.stringify({ mode: "team", team: "dev-team" }));
    writeFileSync(join(root, "fcop", "shared", ".deployed_version"), "3.2.3");
    const h = checkRoleTemplateHealth(root, { mode: "team", team: "dev-team" });
    assert.equal(h.applicable, true);
    assert.equal(h.ok, false);
    assert.equal(h.ghostInit, true);
    assert.ok(h.missing.length >= 2);
    assert.ok(h.summary.includes("半初始化"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkRoleTemplateHealth fails when single role doc missing", () => {
  const root = mkdtempSync(join(tmpdir(), "fcop-v3-role-"));
  try {
    mkdirSync(join(root, "fcop", "shared", "roles"), { recursive: true });
    writeFileSync(join(root, "fcop", "fcop.json"), JSON.stringify({ mode: "team", team: "dev-team" }));
    writeFileSync(join(root, "fcop", "shared", "TEAM-ROLES.md"), "# roles");
    writeFileSync(join(root, "fcop", "shared", "TEAM-OPERATING-RULES.md"), "# rules");
    writeFileSync(join(root, "fcop", "shared", "roles", "PM.md"), "# PM");
    const h = checkRoleTemplateHealth(root, { mode: "team", roles: ["PM", "DEV"] });
    assert.equal(h.ok, false);
    assert.deepEqual(h.missing, ["fcop/shared/roles/DEV.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyFcopProjectInit fails when fcop.json missing", () => {
  const root = mkdtempSync(join(tmpdir(), "fcop-init-verify-"));
  try {
    const v = verifyFcopProjectInit(root);
    assert.equal(v.ok, false);
    assert.ok(v.failures.some((f) => f.includes("fcop/fcop.json")));
    assert.ok(v.items.some((i) => i.id === "fcop_json" && i.status === "fail"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkSkillsManifestHealth skips when fcop.json missing", () => {
  const root = mkdtempSync(join(tmpdir(), "fcop-skills-"));
  try {
    const h = checkSkillsManifestHealth(root);
    assert.equal(h.applicable, false);
    assert.equal(h.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkSkillsManifestHealth fails when agent source and projection are both missing", () => {
  const root = mkdtempSync(join(tmpdir(), "fcop-skills-"));
  try {
    mkdirSync(join(root, "fcop"), { recursive: true });
    writeFileSync(join(root, "fcop", "fcop.json"), JSON.stringify({ protocol_version: 3 }));
    const h = checkSkillsManifestHealth(root);
    assert.equal(h.applicable, true);
    assert.equal(h.ok, false);
    assert.equal(h.agentSourceExists, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkSkillsManifestHealth accepts external project runtime projection without docs source", () => {
  const root = mkdtempSync(join(tmpdir(), "fcop-skills-"));
  try {
    mkdirSync(join(root, "fcop"), { recursive: true });
    mkdirSync(join(root, ".codeflowmu"), { recursive: true });
    writeFileSync(join(root, "fcop", "fcop.json"), JSON.stringify({ protocol_version: 3 }));
    writeFileSync(
      join(root, ".codeflowmu", "agent-skills.manifest.json"),
      JSON.stringify({
        version: 1,
        common_skills: [],
        pm_playbook_skills: [],
        technical_manager_playbook_skills: [],
        architect_playbook_skills: [],
        dev_playbook_skills: [],
        qa_playbook_skills: [],
        ops_playbook_skills: [],
        eval_playbook_skills: [],
        ui_playbook_skills: [],
      }),
    );
    const h = checkSkillsManifestHealth(root);
    assert.equal(h.applicable, true);
    assert.equal(h.ok, true);
    assert.equal(h.agentSourceExists, false);
    assert.equal(h.agentProjectionExists, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkSkillsManifestHealth ok with source + projections", () => {
  const root = mkdtempSync(join(tmpdir(), "fcop-skills-"));
  try {
    mkdirSync(join(root, "fcop"), { recursive: true });
    mkdirSync(join(root, "docs", "skills"), { recursive: true });
    mkdirSync(join(root, ".codeflowmu"), { recursive: true });
    writeFileSync(join(root, "fcop", "fcop.json"), JSON.stringify({ protocol_version: 3 }));
    const agentManifest = {
      version: 1,
      common_skills: [{ skill_package: "skills/fcop-task-reading/SKILL.md", skill_id: "fcop.task_reading" }],
      pm_playbook_skills: [],
      technical_manager_playbook_skills: [],
      architect_playbook_skills: [],
      dev_playbook_skills: [],
      qa_playbook_skills: [],
      ops_playbook_skills: [],
      eval_playbook_skills: [],
      ui_playbook_skills: [],
    };
    writeFileSync(join(root, AGENT_SKILLS_SOURCE_REL), JSON.stringify(agentManifest));
    writeFileSync(join(root, ".codeflowmu", "agent-skills.manifest.json"), JSON.stringify(agentManifest));
    mkdirSync(join(root, "skills", "fcop-task-reading"), { recursive: true });
    writeFileSync(join(root, "skills", "fcop-task-reading", "SKILL.md"), "# skill");
    const pmManifest = {
      kind: "pm-builtin-skills",
      skills: [
        { skill_id: "pm.summarize_thread" },
        { skill_id: "pm.detect_thread_stall" },
        { skill_id: "pm.close_admin_task" },
        { skill_id: "pm.wake_downstream" },
        { skill_id: "pm.review_check" },
      ],
    };
    writeFileSync(join(root, ".codeflowmu", "pm-skills.manifest.json"), JSON.stringify(pmManifest));
    const h = checkSkillsManifestHealth(root);
    assert.equal(h.ok, true);
    assert.equal(h.pmSkillCount, 5);
    assert.equal(h.agentCatalogEntries, 1);
    assert.deepEqual(h.missingSkillPackages, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkSkillsManifestHealth resolves common Playbook packages from the mother application", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "fcop-skills-adopted-"));
  const hostRoot = mkdtempSync(join(tmpdir(), "fcop-skills-host-"));
  const previousHostRoot = process.env.CODEFLOWMU_HOST_ROOT;
  try {
    mkdirSync(join(projectRoot, "fcop"), { recursive: true });
    mkdirSync(join(projectRoot, ".codeflowmu"), { recursive: true });
    mkdirSync(join(hostRoot, "skills", "shared-skill"), { recursive: true });
    writeFileSync(join(projectRoot, "fcop", "fcop.json"), JSON.stringify({ protocol_version: 3 }));
    writeFileSync(
      join(projectRoot, ".codeflowmu", "agent-skills.manifest.json"),
      JSON.stringify({
        version: 1,
        common_skills: [{ id: "shared-skill", skill_package: "skills/shared-skill/SKILL.md" }],
      }),
    );
    writeFileSync(join(hostRoot, "skills", "shared-skill", "SKILL.md"), "# shared skill");
    process.env.CODEFLOWMU_HOST_ROOT = hostRoot;

    const h = checkSkillsManifestHealth(projectRoot);
    assert.deepEqual(h.missingSkillPackages, []);
    assert.equal(h.agentCatalogEntries, 1);
  } finally {
    if (previousHostRoot === undefined) delete process.env.CODEFLOWMU_HOST_ROOT;
    else process.env.CODEFLOWMU_HOST_ROOT = previousHostRoot;
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(hostRoot, { recursive: true, force: true });
  }
});

test("verifyFcopProjectInit passes minimal v3 dev-team layout", () => {
  const root = mkdtempSync(join(tmpdir(), "fcop-init-verify-"));
  try {
    const paths = fcopV3Paths(root);
    mkdirSync(paths.inbox, { recursive: true });
    mkdirSync(join(root, "fcop", "shared", "roles"), { recursive: true });
    for (const d of ["tasks", "reports", "issues", "ledger", "attachments"]) {
      mkdirSync(join(root, "fcop", d), { recursive: true });
    }
    writeFileSync(
      join(root, "fcop", "fcop.json"),
      JSON.stringify({ mode: "team", team: "dev-team", leader: "PM", protocol_version: 3, roles: ["PM", "DEV", "QA", "OPS"] }),
    );
    writeFileSync(join(root, "fcop", "shared", "TEAM-ROLES.md"), "# roles");
    writeFileSync(join(root, "fcop", "shared", "TEAM-OPERATING-RULES.md"), "# rules");
    for (const code of ["PM", "DEV", "QA", "OPS"]) {
      writeFileSync(join(root, "fcop", "shared", "roles", `${code}.md`), `# ${code}`);
    }
    mkdirSync(join(root, "docs", "skills"), { recursive: true });
    writeFileSync(
      join(root, "docs", "skills", "agent-skills.manifest.json"),
      JSON.stringify({
        version: 1,
        common_skills: [],
        pm_playbook_skills: [],
        technical_manager_playbook_skills: [],
        architect_playbook_skills: [],
        dev_playbook_skills: [],
        qa_playbook_skills: [],
        ops_playbook_skills: [],
        eval_playbook_skills: [],
        ui_playbook_skills: [],
      }),
    );
    const v = verifyFcopProjectInit(root);
    assert.equal(v.ok, true, v.summary + " failures=" + v.failures.join("; "));
    assert.equal(v.roleTemplateHealth.ok, true);
    assert.equal(v.skillsHealth.ok, true);
    assert.ok(v.items.some((i) => i.id === "skills_manifest"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
