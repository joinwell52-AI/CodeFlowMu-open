/**
 * MCPInjector tests — Sprint S5 TS-7.9 + TS-7.10.
 *
 * Coverage:
 *   - TS-7.9 : stub mode → mount() emits one logger.info, returns
 *              MCPMount[]; getMounted reflects state; unmount clears.
 *   - TS-7.10: mode="live" → ctor eager-throws
 *              MCPInjectorLiveModeNotImplementedError before any
 *              mount call (composition-time failure).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InMemorySdkAdapter } from "../../registry/AgentSdkAdapter.ts";
import { MCPInjectorLiveModeNotImplementedError } from "../../registry/errors.ts";
import { MCPInjector } from "../MCPInjector.ts";
import { SkillRegistry } from "../SkillRegistry.ts";
import type { AgentRecord } from "../../types/state.ts";
import { plantSkill, quietLogger, withTempSkill } from "./helpers.ts";

function buildAgentRecord(skills: string[]): AgentRecord {
  return {
    protocol: {
      agent_id: "DEV-01",
      role: "DEV",
      layer: "worker",
      node: "local",
      runtime: "local",
      sdk_agent_id: "sdk-1",
      skills,
      status: "idle",
    } as AgentRecord["protocol"],
    runtime_binding_mode: "local",
    runtime_last_reconciled_at: new Date().toISOString(),
  };
}

describe("MCPInjector", () => {
  it("TS-7.9: stub mode mount → emits logger.info, returns audit array, getMounted reflects state", async () => {
    await withTempSkill(async ({ skillsDir }) => {
      await plantSkill(skillsDir, { skill_id: "fcop" });
      await plantSkill(skillsDir, { skill_id: "git" });
      const reg = new SkillRegistry({ skillsDir });
      await reg.load();

      const sdk = new InMemorySdkAdapter();
      const logger = quietLogger();
      const injector = new MCPInjector({
        skillRegistry: reg,
        sdkAdapter: sdk,
        logger,
      });
      assert.equal(injector.mode, "stub");

      const record = buildAgentRecord(["fcop", "git"]);
      const mounts = await injector.mount(record);
      assert.equal(mounts.length, 2);

      const skillIds = mounts.map((m) => m.skill_id).sort();
      assert.deepEqual(skillIds, ["fcop", "git"]);

      // Each mount carries the provider's transport + command/url.
      for (const m of mounts) {
        assert.equal(m.agent_id, "DEV-01");
        assert.equal(m.transport, "stdio");
        assert.equal(m.command, "node fcop-mcp");
      }

      // SDK was NOT touched (stub mode never spawns).
      assert.equal(sdk.calls.create.length, 0);

      // logger.info captures the stub-mode line with the agent_id and
      // skill_id list (operator-friendly summary).
      const stubLine = logger.logs.find((l) =>
        l.includes("[MCPInjector stub] mounting"),
      );
      assert.ok(stubLine, `expected stub-mode info line; got ${JSON.stringify(logger.logs)}`);
      assert.match(stubLine!, /DEV-01/);
      assert.match(stubLine!, /fcop/);
      assert.match(stubLine!, /git/);
      assert.match(stubLine!, /no subprocess spawned/);

      // getMounted reflects state.
      const peek = injector.getMounted("DEV-01");
      assert.equal(peek.length, 2);
      assert.deepEqual(injector.listMounted(), ["DEV-01"]);

      // Unmount clears.
      await injector.unmount("DEV-01");
      assert.deepEqual(injector.getMounted("DEV-01"), []);
      assert.deepEqual(injector.listMounted(), []);

      // Idempotent unmount of unknown agent — no throw.
      await injector.unmount("NEVER-MOUNTED");
    });
  });

  it("TS-7.10: mode='live' → ctor eager-throws MCPInjectorLiveModeNotImplementedError", async () => {
    await withTempSkill(async ({ skillsDir }) => {
      const reg = new SkillRegistry({ skillsDir });
      const sdk = new InMemorySdkAdapter();
      assert.throws(
        () =>
          new MCPInjector({
            skillRegistry: reg,
            sdkAdapter: sdk,
            mode: "live",
          }),
        (err: unknown) => {
          assert.ok(err instanceof MCPInjectorLiveModeNotImplementedError);
          assert.equal(err.name, "MCPInjectorLiveModeNotImplementedError");
          assert.match((err as Error).message, /v0\.2/);
          return true;
        },
      );
    });
  });

  it("bonus: mount with skill_id not in registry → warn + skip (no throw)", async () => {
    await withTempSkill(async ({ skillsDir }) => {
      await plantSkill(skillsDir, { skill_id: "fcop" });
      const reg = new SkillRegistry({ skillsDir });
      await reg.load();

      const sdk = new InMemorySdkAdapter();
      const logger = quietLogger();
      const injector = new MCPInjector({
        skillRegistry: reg,
        sdkAdapter: sdk,
        logger,
      });

      const record = buildAgentRecord(["fcop", "ghost-skill"]);
      const mounts = await injector.mount(record);
      assert.equal(mounts.length, 1);
      assert.equal(mounts[0]!.skill_id, "fcop");
      assert.ok(
        logger.warns.some((w) => w.includes("ghost-skill")),
        "ghost-skill warn expected",
      );
    });
  });

  it("bonus: agent with empty skills → mount returns [] + zero-skills info line", async () => {
    await withTempSkill(async ({ skillsDir }) => {
      const reg = new SkillRegistry({ skillsDir });
      await reg.load();
      const sdk = new InMemorySdkAdapter();
      const logger = quietLogger();
      const injector = new MCPInjector({
        skillRegistry: reg,
        sdkAdapter: sdk,
        logger,
      });
      const record = buildAgentRecord([]);
      const mounts = await injector.mount(record);
      assert.deepEqual(mounts, []);
      assert.ok(
        logger.logs.some((l) => l.includes("no skills to mount")),
      );
    });
  });
});
