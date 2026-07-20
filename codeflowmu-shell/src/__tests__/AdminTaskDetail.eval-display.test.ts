/**
 * ADMIN 任务详情：PM final + EVAL observation 同屏（API + panel 标记）。
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import request from "supertest";
import type { Express } from "express";

import { buildWebPanelApp, wpResetProjectStoreForTests } from "../web-panel.ts";
import { PmQueueGuard, type Runtime } from "@codeflowmu/runtime";
import { withTempLifecycle } from "../../../packages/codeflowmu-runtime/src/lifecycle/__tests__/helpers.ts";
import { LedgerBuilder } from "@codeflowmu/runtime";
import {
  EVAL_ROOT,
  EVAL_THREAD,
  seedEvalCloseoutThread,
} from "../../../packages/codeflowmu-runtime/src/eval/__tests__/evalThreadFixture.ts";
import {
  TASK220_MANUAL,
  TASK220_ROOT,
  seedTask220CanonicalReports,
} from "../../../packages/codeflowmu-runtime/src/eval/__tests__/task220CanonicalFixture.ts";
import { writeTaskAt } from "../../../packages/codeflowmu-runtime/src/lifecycle/__tests__/helpers.ts";

const EVAL_DEV = "TASK-20260610-106-PM-to-DEV";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_HTML = join(__dirname, "../../..", "codeflowmu-desktop", "panel", "index.html");

function buildMinimalRuntime(inboxDir: string): Runtime {
  return {
    registry: { list: async () => [] },
    watcher: { dir: inboxDir },
    reviewWriter: {
      reviewsDir: join(tmpdir(), "cf-eval-display-reviews-" + Date.now()),
    },
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

function buildPanelForRoot(root: string): Express {
  const inbox = join(root, "fcop", "_lifecycle", "inbox");
  mkdirSync(inbox, { recursive: true });
  const reviewsDir = join(root, "fcop", "reviews");
  mkdirSync(reviewsDir, { recursive: true });
  return buildWebPanelApp(buildMinimalRuntime(inbox), {
    projectRoot: root,
    fcopReviewsDir: reviewsDir,
    fcopReportsDir: join(root, "fcop", "reports"),
  });
}

function writePendingReview(
  reviewsDir: string,
  filename: string,
  fields: Record<string, string>,
): void {
  const lines = ["---", ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), "---", "", "# Review", ""];
  writeFileSync(join(reviewsDir, filename), lines.join("\n"), "utf-8");
}

test("7 — GET /api/v2/admin/task-closeout 返回 PM final + EVAL", async () => {
  await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
    await seedEvalCloseoutThread(rootDir, lifecycleRoot);
    wpResetProjectStoreForTests(rootDir);
    const app = buildPanelForRoot(rootDir);

    const res = await request(app)
      .get("/api/v2/admin/task-closeout")
      .query({ task_id: "TASK-20260610-101" });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    const closeout = res.body.closeout;
    assert.ok(closeout.pm_final_report);
    assert.ok(closeout.eval_observation);
    assert.equal(closeout.eval_observation.internal_only, true);
    assert.equal(closeout.eval_observation.bypass_observation, true);
    assert.equal(closeout.eval_observation.drives_lifecycle, false);
    assert.equal(closeout.root_task_id, "TASK-20260610-101");

    const cleanup = (app as unknown as { _sseCleanup?: () => void })._sseCleanup;
    cleanup?.();
  });
});

test("panel workflow timeline orders the main task by creation time", () => {
  const html = readFileSync(PANEL_HTML, "utf-8");
  const fnStart = html.indexOf("function rpWfTaskCreatedMs(");
  assert.ok(fnStart >= 0, "rpWfTaskCreatedMs missing");
  const fnEnd = html.indexOf("\nfunction rpWfAnyMs(", fnStart);
  assert.ok(fnEnd > fnStart, "rpWfTaskCreatedMs boundary missing");
  const source = html.slice(fnStart, fnEnd);
  const getTaskCreatedMs = new Function(
    "envelopeTimestampMs",
    `${source}; return rpWfTaskCreatedMs;`,
  )(() => 0) as (task: Record<string, unknown>) => number;

  const mainMs = getTaskCreatedMs({
    flow_created_at: "2026-06-12T13:42:06+08:00",
    flow_started_at: "2026-06-12T13:43:33+08:00",
  });
  const childMs = getTaskCreatedMs({
    flow_created_at: "2026-06-12T13:42:45+08:00",
    flow_started_at: "2026-06-12T13:43:16+08:00",
    transitions: [
      {
        at: "2026-06-12T05:42:45.644150+00:00",
        from: null,
        to: "inbox",
        tool: "create_task",
      },
    ],
  });

  assert.ok(mainMs < childMs, "main task creation must precede child task creation");
});

test("8b — TASK-220 closeout 选用 manual 111 而非 auto 004", async () => {
  await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
    await seedTask220CanonicalReports(rootDir, lifecycleRoot);
    wpResetProjectStoreForTests(rootDir);
    const app = buildPanelForRoot(rootDir);

    const res = await request(app)
      .get("/api/v2/admin/task-closeout")
      .query({ task_id: TASK220_ROOT });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(
      res.body.closeout.pm_final_report.report_id,
      "REPORT-20260610-111-PM-to-ADMIN",
    );
    assert.equal(res.body.closeout.pm_final_report.filename, TASK220_MANUAL);

    const cleanup = (app as unknown as { _sseCleanup?: () => void })._sseCleanup;
    cleanup?.();
  });
});

test("8 — GET closeout 在无 EVAL 时自动补写", async () => {
  await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
    await seedEvalCloseoutThread(rootDir, lifecycleRoot, {
      skipObservation: true,
    });
    wpResetProjectStoreForTests(rootDir);
    const app = buildPanelForRoot(rootDir);

    const res = await request(app)
      .get("/api/v2/admin/task-closeout")
      .query({ task_id: "TASK-20260610-101" });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.closeout.pm_final_report);
    assert.ok(res.body.closeout.eval_observation);
    assert.equal(
      res.body.closeout.eval_observation.source_report,
      "REPORT-20260610-004-PM-to-ADMIN",
    );

    const cleanup = (app as unknown as { _sseCleanup?: () => void })._sseCleanup;
    cleanup?.();
  });
});

test("9 — POST generate-eval 可手动补写 EVAL", async () => {
  await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
    await seedEvalCloseoutThread(rootDir, lifecycleRoot, {
      skipObservation: true,
    });
    wpResetProjectStoreForTests(rootDir);
    const app = buildPanelForRoot(rootDir);

    const res = await request(app)
      .post("/api/v2/admin/task-closeout/generate-eval")
      .send({ task_id: "TASK-20260610-101" });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.result.generated, true);
    assert.ok(res.body.closeout.eval_observation);
    assert.equal(res.body.admin_closeout_hint.phase, "ready_for_admin_review");

    const cleanup = (app as unknown as { _sseCleanup?: () => void })._sseCleanup;
    cleanup?.();
  });
});

test("10 — ordinary needs_human REVIEW is excluded from operation approvals", async () => {
  await withTempLifecycle(async ({ rootDir }) => {
    wpResetProjectStoreForTests(rootDir);
    const app = buildPanelForRoot(rootDir);
    const reviewsDir = join(rootDir, "fcop", "reviews");
    writePendingReview(reviewsDir, "REVIEW-20260610-010.md", {
      protocol: "fcop",
      version: "1",
      decision: "needs_human",
      task_id: "TASK-20260610-100-ADMIN-to-PM",
      thread_key: EVAL_THREAD,
      reviewer: "SYSTEM",
    });
    writePendingReview(reviewsDir, "REVIEW-20260610-011.md", {
      protocol: "fcop",
      version: "1",
      decision: "needs_human",
      task_id: EVAL_ROOT,
      thread_key: EVAL_THREAD,
      reviewer: "SYSTEM",
    });

    const res = await request(app)
      .get("/api/v2/approvals")
      .query({ task_id: "TASK-20260610-101", thread_key: EVAL_THREAD });

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body.length, 0);

    const preservedReview = readFileSync(join(reviewsDir, "REVIEW-20260610-011.md"), "utf-8");
    assert.match(preservedReview, /decision:\s*needs_human/);

    const cleanup = (app as unknown as { _sseCleanup?: () => void })._sseCleanup;
    cleanup?.();
  });
});

test("12 — PM→DEV 子任务 approve 不因主线缺失 EVAL 被拦截", async () => {
  await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
    await seedEvalCloseoutThread(rootDir, lifecycleRoot, {
      skipObservation: true,
    });
    await writeTaskAt(lifecycleRoot, "review", `${EVAL_DEV}.md`, {
      protocol: "fcop",
      version: 1,
      kind: "task",
      sender: "PM",
      recipient: "DEV",
      task_id: EVAL_DEV,
      parent: EVAL_ROOT,
      thread_key: EVAL_THREAD,
    }, "# DEV sub-task in review\n");
    const builder = new LedgerBuilder({ projectRoot: rootDir });
    await builder.rebuild();
    wpResetProjectStoreForTests(rootDir);
    const app = buildPanelForRoot(rootDir);

    const res = await request(app)
      .post(`/api/v2/tasks/${EVAL_DEV}/approve`)
      .send({ actor: "PM" });

    assert.notEqual(res.body?.code, "EVAL_REQUIRED_BEFORE_APPROVAL");
    assert.notEqual(res.body?.code, "EVAL_REQUIRED_BEFORE_REJECT");

    const cleanup = (app as unknown as { _sseCleanup?: () => void })._sseCleanup;
    cleanup?.();
  });
});

test("13 — ADMIN→PM 主线 approve 在缺失 EVAL 时仍被拦截", async () => {
  await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
    await seedEvalCloseoutThread(rootDir, lifecycleRoot, {
      skipObservation: true,
    });
    await writeTaskAt(lifecycleRoot, "review", `${EVAL_ROOT}.md`, {
      protocol: "fcop",
      version: 1,
      kind: "task",
      sender: "ADMIN",
      recipient: "PM",
      task_id: EVAL_ROOT,
      thread_key: EVAL_THREAD,
    }, "# ADMIN root in review\n");
    const builder = new LedgerBuilder({ projectRoot: rootDir });
    await builder.rebuild();
    wpResetProjectStoreForTests(rootDir);
    const app = buildPanelForRoot(rootDir);

    const res = await request(app)
      .post(`/api/v2/tasks/${EVAL_ROOT}/approve`)
      .send({ actor: "ADMIN" });

    assert.equal(res.status, 403);
    assert.equal(res.body?.code, "EVAL_REQUIRED_BEFORE_APPROVAL");

    const cleanup = (app as unknown as { _sseCleanup?: () => void })._sseCleanup;
    cleanup?.();
  });
});

test("11 — POST generate-eval force_regenerate 可刷新已有 EVAL", async () => {
  await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
    await seedEvalCloseoutThread(rootDir, lifecycleRoot);
    wpResetProjectStoreForTests(rootDir);
    const app = buildPanelForRoot(rootDir);

    const first = await request(app)
      .get("/api/v2/admin/task-closeout")
      .query({ task_id: "TASK-20260610-101" });
    assert.equal(first.status, 200);
    const obs1 = first.body.closeout.eval_observation?.observation_id;

    const regen = await request(app)
      .post("/api/v2/admin/task-closeout/generate-eval")
      .send({ task_id: "TASK-20260610-101", force_regenerate: true });

    assert.equal(regen.status, 200);
    assert.equal(regen.body.ok, true);
    assert.equal(regen.body.result.regenerated ?? regen.body.result.generated, true);

    const cleanup = (app as unknown as { _sseCleanup?: () => void })._sseCleanup;
    cleanup?.();
  });
});

test("panel index.html 含 ADMIN 关单旁路 UI 挂钩", () => {
  const html = readFileSync(PANEL_HTML, "utf-8");
  assert.match(html, /id="tdp-admin-closeout"/);
  assert.match(html, /function renderAdminTaskCloseout/);
  assert.match(html, /\/api\/v2\/admin\/task-closeout/);
  assert.match(html, /\/api\/v2\/admin\/task-closeout\/generate-eval/);
  assert.match(html, /function tdpGenerateAdminEval/);
  assert.match(html, /id="tdp-eval-watch-btn"/);
  assert.match(html, /function tdpOpenEvalObservation/);
  assert.match(html, /id="tdp-eval-observation-dialog"/);
  assert.match(html, /function _adminCloseoutHintKeys/);
  assert.match(html, /tdp\.ac\.generateEval/);
  assert.match(html, /tdp\.ac\.internalOnly/);
  assert.match(html, /旁路观察|Bypass observation/);
  assert.match(html, /不驱动 lifecycle|Does not drive lifecycle/);
  assert.match(html, /renderAdminTaskCloseout\(f\)/);
  assert.match(html, /renderAdminTaskCloseout\(_tdpFile\)/);
  assert.match(html, /loadTaskScopedApprovals/);
  assert.match(html, /approvalMatchesTask/);
  assert.match(html, /force_regenerate/);
  assert.match(html, /tdp\.ac\.refreshEval/);
});

test("panel index.html 含 Diagnostics 最小 UI 挂钩", () => {
  const html = readFileSync(PANEL_HTML, "utf-8");
  assert.match(html, /id="dash-diagnostics-card"/);
  assert.match(html, /id="ts-diagnostics"/);
  assert.match(html, /function applyDiagnosticsPayload/);
  assert.match(html, /function renderDiagnosticsPanel/);
  assert.match(html, /function renderDiagnosticsDashboardCard/);
  assert.match(html, /function rescanDiagnostics/);
  assert.match(html, /function clearOrphanDiagnostic/);
  assert.match(html, /function navToDiagnostics/);
  assert.match(html, /\/api\/v2\/diagnostics/);
  assert.match(html, /\/api\/v2\/diagnostics\/rescan/);
  assert.match(html, /clear-orphan/);
  assert.match(html, /diag\.type\.ledger_orphan/);
  assert.match(html, /diag\.clearOrphan/);
  assert.match(html, /file_without_ledger/);
  assert.match(html, /ts\.ledgerMissing/);
});

test("panel index.html 含主任务文件名搜索框（TASK-20260611-003）", () => {
  const html = readFileSync(PANEL_HTML, "utf-8");
  assert.match(html, /id="tp-search"/);
  assert.match(html, /id="rp-search"/);
  assert.match(html, /function onTpMainSearch/);
  assert.match(html, /function onRpSearch/);
  assert.match(html, /function adminThreadModelMatchesSearch/);
  assert.match(html, /function formatMainlineCountDisplay/);
  assert.match(html, /tp\.searchPh/);
  assert.match(html, /rp\.searchPh/);
});

test("panel index.html 报告页过滤顺序（TASK-20260611-009）", () => {
  const html = readFileSync(PANEL_HTML, "utf-8");
  const block = html.slice(
    html.indexOf("function renderReportPage("),
    html.indexOf("function renderReportPage(") + 2200,
  );
  assert.match(block, /reportArchiveTab==='active'/);
  assert.match(block, /rpShouldHideFromActiveReportBoard/);
  assert.doesNotMatch(block, /if\(!reportSearchQ\)\{\s*items=items\.filter\(r=>!rpShouldHideFromActiveReportBoard/);
  assert.match(block, /applyReportUnifiedSearch\(items,reportSearchQ\)/);
});

test("panel index.html 报告页单一搜索框（TASK-20260611-008）", () => {
  const html = readFileSync(PANEL_HTML, "utf-8");
  assert.doesNotMatch(html, /id="rp-main-task-search"/);
  assert.doesNotMatch(html, /id="rp-main-cnt"/);
  assert.match(html, /id="rp-search-cnt"/);
  assert.match(html, /function applyReportUnifiedSearch/);
  assert.match(html, /function reportUnifiedSearchHaystack/);
  const sync = html.slice(
    html.indexOf("function syncReportThreadSelect("),
    html.indexOf("function syncReportThreadSelect(") + 500,
  );
  assert.match(sync, /threadModelsScopedForReportTab\(\)/);
  assert.match(sync, /normalizeMainTaskSearchQ\(reportSearchQ\)/);
});

test("panel index.html 主任务搜索覆盖全池（TASK-20260611-007）", () => {
  const html = readFileSync(PANEL_HTML, "utf-8");
  assert.match(html, /function mainTaskPoolItemSearchHaystack/);
  assert.match(html, /function syncTaskSearchSectionLayout/);
  assert.match(html, /tp-search-active/);
  assert.doesNotMatch(html, /return threads\.slice\(0,10\)/);
  const adminSectionStart = html.indexOf("function _renderAdminSection(");
  assert.ok(adminSectionStart >= 0);
  const adminSection = html.slice(adminSectionStart, adminSectionStart + 1200);
  assert.match(adminSection, /formatMainlineCountDisplay\(adminMainCount,poolBase\.length/);
});

test("panel index.html rpBuildThreadChainNodes 定义 rootTask 避免 Report 页渲染 ReferenceError", () => {
  const html = readFileSync(PANEL_HTML, "utf-8");
  const fnStart = html.indexOf("function rpBuildThreadChainNodes(");
  assert.ok(fnStart >= 0, "rpBuildThreadChainNodes missing");
  const fnBody = html.slice(fnStart, fnStart + 4000);
  assert.match(fnBody, /const rootTask=byId\[rootId\]\|\|null;/);
});

test("panel index.html EVAL 草稿两阶段晋升 UI 挂钩（Issue + 本地任务）", () => {
  const html = readFileSync(PANEL_HTML, "utf-8");
  assert.match(html, /id="eval-promo-draft-actions"/);
  assert.match(html, /id="eval-promo-view-draft"/);
  assert.match(html, /id="eval-promo-delete-draft"/);
  assert.match(html, /id="eval-promo-admin-check"/);
  assert.match(html, /id="eval-promo-submit-github"/);
  assert.match(html, /id="eval-promo-view-dialog"/);
  assert.match(html, /function syncEvalPromoDraftActions/);
  assert.match(html, /function openEvalPromoViewDraft/);
  assert.match(html, /function submitEvalPromoDraftAction/);
  assert.match(html, /function deleteEvalPromoDraftAction/);
  assert.match(html, /function evalPromotionIsLocalTaskDraft/);
  assert.match(html, /\/api\/v2\/eval\/submit\/issue-draft/);
  assert.match(html, /\/api\/v2\/eval\/submit\/task-draft/);
  assert.match(html, /\/api\/v2\/eval\/delete\/draft/);
  assert.match(html, /eval\.promo\.btnTask.*生成本地任务草稿|生成本地任务草稿/);
  assert.match(html, /eval\.promo\.btnDeleteDraft/);
  assert.match(html, /eval\.promo\.btnSubmitTask/);
  assert.match(html, /eval\.promo\.adminCheckLabel/);
});
