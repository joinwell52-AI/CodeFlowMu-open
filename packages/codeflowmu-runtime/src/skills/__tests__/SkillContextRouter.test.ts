import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  matchAgentContextSkills,
  resolveAndInjectAgentContextSkills,
} from "../SkillContextRouter.ts";
import { readRecentSkillInvocations } from "../../pm/SkillInvocationJournal.ts";

const MINI_MANIFEST = {
  version: 1,
  kind: "agent_skills_manifest",
  common_skills: [
    {
      id: "web-search",
      display_name: "Web Search",
      skill_package: "skills/web-search/SKILL.md",
      status: "playbook_ready",
    },
    {
      id: "web-extract",
      display_name: "Web Extract",
      skill_package: "skills/web-extract/SKILL.md",
      status: "playbook_ready",
    },
    {
      id: "web-research",
      display_name: "Web Research",
      skill_package: "skills/web-research/SKILL.md",
      status: "playbook_ready",
    },
    {
      id: "browser-playwright-check",
      display_name: "Browser Playwright Check",
      skill_package: "skills/browser-playwright-check/SKILL.md",
      status: "playbook_stub",
    },
    {
      id: "run-local-command-check",
      display_name: "Run Local Command Check",
      skill_package: "skills/run-local-command-check/SKILL.md",
      status: "playbook_stub",
    },
    {
      id: "code-search-navigation",
      display_name: "Code Search Navigation",
      skill_package: "skills/code-search-navigation/SKILL.md",
      status: "playbook_stub",
    },
    {
      id: "test-selection",
      display_name: "Test Selection",
      skill_package: "skills/test-selection/SKILL.md",
      status: "playbook_stub",
    },
  ],
  pm_playbook_skills: [
    ...[
      "pm-product-design-brief",
      "pm-product-requirements",
      "pm-scope-control",
      "pm-delivery-plan",
    ].map((id) => ({
      id,
      display_name: id,
      skill_package: `skills/${id}/SKILL.md`,
      status: "playbook_ready",
    })),
    {
      id: "pm-tech-scope",
      display_name: "PM Tech Scope",
      skill_package: "skills/pm-tech-scope/SKILL.md",
      status: "playbook_stub",
    },
    {
      id: "pm-acceptance-criteria",
      display_name: "PM Acceptance Criteria",
      skill_package: "skills/pm-acceptance-criteria/SKILL.md",
      status: "playbook_stub",
    },
  ],
  ui_playbook_skills: [
    "ui-information-architecture",
    "ui-visual-consistency",
    "ui-usability-acceptance",
  ].map((id) => ({
    id,
    display_name: id,
    skill_package: `skills/${id}/SKILL.md`,
    status: "playbook_ready",
  })),
  dev_playbook_skills: [
    {
      id: "dev-code-location",
      display_name: "DEV Code Location",
      skill_package: "skills/dev-code-location/SKILL.md",
      status: "playbook_stub",
    },
    {
      id: "dev-small-scope-patch",
      display_name: "DEV Small Scope Patch",
      skill_package: "skills/dev-small-scope-patch/SKILL.md",
      status: "playbook_stub",
    },
    {
      id: "dev-test-and-explain",
      display_name: "DEV Test And Explain",
      skill_package: "skills/dev-test-and-explain/SKILL.md",
      status: "playbook_stub",
    },
  ],
  qa_playbook_skills: [
    {
      id: "qa-verify-fix",
      display_name: "QA Verify Fix",
      skill_package: "skills/qa-verify-fix/SKILL.md",
      status: "playbook_stub",
    },
  ],
  ops_playbook_skills: [
    {
      id: "ops-log-diagnosis",
      display_name: "OPS Log Diagnosis",
      skill_package: "skills/ops-log-diagnosis/SKILL.md",
      status: "playbook_stub",
    },
  ],
};

async function makeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cfm-skill-router-"));
  await mkdir(join(root, ".codeflowmu"), { recursive: true });
  await writeFile(
    join(root, ".codeflowmu", "agent-skills.manifest.json"),
    JSON.stringify(MINI_MANIFEST),
    "utf-8",
  );
  for (const group of [
    ...MINI_MANIFEST.common_skills,
    ...MINI_MANIFEST.pm_playbook_skills,
    ...MINI_MANIFEST.ui_playbook_skills,
    ...MINI_MANIFEST.dev_playbook_skills,
    ...MINI_MANIFEST.qa_playbook_skills,
    ...MINI_MANIFEST.ops_playbook_skills,
  ]) {
    const dir = join(root, group.skill_package.replace(/\/SKILL\.md$/, ""));
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      `# ${group.display_name}\n\nUse only when matched by context.`,
      "utf-8",
    );
  }
  return root;
}

describe("SkillContextRouter", () => {
  it("does not route unrelated chat", () => {
    const matches = matchAgentContextSkills({
      role: "DEV",
      message: "just chatting",
      intent: "chat",
    });
    assert.deepEqual(matches, []);
  });

  it("routes skills by content in chat mode", async () => {
    const root = await makeProject();
    try {
      const result = await resolveAndInjectAgentContextSkills(root, {
        role: "PM",
        message: "web research with sourced report; search the web and extract page tables",
        intent: "chat",
      });
      assert.deepEqual(result.skillIds, ["web-research", "web-search", "web-extract"]);
      assert.match(result.promptBlock, /Web Research/);
      assert.match(result.promptBlock, /Web Search/);
      assert.match(result.promptBlock, /Web Extract/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes Chinese hierarchical research chat to the same skills", () => {
    const matches = matchAgentContextSkills({
      role: "PM",
      message: "调研汽车之家品牌到车系，再筛2026款并抽取详细参数，形成带来源报告",
      intent: "chat",
    });
    assert.deepEqual(matches.map((match) => match.skillId), [
      "web-research",
      "web-search",
      "web-extract",
    ]);
  });

  it("routes PM dispatch to tech-scope without loading every PM skill", async () => {
    const root = await makeProject();
    try {
      const result = await resolveAndInjectAgentContextSkills(root, {
        role: "PM",
        message: "write_task recipient: DEV build a browser game",
        downstreamRole: "DEV",
        taskId: "TASK-1",
        maxSkills: 1,
      });

      assert.deepEqual(result.skillIds, ["pm-tech-scope"]);
      assert.match(result.promptBlock, /PM Tech Scope/);
      assert.doesNotMatch(result.promptBlock, /PM Acceptance Criteria/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes DEV implementation to code-location and small-scope patch only", async () => {
    const root = await makeProject();
    try {
      const result = await resolveAndInjectAgentContextSkills(root, {
        role: "DEV",
        message: "locate the file and fix the bug with a small patch",
        taskId: "TASK-2",
      });

      assert.ok(result.skillIds.includes("dev-code-location"));
      assert.ok(result.skillIds.includes("dev-small-scope-patch"));
      assert.ok(!result.skillIds.includes("pm-tech-scope"));
      assert.ok(result.skillIds.length <= 3);

      const rows = await readRecentSkillInvocations(root, 10);
      assert.ok(
        rows.some(
          (r) =>
            r.channel === "auto_inject" &&
            r.caller_role === "DEV" &&
            r.skill_id === "dev-small-scope-patch",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes QA and OPS by task situation", async () => {
    const root = await makeProject();
    try {
      const qa = await resolveAndInjectAgentContextSkills(root, {
        role: "QA",
        intent: "verify",
        message: "verify the fix and collect evidence",
      });
      const ops = await resolveAndInjectAgentContextSkills(root, {
        role: "OPS",
        message: "diagnose the error from runtime logs",
      });

      assert.deepEqual(qa.skillIds, ["qa-verify-fix"]);
      assert.deepEqual(ops.skillIds, ["ops-log-diagnosis"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes browser-visible work to the common Playwright skill", async () => {
    const root = await makeProject();
    try {
      const result = await resolveAndInjectAgentContextSkills(root, {
        role: "QA",
        intent: "verify",
        message: "use Playwright to open the page, click the form, and capture a mobile screenshot",
      });

      assert.ok(result.skillIds.includes("browser-playwright-check"));
      assert.ok(result.skillIds.includes("qa-verify-fix"));
      assert.match(result.promptBlock, /Browser Playwright Check/);
      assert.ok(result.skillIds.length <= 3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes sourced web research to search, extract, and research skills", async () => {
    const root = await makeProject();
    try {
      const result = await resolveAndInjectAgentContextSkills(root, {
        role: "PM",
        message:
          "搜索网页并做竞品调研，打开动态页面提取正文和表格，最后给出带来源链接的报告",
      });

      assert.deepEqual(result.skillIds, [
        "web-research",
        "web-search",
        "web-extract",
      ]);
      assert.match(result.promptBlock, /Web Research/);
      assert.match(result.promptBlock, /Web Search/);
      assert.match(result.promptBlock, /Web Extract/);
      assert.doesNotMatch(result.promptBlock, /Browser Playwright Check/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not route PM self-contained smoke (TASK-029) to pm-tech-scope dispatch", async () => {
    const root = await makeProject();
    try {
      const message = [
        "开启 Google PM 最小闭环冒烟。",
        "禁止：不调用 write_task；不派 DEV / OPS / QA。",
        "PM 不派发下游。Only produce final report for TASK-20260607-029.",
      ].join("\n");
      const result = await resolveAndInjectAgentContextSkills(root, {
        role: "PM",
        message,
        downstreamRole: "DEV",
        taskId: "TASK-20260607-029",
        maxSkills: 3,
      });

      assert.ok(!result.skillIds.includes("pm-tech-scope"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes baseline engineering checks without loading the catalog", async () => {
    const root = await makeProject();
    try {
      const result = await resolveAndInjectAgentContextSkills(root, {
        role: "PM",
        message:
          "use rg to locate the route, then run npm typecheck and decide which tests to run",
      });

      assert.ok(result.skillIds.includes("code-search-navigation"));
      assert.ok(result.skillIds.includes("run-local-command-check"));
      assert.ok(result.skillIds.includes("test-selection"));
      assert.equal(result.skillIds.length, 3);
      assert.match(result.promptBlock, /Code Search Navigation/);
      assert.match(result.promptBlock, /Run Local Command Check/);
      assert.match(result.promptBlock, /Test Selection/);
      assert.doesNotMatch(result.promptBlock, /Browser Playwright Check/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads the complete minimum PM/UI playbook set for a product delivery", async () => {
    const root = await makeProject();
    try {
      const taskId = "TASK-20260712-001";
      const result = await resolveAndInjectAgentContextSkills(root, {
        role: "PM",
        message: "创建一个中文名言名句 Web 应用，包含 UI、交互和手机响应式布局",
        intent: "task",
        taskId,
        maxSkills: 3,
      });
      assert.deepEqual(result.skillIds, [
        "pm-product-design-brief",
        "pm-product-requirements",
        "pm-scope-control",
        "pm-acceptance-criteria",
        "pm-delivery-plan",
        "ui-information-architecture",
        "ui-visual-consistency",
        "ui-usability-acceptance",
      ]);
      assert.match(result.promptBlock, /Product Design Gate \(runtime-enforced\)/);
      assert.match(result.promptBlock, new RegExp(`PRODUCT-BRIEF-${taskId}`));
      const rows = await readRecentSkillInvocations(root, 20);
      assert.equal(
        rows.filter((row) => row.task_id === taskId && row.outcome === "ok").length,
        8,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes native Windows application tasks to Windows Use", () => {
    const matches = matchAgentContextSkills({
      role: "DEV",
      message: "Use Windows Use to inspect and operate the native Notepad desktop app",
      maxSkills: 3,
    });
    assert.ok(matches.some((match) => match.skillId === "windows-use"));
  });
});
