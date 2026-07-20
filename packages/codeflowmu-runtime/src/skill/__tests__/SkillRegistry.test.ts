/**
 * SkillRegistry tests — Sprint S5 TS-7.1 ~ TS-7.4.
 *
 * Coverage:
 *   - TS-7.1: load N valid skills returns loaded=N / skipped=[]
 *   - TS-7.2: schema-invalid skill files are skipped, not propagated
 *   - TS-7.3: tolerant-read filters (.tmp / non-.json / corrupt JSON)
 *   - TS-7.4: getById / listForRole / list indexes are consistent
 *
 * Lives under `skill/__tests__/`. Uses `validate` from
 * `@codeflowmu/protocol` indirectly (SkillRegistry calls it during
 * load) — failure-path assertions inspect `skipped[]` rather than
 * trying to construct a `SkillSchemaError` by hand.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SkillRegistry } from "../SkillRegistry.ts";
import {
  plantRaw,
  plantSkill,
  quietLogger,
  withTempSkill,
} from "./helpers.ts";

describe("SkillRegistry", () => {
  it("TS-7.1: load N valid skills → loaded.length === N, skipped=[]", async () => {
    await withTempSkill(async ({ skillsDir }) => {
      await plantSkill(skillsDir, { skill_id: "fcop" });
      await plantSkill(skillsDir, {
        skill_id: "git",
        available_to_roles: ["DEV"],
      });
      await plantSkill(skillsDir, {
        skill_id: "playwright",
        available_to_roles: ["QA"],
      });

      const logger = quietLogger();
      const reg = new SkillRegistry({ skillsDir, logger });
      const result = await reg.load();

      assert.equal(result.loaded.length, 3);
      assert.equal(result.skipped.length, 0);
      assert.equal(reg.size(), 3);

      const ids = result.loaded.map((s) => s.skill_id).sort();
      assert.deepEqual(ids, ["fcop", "git", "playwright"]);

      // logger.info one-liner present.
      assert.ok(
        logger.logs.some((l) => l.includes("loaded 3 skill(s)")),
        "logger.info summary should fire after load",
      );
    });
  });

  it("TS-7.2: schema-invalid skill file → skipped, others still load", async () => {
    await withTempSkill(async ({ skillsDir }) => {
      await plantSkill(skillsDir, { skill_id: "fcop" }); // valid
      // Schema invalid: required_kernel missing the fcop@ contains pattern.
      await plantSkill(skillsDir, {
        skill_id: "noisy",
        required_kernel: ["something@1.0"], // no fcop@
      });

      const logger = quietLogger();
      const reg = new SkillRegistry({ skillsDir, logger });
      const result = await reg.load();

      assert.equal(result.loaded.length, 1);
      assert.equal(result.skipped.length, 1);
      assert.equal(result.loaded[0]!.skill_id, "fcop");
      assert.match(result.skipped[0]!.reason, /schema invalid/i);

      // Tolerant-read: warn is emitted, no error thrown.
      assert.ok(
        logger.warns.some((w) =>
          w.includes("noisy.json") && w.includes("schema invalid"),
        ),
        `expected warn about noisy.json schema invalid; got ${JSON.stringify(logger.warns)}`,
      );
    });
  });

  it("TS-7.3: tolerant-read filters skip .tmp / non-.json / invalid JSON", async () => {
    await withTempSkill(async ({ skillsDir }) => {
      await plantSkill(skillsDir, { skill_id: "fcop" });
      await plantRaw(skillsDir, "fcop.json.tmp", "{ partial");
      await plantRaw(skillsDir, "README.md", "operator notes");
      await plantRaw(skillsDir, "broken.json", "{ invalid: json,");
      await plantRaw(skillsDir, "empty.json", "");

      const logger = quietLogger();
      const reg = new SkillRegistry({ skillsDir, logger });
      const result = await reg.load();

      assert.equal(result.loaded.length, 1);
      assert.equal(result.loaded[0]!.skill_id, "fcop");

      // README.md and *.tmp are silently skipped (no skipped[] entries).
      const skippedFiles = result.skipped.map((s) => s.file);
      assert.ok(
        skippedFiles.some((f) => f.endsWith("broken.json")),
        "broken.json should appear in skipped[]",
      );
      assert.ok(
        skippedFiles.some((f) => f.endsWith("empty.json")),
        "empty.json should appear in skipped[]",
      );
      assert.equal(
        skippedFiles.filter((f) => f.endsWith(".tmp")).length,
        0,
        ".tmp files are silently filtered, not in skipped[]",
      );
      assert.equal(
        skippedFiles.filter((f) => f.endsWith("README.md")).length,
        0,
        "non-.json files are silently filtered, not in skipped[]",
      );
    });
  });

  it("TS-7.4: getById / listForRole / list indexes consistent", async () => {
    await withTempSkill(async ({ skillsDir }) => {
      await plantSkill(skillsDir, {
        skill_id: "fcop",
        available_to_roles: ["DEV", "REVIEW", "QA"],
      });
      await plantSkill(skillsDir, {
        skill_id: "git",
        available_to_roles: ["DEV"],
      });
      await plantSkill(skillsDir, {
        skill_id: "playwright",
        available_to_roles: ["QA"],
      });

      const reg = new SkillRegistry({ skillsDir });
      await reg.load();

      // getById: O(1) lookup
      assert.equal(reg.getById("fcop")?.skill_id, "fcop");
      assert.equal(reg.getById("nonexistent"), null);

      // listForRole: reverse index
      const devSkills = reg.listForRole("DEV").map((s) => s.skill_id).sort();
      assert.deepEqual(devSkills, ["fcop", "git"]);
      const qaSkills = reg.listForRole("QA").map((s) => s.skill_id).sort();
      assert.deepEqual(qaSkills, ["fcop", "playwright"]);
      const reviewSkills = reg.listForRole("REVIEW").map((s) => s.skill_id);
      assert.deepEqual(reviewSkills, ["fcop"]);
      assert.deepEqual(reg.listForRole("UNKNOWN"), []);

      // list: full enumeration
      const all = reg.list().map((s) => s.skill_id).sort();
      assert.deepEqual(all, ["fcop", "git", "playwright"]);

      // size matches list().length
      assert.equal(reg.size(), 3);
    });
  });

  it("bonus: re-loading clears + rebuilds indexes (idempotent)", async () => {
    await withTempSkill(async ({ skillsDir }) => {
      await plantSkill(skillsDir, { skill_id: "fcop" });
      const reg = new SkillRegistry({ skillsDir });
      const first = await reg.load();
      assert.equal(first.loaded.length, 1);

      // Plant a second skill, re-load.
      await plantSkill(skillsDir, {
        skill_id: "git",
        available_to_roles: ["DEV"],
      });
      const second = await reg.load();
      assert.equal(second.loaded.length, 2);
      assert.equal(reg.size(), 2);
    });
  });

  it("bonus: missing skillsDir → load() returns empty (don't auto-create)", async () => {
    await withTempSkill(async ({ rootDir }) => {
      // Use a path that doesn't exist
      const reg = new SkillRegistry({
        skillsDir: `${rootDir}/no-such-dir`,
      });
      const result = await reg.load();
      assert.deepEqual(result, { loaded: [], skipped: [] });
    });
  });

  it("bonus: filename ↔ skill_id mismatch is rejected with reason", async () => {
    await withTempSkill(async ({ skillsDir }) => {
      // Plant a skill with skill_id="fcop" but rename file to wrong-name.json
      await plantRaw(
        skillsDir,
        "wrong-name.json",
        JSON.stringify({
          skill_id: "fcop",
          version: "1.0.0",
          provided_by: {
            type: "mcp_server",
            transport: "stdio",
            command: "node fcop",
          },
          tools: [{ name: "x" }],
          available_to_roles: ["DEV"],
          required_kernel: ["fcop@1.0"],
        }),
      );

      const reg = new SkillRegistry({ skillsDir });
      const result = await reg.load();
      assert.equal(result.loaded.length, 0);
      assert.equal(result.skipped.length, 1);
      assert.match(result.skipped[0]!.reason, /filename .*does not match/);
    });
  });
});

