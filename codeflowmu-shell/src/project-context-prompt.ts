import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve as pathResolve } from "node:path";

import {
  loadProjectRegistry,
  projectsRegistryPath,
  type RegisteredProject,
} from "./project-registry.ts";

export interface DevelopmentProjectContextOptions {
  hostRoot: string;
  activeRoot?: string;
  runtimeDataRoot?: string;
  registryPath?: string;
}

export interface DevelopmentProjectContext {
  hostRoot: string;
  activeRoot: string;
  activeProject: RegisteredProject | null;
  registeredProjects: RegisteredProject[];
  projectsCollectionRoot: string;
  projectsCollectionExists: boolean;
  runtimeDataRoot: string;
  runtimeSlotsRoot: string;
  registryPath: string;
}

function samePath(a: string, b: string): boolean {
  return pathResolve(a).toLowerCase() === pathResolve(b).toLowerCase();
}

function isOpenFallback(project: RegisteredProject): boolean {
  return project.id === "open-default-newproject";
}

/**
 * 读取“开发项目”真实上下文。
 *
 * 注意：~/.codeflowmu/projects 是 Agent 会话与配置槽位，不是开发项目注册表。
 * 开发项目只能来自 projects-registry.json；Open 的 newproject 托底项不计入
 * 正式项目，除非用户另行以普通项目 ID 注册。
 */
export function readDevelopmentProjectContext(
  options: DevelopmentProjectContextOptions,
): DevelopmentProjectContext {
  const hostRoot = pathResolve(options.hostRoot);
  const registryPath = options.registryPath
    ? pathResolve(options.registryPath)
    : projectsRegistryPath();
  const registry = loadProjectRegistry(hostRoot, registryPath);
  const registeredProjects = registry.projects.filter(
    (project) => !isOpenFallback(project),
  );
  const activeRoot = pathResolve(options.activeRoot ?? hostRoot);
  const activeProject =
    registeredProjects.find((project) => samePath(project.root, activeRoot)) ??
    registeredProjects.find(
      (project) => project.id === registry.activeProjectId,
    ) ??
    null;
  const runtimeDataRoot = pathResolve(
    options.runtimeDataRoot ?? join(homedir(), ".codeflowmu"),
  );
  const projectsCollectionRoot = join(hostRoot, "projects");

  return {
    hostRoot,
    activeRoot,
    activeProject,
    registeredProjects,
    projectsCollectionRoot,
    projectsCollectionExists: existsSync(projectsCollectionRoot),
    runtimeDataRoot,
    runtimeSlotsRoot: join(runtimeDataRoot, "projects"),
    registryPath,
  };
}

/** 固定注入 PM 会话，防止把运行时槽位误报为开发项目。 */
export function formatDevelopmentProjectContextBlock(
  options: DevelopmentProjectContextOptions,
): string {
  const context = readDevelopmentProjectContext(options);
  const projectLines =
    context.registeredProjects.length > 0
      ? context.registeredProjects.map(
          (project) =>
            `  - ${project.name}: ${pathResolve(project.root)}${
              context.activeProject?.id === project.id ? "（当前）" : ""
            }`,
        )
      : ["  - （暂无正式注册项目）"];
  const activeName =
    context.activeProject?.name ?? basename(context.activeRoot) ?? "未注册目录";

  return [
    "## CodeFlowMu 项目身份边界（Runtime 事实，禁止自行改写）",
    `- CodeFlowMu 母体应用根：${context.hostRoot}（固定，不因项目切换而改变）`,
    `- 当前开发项目：${activeName} → ${context.activeRoot}`,
    `- 正式项目注册表：${context.registryPath}（列举“已注册/已挂载/当前项目”时的唯一依据）`,
    "- 正式注册项目：",
    ...projectLines,
    `- 新建独立项目集合：${context.projectsCollectionRoot}（${
      context.projectsCollectionExists
        ? "目录已存在"
        : "目录尚未创建；在首个独立项目创建前这是正常状态"
    }）`,
    `- 用户级运行数据：${context.runtimeDataRoot}（不是业务源码仓库）`,
    `- Agent 运行时槽位：${context.runtimeSlotsRoot}（仅存 agents/session/transcript 等；严禁把其子目录统计或描述为开发项目）`,
    "- `newproject` 仅是 Open 版在没有正式项目时的运行托底，不是正式开发项目，也不是空白/试验项目；除非它以普通项目 ID 明确写入正式注册表。",
    "- 旧项目或接手项目可位于任意磁盘路径（如 D:\\OCRCARD、旧 workspace 目录）；是否为开发项目只看正式注册表，不看目录名。",
  ].join("\n");
}
