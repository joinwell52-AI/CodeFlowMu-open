import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { ParsedTask } from "./TaskParser.ts";
import { TaskParser } from "./TaskParser.ts";

/** States that always block dispatch without evaluating depends_on. */
const BLOCKING_STATES = new Set(["staged"]);
const PENDING_DEPENDENCY = "pending_dependency";

export interface DependencyGateResult {
  allowed: boolean;
  reason?: string;
  dependencyTaskIds: string[];
}

function normalizeTaskId(value: string): string {
  return value.trim().replace(/\.md$/i, "");
}

function taskIdKey(value: string): string {
  return normalizeTaskId(value).toUpperCase();
}

/** PM→worker TASK refs in `references` gate dispatch until done REPORT exists. */
export function isDispatchDependencyTaskRef(taskId: string): boolean {
  const norm = normalizeTaskId(taskId);
  if (!/^TASK-/i.test(norm)) return false;
  return /-PM-to-(DEV|QA|OPS|EVAL)(?:\.md)?$/i.test(norm);
}

function listField(fm: Record<string, unknown>, key: string): string[] {
  const v = fm[key];
  if (typeof v === "string") {
    const raw = v.trim();
    if (!raw || raw === "[]" || raw.toLowerCase() === "null") return [];
    const taskIds = raw.match(/TASK-\d{8}-\d{3,}(?:-[A-Za-z0-9]+)*/gi);
    if (taskIds?.length) return [...new Set(taskIds)];
    return [];
  }
  if (!Array.isArray(v)) return [];
  return v
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function referenceTaskIds(task: ParsedTask): string[] {
  return listField(task.frontmatter, "references").map(normalizeTaskId);
}

function parentTaskId(task: ParsedTask): string | undefined {
  const explicit = task.frontmatter["parent"];
  if (typeof explicit === "string" && explicit.trim()) {
    return normalizeTaskId(explicit);
  }
  return referenceTaskIds(task)[0];
}

export function taskHasImplicitDevDependencyReference(
  task: ParsedTask,
): boolean {
  const recipient = String(task.recipient ?? "").trim().toUpperCase();
  if (recipient !== "QA" && recipient !== "OPS") return false;
  const parentKey = parentTaskId(task);
  return referenceTaskIds(task).some(
    (id) => !parentKey || taskIdKey(id) !== taskIdKey(parentKey),
  );
}

export function collectDependencyTaskIds(task: ParsedTask): string[] {
  const ownKey = taskIdKey(task.task_id ?? task.filename);
  const fromReferences = listField(task.frontmatter, "references")
    .map(normalizeTaskId)
    .filter(
      (id) => taskIdKey(id) !== ownKey && isDispatchDependencyTaskRef(id),
    );

  return [
    ...new Set(
      [
        ...(task.depends_on ?? []),
        ...(task.blocked_by ?? []),
        ...fromReferences,
      ]
        .map(normalizeTaskId)
        .filter(Boolean),
    ),
  ];
}

export function taskHasExplicitDependencyControl(task: ParsedTask): boolean {
  const state = String(task.state ?? "").trim().toLowerCase();
  const dispatchState = String(task.dispatch_state ?? "")
    .trim()
    .toLowerCase();
  return (
    BLOCKING_STATES.has(state) ||
    BLOCKING_STATES.has(dispatchState) ||
    state === PENDING_DEPENDENCY ||
    dispatchState === PENDING_DEPENDENCY ||
    collectDependencyTaskIds(task).length > 0
  );
}

async function loadDoneDependencyIds(projectRoot: string): Promise<Set<string>> {
  const reportsDir = join(projectRoot, "fcop", "reports");
  let filenames: string[];
  try {
    filenames = await readdir(reportsDir);
  } catch {
    return new Set();
  }

  const done = new Set<string>();
  await Promise.all(
    filenames
      .filter((filename) => /^REPORT-.*\.md$/i.test(filename))
      .map(async (filename) => {
        try {
          const report = await TaskParser.parse(join(reportsDir, filename));
          const taskId = report.frontmatter["task_id"];
          const status = report.frontmatter["status"];
          if (
            typeof taskId === "string" &&
            typeof status === "string" &&
            status.trim().toLowerCase() === "done"
          ) {
            done.add(taskIdKey(taskId));
          }
        } catch {
          // A malformed report cannot satisfy a dependency.
        }
      }),
  );
  return done;
}

async function findTaskByReference(
  projectRoot: string,
  taskId: string,
): Promise<ParsedTask | undefined> {
  const normalized = normalizeTaskId(taskId);
  const dirs = [
    "inbox",
    "active",
    "review",
    "done",
    "archive",
  ].map((stage) => join(projectRoot, "fcop", "_lifecycle", stage));
  dirs.push(join(projectRoot, "fcop", "tasks"));

  for (const dir of dirs) {
    let filenames: string[];
    try {
      filenames = await readdir(dir);
    } catch {
      continue;
    }
    const filename = filenames.find((name) => {
      const stem = normalizeTaskId(name);
      return (
        taskIdKey(stem) === taskIdKey(normalized) ||
        taskIdKey(stem).startsWith(`${taskIdKey(normalized)}-`)
      );
    });
    if (!filename) continue;
    try {
      return await TaskParser.parse(join(dir, filename));
    } catch {
      // A malformed task cannot establish a dispatch dependency.
    }
  }
  return undefined;
}

async function resolveImplicitDevDependencies(
  task: ParsedTask,
  projectRoot: string | undefined,
): Promise<string[]> {
  if (!projectRoot || !taskHasImplicitDevDependencyReference(task)) return [];

  const parentKey = parentTaskId(task);
  const dependencies: string[] = [];
  for (const reference of referenceTaskIds(task)) {
    if (parentKey && taskIdKey(reference) === taskIdKey(parentKey)) continue;
    const candidate = await findTaskByReference(projectRoot, reference);
    if (!candidate) continue;
    if (String(candidate.sender ?? "").trim().toUpperCase() !== "PM") continue;
    if (String(candidate.recipient ?? "").trim().toUpperCase() !== "DEV") {
      continue;
    }
    const candidateParent = parentTaskId(candidate);
    if (
      parentKey &&
      candidateParent &&
      taskIdKey(candidateParent) !== taskIdKey(parentKey)
    ) {
      continue;
    }
    dependencies.push(
      normalizeTaskId(candidate.task_id ?? candidate.filename),
    );
  }
  return [...new Set(dependencies)];
}

export async function evaluateTaskDependencyGate(
  task: ParsedTask,
  projectRoot: string | undefined,
): Promise<DependencyGateResult> {
  const state = String(task.state ?? "").trim().toLowerCase();
  if (BLOCKING_STATES.has(state)) {
    return {
      allowed: false,
      reason: `state=${state}`,
      dependencyTaskIds: [],
    };
  }

  const dispatchState = String(task.dispatch_state ?? "")
    .trim()
    .toLowerCase();
  if (BLOCKING_STATES.has(dispatchState)) {
    return {
      allowed: false,
      reason: `dispatch_state=${dispatchState}`,
      dependencyTaskIds: [],
    };
  }

  const dependencies = [
    ...new Set([
      ...collectDependencyTaskIds(task),
      ...(await resolveImplicitDevDependencies(task, projectRoot)),
    ]),
  ];
  if (dependencies.length === 0) {
    if (
      state === PENDING_DEPENDENCY ||
      dispatchState === PENDING_DEPENDENCY
    ) {
      return {
        allowed: false,
        reason: "pending_dependency without depends_on/blocked_by/references",
        dependencyTaskIds: [],
      };
    }
    return {
      allowed: true,
      dependencyTaskIds: [],
    };
  }

  const done = projectRoot
    ? await loadDoneDependencyIds(projectRoot)
    : new Set<string>();
  const pending = dependencies.filter((taskId) => !done.has(taskIdKey(taskId)));
  return pending.length > 0
    ? {
        allowed: false,
        reason: `waiting for done report: ${pending.join(", ")}`,
        dependencyTaskIds: pending,
      }
    : {
        allowed: true,
        dependencyTaskIds: dependencies,
      };
}
