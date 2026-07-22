/**
 * Panel task tab visibility — root-driven archive/active filter with child chain follow.
 * Mirrors logic in scripts/_panel-inline.js (keep in sync when changing rules).
 */

export type TaskTab = "active" | "archive" | "all";

export type TaskClass =
  | "main"
  | "subtask"
  | "rework"
  | "supplement"
  | "smoke"
  | "force_archive"
  | "unknown";

export type TaskLike = {
  filename?: string;
  parent?: string;
  references?: string | string[];
  path?: string;
  physical_scope?: string;
  subject?: string;
  preview?: string;
  task_type?: string;
  archive_mode?: string;
  supersedes?: string;
  display_status?: string;
  reopen_reason?: string;
  reopened_count?: number;
  thread_key?: string;
  state?: string;
  lifecycle_projection?: string;
  frozen?: boolean;
  terminated_by_parent_archive?: boolean;
  closed_parent_residue?: boolean;
  summary?: string;
};

export type ThreadRow = {
  thread_key?: string;
  root_task_id?: string;
  task_ids?: string[];
  report_ids?: string[];
};

export type MainTaskSelectionModel = {
  id: string;
  name: string;
  root: TaskLike;
  members: TaskLike[];
};

const LIFECYCLE_STAGE_RE =
  /[/\\]_lifecycle[/\\](inbox|active|review|done|archive)(?:[/\\]|$)/i;

export function taskIdFromFilename(fn: string): string {
  const m = String(fn || "").match(/^(TASK-\d{8}-\d{3,})/i);
  return m?.[1] ?? "";
}

/** FCoP-0003 strong parent link only (Tree / archive chain). */
export function taskStrongParentId(f: TaskLike): string {
  const m = String(f.parent ?? "").match(/TASK-\d{8}-\d{3,}/i);
  return m ? m[0].toUpperCase() : "";
}

/** Weak reference ids from frontmatter `references` (never used for Tree edges). */
export function taskReferenceIds(f: TaskLike): string[] {
  const raw = f.references;
  if (raw == null || raw === "") return [];
  const items = Array.isArray(raw) ? raw : [String(raw)];
  const ids: string[] = [];
  for (const item of items) {
    const re = /TASK-\d{8}-\d{3,}/gi;
    let m: RegExpExecArray | null;
    const s = String(item);
    while ((m = re.exec(s))) {
      const id = m[0].toUpperCase();
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/** Legacy alias — strong `parent` only; do not fold `references` into Tree semantics. */
export function taskParentId(f: TaskLike): string {
  return taskStrongParentId(f);
}

/** Resolve ADMIN→PM root from weak `references` (display compat for pre-parent tasks). */
export function inferAdminRootFromReferences(
  f: TaskLike,
  taskById: Map<string, TaskLike>,
): string {
  for (const refId of taskReferenceIds(f)) {
    const t = taskById.get(refId);
    if (t && isAdminMainline(t.filename ?? "")) return refId;
  }
  return "";
}

export function physicalScopeFromPath(f: TaskLike): string {
  const ps = String(f.physical_scope ?? "").toLowerCase().trim();
  if (ps) return ps;
  const fromPath = (String(f.path ?? "").match(LIFECYCLE_STAGE_RE) || [])[1];
  return fromPath ? String(fromPath).toLowerCase() : "";
}

export function isAdminMainline(filename: string): boolean {
  return /-ADMIN-to-PM/i.test(filename || "");
}

/** Alias for panel inline (`isAdminMainlineTask`). */
export const isAdminMainlineTask = isAdminMainline;

const PM_BRANCH_RE = /-PM-to-(DEV|OPS|QA|EVAL)/i;
const PM_REPLY_RE = /-PM-to-ADMIN/i;

/** PM 派发给 DEV/OPS/QA 的支线任务 */
export function isPmBranchTask(filename: string): boolean {
  return PM_BRANCH_RE.test(filename || "");
}

/** PM→团队执行任务区：DEV / QA / OPS 派发（不含 EVAL / PM→ADMIN）。 */
const PM_TEAM_DISPATCH_RE = /-PM-to-(DEV|OPS|QA)/i;

export function isPmTeamDispatchTask(filename: string): boolean {
  return PM_TEAM_DISPATCH_RE.test(filename || "");
}

/**
 * 任务页专用的根任务模型。
 *
 * 与协作总线的 thread 模型不同，这里永远以 ADMIN→PM 根 task_id 为主键；
 * thread_key 只在同名根任务唯一时兜底，不能把复用 thread_key 的历史主线合并。
 */
export function buildMainTaskSelectionModels(
  allTasks: TaskLike[],
  ledgerRows: ThreadRow[] = [],
): MainTaskSelectionModel[] {
  const tasks = (allTasks ?? []).filter((task) =>
    String(task.filename ?? "").startsWith("TASK-"),
  );
  const byId = buildTaskByIdMap(tasks);
  const roots = tasks.filter(
    (task) =>
      isAdminMainline(task.filename ?? "") && !taskStrongParentId(task),
  );
  const rootById = new Map(
    roots
      .map((root) => [taskIdFromFilename(root.filename ?? ""), root] as const)
      .filter(([id]) => Boolean(id)),
  );
  const rootsByThread = new Map<string, string[]>();
  for (const [rootId, root] of rootById) {
    const key = bareThreadKey(String(root.thread_key ?? "").trim());
    if (!key) continue;
    rootsByThread.set(key, [...(rootsByThread.get(key) ?? []), rootId]);
  }

  const membersByRoot = new Map<string, TaskLike[]>();
  for (const rootId of rootById.keys()) membersByRoot.set(rootId, []);

  const ledgerRootsForTask = (taskId: string): string[] => {
    const matches = new Set<string>();
    for (const row of ledgerRows ?? []) {
      const ids = (row.task_ids ?? []).map((id) =>
        taskIdFromFilename(String(id)),
      );
      if (!ids.includes(taskId)) continue;
      const rootId = taskIdFromFilename(String(row.root_task_id ?? ""));
      if (rootById.has(rootId)) matches.add(rootId);
    }
    return [...matches];
  };

  for (const task of tasks) {
    const taskId = taskIdFromFilename(task.filename ?? "");
    if (!taskId) continue;

    let rootId = rootById.has(taskId) ? taskId : "";

    // 1. parent / recursive parent
    if (!rootId && taskStrongParentId(task)) {
      const parentRoot = resolveAdminRootIdForTask(task, byId);
      if (rootById.has(parentRoot)) rootId = parentRoot;
    }

    // 2. ledger root_task_id / task_ids
    if (!rootId) {
      const ledgerRoots = ledgerRootsForTask(taskId);
      if (ledgerRoots.length === 1) rootId = ledgerRoots[0]!;
    }

    // 3. references compatibility
    if (!rootId) {
      const referenceRoots = taskReferenceIds(task).filter((id) =>
        rootById.has(id),
      );
      if (referenceRoots.length === 1) rootId = referenceRoots[0]!;
    }

    // 4. thread_key is a unique-only fallback
    if (!rootId) {
      const thread = bareThreadKey(String(task.thread_key ?? "").trim());
      const candidates = rootsByThread.get(thread) ?? [];
      if (thread && candidates.length === 1) rootId = candidates[0]!;
    }

    if (rootId) membersByRoot.get(rootId)?.push(task);
  }

  return [...rootById.entries()]
    .map(([id, root]) => {
      const members = membersByRoot.get(id) ?? [];
      if (!members.some((task) => taskIdFromFilename(task.filename ?? "") === id)) {
        members.unshift(root);
      }
      return {
        id,
        name: String(root.subject ?? root.filename ?? id),
        root,
        members,
      };
    })
    .sort((a, b) => b.id.localeCompare(a.id));
}

export function collectPmTeamDispatchTasksForRoot(
  allTasks: TaskLike[],
  ledgerRows: ThreadRow[],
  rootTaskId: string,
  roleFilter?: string | null,
): TaskLike[] {
  const rootId = taskIdFromFilename(rootTaskId);
  const model = buildMainTaskSelectionModels(allTasks, ledgerRows).find(
    (item) => item.id === rootId,
  );
  if (!model) return [];
  const role = String(roleFilter ?? "").trim().toUpperCase();
  return model.members.filter((task) => {
    if (!isPmTeamDispatchTask(task.filename ?? "")) return false;
    if (!role || role === "ALL") return true;
    return new RegExp(`-PM-to-${role}(?:\\.|-)`, "i").test(
      task.filename ?? "",
    );
  });
}

/**
 * 任务页 PM→团队区：同一 bare thread_key 下全部 PM→DEV/QA/OPS 子任务。
 * 不按 lifecycle bucket 过滤；按 task_id 去重。
 */
export function collectPmTeamDispatchTasksForThread(
  allTasks: TaskLike[],
  threadBareKey: string,
  roleFilter?: string | null,
): TaskLike[] {
  const bare = String(threadBareKey ?? "").trim();
  if (!bare) return [];
  const taskById = buildTaskByIdMap(allTasks ?? []);
  const rootIds = new Set(
    (allTasks ?? [])
      .filter(
        (f) =>
          isAdminMainline(f.filename ?? "") &&
          bareThreadKey(String(f.thread_key ?? "").trim()) === bare,
      )
      .map((f) => taskIdFromFilename(f.filename ?? ""))
      .filter(Boolean),
  );
  let rows = (allTasks ?? []).filter((f) => {
    if (!isPmTeamDispatchTask(f.filename ?? "")) return false;
    const strongRoot = resolveAdminRootIdForTask(f, taskById);
    if (strongRoot && rootIds.has(strongRoot)) return true;
    return bareThreadKey(String(f.thread_key ?? "").trim()) === bare;
  });
  const rf = String(roleFilter ?? "").trim();
  if (rf) {
    rows = rows.filter((f) =>
      new RegExp(`PM-to-${rf}`, "i").test(f.filename ?? ""),
    );
  }
  const seen = new Set<string>();
  return rows.filter((f) => {
    const id = taskIdFromFilename(f.filename ?? "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * 任务页「全部任务」：对当前可见的每个 ADMIN 主线 thread 聚合 PM→DEV/QA/OPS。
 * 不按 lifecycle bucket 过滤；跨 thread 按 task_id 去重。
 */
export function collectPmTeamDispatchTasksForVisibleThreads(
  allTasks: TaskLike[],
  visibleThreadModels: MainTaskThreadModelLike[],
  roleFilter?: string | null,
): TaskLike[] {
  const seen = new Set<string>();
  const out: TaskLike[] = [];
  for (const m of visibleThreadModels ?? []) {
    const bare = bareThreadKey(String(m?.root?.thread_key ?? "").trim());
    if (!bare) continue;
    const rows = collectPmTeamDispatchTasksForThread(
      allTasks,
      bare,
      roleFilter,
    );
    for (const f of rows) {
      const id = taskIdFromFilename(f.filename ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(f);
    }
  }
  return out;
}

const ADMIN_MAINLINE_REF_RE = /ADMIN\s*主线\s*(TASK-\d{8}-\d{3,})/i;

/** 无 parent 时从 subject/preview 解析「ADMIN 主线 TASK-…」（orphan 支线常见）。 */
export function inferAdminRootIdFromTaskText(f: TaskLike): string {
  const chunks = [
    String(f.subject ?? ""),
    String(f.preview ?? ""),
    String(f.summary ?? ""),
  ];
  for (const chunk of chunks) {
    const m = chunk.match(ADMIN_MAINLINE_REF_RE);
    if (m?.[1]) return String(m[1]).toUpperCase();
  }
  return "";
}

/** 沿 parent 链上溯到 ADMIN→PM 主线 id；主线自身返回其 task id */
export function resolveAdminRootIdForTask(
  f: TaskLike,
  taskById: Map<string, TaskLike>,
): string {
  const fn = String(f.filename ?? "");
  if (isAdminMainline(fn)) return taskIdFromFilename(fn);
  let cur = taskIdFromFilename(fn);
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const t = taskById.get(cur);
    if (!t) break;
    if (isAdminMainline(t.filename ?? "")) return taskIdFromFilename(t.filename ?? "");
    cur = taskStrongParentId(t);
  }
  const fromRefs = inferAdminRootFromReferences(f, taskById);
  if (fromRefs) return fromRefs;
  return inferAdminRootIdFromTaskText(f);
}

/** Strip ledger bucket suffix (`panel-task-005#TASK-…`) for cross-root comparison. */
export function bareThreadKey(threadKey: string): string {
  const tk = String(threadKey ?? "").trim();
  const hash = tk.indexOf("#");
  return hash >= 0 ? tk.slice(0, hash).trim() : tk;
}

function buildTaskByIdMap(taskList: TaskLike[]): Map<string, TaskLike> {
  const byId = new Map<string, TaskLike>();
  for (const t of taskList) {
    const id = taskIdFromFilename(t.filename ?? "");
    if (id) byId.set(id, t);
  }
  return byId;
}

/** Same bare thread_key: in-flight ADMIN mainline (not done/archive), if any. */
export function findLivingAdminMainlineIdForThread(
  allTasks: TaskLike[],
  bareKey: string,
): string {
  const bare = String(bareKey ?? "").trim();
  if (!bare) return "";
  for (const t of allTasks) {
    if (!isAdminMainline(t.filename ?? "")) continue;
    if (bareThreadKey(String(t.thread_key ?? "").trim()) !== bare) continue;
    const scope = physicalScopeFromPath(t);
    if (scope !== "done" && scope !== "archive") {
      return taskIdFromFilename(t.filename ?? "");
    }
  }
  return "";
}

/** Active/all tab: hide PM branch when its ADMIN root ≠ current in-flight mainline on same thread. */
export function shouldHideStalePmBranchOnActiveTab(
  f: TaskLike,
  allTasks: TaskLike[],
  tab: TaskTab,
): boolean {
  if (tab !== "active" && tab !== "all") return false;
  if (!isPmBranchTask(f.filename ?? "")) return false;
  const byId = buildTaskByIdMap(allTasks);
  const adminRootId = resolveAdminRootIdForTask(f, byId);

  let bare = bareThreadKey(String(f.thread_key ?? "").trim());
  if (!adminRootId) {
    if (!bare) return false;
    const livingId = findLivingAdminMainlineIdForThread(allTasks, bare);
    // Orphan PM branch (no parent / no ADMIN ref in ledger): hide when thread has in-flight mainline.
    return Boolean(livingId);
  }

  const adminRoot = byId.get(adminRootId);
  if (!bare && adminRoot) {
    bare = bareThreadKey(String(adminRoot.thread_key ?? "").trim());
  }
  if (!bare) return false;

  const livingId = findLivingAdminMainlineIdForThread(allTasks, bare);
  if (livingId) return adminRootId !== livingId;

  // No in-flight mainline: hide only when branch's settled root is closed and visible in list
  if (!adminRoot) return false;
  const rootScope = physicalScopeFromPath(adminRoot);
  if (rootScope !== "done" && rootScope !== "archive") return false;
  for (const t of allTasks) {
    if (!isAdminMainline(t.filename ?? "")) continue;
    const id = taskIdFromFilename(t.filename ?? "");
    if (!id || id === adminRootId) continue;
    if (bareThreadKey(String(t.thread_key ?? "").trim()) !== bare) continue;
    const scope = physicalScopeFromPath(t);
    if (scope !== "done" && scope !== "archive") return true;
  }
  return false;
}

const KNOWN_SMOKE_IDS = new Set(["TASK-20260604-018", "TASK-20260604-019"]);

/** Strict smoke — subject/frontmatter/id only; never scan preview/body (024/020 safe). */
export function isStrictSmokeTask(f: TaskLike): boolean {
  const taskType = String(f.task_type ?? "").toLowerCase().trim();
  if (taskType === "smoke") return true;

  const id = taskIdFromFilename(f.filename || "");
  if (KNOWN_SMOKE_IDS.has(id)) return true;

  const fn = String(f.filename || "");
  const subject = String(f.subject ?? "").trim();
  if (/-ADMIN-to-PM/i.test(fn)) {
    if (/topology fix smoke/i.test(subject)) return true;
    if (/delete if test|test artifact/i.test(subject)) return true;
  }
  if (!isAdminMainline(fn) && /delete if test|test artifact/i.test(subject)) {
    return true;
  }
  return false;
}

/** Task nature for Dashboard KPI / swimlane / archive semantics. */
export function classifyTask(f: TaskLike): TaskClass {
  const fn = String(f.filename || "");
  if (!fn.startsWith("TASK-")) return "unknown";

  const archiveMode = String(f.archive_mode ?? "").toLowerCase().trim();
  if (archiveMode === "force") return "force_archive";

  if (isStrictSmokeTask(f)) return "smoke";

  const taskType = String(f.task_type ?? "").toLowerCase().trim();
  if (taskType === "force_archive") return "force_archive";
  if (taskType === "rework") return "rework";
  if (taskType === "supplement") return "supplement";

  if (PM_BRANCH_RE.test(fn)) return "subtask";

  const parentRef = taskParentId(f);
  const supersedes =
    String(f.supersedes ?? "").match(/TASK-\d{8}-\d{3,}/)?.[0] ?? "";
  if (parentRef || supersedes) {
    const ds = String(f.display_status ?? "").toLowerCase();
    if (ds === "admin_rejected" || Number(f.reopened_count ?? 0) > 0) {
      return "rework";
    }
    if (String(f.reopen_reason ?? "").trim()) return "rework";
    if (PM_REPLY_RE.test(fn) && parentRef) return "supplement";
    if (isAdminMainline(fn)) return "rework";
  }

  if (PM_REPLY_RE.test(fn)) return "supplement";
  if (isAdminMainline(fn)) return "main";
  return "unknown";
}

/** smoke/test artifact — excluded from mainline KPIs; may still show in lists with mark. */
export function isSmokeArtifactTask(f: TaskLike): boolean {
  return classifyTask(f) === "smoke";
}

export function isDashboardMainTask(f: TaskLike): boolean {
  return classifyTask(f) === "main";
}

function isBranchClass(c: TaskClass): boolean {
  return c === "subtask" || c === "rework" || c === "supplement" || c === "unknown";
}

export type VisibleTaskBreakdown = {
  mainline: number;
  branch: number;
  smoke: number;
  total: number;
};

/** Non-mainline tasks in pool (excludes smoke / force_archive). */
export function countBranchTasksInPool(pool: TaskLike[]): number {
  return (pool || []).filter((f) => isBranchClass(classifyTask(f))).length;
}

/** Unified breakdown for Dashboard / task header / report hint alignment. */
export function countVisibleTaskBreakdown(
  pool: TaskLike[],
): VisibleTaskBreakdown {
  const list = pool || [];
  let mainline = 0;
  let branch = 0;
  let smoke = 0;
  for (const f of list) {
    const c = classifyTask(f);
    if (c === "smoke") {
      smoke++;
      continue;
    }
    if (c === "force_archive") continue;
    if (c === "main") mainline++;
    else if (isBranchClass(c)) branch++;
  }
  return { mainline, branch, smoke, total: list.length };
}

export function mergeLedgerRowsByRoot(ledgerRows: ThreadRow[]): ThreadRow[] {
  const byRoot = new Map<string, ThreadRow>();
  for (const row of ledgerRows || []) {
    if (!row || row.thread_key === "_orphan_") continue;
    const rootId = taskIdFromFilename(row.root_task_id || "");
    if (!rootId) continue;
    if (!byRoot.has(rootId)) {
      byRoot.set(rootId, {
        root_task_id: rootId,
        thread_key: row.thread_key || "",
        task_ids: [],
        report_ids: [],
      });
    }
    const m = byRoot.get(rootId)!;
    const addUnique = (arr: string[], items: string[] | undefined) => {
      for (const x of items || []) {
        const s = String(x);
        if (s && !arr.includes(s)) arr.push(s);
      }
    };
    addUnique(m.task_ids!, row.task_ids);
    addUnique(m.report_ids!, row.report_ids);
  }
  return [...byRoot.values()];
}

export function absorbOrphanLedgerRows(
  mergedRows: ThreadRow[],
  allRows: ThreadRow[],
  taskList: TaskLike[],
): ThreadRow[] {
  const merged = mergedRows.map((r) => ({
    ...r,
    task_ids: [...(r.task_ids ?? [])],
    report_ids: [...(r.report_ids ?? [])],
  }));
  const byRoot = new Map<string, ThreadRow>();
  for (const r of merged) {
    const rid = taskIdFromFilename(r.root_task_id || "");
    if (rid) byRoot.set(rid, r);
  }
  const byId = new Map<string, TaskLike>();
  for (const t of taskList) {
    const id = taskIdFromFilename(t.filename || "");
    if (id) byId.set(id, t);
  }
  const findHost = (t: TaskLike): ThreadRow | null => {
    let parentId = taskParentId(t);
    while (parentId) {
      const host = byRoot.get(parentId);
      if (host) return host;
      const pt = byId.get(parentId);
      parentId = pt ? taskParentId(pt) : "";
    }
    const adminRootId = resolveAdminRootIdForTask(t, byId);
    if (adminRootId) return byRoot.get(adminRootId) ?? null;
    return null;
  };
  for (const row of allRows || []) {
    if (!String(row?.thread_key || "").startsWith("_orphan")) continue;
    for (const tid of row.task_ids ?? []) {
      const id = taskIdFromFilename(String(tid));
      const t = byId.get(id);
      const host = t ? findHost(t) : null;
      if (host && id && !host.task_ids!.includes(id)) host.task_ids!.push(id);
    }
  }
  return merged;
}

export function expandThreadMembersByParent(
  taskList: TaskLike[],
  members: TaskLike[],
): TaskLike[] {
  const claimed = new Set(
    members.map((m) => taskIdFromFilename(m.filename || "")).filter(Boolean),
  );
  const out = [...members];
  const q = [...claimed];
  while (q.length) {
    const pid = q.shift()!;
    for (const x of taskList) {
      const xid = taskIdFromFilename(x.filename || "");
      if (!xid || claimed.has(xid)) continue;
      if (taskStrongParentId(x) === pid) {
        claimed.add(xid);
        out.push(x);
        q.push(xid);
      }
    }
  }
  return out;
}

function rootMatchesArchiveTab(root: TaskLike, tab: TaskTab): boolean {
  if (tab === "all") return true;
  const isArchive = physicalScopeFromPath(root) === "archive";
  if (tab === "archive") return isArchive;
  return !isArchive;
}

function taskMatchesArchiveTab(f: TaskLike, tab: TaskTab): boolean {
  if (tab === "all") return true;
  const isArchive = physicalScopeFromPath(f) === "archive";
  if (tab === "archive") return isArchive;
  return !isArchive;
}

export function pickThreadDisplayRootId(
  row: ThreadRow,
  members: TaskLike[],
  root: TaskLike | null,
): string {
  const admin = members.find((m) => isAdminMainline(m.filename || ""));
  if (admin) return taskIdFromFilename(admin.filename || "");
  const fromLedger = taskIdFromFilename(row.root_task_id || "");
  if (fromLedger) return fromLedger;
  return (
    taskIdFromFilename(root?.filename || "") ||
    String(row.thread_key || "") ||
    "thread"
  );
}

export function buildThreadMembersFromLedger(
  taskList: TaskLike[],
  ledgerRows: ThreadRow[],
): { members: TaskLike[]; root: TaskLike | null }[] {
  const list = taskList.filter((t) =>
    String(t.filename || "").startsWith("TASK-"),
  );
  const byId = new Map<string, TaskLike>();
  for (const t of list) {
    const id = taskIdFromFilename(t.filename || "");
    if (id) byId.set(id, t);
  }
  const source = absorbOrphanLedgerRows(
    mergeLedgerRowsByRoot(ledgerRows),
    ledgerRows,
    list,
  ).filter((row) => (row.task_ids?.length ?? 0) > 0);

  return source.map((row) => {
    const rootId = taskIdFromFilename(row.root_task_id || "");
    const rowThread = String(row.thread_key || "").trim();
    const livingId = findLivingAdminMainlineIdForThread(
      list,
      bareThreadKey(rowThread),
    );
    const effectiveRootId = livingId || rootId;
    let members: TaskLike[] = [];
    for (const tid of row.task_ids ?? []) {
      const id = taskIdFromFilename(String(tid));
      const t = byId.get(id);
      if (!t) continue;
      if (livingId && isAdminMainline(t.filename || "") && id !== livingId) {
        continue;
      }
      if (!livingId && id !== rootId && isAdminMainline(t.filename || "")) {
        continue;
      }
      members.push(t);
    }
    if (livingId) {
      const living = byId.get(livingId);
      if (
        living &&
        !members.some((m) => taskIdFromFilename(m.filename || "") === livingId)
      ) {
        members.push(living);
      }
    }
    members = expandThreadMembersByParent(list, members);
    if (rowThread) {
      members = members.filter((m) => {
        const tk = String(m.thread_key ?? "").trim();
        return !tk || tk === rowThread;
      });
    }
    members = members.filter((m) => {
      const adminRoot = resolveAdminRootIdForTask(m, byId);
      if (adminRoot) return adminRoot === effectiveRootId;
      if (isPmBranchTask(m.filename ?? "")) return false;
      return true;
    });
    const seen = new Set<string>();
    members = members.filter((m) => {
      const mid = taskIdFromFilename(m.filename || "");
      if (!mid || seen.has(mid)) return false;
      seen.add(mid);
      return true;
    });
    let root: TaskLike | null =
      (effectiveRootId && byId.get(effectiveRootId)) ||
      members.find(
        (m) => taskIdFromFilename(m.filename || "") === effectiveRootId,
      ) ||
      members.find((m) => isAdminMainline(m.filename || "")) ||
      members[0] ||
      null;
    if (livingId) {
      const living = byId.get(livingId);
      if (living) root = living;
    }
    return { members, root };
  });
}

export function taskIdsMatchingRootArchiveTab(
  taskList: TaskLike[],
  ledgerRows: ThreadRow[],
  tab: TaskTab,
): { visibleIds: Set<string>; threadMemberIds: Set<string> } {
  const visibleIds = new Set<string>();
  const threadMemberIds = new Set<string>();
  const threads = buildThreadMembersFromLedger(taskList, ledgerRows);
  for (const { members, root } of threads) {
    for (const m of members) {
      const id = taskIdFromFilename(m.filename || "");
      if (id) threadMemberIds.add(id);
    }
    let rootTask =
      root ||
      members.find((m) => isAdminMainline(m.filename || "")) ||
      members[0];
    if (tab === "active") {
      const bare = bareThreadKey(
        String(
          members.find((m) => String(m.thread_key ?? "").trim())?.thread_key ??
            "",
        ).trim(),
      );
      if (bare) {
        const livingId = findLivingAdminMainlineIdForThread(taskList, bare);
        if (livingId) {
          const living =
            members.find(
              (m) => taskIdFromFilename(m.filename || "") === livingId,
            ) ?? taskList.find((t) => taskIdFromFilename(t.filename || "") === livingId);
          if (living) rootTask = living;
        }
      }
    }
    if (!rootTask || !rootMatchesArchiveTab(rootTask, tab)) continue;
    for (const m of members) {
      const id = taskIdFromFilename(m.filename || "");
      if (id) visibleIds.add(id);
    }
  }
  return { visibleIds, threadMemberIds };
}

export const CLOSED_PARENT_RESIDUE_DISPLAY = "closed_parent_residue";

export function isClosedParentResidueMarked(f: TaskLike): boolean {
  if (f.terminated_by_parent_archive === true) return true;
  if (f.closed_parent_residue === true) return true;
  const ds = String(f.display_status ?? "").trim().toLowerCase();
  return ds === CLOSED_PARENT_RESIDUE_DISPLAY;
}

export function isParentTaskClosedForResidue(
  parent: TaskLike | null | undefined,
): boolean {
  if (!parent) return false;
  const scope = physicalScopeFromPath(parent);
  if (scope === "archive" || scope === "done") return true;
  if (parent.frozen === true) return true;
  const proj = String(parent.lifecycle_projection ?? "").trim().toLowerCase();
  if (proj === "archive" || proj === "done") return true;
  const ds = String(parent.display_status ?? "").trim().toLowerCase();
  return ds === "archived";
}

export function isForceArchivedWithoutResidueMark(f: TaskLike): boolean {
  if (isClosedParentResidueMarked(f)) return false;
  const scope = physicalScopeFromPath(f);
  if (scope !== "archive") return false;
  const archiveMode = String(f.archive_mode ?? "").trim().toLowerCase();
  const taskType = String(f.task_type ?? "").trim().toLowerCase();
  return archiveMode === "force" || taskType === "force_archive";
}

export function isClosedParentResidueTask(
  f: TaskLike,
  taskList: TaskLike[],
): boolean {
  if (isClosedParentResidueMarked(f)) return true;
  if (isAdminMainline(f.filename ?? "")) return false;
  const byId = new Map<string, TaskLike>();
  for (const t of taskList) {
    const id = taskIdFromFilename(t.filename ?? "");
    if (id) byId.set(id, t);
  }
  const parentId = taskStrongParentId(f) || resolveAdminRootIdForTask(f, byId);
  const parent = parentId ? byId.get(parentId) ?? null : null;
  const parentClosed = isParentTaskClosedForResidue(parent);
  if (!parentClosed) return false;
  const scope = physicalScopeFromPath(f);
  if (scope === "inbox" || scope === "active" || scope === "review") {
    return true;
  }
  if (isForceArchivedWithoutResidueMark(f)) return true;
  const proj = String(f.lifecycle_projection ?? "").trim().toLowerCase();
  return proj === "inbox" || proj === "active" || proj === "review";
}

export function hasStateBucketMismatch(f: TaskLike): boolean {
  const scope = physicalScopeFromPath(f);
  const state = String(f.state ?? "").trim().toLowerCase();
  return scope === "inbox" && state === "dispatched";
}

export function detectClosedParentResidueTasks(
  taskList: TaskLike[],
): Array<TaskLike & { residue_flags?: string[] }> {
  const list = taskList || [];
  return list
    .filter((f) => isClosedParentResidueTask(f, list))
    .map((f) => {
      const flags: string[] = ["closed_parent_residue"];
      if (hasStateBucketMismatch(f)) flags.push("state_bucket_mismatch");
      return { ...f, residue_flags: flags };
    });
}

export function shouldExcludeClosedParentResidueFromActiveLists(
  f: TaskLike,
  taskList: TaskLike[],
): boolean {
  return isClosedParentResidueTask(f, taskList);
}

export function taskIsDescendantOfVisibleRoot(
  f: TaskLike,
  visibleIds: Set<string>,
  taskList: TaskLike[],
): boolean {
  let cur = taskIdFromFilename(f.filename || "");
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    if (visibleIds.has(cur)) return true;
    seen.add(cur);
    const t = taskList.find((x) => taskIdFromFilename(x.filename || "") === cur);
    cur = t ? taskStrongParentId(t) : "";
  }
  return false;
}

export function filterTaskPageVisiblePool(
  pool: TaskLike[],
  allTasks: TaskLike[],
  ledgerRows: ThreadRow[],
  tab: TaskTab,
): TaskLike[] {
  if (tab === "all") {
    return pool.filter(
      (f) =>
        !shouldHideStalePmBranchOnActiveTab(f, allTasks, tab) &&
        !shouldExcludeClosedParentResidueFromActiveLists(f, allTasks),
    );
  }
  const { visibleIds, threadMemberIds } = taskIdsMatchingRootArchiveTab(
    allTasks,
    ledgerRows,
    tab,
  );
  return pool.filter((f) => {
    if (shouldExcludeClosedParentResidueFromActiveLists(f, allTasks)) {
      return false;
    }
    if (shouldHideStalePmBranchOnActiveTab(f, allTasks, tab)) return false;
    const id = taskIdFromFilename(f.filename || "");
    if (id && threadMemberIds.has(id)) return visibleIds.has(id);
    if (id && taskIsDescendantOfVisibleRoot(f, visibleIds, allTasks)) return true;
    if (isPmBranchTask(f.filename ?? "")) return false;
    return taskMatchesArchiveTab(f, tab);
  });
}

/** 当前可见池中的正式主线数（classify === main） */
export function countAdminMainlinesInPool(pool: TaskLike[]): number {
  return (pool || []).filter((f) => classifyTask(f) === "main").length;
}

export function normalizeMainTaskSearchQ(q: string): string {
  return String(q || "").trim().toLowerCase();
}

export function mainTaskPoolItemSearchHaystack(f: TaskLike): string {
  const parts = [
    f.filename || "",
    taskIdFromFilename(f.filename || ""),
    f.subject || "",
  ];
  return parts.join(" ").toLowerCase();
}

export type MainTaskThreadModelLike = {
  id?: string;
  name?: string;
  root?: TaskLike;
  members?: TaskLike[];
};

export function adminThreadModelSearchHaystack(
  m: MainTaskThreadModelLike,
): string {
  const root = m?.root ?? {};
  const parts = [
    root.filename || "",
    taskIdFromFilename(root.filename || "") || String(m?.id || ""),
    root.subject || "",
    m.name || "",
  ];
  return parts.join(" ").toLowerCase();
}

export function adminThreadModelMatchesSearch(
  m: MainTaskThreadModelLike,
  q: string,
): boolean {
  const needle = normalizeMainTaskSearchQ(q);
  if (!needle) return true;
  return adminThreadModelSearchHaystack(m).includes(needle);
}

export function mainTaskSearchMemberIds(
  models: MainTaskThreadModelLike[],
): Set<string> {
  const ids = new Set<string>();
  for (const m of models || []) {
    if (m.id) ids.add(m.id);
    for (const t of m.members || []) {
      const id = taskIdFromFilename(t.filename || "");
      if (id) ids.add(id);
    }
  }
  return ids;
}

/** 主任务搜索：thread 模型命中 + 池内主线直匹配（覆盖 >10 条全池语义） */
export function filterPoolByMainTaskSearch(
  pool: TaskLike[],
  q: string,
  scopedModels: MainTaskThreadModelLike[],
  allTasks: TaskLike[],
): TaskLike[] {
  const needle = normalizeMainTaskSearchQ(q);
  if (!needle) return pool || [];
  const matchModels = (scopedModels || []).filter((m) =>
    adminThreadModelMatchesSearch(m, needle),
  );
  const ids = mainTaskSearchMemberIds(matchModels);
  return (pool || []).filter((f) => {
    const id = taskIdFromFilename(f.filename || "");
    if (id && ids.has(id)) return true;
    if (taskIsDescendantOfVisibleRoot(f, ids, allTasks)) return true;
    if (
      classifyTask(f) === "main" &&
      mainTaskPoolItemSearchHaystack(f).includes(needle)
    ) {
      return true;
    }
    return false;
  });
}

export function formatMainlineCountDisplay(
  matched: number,
  total: number,
  q: string,
): string {
  const needle = normalizeMainTaskSearchQ(q);
  if (!needle || matched === total) return String(matched);
  return `${matched}/${total}`;
}

export type ReportSearchLike = {
  filename?: string;
  subject?: string;
  sender?: string;
  from?: string;
  recipient?: string;
  to?: string;
  preview?: string;
  summary?: string;
};

export function reportMainTaskSearchHaystack(
  r: ReportSearchLike,
  linkedTaskIds: string[] = [],
): string {
  const linked = (linkedTaskIds || []).join(" ");
  const parts = [
    r.filename || "",
    linked,
    taskIdFromFilename(r.filename || ""),
    r.subject || "",
  ];
  return parts.join(" ").toLowerCase();
}

export function reportContentSearchHaystack(
  r: ReportSearchLike,
  linkedTaskIds: string[] = [],
  topic = "",
  summary = "",
): string {
  const fn = String(r.filename || "").toLowerCase();
  const linkedIds = (linkedTaskIds || []).join(" ").toLowerCase();
  const sender = String(r.sender ?? r.from ?? "").toLowerCase();
  const recip = String(r.recipient ?? r.to ?? "").toLowerCase();
  return [fn, linkedIds, topic.toLowerCase(), summary.toLowerCase(), sender, recip].join(
    " ",
  );
}

export function reportUnifiedSearchHaystack(
  r: ReportSearchLike,
  linkedTaskIds: string[] = [],
  topic = "",
  summary = "",
): string {
  return (
    reportMainTaskSearchHaystack(r, linkedTaskIds) +
    " " +
    reportContentSearchHaystack(r, linkedTaskIds, topic, summary)
  );
}

export function reportMatchesThreadModelSearch(
  linkedTaskIds: string[],
  q: string,
  scopedModels: MainTaskThreadModelLike[],
  ledger?: { root_task_id?: string; thread_key?: string } | null,
): boolean {
  const needle = normalizeMainTaskSearchQ(q);
  if (!needle) return true;
  const matchModels = (scopedModels || []).filter((m) =>
    adminThreadModelMatchesSearch(m, needle),
  );
  if (!matchModels.length) return false;
  const memberIds = mainTaskSearchMemberIds(matchModels);
  const rootIds = new Set(matchModels.map((m) => m.id).filter(Boolean));
  const linked = (linkedTaskIds || []).map(
    (x) => taskIdFromFilename(x) || x,
  );
  if (linked.some((id) => memberIds.has(id))) return true;
  if (ledger) {
    const root = taskIdFromFilename(ledger.root_task_id || "");
    if (rootIds.has(root) || memberIds.has(root)) return true;
    const tk = String(ledger.thread_key || "");
    if (matchModels.some((m) => m.id === root || m.id === tk)) return true;
  }
  return false;
}

export type ReportPageArchiveTab = "active" | "archive" | "all";

export function filterReportByRoleTab<T extends ReportSearchLike>(
  items: T[],
  roleTab: string,
): T[] {
  if (!roleTab) return items || [];
  if (roleTab === "PM") {
    return (items || []).filter(
      (r) =>
        /PM-to-ADMIN/i.test(r.filename || "") ||
        /PM/i.test(String(r.sender ?? r.from ?? "")),
    );
  }
  return (items || []).filter((r) =>
    new RegExp(`${roleTab}-to-PM`, "i").test(r.filename || ""),
  );
}

/**
 * 报告页可见池：role tab → active-board hide → unified search。
 * 与 panel inline `renderReportPage` 过滤顺序一致（搜索不扩池）。
 */
export function filterReportPageVisibleItems<T extends ReportSearchLike>(
  pool: T[],
  opts: {
    roleTab: string;
    archiveTab: ReportPageArchiveTab;
    searchQ: string;
    scopedModels: MainTaskThreadModelLike[];
    shouldHideOnActiveBoard: (r: T) => boolean;
    meta: (r: T) => {
      linkedTaskIds: string[];
      topic: string;
      summary: string;
      ledger?: { root_task_id?: string; thread_key?: string } | null;
    };
  },
): { items: T[]; totalBeforeSearch: number } {
  let items = filterReportByRoleTab(pool, opts.roleTab);
  if (opts.archiveTab === "active") {
    items = items.filter((r) => !opts.shouldHideOnActiveBoard(r));
  }
  const totalBeforeSearch = items.length;
  items = applyReportUnifiedSearch(
    items,
    opts.searchQ,
    opts.scopedModels,
    opts.meta,
  );
  return { items, totalBeforeSearch };
}

/** 报告页统一搜索：主线 thread 命中 + 报告字段直匹配 */
export function applyReportUnifiedSearch<T extends ReportSearchLike>(
  items: T[],
  q: string,
  scopedModels: MainTaskThreadModelLike[],
  meta: (r: T) => {
    linkedTaskIds: string[];
    topic: string;
    summary: string;
    ledger?: { root_task_id?: string; thread_key?: string } | null;
  },
): T[] {
  const needle = normalizeMainTaskSearchQ(q);
  if (!needle) return items || [];
  return (items || []).filter((r) => {
    const m = meta(r);
    if (
      reportUnifiedSearchHaystack(
        r,
        m.linkedTaskIds,
        m.topic,
        m.summary,
      ).includes(needle)
    ) {
      return true;
    }
    return reportMatchesThreadModelSearch(
      m.linkedTaskIds,
      needle,
      scopedModels,
      m.ledger,
    );
  });
}

/** thread 模型内 ADMIN 主线数（下拉后缀，通常 1） */
export function countAdminMainlinesForThreadMembers(members: TaskLike[]): number {
  const n = (members || []).filter((t) =>
    isAdminMainline(t.filename || ""),
  ).length;
  return n > 0 ? n : 1;
}

/** 报告页 taskTree / chain 中 ADMIN 主线数（分组 hint，通常 1） */
export function countAdminMainlinesInReportTaskTree(
  taskTree: { task?: TaskLike }[],
): number {
  const n = (taskTree || []).filter((node) => {
    const t = node.task;
    return classifyTask(t ?? { filename: "" }) === "main";
  }).length;
  return n > 0 ? n : 1;
}

/** Alias matching panel inline `countAdminMainlinesInReportChain`. */
export function countAdminMainlinesInReportChain(chain: {
  taskTree?: { task?: TaskLike }[];
}): number {
  return countAdminMainlinesInReportTaskTree(chain?.taskTree ?? []);
}

/** Page filter dropdown: all ADMIN→PM threads, including archived / settled (not team-dynamics gated). */
export function threadEligibleForPageFilter(members: TaskLike[]): boolean {
  if (!members?.length) return false;
  const admin = members.find((m) => isAdminMainline(m.filename || ""));
  if (!admin) return false;
  return String(admin.filename || "").startsWith("TASK-");
}

function isForceArchiveTask(f: TaskLike | null | undefined): boolean {
  if (!f) return false;
  const c = classifyTask(f);
  return c === "force_archive";
}

function taskPathIndicatesHistoryArchive(f: TaskLike): boolean {
  return /[/\\]history[/\\]/i.test(String(f.path ?? ""));
}

/** Workflow sealed: archive / history / force_archive (not done). */
export function taskIsWorkflowSealed(f: TaskLike | null | undefined): boolean {
  if (!f) return false;
  if (physicalScopeFromPath(f) === "archive") return true;
  if (taskPathIndicatesHistoryArchive(f)) return true;
  if (isForceArchiveTask(f)) return true;
  return false;
}

/** Reports archive tab: settled = sealed or done/. */
export function taskIsArchiveTabSettled(f: TaskLike | null | undefined): boolean {
  if (!f) return false;
  if (taskIsWorkflowSealed(f)) return true;
  return physicalScopeFromPath(f) === "done";
}

/** Legacy report groups (non-thread): root task archive/active filter. */
export function reportRootMatchesArchiveTab(
  rootTask: TaskLike | null | undefined,
  tab: TaskTab,
): boolean {
  if (tab === "all") return true;
  if (!rootTask) {
    if (tab === "active") return false;
    return tab === "archive";
  }
  const settled = taskIsArchiveTabSettled(rootTask);
  if (tab === "archive") return settled;
  if (taskIsWorkflowSealed(rootTask)) return false;
  return true;
}

export type LegacyReportGroupLike = {
  task?: TaskLike | null;
  reports?: unknown[];
};

/** Legacy report groups without thread ledger wrapper. */
export function reportLegacyGroupMatchesArchiveTab(
  g: LegacyReportGroupLike,
  tab: TaskTab,
): boolean {
  if (tab === "all") return true;
  if (g.task) return reportRootMatchesArchiveTab(g.task, tab);
  if (tab === "archive") return (g.reports?.length ?? 0) > 0;
  return tab === "active";
}

function isReportThreadRootSealed(
  rootTask: TaskLike | null | undefined,
  rootId: string,
  taskList: TaskLike[],
): boolean {
  const root =
    rootTask ??
    taskList.find((t) => taskIdFromFilename(t.filename ?? "") === rootId) ??
    null;
  if (!root) return false;
  if (physicalScopeFromPath(root) === "archive") return true;
  return isForceArchiveTask(root);
}

function resolveReportThreadMembers(
  row: ThreadRow,
  taskList: TaskLike[],
): TaskLike[] {
  const rootId = taskIdFromFilename(row.root_task_id ?? "");
  const byId = buildTaskByIdMap(taskList);
  const out: TaskLike[] = [];
  const seen = new Set<string>();
  for (const tid of row.task_ids ?? []) {
    const id = taskIdFromFilename(String(tid)) || String(tid).trim();
    const t = byId.get(id);
    if (t && !seen.has(id)) {
      seen.add(id);
      out.push(t);
    }
  }
  if (rootId && byId.has(rootId) && !seen.has(rootId)) {
    out.unshift(byId.get(rootId)!);
  }
  return out;
}

function hasOpenReportThreadTask(members: TaskLike[]): boolean {
  return members.some((m) => {
    if (!String(m.filename ?? "").startsWith("TASK-")) return false;
    if (isForceArchiveTask(m)) return false;
    const scope = physicalScopeFromPath(m);
    if (scope === "archive") return false;
    return scope === "inbox" || scope === "active" || scope === "review";
  });
}

/**
 * Ledger row still names tasks but none resolve in the live task pool (history-only /
 * fully archived). Such threads must not render as active「协作主线」headers.
 */
export function isDetachedLedgerThread(
  row: ThreadRow | null | undefined,
  taskList: TaskLike[],
): boolean {
  if (!row) return false;
  const tk = String(row.thread_key ?? "");
  if (tk.startsWith("_orphan_REPORT")) return true;
  if (tk.startsWith("_orphan_") && !taskIdFromFilename(row.root_task_id ?? "")) {
    return true;
  }
  const hasLedgerTasks = Boolean(
    taskIdFromFilename(row.root_task_id ?? "") ||
      (row.task_ids?.length ?? 0) > 0,
  );
  if (!hasLedgerTasks) return false;
  return resolveReportThreadMembers(row, taskList).length === 0;
}

/** Reports page active tab: hide archive/force roots and empty shells. */
export function shouldShowReportThreadInActive(
  row: ThreadRow,
  visibleReports: unknown[],
  taskList: TaskLike[],
  rootTask?: TaskLike | null,
): boolean {
  const rootId = taskIdFromFilename(row.root_task_id ?? "");
  if (isDetachedLedgerThread(row, taskList)) return false;
  if (isReportThreadRootSealed(rootTask, rootId, taskList)) return false;

  const members = resolveReportThreadMembers(row, taskList).filter((m) => {
    if (isForceArchiveTask(m)) return false;
    return physicalScopeFromPath(m) !== "archive";
  });

  const reportCount = visibleReports.length;
  const hasOpen = hasOpenReportThreadTask(members);
  if (reportCount <= 0 && !hasOpen) return false;
  if (!hasOpen && members.length === 0) return false;
  return true;
}

/** Reports page archive tab: sealed roots or all members settled. */
export function shouldShowReportThreadInArchive(
  row: ThreadRow,
  visibleReports: unknown[],
  taskList: TaskLike[],
  rootTask?: TaskLike | null,
): boolean {
  const rootId = taskIdFromFilename(row.root_task_id ?? "");
  if (isReportThreadRootSealed(rootTask, rootId, taskList)) return true;
  const members = resolveReportThreadMembers(row, taskList);
  if (!members.length && visibleReports.length > 0) return true;
  if (!members.length) return false;
  return members.every((m) => {
    const scope = physicalScopeFromPath(m);
    return scope === "archive" || scope === "done" || isForceArchiveTask(m);
  });
}

export type ReportThreadChainLike = {
  rootId?: string;
  taskTree?: { task?: TaskLike; taskId?: string }[];
  reports?: unknown[];
  reportCount?: number;
};

/** Active tab: task chips / counts use open non-archive tasks only. */
export function filterReportThreadTaskTreeForTab(
  taskTree: { task?: TaskLike; taskId?: string }[],
  tab: TaskTab,
): { task?: TaskLike; taskId?: string }[] {
  if (tab !== "active") return taskTree ?? [];
  return (taskTree ?? []).filter((node) => {
    const t = node.task;
    if (!t) return false;
    if (isForceArchiveTask(t)) return false;
    const scope = physicalScopeFromPath(t);
    if (scope === "archive") return false;
    return scope === "inbox" || scope === "active" || scope === "review";
  });
}

export function countReportThreadTasksForDisplay(
  taskTree: { task?: TaskLike }[],
  tab: TaskTab,
): number {
  const tree =
    tab === "active"
      ? filterReportThreadTaskTreeForTab(taskTree, tab)
      : (taskTree ?? []);
  return tree.filter((n) => String(n.task?.filename ?? "").startsWith("TASK-"))
    .length;
}
