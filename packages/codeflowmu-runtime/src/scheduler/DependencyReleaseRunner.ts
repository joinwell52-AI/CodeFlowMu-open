import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolveLedgerLayout } from "../ledger/paths.ts";
import { pmGovernanceCycleJournalPath } from "../pm/PmGovernancePlanner.ts";
import {
  collectDependencyTaskIds,
  evaluateTaskDependencyGate,
  taskHasImplicitDevDependencyReference,
} from "./TaskDependencyGate.ts";
import type { ParsedTask } from "./TaskParser.ts";
import { TaskParser } from "./TaskParser.ts";

export interface ReleasedDependencyTask {
  task_id: string;
  filename: string;
  filepath: string;
  recipient: string;
  dependency_task_ids: string[];
}

export interface ReleasePendingDependencyTasksOpts {
  projectRoot: string;
  /** Flat inbox dirs used in tests or legacy layouts. */
  extraScanDirs?: string[];
  parser?: Pick<TaskParser, "parse">;
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
}

function isDependencyReleaseCandidate(parsed: ParsedTask): boolean {
  const releaseState = String(parsed.frontmatter["dependency_release_state"] ?? "")
    .trim()
    .toLowerCase();
  const deps = collectDependencyTaskIds(parsed);
  if (deps.length === 0 && !taskHasImplicitDevDependencyReference(parsed)) {
    return false;
  }

  const state = String(parsed.state ?? "").trim().toLowerCase();
  const dispatchState = String(parsed.dispatch_state ?? "")
    .trim()
    .toLowerCase();
  const explicitlyRearmed =
    state === "pending_dependency" || dispatchState === "pending_dependency";
  if (releaseState === "released" && !explicitlyRearmed) return false;
  if (state === "dispatched" || state === "running") return false;
  if (dispatchState === "dispatched" || dispatchState === "running") {
    return false;
  }
  if (
    state === "pending_dependency" ||
    dispatchState === "pending_dependency"
  ) {
    return true;
  }
  return state === "inbox" || state === "pending" || !state;
}

/** Patch frontmatter so TaskDispatcher can claim and dispatch the task. */
export function patchTaskDependencyReleaseFrontmatter(raw: string): string {
  const re = /^(---\r?\n)([\s\S]*?)(\r?\n---)/;
  const m = raw.match(re);
  if (!m) return raw;
  const open = m[1] ?? "---\n";
  let yamlBody = m[2] ?? "";
  const close = m[3] ?? "\n---";
  yamlBody = /^state:/m.test(yamlBody)
    ? yamlBody.replace(/^state:.*$/m, "state: inbox")
    : `${yamlBody}\nstate: inbox`;
  yamlBody = /^dispatch_state:/m.test(yamlBody)
    ? yamlBody.replace(/^dispatch_state:.*$/m, "dispatch_state: ready")
    : `${yamlBody}\ndispatch_state: ready`;
  yamlBody = /^dependency_release_state:/m.test(yamlBody)
    ? yamlBody.replace(/^dependency_release_state:.*$/m, "dependency_release_state: released")
    : `${yamlBody}\ndependency_release_state: released`;
  return raw.replace(re, `${open}${yamlBody}${close}`);
}

async function collectTaskFiles(dirs: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isFile() || !/^TASK-.*\.md$/i.test(ent.name)) continue;
      const filepath = join(dir, ent.name);
      const key = filepath.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(filepath);
    }
  }
  return files;
}

/** Append dependency release batch to PM governance cycle journal. */
export async function appendDependencyReleaseCycleEvents(
  projectRoot: string,
  released: ReleasedDependencyTask[],
): Promise<void> {
  if (released.length === 0) return;
  const path = pmGovernanceCycleJournalPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  const line = JSON.stringify({
    event: "dependency_release",
    at: new Date().toISOString(),
    released: released.map((r) => ({
      task_id: r.task_id,
      filename: r.filename,
      dependency_task_ids: r.dependency_task_ids,
    })),
  });
  await appendFile(path, `${line}\n`, "utf-8");
}

/**
 * Scan inbox/active for dependency-satisfied tasks, patch frontmatter to
 * claimable state, and return release signals for the dispatch control plane.
 * Does not dispatch — TaskDispatcher owns the sole emission entry.
 */
export async function releasePendingDependencyTasks(
  opts: ReleasePendingDependencyTasksOpts,
): Promise<ReleasedDependencyTask[]> {
  const parser = opts.parser ?? new TaskParser();
  const layout = resolveLedgerLayout(opts.projectRoot);
  const scanDirs = [
    join(layout.lifecycleRoot, "inbox"),
    join(layout.lifecycleRoot, "active"),
    ...(opts.extraScanDirs ?? []),
  ];

  const released: ReleasedDependencyTask[] = [];
  const filepaths = await collectTaskFiles(scanDirs);
  for (const filepath of filepaths) {
    let parsed: ParsedTask;
    try {
      parsed = await parser.parse(filepath);
    } catch {
      continue;
    }
    if (!isDependencyReleaseCandidate(parsed)) continue;

    const gate = await evaluateTaskDependencyGate(parsed, opts.projectRoot);
    if (!gate.allowed) continue;

    const recipient = parsed.recipient;
    if (!recipient) continue;

    const raw = await readFile(filepath, "utf-8");
    await writeFile(
      filepath,
      patchTaskDependencyReleaseFrontmatter(raw),
      "utf-8",
    );

    const taskId =
      parsed.task_id ?? parsed.filename.replace(/\.md$/i, "");

    opts.logger?.info?.(
      `[DependencyRelease] released ${parsed.filename} (enqueue dispatch signal)`,
    );

    released.push({
      task_id: taskId,
      filename: parsed.filename,
      filepath,
      recipient,
      dependency_task_ids: gate.dependencyTaskIds,
    });
  }
  return released;
}
