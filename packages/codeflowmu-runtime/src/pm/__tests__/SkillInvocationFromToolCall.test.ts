import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildPlaybookPathIndex,
  extractPathsFromToolCallPayload,
  resolveSkillIdFromFilePath,
  maybeRecordPlaybookSkillFromToolCall,
  resetPlaybookSkillDedupeForTests,
} from "../SkillInvocationFromToolCall.ts";
import {
  readRecentSkillInvocations,
  skillInvocationJournalPath,
} from "../SkillInvocationJournal.ts";

const MINI_MANIFEST = {
  version: 1,
  pm_playbook_skills: [
    {
      id: "pm-tech-scope",
      display_name: "PM 技术栈边界",
      skill_package: "skills/pm-tech-scope/SKILL.md",
      doc: "docs/skills/pm-playbook/tech-scope.md",
    },
  ],
};

describe("SkillInvocationFromToolCall", () => {
  beforeEach(() => resetPlaybookSkillDedupeForTests());
  afterEach(() => resetPlaybookSkillDedupeForTests());

  it("buildPlaybookPathIndex maps package, doc, and default paths", () => {
    const index = buildPlaybookPathIndex(MINI_MANIFEST);
    assert.equal(
      resolveSkillIdFromFilePath(
        "skills/pm-tech-scope/SKILL.md",
        "/proj",
        index,
      ),
      "pm-tech-scope",
    );
    assert.equal(
      resolveSkillIdFromFilePath(
        "docs/skills/pm-playbook/tech-scope.md",
        "/proj",
        index,
      ),
      "pm-tech-scope",
    );
  });

  it("resolveSkillIdFromFilePath handles Windows absolute paths", () => {
    const index = buildPlaybookPathIndex(MINI_MANIFEST);
    const root = "D:\\codeflowmu";
    const abs = `${root}\\skills\\pm-tech-scope\\SKILL.md`;
    assert.equal(resolveSkillIdFromFilePath(abs, root, index), "pm-tech-scope");
  });

  it("extractPathsFromToolCallPayload reads paths from raw", () => {
    const paths = extractPathsFromToolCallPayload({
      raw: {
        tool: "read",
        path: "D:\\codeflowmu\\skills\\pm-tech-scope\\SKILL.md",
      },
    });
    assert.ok(paths.some((p) => p.includes("pm-tech-scope")));
  });

  it("maybeRecordPlaybookSkillFromToolCall writes journal for SKILL.md read", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-skill-inv-"));
    try {
      await mkdir(join(root, ".codeflowmu"), { recursive: true });
      await mkdir(join(root, "docs", "skills"), { recursive: true });
      await writeFile(
        join(root, "docs", "skills", "agent-skills.manifest.json"),
        JSON.stringify(MINI_MANIFEST),
        "utf-8",
      );

      const skillId = await maybeRecordPlaybookSkillFromToolCall({
        projectRoot: root,
        agent_id: "PM-01",
        session_id: "sess-pm-01",
        payload: {
          raw: { path: join(root, "skills", "pm-tech-scope", "SKILL.md") },
        },
        thread_key: "thread-1",
        task_id: "TASK-001",
      });
      assert.equal(skillId, "pm-tech-scope");

      const journal = skillInvocationJournalPath(root);
      const text = await readFile(journal, "utf-8");
      const line = JSON.parse(text.trim().split("\n").pop()!);
      assert.equal(line.skill_id, "pm-tech-scope");
      assert.equal(line.skill_display_name, "PM 技术栈边界");
      assert.equal(line.channel, "agent_runtime");
      assert.equal(line.triggered_by, "sdk.tool_call");
      assert.equal(line.caller_role, "PM-01");

      const recent = await readRecentSkillInvocations(root, 5);
      assert.equal(recent[0]?.skill_id, "pm-tech-scope");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("dedupes same session+skill within 120s", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-skill-dedupe-"));
    try {
      await mkdir(join(root, ".codeflowmu"), { recursive: true });
      await mkdir(join(root, "docs", "skills"), { recursive: true });
      await writeFile(
        join(root, "docs", "skills", "agent-skills.manifest.json"),
        JSON.stringify(MINI_MANIFEST),
        "utf-8",
      );
      const input = {
        projectRoot: root,
        agent_id: "PM-01",
        session_id: "sess-dedupe",
        payload: {
          raw: { path: "skills/pm-tech-scope/SKILL.md" },
        },
      };
      assert.equal(await maybeRecordPlaybookSkillFromToolCall(input), "pm-tech-scope");
      assert.equal(await maybeRecordPlaybookSkillFromToolCall(input), null);
      const text = await readFile(skillInvocationJournalPath(root), "utf-8");
      assert.equal(text.trim().split("\n").length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
