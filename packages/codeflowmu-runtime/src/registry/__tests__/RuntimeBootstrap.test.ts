/**
 * RuntimeBootstrap unit tests — TASK-20260509-009 §必交付 6 scenarios 7-9 + 11
 * + TASK-20260509-013 附加交付 2 scenario 12 (TS-2.8 B-path)
 * + TASK-20260509-024 §必交付 4.a TS-7.11 (kernel-dep audit phase).
 *
 * Run with `npm test`.
 *
 * Scenario coverage:
 *   7.  Bootstrap success (2 records, both in SDK list)
 *   8.  Bootstrap orphan_local (record's sdk_agent_id missing from SDK)
 *   9.  Bootstrap ignore_foreign (SDK has extra id not in records)
 *   11. Race-defense: register during run() throws RuntimeNotReadyError
 *   12. SDK.list() failure → RuntimeBootstrapError (TS-2.8 B HARD FAIL)
 *   13. (TS-7.11) Kernel-dep audit phase moves rejected agents from
 *       success → failed and stamps `report.kernel_failures[]`.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { AgentRegistry } from "../AgentRegistry.ts";
import {
  type AgentSdkAdapter,
  InMemorySdkAdapter,
} from "../AgentSdkAdapter.ts";
import {
  RuntimeBootstrapError,
  RuntimeNotReadyError,
} from "../errors.ts";
import { RuntimeBootstrap } from "../RuntimeBootstrap.ts";
import { KernelDependencyValidator } from "../../skill/KernelDependencyValidator.ts";
import { SkillRegistry } from "../../skill/SkillRegistry.ts";
import { ReconciliationStrategy } from "../../types/state.ts";
import {
  plantSkill,
  withTempSkill,
} from "../../skill/__tests__/helpers.ts";

import { captureLogger, validAgentSpec, withTempStore } from "./helpers.ts";

// Scenario 7 — full success
test("bootstrap: 2 known records → report.success.length === 2", async () => {
  await withTempStore(async ({ store }) => {
    const sdk = new InMemorySdkAdapter();
    const registry = new AgentRegistry({ store, sdk });

    await registry.register(validAgentSpec({ agent_id: "DEV-01" }));
    await registry.register(
      validAgentSpec({ agent_id: "PM-01", role: "pm", workspace: undefined }),
    );

    const logger = captureLogger();
    const bootstrap = new RuntimeBootstrap({ store, sdk, registry, logger });
    const report = await bootstrap.run();

    assert.equal(report.success.length, 2);
    assert.equal(report.failed.length, 0);
    assert.equal(report.orphaned.length, 0);
    assert.equal(report.foreign.length, 0);
    assert.equal(report.drifted.length, 0);

    assert.equal(logger.logs.length, 1, "one summary line expected");
    assert.match(logger.logs[0]!, /✅ 2 success/);

    assert.equal(registry.isBootstrapping, false, "flag must clear after run()");
  });
});

// Scenario 8 — orphan_local (case X)
test("bootstrap: record's sdk_agent_id absent from SDK → orphan_local", async () => {
  await withTempStore(async ({ store }) => {
    const sdk = new InMemorySdkAdapter();
    const registry = new AgentRegistry({ store, sdk });

    const record = await registry.register(validAgentSpec());

    // Simulate SDK forgetting the agent (e.g. external cleanup).
    const sdkId = record.protocol.sdk_agent_id!;
    sdk.seedKnown(); // already known; we override below by clearing
    // InMemorySdkAdapter doesn't expose deleteKnown publicly; simulate
    // by using the planted-failure path on resume + a list() that
    // doesn't include the id. We need a fresh SDK whose known set
    // doesn't include sdkId:
    const sdk2 = new InMemorySdkAdapter();
    // Don't seed sdkId. Plant a planted-failure on resume just in case
    // the bootstrap tries (it shouldn't, since the id isn't in list).
    void sdk2;

    // Rewire registry/bootstrap to the new SDK to simulate "SDK forgot":
    const registry2 = new AgentRegistry({ store, sdk: sdk2 });
    const logger = captureLogger();
    const bootstrap = new RuntimeBootstrap({
      store,
      sdk: sdk2,
      registry: registry2,
      logger,
      autoRecreateOrphans: false,
    });
    const report = await bootstrap.run();

    assert.equal(report.success.length, 0);
    assert.equal(report.orphaned.length, 1);
    assert.equal(report.orphaned[0]!.agent_id, "DEV-01");
    assert.equal(report.orphaned[0]!.sdk_agent_id, sdkId);
    assert.equal(
      report.orphaned[0]!.strategy,
      ReconciliationStrategy.ORPHAN_LOCAL,
    );

    // Record should now be marked status=error.
    const rec = await registry2.get("DEV-01");
    assert.ok(rec, "record must still be in store (we keep PCB for audit)");
    assert.equal(rec!.protocol.status, "error");
    assert.ok(rec!.runtime_failure);
    assert.match(rec!.runtime_failure!.reason, /orphaned/);

    assert.match(logger.logs[0]!, /🪦 1 orphaned/);
  });
});

// Scenario 9 — ignore_foreign (case Y)
test("bootstrap: SDK exposes a foreign id → report.foreign + agents.json unchanged", async () => {
  await withTempStore(async ({ store, agentsPath }) => {
    const sdk = new InMemorySdkAdapter();
    const registry = new AgentRegistry({ store, sdk });

    await registry.register(validAgentSpec());

    // External entity creates an SDK agent without going through the runtime.
    sdk.seedKnown("sdk-alien-9999");

    // Snapshot agents.json BEFORE run.
    const before = (await store.loadAll()).map((r) => r.protocol.agent_id);

    const logger = captureLogger();
    const bootstrap = new RuntimeBootstrap({ store, sdk, registry, logger });
    const report = await bootstrap.run();

    assert.equal(report.success.length, 1, "the original record still resumes");
    assert.equal(report.foreign.length, 1);
    assert.equal(report.foreign[0]!.sdk_agent_id, "sdk-alien-9999");
    assert.equal(
      report.foreign[0]!.strategy,
      ReconciliationStrategy.IGNORE_FOREIGN,
    );

    // agents.json must NOT have grown a new record for the alien id.
    const after = (await store.loadAll()).map((r) => r.protocol.agent_id);
    assert.deepEqual(after, before);
    void agentsPath;

    assert.match(logger.logs[0]!, /👻 1 foreign/);
  });
});

test("bootstrap: lazy local binding survives list/resume visibility gap and adopts active workspace", async () => {
  await withTempStore(async ({ store }) => {
    const originalSdk = new InMemorySdkAdapter();
    const originalRegistry = new AgentRegistry({ store, sdk: originalSdk });
    const original = await originalRegistry.register(
      validAgentSpec({ workspace: "D:\\wrong\\codeflowmu-shell" }),
    );
    const oldId = original.protocol.sdk_agent_id!;
    const resumeCalls: string[] = [];
    const createWorkspaces: Array<string | undefined> = [];
    const recoveringSdk: AgentSdkAdapter = {
      async list() {
        return [oldId];
      },
      async create(spec) {
        createWorkspaces.push(spec.workspace);
        return { sdk_agent_id: "sdk-should-not-be-created" };
      },
      async resume(id) {
        resumeCalls.push(id);
        if (id === oldId) throw new Error("agent_not_found");
      },
      async send() {
        throw new Error("not used");
      },
      async listModels() {
        return [];
      },
    };
    const registry = new AgentRegistry({ store, sdk: recoveringSdk });
    const bootstrap = new RuntimeBootstrap({
      store,
      sdk: recoveringSdk,
      registry,
      logger: captureLogger(),
      expectedWorkspace: "D:\\projects\\Famous sayings",
    });

    const report = await bootstrap.run();
    const recovered = await registry.get("DEV-01");

    assert.equal(report.failed.length, 0);
    assert.equal(report.recreated.length, 0);
    assert.equal(report.success.length, 1);
    assert.equal(recovered?.protocol.sdk_agent_id, oldId);
    assert.equal(recovered?.protocol.workspace, "D:\\projects\\Famous sayings");
    assert.deepEqual(createWorkspaces, []);
    assert.deepEqual(resumeCalls, [oldId]);
  });
});

// Scenario 11 — race defense
test("bootstrap: register during run() throws RuntimeNotReadyError", async () => {
  await withTempStore(async ({ store }) => {
    const sdk = new InMemorySdkAdapter();
    const registry = new AgentRegistry({ store, sdk });
    const logger = captureLogger();
    const bootstrap = new RuntimeBootstrap({ store, sdk, registry, logger });

    // Simulate "still bootstrapping" by toggling the flag manually —
    // races between run() and register() are the property under test,
    // and toggling the flag is the contractually-supported way for
    // RuntimeBootstrap to gate registers. Tests on a public seam.
    registry._setBootstrapping(true);
    await assert.rejects(
      () => registry.register(validAgentSpec()),
      RuntimeNotReadyError,
    );
    registry._setBootstrapping(false);

    // Sanity: after flag clears, register works.
    const record = await registry.register(validAgentSpec());
    assert.equal(record.protocol.agent_id, "DEV-01");

    // Bootstrap also clears the flag in finally{} — verify by running
    // a subsequent register after run() finishes.
    await bootstrap.run();
    assert.equal(registry.isBootstrapping, false);
  });
});

// Scenario 12 — TS-2.8 B-path: SDK.list() fails → HARD FAIL as RuntimeBootstrapError.
//
// crash-recovery.md decision 2 mandates "不允许半启动状态". When the SDK
// is unreachable during reconciliation we must propagate a single,
// uniformly-typed `RuntimeBootstrapError` (so the bin/codeflowmu-runtime
// stderr summary stays consistent with the agents.json-corrupt path)
// and let the caller `process.exit(1)`.
test("bootstrap: SDK.list() throws → RuntimeBootstrapError (TS-2.8 B)", async () => {
  await withTempStore(async ({ store }) => {
    const sdk = new InMemorySdkAdapter();
    const registry = new AgentRegistry({ store, sdk });

    // Have at least one record so step 1 succeeds and we hit step 2.
    await registry.register(validAgentSpec());

    // Plant the SDK.list failure — must fire on the very next list() call.
    sdk.failNextListWith("network down");

    const logger = captureLogger();
    const bootstrap = new RuntimeBootstrap({ store, sdk, registry, logger });

    await assert.rejects(
      () => bootstrap.run(),
      (err: unknown) => {
        assert.ok(
          err instanceof RuntimeBootstrapError,
          `expected RuntimeBootstrapError, got ${(err as Error).constructor.name}`,
        );
        assert.match(
          (err as Error).message,
          /SDK\.list\(\) failed during reconciliation: list failed: network down/,
          `error message must include the SDK.list reason; got: ${(err as Error).message}`,
        );
        return true;
      },
    );

    // Race-defense flag must clear even on HARD FAIL — finally{} guarantee.
    assert.equal(
      registry.isBootstrapping,
      false,
      "isBootstrapping flag must clear after HARD FAIL via finally{}",
    );
  });
});

// Scenario 13 (TS-7.11) — Phase E: kernel-dep audit phase
//
// Note: agent.schema.json `skills.contains: "fcop"` makes it impossible
// to write a non-fcop record VIA register() — schema rejects first.
// To exercise the bootstrap-only audit path we plant the violator
// record directly via `store.saveAll` (post-register the file already
// exists; subsequent boots rehydrate without schema re-checks). This
// is exactly the production scenario: an old `agents.json` that
// PRE-DATED the v0.1 fcop-mcp dependency rule needs to be migrated,
// and the kernel-dep audit is what tells the operator which records
// to fix.
test("TS-7.11: kernel_failures[] picks up agents lacking fcop on bootstrap", async () => {
  await withTempStore(async ({ store }) => {
    await withTempSkill(async ({ skillsDir }) => {
      // Plant fcop only — the validator will reject anything that
      // declares a skill not in the registry.
      await plantSkill(skillsDir, { skill_id: "fcop" });
      const skillReg = new SkillRegistry({ skillsDir });
      await skillReg.load();
      const kernelValidator = new KernelDependencyValidator({
        skillRegistry: skillReg,
      });

      const sdk = new InMemorySdkAdapter();
      const registry = new AgentRegistry({ store, sdk });

      // Step 1: register a clean DEV-01 (passes both agent schema
      // AND kernel-dep validation).
      const devRecord = await registry.register(
        validAgentSpec({ agent_id: "DEV-01", skills: ["fcop"] }),
      );

      // Step 2: register a clean PM-01 first (so SDK has a known id),
      // then post-process its skills to a violating set via saveAll —
      // mirrors the migration scenario where v0.0 deployments stored
      // skills that v0.1 rejects.
      const pmRecord = await registry.register(
        validAgentSpec({
          agent_id: "PM-01",
          role: "pm",
          workspace: undefined,
          skills: ["fcop"],
        }),
      );
      // Mutate to violation skills (bypassing register schema check).
      pmRecord.protocol.skills = ["ghost-skill", "fcop"];
      await store.saveAll([devRecord, pmRecord]);

      const logger = captureLogger();
      const bootstrap = new RuntimeBootstrap({
        store,
        sdk,
        registry,
        logger,
        kernelValidator,
      });
      const report = await bootstrap.run();

      // DEV-01 survived; PM-01 demoted to failed[] AND audited in
      // kernel_failures[].
      assert.equal(report.success.length, 1);
      assert.equal(report.success[0]!.agent_id, "DEV-01");
      assert.equal(report.failed.length, 1);
      assert.equal(report.failed[0]!.agent_id, "PM-01");
      assert.match(report.failed[0]!.reason, /skill_not_found/);

      assert.equal(report.kernel_failures.length, 1);
      assert.equal(report.kernel_failures[0]!.agent_id, "PM-01");
      assert.equal(report.kernel_failures[0]!.reason, "skill_not_found");
      assert.match(report.kernel_failures[0]!.detail, /ghost-skill/);

      // The summary line includes the 🚫 prefix when failures occur.
      assert.match(logger.logs[0]!, /🚫 1 kernel-dep/);
    });
  });
});

test("TS-7.11b: kernelValidator absent → kernel_failures is [] (zero behavior change)", async () => {
  await withTempStore(async ({ store }) => {
    const sdk = new InMemorySdkAdapter();
    const registry = new AgentRegistry({ store, sdk });
    await registry.register(validAgentSpec());

    const logger = captureLogger();
    const bootstrap = new RuntimeBootstrap({ store, sdk, registry, logger });
    const report = await bootstrap.run();

    assert.equal(report.success.length, 1);
    assert.equal(report.kernel_failures.length, 0);
    // Summary line does NOT include the 🚫 prefix.
    assert.equal(/🚫/.test(logger.logs[0]!), false);
  });
});

