/**
 * KernelDependencyValidator tests — Sprint S5 TS-7.5 ~ TS-7.8 + TS-7.13.
 *
 * Coverage:
 *   - TS-7.5 : agent with fcop-aware skill → null
 *   - TS-7.6 : agent skills empty / no fcop → reason="no_fcop_skill"
 *   - TS-7.7 : agent references unknown skill_id → reason="skill_not_found"
 *   - TS-7.8 : agent's skills don't list "local" runtime → "no_compatible_runtime"
 *   - TS-7.13: bonus — agent.skills=[] gives "no_fcop_skill" via fast path
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Agent } from "@codeflowmu/protocol";

import {
  FCOP_KERNEL_PATTERN,
  KernelDependencyValidator,
} from "../KernelDependencyValidator.ts";
import { KernelDependencyError } from "../../registry/errors.ts";
import { SkillRegistry } from "../SkillRegistry.ts";
import type { AgentRecord } from "../../types/state.ts";
import { plantSkill, quietLogger, withTempSkill } from "./helpers.ts";

function buildAgentSpec(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: "DEV-01",
    role: "DEV",
    layer: "worker",
    node: "local",
    runtime: "local",
    skills: ["fcop"],
    status: "idle",
    ...overrides,
  } as Agent;
}

function wrapAsRecord(spec: Agent): AgentRecord {
  return {
    protocol: spec,
    runtime_binding_mode: spec.runtime,
    runtime_last_reconciled_at: new Date().toISOString(),
  };
}

describe("KernelDependencyValidator", () => {
  it("FCOP_KERNEL_PATTERN matches design doc / schema invariant", () => {
    assert.equal(FCOP_KERNEL_PATTERN.source, "^fcop@.+");
    assert.ok(FCOP_KERNEL_PATTERN.test("fcop@1.0"));
    assert.ok(FCOP_KERNEL_PATTERN.test("fcop@>=1.0"));
    assert.ok(!FCOP_KERNEL_PATTERN.test("foo@1.0"));
    assert.ok(!FCOP_KERNEL_PATTERN.test("fcop"));
  });

  it("TS-7.5: agent with fcop-aware skill resolved → returns null", async () => {
    await withTempSkill(async ({ skillsDir }) => {
      await plantSkill(skillsDir, { skill_id: "fcop" });
      const reg = new SkillRegistry({ skillsDir });
      await reg.load();

      const v = new KernelDependencyValidator({ skillRegistry: reg });
      const spec = buildAgentSpec({ skills: ["fcop"] });
      assert.equal(v.validateAgentSpec(spec), null);
      assert.equal(v.validateAgent(wrapAsRecord(spec)), null);
      assert.deepEqual(v.validateAll([wrapAsRecord(spec)]), []);
      // assertAgentSpec doesn't throw on null
      v.assertAgentSpec(spec);
    });
  });

  it("TS-7.6: agent without any fcop-providing skill → no_fcop_skill", async () => {
    await withTempSkill(async ({ skillsDir }) => {
      // Plant a non-fcop skill that the validator can find via lookup
      // BUT whose required_kernel does NOT contain fcop@ — use schema
      // bypass via manual JSON since schema *requires* fcop@. We
      // hand-write the file to bypass the schema layer (since
      // SkillRegistry skips schema-invalid files), so we must instead
      // exercise the fast path: agent referencing a *valid* fcop skill
      // counts as fcop-present, so for "no_fcop_skill" main path we
      // ALSO need the validator to walk the resolved set. Plant fcop
      // then have agent reference a DIFFERENT skill that isn't fcop.
      //
      // Trick: since every loaded skill MUST have fcop@.+ per schema,
      // the only way "agent has skills but no fcop" can happen is via
      // an empty agent.skills list (TS-7.13 fast path). So this test
      // exercises that path.
      await plantSkill(skillsDir, { skill_id: "fcop" });
      const reg = new SkillRegistry({ skillsDir });
      await reg.load();

      const logger = quietLogger();
      const v = new KernelDependencyValidator({ skillRegistry: reg, logger });
      const spec = buildAgentSpec({ skills: [] });
      const failure = v.validateAgentSpec(spec);
      assert.ok(failure, "expected failure for empty skills");
      assert.equal(failure.reason, "no_fcop_skill");
      assert.equal(failure.agent_id, "DEV-01");
      assert.match(failure.detail, /empty/);
      assert.ok(
        logger.warns.some((w) => w.includes("no_fcop_skill") || w.includes("empty")),
        "warn should be logged for the rejection",
      );
    });
  });

  it("TS-7.7: agent references unknown skill_id → skill_not_found", async () => {
    await withTempSkill(async ({ skillsDir }) => {
      await plantSkill(skillsDir, { skill_id: "fcop" });
      const reg = new SkillRegistry({ skillsDir });
      await reg.load();

      const v = new KernelDependencyValidator({ skillRegistry: reg });
      const spec = buildAgentSpec({ skills: ["fcop", "ghost-skill"] });
      const failure = v.validateAgentSpec(spec);
      assert.ok(failure);
      assert.equal(failure.reason, "skill_not_found");
      assert.match(failure.detail, /skill_id="ghost-skill"/);

      // assertAgentSpec throws KernelDependencyError with same reason
      assert.throws(
        () => v.assertAgentSpec(spec),
        (err: unknown) => {
          assert.ok(err instanceof KernelDependencyError);
          assert.equal(err.reason, "skill_not_found");
          assert.equal(err.agentId, "DEV-01");
          return true;
        },
      );
    });
  });

  it("TS-7.8: skill compatible_runtimes lacks 'local' → no_compatible_runtime", async () => {
    await withTempSkill(async ({ skillsDir }) => {
      // Plant a skill that is fcop-aware but cloud-only.
      await plantSkill(skillsDir, {
        skill_id: "fcop",
        compatible_runtimes: ["cloud"],
      });
      const reg = new SkillRegistry({ skillsDir });
      await reg.load();

      const v = new KernelDependencyValidator({
        skillRegistry: reg,
        hostRuntime: "local",
      });
      const spec = buildAgentSpec({ skills: ["fcop"] });
      const failure = v.validateAgentSpec(spec);
      assert.ok(failure);
      assert.equal(failure.reason, "no_compatible_runtime");
      assert.match(failure.detail, /local/);

      // Now flip host_runtime to "cloud" — should pass.
      const v2 = new KernelDependencyValidator({
        skillRegistry: reg,
        hostRuntime: "cloud",
      });
      assert.equal(v2.validateAgentSpec(spec), null);
    });
  });

  it("TS-7.8b: missing compatible_runtimes counts as compatible (default-open)", async () => {
    await withTempSkill(async ({ skillsDir }) => {
      // No compatible_runtimes field at all.
      await plantSkill(skillsDir, { skill_id: "fcop" });
      const reg = new SkillRegistry({ skillsDir });
      await reg.load();

      const v = new KernelDependencyValidator({
        skillRegistry: reg,
        hostRuntime: "local",
      });
      const spec = buildAgentSpec({ skills: ["fcop"] });
      assert.equal(v.validateAgentSpec(spec), null);
    });
  });

  it("TS-7.13 (bonus): agent.skills=[] → no_fcop_skill via fast path", async () => {
    await withTempSkill(async ({ skillsDir }) => {
      const reg = new SkillRegistry({ skillsDir });
      await reg.load();

      const v = new KernelDependencyValidator({ skillRegistry: reg });
      const spec = buildAgentSpec({ skills: [] });
      const failure = v.validateAgentSpec(spec);
      assert.ok(failure);
      assert.equal(failure.reason, "no_fcop_skill");
      // Detail should call out "empty"
      assert.match(failure.detail, /empty/i);
    });
  });

  it("validateAll aggregates per-agent failures", async () => {
    await withTempSkill(async ({ skillsDir }) => {
      await plantSkill(skillsDir, { skill_id: "fcop" });
      const reg = new SkillRegistry({ skillsDir });
      await reg.load();

      const v = new KernelDependencyValidator({ skillRegistry: reg });
      const recordOk = wrapAsRecord(buildAgentSpec({ agent_id: "DEV-01" }));
      const recordEmpty = wrapAsRecord(
        buildAgentSpec({ agent_id: "DEV-02", skills: [] }),
      );
      const recordGhost = wrapAsRecord(
        buildAgentSpec({ agent_id: "DEV-03", skills: ["ghost"] }),
      );
      const failures = v.validateAll([recordOk, recordEmpty, recordGhost]);
      assert.equal(failures.length, 2);
      assert.equal(failures[0]!.agent_id, "DEV-02");
      assert.equal(failures[0]!.reason, "no_fcop_skill");
      assert.equal(failures[1]!.agent_id, "DEV-03");
      assert.equal(failures[1]!.reason, "skill_not_found");
    });
  });
});

