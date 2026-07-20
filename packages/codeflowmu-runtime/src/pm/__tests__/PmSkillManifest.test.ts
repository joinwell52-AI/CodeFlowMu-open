import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PM_BUILTIN_SKILLS,
  buildPmSkillManifestFile,
  formatPmBuiltinSkillsPlaybookBlock,
  listPmBuiltinSkills,
  listPmSkillsForRole,
} from "../PmSkillManifest.ts";

describe("PmSkillManifest", () => {
  it("buildPmSkillManifestFile includes all PM runtime skills", () => {
    const manifest = buildPmSkillManifestFile();
    assert.equal(manifest.manifest_version, "1.0.0");
    assert.equal(manifest.kind, "pm-builtin-skills");
    assert.equal(manifest.role, "PM");
    assert.equal(manifest.skills.length, 7);
    const ids = manifest.skills.map((s) => s.skill_id).sort();
    assert.deepEqual(ids, [
      "pm.close_admin_task",
      "pm.detect_thread_stall",
      "pm.record_planning_skill_evidence",
      "pm.review_check",
      "pm.summarize_thread",
      "pm.wake_downstream",
      "pm.write_planning_artifact",
    ]);
  });

  it("listPmSkillsForRole returns skills only for PM", () => {
    assert.equal(listPmSkillsForRole("PM").length, 7);
    assert.equal(listPmSkillsForRole("pm").length, 7);
    assert.equal(listPmSkillsForRole("DEV").length, 0);
    assert.equal(listPmBuiltinSkills().length, PM_BUILTIN_SKILLS.length);
  });

  it("formatPmBuiltinSkillsPlaybookBlock lists every skill_id", () => {
    const block = formatPmBuiltinSkillsPlaybookBlock();
    for (const skill of PM_BUILTIN_SKILLS) {
      assert.match(block, new RegExp(skill.skill_id.replace(".", "\\.")));
    }
    assert.match(block, /pm-skills\.manifest\.json/);
    assert.match(block, /不是.*ADMIN 按钮墙/);
    assert.match(block, /下游 .*active.*无 REPORT 超过约 5 分钟/);
    assert.match(block, /DOWNSTREAM_AUTO_NUDGE/);
    assert.match(block, /禁止只让 ADMIN 点 Panel 开工/);
  });
});
