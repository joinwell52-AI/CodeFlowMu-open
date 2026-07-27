import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import request from "supertest";
import { PmQueueGuard, type Runtime } from "@codeflowmu/runtime";

import { buildWebPanelApp, wpResetProjectStoreForTests } from "../web-panel.ts";
import {
  listCursorModels,
  resolveEffectiveModel,
  type CursorModelCatalog,
} from "../team-model-config.ts";
import { startOpenInstallIntegrityGuard } from "../open-install-integrity.ts";

function writeTeam(root: string, model = "auto"): void {
  writeFileSync(
    join(root, "codeflowmu.team.json"),
    JSON.stringify({
      team_name: "test-team",
      members: [
        {
          agent_id: "DEV-01",
          role: "DEV",
          layer: "worker",
          skills: ["fcop"],
          model: { id: model },
        },
      ],
    }, null, 2),
    "utf-8",
  );
}

function liveCatalog(models = ["auto", "claude-sonnet-5", "claude-sonnet-4-6"]): CursorModelCatalog {
  return { ok: true, source: "cursor", models };
}

function runtimeMock(input: {
  configured?: string;
  effective?: string;
  current?: string;
  failUpdate?: boolean;
  updates?: Array<{ agentId: string; configured: string; effective: string }>;
} = {}): Runtime {
  const record = {
    protocol: {
      agent_id: "DEV-01",
      role: "DEV",
      layer: "worker",
      node: "local",
      runtime: "local",
      workspace: "D:\\business",
      skills: ["fcop"],
      status: "idle",
      model: { id: input.configured ?? "auto" },
    },
    runtime_binding_mode: "local",
    runtime_effective_model_id: input.effective ?? "auto-smart",
  };
  const active = input.current
    ? [{
        protocol: {
          session_id: "session-old",
          agent_id: "DEV-01",
          task_id: "TASK-old",
          status: "running",
        },
        runtime_effective_model_id: input.current,
      }]
    : [];
  return {
    registry: {
      list: async () => [record],
      get: async (agentId: string) => agentId === "DEV-01" ? record : null,
      updateModel: async (agentId: string, configured: string, effective: string) => {
        if (input.failUpdate) throw new Error("registry write failed");
        input.updates?.push({ agentId, configured, effective });
        record.protocol.model.id = configured;
        record.runtime_effective_model_id = effective;
      },
    },
    watcher: { dir: join(tmpdir(), "missing-inbox") },
    reviewWriter: { reviewsDir: join(tmpdir(), "missing-reviews") },
    sessionManager: {
      listActive: async () => active,
      onEvent: () => () => {},
    },
    sessionStore: {
      listAll: async () => [],
      load: async () => null,
      save: async () => {},
    },
    mcpInjector: { mode: "stub", listMounted: () => [] },
    reportDispatcher: { queueSnapshot: () => [] },
    pmQueueGuard: new PmQueueGuard(),
    panelEventBridge: { setSink: () => {} },
    dispatcher: {
      setDispatchRetryHook: () => {},
      listDispatchRetryRecords: () => [],
    },
  } as unknown as Runtime;
}

function buildTeamApp(input: {
  installRoot: string;
  businessRoot: string;
  runtime?: Runtime;
  catalog?: CursorModelCatalog;
}) {
  wpResetProjectStoreForTests(input.businessRoot);
  const app = buildWebPanelApp(input.runtime ?? runtimeMock(), {
    projectRoot: input.businessRoot,
    teamConfigRoot: input.installRoot,
    teamConfigRootType: "open_install_root",
    teamModelCatalog: async () => input.catalog ?? liveCatalog(),
  });
  return {
    app,
    cleanup: () => (app as unknown as { _sseCleanup?: () => void })._sseCleanup?.(),
  };
}

test("TM-01: GET uses install team root when active project root differs", async () => {
  const installRoot = mkdtempSync(join(tmpdir(), "cf-install-"));
  const businessRoot = mkdtempSync(join(tmpdir(), "cf-business-"));
  writeTeam(installRoot, "claude-sonnet-5");
  const { app, cleanup } = buildTeamApp({ installRoot, businessRoot });
  try {
    const response = await request(app).get("/api/v2/team");
    assert.equal(response.status, 200);
    assert.equal(response.body.members[0].model.id, "claude-sonnet-5");
    assert.equal(response.body.config_source.type, "open_install_root");
    assert.equal(existsSync(join(businessRoot, "codeflowmu.team.json")), false);
  } finally {
    cleanup();
  }
});

test("TM-02: PATCH writes install root and never creates business-root config", async () => {
  const installRoot = mkdtempSync(join(tmpdir(), "cf-install-"));
  const businessRoot = mkdtempSync(join(tmpdir(), "cf-business-"));
  writeTeam(installRoot);
  const { app, cleanup } = buildTeamApp({ installRoot, businessRoot });
  try {
    const response = await request(app)
      .patch("/api/v2/team/DEV-01/model")
      .send({ model_id: "claude-sonnet-5" });
    assert.equal(response.status, 200);
    const persisted = JSON.parse(readFileSync(join(installRoot, "codeflowmu.team.json"), "utf-8"));
    assert.equal(persisted.members[0].model.id, "claude-sonnet-5");
    assert.equal(existsSync(join(businessRoot, "codeflowmu.team.json")), false);
  } finally {
    cleanup();
  }
});

test("TM-03: successful PATCH synchronizes Runtime Registry with effective model", async () => {
  const installRoot = mkdtempSync(join(tmpdir(), "cf-install-"));
  const businessRoot = mkdtempSync(join(tmpdir(), "cf-business-"));
  const updates: Array<{ agentId: string; configured: string; effective: string }> = [];
  writeTeam(installRoot);
  const { app, cleanup } = buildTeamApp({
    installRoot,
    businessRoot,
    runtime: runtimeMock({ updates }),
  });
  try {
    const response = await request(app)
      .patch("/api/v2/team/DEV-01/model")
      .send({ model_id: "claude-sonnet-5" });
    assert.equal(response.status, 200);
    assert.deepEqual(updates, [{
      agentId: "DEV-01",
      configured: "claude-sonnet-5",
      effective: "claude-sonnet-5",
    }]);
    assert.equal(response.body.applies_from, "next_session");
  } finally {
    cleanup();
  }
});

test("TM-04: GET/PATCH/GET round trip returns persisted and next-session values", async () => {
  const installRoot = mkdtempSync(join(tmpdir(), "cf-install-"));
  const businessRoot = mkdtempSync(join(tmpdir(), "cf-business-"));
  const runtime = runtimeMock();
  writeTeam(installRoot);
  const integrityGuard = await startOpenInstallIntegrityGuard(installRoot, {
    auditIntervalMs: 60_000,
  });
  const { app, cleanup } = buildTeamApp({ installRoot, businessRoot, runtime });
  try {
    assert.equal((await request(app).get("/api/v2/team")).body.members[0].model.id, "auto");
    assert.equal((await request(app).patch("/api/v2/team/DEV-01/model").send({
      model_id: "claude-sonnet-4-6",
    })).status, 200);
    await integrityGuard.auditNow();
    const after = await request(app).get("/api/v2/team");
    assert.equal(after.body.members[0].model_status.persisted_model_id, "claude-sonnet-4-6");
    assert.equal(after.body.members[0].model_status.next_session_model_id, "claude-sonnet-4-6");
  } finally {
    integrityGuard.stop();
    cleanup();
  }
});

test("TM-06: running session keeps its captured model after next-session update", async () => {
  const installRoot = mkdtempSync(join(tmpdir(), "cf-install-"));
  const businessRoot = mkdtempSync(join(tmpdir(), "cf-business-"));
  writeTeam(installRoot, "claude-sonnet-4-6");
  const runtime = runtimeMock({
    configured: "claude-sonnet-4-6",
    effective: "claude-sonnet-4-6",
    current: "claude-sonnet-4-6",
  });
  const { app, cleanup } = buildTeamApp({ installRoot, businessRoot, runtime });
  try {
    await request(app).patch("/api/v2/team/DEV-01/model").send({
      model_id: "claude-sonnet-5",
    });
    const after = await request(app).get("/api/v2/team");
    const status = after.body.members[0].model_status;
    assert.equal(status.current_session_model_id, "claude-sonnet-4-6");
    assert.equal(status.next_session_model_id, "claude-sonnet-5");
  } finally {
    cleanup();
  }
});

test("TM-07/TM-08: Panel checks HTTP/body status and never treats legacy models cache as applied", () => {
  const html = readFileSync(
    join(process.cwd(), "..", "codeflowmu-desktop", "panel", "index.html"),
    "utf-8",
  );
  assert.match(html, /if\(!r\.ok\|\|d\.ok!==true\)/);
  assert.match(html, /await loadTeam\(\)/);
  assert.match(html, /teamPersistedModelMap\.get\(id\)!==modelId/);
  assert.match(html, /delete cfg\.models/);
  assert.doesNotMatch(html, /liveModel\|\|savedModels\[a\.id\]/);
  assert.match(html, /未读取到服务端配置/);
});

test("TM-09: Registry failure returns non-2xx and rolls team config back", async () => {
  const installRoot = mkdtempSync(join(tmpdir(), "cf-install-"));
  const businessRoot = mkdtempSync(join(tmpdir(), "cf-business-"));
  writeTeam(installRoot, "auto");
  const { app, cleanup } = buildTeamApp({
    installRoot,
    businessRoot,
    runtime: runtimeMock({ failUpdate: true }),
  });
  try {
    const response = await request(app)
      .patch("/api/v2/team/DEV-01/model")
      .send({ model_id: "claude-sonnet-5" });
    assert.equal(response.status, 500);
    const persisted = JSON.parse(readFileSync(join(installRoot, "codeflowmu.team.json"), "utf-8"));
    assert.equal(persisted.members[0].model.id, "auto");
  } finally {
    cleanup();
  }
});

test("TM-10: auto resolves through CURSOR_DEFAULT_MODEL or Cursor auto routing", () => {
  assert.deepEqual(resolveEffectiveModel("auto", "auto-smart"), {
    configured_model_id: "auto",
    effective_model_id: "auto-smart",
    source: "cursor_default_model",
  });
  assert.deepEqual(resolveEffectiveModel("auto", ""), {
    configured_model_id: "auto",
    effective_model_id: "auto",
    source: "cursor_auto",
  });
});

test("TM-11: unavailable model returns explicit error plus available models", async () => {
  const installRoot = mkdtempSync(join(tmpdir(), "cf-install-"));
  const businessRoot = mkdtempSync(join(tmpdir(), "cf-business-"));
  writeTeam(installRoot);
  const { app, cleanup } = buildTeamApp({
    installRoot,
    businessRoot,
    catalog: liveCatalog(["auto", "claude-sonnet-4-6"]),
  });
  try {
    const response = await request(app)
      .patch("/api/v2/team/DEV-01/model")
      .send({ model_id: "missing-model" });
    assert.equal(response.status, 422);
    assert.equal(response.body.code, "MODEL_NOT_AVAILABLE");
    assert.deepEqual(response.body.available_models, ["auto", "claude-sonnet-4-6"]);
  } finally {
    cleanup();
  }
});

test("TM-12: model catalog errors and API payloads do not leak Cursor API Key", async () => {
  const root = mkdtempSync(join(tmpdir(), "cf-secret-"));
  const secret = "cursor-secret-value";
  const catalog = await listCursorModels(root, {
    env: { CURSOR_API_KEY: secret },
    list: async () => {
      throw new Error(`authentication failed for ${secret}`);
    },
  });
  assert.equal(catalog.ok, false);
  assert.doesNotMatch(JSON.stringify(catalog), new RegExp(secret));
  assert.match(catalog.error ?? "", /\[REDACTED\]/);
});
