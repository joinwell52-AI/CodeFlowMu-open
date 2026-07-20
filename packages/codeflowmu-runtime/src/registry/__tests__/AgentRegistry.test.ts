/**
 * AgentRegistry unit tests — TASK-20260509-009 §必交付 6 scenarios 1-6
 * + Sprint S5 TS-7.12 (kernel-dep hook integration).
 *
 * Run with `npm test` (which invokes `node --import tsx --test`).
 *
 * Scenario coverage:
 *   1. register normal flow
 *   2. register schema validation failure (missing layer)
 *   3. register layer=admin → SDK adapter NOT touched (spy-verified)
 *   4. register SDK create throws → agents.json untouched
 *   5. resume happy path → record updated
 *   6. resume target missing → AgentNotFoundError
 *  12. (TS-7.12) register with kernelValidator hook → SDK + store
 *      both untouched on rejection (decision S timing invariant)
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import type { Agent } from "@codeflowmu/protocol";

import { AgentRegistry } from "../AgentRegistry.ts";
import {
  AgentNotFoundError,
  KernelDependencyError,
  LayerViolationError,
  ValidationError,
} from "../errors.ts";
import { InMemorySdkAdapter } from "../AgentSdkAdapter.ts";
import { KernelDependencyValidator } from "../../skill/KernelDependencyValidator.ts";
import { MCPInjector } from "../../skill/MCPInjector.ts";
import { SkillRegistry } from "../../skill/SkillRegistry.ts";
import {
  plantSkill,
  quietLogger,
  withTempSkill,
} from "../../skill/__tests__/helpers.ts";

import { captureLogger, validAgentSpec, withTempStore } from "./helpers.ts";

void captureLogger; // imported for symmetry with bootstrap tests; not used here

// Scenario 1
test("register: normal flow persists record + sets sdk_agent_id", async () => {
  await withTempStore(async ({ store, agentsPath }) => {
    const sdk = new InMemorySdkAdapter();
    const registry = new AgentRegistry({ store, sdk });

    const record = await registry.register(validAgentSpec());

    assert.equal(record.protocol.agent_id, "DEV-01");
    assert.match(record.protocol.sdk_agent_id ?? "", /^sdk-fake-/);
    assert.equal(record.protocol.status, "idle");
    assert.equal(record.runtime_binding_mode, "local");
    assert.ok(record.runtime_last_reconciled_at);

    assert.ok(existsSync(agentsPath), "agents.json must exist after register");
    const persisted = JSON.parse(readFileSync(agentsPath, "utf-8"));
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].protocol.agent_id, "DEV-01");
    assert.equal(persisted[0].protocol.sdk_agent_id, record.protocol.sdk_agent_id);

    assert.equal(sdk.calls.create.length, 1);
    assert.equal(sdk.calls.create[0]?.agentId, "DEV-01");
  });
});

// Scenario 2
test("register: schema validation rejects missing layer", async () => {
  await withTempStore(async ({ store, agentsPath }) => {
    const sdk = new InMemorySdkAdapter();
    const registry = new AgentRegistry({ store, sdk });

    const bogus = {
      agent_id: "DEV-01",
      role: "developer",
      // layer intentionally missing
      node: "local",
      runtime: "local",
      skills: ["fcop"],
      status: "idle",
    } as unknown as Agent;

    await assert.rejects(() => registry.register(bogus), ValidationError);
    assert.equal(
      sdk.calls.create.length,
      0,
      "SDK adapter must not be called when validation fails",
    );
    assert.equal(
      existsSync(agentsPath),
      false,
      "agents.json must not be created on validation failure",
    );
  });
});

// Scenario 3 — the BIG invariant: layer=admin reject BEFORE SDK call
test("register: layer=admin throws LayerViolationError before SDK is touched", async () => {
  await withTempStore(async ({ store, agentsPath }) => {
    const sdk = new InMemorySdkAdapter();
    const registry = new AgentRegistry({ store, sdk });

    const adminSpec = validAgentSpec({
      agent_id: "ADMIN-01",
      role: "admin",
      layer: "admin",
    });

    await assert.rejects(
      () => registry.register(adminSpec),
      LayerViolationError,
    );
    assert.equal(
      sdk.calls.create.length,
      0,
      "SDK adapter MUST NOT be called for layer=admin (test scenario 3 spy)",
    );
    assert.equal(existsSync(agentsPath), false);
  });
});

// Scenario 4 — SDK throws → agents.json never written
test("register: SDK create throws → agents.json is not written", async () => {
  await withTempStore(async ({ store, agentsPath }) => {
    const sdk = new InMemorySdkAdapter();
    sdk.failNextCreateWith("simulated SDK outage");

    const registry = new AgentRegistry({ store, sdk });

    await assert.rejects(() => registry.register(validAgentSpec()));
    assert.equal(
      sdk.calls.create.length,
      1,
      "SDK was hit (expected) — that's how we know we got past validation",
    );
    assert.equal(
      existsSync(agentsPath),
      false,
      "agents.json must NOT exist when SDK create failed",
    );
  });
});

// Scenario 5 — resume happy path
test("resume: SDK knows the id → record's reconciled_at is updated", async () => {
  await withTempStore(async ({ store }) => {
    const sdk = new InMemorySdkAdapter();
    const registry = new AgentRegistry({ store, sdk });

    const original = await registry.register(validAgentSpec());
    const sdkAgentId = original.protocol.sdk_agent_id!;
    const beforeReconciled = original.runtime_last_reconciled_at!;

    // Make sure timestamp moves forward.
    await new Promise((r) => setTimeout(r, 10));

    const resumed = await registry.resume("DEV-01");
    assert.equal(resumed.protocol.agent_id, "DEV-01");
    assert.notEqual(
      resumed.runtime_last_reconciled_at,
      beforeReconciled,
      "runtime_last_reconciled_at must move forward after resume",
    );
    assert.deepEqual(
      sdk.calls.resume,
      [sdkAgentId],
      "register persists the created id; explicit resume is the first probe",
    );
  });
});

test("register: does not reject a newly-created id during SDK visibility delay", async () => {
  await withTempStore(async ({ store, agentsPath }) => {
    const sdk = new InMemorySdkAdapter();
    sdk.failNextResumeWith("permission denied");
    const registry = new AgentRegistry({ store, sdk });

    const registered = await registry.register(validAgentSpec());
    assert.ok(registered.protocol.sdk_agent_id);
    assert.equal(sdk.calls.resume.length, 0);
    assert.equal(
      existsSync(agentsPath),
      true,
      "successful SDK create must be persisted without an immediate resume gate",
    );
  });
});

// Scenario 6 — resume non-existent agent
test("resume: agent not in store → AgentNotFoundError", async () => {
  await withTempStore(async ({ store }) => {
    const sdk = new InMemorySdkAdapter();
    const registry = new AgentRegistry({ store, sdk });

    await assert.rejects(
      () => registry.resume("DEV-01"),
      AgentNotFoundError,
    );
    assert.equal(sdk.calls.resume.length, 0);
  });
});

// Scenario 12 (TS-7.12) — Phase E hook: kernel-dep validator gates
// register BEFORE SDK.create (decision S). Verifies that on rejection:
//   1. SDK adapter is NOT called (sdk quota preserved)
//   2. agents.json is NOT created (no half-state on disk)
//   3. The thrown error is `KernelDependencyError` with correct reason
test("TS-7.12: register with kernelValidator → SDK + store untouched on rejection", async () => {
  await withTempStore(async ({ store, agentsPath }) => {
    await withTempSkill(async ({ skillsDir }) => {
      // Plant a fcop skill so the registry is non-trivially populated.
      await plantSkill(skillsDir, { skill_id: "fcop" });
      const skillReg = new SkillRegistry({ skillsDir });
      await skillReg.load();
      const kernelValidator = new KernelDependencyValidator({
        skillRegistry: skillReg,
      });

      const sdk = new InMemorySdkAdapter();
      const registry = new AgentRegistry({
        store,
        sdk,
        kernelValidator,
      });

      // Agent declares a non-existent skill — should reject before SDK.
      const spec = validAgentSpec({ skills: ["fcop", "ghost-skill"] });

      await assert.rejects(
        () => registry.register(spec),
        (err: unknown) => {
          assert.ok(err instanceof KernelDependencyError);
          assert.equal(err.reason, "skill_not_found");
          assert.equal(err.agentId, "DEV-01");
          return true;
        },
      );

      // Decision S invariant: SDK.create NOT called.
      assert.equal(
        sdk.calls.create.length,
        0,
        "SDK.create must NOT be called when kernelValidator rejects",
      );
      // agents.json was never written.
      assert.equal(
        existsSync(agentsPath),
        false,
        "agents.json must not exist after a rejected register",
      );
    });
  });
});

test("TS-7.12b: register with kernelValidator + valid skills → mounts via mcpInjector", async () => {
  await withTempStore(async ({ store, agentsPath }) => {
    await withTempSkill(async ({ skillsDir }) => {
      await plantSkill(skillsDir, { skill_id: "fcop" });
      await plantSkill(skillsDir, { skill_id: "git" });
      const skillReg = new SkillRegistry({ skillsDir });
      await skillReg.load();

      const sdk = new InMemorySdkAdapter();
      const kernelValidator = new KernelDependencyValidator({
        skillRegistry: skillReg,
      });
      const logger = quietLogger();
      const mcpInjector = new MCPInjector({
        skillRegistry: skillReg,
        sdkAdapter: sdk,
        logger,
      });
      const registry = new AgentRegistry({
        store,
        sdk,
        kernelValidator,
        mcpInjector,
      });

      const record = await registry.register(
        validAgentSpec({ skills: ["fcop", "git"] }),
      );

      // Successful path: SDK.create was called once, agents.json exists,
      // and mcpInjector emitted exactly one mount line for this agent.
      assert.equal(sdk.calls.create.length, 1);
      assert.ok(existsSync(agentsPath));
      assert.equal(record.protocol.skills.length, 2);

      const mountLine = logger.logs.find((l) =>
        l.includes("[MCPInjector stub] mounting"),
      );
      assert.ok(mountLine, `expected mount info; got ${JSON.stringify(logger.logs)}`);
      assert.match(mountLine!, /DEV-01/);
      assert.match(mountLine!, /fcop/);

      // Mount audit reflects per-agent state.
      assert.equal(mcpInjector.getMounted("DEV-01").length, 2);
    });
  });
});

