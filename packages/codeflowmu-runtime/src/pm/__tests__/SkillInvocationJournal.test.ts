import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  enrichSkillInvocationsForDisplay,
  skillInvocationToLogCenterRow,
  type SkillInvocationRecord,
} from "../SkillInvocationJournal.ts";

describe("enrichSkillInvocationsForDisplay", () => {
  it("fills skill_display_name from manifest projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfmu-enrich-"));
    await mkdir(join(root, ".codeflowmu"), { recursive: true });
    await writeFile(
      join(root, ".codeflowmu", "agent-skills.manifest.json"),
      JSON.stringify({
        version: 1,
        pm_playbook_skills: [
          {
            id: "pm-tech-scope",
            display_name: "PM 技术栈边界",
            skill_package: "skills/pm-tech-scope/SKILL.md",
          },
        ],
      }),
      "utf-8",
    );

    const raw: SkillInvocationRecord = {
      invocation_id: "test-1",
      at: "2026-06-03T12:00:00.000Z",
      skill_id: "pm-tech-scope",
      channel: "agent_runtime",
      outcome: "ok",
      summary: "Agent 读取 Playbook",
    };

    const enriched = await enrichSkillInvocationsForDisplay(root, [raw]);
    assert.equal(enriched[0]?.skill_display_name, "PM 技术栈边界");

    const row = skillInvocationToLogCenterRow(enriched[0]!);
    assert.equal(row.tool_name, "PM 技术栈边界");
    assert.equal(row.skill_id, "pm-tech-scope");
    assert.match(row.message ?? "", /^\[PM 技术栈边界\]/);
  });
});
