/**
 * AgentSdkAdapter (CursorSdkAdapter) unit tests.
 *
 * MT-1 (TASK-20260510-010-PM-to-DEV §3.5) — TS-MODEL-1..5 — defaultModel
 * wire-through (BUG-SDK-001 closure).
 *
 * MT-2 (TASK-20260510-012-PM-to-DEV) — TS-RUN-1..2 — `agent.send()` opts
 * carry `local: { force: true }` for local-mode sends and an empty object
 * for cloud-mode sends (BUG-SDK-002 closure).
 *
 * Background:
 *
 * - REPORT-20260510-009-QA-to-PM §五 BUG-SDK-001 surfaced that
 *   `Agent.create({ local: { cwd } })` produces a usable agent in `local`
 *   runtime mode, but the resulting `agent.send()` rejects with:
 *     Local SDK agents require an explicit model. Pass model: { id: "..." }
 *     to Agent.create() or to send(), or run this agent in cloud mode.
 *   MT-1 fixed this by adding `defaultModel` to `CursorSdkAdapterOptions`
 *   and having `create()` / `send()` fall back from `spec.modelId` to
 *   `this._opts.defaultModel`. TS-MODEL-1..5 pin the wire-through.
 *
 * - REPORT-20260510-011-QA-to-PM §六 BUG-SDK-002 surfaced that, after
 *   MT-1's model wire-through, the very next failure is:
 *     Agent <uuid> already has active run (code=undefined, isRetryable=false)
 *   100% reproducible across two independent runs (different dataDir +
 *   different agent UUID). MT-2 fixes this by passing
 *   `local: { force: true }` to `agent.send()` for local-mode sends — see
 *   AgentSdkAdapter.ts file-level JSDoc for the root-cause analysis.
 *   TS-RUN-1..2 pin the new send-opts shape (local vs cloud).
 *
 * Test plan:
 *   TS-MODEL-1  (BUG-SDK-007 flipped) defaultModel set, no spec.modelId →
 *               Agent.create receives NO model key. Pre-beta.3 this
 *               asserted the model was wired through; QA-014 proved that
 *               path crashes on ADMIN-class keys (see AgentSdkAdapter.ts
 *               BUG-SDK-007 JSDoc section).
 *   TS-MODEL-2  (BUG-SDK-007 flipped) spec.modelId set (overrides
 *               defaultModel) → Agent.create STILL receives NO model
 *               key. The precedence chain (spec.modelId ?? defaultModel)
 *               applies only on the resume/send path now.
 *   TS-MODEL-3  neither set → Agent.create receives no `model` key at all
 *               (existing pre-BUG-SDK-007 contract; kept as a sanity
 *               anchor since 1/2 now match its assertion too).
 *   TS-MODEL-4  send() inherits the same precedence chain (defaultModel
 *               fallback when spec.modelId is omitted) on the
 *               Agent.resume({ model }) side — unchanged by BUG-SDK-007.
 *   TS-MODEL-5  send() spec.modelId override symmetric to TS-MODEL-4
 *               (resume side; unchanged by BUG-SDK-007).
 *   TS-RUN-1    local-mode send → agent.send(text, { local: { force: true } }).
 *               This is the BUG-SDK-002 fix — without `force` the SDK
 *               rejects every local send after a `create()` because the
 *               first `create()` leaves a persisted run wedged on disk.
 *   TS-RUN-2    cloud-mode send → agent.send(text, {}).
 *               No `local` field is allowed on cloud sends per SDK type
 *               system; cloud uses server-side `409 agent_busy` instead.
 *
 *   ── BUG-SDK-007 (TASK-20260511-001, v0.2.0-beta.3) ──────────────────
 *   TS-MODEL-6  ANY combination of (defaultModel set / spec.modelId set /
 *               both set / neither set) → Agent.create NEVER receives a
 *               `model` key. Parameterized strong-acceptance guard for
 *               the BUG-SDK-007 hotfix; pins the contract independently
 *               of TS-MODEL-1/2/3.
 *   TS-MODEL-7  spec.modelId set → Agent.resume receives
 *               `model: { id: spec.modelId }` (regression guard: the
 *               BUG-SDK-007 hotfix must NOT accidentally also strip the
 *               resume-path model arg, which is required to make local
 *               sends succeed per BUG-SDK-001).
 *   TS-MODEL-8  defaultModel set but spec.modelId omitted → Agent.resume
 *               receives `model: { id: defaultModel }` (regression guard
 *               for the defaultModel fallback half of the resume-path
 *               precedence chain, symmetric to TS-MODEL-7).
 *
 * SDK seam: we import `Agent` from `@cursor/sdk` and monkey-patch
 * `Agent.create` / `Agent.resume` for the duration of each test, then
 * restore. This is identical in spirit to `PersistentStore.test.ts`
 * scenario 10's `fs.rename` patching — keeps the test zero-dep and
 * doesn't introduce a DI seam in production code.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { Agent, CursorAgentError } from "@cursor/sdk";

import { CursorSdkAdapter } from "../AgentSdkAdapter.ts";
import type {
  AgentCreateSpec,
  AgentSendSpec,
} from "../AgentSdkAdapter.ts";

/** A baseline create spec — every test overlays just the field it varies. */
function baseCreateSpec(): AgentCreateSpec {
  return {
    agentId: "DEV-01",
    role: "developer",
    layer: "worker",
    runtime: "local",
    workspace: "/tmp/codeflowmu-test",
  };
}

function baseSendSpec(): AgentSendSpec {
  return {
    sessionId: "session-test-1",
    agentId: "DEV-01",
    text: "go",
  };
}

/**
 * Patch `Agent.create` to a spy. Returns a `restore()` callback. Captures
 * **only the most recent** call's options (sufficient for these tests —
 * each test does exactly one create).
 */
function patchAgentCreate(): {
  captured: { lastOpts: Record<string, unknown> | null };
  restore: () => void;
} {
  const realCreate = (Agent as unknown as { create: typeof Agent.create })
    .create;
  const captured: { lastOpts: Record<string, unknown> | null } = {
    lastOpts: null,
  };
  (Agent as unknown as { create: unknown }).create = (async (
    opts: Record<string, unknown>,
  ) => {
    captured.lastOpts = opts;
    return {
      agentId: "stub-agent-id-mt1-test",
      [Symbol.asyncDispose]: async () => undefined,
    };
  }) as unknown as typeof Agent.create;
  return {
    captured,
    restore: () => {
      (Agent as unknown as { create: typeof Agent.create }).create = realCreate;
    },
  };
}

/**
 * Sentinel marker used by `patchAgentResumeForSeamTest` — when `agent.send()`
 * is invoked on the stub agent we throw with this exact message so the
 * test can distinguish "resume captured the model option correctly" from
 * "Agent.resume itself failed". CursorSdkAdapter.send() catches this in
 * its non-CursorAgentError path and re-throws it verbatim, so the test
 * uses `assert.rejects(..., /SEAM_TEST_HALT/)` as a positive signal.
 */
const SEAM_TEST_HALT = "SEAM_TEST_HALT_after_capturing_resume_opts";

/**
 * Patch `Agent.resume` to record options. Stops the run-handle construction
 * path by having the stub agent's `.send()` throw the sentinel marker
 * above — that's much cheaper than building a SDKMessage-shaped Run.
 *
 * Also captures the second argument to `agent.send(text, opts)` so MT-2
 * tests (TS-RUN-1..2) can assert on the SendOptions shape.
 */
function patchAgentResumeForSeamTest(): {
  captured: {
    lastResumeOpts: Record<string, unknown> | null;
    lastSendText: string | null;
    lastSendOpts: Record<string, unknown> | null;
    sendCallCount: number;
  };
  restore: () => void;
} {
  const realResume = (Agent as unknown as { resume: typeof Agent.resume })
    .resume;
  const captured = {
    lastResumeOpts: null as Record<string, unknown> | null,
    lastSendText: null as string | null,
    lastSendOpts: null as Record<string, unknown> | null,
    sendCallCount: 0,
  };
  (Agent as unknown as { resume: unknown }).resume = (async (
    _id: string,
    opts: Record<string, unknown>,
  ) => {
    captured.lastResumeOpts = opts;
    return {
      send: async (
        text: string,
        sendOpts?: Record<string, unknown>,
      ) => {
        captured.lastSendText = text;
        captured.lastSendOpts = sendOpts ?? null;
        captured.sendCallCount += 1;
        throw new Error(SEAM_TEST_HALT);
      },
      [Symbol.asyncDispose]: async () => undefined,
    };
  }) as unknown as typeof Agent.resume;
  return {
    captured,
    restore: () => {
      (Agent as unknown as { resume: typeof Agent.resume }).resume = realResume;
    },
  };
}

// ───────────── TS-MODEL-1 (BUG-SDK-007 flipped): defaultModel set but
//               Agent.create() still receives NO model key ─────────────
//
// PRE-BUG-SDK-007 (v0.2.0-beta.1/.2): this asserted that the adapter
// wired defaultModel through to Agent.create({ model: { id } }). QA-014
// then proved that path crashes on ADMIN-class API keys with the
// misleading "Cannot use this model: <name>" error. v0.2.0-beta.3
// reverts the create-time wire while keeping the resume-time wire
// (covered by TS-MODEL-4/5). See file-level JSDoc BUG-SDK-007 section.

test("TS-MODEL-1 (BUG-SDK-007): defaultModel set + spec.modelId omitted → Agent.create receives NO model key", async () => {
  const { captured, restore } = patchAgentCreate();
  try {
    const adapter = new CursorSdkAdapter({
      apiKey: "fake-key-not-validated-in-stub",
      defaultModel: "claude-sonnet-4",
    });
    await adapter.create(baseCreateSpec());

    assert.ok(captured.lastOpts, "Agent.create must have been called");
    assert.ok(
      !("model" in (captured.lastOpts as Record<string, unknown>)),
      "BUG-SDK-007: Agent.create must NEVER receive a `model` key, even when " +
        "defaultModel is set on the adapter. The defaultModel still gets " +
        "wired through Agent.resume() inside send() — see TS-MODEL-4.",
    );
  } finally {
    restore();
  }
});

// ──────── TS-MODEL-2 (BUG-SDK-007 flipped): spec.modelId set but
//          Agent.create() still receives NO model key ────────

test("TS-MODEL-2 (BUG-SDK-007): spec.modelId set + defaultModel set → Agent.create still receives NO model key", async () => {
  const { captured, restore } = patchAgentCreate();
  try {
    const adapter = new CursorSdkAdapter({
      apiKey: "fake-key-not-validated-in-stub",
      defaultModel: "claude-sonnet-4",
    });
    const spec = { ...baseCreateSpec(), modelId: "gpt-5" };
    await adapter.create(spec);

    assert.ok(captured.lastOpts);
    assert.ok(
      !("model" in (captured.lastOpts as Record<string, unknown>)),
      "BUG-SDK-007: Agent.create must NEVER receive a `model` key, even when " +
        "BOTH defaultModel and per-call spec.modelId are set. The precedence " +
        "chain (spec.modelId ?? defaultModel) still applies on the resume " +
        "path inside send() — see TS-MODEL-5.",
    );
  } finally {
    restore();
  }
});

// ──── TS-MODEL-3: neither set → no `model` key at all (regression guard) ────

test("TS-MODEL-3: defaultModel omitted + spec.modelId omitted → Agent.create called WITHOUT a model key", async () => {
  const { captured, restore } = patchAgentCreate();
  try {
    const adapter = new CursorSdkAdapter({
      apiKey: "fake-key-not-validated-in-stub",
      // intentionally no defaultModel
    });
    await adapter.create(baseCreateSpec());

    assert.ok(captured.lastOpts);
    assert.ok(
      !("model" in captured.lastOpts),
      "Agent.create must receive NO model key (caller decides; cloud auto-picks, local will fail at send)",
    );
  } finally {
    restore();
  }
});

// ──── TS-MODEL-4: send() honors the same precedence chain ────

test("TS-MODEL-4: send() — defaultModel fallback when spec.modelId is omitted", async () => {
  const { captured, restore } = patchAgentResumeForSeamTest();
  try {
    const adapter = new CursorSdkAdapter({
      apiKey: "fake-key-not-validated-in-stub",
      defaultModel: "claude-sonnet-4",
    });
    // The stub agent's `.send()` throws SEAM_TEST_HALT after Agent.resume
    // already captured opts — that's the seam we're testing.
    await assert.rejects(
      () => adapter.send(baseSendSpec(), "stub-sdk-id-mt1-test"),
      new RegExp(SEAM_TEST_HALT),
      "expected stub agent.send() to halt after seam was captured",
    );

    assert.ok(captured.lastResumeOpts, "Agent.resume must have been called");
    const model = (captured.lastResumeOpts as { model?: { id?: string } })
      .model;
    assert.deepEqual(
      model,
      { id: "claude-sonnet-4" },
      "send() must wire defaultModel → Agent.resume({ model }) too, not just create()",
    );
  } finally {
    restore();
  }
});

// ──── TS-MODEL-5: send() spec.modelId override (sanity: same shape on both methods) ────

test("TS-MODEL-5: send() — spec.modelId overrides defaultModel symmetric to create()", async () => {
  const { captured, restore } = patchAgentResumeForSeamTest();
  try {
    const adapter = new CursorSdkAdapter({
      apiKey: "fake-key-not-validated-in-stub",
      defaultModel: "claude-sonnet-4",
    });
    const spec = { ...baseSendSpec(), modelId: "gpt-5" };
    await assert.rejects(
      () => adapter.send(spec, "stub-sdk-id-mt1-test"),
      new RegExp(SEAM_TEST_HALT),
    );

    assert.ok(captured.lastResumeOpts);
    const model = (captured.lastResumeOpts as { model?: { id?: string } })
      .model;
    assert.deepEqual(model, { id: "gpt-5" });
  } finally {
    restore();
  }
});

// ─────── TS-RUN-1: local mode send → agent.send(text, { local: { force: true } }) ───────
//
// BUG-SDK-002 fix verification: every local-mode `agent.send()` from
// CursorSdkAdapter must carry `local: { force: true }` so that the SDK's
// "expire-then-replace" recovery path runs (vs. "this is a 2nd run on the
// same agent" rejection). See AgentSdkAdapter.ts file-level JSDoc.

test("TS-RUN-1: local-mode send → agent.send is called with { local: { force: true } }", async () => {
  const { captured, restore } = patchAgentResumeForSeamTest();
  try {
    const adapter = new CursorSdkAdapter({
      apiKey: "fake-key-not-validated-in-stub",
      defaultModel: "claude-sonnet-4",
      // local is the v0.2 default; spelled out here for self-documentation.
      listScope: "local",
    });
    await assert.rejects(
      () => adapter.send(baseSendSpec(), "stub-sdk-id-bug-sdk-002-test"),
      new RegExp(SEAM_TEST_HALT),
      "expected stub agent.send() to halt after seam was captured",
    );

    assert.equal(
      captured.sendCallCount,
      1,
      "agent.send() must be called exactly once (no retry path on seam halt)",
    );
    assert.equal(captured.lastSendText, "go", "text must round-trip from spec");
    assert.deepEqual(
      captured.lastSendOpts,
      {
        model: { id: "claude-sonnet-4" },
        local: { force: true },
      },
      "BUG-SDK-002: local-mode sends MUST set local.force=true to expire any " +
        "wedged persisted run and repeat the explicit model at send-time",
    );
  } finally {
    restore();
  }
});

// ─────── TS-RUN-2: cloud mode send → agent.send(text, {}) (no local field) ───────
//
// SendOptions.local is type-gated to local agents in @cursor/sdk
// (`local?: { ... }` only exists in the local-shape variant). Cloud sends
// must send an EMPTY options object — cloud has server-side `409 agent_busy`
// concurrency control, so no equivalent of `force` exists or is needed.

test("TS-RUN-2: cloud-mode send → agent.send carries model but no local field", async () => {
  const { captured, restore } = patchAgentResumeForSeamTest();
  try {
    const adapter = new CursorSdkAdapter({
      apiKey: "fake-key-not-validated-in-stub",
      defaultModel: "claude-sonnet-4",
      listScope: "cloud",
    });
    await assert.rejects(
      () => adapter.send(baseSendSpec(), "stub-sdk-id-cloud-test"),
      new RegExp(SEAM_TEST_HALT),
    );

    assert.equal(captured.sendCallCount, 1);
    assert.deepEqual(
      captured.lastSendOpts,
      { model: { id: "claude-sonnet-4" } },
      "cloud-mode sends MUST omit `local` (SDK type system rejects it; " +
        "cloud has server-side 409 agent_busy concurrency control instead), " +
        "while preserving the explicit send-time model",
    );
  } finally {
    restore();
  }
});

// ════════════════════════════════════════════════════════════════════
// BUG-SDK-007 (TASK-20260511-001, v0.2.0-beta.3) — strong-acceptance
// guards. TS-MODEL-1/2 above were FLIPPED for this hotfix; the tests
// below pin the new contract from independent angles so a future
// regression cannot quietly re-enable Agent.create({ model: ... }).
// ════════════════════════════════════════════════════════════════════

// ─────── TS-MODEL-6: parameterised — ANY config → create gets NO model ───────
//
// Iterates four (defaultModel, spec.modelId) configurations and asserts
// that the captured Agent.create options never contain a `model` key.
// This is the canonical "BUG-SDK-007 closed" contract — TS-MODEL-1/2/3
// each cover one cell of this matrix in isolation; TS-MODEL-6 sweeps
// the whole matrix in one run so a partial regression on any single
// cell still fails the suite.

test("TS-MODEL-6 (BUG-SDK-007): Agent.create() receives NO model key under ANY (defaultModel, spec.modelId) combo", async () => {
  const matrix: Array<{
    label: string;
    defaultModel?: string;
    modelId?: string;
  }> = [
    { label: "neither set", defaultModel: undefined, modelId: undefined },
    { label: "defaultModel only", defaultModel: "claude-sonnet-4" },
    { label: "spec.modelId only", modelId: "gpt-5" },
    {
      label: "both set (precedence chain unused on create)",
      defaultModel: "claude-sonnet-4",
      modelId: "gpt-5",
    },
  ];

  for (const cell of matrix) {
    const { captured, restore } = patchAgentCreate();
    try {
      const adapter = new CursorSdkAdapter({
        apiKey: "fake-key-not-validated-in-stub",
        ...(cell.defaultModel !== undefined
          ? { defaultModel: cell.defaultModel }
          : {}),
      });
      const spec =
        cell.modelId !== undefined
          ? { ...baseCreateSpec(), modelId: cell.modelId }
          : baseCreateSpec();
      await adapter.create(spec);

      assert.ok(
        captured.lastOpts,
        `Agent.create must have been called [${cell.label}]`,
      );
      assert.ok(
        !("model" in (captured.lastOpts as Record<string, unknown>)),
        `BUG-SDK-007 closed acceptance [${cell.label}]: Agent.create must ` +
          `never receive a model key, but lastOpts=${JSON.stringify(
            captured.lastOpts,
          )}`,
      );
    } finally {
      restore();
    }
  }
});

// ─────── TS-MODEL-7: spec.modelId still wires through to Agent.resume() ───────
//
// Regression guard: the BUG-SDK-007 hotfix surgically removes `model`
// from Agent.create() ONLY. The resume-path model wire-through (which
// is what actually unblocks BUG-SDK-001's "Local SDK agents require an
// explicit model" SDK error) must remain intact, otherwise this hotfix
// would silently re-introduce BUG-SDK-001 on local sends.

test("TS-MODEL-7 (BUG-SDK-007 regression guard): spec.modelId → Agent.resume receives model.id=spec.modelId", async () => {
  const { captured, restore } = patchAgentResumeForSeamTest();
  try {
    const adapter = new CursorSdkAdapter({
      apiKey: "fake-key-not-validated-in-stub",
      // intentionally NO defaultModel — spec.modelId must drive on its own
    });
    const spec = { ...baseSendSpec(), modelId: "gpt-5" };
    await assert.rejects(
      () => adapter.send(spec, "stub-sdk-id-bug-sdk-007-test"),
      new RegExp(SEAM_TEST_HALT),
      "expected stub agent.send() to halt after Agent.resume captured opts",
    );

    assert.ok(captured.lastResumeOpts);
    const model = (captured.lastResumeOpts as { model?: { id?: string } })
      .model;
    assert.deepEqual(
      model,
      { id: "gpt-5" },
      "BUG-SDK-007 must NOT strip the resume-path model wire-through; " +
        "spec.modelId still has to reach Agent.resume({ model }) so " +
        "BUG-SDK-001 (Local SDK agents require an explicit model) stays " +
        "fixed on the resume half of the pipeline.",
    );
  } finally {
    restore();
  }
});

// ─────── TS-MODEL-8: defaultModel still wires through to Agent.resume() ───────
//
// Symmetric to TS-MODEL-7 but exercises the defaultModel fallback half
// of the spec.modelId ?? this._opts.defaultModel precedence chain on
// the resume path.

test("TS-MODEL-8 (BUG-SDK-007 regression guard): defaultModel-only → Agent.resume receives model.id=defaultModel", async () => {
  const { captured, restore } = patchAgentResumeForSeamTest();
  try {
    const adapter = new CursorSdkAdapter({
      apiKey: "fake-key-not-validated-in-stub",
      defaultModel: "claude-sonnet-4",
      // intentionally NO spec.modelId — defaultModel must drive on fallback
    });
    await assert.rejects(
      () => adapter.send(baseSendSpec(), "stub-sdk-id-bug-sdk-007-test"),
      new RegExp(SEAM_TEST_HALT),
    );

    assert.ok(captured.lastResumeOpts);
    const model = (captured.lastResumeOpts as { model?: { id?: string } })
      .model;
    assert.deepEqual(
      model,
      { id: "claude-sonnet-4" },
      "BUG-SDK-007 must preserve the adapter-level defaultModel fallback " +
        "on the resume path; otherwise users who only set CURSOR_DEFAULT_MODEL " +
        "(common case) would silently regress to BUG-SDK-001.",
    );
  } finally {
    restore();
  }
});

test("TS-MODEL-9: Auto defaults to Cursor Router Cost params on resume and send", async () => {
  const { captured, restore } = patchAgentResumeForSeamTest();
  try {
    const adapter = new CursorSdkAdapter({
      apiKey: "fake-key-not-validated-in-stub",
      defaultModel: "auto-smart",
    });
    await assert.rejects(
      () => adapter.send(baseSendSpec(), "stub-sdk-id-auto-cost-test"),
      new RegExp(SEAM_TEST_HALT),
    );

    const expectedModel = {
      id: "auto-smart",
      params: [{ id: "optimize_for", value: "cost" }],
    };
    assert.deepEqual(
      (captured.lastResumeOpts as { model?: unknown } | null)?.model,
      expectedModel,
    );
    assert.deepEqual(
      (captured.lastSendOpts as { model?: unknown } | null)?.model,
      expectedModel,
    );
  } finally {
    restore();
  }
});

test("TS-MODEL-10: legacy default alias normalizes to Auto Cost", async () => {
  const { captured, restore } = patchAgentResumeForSeamTest();
  try {
    const adapter = new CursorSdkAdapter({
      apiKey: "fake-key-not-validated-in-stub",
      defaultModel: "default",
    });
    await assert.rejects(
      () => adapter.send(baseSendSpec(), "stub-sdk-id-auto-cost-legacy-test"),
      new RegExp(SEAM_TEST_HALT),
    );

    assert.deepEqual(
      (captured.lastResumeOpts as { model?: unknown } | null)?.model,
      {
        id: "auto-smart",
        params: [{ id: "optimize_for", value: "cost" }],
      },
    );
  } finally {
    restore();
  }
});

test("local send materializes a lazy sdk_agent_id when resume reports agent_not_found", async () => {
  const realResume = (Agent as unknown as { resume: typeof Agent.resume }).resume;
  const realCreate = (Agent as unknown as { create: typeof Agent.create }).create;
  const captured = {
    createOpts: null as Record<string, unknown> | null,
    sendOpts: null as Record<string, unknown> | null,
  };
  (Agent as unknown as { resume: unknown }).resume = (async () => {
    throw new CursorAgentError("Agent lazy-local-id not found", {
      code: "agent_not_found",
      isRetryable: false,
    });
  }) as unknown as typeof Agent.resume;
  (Agent as unknown as { create: unknown }).create = (async (
    opts: Record<string, unknown>,
  ) => {
    captured.createOpts = opts;
    return {
      agentId: String(opts["agentId"]),
      send: async (_text: string, sendOpts?: Record<string, unknown>) => {
        captured.sendOpts = sendOpts ?? null;
        throw new Error(SEAM_TEST_HALT);
      },
      [Symbol.asyncDispose]: async () => undefined,
    };
  }) as unknown as typeof Agent.create;

  try {
    const adapter = new CursorSdkAdapter({
      apiKey: "fake-key-not-validated-in-stub",
      defaultModel: "gpt-5",
      defaultCwd: "D:\\codeflowmu\\projects\\Luniva",
      listScope: "local",
    });
    await assert.rejects(
      () => adapter.send(baseSendSpec(), "lazy-local-id"),
      new RegExp(SEAM_TEST_HALT),
    );
    assert.equal(captured.createOpts?.["agentId"], "lazy-local-id");
    assert.deepEqual(
      (captured.createOpts?.["local"] as { cwd?: string } | undefined)?.cwd,
      "D:\\codeflowmu\\projects\\Luniva",
    );
    assert.deepEqual(captured.sendOpts, {
      model: { id: "gpt-5" },
      local: { force: true },
    });
  } finally {
    (Agent as unknown as { resume: typeof Agent.resume }).resume = realResume;
    (Agent as unknown as { create: typeof Agent.create }).create = realCreate;
  }
});

test("Open edition adapter enables the Cursor OS sandbox on supported platforms", async () => {
  const { captured, restore } = patchAgentCreate();
  try {
    const adapter = new CursorSdkAdapter({
      apiKey: "fake-key-not-validated-in-stub",
      sandboxEnabled: true,
      platform: "linux",
    });
    await adapter.create(baseCreateSpec());
    assert.deepEqual(
      (captured.lastOpts as {
        local?: { sandboxOptions?: { enabled?: boolean } };
      }).local?.sandboxOptions,
      { enabled: true },
    );
  } finally {
    restore();
  }
});

test("Open edition adapter keeps the Cursor OS sandbox on supported resume/send", async () => {
  const { captured, restore } = patchAgentResumeForSeamTest();
  try {
    const adapter = new CursorSdkAdapter({
      apiKey: "fake-key-not-validated-in-stub",
      defaultModel: "gpt-5",
      sandboxEnabled: true,
      platform: "linux",
    });
    await assert.rejects(
      () => adapter.send(baseSendSpec(), "stub-sdk-id-sandbox-test"),
      new RegExp(SEAM_TEST_HALT),
    );
    assert.deepEqual(
      (captured.lastResumeOpts as {
        local?: { sandboxOptions?: { enabled?: boolean } };
      }).local?.sandboxOptions,
      { enabled: true },
    );
  } finally {
    restore();
  }
});

test("Open edition adapter does not request unsupported Cursor OS sandboxing on Windows", async () => {
  const { captured, restore } = patchAgentResumeForSeamTest();
  try {
    const adapter = new CursorSdkAdapter({
      apiKey: "fake-key-not-validated-in-stub",
      defaultModel: "gpt-5",
      sandboxEnabled: true,
      platform: "win32",
    });
    await assert.rejects(
      () => adapter.send(baseSendSpec(), "stub-sdk-id-windows-sandbox-test"),
      new RegExp(SEAM_TEST_HALT),
    );
    assert.equal(
      (captured.lastResumeOpts as {
        local?: { sandboxOptions?: { enabled?: boolean } };
      }).local?.sandboxOptions,
      undefined,
    );
  } finally {
    restore();
  }
});

