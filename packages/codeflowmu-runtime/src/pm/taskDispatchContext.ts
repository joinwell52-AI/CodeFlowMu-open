/**
 * Load thread-scoped tasks/reports for taskDispatchGate evaluation.
 */

import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { readLedgerTasksJsonl, resolveLedgerLayout } from "../ledger/index.ts";
import type { LedgerReportRecord, LedgerTaskRecord } from "../ledger/types.ts";
import {
  extractRecipientFromFilename,
  extractReporterFromReportFilename,
  type DispatchGateReportRef,
  type DispatchGateTaskRef,
} from "./taskDispatchGate.ts";

function normalizeTaskIdPrefix(id: string): string {
  const raw = String(id ?? "").trim();
  if (!raw) return "";
  return raw.replace(/\.md$/i, "").split("-to-")[0] ?? raw;
}

const LIFECYCLE_BUCKETS = ["inbox", "active", "review", "done", "archive"] as const;

function parseFmState(raw: string): string | undefined {
  return raw.match(/^state:\s*(\S+)/m)?.[1];
}

function parseFmField(raw: string, key: string): string | undefined {
  // Keep the match on the current YAML line. `\\s*` also consumes newlines
  // and previously turned a block-list item into the literal value `- TASK-*`.
  const re = new RegExp(`^${key}:[ \\t]*(.+)$`, "m");
  const m = raw.match(re);
  return m?.[1]?.trim().replace(/^["']|["']$/g, "");
}

function parseFmBool(raw: string, key: string): boolean | undefined {
  const v = parseFmField(raw, key);
  if (v === undefined) return undefined;
  return v.toLowerCase() === "true";
}

function parseFmStringList(raw: string, key: string): string[] | undefined {
  const inline = parseFmField(raw, key);
  if (inline && inline !== "[]") {
    if (inline.startsWith("[") && inline.endsWith("]")) {
      return inline
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }
    return [inline];
  }
  const block = raw.match(
    new RegExp(`^${key}:\\s*\\r?\\n((?:\\s+-\\s+.+(?:\\r?\\n|$))+)`, "m"),
  );
  if (!block?.[1]) return inline === "[]" ? [] : undefined;
  return block[1]
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+(.+)$/)?.[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .map((value) => value.replace(/^["']|["']$/g, ""));
}

function mergeDependencyIds(...lists: Array<string[] | undefined>): string[] | undefined {
  const merged = [
    ...new Set(
      lists
        .flatMap((values) => values ?? [])
        .map((value) => value.trim().replace(/\.md$/i, ""))
        .filter(Boolean),
    ),
  ];
  return merged.length > 0 ? merged : undefined;
}

async function readTaskRefFromPath(
  path: string,
  bucket: string,
): Promise<DispatchGateTaskRef | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return null;
  }
  const filename = basename(path);
  const taskId =
    parseFmField(raw, "task_id") ?? filename.replace(/\.md$/i, "");
  return {
    taskId,
    filename,
    recipient:
      parseFmField(raw, "recipient") ??
      extractRecipientFromFilename(filename),
    sender: parseFmField(raw, "sender"),
    threadKey: parseFmField(raw, "thread_key"),
    lifecycleBucket: bucket,
    fmState: parseFmState(raw),
    displayStatus: parseFmField(raw, "display_status"),
    terminatedByParentArchive: parseFmBool(raw, "terminated_by_parent_archive"),
    closedParentResidue: parseFmBool(raw, "closed_parent_residue"),
    parent: parseFmField(raw, "parent"),
    parentTaskId: parseFmField(raw, "parent_task_id"),
    reworkOf: parseFmField(raw, "rework_of"),
    dependsOn: mergeDependencyIds(
      parseFmStringList(raw, "depends_on"),
      parseFmStringList(raw, "blocked_by"),
    ),
  };
}

export async function loadLifecycleTaskRefs(
  lifecycleRoot: string,
): Promise<DispatchGateTaskRef[]> {
  const out: DispatchGateTaskRef[] = [];
  for (const bucket of LIFECYCLE_BUCKETS) {
    const dir = join(lifecycleRoot, bucket);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^TASK-/.test(name)) continue;
      const ref = await readTaskRefFromPath(join(dir, name), bucket);
      if (ref) out.push(ref);
    }
  }
  return out;
}

export function ledgerTaskToGateRef(t: LedgerTaskRecord): DispatchGateTaskRef {
  const yaml = t.yaml ?? {};
  return {
    taskId: t.task_id,
    filename: t.filename ?? `${t.task_id}.md`,
    recipient: t.recipient ?? extractRecipientFromFilename(t.filename ?? ""),
    sender: t.sender,
    threadKey: t.thread_key,
    lifecycleBucket: t.bucket ?? "inbox",
    fmState: typeof yaml.state === "string" ? yaml.state : undefined,
    displayStatus:
      t.display_status ??
      (typeof yaml.display_status === "string"
        ? yaml.display_status
        : undefined),
    terminatedByParentArchive: yaml.terminated_by_parent_archive === true,
    closedParentResidue: yaml.closed_parent_residue === true,
    parent:
      typeof yaml.parent === "string"
        ? yaml.parent
        : typeof t.parent === "string"
          ? t.parent
          : undefined,
    parentTaskId:
      typeof yaml.parent_task_id === "string"
        ? yaml.parent_task_id
        : typeof t.parent_task_id === "string"
          ? t.parent_task_id
          : undefined,
    reworkOf:
      typeof yaml.rework_of === "string" ? yaml.rework_of : undefined,
    dependsOn: mergeDependencyIds(
      Array.isArray(yaml.depends_on)
        ? yaml.depends_on.map(String)
        : typeof yaml.depends_on === "string"
          ? [yaml.depends_on]
          : undefined,
      Array.isArray(yaml.blocked_by)
        ? yaml.blocked_by.map(String)
        : typeof yaml.blocked_by === "string"
          ? [yaml.blocked_by]
          : undefined,
    ),
  };
}

export function ledgerReportToGateRef(r: LedgerReportRecord): DispatchGateReportRef {
  return {
    taskId: r.task_id ?? "",
    reporter: r.sender ?? "",
    status: String(r.status ?? ""),
    threadKey: r.thread_key,
  };
}

function reportRefKey(r: DispatchGateReportRef): string {
  return `${r.taskId}|${r.reporter}|${String(r.status ?? "").toLowerCase()}`;
}

/** Align with TaskDependencyGate: fcop/reports REPORT-*.md frontmatter. */
async function loadFcopDiskReportRefs(
  reportsDir: string,
): Promise<DispatchGateReportRef[]> {
  let filenames: string[];
  try {
    filenames = await readdir(reportsDir);
  } catch {
    return [];
  }
  const out: DispatchGateReportRef[] = [];
  for (const filename of filenames) {
    if (!/^REPORT-.*\.md$/i.test(filename)) continue;
    let raw: string;
    try {
      raw = await readFile(join(reportsDir, filename), "utf-8");
    } catch {
      continue;
    }
    const taskId = parseFmField(raw, "task_id");
    if (!taskId) continue;
    out.push({
      taskId,
      reporter:
        parseFmField(raw, "sender") ??
        parseFmField(raw, "reporter") ??
        extractReporterFromReportFilename(filename),
      status: parseFmField(raw, "status") ?? "",
      threadKey: parseFmField(raw, "thread_key"),
    });
  }
  return out;
}

export async function loadDispatchGateContext(projectRoot: string): Promise<{
  tasks: DispatchGateTaskRef[];
  reports: DispatchGateReportRef[];
}> {
  const layout = resolveLedgerLayout(projectRoot);
  const lifecycleRoot = layout.lifecycleRoot;
  const tasksJsonl = join(layout.ledgerDir, "tasks.jsonl");
  const reportsJsonl = join(layout.ledgerDir, "reports.jsonl");
  const [lifecycleTasks, ledgerTasks] = await Promise.all([
    loadLifecycleTaskRefs(lifecycleRoot),
    readLedgerTasksJsonl(tasksJsonl).catch(() => [] as LedgerTaskRecord[]),
  ]);

  const byFilename = new Map<string, DispatchGateTaskRef>();
  for (const t of ledgerTasks.map(ledgerTaskToGateRef)) {
    byFilename.set(t.filename, t);
  }
  for (const t of lifecycleTasks) {
    byFilename.set(t.filename, t);
  }

  let reportsRaw: LedgerReportRecord[] = [];
  try {
    const raw = await readFile(reportsJsonl, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        reportsRaw.push(JSON.parse(line) as LedgerReportRecord);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no reports jsonl */
  }

  const ledgerReports = reportsRaw.map(ledgerReportToGateRef);
  const diskReports = await loadFcopDiskReportRefs(layout.reportsDir);
  const seen = new Set(ledgerReports.map(reportRefKey));
  const mergedReports = [...ledgerReports];
  for (const r of diskReports) {
    const key = reportRefKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    mergedReports.push(r);
  }

  return {
    tasks: [...byFilename.values()],
    reports: mergedReports,
  };
}

export function filterThreadTasks(
  tasks: DispatchGateTaskRef[],
  threadKey: string | undefined,
): DispatchGateTaskRef[] {
  const key = String(threadKey ?? "").trim();
  if (!key) return tasks;
  return tasks.filter((t) => String(t.threadKey ?? "").trim() === key);
}

export interface ExecutionTaskMeta {
  artifactPath?: string;
  supersededBy?: string;
  cancelled?: boolean;
  cancelReason?: string;
}

export interface ExecutionGateContext {
  tasks: DispatchGateTaskRef[];
  reports: DispatchGateReportRef[];
  taskMeta: Map<string, ExecutionTaskMeta>;
  projectRoot: string;
  artifactExists?: (relPath: string) => boolean;
}

function bodyAfterFrontmatter(raw: string): string {
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return m?.[1] ?? raw;
}

function parseSupersedesTargets(raw: string): string[] {
  const single = parseFmField(raw, "supersedes");
  if (single) return [normalizeTaskIdPrefix(single)];
  const block = raw.match(/^supersedes:\s*\n((?:\s+-\s+.+\n)+)/m);
  if (!block?.[1]) return [];
  return block[1]
    .split("\n")
    .map((line) => line.match(/^\s*-\s+(.+)/)?.[1]?.trim())
    .filter((v): v is string => Boolean(v))
    .map((v) => normalizeTaskIdPrefix(v.replace(/^["']|["']$/g, "")));
}

export function extractArtifactPathFromTaskContent(raw: string): string | undefined {
  const fmPath =
    parseFmField(raw, "artifact_path") ?? parseFmField(raw, "artifact");
  if (fmPath) return normalizeArtifactRelPath(fmPath);
  const body = bodyAfterFrontmatter(raw);
  const patterns = [
    /`((?:games|workspace)\/[a-z0-9][a-z0-9./-]*)/i,
    /(?:^|\s|\()((?:games|workspace)\/[a-z0-9][a-z0-9-]+(?:\/[a-z0-9.-]+)*\/?)/im,
  ];
  for (const re of patterns) {
    const m = body.match(re);
    if (m?.[1]) return normalizeArtifactRelPath(m[1]);
  }
  return undefined;
}

function normalizeArtifactRelPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function ledgerTransitionList(t: LedgerTaskRecord): Array<{ action?: string; reason?: string }> {
  const raw = (t as { transitions?: unknown }).transitions ?? t.yaml?.transitions;
  return Array.isArray(raw) ? (raw as Array<{ action?: string; reason?: string }>) : [];
}

function isCancelledFromLedger(t: LedgerTaskRecord): boolean {
  const yamlFm = (t.yaml ?? {}) as Record<string, unknown>;
  const archiveMode = String(
    (t as { archive_mode?: string }).archive_mode ?? yamlFm.archive_mode ?? "",
  ).toLowerCase();
  const taskType = String(yamlFm.task_type ?? "").toLowerCase();
  if (archiveMode === "force" || taskType === "force_archive") return true;
  for (const tr of ledgerTransitionList(t)) {
    const action = String(tr.action ?? "").toLowerCase();
    if (action === "force_archive_task" || action === "force_archive") return true;
  }
  return false;
}

function isCancelledFromRaw(
  raw: string,
  ref: DispatchGateTaskRef,
): boolean {
  if (String(ref.displayStatus ?? "").toLowerCase() === "cancelled") return true;
  const archiveMode = parseFmField(raw, "archive_mode")?.toLowerCase();
  const taskType = parseFmField(raw, "task_type")?.toLowerCase();
  return archiveMode === "force" || taskType === "force_archive";
}

async function readExecutionMetaFromPath(
  path: string,
  ref: DispatchGateTaskRef,
): Promise<{ id: string; meta: ExecutionTaskMeta; supersedesTargets: string[] }> {
  let raw = "";
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return { id: normalizeTaskIdPrefix(ref.taskId), meta: {}, supersedesTargets: [] };
  }
  const id = normalizeTaskIdPrefix(
    parseFmField(raw, "task_id") ?? ref.taskId ?? basename(path).replace(/\.md$/i, ""),
  );
  return {
    id,
    meta: {
      artifactPath: extractArtifactPathFromTaskContent(raw),
      cancelled: isCancelledFromRaw(raw, ref),
    },
    supersedesTargets: parseSupersedesTargets(raw),
  };
}

export async function loadExecutionGateContext(
  projectRoot: string,
): Promise<ExecutionGateContext> {
  const base = await loadDispatchGateContext(projectRoot);
  const layout = resolveLedgerLayout(projectRoot);
  const lifecycleRoot = layout.lifecycleRoot;
  const taskMeta = new Map<string, ExecutionTaskMeta>();
  const supersededBy = new Map<string, string>();

  for (const bucket of LIFECYCLE_BUCKETS) {
    const dir = join(lifecycleRoot, bucket);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^TASK-/.test(name)) continue;
      const ref = base.tasks.find((t) => t.filename === name);
      if (!ref) continue;
      const { id, meta, supersedesTargets } = await readExecutionMetaFromPath(
        join(dir, name),
        ref,
      );
      taskMeta.set(id, { ...(taskMeta.get(id) ?? {}), ...meta });
      for (const target of supersedesTargets) {
        const key = normalizeTaskIdPrefix(target);
        if (!supersededBy.has(key)) supersededBy.set(key, id);
      }
    }
  }

  const tasksJsonl = join(layout.ledgerDir, "tasks.jsonl");
  const ledgerTasks = await readLedgerTasksJsonl(tasksJsonl).catch(
    () => [] as LedgerTaskRecord[],
  );
  for (const lt of ledgerTasks) {
    const id = normalizeTaskIdPrefix(lt.task_id);
    const prev = taskMeta.get(id) ?? {};
    const yamlFm = (lt.yaml ?? {}) as Record<string, unknown>;
    const supRaw = yamlFm.supersedes;
    const supersedesTargets = Array.isArray(supRaw)
      ? supRaw.map((v) => normalizeTaskIdPrefix(String(v)))
      : typeof supRaw === "string"
        ? [normalizeTaskIdPrefix(supRaw)]
        : [];
    taskMeta.set(id, {
      ...prev,
      cancelled: prev.cancelled === true || isCancelledFromLedger(lt),
      cancelReason:
        prev.cancelReason ??
        (isCancelledFromLedger(lt) ? "ADMIN cancelled / force archive" : undefined),
    });
    for (const target of supersedesTargets) {
      const key = normalizeTaskIdPrefix(target);
      if (!supersededBy.has(key)) supersededBy.set(key, id);
    }
  }

  for (const [targetId, byId] of supersededBy) {
    const prev = taskMeta.get(targetId) ?? {};
    taskMeta.set(targetId, { ...prev, supersededBy: byId });
  }

  return {
    ...base,
    taskMeta,
    projectRoot,
  };
}
