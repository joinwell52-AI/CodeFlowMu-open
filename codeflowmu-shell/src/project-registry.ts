/**
 * Panel 多产品开发根注册表（持久化到用户目录，与具体 fcop 项目根无关）。
 *
 * 路径：%USERPROFILE%/.codeflowmu/v2/projects-registry.json
 * 测试可通过环境变量 CODEFLOW_PROJECTS_REGISTRY 覆盖。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
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
}

export function projectsRegistryPath(): string {
  const override = process.env["CODEFLOW_PROJECTS_REGISTRY"]?.trim();
  if (override) return pathResolve(override);
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
    return { activeProjectId, projects, loadedFromDisk: true };
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

/**
 * Resolve the one project root used to construct Runtime during Shell startup.
 * Open edition supplies an install-time bootstrap root, but the persisted
 * active project remains authoritative after a Panel project switch.
 */
export function resolveRuntimeStartupProjectRoot(
  openEditionBootstrapRoot: string | null,
  discoveredBootstrapRoot: string | null,
  registryPath = projectsRegistryPath(),
): string | null {
  const bootstrapRoot = openEditionBootstrapRoot ?? discoveredBootstrapRoot;
  return bootstrapRoot
    ? resolveActiveProjectRoot(bootstrapRoot, registryPath)
    : null;
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
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
}
