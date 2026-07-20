/**
 * Lifecycle (`_lifecycle/`) tasks that ledger marks `pending_pm_review` while
 * still physically in `active/` — PM Panel approve/reject without requiring
 * a prior manual `submit_review`.
 */

import { basename, join } from "node:path";
import { promises as fs } from "node:fs";

import { toLocalIsoString } from "../_internal/local-iso.ts";
import { LifecycleKernel } from "../lifecycle/LifecycleKernel.ts";
import { resolveDriver } from "../lifecycle/authorityDefaults.ts";
import { TaskFrontmatterStore } from "../lifecycle/TaskFrontmatterStore.ts";
import { findTaskLocationById } from "../lifecycle/taskPathUtils.ts";
import type { LifecycleTransitionResult, TaskFm } from "../lifecycle/types.ts";
import { LedgerBuilder } from "./LedgerBuilder.ts";
import { ReportResolver } from "./ReportResolver.ts";
import { resolveLedgerLayout } from "./paths.ts";
import type { LedgerReportRecord, LedgerThreadRecord } from "./types.ts";

function normalizeTaskId(taskId: string): string {
  const raw = taskId.replace(/\.md$/i, "").trim();
  return /^TASK-\d{8}-\d{3,}/i.exec(raw)?.[0].toUpperCase() ?? raw;
}

function taskMarkdown(
  fm: Record<string, unknown>,
  body = "# Review\n",
): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined || v === null) continue;
    lines.push(`${k}: ${v}`);
  }
  lines.push("---", body);
  return lines.join("\n") + "\n";
}

async function nextReviewSeq(reviewsDir: string, date: string): Promise<string> {
  let max = 0;
  try {
    const names = await fs.readdir(reviewsDir);
    const re = new RegExp(`^REVIEW-${date}-(\\d{3})`, "i");
    for (const name of names) {
      const m = re.exec(name);
      if (m) max = Math.max(max, parseInt(m[1]!, 10));
    }
  } catch {
    /* empty dir */
  }
  return String(max + 1).padStart(3, "0");
}

async function readJsonlLines<T>(filePath: string): Promise<T[]> {
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skip bad line */
    }
  }
  return out;
}

export async function isTaskPendingPmReviewInLedger(
  projectRoot: string,
  taskId: string,
): Promise<boolean> {
  const layout = resolveLedgerLayout(projectRoot);
  const norm = normalizeTaskId(taskId);
  const threads = await readJsonlLines<LedgerThreadRecord>(
    join(layout.ledgerDir, "threads.jsonl"),
  );
  for (const rec of threads) {
    for (const id of rec.pending_pm_review ?? []) {
      if (normalizeTaskId(id) === norm) return true;
    }
  }
  return false;
}

function frontmatterProjectsPmReview(fm: TaskFm): boolean {
  const display = String(fm.display_status ?? "")
    .trim()
    .toLowerCase();
  const projection = String(fm.lifecycle_projection ?? "")
    .trim()
    .toLowerCase();
  return display === "waiting_pm_review" || projection === "review";
}

export async function locateProjectedPmReviewLifecycleTask(
  projectRoot: string,
  taskId: string,
): Promise<{ path: string; filename: string } | null> {
  const layout = resolveLedgerLayout(projectRoot);
  const located = await findTaskLocationById(layout.lifecycleRoot, taskId, {
    hotTasksDir: layout.tasksDir,
  });
  if (!located || located.storage !== "lifecycle") return null;
  if (located.stage === "review") return null;
  if (located.stage !== "active") return null;

  const store = new TaskFrontmatterStore();
  const { fm } = await store.read(located.path);

  const ledgerPending = await isTaskPendingPmReviewInLedger(
    projectRoot,
    taskId,
  );
  if (!frontmatterProjectsPmReview(fm) && !ledgerPending) return null;

  return { path: located.path, filename: located.filename };
}

export async function findDoneReportIdForLifecycleTask(
  projectRoot: string,
  taskId: string,
  driver: string,
): Promise<string | null> {
  const layout = resolveLedgerLayout(projectRoot);
  const norm = normalizeTaskId(taskId);
  const driverUp = driver.toUpperCase();
  const reports = await readJsonlLines<LedgerReportRecord>(
    join(layout.ledgerDir, "reports.jsonl"),
  );

  let best: { id: string; updated: string } | null = null;
  for (const r of reports) {
    const done = r.status === "done" || r.status === "completed";
    if (!done) continue;
    if (r.sender.toUpperCase() !== driverUp) continue;
    if (r.recipient.toUpperCase() !== "PM") continue;

    const refs = new Set<string>();
    if (r.task_id) refs.add(normalizeTaskId(r.task_id));
    if (r.parent_task_id) refs.add(normalizeTaskId(r.parent_task_id));
    for (const id of r.linked_task_ids ?? []) {
      refs.add(normalizeTaskId(id));
    }
    for (const id of r.references ?? []) {
      refs.add(normalizeTaskId(id));
    }
    if (!refs.has(norm)) continue;

    const updated = r.updated_at || r.created_at || "";
    if (!best || updated > best.updated) {
      best = {
        id: r.report_id || basename(r.filename, ".md"),
        updated,
      };
    }
  }
  return best?.id ?? null;
}

export interface ProjectedLifecycleReviewOpts {
  projectRoot: string;
  taskId: string;
  actor: string;
  note?: string;
  reason?: string;
}

async function writeReviewEnvelope(
  layout: ReturnType<typeof resolveLedgerLayout>,
  taskId: string,
  actor: string,
  decision: "approved" | "rejected",
  note: string,
): Promise<void> {
  const now = toLocalIsoString(new Date());
  await fs.mkdir(layout.reviewsDir, { recursive: true });
  const date = now.slice(0, 10).replace(/-/g, "");
  const seq = await nextReviewSeq(layout.reviewsDir, date);
  const reviewFilename = `REVIEW-${date}-${seq}-${actor}-on-${taskId}.md`;
  const reviewPath = join(layout.reviewsDir, reviewFilename);

  const reviewFm: Record<string, unknown> = {
    protocol: "fcop",
    version: 1,
    kind: "review",
    review_id: basename(reviewFilename, ".md"),
    subject_id: taskId,
    subject_type: "task",
    decision,
    reviewer: actor,
    reviewed_at: now,
    task_id: taskId,
    sender: actor,
    recipient: "PM",
    note,
  };

  await fs.writeFile(
    reviewPath,
    taskMarkdown(reviewFm, `# PM review · ${taskId}\n\n${note}\n`),
    "utf-8",
  );
}

async function rebuildLedgerAndSettle(
  projectRoot: string,
  taskId: string,
  layout: ReturnType<typeof resolveLedgerLayout>,
): Promise<void> {
  const builder = new LedgerBuilder({ projectRoot });
  await builder.rebuild();
  const resolver = new ReportResolver({
    projectRoot,
    lifecycleRoot: layout.lifecycleRoot,
  });
  await resolver.reconcileThreadSettlement(taskId);
}

export async function approveProjectedLifecycleTaskReview(
  opts: ProjectedLifecycleReviewOpts,
): Promise<LifecycleTransitionResult> {
  const located = await locateProjectedPmReviewLifecycleTask(
    opts.projectRoot,
    opts.taskId,
  );
  if (!located) {
    throw new Error(`projected lifecycle review task not found: ${opts.taskId}`);
  }

  const actor = (opts.actor || "PM").trim().toUpperCase();
  const layout = resolveLedgerLayout(opts.projectRoot);
  const store = new TaskFrontmatterStore();
  const { fm } = await store.read(located.path);
  const taskId = normalizeTaskId(String(fm.task_id ?? opts.taskId));
  const driver = resolveDriver(fm);
  const reportId = await findDoneReportIdForLifecycleTask(
    opts.projectRoot,
    taskId,
    driver,
  );
  if (!reportId) {
    throw new Error(
      `approve_review denied: no done report from ${driver} for ${taskId}`,
    );
  }

  const kernel = new LifecycleKernel({ lifecycleRoot: layout.lifecycleRoot });

  await kernel.submitReview({
    taskId,
    actor: driver,
    reportId,
  });

  const result = await kernel.approveReview({
    taskId,
    actor,
    ...(opts.note ? { note: opts.note } : {}),
  });

  await writeReviewEnvelope(
    layout,
    taskId,
    actor,
    "approved",
    opts.note ?? "approved",
  );
  await rebuildLedgerAndSettle(opts.projectRoot, taskId, layout);

  return result;
}

export async function rejectProjectedLifecycleTaskReview(
  opts: ProjectedLifecycleReviewOpts,
): Promise<LifecycleTransitionResult> {
  const located = await locateProjectedPmReviewLifecycleTask(
    opts.projectRoot,
    opts.taskId,
  );
  if (!located) {
    throw new Error(`projected lifecycle review task not found: ${opts.taskId}`);
  }

  const actor = (opts.actor || "PM").trim().toUpperCase();
  const reason = opts.reason ?? opts.note ?? "rejected";
  const layout = resolveLedgerLayout(opts.projectRoot);
  const store = new TaskFrontmatterStore();
  const { fm } = await store.read(located.path);
  const taskId = normalizeTaskId(String(fm.task_id ?? opts.taskId));
  const driver = resolveDriver(fm);
  const reportId = await findDoneReportIdForLifecycleTask(
    opts.projectRoot,
    taskId,
    driver,
  );
  if (!reportId) {
    throw new Error(
      `reject_review denied: no done report from ${driver} for ${taskId}`,
    );
  }

  const kernel = new LifecycleKernel({ lifecycleRoot: layout.lifecycleRoot });

  await kernel.submitReview({
    taskId,
    actor: driver,
    reportId,
  });

  const result = await kernel.rejectReview({
    taskId,
    actor,
    reason,
  });

  await writeReviewEnvelope(layout, taskId, actor, "rejected", reason);
  await rebuildLedgerAndSettle(opts.projectRoot, taskId, layout);

  return result;
}
