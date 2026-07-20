import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import {
  loadReviewDecisionPolicy,
  saveReviewDecisionPolicy,
  enabledTeamRules,
  renderReviewDecisionPolicyPromptBlock,
  policyFilePath,
} from "../ReviewDecisionPolicyLoader.ts";

function createTempProject() {
  const root = join(tmpdir(), `codeflowmu-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function cleanupTempProject(root: string) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe("ReviewDecisionPolicyLoader", () => {
  it("should return safe fallback when project policy and adoptedSource are missing", async () => {
    const root = createTempProject();
    try {
      const policy = await loadReviewDecisionPolicy({
        projectRoot: root,
        initializeIfMissing: false,
      });

      assert.equal(policy.team_name, "开发团队");
      assert.equal(policy.team_type, "software_dev");
      assert.equal(policy.approval_mode, "semi_auto");
      assert.ok(policy.system_invariants.rules.length > 0);
      assert.equal(policy.team_rules.rules.length, 0);
    } finally {
      cleanupTempProject(root);
    }
  });

  it("should copy from adoptedSource when project policy is missing and initializeIfMissing is true", async () => {
    const root = createTempProject();
    const mockAdoptedRoot = createTempProject();
    try {
      // Create fake adoptedSource review-decision-policy.yaml
      const adoptedDir = join(mockAdoptedRoot, "fcop/shared/policies");
      mkdirSync(adoptedDir, { recursive: true });
      const adoptedPath = join(adoptedDir, "review-decision-policy.yaml");
      const yamlContent = `
team_name: 测试专属团队
team_type: qa_automation
approval_mode: manual
system_invariants:
  configurable: false
  rules:
    - id: mock_invariant
      name: 模拟底线规则
      action: fallback_to_human
      description: 模拟描述
team_rules:
  configurable: true
  rules:
    - id: mock_team_rule_1
      name: 模拟团队规则1
      enabled: true
      action: needs_human
      description: 模拟描述1
    - id: mock_team_rule_2
      name: 模拟团队规则2
      enabled: false
      action: needs_human
      description: 模拟描述2
`;
      writeFileSync(adoptedPath, yamlContent, "utf-8");

      const policy = await loadReviewDecisionPolicy({
        projectRoot: root,
        adoptedSourceRoot: mockAdoptedRoot,
        initializeIfMissing: true,
      });

      assert.equal(policy.team_name, "测试专属团队");
      assert.equal(policy.team_type, "qa_automation");
      assert.equal(policy.approval_mode, "manual");
      assert.equal(policy.system_invariants.rules.length, 1);
      assert.equal(policy.system_invariants.rules[0]?.id, "mock_invariant");
      assert.equal(policy.team_rules.rules.length, 2);
      assert.equal(policy.team_rules.rules[0]?.id, "mock_team_rule_1");
      assert.equal(policy.team_rules.rules[0]?.enabled, true);
      assert.equal(policy.team_rules.rules[1]?.id, "mock_team_rule_2");
      assert.equal(policy.team_rules.rules[1]?.enabled, false);

      // Verify that the file was written to the project fcop folder
      const projectPolicyPath = policyFilePath(root);
      assert.ok(existsSync(projectPolicyPath));
    } finally {
      cleanupTempProject(root);
      cleanupTempProject(mockAdoptedRoot);
    }
  });

  it("should prioritize project policy file over adoptedSource when both exist", async () => {
    const root = createTempProject();
    const mockAdoptedRoot = createTempProject();
    try {
      // Project policy
      const projectDir = join(root, "fcop/shared/policies");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(projectDir, "review-decision-policy.yaml"),
        `
team_name: 项目自定团队
team_type: software_dev
approval_mode: auto
system_invariants:
  configurable: false
  rules: []
team_rules:
  configurable: true
  rules: []
`,
        "utf-8"
      );

      // Adopted template
      const adoptedDir = join(mockAdoptedRoot, "fcop/shared/policies");
      mkdirSync(adoptedDir, { recursive: true });
      writeFileSync(
        join(adoptedDir, "review-decision-policy.yaml"),
        `
team_name: 模板团队
team_type: software_dev
approval_mode: manual
system_invariants:
  configurable: false
  rules: []
team_rules:
  configurable: true
  rules: []
`,
        "utf-8"
      );

      const policy = await loadReviewDecisionPolicy({
        projectRoot: root,
        adoptedSourceRoot: mockAdoptedRoot,
        initializeIfMissing: true,
      });

      assert.equal(policy.team_name, "项目自定团队");
      assert.equal(policy.approval_mode, "auto");
    } finally {
      cleanupTempProject(root);
      cleanupTempProject(mockAdoptedRoot);
    }
  });

  it("should return only enabled rules in enabledTeamRules", () => {
    const mockPolicy = {
      team_name: "测试团队",
      team_type: "dev",
      approval_mode: "semi_auto",
      system_invariants: {
        configurable: false as const,
        rules: [],
      },
      team_rules: {
        configurable: true as const,
        rules: [
          { id: "r1", name: "Rule 1", enabled: true, action: "needs_human" as const, description: "D1" },
          { id: "r2", name: "Rule 2", enabled: false, action: "needs_human" as const, description: "D2" },
          { id: "r3", name: "Rule 3", action: "needs_human" as const, description: "D3" },
        ],
      },
    };

    const enabled = enabledTeamRules(mockPolicy);
    assert.equal(enabled.length, 2);
    assert.equal(enabled[0]?.id, "r1");
    assert.equal(enabled[1]?.id, "r3");
  });

  it("should save updates successfully and preserve system invariants", async () => {
    const root = createTempProject();
    const mockAdoptedRoot = createTempProject();
    try {
      // 1. Initial copy setup
      const adoptedDir = join(mockAdoptedRoot, "fcop/shared/policies");
      mkdirSync(adoptedDir, { recursive: true });
      writeFileSync(
        join(adoptedDir, "review-decision-policy.yaml"),
        `
team_name: 默认团队
team_type: software_dev
approval_mode: semi_auto
system_invariants:
  configurable: false
  rules:
    - id: invariant_1
      name: invariant name
      action: fallback_to_human
      description: invariant description
team_rules:
  configurable: true
  rules:
    - id: rule_1
      name: Rule 1
      enabled: true
      action: needs_human
      description: description 1
    - id: rule_2
      name: Rule 2
      enabled: true
      action: needs_human
      description: description 2
`,
        "utf-8"
      );

      // 2. Perform updates
      const updated = await saveReviewDecisionPolicy({
        projectRoot: root,
        adoptedSourceRoot: mockAdoptedRoot,
        updates: {
          team_name: "更新后的团队",
          approval_mode: "manual",
          team_rules: [
            { id: "rule_1", enabled: false },
          ],
        },
      });

      assert.equal(updated.team_name, "更新后的团队");
      assert.equal(updated.team_type, "software_dev");
      assert.equal(updated.approval_mode, "manual");
      
      assert.equal(updated.system_invariants.rules.length, 1);
      assert.equal(updated.system_invariants.rules[0]?.id, "invariant_1");
      
      assert.equal(updated.team_rules.rules.length, 2);
      assert.equal(updated.team_rules.rules[0]?.id, "rule_1");
      assert.equal(updated.team_rules.rules[0]?.enabled, false);
      assert.equal(updated.team_rules.rules[1]?.id, "rule_2");
      assert.equal(updated.team_rules.rules[1]?.enabled, true);

      // Reload and verify
      const reloaded = await loadReviewDecisionPolicy({
        projectRoot: root,
        adoptedSourceRoot: mockAdoptedRoot,
      });
      assert.equal(reloaded.team_name, "更新后的团队");
      assert.equal(reloaded.team_rules.rules[0]?.enabled, false);
    } finally {
      cleanupTempProject(root);
      cleanupTempProject(mockAdoptedRoot);
    }
  });

  it("should fallback gracefully if file is invalid YAML", async () => {
    const root = createTempProject();
    try {
      const projectDir = join(root, "fcop/shared/policies");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, "review-decision-policy.yaml"), "illegal yaml text ::: :", "utf-8");

      const policy = await loadReviewDecisionPolicy({
        projectRoot: root,
        initializeIfMissing: false,
      });

      assert.equal(policy.team_name, "开发团队");
    } finally {
      cleanupTempProject(root);
    }
  });

  it("should render prompt block correctly", () => {
    const mockPolicy = {
      team_name: "开发小队",
      team_type: "devops",
      approval_mode: "semi_auto",
      system_invariants: {
        configurable: false as const,
        rules: [],
      },
      team_rules: {
        configurable: true as const,
        rules: [
          { id: "r1", name: "Rule 1", enabled: true, action: "needs_human" as const, description: "Desc 1" },
        ],
      },
    };

    const prompt = renderReviewDecisionPolicyPromptBlock(mockPolicy);
    assert.match(prompt, /开发小队/);
    assert.match(prompt, /devops/);
    assert.match(prompt, /semi_auto/);
    assert.match(prompt, /r1: Rule 1/);
  });
});
