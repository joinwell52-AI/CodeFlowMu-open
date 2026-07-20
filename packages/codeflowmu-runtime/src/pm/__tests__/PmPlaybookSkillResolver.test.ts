import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  matchPmPlaybookSkills,
  resolveAndInjectPmPlaybookSkills,
  formatPmPlaybookAutoInjectBlock,
} from "../PmPlaybookSkillResolver.ts";
import {
  readRecentSkillInvocations,
  skillInvocationJournalPath,
} from "../SkillInvocationJournal.ts";

const MINI_MANIFEST = {
  version: 1,
  pm_playbook_skills: [
    {
      id: "pm-product-design-brief",
      display_name: "PM Product Design Brief",
      skill_package: "skills/pm-product-design-brief/SKILL.md",
      doc: "docs/skills/pm-playbook/product-design-brief.md",
    },
    {
      id: "pm-tech-scope",
      display_name: "PM Tech Scope",
      skill_package: "skills/pm-tech-scope/SKILL.md",
      doc: "docs/skills/pm-playbook/tech-scope.md",
    },
    {
      id: "pm-priority-triage",
      display_name: "PM Priority Triage",
      skill_package: "skills/pm-priority-triage/SKILL.md",
    },
  ],
};

describe("PmPlaybookSkillResolver", () => {
  it("matchPmPlaybookSkills picks pm-tech-scope when dispatching to DEV without stack", () => {
    const matches = matchPmPlaybookSkills(
      "write_task recipient: DEV\n实现登录页",
      "pm_task",
      "DEV",
    );
    assert.ok(matches.some((m) => m.skillId === "pm-tech-scope"));
  });

  it("matchPmPlaybookSkills picks product design brief for product PWA work", () => {
    const matches = matchPmPlaybookSkills(
      "请完成一个产品级 PWA 应用，要求产品名称、页面设计、手机端和 Gateway 访问都由团队完成",
      "pm_task",
      undefined,
      5,
    );
    assert.ok(matches.some((m) => m.skillId === "pm-product-design-brief"));
  });

  it("matchPmPlaybookSkills skips pm-tech-scope when stack is explicit", () => {
    const matches = matchPmPlaybookSkills(
      "write_task to-DEV\n技术栈: Python + FastAPI",
      "pm_task",
      "DEV",
    );
    assert.ok(!matches.some((m) => m.skillId === "pm-tech-scope"));
  });

  it("matchPmPlaybookSkills returns empty for chat intent", () => {
    const matches = matchPmPlaybookSkills("随便聊聊", "chat");
    assert.equal(matches.length, 0);
  });

  it("patrol with no keywords defaults to pm-priority-triage via resolve", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-pm-playbook-"));
    try {
      await mkdir(join(root, ".codeflowmu"), { recursive: true });
      await mkdir(join(root, "docs", "skills"), { recursive: true });
      await writeFile(
        join(root, "docs", "skills", "agent-skills.manifest.json"),
        JSON.stringify(MINI_MANIFEST),
        "utf-8",
      );

      const result = await resolveAndInjectPmPlaybookSkills(root, {
        role: "PM",
        message: "开始巡检",
        intent: "patrol",
      });

      assert.ok(result.skillIds.includes("pm-priority-triage"));
      assert.match(result.promptBlock, /Auto-loaded PM Playbook Skills/);

      const rows = await readRecentSkillInvocations(root, 5);
      assert.ok(
        rows.some(
          (r) =>
            r.channel === "auto_inject" &&
            r.skill_id === "pm-priority-triage",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("non-PM role does not inject", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-pm-playbook-"));
    try {
      const result = await resolveAndInjectPmPlaybookSkills(root, {
        role: "DEV",
        message: "write_task to-QA",
        intent: "pm_task",
      });
      assert.equal(result.promptBlock, "");
      assert.equal(result.skillIds.length, 0);

      const journalPath = skillInvocationJournalPath(root);
      try {
        await readFile(journalPath, "utf-8");
        assert.fail("journal should not exist");
      } catch {
        // expected
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("formatPmPlaybookAutoInjectBlock renders skill headers", () => {
    const block = formatPmPlaybookAutoInjectBlock(
      [{ skillId: "pm-tech-scope", reason: "test reason" }],
      undefined,
    );
    assert.match(block, /pm-tech-scope/);
    assert.match(block, /test reason/);
  });
});
