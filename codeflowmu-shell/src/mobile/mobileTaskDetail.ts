import { basename } from "node:path";

import { mobileUiText, type MobileUiLang } from "./mobileUiLocale.ts";

type MobileCloseout = {
  pm_final_report?: Record<string, unknown> | null;
  eval_observation?: Record<string, unknown> | null;
};

export type MobileTaskActionId =
  | "nudge"
  | "unstick"
  | "approve"
  | "reject"
  | "archive"
  | "back";

export type MobileTaskAction = {
  id: MobileTaskActionId;
  label: string;
  enabled: boolean;
  disabled_reason?: string;
};

export type MobileFlowNode = {
  id: string;
  kind: "start" | "task" | "report" | "gate";
  title: string;
  sender?: string;
  recipient?: string;
  status?: string;
  time?: string;
  filename?: string;
  ref_kind?: "task" | "report" | "approval";
};

const TASK_FILENAME_RE =
  /^TASK-(\d{8})-(\d{3})-([A-Z][A-Z0-9_-]*)-to-([A-Z][A-Z0-9_.-]*)(?:\.md)?$/i;

export function normalizedTaskId(value: unknown): string {
  return String(value ?? "")
    .replace(/\.md$/i, "")
    .trim();
}

function sameTaskIdentity(a: unknown, b: unknown): boolean {
  const left = normalizedTaskId(a).toUpperCase();
  const right = normalizedTaskId(b).toUpperCase();
  if (!left || !right) return false;
  const leftCanonical = /^TASK-\d{8}-\d{3,}/i.exec(left)?.[0] ?? left;
  const rightCanonical = /^TASK-\d{8}-\d{3,}/i.exec(right)?.[0] ?? right;
  return leftCanonical === rightCanonical;
}

export function parseTaskFilename(filename: string): {
  date: string;
  seq: string;
  sender: string;
  recipient: string;
} | null {
  const base = basename(String(filename ?? ""));
  const m = base.match(TASK_FILENAME_RE);
  if (!m) return null;
  return {
    date: m[1] ?? "",
    seq: m[2] ?? "",
    sender: (m[3] ?? "").toUpperCase(),
    recipient: (m[4] ?? "").toUpperCase(),
  };
}

export function taskRoleCode(value: unknown): string {
  const code = String(value ?? "")
    .trim()
    .toUpperCase();
  if (!code || code === "—" || code === "-") return "";
  const dot = code.indexOf(".");
  return dot >= 0 ? code.slice(0, dot) : code;
}

export function taskRecipientCode(row: Record<string, unknown>): string {
  const fromFields = taskRoleCode(row.recipient ?? row.to);
  if (fromFields) return fromFields;
  const parsed = parseTaskFilename(String(row.filename ?? row.task_id ?? ""));
  if (!parsed) return "";
  const recipient = parsed.recipient;
  const dot = recipient.indexOf(".");
  return dot >= 0 ? recipient.slice(0, dot) : recipient;
}

export function taskSenderCode(row: Record<string, unknown>): string {
  const fromFields = taskRoleCode(row.sender ?? row.from);
  if (fromFields) return fromFields;
  const parsed = parseTaskFilename(String(row.filename ?? row.task_id ?? ""));
  return parsed?.sender ?? "";
}

export function isArchivedBucket(bucket: unknown): boolean {
  const b = String(bucket ?? "").toLowerCase();
  return b === "archive" || b === "archived";
}

export function taskMatchesRecipientFilter(
  row: Record<string, unknown>,
  recipient: string,
): boolean {
  const want = taskRoleCode(recipient);
  if (!want) return true;
  return taskRecipientCode(row) === want;
}

export function taskSortKey(row: Record<string, unknown>): string {
  const updated = String(row.updated_at ?? row.mtime ?? "").trim();
  if (updated) return updated;
  const created = String(row.created_at ?? row.ctime ?? "").trim();
  if (created) return created;
  const parsed = parseTaskFilename(String(row.filename ?? row.task_id ?? ""));
  if (parsed) return `${parsed.date}T${parsed.seq}`;
  return String(row.filename ?? "");
}

export function sortTasksNewestFirst<T extends Record<string, unknown>>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => taskSortKey(b).localeCompare(taskSortKey(a)));
}

export function filterTasksForRecipient(
  tasks: Record<string, unknown>[],
  recipient: string | undefined,
): Record<string, unknown>[] {
  let rows = tasks;
  if (recipient) {
    rows = rows.filter((row) => taskMatchesRecipientFilter(row, recipient));
  }
  return sortTasksNewestFirst(rows);
}

export function rowLinksTask(
  row: Record<string, unknown>,
  taskId: string,
  threadKey?: string,
): boolean {
  const norm = normalizedTaskId(taskId);
  if (!norm) return false;
  const rowId = normalizedTaskId(row.task_id ?? row.filename);
  if (rowId === norm) return true;
  const parent = normalizedTaskId(row.parent ?? row.parent_task_id);
  if (parent === norm) return true;
  const source = normalizedTaskId(row.source_task_id);
  if (source === norm) return true;
  const related = row.related ?? row.linked_task_ids ?? row.references;
  if (Array.isArray(related) && related.some((id) => normalizedTaskId(id) === norm)) {
    return true;
  }
  if (threadKey) {
    const rowThread = String(row.thread_key ?? "").trim();
    if (rowThread && rowThread === threadKey) return true;
  }
  return false;
}

export function isAdminToPmTask(row: Record<string, unknown>): boolean {
  return taskSenderCode(row) === "ADMIN" && taskRecipientCode(row) === "PM";
}

export function findChildTasksForParent(
  parent: Record<string, unknown>,
  allTasks: Record<string, unknown>[],
): Record<string, unknown>[] {
  const parentId = normalizedTaskId(parent.task_id ?? parent.filename);
  const threadKey = String(parent.thread_key ?? "").trim();
  const children = allTasks.filter((row) => {
    const rowId = normalizedTaskId(row.task_id ?? row.filename);
    if (sameTaskIdentity(rowId, parentId)) return false;

    const explicitParent = normalizedTaskId(row.parent ?? row.parent_task_id);
    if (sameTaskIdentity(explicitParent, parentId)) return true;

    if (taskSenderCode(row) !== "PM") return false;
    const recip = taskRecipientCode(row);
    if (recip !== "DEV" && recip !== "QA" && recip !== "OPS") return false;
    if (explicitParent && !sameTaskIdentity(explicitParent, parentId)) return false;
    if (!threadKey) return false;
    const rowThread = String(row.thread_key ?? "").trim();
    return rowThread === threadKey;
  });
  return sortTasksNewestFirst(children);
}

function formatTimeField(value: unknown): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function slimFlowTask(row: Record<string, unknown>) {
  const fn = String(row.filename ?? row.task_id ?? "");
  return {
    filename: fn,
    task_id: normalizedTaskId(row.task_id ?? fn),
    title: String(row.title ?? row.subject ?? fn),
    sender: taskSenderCode(row) || "—",
    recipient: taskRecipientCode(row) || "—",
    status: String(row.status ?? row.bucket ?? row.display_status ?? "—").toLowerCase(),
    bucket: String(row.bucket ?? row.stage ?? "—"),
    updated_at: String(row.updated_at ?? row.mtime ?? ""),
    created_at: String(row.created_at ?? row.ctime ?? ""),
  };
}

export function buildFlowOverview(
  parent: Record<string, unknown>,
  childTasks: Record<string, unknown>[],
  closeout: MobileCloseout | null,
  lang: MobileUiLang = "zh",
): MobileFlowNode[] {
  const l = (zh: string, en: string) => mobileUiText(lang, zh, en);
  const nodes: MobileFlowNode[] = [
    {
      id: "start",
      kind: "start",
      title: l("开始", "Start"),
      status: "done",
    },
  ];
  const parentFn = String(parent.filename ?? parent.task_id ?? "");
  nodes.push({
    id: parentFn,
    kind: "task",
    title: String(parent.title ?? parent.subject ?? parentFn),
    sender: taskSenderCode(parent),
    recipient: taskRecipientCode(parent),
    status: String(parent.status ?? parent.bucket ?? "").toLowerCase(),
    time: formatTimeField(parent.updated_at ?? parent.created_at),
    filename: parentFn,
    ref_kind: "task",
  });
  for (const child of childTasks) {
    const fn = String(child.filename ?? child.task_id ?? "");
    nodes.push({
      id: fn,
      kind: "task",
      title: String(child.title ?? child.subject ?? fn),
      sender: taskSenderCode(child),
      recipient: taskRecipientCode(child),
      status: String(child.status ?? child.bucket ?? "").toLowerCase(),
      time: formatTimeField(child.updated_at ?? child.created_at),
      filename: fn,
      ref_kind: "task",
    });
  }
  const pmFinal = closeout?.pm_final_report;
  if (pmFinal?.filename) {
    nodes.push({
      id: String(pmFinal.filename),
      kind: "report",
      title: l("PM → ADMIN 最终报告", "PM → ADMIN final report"),
      sender: "PM",
      recipient: "ADMIN",
      status: String(pmFinal.status ?? "done").toLowerCase(),
      time: undefined,
      filename: String(pmFinal.filename),
      ref_kind: "report",
    });
  }
  const evalObs = closeout?.eval_observation as Record<string, unknown> | null | undefined;
  if (evalObs) {
    const gateId = String(evalObs.filename ?? evalObs.report_id ?? "approval-gate");
    nodes.push({
      id: gateId,
      kind: "gate",
      title: l("审批 GATE", "Approval gate"),
      sender: "ADMIN",
      recipient: "PM",
      status: String(evalObs.status ?? "pending").toLowerCase(),
      time: formatTimeField(evalObs.updated_at ?? evalObs.created_at),
      filename: gateId,
      ref_kind: "approval",
    });
  }
  return nodes;
}

export function buildAvailableTaskActions(
  task: Record<string, unknown>,
  options?: { panelPort?: number; childTasks?: Record<string, unknown>[]; lang?: MobileUiLang },
): MobileTaskAction[] {
  const lang = options?.lang ?? "zh";
  const l = (zh: string, en: string) => mobileUiText(lang, zh, en);
  const bucket = String(task.bucket ?? task.stage ?? "").toLowerCase();
  const status = String(task.status ?? task.display_status ?? "").toLowerCase();
  const panelReady = typeof options?.panelPort === "number" && options.panelPort > 0;
  const panelReason = panelReady ? undefined : l("PC 面板未就绪，无法执行治理操作", "The PC panel is unavailable; governance actions cannot run.");
  const actions: MobileTaskAction[] = [];

  const isActive =
    bucket === "active" ||
    bucket === "running" ||
    status === "active" ||
    status === "running" ||
    status === "doing";

  if (isActive) {
    actions.push({
      id: "nudge",
      label: l("催办", "Nudge"),
      enabled: panelReady,
      disabled_reason: panelReason,
    });
    actions.push({
      id: "unstick",
      label: l("一键解除卡死", "Resolve stuck state"),
      enabled: panelReady,
      disabled_reason: panelReason,
    });
  }

  const isReview = bucket === "review" || status === "review" || status === "pending";
  if (isReview) {
    actions.push({ id: "approve", label: l("审批通过", "Approve"), enabled: true });
    actions.push({ id: "reject", label: l("打回", "Reject"), enabled: true });
  }

  if (bucket === "done" || status === "done" || status === "completed") {
    const openChildren = isAdminToPmTask(task)
      ? openChildTasksBlockingArchive(options?.childTasks ?? [])
      : [];
    actions.push({
      id: "archive",
      label: l("归档", "Archive"),
      enabled: openChildren.length === 0,
      disabled_reason: openChildren.length
        ? l(`不能归档：仍有 ${openChildren.length} 个子任务未收口`, `Cannot archive: ${openChildren.length} child task(s) remain open.`)
        : undefined,
    });
  }

  actions.push({ id: "back", label: l("返回", "Back"), enabled: true });
  return actions;
}

function childTaskLifecycleScope(task: Record<string, unknown>): string {
  return String(
    task.bucket ?? task.scope ?? task.stage ?? task._state ?? "",
  ).toLowerCase();
}

function childTaskLifecycleStatus(task: Record<string, unknown>): string {
  return String(task.display_status ?? task.status ?? "").toLowerCase();
}

function childTaskBlocksParentArchive(task: Record<string, unknown>): boolean {
  const scope = childTaskLifecycleScope(task);
  const status = childTaskLifecycleStatus(task);
  if (scope === "archive" || status === "archive" || status === "archived") return false;
  if (
    scope === "done" ||
    status === "done" ||
    status === "completed" ||
    status === "human_review_approved" ||
    status === "auto_review_approved"
  ) {
    return ["blocked", "failed", "waiting_rework", "waiting_pm_rework"].includes(status);
  }
  if (["inbox", "active", "review", "running"].includes(scope)) return true;
  return ["inbox", "active", "review", "running", "pending"].includes(status);
}

export function openChildTasksBlockingArchive(
  children: Record<string, unknown>[],
): Record<string, unknown>[] {
  return children.filter(childTaskBlocksParentArchive);
}

export async function proxyPanelPost(
  panelPort: number | undefined,
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  if (!panelPort) {
    return { ok: false, status: 503, body: { error: "PANEL_PORT_UNAVAILABLE" } };
  }
  const url = `http://127.0.0.1:${panelPort}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

export function slimChildTasks(rows: Record<string, unknown>[]) {
  return rows.map(slimFlowTask);
}
