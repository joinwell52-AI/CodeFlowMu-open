/**
 * fcop/logs — CodeFlowMu 历史数据资产根目录（与 FCoP 钦定 fcop/log/ 单数归档区分）
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const FCOP_LOGS_SEGMENTS = {
  thinking: "thinking",
  usage: "usage",
  analytics: "analytics",
  runtime: "runtime",
  panelApi: "panel-api",
} as const;

export const ROOT_README_VERSION = "collab-assets-v2";

export const ROOT_README = `# fcop/logs — CodeFlowMu 协作数据资产

<!-- fcop-logs-readme-version: ${ROOT_README_VERSION} -->

本目录存放 **Agent 运行时遥测与可分析历史**，供面板、日志中心、用量统计与离线分析使用。

> 注意：FCoP 协议钦定的 **\`fcop/log/\`（单数）** 是任务/协作归档桶；本目录 **\`fcop/logs/\`（复数）** 是 CodeFlowMu 扩展，语义不同，勿混删。

## 九类协作数据资产

| # | 资产 | 路径 / 形态 | 说明 |
|---|------|-------------|------|
| 1 | **任务** | \`_lifecycle/TASK-*.md\` | FCoP 生命周期任务 IPC |
| 2 | **报告** | \`REPORT-*.md\`（与 TASK 同生命周期目录） | 任务回执 |
| 3 | **日志** | \`fcop/logs/runtime\`、\`analytics\`、\`usage\`、\`panel-api\` | 运维 / 分析 / 用量 / 面板 API 遥测；\`actions-*.jsonl\` 为 Review 动作证据链 |
| 4 | **门铃** | 内存 DoorbellBuffer + **冷存储写入 runtime JSONL** | 调度证据链；无独立 \`doorbell/\` 目录 |
| 5 | **聊天** | \`fcop/chat/chat-YYYYMMDD.jsonl\` | 面板 Direct Chat（兼容旧 \`chat.jsonl\`） |
| 6 | **思考流** | \`fcop/logs/thinking/chat|task/thinking-YYYYMMDD.jsonl\` | SDK thinking / tool 轨迹 |
| 7 | **附件** | \`fcop/attachments/YYYYMMDD/\` | 聊天与任务图片等 |
| 8 | **统计** | 从 \`analytics\` / \`usage\` / \`runtime\` **派生** | 不另建独立真相源 |
| 9 | **涌现** | \`fcop/internal/eval\`、\`fcop/internal/emergence-log\`、ADR / \`.fcop/proposals\` | 团队内部档案与协议演化 |

## 本目录结构（日志类子集）

\`\`\`
fcop/logs/
├── README.md
├── thinking/
│   ├── chat/     thinking-YYYYMMDD.jsonl
│   └── task/     thinking-YYYYMMDD.jsonl
├── usage/        usage-YYYYMMDD.jsonl
├── analytics/    events-YYYYMMDD.jsonl
├── runtime/
│   ├── runtime-events-YYYYMMDD.jsonl   （兼容旧 runtime-events.jsonl）
│   ├── actions-YYYYMMDD.jsonl          （Action Evidence Log，Review 证据链）
│   └── commands/                       （command.run 大输出 stdout/stderr 引用）
└── panel-api/    panel-api-YYYYMMDD.jsonl
\`\`\`

## 写入约定

- 所有 append-only 资产使用 **JSONL**，按 **自然日** 切文件（\`YYYYMMDD\`）。
- **新写入**走按日文件；**历史单文件**（如 \`runtime-events.jsonl\`、\`chat.jsonl\`）保留只读兼容，不做强制迁移。

## API

- \`GET /api/v2/analytics/query\` / \`summary\`
- \`GET /api/v2/log-center/query\`
- \`GET /api/v2/thinking/files\`

## 迁移说明

v0.3+ 起写入路径由 \`.codeflowmu/analytics\`、\`.codeflowmu/events\` 迁至 \`fcop/logs/\`。
查询仍会**只读**旧路径中的历史 JSONL，避免断档。
`;

/** 自然日键 YYYYMMDD（UTC，与 thinking / usage 一致） */
export function logsDateKey(d = new Date()): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export function fcopLogsRoot(projectRoot: string): string {
  return join(projectRoot, "fcop", "logs");
}

export function fcopLogsAnalyticsDir(projectRoot: string): string {
  return join(fcopLogsRoot(projectRoot), FCOP_LOGS_SEGMENTS.analytics);
}

export function fcopLogsRuntimeDir(projectRoot: string): string {
  return join(fcopLogsRoot(projectRoot), FCOP_LOGS_SEGMENTS.runtime);
}

export const LEGACY_RUNTIME_EVENTS_MONO = "runtime-events.jsonl";

/** 当日（或指定日）runtime 写入路径 */
export function fcopLogsRuntimeEventsPath(projectRoot: string, dateKey?: string): string {
  const key = dateKey ?? logsDateKey();
  return join(fcopLogsRuntimeDir(projectRoot), `runtime-events-${key}.jsonl`);
}

export function fcopLogsRuntimeEventsLegacyMonolithPath(projectRoot: string): string {
  return join(fcopLogsRuntimeDir(projectRoot), LEGACY_RUNTIME_EVENTS_MONO);
}

/** @deprecated v0.3 前分析账本位置，仅用于只读回退 */
export function legacyAnalyticsDir(projectRoot: string): string {
  return join(projectRoot, ".codeflowmu", "analytics");
}

/** @deprecated v0.3 前 runtime 事件位置，仅用于只读回退 */
export function legacyRuntimeEventsPath(projectRoot: string): string {
  return join(projectRoot, ".codeflowmu", "events", "runtime-events.jsonl");
}

/**
 * 读取用路径列表：按日文件（新 → 旧）、legacy 单文件、.codeflowmu 旧路径。
 */
export function listRuntimeEventsReadPaths(projectRoot: string): string[] {
  const paths: string[] = [];
  const dir = fcopLogsRuntimeDir(projectRoot);
  try {
    const daily = readdirSync(dir)
      .filter((f) => /^runtime-events-\d{8}\.jsonl$/.test(f))
      .sort((a, b) => b.localeCompare(a))
      .map((f) => join(dir, f));
    paths.push(...daily);
  } catch {
    /* dir may not exist */
  }
  const mono = fcopLogsRuntimeEventsLegacyMonolithPath(projectRoot);
  if (existsSync(mono) && !paths.includes(mono)) paths.push(mono);
  const legacy = legacyRuntimeEventsPath(projectRoot);
  if (existsSync(legacy) && !paths.includes(legacy)) paths.push(legacy);
  return paths;
}

/** 解析用于读取的 runtime 文件：优先最新按日文件，否则 legacy */
export function resolveRuntimeEventsReadPath(projectRoot: string): string {
  const paths = listRuntimeEventsReadPaths(projectRoot);
  if (paths.length > 0) return paths[0]!;
  return fcopLogsRuntimeEventsPath(projectRoot);
}

/** 创建 fcop/logs 及子目录，写入根 README（幂等） */
export function ensureFcopLogsAssetLayout(projectRoot: string): string {
  const root = fcopLogsRoot(projectRoot);
  const dirs = [
    root,
    join(root, FCOP_LOGS_SEGMENTS.thinking, "chat"),
    join(root, FCOP_LOGS_SEGMENTS.thinking, "task"),
    join(root, FCOP_LOGS_SEGMENTS.usage),
    fcopLogsAnalyticsDir(projectRoot),
    fcopLogsRuntimeDir(projectRoot),
    join(fcopLogsRuntimeDir(projectRoot), "commands"),
    join(root, FCOP_LOGS_SEGMENTS.panelApi),
  ];
  for (const d of dirs) {
    try {
      mkdirSync(d, { recursive: true });
    } catch {
      /* best-effort */
    }
  }
  try {
    const readme = join(root, "README.md");
    const shouldWrite =
      !existsSync(readme) ||
      !readFileContainsVersion(readme, ROOT_README_VERSION);
    if (shouldWrite) {
      writeFileSync(readme, ROOT_README, "utf-8");
    }
  } catch {
    /* best-effort */
  }
  migrateLegacyLogsAssets(projectRoot);
  return root;
}

function readFileContainsVersion(readmePath: string, version: string): boolean {
  try {
    const text = readFileSync(readmePath, "utf-8");
    return text.includes(`fcop-logs-readme-version: ${version}`);
  } catch {
    return false;
  }
}

/**
 * 一次性复制旧路径历史 JSONL 到 fcop/logs（不删除源文件，避免断档）。
 * runtime 复制目标仍为 legacy 单文件，与按日新写入并存。
 */
export function migrateLegacyLogsAssets(projectRoot: string): void {
  try {
    const runtimeTarget = fcopLogsRuntimeEventsLegacyMonolithPath(projectRoot);
    const runtimeLegacy = legacyRuntimeEventsPath(projectRoot);
    if (!existsSync(runtimeTarget) && existsSync(runtimeLegacy)) {
      mkdirSync(fcopLogsRuntimeDir(projectRoot), { recursive: true });
      copyFileSync(runtimeLegacy, runtimeTarget);
    }

    const analyticsTarget = fcopLogsAnalyticsDir(projectRoot);
    const analyticsLegacy = legacyAnalyticsDir(projectRoot);
    if (existsSync(analyticsLegacy)) {
      mkdirSync(analyticsTarget, { recursive: true });
      for (const name of readdirSync(analyticsLegacy)) {
        if (!name.endsWith(".jsonl")) continue;
        const dest = join(analyticsTarget, name);
        if (existsSync(dest)) continue;
        copyFileSync(join(analyticsLegacy, name), dest);
      }
    }

    const panelApiTarget = join(fcopLogsRoot(projectRoot), FCOP_LOGS_SEGMENTS.panelApi);
    const panelApiLegacy = join(projectRoot, ".codeflowmu", "logs");
    if (existsSync(panelApiLegacy)) {
      mkdirSync(panelApiTarget, { recursive: true });
      for (const name of readdirSync(panelApiLegacy)) {
        if (!name.startsWith("panel-api-") || !name.endsWith(".jsonl")) continue;
        const dest = join(panelApiTarget, name);
        if (existsSync(dest)) continue;
        copyFileSync(join(panelApiLegacy, name), dest);
      }
    }
  } catch {
    /* best-effort */
  }
}
