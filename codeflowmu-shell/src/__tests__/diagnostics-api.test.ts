/**
 * Diagnostics Shell API — GET/POST /api/v2/diagnostics*, tasks/stats diagnostics_count
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import request from "supertest";

import { PmQueueGuard, resolveLedgerLayout } from "@codeflowmu/runtime";

import { buildWebPanelApp, wpResetProjectStoreForTests } from "../web-panel.ts";
import { resetLedgerFreshGateForTests } from "../ledger-api-helpers.ts";
import { stopAutoRecoveryBridge } from "../autoRecoveryBridge.ts";
import {
  getDiagnosticsListResponseConfirmed,
  type DiagnosticsListConfirmOptions,
} from "../diagnostics-api-helpers.ts";
import type { Runtime } from "@codeflowmu/runtime";

const tempRoots: string[] = [];

function buildRuntimeMock(inboxDir: string): Runtime {
  return {
    registry: { list: async () => [] },
    watcher: { dir: inboxDir },
    reviewWriter: { reviewsDir: join(tmpdir(), "cf-diag-reviews-" + Date.now()) },
    sessionManager: {
      listActive: async () => [],
      startSession: async () => ({ session_id: "sess-test" }),
      onEvent: () => () => {},
    },
    sessionStore: { listAll: async () => [], save: async () => {} },
    mcpInjector: { mode: "stub", listMounted: () => [] },
    reportDispatcher: { queueSnapshot: () => [] },
    pmQueueGuard: new PmQueueGuard(),
    panelEventBridge: { setSink: () => {} },
    dispatcher: {
      getDispatchRetryRecord: () => null,
      listDispatchRetryRecords: () => [],
      adminRetryDispatch: async () => ({ kind: "dispatched" }),
      adminForceArchiveDispatch: async () => {},
      setDispatchRetryHook: () => {},
    },
  } as unknown as Runtime;
}

function makeDiagnosticsProject(): string {
  const root = mkdtempSync(join(tmpdir(), "cf-diagnostics-api-"));
  const layout = resolveLedgerLayout(root);
  mkdirSync(layout.ledgerDir, { recursive: true });
  mkdirSync(join(root, "fcop", "_lifecycle", "inbox"), { recursive: true });
  mkdirSync(join(root, "fcop", "_lifecycle", "active"), { recursive: true });
  mkdirSync(join(root, "fcop", "_lifecycle", "archive"), { recursive: true });

  writeFileSync(
    join(root, "fcop", "fcop.json"),
    JSON.stringify({ protocol_version: 3, mode: "team" }),
    "utf-8",
  );

  // tasks.jsonl uses canonical task_id prefix (matches LedgerBuilder.reconcile).
  const orphanTaskId = "TASK-20260609-005-PM-to-OPS";
  const orphanDiagId = `ledger_orphan:${orphanTaskId}`;
  const normalTaskId = "TASK-20260609-001-ADMIN-to-PM";

  writeFileSync(
    join(layout.ledgerDir, "tasks.jsonl"),
    [
      JSON.stringify({
        task_id: orphanTaskId,
        filename: "TASK-20260609-005-PM-to-OPS.md",
        sender: "PM",
        recipient: "OPS",
        bucket: "archive",
        state: "archive",
        path: "fcop/_lifecycle/archive/TASK-20260609-005-PM-to-OPS.md",
      }),
      JSON.stringify({
        task_id: normalTaskId,
        filename: "TASK-20260609-001-ADMIN-to-PM.md",
        sender: "ADMIN",
        recipient: "PM",
        bucket: "inbox",
        state: "inbox",
        path: "fcop/_lifecycle/inbox/TASK-20260609-001-ADMIN-to-PM.md",
      }),
    ].join("\n"),
    "utf-8",
  );

  writeFileSync(
    join(root, "fcop", "_lifecycle", "inbox", "TASK-20260609-001-ADMIN-to-PM.md"),
    "---\nprotocol: fcop\nversion: 1\nkind: task\nsender: ADMIN\nrecipient: PM\ntask_id: TASK-20260609-001-ADMIN-to-PM\n---\n",
    "utf-8",
  );

  writeFileSync(
    join(layout.ledgerDir, "diagnostics.jsonl"),
    JSON.stringify({
      id: orphanDiagId,
      task_id: orphanTaskId,
      type: "ledger_orphan",
      severity: "P0",
      title: "Ledger orphan",
      message: "Task row exists in ledger but file is missing on disk",
      ledger_path: "fcop/_lifecycle/archive/TASK-20260609-005-PM-to-OPS.md",
      bucket_from_ledger: "archive",
      source: "reconcile",
      detected_at: "2026-06-09T12:00:00.000Z",
    }),
    "utf-8",
  );

  writeFileSync(
    join(layout.ledgerDir, "threads.jsonl"),
    JSON.stringify({
      thread_key: "diag-test",
      task_ids: [orphanTaskId, normalTaskId],
      pending_pm_review: [],
    }),
    "utf-8",
  );

  writeFileSync(join(layout.ledgerDir, "reports.jsonl"), "", "utf-8");

  return root;
}

function appendFileWithoutLedgerDiagnostic(
  root: string,
  taskId = "TASK-20260611-099-PM-to-DEV",
): string {
  const layout = resolveLedgerLayout(root);
  const id = `file_without_ledger:${taskId}`;
  const existing = readFileSync(join(layout.ledgerDir, "diagnostics.jsonl"), "utf-8").trim();
  const row = JSON.stringify({
    id,
    task_id: taskId,
    type: "file_without_ledger",
    severity: "P1",
    title: "Missing ledger row",
    message: "TASK file on disk has no tasks.jsonl row",
    detected_at: "2026-06-11T12:00:00.000Z",
  });
  writeFileSync(
    join(layout.ledgerDir, "diagnostics.jsonl"),
    (existing ? `${existing}\n` : "") + `${row}\n`,
    "utf-8",
  );
  return id;
}

function removeDiagnosticById(root: string, diagnosticId: string): void {
  const layout = resolveLedgerLayout(root);
  const path = join(layout.ledgerDir, "diagnostics.jsonl");
  const kept = readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      try {
        return String(JSON.parse(trimmed).id ?? "") !== diagnosticId;
      } catch {
        return true;
      }
    });
  writeFileSync(path, kept.length ? `${kept.join("\n")}\n` : "", "utf-8");
}

function buildApp(root: string) {
  wpResetProjectStoreForTests(root);
  resetLedgerFreshGateForTests();
  const inbox = join(root, "fcop", "_lifecycle", "inbox");
  return buildWebPanelApp(buildRuntimeMock(inbox), { projectRoot: root });
}

afterEach(() => {
  stopAutoRecoveryBridge();
  resetLedgerFreshGateForTests();
  while (tempRoots.length) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

test("GET /api/v2/diagnostics lists ledger_orphan with summary counts", async () => {
  const root = makeDiagnosticsProject();
  tempRoots.push(root);
  const app = buildApp(root);

  const res = await request(app).get("/api/v2/diagnostics").expect(200);
  assert.equal(res.body.summary.diagnostics_count, 1);
  assert.equal(res.body.summary.ledger_orphan_count, 1);
  assert.equal(res.body.diagnostics.length, 1);
  assert.equal(res.body.diagnostics[0].type, "ledger_orphan");
  assert.match(res.body.diagnostics[0].task_id, /TASK-20260609-005/);
  assert.ok(res.body.diagnostics[0].actions.includes("clear_orphan"));
});

test("GET /api/v2/diagnostics/:id returns detail fields", async () => {
  const root = makeDiagnosticsProject();
  tempRoots.push(root);
  const app = buildApp(root);
  const id = "ledger_orphan:TASK-20260609-005-PM-to-OPS";

  const res = await request(app)
    .get(`/api/v2/diagnostics/${encodeURIComponent(id)}`)
    .expect(200);

  assert.equal(res.body.id, id);
  assert.equal(res.body.type, "ledger_orphan");
  assert.equal(res.body.ledgerPath, "fcop/_lifecycle/archive/TASK-20260609-005-PM-to-OPS.md");
  assert.equal(res.body.bucketFromLedger, "archive");
  assert.ok(res.body.createdAt);
});

test("GET /api/v2/tasks?source=ledger excludes ledger_orphan rows", async () => {
  const root = makeDiagnosticsProject();
  tempRoots.push(root);
  const app = buildApp(root);

  const res = await request(app)
    .get("/api/v2/tasks")
    .query({ source: "ledger", limit: 50 })
    .expect(200);

  const ids = (res.body.tasks as { task_id?: string }[]).map((t) => t.task_id);
  assert.ok(!ids.some((id) => id?.includes("TASK-20260609-005")));
  assert.ok(ids.some((id) => id?.includes("TASK-20260609-001")));
});

test("GET /api/v2/tasks/stats returns diagnostics_count separately", async () => {
  const root = makeDiagnosticsProject();
  tempRoots.push(root);
  const app = buildApp(root);

  const res = await request(app).get("/api/v2/tasks/stats").expect(200);
  assert.equal(res.body.inbox, 1);
  assert.equal(res.body.diagnostics_count, 1);
  assert.equal(typeof res.body.active, "number");
  assert.equal(typeof res.body.diagnostics_count, "number");
  assert.ok(Object.hasOwn(res.body, "diagnostics_count"));
});

test("POST /api/v2/diagnostics/rescan refreshes tasks.jsonl and diagnostics.jsonl", async () => {
  const root = makeDiagnosticsProject();
  tempRoots.push(root);
  const layout = resolveLedgerLayout(root);
  const app = buildApp(root);

  const res = await request(app).post("/api/v2/diagnostics/rescan").expect(200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.summary.ledger_orphan_count, 1);

  const tasksRaw = readFileSync(join(layout.ledgerDir, "tasks.jsonl"), "utf-8");
  assert.ok(!tasksRaw.includes("TASK-20260609-005"));
  assert.ok(tasksRaw.includes("TASK-20260609-001"));

  const diagRaw = readFileSync(join(layout.ledgerDir, "diagnostics.jsonl"), "utf-8");
  assert.ok(diagRaw.includes("ledger_orphan"));
  assert.ok(diagRaw.includes("TASK-20260609-005"));
});

test("POST clear-orphan hides diagnostic but keeps resolution record", async () => {
  const root = makeDiagnosticsProject();
  tempRoots.push(root);
  const layout = resolveLedgerLayout(root);
  const app = buildApp(root);
  const id = "ledger_orphan:TASK-20260609-005-PM-to-OPS";

  const clearRes = await request(app)
    .post(`/api/v2/diagnostics/${encodeURIComponent(id)}/clear-orphan`)
    .expect(200);

  assert.equal(clearRes.body.ok, true);
  assert.equal(clearRes.body.diagnostic_id, id);
  assert.equal(clearRes.body.resolution.action, "clear_orphan");

  const listRes = await request(app).get("/api/v2/diagnostics").expect(200);
  assert.equal(listRes.body.summary.diagnostics_count, 0);

  const resolutions = readFileSync(
    join(layout.ledgerDir, "diagnostic_resolutions.jsonl"),
    "utf-8",
  );
  assert.ok(resolutions.includes(id));
  assert.ok(resolutions.includes("clear_orphan"));

  const tasksRaw = readFileSync(join(layout.ledgerDir, "tasks.jsonl"), "utf-8");
  assert.ok(tasksRaw.includes("TASK-20260609-001"));
  // clear-orphan only appends resolution — does not rewrite tasks.jsonl
  assert.ok(tasksRaw.includes("TASK-20260609-005"));
});

test("POST clear-orphan rejects non-ledger_orphan", async () => {
  const root = makeDiagnosticsProject();
  tempRoots.push(root);
  const layout = resolveLedgerLayout(root);
  writeFileSync(
    join(layout.ledgerDir, "diagnostics.jsonl"),
    JSON.stringify({
      id: "path_mismatch:TASK-20260609-010",
      task_id: "TASK-20260609-010-ADMIN-to-PM",
      type: "path_mismatch",
      severity: "P1",
      title: "Path mismatch",
      message: "paths differ",
      detected_at: "2026-06-09T12:00:00.000Z",
    }),
    "utf-8",
  );
  const app = buildApp(root);

  await request(app)
    .post("/api/v2/diagnostics/path_mismatch%3ATASK-20260609-010/clear-orphan")
    .expect(400);
});

test("GET /api/v2/diagnostics hides auto-healed bucket_mismatch from list and detail", async () => {
  const root = makeDiagnosticsProject();
  tempRoots.push(root);
  const layout = resolveLedgerLayout(root);
  const autoId = "bucket_mismatch:TASK-20260609-011-PM-to-OPS";
  writeFileSync(
    join(layout.ledgerDir, "diagnostics.jsonl"),
    [
      readFileSync(join(layout.ledgerDir, "diagnostics.jsonl"), "utf-8").trim(),
      JSON.stringify({
        id: autoId,
        task_id: "TASK-20260609-011-PM-to-OPS",
        type: "bucket_mismatch",
        severity: "info",
        auto_healed: true,
        visible: false,
        title: "Bucket mismatch (auto-healed)",
        message: "stale ledger",
        detected_at: "2026-06-09T12:00:00.000Z",
      }),
    ].join("\n") + "\n",
    "utf-8",
  );
  const app = buildApp(root);

  const listRes = await request(app).get("/api/v2/diagnostics").expect(200);
  assert.equal(listRes.body.summary.diagnostics_count, 1);
  assert.ok(!listRes.body.diagnostics.some((d: { id: string }) => d.id === autoId));

  await request(app)
    .get(`/api/v2/diagnostics/${encodeURIComponent(autoId)}`)
    .expect(404);
});

test("getDiagnosticsListResponseConfirmed skips rebuild when no file_without_ledger", async () => {
  const root = makeDiagnosticsProject();
  tempRoots.push(root);
  let slept = false;
  let rebuilt = false;
  const opts: DiagnosticsListConfirmOptions = {
    sleep: async () => {
      slept = true;
    },
    ensureLedgerFresh: async () => {
      rebuilt = true;
      return true;
    },
    invalidateLedgerFreshCache: () => {},
  };

  const res = await getDiagnosticsListResponseConfirmed(root, opts);
  assert.equal(res.summary.ledger_orphan_count, 1);
  assert.equal(res.summary.file_without_ledger_count, 0);
  assert.equal(slept, false);
  assert.equal(rebuilt, false);
});

test("getDiagnosticsListResponseConfirmed immediately rescans and drops transient file_without_ledger", async () => {
  const root = makeDiagnosticsProject();
  tempRoots.push(root);
  const fwolId = appendFileWithoutLedgerDiagnostic(root);
  let rebuildCalls = 0;
  let slept = false;
  const opts: DiagnosticsListConfirmOptions = {
    sleep: async () => {
      slept = true;
    },
    randomDelayMs: () => 3000,
    invalidateLedgerFreshCache: () => {},
    ensureLedgerFresh: async () => {
      rebuildCalls++;
      removeDiagnosticById(root, fwolId);
      return true;
    },
  };

  const res = await getDiagnosticsListResponseConfirmed(root, opts);
  assert.equal(rebuildCalls, 1);
  assert.equal(slept, false);
  assert.equal(res.summary.file_without_ledger_count, 0);
  assert.equal(res.summary.ledger_orphan_count, 1);
  assert.ok(!res.diagnostics.some((d) => d.id === fwolId));
});

test("getDiagnosticsListResponseConfirmed keeps file_without_ledger when still present after rescan", async () => {
  const root = makeDiagnosticsProject();
  tempRoots.push(root);
  const fwolId = appendFileWithoutLedgerDiagnostic(root);
  let slept = false;
  const opts: DiagnosticsListConfirmOptions = {
    sleep: async () => {
      slept = true;
    },
    randomDelayMs: () => 4500,
    invalidateLedgerFreshCache: () => {},
    ensureLedgerFresh: async () => true,
  };

  const res = await getDiagnosticsListResponseConfirmed(root, opts);
  assert.equal(slept, false);
  assert.equal(res.summary.file_without_ledger_count, 1);
  assert.ok(res.diagnostics.some((d) => d.id === fwolId));
});

test("getDiagnosticsListResponseConfirmed returns first scan when rebuild throws", async () => {
  const root = makeDiagnosticsProject();
  tempRoots.push(root);
  const fwolId = appendFileWithoutLedgerDiagnostic(root);
  const opts: DiagnosticsListConfirmOptions = {
    sleep: async () => {},
    randomDelayMs: () => 6000,
    invalidateLedgerFreshCache: () => {},
    ensureLedgerFresh: async () => {
      throw new Error("REBUILD_FAILED");
    },
  };

  const res = await getDiagnosticsListResponseConfirmed(root, opts);
  assert.equal(res.summary.file_without_ledger_count, 1);
  assert.ok(res.diagnostics.some((d) => d.id === fwolId));
});

test("GET /api/v2/diagnostics returns ledger_orphan immediately without file_without_ledger delay", async () => {
  const root = makeDiagnosticsProject();
  tempRoots.push(root);
  const app = buildApp(root);
  const t0 = Date.now();

  const res = await request(app).get("/api/v2/diagnostics").expect(200);
  const elapsed = Date.now() - t0;

  assert.equal(res.body.summary.ledger_orphan_count, 1);
  assert.equal(res.body.summary.file_without_ledger_count, 0);
  assert.ok(elapsed < 2000, `expected immediate response, got ${elapsed}ms`);
});
