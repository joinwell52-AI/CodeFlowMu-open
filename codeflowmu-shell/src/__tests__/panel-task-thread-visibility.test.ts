import { test } from "node:test";
import assert from "node:assert/strict";
import {
  absorbOrphanLedgerRows,
  buildThreadMembersFromLedger,
  classifyTask,
  countAdminMainlinesForThreadMembers,
  countAdminMainlinesInPool,
  countAdminMainlinesInReportChain,
  countAdminMainlinesInReportTaskTree,
  countBranchTasksInPool,
  collectPmTeamDispatchTasksForThread,
  collectPmTeamDispatchTasksForVisibleThreads,
  countVisibleTaskBreakdown,
  filterTaskPageVisiblePool,
  isSmokeArtifactTask,
  isStrictSmokeTask,
  mergeLedgerRowsByRoot,
  resolveAdminRootIdForTask,
  isDetachedLedgerThread,
  inferAdminRootIdFromTaskText,
  shouldHideStalePmBranchOnActiveTab,
  shouldShowReportThreadInActive,
  shouldShowReportThreadInArchive,
  countReportThreadTasksForDisplay,
  filterReportThreadTaskTreeForTab,
  taskIdsMatchingRootArchiveTab,
  threadEligibleForPageFilter,
  taskIsArchiveTabSettled,
  taskIsWorkflowSealed,
  reportRootMatchesArchiveTab,
  reportLegacyGroupMatchesArchiveTab,
  detectClosedParentResidueTasks,
  shouldExcludeClosedParentResidueFromActiveLists,
  expandThreadMembersByParent,
  filterPoolByMainTaskSearch,
  formatMainlineCountDisplay,
  mainTaskPoolItemSearchHaystack,
  applyReportUnifiedSearch,
  filterReportPageVisibleItems,
  reportUnifiedSearchHaystack,
} from "../panel-task-thread-visibility.ts";

const task005 = {
  filename: "TASK-20260604-005-ADMIN-to-PM.md",
  path: "fcop/_lifecycle/done/TASK-20260604-005-ADMIN-to-PM.md",
  physical_scope: "done",
};

const task006 = {
  filename: "TASK-20260604-006-PM-to-DEV.md",
  path: "fcop/_lifecycle/archive/TASK-20260604-006-PM-to-DEV.md",
  physical_scope: "archive",
  parent: "TASK-20260604-005",
};

const ledgerRows = [
  {
    thread_key: "panel-task-005",
    task_ids: ["TASK-20260604-005"],
    root_task_id: "TASK-20260604-005",
  },
  {
    thread_key: "_orphan_TASK-20260604-006",
    task_ids: ["TASK-20260604-006"],
  },
];

test("absorbOrphanLedgerRows merges 006 into panel-task-005 thread", () => {
  const merged = absorbOrphanLedgerRows(
    mergeLedgerRowsByRoot(ledgerRows),
    ledgerRows,
    [task005, task006],
  );
  const row = merged.find((r) => r.root_task_id === "TASK-20260604-005");
  assert.ok(row);
  assert.ok(row!.task_ids!.includes("TASK-20260604-006"));
});

test("active tab: 005 done + 006 archive both visible (root-driven chain)", () => {
  const all = [task005, task006];
  const { visibleIds } = taskIdsMatchingRootArchiveTab(all, ledgerRows, "active");
  assert.ok(visibleIds.has("TASK-20260604-005"));
  assert.ok(visibleIds.has("TASK-20260604-006"));
});

test("archive tab: hidden while root is in done/", () => {
  const all = [task005, task006];
  const { visibleIds } = taskIdsMatchingRootArchiveTab(all, ledgerRows, "archive");
  assert.equal(visibleIds.has("TASK-20260604-005"), false);
  assert.equal(visibleIds.has("TASK-20260604-006"), false);
});

test("filterTaskPageVisiblePool PM branch follows root on active tab", () => {
  const pool = filterTaskPageVisiblePool(
    [task005, task006],
    [task005, task006],
    ledgerRows,
    "active",
  );
  assert.equal(pool.length, 2);
});

test("006 alone not visible on active when root not in pool", () => {
  const pool = filterTaskPageVisiblePool([task006], [task006], ledgerRows, "active");
  assert.equal(pool.length, 0);
});

test("countAdminMainlinesInPool excludes PM child tasks", () => {
  const pool = filterTaskPageVisiblePool(
    [task005, task006],
    [task005, task006],
    ledgerRows,
    "active",
  );
  assert.equal(pool.length, 2);
  assert.equal(countAdminMainlinesInPool(pool), 1);
});

test("countAdminMainlinesForThreadMembers returns 1 per thread", () => {
  assert.equal(
    countAdminMainlinesForThreadMembers([task005, task006]),
    1,
  );
});

test("countAdminMainlinesInReportTaskTree counts only ADMIN mainline nodes", () => {
  const tree = [
    { task: task005 },
    { task: task006 },
  ];
  assert.equal(countAdminMainlinesInReportTaskTree(tree), 1);
});

const task020 = {
  filename: "TASK-20260604-020-ADMIN-to-PM.md",
  path: "fcop/_lifecycle/active/TASK-20260604-020-ADMIN-to-PM.md",
};

const task021a = {
  filename: "TASK-20260604-021-PM-to-DEV.md",
  parent: "TASK-20260604-020",
};

const task021b = {
  filename: "TASK-20260604-022-PM-to-DEV.md",
  parent: "TASK-20260604-020",
};

const taskSmoke = {
  filename: "TASK-20260604-019-ADMIN-to-PM.md",
  subject: "topology fix smoke verify",
};

const task018 = {
  filename: "TASK-20260604-018-ADMIN-to-PM.md",
  subject: "topology fix smoke",
};

const task024 = {
  filename: "TASK-20260604-024-ADMIN-to-PM.md",
  subject: "Panel 统计口径治理",
  preview: "018/019 smoke 不再污染主任务大数字",
};

test("1 mainline + 2 PM→DEV → main=1 branch=2", () => {
  const pool = [task020, task021a, task021b];
  assert.equal(countAdminMainlinesInPool(pool), 1);
  assert.equal(countBranchTasksInPool(pool), 2);
  const bd = countVisibleTaskBreakdown(pool);
  assert.equal(bd.mainline, 1);
  assert.equal(bd.branch, 2);
  assert.equal(bd.smoke, 0);
});

test("Dashboard / task page / report chain share mainline=1 on same pool", () => {
  const pool = filterTaskPageVisiblePool(
    [task020, task021a, task021b],
    [task020, task021a, task021b],
    [],
    "all",
  );
  const dashBd = countVisibleTaskBreakdown(pool);
  const taskHdr = countAdminMainlinesInPool(pool);
  const reportChain = {
    taskTree: [
      { task: task020 },
      { task: task021a },
      { task: task021b },
    ],
  };
  assert.equal(dashBd.mainline, 1);
  assert.equal(taskHdr, 1);
  assert.equal(countAdminMainlinesInReportChain(reportChain), 1);
});

test("smoke artifact excluded from mainline and branch counts", () => {
  const pool = [task020, task021a, taskSmoke];
  assert.equal(isSmokeArtifactTask(taskSmoke), true);
  const bd = countVisibleTaskBreakdown(pool);
  assert.equal(bd.mainline, 1);
  assert.equal(bd.branch, 1);
  assert.equal(bd.smoke, 1);
  assert.equal(countAdminMainlinesInPool(pool), 1);
});

test("classifyTask: 018/019 → smoke, formal mainline → main, PM→DEV → subtask", () => {
  assert.equal(classifyTask(task018), "smoke");
  assert.equal(classifyTask(taskSmoke), "smoke");
  assert.equal(classifyTask(task020), "main");
  assert.equal(classifyTask(task021a), "subtask");
});

test("classifyTask: preview/body smoke keyword must not demote formal mainline 024", () => {
  assert.equal(isStrictSmokeTask(task024), false);
  assert.equal(classifyTask(task024), "main");
  assert.equal(countAdminMainlinesInPool([task024, taskSmoke]), 1);
});

const root08 = {
  filename: "TASK-20260608-005-ADMIN-to-PM.md",
  path: "fcop/_lifecycle/archive/TASK-20260608-005-ADMIN-to-PM.md",
  physical_scope: "archive",
  thread_key: "panel-task-005",
};
const branch08 = {
  filename: "TASK-20260608-003-PM-to-OPS.md",
  path: "fcop/_lifecycle/active/TASK-20260608-003-PM-to-OPS.md",
  physical_scope: "active",
  parent: "TASK-20260608-005",
  thread_key: "panel-task-005",
};
/** 生产 orphan：无 parent，preview 含 ADMIN 主线引用 */
const orphanBranch08NoParent = {
  filename: "TASK-20260608-003-PM-to-OPS.md",
  path: "fcop/_lifecycle/done/TASK-20260608-003-PM-to-OPS.md",
  physical_scope: "done",
  thread_key: "panel-task-005",
  preview: "ADMIN 主线 TASK-20260608-005 · FCoP 工作区健康巡检",
};
const root09 = {
  filename: "TASK-20260609-005-ADMIN-to-PM.md",
  path: "fcop/_lifecycle/review/TASK-20260609-005-ADMIN-to-PM.md",
  physical_scope: "review",
  thread_key: "panel-task-005",
};
const branch09 = {
  filename: "TASK-20260609-003-PM-to-OPS.md",
  path: "fcop/_lifecycle/active/TASK-20260609-003-PM-to-OPS.md",
  physical_scope: "active",
  parent: "TASK-20260609-005",
  thread_key: "panel-task-005",
};
const dualLedgerRows = [
  {
    thread_key: "panel-task-005",
    task_ids: ["TASK-20260608-005", "TASK-20260608-003"],
    root_task_id: "TASK-20260608-005",
  },
  {
    thread_key: "panel-task-005",
    task_ids: ["TASK-20260609-005", "TASK-20260609-003"],
    root_task_id: "TASK-20260609-005",
  },
];

test("resolveAdminRootIdForTask walks parent chain to ADMIN root", () => {
  const byId = new Map([
    ["TASK-20260609-005", root09],
    ["TASK-20260609-003", branch09],
  ]);
  assert.equal(resolveAdminRootIdForTask(root09, byId), "TASK-20260609-005");
  assert.equal(resolveAdminRootIdForTask(branch09, byId), "TASK-20260609-005");
});

test("buildThreadMembersFromLedger keeps PM branch under matching ADMIN root only", () => {
  const all = [root08, branch08, root09, branch09];
  const threads = buildThreadMembersFromLedger(all, [dualLedgerRows[1]!]);
  const m09 = threads[0]?.members ?? [];
  const ids = m09.map((t) => t.filename);
  assert.ok(ids.some((fn) => (fn ?? "").includes("20260609-003")));
  assert.equal(ids.some((fn) => (fn ?? "").includes("20260608-003")), false);
});

test("inferAdminRootIdFromTaskText parses ADMIN mainline from preview without parent", () => {
  assert.equal(
    inferAdminRootIdFromTaskText(orphanBranch08NoParent),
    "TASK-20260608-005",
  );
  assert.equal(
    resolveAdminRootIdForTask(
      orphanBranch08NoParent,
      new Map([["TASK-20260608-005", root08]]),
    ),
    "TASK-20260608-005",
  );
});

test("active tab: stale PM branch hidden when its ADMIN root is done", () => {
  const all = [root08, branch08, root09, branch09];
  const pool = filterTaskPageVisiblePool(all, all, dualLedgerRows, "active");
  const fns = pool.map((t) => t.filename);
  assert.ok(fns.some((fn) => (fn ?? "").includes("20260609-005")));
  assert.ok(fns.some((fn) => (fn ?? "").includes("20260609-003")));
  assert.equal(fns.some((fn) => (fn ?? "").includes("20260608-003")), false);
});

test("all tab: orphan PM branch without parent hidden via preview ADMIN root inference", () => {
  const all = [root08, orphanBranch08NoParent, root09, branch09];
  assert.equal(
    shouldHideStalePmBranchOnActiveTab(orphanBranch08NoParent, all, "all"),
    true,
  );
  const pool = filterTaskPageVisiblePool(all, all, dualLedgerRows, "all");
  const fns = pool.map((t) => t.filename);
  assert.ok(fns.some((fn) => (fn ?? "").includes("20260609-003")));
  assert.equal(fns.some((fn) => (fn ?? "").includes("20260608-003")), false);
});

test("all tab: orphan branch hidden when archived ADMIN root absent from task list", () => {
  const all = [orphanBranch08NoParent, root09, branch09];
  assert.equal(
    shouldHideStalePmBranchOnActiveTab(orphanBranch08NoParent, all, "all"),
    true,
  );
  const pool = filterTaskPageVisiblePool(all, all, dualLedgerRows, "all");
  const fns = pool.map((t) => t.filename);
  assert.ok(fns.some((fn) => (fn ?? "").includes("20260609-003")));
  assert.equal(fns.some((fn) => (fn ?? "").includes("20260608-003")), false);
});

test("references-only PM branch pointing at living ADMIN mainline is not hidden", () => {
  const refsOnlyLivingBranch = {
    filename: "TASK-20260609-004-PM-to-DEV.md",
    path: "fcop/_lifecycle/active/TASK-20260609-004-PM-to-DEV.md",
    physical_scope: "active",
    thread_key: "panel-task-005",
    references: ["TASK-20260609-005"],
  };
  const all = [root09, branch09, refsOnlyLivingBranch];
  assert.equal(
    shouldHideStalePmBranchOnActiveTab(refsOnlyLivingBranch, all, "all"),
    false,
  );
  const pool = filterTaskPageVisiblePool(all, all, dualLedgerRows, "all");
  assert.ok(pool.some((t) => t.filename === refsOnlyLivingBranch.filename));
});

test("references-only PM branch pointing at stale archived ADMIN root stays hidden", () => {
  const staleRefBranch = {
    filename: "TASK-20260608-004-PM-to-QA.md",
    thread_key: "panel-task-005",
    references: "TASK-20260608-005",
  };
  const all = [root08, staleRefBranch, root09, branch09];
  assert.equal(
    shouldHideStalePmBranchOnActiveTab(staleRefBranch, all, "all"),
    true,
  );
});

test("expandThreadMembersByParent does not treat references as tree parent", () => {
  const refsOnlyDev = {
    filename: "TASK-20260604-023-PM-to-DEV.md",
    references: "TASK-20260604-020",
  };
  const expanded = expandThreadMembersByParent(
    [task020, task021a, refsOnlyDev],
    [task020, task021a],
  );
  const ids = expanded.map((t) => t.filename);
  assert.ok(ids.includes(task021a.filename));
  assert.equal(ids.includes(refsOnlyDev.filename), false);
});

const ROOT013 = {
  filename: "TASK-20260609-013-ADMIN-to-PM.md",
  path: "fcop/_lifecycle/archive/TASK-20260609-013-ADMIN-to-PM.md",
  physical_scope: "archive",
};
const QA010 = {
  filename: "TASK-20260609-010-PM-to-QA.md",
  path: "fcop/_lifecycle/archive/TASK-20260609-010-PM-to-QA.md",
  physical_scope: "archive",
  bucket: "active",
};
const ledger013 = {
  thread_key: "panel-task-013",
  root_task_id: "TASK-20260609-013-ADMIN-to-PM",
  task_ids: ["TASK-20260609-013-ADMIN-to-PM", "TASK-20260609-010-PM-to-QA"],
  report_ids: [],
};

test("report active: ledger task_ids archive + no reports → hidden", () => {
  const ok = shouldShowReportThreadInActive(
    ledger013,
    [],
    [ROOT013, QA010],
    ROOT013,
  );
  assert.equal(ok, false);
});

test("report active: archived root hidden even with reports", () => {
  const ok = shouldShowReportThreadInActive(
    ledger013,
    [{ filename: "REPORT-x.md" }],
    [ROOT013],
    ROOT013,
  );
  assert.equal(ok, false);
});

test("report archive tab shows sealed thread", () => {
  const ok = shouldShowReportThreadInArchive(
    ledger013,
    [],
    [ROOT013],
    ROOT013,
  );
  assert.equal(ok, true);
});

test("report active task count uses open tasks only", () => {
  const tree = [{ task: ROOT013 }, { task: QA010 }];
  const filtered = filterReportThreadTaskTreeForTab(tree, "active");
  assert.equal(filtered.length, 0);
  const activeRoot = {
    ...ROOT013,
    path: "fcop/_lifecycle/active/TASK-20260609-013-ADMIN-to-PM.md",
    physical_scope: "active",
  };
  const n = countReportThreadTasksForDisplay(
    [{ task: activeRoot }, { task: QA010 }],
    "active",
  );
  assert.equal(n, 1);
});

test("threadEligibleForPageFilter includes archived ADMIN mainline for page dropdown", () => {
  const archivedRoot = {
    filename: "TASK-20260609-019-ADMIN-to-PM.md",
    path: "fcop/_lifecycle/archive/TASK-20260609-019-ADMIN-to-PM.md",
    physical_scope: "archive",
    preview: "",
  };
  assert.equal(threadEligibleForPageFilter([archivedRoot]), true);
  assert.equal(threadEligibleForPageFilter([]), false);
  assert.equal(
    threadEligibleForPageFilter([
      { filename: "TASK-20260609-020-PM-to-DEV.md", parent: "TASK-20260609-019" },
    ]),
    false,
  );
});

/** panel-task-012：根任务仅在 history，成员已归档，live pool 无成员 → 非活跃协作主线 */
const ledger012 = {
  thread_key: "panel-task-012",
  root_task_id: "TASK-20260609-012-ADMIN-to-PM",
  task_ids: [
    "TASK-20260609-006-PM-to-DEV",
    "TASK-20260609-007-PM-to-QA",
    "TASK-20260609-008-PM-to-OPS",
  ],
  report_ids: ["REPORT-20260610-019-QA-to-PM.md"],
};
const report019 = { filename: "REPORT-20260610-019-QA-to-PM.md", status: "blocked" };

test("panel-task-012: detached ledger thread when live pool has no members", () => {
  const livePool: typeof task005[] = [];
  assert.equal(isDetachedLedgerThread(ledger012, livePool), true);
});

test("panel-task-012: must not show as active report thread (REPORT-019 only)", () => {
  const livePool: typeof task005[] = [];
  const ok = shouldShowReportThreadInActive(
    ledger012,
    [report019],
    livePool,
    null,
  );
  assert.equal(ok, false);
});

const task034Done = {
  filename: "TASK-20260610-034-PM-to-DEV.md",
  path: "fcop/_lifecycle/done/TASK-20260610-034-PM-to-DEV.md",
  physical_scope: "done",
};
const task033Inbox = {
  filename: "TASK-20260610-033-PM-to-DEV.md",
  path: "fcop/_lifecycle/inbox/TASK-20260610-033-PM-to-DEV.md",
  physical_scope: "inbox",
};
const ledger214 = {
  thread_key: "panel-task-214",
  root_task_id: "TASK-20260610-214-ADMIN-to-PM",
  task_ids: ["TASK-20260610-034", "TASK-20260610-214"],
  report_ids: [
    "REPORT-20260610-091-QA-to-PM.md",
    "REPORT-20260610-092-QA-to-PM.md",
    "REPORT-20260610-093-QA-to-PM.md",
  ],
};
const ledger213 = {
  thread_key: "panel-task-213",
  root_task_id: "TASK-20260610-213-ADMIN-to-PM",
  task_ids: ["TASK-20260610-033", "TASK-20260610-213"],
  report_ids: ["REPORT-20260610-090-QA-to-PM.md"],
};

test("taskIsArchiveTabSettled: done/ counts as archive-tab settled", () => {
  assert.equal(taskIsArchiveTabSettled(task034Done), true);
  assert.equal(taskIsWorkflowSealed(task034Done), false);
  assert.equal(taskIsArchiveTabSettled(task033Inbox), false);
});

test("reportRootMatchesArchiveTab: done member visible on archive, not active-only sealed", () => {
  assert.equal(reportRootMatchesArchiveTab(task034Done, "archive"), true);
  assert.equal(reportRootMatchesArchiveTab(task034Done, "active"), true);
  assert.equal(reportRootMatchesArchiveTab(task033Inbox, "archive"), false);
  assert.equal(reportRootMatchesArchiveTab(null, "archive"), true);
  assert.equal(reportRootMatchesArchiveTab(null, "active"), false);
});

test("reportLegacyGroupMatchesArchiveTab: no-task legacy group shows on archive when reports exist", () => {
  const g = { reports: [{ filename: "REPORT-20260610-019-QA-to-PM.md" }] };
  assert.equal(reportLegacyGroupMatchesArchiveTab(g, "archive"), true);
  assert.equal(reportLegacyGroupMatchesArchiveTab(g, "active"), true);
  assert.equal(reportLegacyGroupMatchesArchiveTab({ reports: [] }, "archive"), false);
});

test("panel-task-214: archive tab shows thread when member 034 is in done/", () => {
  const live = [task034Done];
  const reports214 = [
    { filename: "REPORT-20260610-091-QA-to-PM.md" },
    { filename: "REPORT-20260610-092-QA-to-PM.md" },
    { filename: "REPORT-20260610-093-QA-to-PM.md" },
  ];
  assert.equal(
    shouldShowReportThreadInArchive(ledger214, reports214, live, null),
    true,
  );
});

test("closed parent residue: child with archived parent excluded from active pool", () => {
  const parent = {
    filename: "TASK-20260610-210-ADMIN-to-PM.md",
    path: "fcop/_lifecycle/archive/TASK-20260610-210-ADMIN-to-PM.md",
    physical_scope: "archive",
    frozen: true,
    display_status: "archived",
  };
  const child = {
    filename: "TASK-20260610-028-PM-to-DEV.md",
    path: "fcop/_lifecycle/archive/TASK-20260610-028-PM-to-DEV.md",
    physical_scope: "archive",
    parent: "TASK-20260610-210",
    archive_mode: "force",
    task_type: "force_archive",
    state: "dispatched",
  };
  const all = [parent, child];
  assert.equal(shouldExcludeClosedParentResidueFromActiveLists(child, all), true);
  const detected = detectClosedParentResidueTasks(all);
  assert.equal(detected.length, 1);
  assert.equal(detected[0]!.filename, child.filename);
  const visible = filterTaskPageVisiblePool(all, all, [], "active");
  assert.equal(visible.some((t) => t.filename === child.filename), false);
});

test("closed parent residue: marked task always excluded", () => {
  const marked = {
    filename: "TASK-20260610-032-PM-to-DEV.md",
    path: "fcop/_lifecycle/archive/TASK-20260610-032-PM-to-DEV.md",
    physical_scope: "archive",
    display_status: "closed_parent_residue",
    terminated_by_parent_archive: true,
    closed_parent_residue: true,
  };
  assert.equal(
    shouldExcludeClosedParentResidueFromActiveLists(marked, [marked]),
    true,
  );
});

test("panel-task-213: archive tab hides thread while member 033 still in inbox/", () => {
  const live = [task033Inbox];
  assert.equal(
    shouldShowReportThreadInArchive(
      ledger213,
      [{ filename: "REPORT-20260610-090-QA-to-PM.md" }],
      live,
      null,
    ),
    false,
  );
});

function mockAdminMainline(
  seq: string,
  subject = "",
): (typeof task024) & { path: string; physical_scope: string } {
  return {
    filename: `TASK-20260610-${seq}-ADMIN-to-PM.md`,
    path: `fcop/_lifecycle/archive/TASK-20260610-${seq}-ADMIN-to-PM.md`,
    physical_scope: "archive",
    preview: "",
    subject: subject || `主线 ${seq}`,
  };
}

test("TASK-20260611-007: mainTaskPoolItemSearchHaystack matches filename fragment", () => {
  const t = mockAdminMainline("113", "核对团队动态");
  assert.match(mainTaskPoolItemSearchHaystack(t), /task-20260610-113/);
  assert.match(mainTaskPoolItemSearchHaystack(t), /核对团队动态/);
});

test("TASK-20260611-007: filterPoolByMainTaskSearch hits item beyond first 10 thread models", () => {
  const pool = Array.from({ length: 12 }, (_, i) =>
    mockAdminMainline(String(101 + i)),
  );
  const scopedModels = pool.slice(0, 10).map((t) => ({
    id: (t.filename || "").replace(/\.md$/i, "").split("-").slice(0, 3).join("-"),
    root: t,
    members: [t],
    name: t.subject,
  }));
  const filtered = filterPoolByMainTaskSearch(
    pool,
    "112",
    scopedModels,
    pool,
  );
  assert.equal(filtered.length, 1);
  assert.match(filtered[0]!.filename || "", /112-ADMIN-to-PM/);
});

test("TASK-20260611-007: formatMainlineCountDisplay shows matched/total when searching", () => {
  assert.equal(formatMainlineCountDisplay(3, 22, "112"), "3/22");
  assert.equal(formatMainlineCountDisplay(22, 22, ""), "22");
});

test("TASK-20260611-008: reportUnifiedSearchHaystack merges main-task and body fields", () => {
  const r = {
    filename: "REPORT-20260611-016-DEV-to-PM.md",
    subject: "全池搜索修复",
    sender: "DEV",
    recipient: "PM",
  };
  const hay = reportUnifiedSearchHaystack(r, ["TASK-20260611-007"], "结论", "done");
  assert.match(hay, /task-20260611-007/);
  assert.match(hay, /dev-to-pm/);
  assert.match(hay, /结论/);
  assert.match(hay, /\bdev\b/);
});

test("TASK-20260611-009: empty search count >= narrowed search on same pool", () => {
  const pool = [
    ...Array.from({ length: 20 }, (_, i) => ({
      filename: `REPORT-20260510-${String(i + 1).padStart(3, "0")}-DEV-to-PM.md`,
      sender: "DEV",
      recipient: "PM",
      subject: `legacy ${i + 1}`,
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      filename: `REPORT-20260610-${String(i + 1).padStart(3, "0")}-DEV-to-PM.md`,
      sender: "DEV",
      recipient: "PM",
      subject: `june ${i + 1}`,
    })),
  ];
  const meta = (r: (typeof pool)[0]) => ({
    linkedTaskIds: [] as string[],
    topic: r.subject || "",
    summary: "",
    ledger: null,
  });
  const empty = filterReportPageVisibleItems(pool, {
    roleTab: "",
    archiveTab: "all",
    searchQ: "",
    scopedModels: [],
    shouldHideOnActiveBoard: () => false,
    meta,
  });
  const narrow = filterReportPageVisibleItems(pool, {
    roleTab: "",
    archiveTab: "all",
    searchQ: "20260610",
    scopedModels: [],
    shouldHideOnActiveBoard: () => false,
    meta,
  });
  assert.equal(empty.items.length, 25);
  assert.equal(narrow.items.length, 5);
  assert.ok(empty.items.length >= narrow.items.length);
});

test("TASK-20260611-009: active-board hide applies with and without search", () => {
  const pool = [
    {
      filename: "REPORT-20260611-001-DEV-to-PM.md",
      sender: "DEV",
      subject: "visible",
    },
    {
      filename: "REPORT-20260611-999-DEV-to-PM.md",
      sender: "DEV",
      subject: "late intake",
    },
  ];
  const meta = (r: (typeof pool)[0]) => ({
    linkedTaskIds: [] as string[],
    topic: r.subject || "",
    summary: "",
    ledger: null,
  });
  const hideLate = (r: (typeof pool)[0]) => r.filename?.includes("999") ?? false;
  const empty = filterReportPageVisibleItems(pool, {
    roleTab: "",
    archiveTab: "active",
    searchQ: "",
    scopedModels: [],
    shouldHideOnActiveBoard: hideLate,
    meta,
  });
  const narrow = filterReportPageVisibleItems(pool, {
    roleTab: "",
    archiveTab: "active",
    searchQ: "2026",
    scopedModels: [],
    shouldHideOnActiveBoard: hideLate,
    meta,
  });
  assert.equal(empty.items.length, 1);
  assert.equal(narrow.items.length, 1);
  assert.ok(empty.items.length >= narrow.items.length);
});

test("active tab: living ADMIN mainline visible when ledger root is archived (panel-task-102)", () => {
  const root042 = {
    filename: "TASK-20260611-042-ADMIN-to-PM.md",
    path: "fcop/_lifecycle/archive/TASK-20260611-042-ADMIN-to-PM.md",
    physical_scope: "archive",
    thread_key: "panel-task-102",
  };
  const root102 = {
    filename: "TASK-20260611-102-ADMIN-to-PM.md",
    path: "fcop/_lifecycle/active/TASK-20260611-102-ADMIN-to-PM.md",
    physical_scope: "active",
    thread_key: "panel-task-102",
  };
  const ledger102 = {
    thread_key: "panel-task-102",
    root_task_id: "TASK-20260611-042-ADMIN-to-PM",
    task_ids: ["TASK-20260611-042-ADMIN-to-PM", "TASK-20260611-102-ADMIN-to-PM"],
    report_ids: [],
  };
  const all = [root042, root102];
  const { visibleIds } = taskIdsMatchingRootArchiveTab(all, [ledger102], "active");
  assert.ok(visibleIds.has("TASK-20260611-102"));
  const pool = filterTaskPageVisiblePool(all, all, [ledger102], "active");
  assert.ok(pool.some((t) => t.filename?.includes("102-ADMIN-to-PM")));
});

test("TASK-20260611-008: applyReportUnifiedSearch finds report by body and by linked task", () => {
  const reports = [
    {
      filename: "REPORT-20260611-002-DEV-to-PM.md",
      sender: "DEV",
      recipient: "PM",
      subject: "面板修复",
    },
    {
      filename: "REPORT-20260611-016-DEV-to-PM.md",
      sender: "DEV",
      recipient: "PM",
      subject: "搜索全池",
    },
  ];
  const models = [
    {
      id: "TASK-20260611-007",
      root: { filename: "TASK-20260611-007-PM-to-DEV.md", subject: "搜索修复" },
      members: [{ filename: "TASK-20260611-007-PM-to-DEV.md" }],
      name: "搜索修复",
    },
  ];
  const byTask = applyReportUnifiedSearch(
    reports,
    "TASK-20260611-007",
    models,
    (r) => ({
      linkedTaskIds:
        r.filename === "REPORT-20260611-016-DEV-to-PM.md"
          ? ["TASK-20260611-007"]
          : [],
      topic: r.subject || "",
      summary: "",
      ledger: null,
    }),
  );
  assert.equal(byTask.length, 1);
  assert.match(byTask[0]!.filename || "", /016/);
  const byBody = applyReportUnifiedSearch(
    reports,
    "面板修复",
    models,
    (r) => ({
      linkedTaskIds: [],
      topic: r.subject || "",
      summary: "",
      ledger: null,
    }),
  );
  assert.equal(byBody.length, 1);
  assert.match(byBody[0]!.filename || "", /002/);
});

test("panel-task-011: PM team section lists DEV+QA done subtasks by thread_key", () => {
  const all = [
    {
      filename: "TASK-20260619-011-ADMIN-to-PM.md",
      thread_key: "panel-task-011",
      physical_scope: "review",
    },
    {
      filename: "TASK-20260619-012-PM-to-DEV.md",
      thread_key: "panel-task-011",
      physical_scope: "done",
    },
    {
      filename: "TASK-20260619-013-PM-to-QA.md",
      thread_key: "panel-task-011",
      physical_scope: "done",
    },
  ];
  const rows = collectPmTeamDispatchTasksForThread(all, "panel-task-011", null);
  assert.equal(rows.length, 2);
  const ids = rows.map((r) => r.filename).sort();
  assert.deepEqual(ids, [
    "TASK-20260619-012-PM-to-DEV.md",
    "TASK-20260619-013-PM-to-QA.md",
  ]);
});

test("PM team section follows strong parent when child thread_key differs", () => {
  const all = [
    {
      filename: "TASK-20260711-001-ADMIN-to-PM.md",
      thread_key: "panel-task-001",
      physical_scope: "review",
    },
    {
      filename: "TASK-20260711-002-PM-to-DEV.md",
      thread_key: "TASK-20260711-001",
      parent: "TASK-20260711-001",
      physical_scope: "done",
    },
    {
      filename: "TASK-20260711-003-PM-to-QA.md",
      thread_key: "TASK-20260711-001",
      parent: "TASK-20260711-001",
      physical_scope: "done",
    },
  ];
  const rows = collectPmTeamDispatchTasksForThread(all, "panel-task-001", null);
  assert.deepEqual(
    rows.map((row) => row.filename),
    [
      "TASK-20260711-002-PM-to-DEV.md",
      "TASK-20260711-003-PM-to-QA.md",
    ],
  );
});

test("panel-task-011: all visible threads mode lists DEV+QA without thread select", () => {
  const all = [
    {
      filename: "TASK-20260619-011-ADMIN-to-PM.md",
      thread_key: "panel-task-011",
      physical_scope: "review",
    },
    {
      filename: "TASK-20260619-012-PM-to-DEV.md",
      thread_key: "panel-task-011",
      physical_scope: "done",
    },
    {
      filename: "TASK-20260619-013-PM-to-QA.md",
      thread_key: "panel-task-011",
      physical_scope: "done",
    },
  ];
  const models = [
    {
      id: "panel-task-011",
      name: "新的游戏开发",
      root: { filename: "TASK-20260619-011-ADMIN-to-PM.md", thread_key: "panel-task-011" },
    },
  ];
  const rows = collectPmTeamDispatchTasksForVisibleThreads(all, models, null);
  assert.equal(rows.length, 2);
  const ids = rows.map((r) => r.filename).sort();
  assert.deepEqual(ids, [
    "TASK-20260619-012-PM-to-DEV.md",
    "TASK-20260619-013-PM-to-QA.md",
  ]);
});

test("panel-task-011: PM team section role filter keeps single role", () => {
  const all = [
    {
      filename: "TASK-20260619-012-PM-to-DEV.md",
      thread_key: "panel-task-011",
      physical_scope: "done",
    },
    {
      filename: "TASK-20260619-013-PM-to-QA.md",
      thread_key: "panel-task-011",
      physical_scope: "done",
    },
  ];
  const qaOnly = collectPmTeamDispatchTasksForThread(all, "panel-task-011", "QA");
  assert.equal(qaOnly.length, 1);
  assert.match(qaOnly[0]!.filename || "", /013.*QA/);
});
