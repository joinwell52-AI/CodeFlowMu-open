/**
 * Mobile API integration tests — TASK-002
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import request from "supertest";
import type { Express } from "express";

import { stopAutoRecoveryBridge } from "../autoRecoveryBridge.ts";
import { buildWebPanelApp, wpResetProjectStoreForTests } from "../web-panel.ts";
import { ensureLedgerFresh, resetLedgerFreshGateForTests } from "../ledger-api-helpers.ts";
import { resetMobileGatewayClientForTests } from "../mobile/mobileGatewayClient.ts";
import { MobileDeviceStore } from "../mobile/mobileDeviceStore.ts";
import {
  formatMobileSseEvent,
  isMobileBlockedSseType,
} from "../mobile/mobileEvents.ts";
import { mergeMobileChatMessages } from "../mobile/mobileRoutes.ts";
import { resetMobileEventStoreForTests } from "../mobile/mobileEventStore.ts";
import { fcopLogsRuntimeDir, logsDateKey } from "../logs-paths.ts";
import { appendPanelRuntimeAction } from "../panel-runtime-actions.ts";
import { OperationApprovalService, PmQueueGuard, resolveLedgerLayout, type Runtime } from "@codeflowmu/runtime";

function makeV3ProjectRoot(): { root: string; inbox: string; reviews: string } {
  const root = mkdtempSync(join(tmpdir(), "cf-mobile-proj-"));
  const inbox = join(root, "fcop", "_lifecycle", "inbox");
  const reviews = join(root, "fcop", "reviews");
  mkdirSync(inbox, { recursive: true });
  mkdirSync(reviews, { recursive: true });
  mkdirSync(join(root, "fcop", "issues"), { recursive: true });
  writeFileSync(
    join(root, "fcop", "fcop.json"),
    JSON.stringify({ protocol_version: 3, mode: "team" }),
    "utf-8",
  );
  return { root, inbox, reviews };
}

function seedMinimalRule45ForTeam(root: string): void {
  const shared = join(root, "fcop", "shared");
  const rolesDir = join(shared, "roles");
  mkdirSync(rolesDir, { recursive: true });
  writeFileSync(join(shared, "TEAM-ROLES.md"), "# roles", "utf-8");
  writeFileSync(join(shared, "TEAM-OPERATING-RULES.md"), "# rules", "utf-8");
  for (const code of ["PM", "DEV", "QA", "OPS"]) {
    writeFileSync(join(rolesDir, `${code}.md`), `# ${code}`, "utf-8");
  }
}

function buildRuntimeMock(inboxDir: string, reviewsDir: string): Runtime {
  return {
    registry: { list: async () => [] },
    watcher: { dir: inboxDir },
    reviewWriter: { reviewsDir },
    sessionManager: {
      listActive: async () => [],
      startSession: async () => ({ session_id: "session-test" }),
      onEvent: () => () => {},
    },
    sessionStore: {
      listAll: async () => [],
      save: async () => {},
    },
    mcpInjector: {
      mode: "stub",
      listMounted: () => [],
    },
    reportDispatcher: {
      queueSnapshot: () => [],
    },
    pmQueueGuard: new PmQueueGuard(),
    panelEventBridge: {
      setSink: () => {},
      emit: () => {},
    },
    dispatcher: {
      getDispatchRetryRecord: () => null,
      listDispatchRetryRecords: () => [],
      adminRetryDispatch: async () => ({ kind: "dispatched" }),
      adminForceArchiveDispatch: async () => {},
      setDispatchRetryHook: () => {},
    },
    ledgerBuilder: { build: async () => ({}) },
  } as unknown as Runtime;
}

function cleanupPanel(app: Express): void {
  const cleanup = (app as unknown as { _sseCleanup?: () => void })._sseCleanup;
  cleanup?.();
  stopAutoRecoveryBridge();
  resetMobileGatewayClientForTests();
}

function buildMobilePanel(
  root: string,
  reviews: string,
  dataDir: string,
): Express {
  wpResetProjectStoreForTests(root);
  resetLedgerFreshGateForTests();
  const inbox = join(root, "fcop", "_lifecycle", "inbox");
  return buildWebPanelApp(buildRuntimeMock(inbox, reviews), {
    projectRoot: root,
    fcopReviewsDir: reviews,
    dataDir,
  });
}

function reserveListenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (!addr || typeof addr === "string") {
        probe.close();
        reject(new Error("reserveListenPort: no port"));
        return;
      }
      const port = addr.port;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function startPanelServer(app: Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function buildMobilePanelWithPort(
  root: string,
  reviews: string,
  dataDir: string,
  panelPort: number,
): Express {
  wpResetProjectStoreForTests(root);
  resetLedgerFreshGateForTests();
  const inbox = join(root, "fcop", "_lifecycle", "inbox");
  return buildWebPanelApp(buildRuntimeMock(inbox, reviews), {
    projectRoot: root,
    fcopReviewsDir: reviews,
    dataDir,
    panelPort,
  });
}

function seedReviewTaskForMobileProxy(root: string): {
  taskId: string;
  filename: string;
  reviewDir: string;
  doneDir: string;
} {
  const base = join(root, "fcop", "_lifecycle");
  const reviewDir = join(base, "review");
  const doneDir = join(base, "done");
  for (const d of [
    join(base, "inbox"),
    join(base, "active"),
    reviewDir,
    doneDir,
    join(base, "archive"),
  ]) {
    mkdirSync(d, { recursive: true });
  }
  const taskId = "TASK-20260618-100-ADMIN-to-PM";
  const filename = `${taskId}.md`;
  writeFileSync(
    join(reviewDir, filename),
    `---
protocol: fcop
version: 1
kind: task
task_id: ${taskId}
sender: ADMIN
recipient: PM
review_status: pending
state: review
---
# review task
`,
    "utf-8",
  );
  return { taskId, filename, reviewDir, doneDir };
}

type MobileApp = Express & {
  registerMobilePendingBind?: (bindId: string, token: string, ttlMs: number) => void;
};

test("mergeMobileChatMessages keeps mobile store when PC directChat exists", () => {
  const fromPc = [
    {
      role: "assistant",
      content: "old pc reply",
      created_at: "2026-06-16T10:00:00.000Z",
    },
  ];
  const fromStore = [
    {
      role: "user",
      content: "mobile only",
      created_at: "2026-06-16T10:01:00.000Z",
    },
  ];
  const merged = mergeMobileChatMessages(fromPc, fromStore, 200);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]!.content, "old pc reply");
  assert.equal(merged[1]!.content, "mobile only");
});

test("mobile API: auth, bind-confirm, bootstrap, revoke", async () => {
  const { root, inbox, reviews } = makeV3ProjectRoot();
  seedMinimalRule45ForTeam(root);
  const dataDir = mkdtempSync(join(tmpdir(), "cf-mobile-data-"));
  const app = buildMobilePanel(root, reviews, dataDir) as MobileApp;

  try {
    const noAuth = await request(app).get("/api/v2/mobile/bootstrap");
    assert.equal(noAuth.status, 403);
    assert.equal(noAuth.body.error, "MOBILE_AUTH_REQUIRED");

    const bindId = "bind_test_001";
    const bindToken = "bind_secret_token";
    assert.ok(app.registerMobilePendingBind, "registerMobilePendingBind exposed on app");
    app.registerMobilePendingBind!(bindId, bindToken, 60_000);

    const bindRes = await request(app)
      .post("/api/v2/mobile/bind-confirm")
      .send({ bind_id: bindId, token: bindToken, device_name: "Test Safari" });
    assert.equal(bindRes.status, 200);
    assert.equal(bindRes.body.ok, true);
    assert.ok(bindRes.body.mobile_session_token);
    assert.ok(bindRes.body.device_id);
    assert.ok(bindRes.body.api_base);
    assert.match(String(bindRes.body.api_base), /\/m\/[a-f0-9]{16}$/);

    const token = String(bindRes.body.mobile_session_token);
    const deviceId = String(bindRes.body.device_id);

    const bootstrap = await request(app)
      .get("/api/v2/mobile/bootstrap")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.body.app, "codeflowmu-mobile");
    assert.ok(bootstrap.body.api_base);
    assert.match(String(bootstrap.body.api_base), /\/m\/[a-f0-9]{16}$/);
    assert.ok(bootstrap.body.summary);
    assert.equal(typeof bootstrap.body.summary.tasks_open, "number");

    const tasks = await request(app)
      .get("/api/v2/mobile/tasks")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(tasks.status, 200);
    assert.ok(Array.isArray(tasks.body.tasks));

    const reports = await request(app)
      .get("/api/v2/mobile/reports")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(reports.status, 200);
    assert.ok(Array.isArray(reports.body.reports));

    writeFileSync(
      join(reviews, "REVIEW-20260617-001-REVIEW-GATE-on-TASK-20260617-001.md"),
      `---
protocol: fcop
version: 1
kind: review
review_id: REVIEW-20260617-001-REVIEW-GATE
subject_id: REPORT-20260617-001-DEV-to-PM
task_id: TASK-20260617-001
report_id: REPORT-20260617-001-DEV-to-PM
reviewer: REVIEW-GATE
decision: needs_human
reviewed_at: 2026-06-17T10:00:00.000Z
fact_check_verdict: fail
reason_code: missing_file_evidence
---
# Review Fact Check

Task: TASK-20260617-001
`,
      "utf-8",
    );

    const approvalId = "APPROVAL-MOBILE-001";
    new OperationApprovalService({ projectRoot: root, idFactory: () => approvalId }).prepare({
      request: {
        subject: { actor: "DEV-01", role: "DEV", project_id: "mobile-test" },
        action: { capability: "git.remote.push", operation: "push_branch", executor: "git.push" },
        resource: { type: "git_remote_branch", targets: ["origin/main"], scope: { cwd: root, branch: "main" } },
        context: {
          workspace: root,
          environment: "external_git_remote",
          initiated_by: "agent",
          authorization_source: "none",
          human_confirmation_id: null,
        },
        effect: { external_write: true },
        snapshot: { local_sha: "abc", remote_sha: null },
      },
      reason: "移动端操作审批列表回归",
      effects: ["将更新远端分支"],
      non_effects: ["不会合并分支"],
      recovery: "可回退远端分支",
    });

    const approvals = await request(app)
      .get("/api/v2/mobile/approvals")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(approvals.status, 200);
    assert.ok(Array.isArray(approvals.body.approvals));
    assert.ok(
      approvals.body.approvals.some((row: { filename?: string; status?: string }) =>
        row.filename === approvalId && row.status === "pending",
      ),
    );
    assert.equal(
      approvals.body.approvals.some((row: { filename?: string }) =>
        row.filename === "REVIEW-20260617-001-REVIEW-GATE-on-TASK-20260617-001.md",
      ),
      false,
    );
    const approvalWithoutReason = await request(app)
      .post(`/api/v2/mobile/approvals/${approvalId}/approve`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    assert.equal(approvalWithoutReason.status, 400);
    assert.equal(approvalWithoutReason.body.error, "APPROVAL_REASON_REQUIRED");

    const approved = await request(app)
      .post(`/api/v2/mobile/approvals/${approvalId}/approve`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "ADMIN 在已绑定移动端确认精确摘要" });
    assert.equal(approved.status, 200);
    assert.equal(typeof approved.body.execution_token, "string");
    assert.equal(approved.body.approval.status, "approved");

    const activity = await request(app)
      .get("/api/v2/mobile/activity")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(activity.status, 200);
    assert.equal(activity.body.ok, true);
    assert.ok(Array.isArray(activity.body.events));

    const taskActivity = await request(app)
      .get("/api/v2/mobile/tasks/TASK-TEST-001/activity")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(taskActivity.status, 200);
    assert.equal(taskActivity.body.ok, true);
    assert.ok(Array.isArray(taskActivity.body.events));

    const tinyPngB64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const upload = await request(app)
      .post("/api/v2/mobile/attachments/upload")
      .set("Authorization", `Bearer ${token}`)
      .send({
        filename: "test.png",
        mime: "image/png",
        data_base64: tinyPngB64,
      });
    assert.equal(upload.status, 200);
    assert.equal(upload.body.ok, true);
    assert.equal(upload.body.attachment.type, "image");
    assert.ok(upload.body.attachment.local_path);

    const fileGet = await request(app)
      .get("/api/v2/mobile/files/attachment")
      .query({ path: upload.body.attachment.local_path })
      .set("Authorization", `Bearer ${token}`);
    assert.equal(fileGet.status, 200);
    assert.equal(fileGet.body.ok, true);
    assert.equal(fileGet.body.mime, "image/png");
    assert.ok(fileGet.body.base64);

    const inboxCountBefore = readdirSync(inbox).filter((name) => name.endsWith(".md")).length;

    const chat = await request(app)
      .get("/api/v2/mobile/chat/messages")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(chat.status, 200);
    assert.equal(chat.body.ok, true);
    assert.ok(Array.isArray(chat.body.messages));
    assert.equal(chat.body.messages.length, 0);

    const chatSend = await request(app)
      .post("/api/v2/mobile/chat/send")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "巡检开工" });
    assert.equal(chatSend.status, 200);
    assert.equal(chatSend.body.ok, true);
    assert.equal(chatSend.body.message.role, "user");
    assert.equal(chatSend.body.message.content, "巡检开工");
    assert.ok(chatSend.body.message.created_at);
    assert.equal(chatSend.body.forwarded, "pending");

    const inboxCountAfter = readdirSync(inbox).filter((name) => name.endsWith(".md")).length;
    assert.equal(inboxCountAfter, inboxCountBefore);

    const chatAgain = await request(app)
      .get("/api/v2/mobile/chat/messages")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(chatAgain.status, 200);
    assert.equal(chatAgain.body.messages.length, 1);
    assert.equal(chatAgain.body.messages[0].content, "巡检开工");

    const store = new MobileDeviceStore(dataDir);
    store.revokeDevice(deviceId);

    const afterRevoke = await request(app)
      .get("/api/v2/mobile/bootstrap")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(afterRevoke.status, 403);
    assert.equal(afterRevoke.body.error, "MOBILE_AUTH_FORBIDDEN");

  } finally {
    cleanupPanel(app);
  }
});

test("mobile panel API: bind-prepare, devices, revoke", async () => {
  const { root, reviews } = makeV3ProjectRoot();
  seedMinimalRule45ForTeam(root);
  const dataDir = mkdtempSync(join(tmpdir(), "cf-mobile-panel-data-"));
  const app = buildMobilePanel(root, reviews, dataDir);

  try {
    const status = await request(app).get("/api/v2/mobile/panel/status");
    assert.equal(status.status, 200);
    assert.equal(status.body.ok, true);
    assert.ok(status.body.instance_id);
    assert.equal(typeof status.body.gateway_online, "boolean");
    assert.ok(status.body.public_base_url);
    assert.ok("gateway_url" in status.body);
    assert.ok("last_connected_at" in status.body);
    assert.ok("last_error" in status.body);
    assert.ok("last_seen_at" in status.body);

    const prep = await request(app).post("/api/v2/mobile/panel/bind-prepare");
    assert.equal(prep.status, 200);
    assert.equal(prep.body.ok, true);
    assert.ok(prep.body.bind_id);
    assert.ok(prep.body.token);
    assert.ok(prep.body.expires_at);
    assert.equal(prep.body.instance_id, status.body.instance_id);

    const bindRes = await request(app)
      .post("/api/v2/mobile/bind-confirm")
      .send({
        bind_id: prep.body.bind_id,
        token: prep.body.token,
        device_name: "Panel Test Device",
      });
    assert.equal(bindRes.status, 200);
    assert.equal(bindRes.body.ok, true);
    const deviceId = String(bindRes.body.device_id);
    const sessionToken = String(bindRes.body.mobile_session_token);

    const bindReplay = await request(app)
      .post("/api/v2/mobile/bind-confirm")
      .send({
        bind_id: prep.body.bind_id,
        token: prep.body.token,
        device_name: "Panel Test Device",
      });
    assert.equal(bindReplay.status, 200);
    assert.equal(bindReplay.body.ok, true);
    assert.equal(bindReplay.body.replay, true);
    assert.equal(bindReplay.body.device_id, deviceId);
    assert.equal(bindReplay.body.mobile_session_token, sessionToken);

    const devices = await request(app).get("/api/v2/mobile/panel/devices");
    assert.equal(devices.status, 200);
    assert.equal(devices.body.ok, true);
    assert.ok(Array.isArray(devices.body.devices));
    assert.ok(devices.body.devices.some((d: { device_id: string }) => d.device_id === deviceId));
    const listed = devices.body.devices.find((d: { device_id: string }) => d.device_id === deviceId);
    assert.equal(listed.enabled, true);
    assert.equal("session_token_hash" in listed, false);

    const revoke = await request(app).post(`/api/v2/mobile/panel/devices/${deviceId}/revoke`);
    assert.equal(revoke.status, 200);
    assert.equal(revoke.body.ok, true);

    const after = await request(app).get("/api/v2/mobile/panel/devices");
    const row = after.body.devices.find((d: { device_id: string }) => d.device_id === deviceId);
    assert.ok(row);
    assert.equal(row.enabled, false);

    const token = String(bindRes.body.mobile_session_token);
    const forbidden = await request(app)
      .get("/api/v2/mobile/bootstrap")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(forbidden.status, 403);
  } finally {
    cleanupPanel(app);
  }
});

test("mobile panel API: revoke-others and purge-revoked", async () => {
  const { root, reviews } = makeV3ProjectRoot();
  seedMinimalRule45ForTeam(root);
  const dataDir = mkdtempSync(join(tmpdir(), "cf-mobile-panel-bulk-"));
  const app = buildMobilePanel(root, reviews, dataDir);
  const deviceIds: string[] = [];

  async function bindOne(name: string): Promise<string> {
    const prep = await request(app).post("/api/v2/mobile/panel/bind-prepare");
    assert.equal(prep.status, 200);
    const bindRes = await request(app)
      .post("/api/v2/mobile/bind-confirm")
      .send({
        bind_id: prep.body.bind_id,
        token: prep.body.token,
        device_name: name,
      });
    assert.equal(bindRes.status, 200);
    const id = String(bindRes.body.device_id);
    deviceIds.push(id);
    return id;
  }

  try {
    await bindOne("Device A");
    await bindOne("Device B");
    const keepId = await bindOne("Device C");

    const store = new MobileDeviceStore(dataDir);
    store.touchLastSeen(keepId);

    const bulk = await request(app)
      .post("/api/v2/mobile/panel/devices/revoke-others")
      .send({});
    assert.equal(bulk.status, 200);
    assert.equal(bulk.body.ok, true);
    assert.equal(bulk.body.kept_device_id, keepId);
    assert.equal(bulk.body.revoked_device_ids.length, 2);

    const list1 = await request(app).get("/api/v2/mobile/panel/devices");
    assert.equal(list1.body.devices.filter((d: { enabled: boolean }) => d.enabled !== false).length, 1);

    const purge = await request(app).post("/api/v2/mobile/panel/devices/purge-revoked");
    assert.equal(purge.status, 200);
    assert.equal(purge.body.ok, true);
    assert.equal(purge.body.removed_count, 2);

    const list2 = await request(app).get("/api/v2/mobile/panel/devices");
    assert.equal(list2.body.devices.length, 1);
    assert.equal(list2.body.devices[0].device_id, keepId);
  } finally {
    cleanupPanel(app);
  }
});

test("mobile API: attachment upload validation", async () => {
  const { root, reviews } = makeV3ProjectRoot();
  seedMinimalRule45ForTeam(root);
  const dataDir = mkdtempSync(join(tmpdir(), "cf-mobile-attach-"));
  const app = buildMobilePanel(root, reviews, dataDir) as MobileApp;

  try {
    const bindId = "bind_attach_001";
    const bindToken = "bind_attach_secret";
    app.registerMobilePendingBind!(bindId, bindToken, 60_000);
    const bindRes = await request(app)
      .post("/api/v2/mobile/bind-confirm")
      .send({ bind_id: bindId, token: bindToken, device_name: "Attach Test" });
    assert.equal(bindRes.status, 200);
    const token = String(bindRes.body.mobile_session_token);

    const tinyPngB64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    const badMime = await request(app)
      .post("/api/v2/mobile/attachments/upload")
      .set("Authorization", `Bearer ${token}`)
      .send({ filename: "x.gif", mime: "image/gif", data_base64: tinyPngB64 });
    assert.equal(badMime.status, 415);
    assert.equal(badMime.body.error, "UNSUPPORTED_IMAGE_MIME");

    const emptyName = await request(app)
      .post("/api/v2/mobile/attachments/upload")
      .set("Authorization", `Bearer ${token}`)
      .send({ filename: "", mime: "image/png", data_base64: tinyPngB64 });
    assert.equal(emptyName.status, 200);
    assert.equal(emptyName.body.ok, true);
    assert.ok(emptyName.body.attachment.local_path);
    assert.match(String(emptyName.body.attachment.filename), /^img-/);

    const tooLarge = Buffer.alloc(10 * 1024 * 1024 + 1, 0).toString("base64");
    const largeRes = await request(app)
      .post("/api/v2/mobile/attachments/upload")
      .set("Authorization", `Bearer ${token}`)
      .send({ filename: "big.png", mime: "image/png", data_base64: tooLarge });
    assert.equal(largeRes.status, 413);
    assert.equal(largeRes.body.error, "ATTACHMENT_TOO_LARGE");
    assert.equal(largeRes.body.layer, "shell");
    assert.equal(largeRes.body.actual_bytes, 10 * 1024 * 1024 + 1);
    assert.equal(largeRes.body.max_bytes, 10 * 1024 * 1024);

    const badPath = await request(app)
      .get("/api/v2/mobile/files/attachment")
      .query({ path: "fcop/../fcop.json" })
      .set("Authorization", `Bearer ${token}`);
    assert.equal(badPath.status, 400);
    assert.equal(badPath.body.error, "ATTACHMENT_PATH_NOT_ALLOWED");
  } finally {
    cleanupPanel(app);
  }
});

test("mobile events: block agent snapshots and sdk logs", () => {
  assert.equal(isMobileBlockedSseType("codeflowmu.agents_snapshot"), true);
  assert.equal(isMobileBlockedSseType("sdk.message"), true);
  assert.equal(formatMobileSseEvent("codeflowmu.agents_snapshot", { agents: [] }), null);
  const mapped = formatMobileSseEvent("codeflowmu.task_created", {
    task_id: "TASK-20260615-001",
    filename: "TASK-20260615-001-ADMIN-to-PM.md",
  });
  assert.ok(mapped);
  assert.equal(mapped!.event, "task_changed");
  assert.equal(mapped!.data.task_id, "TASK-20260615-001");
  assert.equal("agents" in mapped!.data, false);
});

test("mobile panel API: version-history", async () => {
  const { root, reviews } = makeV3ProjectRoot();
  seedMinimalRule45ForTeam(root);
  const dataDir = mkdtempSync(join(tmpdir(), "cf-mobile-version-history-"));
  const app = buildMobilePanel(root, reviews, dataDir);

  try {
    const res = await request(app).get("/api/v2/mobile/panel/version-history");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(Array.isArray(res.body.items));
    assert.ok(res.body.items.length >= 1);
    assert.equal(res.body.items[0].version, "V1.1.18");
    assert.equal(res.body.items[0].date, "2026-07-14");
    assert.ok(Array.isArray(res.body.items[0].changes));
    assert.ok(res.body.items[0].changes.length > 0);
    const v100 = res.body.items.find((i: { version: string }) => i.version === "V1.0.0");
    assert.ok(v100);
    assert.ok(Array.isArray(v100.tasks));
    assert.ok(v100.tasks.includes("TASK-010R-C1"));
    assert.ok(v100.tasks.includes("TASK-010R-D"));
  } finally {
    cleanupPanel(app);
  }
});

test("mobile API: activity merges think stream and includes runtime actions", async () => {
  const { root, reviews } = makeV3ProjectRoot();
  seedMinimalRule45ForTeam(root);
  resetMobileEventStoreForTests(root);
  const dataDir = mkdtempSync(join(tmpdir(), "cf-mobile-activity-live-"));
  const app = buildMobilePanel(root, reviews, dataDir) as MobileApp;

  const taskId = "TASK-20260617-002";
  const dateKey = logsDateKey();
  const thinkingDir = join(root, "fcop", "logs", "thinking", "task");
  const runtimeDir = fcopLogsRuntimeDir(root);
  mkdirSync(thinkingDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });

  const thoughtLines = [
    JSON.stringify({
      ts: 1718610360000,
      at: "2026-06-17T09:06:00.000Z",
      channel: "task",
      event_type: "sdk.thinking",
      agent_id: "PM-01",
      task_id: taskId,
      payload: { text: "正在分析任务范围。" },
    }),
    JSON.stringify({
      ts: 1718610365000,
      at: "2026-06-17T09:06:05.000Z",
      channel: "task",
      event_type: "sdk.thinking",
      agent_id: "PM-01",
      task_id: taskId,
      payload: { text: "下一步将检查依赖与阻塞项。" },
    }),
    JSON.stringify({
      ts: 1718610372000,
      at: "2026-06-17T09:06:12.000Z",
      channel: "task",
      event_type: "sdk.thinking",
      agent_id: "PM-01",
      task_id: taskId,
      payload: { text: "完成后写回执。" },
    }),
  ];
  const toolLine = JSON.stringify({
    ts: 1718610480000,
    at: "2026-06-17T09:08:00.000Z",
    channel: "task",
    event_type: "sdk.tool_call",
    agent_id: "PM-01",
    task_id: taskId,
    payload: {
      raw: {
        name: "shell",
        status: "completed",
        args: { command: "python -c print('ok')" },
      },
    },
  });
  writeFileSync(
    join(thinkingDir, `thinking-${dateKey}.jsonl`),
    thoughtLines.join("\n") + "\n" + toolLine + "\n",
    "utf-8",
  );

  appendPanelRuntimeAction(root, {
    operator: "ADMIN",
    action: "submit_review",
    target_task: taskId,
    result: "ok",
    detail: "Agent 已提交回执，等待审批",
  });

  try {
    const bindId = "bind_activity_live";
    const bindToken = "bind_activity_live_secret";
    assert.ok(app.registerMobilePendingBind);
    app.registerMobilePendingBind!(bindId, bindToken, 60_000);

    const confirm = await request(app)
      .post("/api/v2/mobile/bind-confirm")
      .send({ bind_id: bindId, token: bindToken, device_name: "activity-test" });
    assert.equal(confirm.status, 200);
    const token = confirm.body.mobile_session_token as string;

    const activity = await request(app)
      .get("/api/v2/mobile/activity?limit=80")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(activity.status, 200);
    assert.equal(activity.body.ok, true);
    assert.ok(Array.isArray(activity.body.events));

    const thinkEvents = activity.body.events.filter(
      (e: { consoleKind: string; source: string }) =>
        e.consoleKind === "think" && e.source === "think_console",
    );
    assert.equal(thinkEvents.length, 1, "same-agent thoughts within 15s should merge");
    const thought = thinkEvents[0];
    assert.equal(thought.agent, "PM-01");
    assert.match(thought.summary, /正在分析任务范围/);
    assert.match(thought.summary, /下一步将检查依赖/);
    assert.match(thought.summary, /完成后写回执/);

    assert.ok(
      !activity.body.events.some((e: { consoleKind: string }) => e.consoleKind === "tool"),
      "tool_call rows must not appear in activity stream",
    );

    const runtime = activity.body.events.find(
      (e: { consoleKind: string; source: string }) =>
        e.consoleKind === "runtime" && e.source === "runtime_action",
    );
    assert.ok(runtime, "expected runtime_action event from panel runtime log");
    assert.match(runtime.summary, /已提交验收/);

    const taskActivity = await request(app)
      .get(`/api/v2/mobile/tasks/${taskId}/activity?limit=100`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(taskActivity.status, 200);
    assert.ok(taskActivity.body.events.length >= 1);
    assert.ok(
      taskActivity.body.events.every(
        (e: { consoleKind: string }) => e.consoleKind !== "tool",
      ),
    );
  } finally {
    cleanupPanel(app);
    resetMobileEventStoreForTests(root);
  }
});

test("mobile API: activity returns empty when no thinking jsonl", async () => {
  const { root, reviews } = makeV3ProjectRoot();
  seedMinimalRule45ForTeam(root);
  resetMobileEventStoreForTests(root);
  const dataDir = mkdtempSync(join(tmpdir(), "cf-mobile-activity-fallback-"));
  const app = buildMobilePanel(root, reviews, dataDir) as MobileApp;

  try {
    const bindId = "bind_activity_fallback";
    const bindToken = "bind_activity_fallback_secret";
    assert.ok(app.registerMobilePendingBind);
    app.registerMobilePendingBind!(bindId, bindToken, 60_000);

    const confirm = await request(app)
      .post("/api/v2/mobile/bind-confirm")
      .send({ bind_id: bindId, token: bindToken, device_name: "fallback-test" });
    assert.equal(confirm.status, 200);
    const token = confirm.body.mobile_session_token as string;

    const activity = await request(app)
      .get("/api/v2/mobile/activity?limit=80")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(activity.status, 200);
    assert.equal(activity.body.ok, true);
    assert.ok(Array.isArray(activity.body.events));
    assert.equal(activity.body.events.length, 0);
  } finally {
    cleanupPanel(app);
    resetMobileEventStoreForTests(root);
  }
});

function seedMobileRoleTaskFixture(root: string): {
  adminPm: string;
  pmDev: string;
  pmQa: string;
  pmOps: string;
} {
  const layout = resolveLedgerLayout(root);
  mkdirSync(layout.ledgerDir, { recursive: true });
  const inbox = join(root, "fcop", "_lifecycle", "inbox");
  const active = join(root, "fcop", "_lifecycle", "active");
  mkdirSync(inbox, { recursive: true });
  mkdirSync(active, { recursive: true });

  const adminPm = "TASK-20260617-001-ADMIN-to-PM.md";
  const pmDev = "TASK-20260617-002-PM-to-DEV.md";
  const pmQa = "TASK-20260617-003-PM-to-QA.md";
  const pmOps = "TASK-20260617-004-PM-to-OPS.md";
  const thread = "thread-mobile-role-filter";

  writeFileSync(
    join(inbox, adminPm),
    `---
protocol: fcop
version: 1
task_id: TASK-20260617-001-ADMIN-to-PM
sender: ADMIN
recipient: PM
thread_key: ${thread}
---
# Admin to PM main
`,
    "utf-8",
  );

  const childSpecs: Array<[string, string, string]> = [
    [pmDev, "DEV", "002"],
    [pmQa, "QA", "003"],
    [pmOps, "OPS", "004"],
  ];

  for (const [fn, recip, seq] of childSpecs) {
    writeFileSync(
      join(active, fn),
      `---
protocol: fcop
version: 1
task_id: TASK-20260617-${seq}-PM-to-${recip}
sender: PM
recipient: ${recip}
parent: TASK-20260617-001-ADMIN-to-PM
thread_key: ${thread}
---
# PM to ${recip}
`,
      "utf-8",
    );
  }

  const ledgerRows = [
    {
      task_id: "TASK-20260617-001-ADMIN-to-PM",
      filename: adminPm,
      sender: "ADMIN",
      recipient: "PM",
      bucket: "inbox",
      state: "inbox",
      path: `fcop/_lifecycle/inbox/${adminPm}`,
      updated_at: "2026-06-17T20:00:00Z",
      thread_key: thread,
    },
    ...childSpecs.map(([fn, recip, seq], i) => ({
      task_id: `TASK-20260617-${seq}-PM-to-${recip}`,
      filename: fn,
      sender: "PM",
      recipient: recip,
      bucket: "active",
      state: "active",
      path: `fcop/_lifecycle/active/${fn}`,
      updated_at: `2026-06-17T1${i}:00:00Z`,
      thread_key: thread,
      parent: "TASK-20260617-001-ADMIN-to-PM",
    })),
  ];

  writeFileSync(
    join(layout.ledgerDir, "tasks.jsonl"),
    ledgerRows.map((r) => JSON.stringify(r)).join("\n"),
    "utf-8",
  );

  return { adminPm, pmDev, pmQa, pmOps };
}

async function bindMobileTestSession(app: MobileApp): Promise<string> {
  const bindId = "bind_role_filter";
  const bindToken = "bind_role_filter_secret";
  assert.ok(app.registerMobilePendingBind);
  app.registerMobilePendingBind!(bindId, bindToken, 60_000);
  const bindRes = await request(app)
    .post("/api/v2/mobile/bind-confirm")
    .send({ bind_id: bindId, token: bindToken, device_name: "RoleFilterTest" });
  assert.equal(bindRes.status, 200);
  return String(bindRes.body.mobile_session_token);
}

test("mobile API: tasks recipient filter and admin PM detail", async () => {
  const { root, reviews } = makeV3ProjectRoot();
  seedMinimalRule45ForTeam(root);
  seedMobileRoleTaskFixture(root);
  const dataDir = mkdtempSync(join(tmpdir(), "cf-mobile-role-data-"));
  const app = buildMobilePanel(root, reviews, dataDir) as MobileApp;

  try {
    const token = await bindMobileTestSession(app);

    const pmList = await request(app)
      .get("/api/v2/mobile/tasks")
      .query({ recipient: "PM" })
      .set("Authorization", `Bearer ${token}`);
    assert.equal(pmList.status, 200);
    assert.equal(pmList.body.filtered_by, "PM");
    const pmFiles = pmList.body.tasks.map((t: { filename: string }) => t.filename);
    assert.ok(pmFiles.includes("TASK-20260617-001-ADMIN-to-PM.md"));
    assert.equal(
      pmFiles.some((f: string) => f.includes("PM-to-DEV") || f.includes("PM-to-QA")),
      false,
    );

    const devList = await request(app)
      .get("/api/v2/mobile/tasks")
      .query({ recipient: "DEV" })
      .set("Authorization", `Bearer ${token}`);
    assert.equal(devList.status, 200);
    assert.equal(devList.body.tasks.length, 1);
    assert.equal(devList.body.tasks[0].filename, "TASK-20260617-002-PM-to-DEV.md");

    const detail = await request(app)
      .get("/api/v2/mobile/tasks/TASK-20260617-001-ADMIN-to-PM.md")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(detail.status, 200);
    assert.ok(Array.isArray(detail.body.child_tasks));
    assert.equal(detail.body.child_tasks.length, 3);
    const childRecipients = detail.body.child_tasks.map(
      (c: { recipient?: string; to?: string }) =>
        String(c.recipient ?? c.to ?? "").toUpperCase(),
    );
    assert.ok(childRecipients.includes("DEV"));
    assert.ok(childRecipients.includes("QA"));
    assert.ok(childRecipients.includes("OPS"));
    assert.ok(Array.isArray(detail.body.flow_overview));
    assert.ok(detail.body.flow_overview.length >= 2);
    assert.ok(Array.isArray(detail.body.available_actions));
    assert.ok(detail.body.available_actions.some((a: { id: string }) => a.id === "back"));

    const badAction = await request(app)
      .post("/api/v2/mobile/tasks/TASK-20260617-001-ADMIN-to-PM.md/actions")
      .set("Authorization", `Bearer ${token}`)
      .send({ action: "not_a_real_action" });
    assert.equal(badAction.status, 400);
    assert.equal(badAction.body.error, "UNKNOWN_ACTION");
  } finally {
    cleanupPanel(app);
  }
});

test("mobile API: task list includes archived lifecycle tasks without include_archive", async () => {
  const { root, reviews } = makeV3ProjectRoot();
  seedMinimalRule45ForTeam(root);
  seedMobileRoleTaskFixture(root);
  const layout = resolveLedgerLayout(root);
  const archivedFn = "TASK-20260617-099-ADMIN-to-PM.md";
  const archiveDir = join(root, "fcop", "_lifecycle", "archive");
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(
    join(archiveDir, archivedFn),
    `---
protocol: fcop
version: 1
task_id: TASK-20260617-099-ADMIN-to-PM
sender: ADMIN
recipient: PM
---
# Archived PM task
`,
    "utf-8",
  );
  const ledgerPath = join(layout.ledgerDir, "tasks.jsonl");
  const archivedRow = {
    task_id: "TASK-20260617-099-ADMIN-to-PM",
    filename: archivedFn,
    sender: "ADMIN",
    recipient: "PM",
    bucket: "archive",
    state: "archive",
    path: `fcop/_lifecycle/archive/${archivedFn}`,
    updated_at: "2026-06-17T21:00:00Z",
  };
  writeFileSync(ledgerPath, `${readFileSync(ledgerPath, "utf-8").trim()}\n${JSON.stringify(archivedRow)}`, "utf-8");

  const dataDir = mkdtempSync(join(tmpdir(), "cf-mobile-archive-list-"));
  const app = buildMobilePanel(root, reviews, dataDir) as MobileApp;

  try {
    const token = await bindMobileTestSession(app);
    const pmList = await request(app)
      .get("/api/v2/mobile/tasks")
      .query({ recipient: "PM" })
      .set("Authorization", `Bearer ${token}`);
    assert.equal(pmList.status, 200);
    const pmFiles = pmList.body.tasks.map((t: { filename: string }) => t.filename);
    assert.ok(pmFiles.includes(archivedFn), "archived PM task should appear in mobile list");
    const archived = pmList.body.tasks.find((t: { filename: string }) => t.filename === archivedFn);
    assert.equal(archived.bucket, "archive");
  } finally {
    cleanupPanel(app);
  }
});

test("mobile task approve proxies to panel lifecycle API", async () => {
  const { root, reviews } = makeV3ProjectRoot();
  seedMinimalRule45ForTeam(root);
  const { filename, reviewDir, doneDir } = seedReviewTaskForMobileProxy(root);
  const dataDir = mkdtempSync(join(tmpdir(), "cf-mobile-proxy-"));
  const port = await reserveListenPort();
  const app = buildMobilePanelWithPort(root, reviews, dataDir, port) as MobileApp;
  const server = await startPanelServer(app, port);
  try {
    const token = await bindMobileTestSession(app);
    const res = await request(app)
      .post(`/api/v2/mobile/tasks/${filename}/actions`)
      .set("Authorization", `Bearer ${token}`)
      .send({ action: "approve" });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.to, "done");
    assert.equal(res.body.task_transition, undefined);
    assert.ok(!existsSync(join(reviewDir, filename)));
    assert.ok(existsSync(join(doneDir, filename)));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    cleanupPanel(app);
  }
});

test("mobile task reject without reason returns REJECT_REASON_REQUIRED", async () => {
  const { root, reviews } = makeV3ProjectRoot();
  seedMinimalRule45ForTeam(root);
  const { filename } = seedReviewTaskForMobileProxy(root);
  const dataDir = mkdtempSync(join(tmpdir(), "cf-mobile-proxy-reject-"));
  const port = await reserveListenPort();
  const app = buildMobilePanelWithPort(root, reviews, dataDir, port) as MobileApp;
  const server = await startPanelServer(app, port);
  try {
    const token = await bindMobileTestSession(app);
    const res = await request(app)
      .post(`/api/v2/mobile/tasks/${filename}/actions`)
      .set("Authorization", `Bearer ${token}`)
      .send({ action: "reject" });
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, "REJECT_REASON_REQUIRED");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    cleanupPanel(app);
  }
});

test("GET /api/v2/mobile/gateway/status returns gateway fields when client not started", async () => {
  const { root, reviews } = makeV3ProjectRoot();
  seedMinimalRule45ForTeam(root);
  const dataDir = mkdtempSync(join(tmpdir(), "cf-mobile-gw-status-"));
  const app = buildMobilePanel(root, reviews, dataDir);
  try {
    const res = await request(app).get("/api/v2/mobile/gateway/status");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.online, false);
    assert.equal(res.body.reconnecting, false);
    assert.ok("instance_id" in res.body);
    assert.ok("last_connected_at" in res.body);
    assert.ok("last_error" in res.body);
  } finally {
    cleanupPanel(app);
  }
});

test("POST /api/v2/mobile/gateway/reconnect returns 502 when gateway client not started", async () => {
  const { root, reviews } = makeV3ProjectRoot();
  seedMinimalRule45ForTeam(root);
  const dataDir = mkdtempSync(join(tmpdir(), "cf-mobile-gw-reconnect-"));
  const app = buildMobilePanel(root, reviews, dataDir);
  try {
    const res = await request(app).post("/api/v2/mobile/gateway/reconnect");
    assert.equal(res.status, 502);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, "NOT_STARTED");
  } finally {
    cleanupPanel(app);
  }
});

test("mobile API: reports list returns readable title from ## 结论", async () => {
  const { root, reviews } = makeV3ProjectRoot();
  seedMinimalRule45ForTeam(root);
  const reportsDir = join(root, "fcop", "reports");
  mkdirSync(reportsDir, { recursive: true });
  const reportFn = "REPORT-20260620-008-DEV-to-PM.md";
  writeFileSync(
    join(reportsDir, reportFn),
    `---
protocol: fcop
sender: DEV
recipient: PM
status: done
---

## 结论

**done** — 手机端报告列表标题修复验收样例。
`,
    "utf-8",
  );
  await ensureLedgerFresh(root, { rebuild: true });
  const dataDir = mkdtempSync(join(tmpdir(), "cf-mobile-report-title-"));
  const app = buildMobilePanel(root, reviews, dataDir) as MobileApp;

  try {
    const token = await bindMobileTestSession(app);
    const res = await request(app)
      .get("/api/v2/mobile/reports")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    const row = res.body.reports.find((r: { filename: string }) => r.filename === reportFn);
    assert.ok(row, "seeded report in list");
    assert.match(String(row.title), /报告列表标题修复/);
    assert.notEqual(row.title, "REPORT-20260620-008-DEV-to-PM");
  } finally {
    cleanupPanel(app);
  }
});
