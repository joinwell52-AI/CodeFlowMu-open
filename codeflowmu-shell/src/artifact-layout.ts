import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

export type WorkspaceMode = "root" | "multi";

export interface ArtifactRootResolution {
  mode: WorkspaceMode;
  projectRoot: string;
  artifactRoot: string;
  relativeArtifactRoot: "." | "workspace" | `workspace/${string}`;
  explicit: boolean;
  inferredFrom: "config" | "default-newproject" | "workspace" | "source-root" | "fallback";
  requiresAdminSelection: boolean;
}

const SOURCE_ROOT_MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "src",
  "public",
  "index.html",
];

const PROTECTED_ROOT_NAMES = new Set([
  "fcop",
  ".codeflowmu",
  ".cursor",
  ".fcop",
  "AGENTS.md",
  "CLAUDE.md",
]);

function fcopConfigPath(projectRoot: string): string {
  return join(resolve(projectRoot), "fcop", "fcop.json");
}

function readExplicitMode(projectRoot: string): WorkspaceMode | null {
  const path = fcopConfigPath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    return parsed.workspace_mode === "root" || parsed.workspace_mode === "multi"
      ? parsed.workspace_mode
      : null;
  } catch {
    return null;
  }
}

export function listWorkspaceSlugs(projectRoot: string): string[] {
  const workspace = join(resolve(projectRoot), "workspace");
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) return [];
  return readdirSync(workspace)
    .filter((name) => !name.startsWith("."))
    .filter((name) => {
      const path = join(workspace, name);
      return existsSync(path) && statSync(path).isDirectory();
    })
    .sort((a, b) => a.localeCompare(b));
}

export function inferWorkspaceMode(projectRoot: string): Omit<ArtifactRootResolution, "artifactRoot" | "relativeArtifactRoot"> {
  const root = resolve(projectRoot);
  const explicit = readExplicitMode(root);
  if (explicit) {
    return {
      mode: explicit,
      projectRoot: root,
      explicit: true,
      inferredFrom: "config",
      requiresAdminSelection: false,
    };
  }

  if (basename(root).toLowerCase() === "newproject") {
    return {
      mode: "multi",
      projectRoot: root,
      explicit: false,
      inferredFrom: "default-newproject",
      requiresAdminSelection: false,
    };
  }

  if (listWorkspaceSlugs(root).length > 0) {
    return {
      mode: "multi",
      projectRoot: root,
      explicit: false,
      inferredFrom: "workspace",
      requiresAdminSelection: false,
    };
  }

  if (SOURCE_ROOT_MARKERS.some((name) => existsSync(join(root, name)))) {
    return {
      mode: "root",
      projectRoot: root,
      explicit: false,
      inferredFrom: "source-root",
      requiresAdminSelection: false,
    };
  }

  return {
    mode: "multi",
    projectRoot: root,
    explicit: false,
    inferredFrom: "fallback",
    requiresAdminSelection: true,
  };
}

export function resolveArtifactRoot(projectRoot: string, slug?: string): ArtifactRootResolution {
  const inferred = inferWorkspaceMode(projectRoot);
  if (inferred.mode === "root") {
    return {
      ...inferred,
      artifactRoot: inferred.projectRoot,
      relativeArtifactRoot: ".",
    };
  }
  const normalizedSlug = (slug ?? "").trim();
  const relativeArtifactRoot = normalizedSlug
    ? (`workspace/${normalizedSlug}` as const)
    : ("workspace" as const);
  return {
    ...inferred,
    artifactRoot: normalizedSlug
      ? join(inferred.projectRoot, "workspace", normalizedSlug)
      : join(inferred.projectRoot, "workspace"),
    relativeArtifactRoot,
  };
}

export function writeWorkspaceMode(projectRoot: string, mode: WorkspaceMode): void {
  const path = fcopConfigPath(projectRoot);
  if (!existsSync(path)) {
    throw new Error(`fcop.json not found: ${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  parsed.workspace_mode = mode;
  const temp = `${path}.workspace-mode.tmp`;
  writeFileSync(temp, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
  renameSync(temp, path);
  if (mode === "root") {
    const workspace = join(resolve(projectRoot), "workspace");
    if (existsSync(workspace)) {
      const remaining = readdirSync(workspace).filter((name) => name !== "README.md");
      if (remaining.length === 0) rmSync(workspace, { recursive: true, force: true });
    }
  }
}

export interface WorkspaceMigrationPlan {
  ok: boolean;
  projectRoot: string;
  sourceSlug?: string;
  sourceRoot?: string;
  destinationRoot: string;
  moves: Array<{ from: string; to: string }>;
  conflicts: string[];
  reason?: string;
}

export function planSingleWorkspaceMigration(projectRoot: string): WorkspaceMigrationPlan {
  const root = resolve(projectRoot);
  const slugs = listWorkspaceSlugs(root);
  const base: WorkspaceMigrationPlan = {
    ok: false,
    projectRoot: root,
    destinationRoot: root,
    moves: [],
    conflicts: [],
  };
  if (slugs.length !== 1) {
    return {
      ...base,
      reason: slugs.length === 0
        ? "No internal workspace is available to migrate."
        : "Root migration requires exactly one internal workspace.",
    };
  }
  const sourceSlug = slugs[0]!;
  const sourceRoot = join(root, "workspace", sourceSlug);
  const moves = readdirSync(sourceRoot).map((name) => ({
    from: join(sourceRoot, name),
    to: join(root, name),
  }));
  const conflicts = moves
    .filter(({ to }) => existsSync(to) || PROTECTED_ROOT_NAMES.has(basename(to)))
    .map(({ to }) => relative(root, to) || basename(to));
  return {
    ...base,
    ok: conflicts.length === 0,
    sourceSlug,
    sourceRoot,
    moves,
    conflicts,
    ...(conflicts.length > 0 ? { reason: "Destination contains conflicting or protected paths." } : {}),
  };
}

function activeTaskFiles(projectRoot: string): string[] {
  const roots = [
    join(projectRoot, "fcop", "tasks"),
    join(projectRoot, "fcop", "_lifecycle", "inbox"),
    join(projectRoot, "fcop", "_lifecycle", "active"),
    join(projectRoot, "fcop", "_lifecycle", "review"),
  ];
  const files: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const path = join(root, name);
      if (name.startsWith("TASK-") && name.endsWith(".md") && statSync(path).isFile()) {
        files.push(path);
      }
    }
  }
  return files;
}

export function executeSingleWorkspaceMigration(projectRoot: string): {
  ok: true;
  workspaceMode: "root";
  manifestPath: string;
  moved: number;
  updatedActiveTasks: number;
} {
  const plan = planSingleWorkspaceMigration(projectRoot);
  if (!plan.ok || !plan.sourceRoot || !plan.sourceSlug) {
    throw new Error(plan.reason ?? "Workspace migration preflight failed.");
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = join(plan.projectRoot, ".codeflowmu", "migrations", `workspace-root-${stamp}`);
  const taskBackupRoot = join(backupRoot, "active-tasks");
  mkdirSync(taskBackupRoot, { recursive: true });
  const moved: Array<{ from: string; to: string }> = [];
  const taskBackups: Array<{ path: string; backup: string }> = [];
  let updatedActiveTasks = 0;
  try {
    for (const move of plan.moves) {
      renameSync(move.from, move.to);
      moved.push(move);
    }
    const relativeNeedle = `workspace/${plan.sourceSlug}`;
    const absoluteNeedle = plan.sourceRoot.replace(/\\/g, "/");
    for (const taskPath of activeTaskFiles(plan.projectRoot)) {
      const before = readFileSync(taskPath, "utf-8");
      const after = before
        .split(relativeNeedle).join(".")
        .split(absoluteNeedle).join(plan.projectRoot.replace(/\\/g, "/"));
      if (after === before) continue;
      const backup = join(taskBackupRoot, `${taskBackups.length}-${basename(taskPath)}`);
      copyFileSync(taskPath, backup);
      taskBackups.push({ path: taskPath, backup });
      writeFileSync(taskPath, after, "utf-8");
      updatedActiveTasks += 1;
    }
    writeWorkspaceMode(plan.projectRoot, "root");
    rmSync(plan.sourceRoot, { recursive: true, force: true });
    const workspaceRoot = dirname(plan.sourceRoot);
    const remaining = readdirSync(workspaceRoot).filter((name) => name !== "README.md");
    if (remaining.length === 0) rmSync(workspaceRoot, { recursive: true, force: true });
  } catch (error) {
    for (const task of taskBackups.reverse()) copyFileSync(task.backup, task.path);
    for (const move of moved.reverse()) {
      mkdirSync(dirname(move.from), { recursive: true });
      if (existsSync(move.to)) renameSync(move.to, move.from);
    }
    throw error;
  }
  const manifestPath = join(backupRoot, "migration.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    version: 1,
    migrated_at: new Date().toISOString(),
    project_root: plan.projectRoot,
    source_slug: plan.sourceSlug,
    moves: plan.moves,
    active_task_backups: taskBackups,
    rollback: "Move each 'to' path back to 'from', restore active_task_backups, then set workspace_mode to multi.",
  }, null, 2)}\n`, "utf-8");
  return {
    ok: true,
    workspaceMode: "root",
    manifestPath,
    moved: moved.length,
    updatedActiveTasks,
  };
}
