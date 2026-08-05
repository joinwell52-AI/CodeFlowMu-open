/**
 * Panel 多产品开发根注册表（持久化到用户目录，与具体 fcop 项目根无关）。
 *
 * 路径：%USERPROFILE%/.codeflowmu/instances/<instance_id>/projects-registry.json
 * 测试可通过环境变量 CODEFLOW_PROJECTS_REGISTRY 覆盖。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve as pathResolve } from "node:path";

export interface RegisteredProject {
  id: string;
  name: string;
  root: string;
}

export interface ProjectRegistrySnapshot {
  version: 1;
  activeProjectId: string;
  projects: RegisteredProject[];
}

export interface LoadProjectRegistryResult {
  activeProjectId: string;
  projects: RegisteredProject[];
  loadedFromDisk: boolean;
  registryStatus: "loaded" | "missing" | "invalid";
  requestedActiveProjectId: string;
}

export function projectsRegistryPath(): string {
  const override = process.env["CODEFLOW_PROJECTS_REGISTRY"]?.trim();
  if (override) return pathResolve(override);
  const instanceId = process.env["CODEFLOWMU_RUNTIME_INSTANCE_ID"]
    ?.trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-");
  if (instanceId) {
    return pathResolve(
      homedir(),
      ".codeflowmu",
      "instances",
      instanceId,
      "projects-registry.json",
    );
  }
  return pathResolve(homedir(), ".codeflowmu", "v2", "projects-registry.json");
}

function defaultDisplayName(root: string): string {
  const base = basename(pathResolve(root));
  return base && base !== "." ? base : "codeflowmu";
}

function normalizeProjects(
  raw: unknown,
  _bootstrapRoot: string,
): RegisteredProject[] {
  const out: RegisteredProject[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    const root =
      typeof rec.root === "string" ? pathResolve(rec.root.trim()) : "";
    if (!id || !name || !root) continue;
    out.push({ id, name, root });
  }
  return out;
}

function pickActiveProjectId(
  projects: RegisteredProject[],
  preferred: string,
  bootstrapRoot: string,
): string {
  const byId = new Map(projects.map((p) => [p.id, p]));
  if (
    preferred &&
    byId.has(preferred) &&
    existsSync(byId.get(preferred)!.root)
  ) {
    return preferred;
  }
  if (byId.has("default") && existsSync(byId.get("default")!.root)) {
    return "default";
  }
  for (const p of projects) {
    if (existsSync(p.root)) return p.id;
  }
  return "default";
}

export function loadProjectRegistry(
  bootstrapRoot: string,
  registryPath = projectsRegistryPath(),
): LoadProjectRegistryResult {
  const bootstrap = pathResolve(bootstrapRoot);
  if (!existsSync(registryPath)) {
    return {
      activeProjectId: "default",
      projects: [
        {
          id: "default",
          name: defaultDisplayName(bootstrap),
          root: bootstrap,
        },
      ],
      loadedFromDisk: false,
      registryStatus: "missing",
      requestedActiveProjectId: "default",
    };
  }
  try {
    const parsed = JSON.parse(
      readFileSync(registryPath, "utf-8"),
    ) as Record<string, unknown>;
    let projects = normalizeProjects(parsed.projects, bootstrap);
    if (projects.length === 0) {
      projects = [
        {
          id: "default",
          name: defaultDisplayName(bootstrap),
          root: bootstrap,
        },
      ];
    }
    const preferred =
      typeof parsed.activeProjectId === "string"
        ? parsed.activeProjectId.trim()
        : "default";
    const activeProjectId = pickActiveProjectId(
      projects,
      preferred,
      bootstrap,
    );
    return {
      activeProjectId,
      projects,
      loadedFromDisk: true,
      registryStatus: "loaded",
      requestedActiveProjectId: preferred,
    };
  } catch {
    return {
      activeProjectId: "default",
      projects: [
        {
          id: "default",
          name: defaultDisplayName(bootstrap),
          root: bootstrap,
        },
      ],
      loadedFromDisk: false,
      registryStatus: "invalid",
      requestedActiveProjectId: "default",
    };
  }
}

/**
 * Resolve the persisted Panel active project for Shell startup.
 *
 * The Panel registry is the single source of truth for multi-project mode.
 * Runtime construction must use the same root; otherwise Cursor cwd, MCP
 * FCOP_PROJECT_DIR and filesystem watchers remain bound to the bootstrap repo.
 */
export function resolveActiveProjectRoot(
  bootstrapRoot: string,
  registryPath = projectsRegistryPath(),
): string {
  const bootstrap = pathResolve(bootstrapRoot);
  const registry = loadProjectRegistry(bootstrap, registryPath);
  const active = registry.projects.find(
    (project) => project.id === registry.activeProjectId,
  );
  return active && existsSync(active.root)
    ? pathResolve(active.root)
    : bootstrap;
}

export interface RuntimeStartupProjectRootOptions {
  explicitProjectRoot?: string | null;
  instanceProjectRoot?: string | null;
  discoveredBootstrapRoot?: string | null;
  openEditionBootstrapRoot?: string | null;
  globalBootstrapRoot?: string | null;
  registryPath?: string;
  /** True only when registryPath belongs to the validated local Runtime instance. */
  registryBelongsToRuntimeInstance?: boolean;
}

export type RuntimeStartupProjectRootSource =
  | "explicit_project_root"
  | "instance_registry_active"
  | "instance_project_root"
  | "discovered_bootstrap_root"
  | "open_edition_bootstrap_root"
  | "global_bootstrap_root"
  | "unresolved";

export interface RuntimeStartupProjectRootDiagnostic {
  code:
    | "EXPLICIT_PROJECT_ROOT_MISSING"
    | "INSTANCE_REGISTRY_NOT_OWNED"
    | "INSTANCE_REGISTRY_MISSING"
    | "INSTANCE_REGISTRY_INVALID"
    | "ACTIVE_PROJECT_NOT_REGISTERED"
    | "ACTIVE_PROJECT_ROOT_MISSING"
    | "OPEN_INSTALL_ROOT_REJECTED";
  message: string;
  registryPath?: string;
  activeProjectId?: string;
  activeProjectRoot?: string;
}

export interface RuntimeStartupProjectRootResolution {
  root: string | null;
  source: RuntimeStartupProjectRootSource;
  activeProjectId: string | null;
  diagnostics: RuntimeStartupProjectRootDiagnostic[];
}

function existingRoot(value?: string | null): string | null {
  if (!value?.trim()) return null;
  const resolved = pathResolve(value);
  return existsSync(resolved) ? resolved : null;
}

export function ensureOpenEditionDefaultProjectRoot(hostRoot: string): string {
  const root = pathResolve(hostRoot, "projects", "newproject");
  mkdirSync(root, { recursive: true });
  return root;
}

export function enforceOpenEditionStartupProjectBoundary(
  resolution: RuntimeStartupProjectRootResolution,
  hostRoot: string,
  defaultProjectRoot: string,
): RuntimeStartupProjectRootResolution {
  const protectedHostRoot = pathResolve(hostRoot);
  const fallbackRoot = pathResolve(defaultProjectRoot);
  const resolvedRoot = resolution.root ? pathResolve(resolution.root) : null;
  if (resolvedRoot && resolvedRoot.toLowerCase() !== protectedHostRoot.toLowerCase()) {
    return resolution;
  }
  return {
    root: fallbackRoot,
    source: "open_edition_bootstrap_root",
    activeProjectId: null,
    diagnostics: resolvedRoot
      ? [
          ...resolution.diagnostics,
          {
            code: "OPEN_INSTALL_ROOT_REJECTED",
            message:
              `Open edition install root cannot be used as a development project: ${protectedHostRoot}; ` +
              `using ${fallbackRoot}`,
            activeProjectRoot: protectedHostRoot,
          },
        ]
      : resolution.diagnostics,
  };
}

/**
 * Resolve startup root with an auditable source and safe fallback diagnostics.
 * A persisted registry may override instance.project_root only after the host
 * has proved that registry belongs to the same local Runtime instance.
 */
export function resolveRuntimeStartupProjectRootDetailed(
  options: RuntimeStartupProjectRootOptions,
): RuntimeStartupProjectRootResolution {
  const diagnostics: RuntimeStartupProjectRootDiagnostic[] = [];
  const explicit = existingRoot(options.explicitProjectRoot);
  if (explicit) {
    return {
      root: explicit,
      source: "explicit_project_root",
      activeProjectId: null,
      diagnostics,
    };
  }
  if (options.explicitProjectRoot?.trim()) {
    diagnostics.push({
      code: "EXPLICIT_PROJECT_ROOT_MISSING",
      message: `Explicit project root does not exist: ${pathResolve(options.explicitProjectRoot)}`,
      activeProjectRoot: pathResolve(options.explicitProjectRoot),
    });
  }

  const registryPath = options.registryPath
    ? pathResolve(options.registryPath)
    : undefined;
  if (registryPath && options.registryBelongsToRuntimeInstance === true) {
    const bootstrap =
      options.instanceProjectRoot ??
      options.discoveredBootstrapRoot ??
      options.openEditionBootstrapRoot ??
      options.globalBootstrapRoot ??
      process.cwd();
    const registry = loadProjectRegistry(bootstrap, registryPath);
    if (registry.registryStatus === "missing") {
      diagnostics.push({
        code: "INSTANCE_REGISTRY_MISSING",
        message: `Runtime instance project registry is missing: ${registryPath}`,
        registryPath,
      });
    } else if (registry.registryStatus === "invalid") {
      diagnostics.push({
        code: "INSTANCE_REGISTRY_INVALID",
        message: `Runtime instance project registry is invalid: ${registryPath}`,
        registryPath,
      });
    } else {
      const requestedId = registry.requestedActiveProjectId;
      const active = registry.projects.find((project) => project.id === requestedId);
      if (!active) {
        diagnostics.push({
          code: "ACTIVE_PROJECT_NOT_REGISTERED",
          message: `Active project ${requestedId} is not present in ${registryPath}`,
          registryPath,
          activeProjectId: requestedId,
        });
      } else if (!existsSync(active.root)) {
        diagnostics.push({
          code: "ACTIVE_PROJECT_ROOT_MISSING",
          message: `Active project root no longer exists: ${active.root}`,
          registryPath,
          activeProjectId: requestedId,
          activeProjectRoot: pathResolve(active.root),
        });
      } else {
        return {
          root: pathResolve(active.root),
          source: "instance_registry_active",
          activeProjectId: requestedId,
          diagnostics,
        };
      }
    }
  } else if (registryPath) {
    diagnostics.push({
      code: "INSTANCE_REGISTRY_NOT_OWNED",
      message: `Ignoring project registry that is not owned by the current Runtime instance: ${registryPath}`,
      registryPath,
    });
  }

  const fallbacks: Array<{
    value?: string | null;
    source: RuntimeStartupProjectRootSource;
  }> = [
    { value: options.instanceProjectRoot, source: "instance_project_root" },
    { value: options.discoveredBootstrapRoot, source: "discovered_bootstrap_root" },
    { value: options.openEditionBootstrapRoot, source: "open_edition_bootstrap_root" },
    { value: options.globalBootstrapRoot, source: "global_bootstrap_root" },
  ];
  for (const fallback of fallbacks) {
    const root = existingRoot(fallback.value);
    if (root) {
      return { root, source: fallback.source, activeProjectId: null, diagnostics };
    }
  }
  return { root: null, source: "unresolved", activeProjectId: null, diagnostics };
}

/**
 * Resolve the one project root used to construct Runtime during Shell startup.
 *
 * Priority: explicit CLI root -> local instance root -> current code markers ->
 * Open bootstrap -> per-instance/global registry fallback.
 */
export function resolveRuntimeStartupProjectRoot(
  options: RuntimeStartupProjectRootOptions,
): string | null {
  return resolveRuntimeStartupProjectRootDetailed(options).root;
}

export interface RuntimeProjectBindingPlan {
  activeProjectRoot: string;
  workspaceRoot: string;
  runtimeProjectRoot: string;
  mcpProjectRoot: string;
  mcpCwd: string;
  fcopProjectDir: string;
  reportWatcherRoot: string;
  lifecycleWatcherRoot: string;
  cursorDefaultCwd: string;
}

export function buildRuntimeProjectBindingPlan(
  activeProjectRoot: string,
): RuntimeProjectBindingPlan {
  const root = pathResolve(activeProjectRoot);
  return {
    activeProjectRoot: root,
    workspaceRoot: root,
    runtimeProjectRoot: root,
    mcpProjectRoot: root,
    mcpCwd: root,
    fcopProjectDir: root,
    reportWatcherRoot: root,
    lifecycleWatcherRoot: root,
    cursorDefaultCwd: root,
  };
}

export interface RuntimeProjectBindingConsistency {
  ok: boolean;
  code: "ACTIVE_PROJECT_BINDING_OK" | "ACTIVE_PROJECT_BINDING_MISMATCH";
  expectedRoot: string;
  mismatches: Array<{ binding: string; actual: string | null }>;
}

export function diagnoseRuntimeProjectBinding(input: {
  expectedRoot: string;
  instanceProjectRoot?: string | null;
  writerLockProjectRoot?: string | null;
  plan: RuntimeProjectBindingPlan;
}): RuntimeProjectBindingConsistency {
  const expectedRoot = pathResolve(input.expectedRoot);
  const values: Array<[string, string | null | undefined]> = [
    ["instance.project_root", input.instanceProjectRoot],
    ["runtime.lock.project_root", input.writerLockProjectRoot],
    ["Runtime workspaceRoot", input.plan.workspaceRoot],
    ["Runtime projectRoot", input.plan.runtimeProjectRoot],
    ["MCP FCOP_PROJECT_DIR", input.plan.mcpProjectRoot],
    ["MCP cwd", input.plan.mcpCwd],
    ["report-watcher root", input.plan.reportWatcherRoot],
    ["lifecycle watcher root", input.plan.lifecycleWatcherRoot],
    ["Cursor defaultCwd", input.plan.cursorDefaultCwd],
  ];
  const normalize = (value: string): string => {
    const resolved = pathResolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const expectedIdentity = normalize(expectedRoot);
  const mismatches = values
    .filter(([, value]) => !value || normalize(value) !== expectedIdentity)
    .map(([binding, value]) => ({
      binding,
      actual: value ? pathResolve(value) : null,
    }));
  return {
    ok: mismatches.length === 0,
    code: mismatches.length === 0
      ? "ACTIVE_PROJECT_BINDING_OK"
      : "ACTIVE_PROJECT_BINDING_MISMATCH",
    expectedRoot,
    mismatches,
  };
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    renameSync(tempPath, filePath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export function saveProjectRegistry(
  activeProjectId: string,
  projects: RegisteredProject[],
  registryPath = projectsRegistryPath(),
): void {
  const snapshot: ProjectRegistrySnapshot = {
    version: 1,
    activeProjectId,
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      root: pathResolve(p.root),
    })),
  };
  writeJsonAtomic(registryPath, snapshot);
}
