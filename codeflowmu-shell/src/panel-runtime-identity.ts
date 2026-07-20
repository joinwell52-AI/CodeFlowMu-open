/**
 * Panel runtime identity — provider + send-time wire + 账单观测。
 *
 * - 「设置页」= team.json / .env 配置意图
 * - 「wire」= registry model.id → SDK send 参数（路由别名，如 default）
 * - 「账单观测」= sdk.result.modelUsage（计费明细，非身份问答正文）
 * - Cursor SDK 下「你是什么模型」= **Composer**（与 SDK 思考流自述一致），不是 wire 字符串
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CodeflowProvider = "cursor";

export interface RuntimeSendWire {
  /** SessionManager → spec.modelId（agents.json protocol.model.id） */
  registryModelId: string;
  /** adapter.send: spec.modelId ?? adapterDefault（与 CursorSdkAdapter.send 一致） */
  wireModelId: string | null;
  /** 经 provider 解析后写入 SDK/CLI 的值 */
  resolvedWire: string;
  wireExplanation: string;
  /** 若按当前配置 send 会直接失败 */
  sendBlockedReason?: string;
}

export interface LastObservedModels {
  models: string[];
  observedAt?: string;
  source: "usage-jsonl" | "none";
}

export interface PanelRuntimeIdentity {
  provider: CodeflowProvider;
  providerLabel: string;
  agentId: string;
  role?: string;
  teamModelId: string;
  send: RuntimeSendWire;
  lastObserved: LastObservedModels;
  mismatchNote?: string;
}

export interface RuntimeIdentityOverrides {
  /** 优先于 team.json / agents.json（来自 runtime.registry.get） */
  registryModelId?: string;
}

const PROVIDER_LABELS: Record<CodeflowProvider, string> = {
  cursor: "Cursor SDK",
};

const ENV_KEYS = [
  "CODEFLOW_PROVIDER",
  "CURSOR_DEFAULT_MODEL",
  "CODEFLOW_DATA_DIR",
] as const;

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function expandHome(path: string): string {
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  if (path === "~") return homedir();
  return path;
}

/** 合并磁盘 .env 与当前进程 env（shell 已 loadConfig 时以 process.env 为准）。 */
export function readPanelRuntimeEnv(projectRoot: string): Record<string, string> {
  const out: Record<string, string> = {};
  const envPath = join(projectRoot, ".env");
  if (existsSync(envPath)) {
    for (const rawLine of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      if (!ENV_KEYS.includes(key as (typeof ENV_KEYS)[number])) continue;
      out[key] = unquoteEnvValue(line.slice(eq + 1).trim());
    }
  }
  for (const key of ENV_KEYS) {
    const live = process.env[key];
    if (typeof live === "string" && live.trim()) {
      out[key] = live.trim();
    }
  }
  return out;
}

function normalizeProvider(_raw: string | undefined): CodeflowProvider {
  return "cursor";
}

function projectSlug(projectRoot: string): string {
  return (
    projectRoot
      .split(/[\\/]/)
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z0-9-]/g, "-") ?? "default"
  );
}

/** ~/.codeflowmu/projects/<slug>/agents.json（与 main.ts 隔离策略一致） */
export function resolveAgentsJsonPath(projectRoot: string): string | null {
  const env = readPanelRuntimeEnv(projectRoot);
  const explicit = env["CODEFLOW_DATA_DIR"]?.trim();
  const dataDir = explicit
    ? expandHome(explicit)
    : join(homedir(), ".codeflowmu", "projects", projectSlug(projectRoot));
  const p = join(dataDir, "agents.json");
  return existsSync(p) ? p : null;
}

function readTeamMember(
  projectRoot: string,
  agentId: string,
): { role?: string; modelId: string } {
  const teamPath = join(projectRoot, "codeflowmu.team.json");
  if (!existsSync(teamPath)) {
    return { modelId: "default" };
  }
  try {
    const team = JSON.parse(readFileSync(teamPath, "utf-8")) as {
      members?: { agent_id: string; role?: string; model?: { id?: string } }[];
    };
    const member = team.members?.find((m) => m.agent_id === agentId);
    return {
      role: member?.role,
      modelId: member?.model?.id?.trim() || "default",
    };
  } catch {
    return { modelId: "default" };
  }
}

export function readRegistryModelId(
  projectRoot: string,
  agentId: string,
): string | undefined {
  const agentsPath = resolveAgentsJsonPath(projectRoot);
  if (!agentsPath) return undefined;
  try {
    const records = JSON.parse(readFileSync(agentsPath, "utf-8")) as Array<{
      protocol?: { agent_id?: string; model?: { id?: string } };
    }>;
    if (!Array.isArray(records)) return undefined;
    const rec = records.find((r) => r.protocol?.agent_id === agentId);
    const id = rec?.protocol?.model?.id?.trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

function isOpaqueCursorRoute(id: string): boolean {
  return id === "default" || id === "auto";
}

/** Resolve the public Cursor SDK send-time model wire. */
export function resolveRuntimeSendWire(
  _provider: CodeflowProvider,
  registryModelId: string,
  env: Record<string, string>,
): RuntimeSendWire {
  const registry = registryModelId.trim() || "default";
  const adapterDefault = env["CURSOR_DEFAULT_MODEL"]?.trim();
  const wireModelId =
    registry !== "default" && registry !== ""
      ? registry
      : adapterDefault?.trim() || registry;
  const wire = wireModelId?.trim() || null;
  if (!wire) {
    return {
      registryModelId: registry,
      wireModelId: null,
      resolvedWire: "(未指定)",
      wireExplanation: "Cursor 按账号默认路由；实际模型见 sdk.result.modelUsage",
    };
  }
  return {
    registryModelId: registry,
    wireModelId: wire,
    resolvedWire: wire,
    wireExplanation: isOpaqueCursorRoute(wire)
      ? `Cursor 路由别名 ${wire}；实际模型见 sdk.result.modelUsage`
      : `Agent.resume({ model: { id: "${wire}" } })`,
  };
}

function extractModelUsageKeys(payload: Record<string, unknown>): string[] {
  const raw = payload["raw"] as Record<string, unknown> | undefined;
  const modelUsage = raw?.["modelUsage"] as Record<string, unknown> | undefined;
  if (modelUsage && typeof modelUsage === "object") {
    return Object.keys(modelUsage).filter(Boolean);
  }
  const direct = payload["modelUsage"] as Record<string, unknown> | undefined;
  if (direct && typeof direct === "object") {
    return Object.keys(direct).filter(Boolean);
  }
  return [];
}

/** 从 fcop/logs/usage/usage-*.jsonl 读取该 agent 最近一次 sdk.result 观测到的计费模型。 */
export function readLastObservedModels(
  projectRoot: string,
  agentId: string,
): LastObservedModels {
  const dir = join(projectRoot, "fcop", "logs", "usage");
  if (!existsSync(dir)) {
    return { models: [], source: "none" };
  }

  const files = readdirSync(dir)
    .filter((f) => f.startsWith("usage-") && f.endsWith(".jsonl"))
    .sort()
    .reverse();

  for (const file of files) {
    const lines = readFileSync(join(dir, file), "utf-8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let rec: {
        at?: string;
        agent_id?: string;
        payload?: Record<string, unknown>;
      };
      try {
        rec = JSON.parse(lines[i]!) as typeof rec;
      } catch {
        continue;
      }
      if (rec.agent_id !== agentId) continue;
      const models = extractModelUsageKeys(rec.payload ?? {});
      const concrete = models.filter((m) => !isOpaqueCursorRoute(m));
      const picked = concrete.length > 0 ? concrete : models;
      if (picked.length > 0) {
        return {
          models: picked,
          observedAt: rec.at,
          source: "usage-jsonl",
        };
      }
    }
  }

  return { models: [], source: "none" };
}

function buildMismatchNote(
  provider: CodeflowProvider,
  teamModelId: string,
  registryModelId: string,
  send: RuntimeSendWire,
): string | undefined {
  const notes: string[] = [];
  if (teamModelId !== registryModelId && registryModelId) {
    notes.push(
      `team.json model.id=${teamModelId} 与 agents.json registry=${registryModelId} 不一致（send 以 registry 为准）`,
    );
  }
  if (send.sendBlockedReason) {
    notes.push(send.sendBlockedReason);
  }
  return notes.length ? notes.join("；") : undefined;
}

export function buildPanelRuntimeIdentity(
  projectRoot: string,
  agentId: string,
  overrides?: RuntimeIdentityOverrides,
): PanelRuntimeIdentity {
  const env = readPanelRuntimeEnv(projectRoot);
  const provider = normalizeProvider(env["CODEFLOW_PROVIDER"]);
  const { role, modelId: teamModelId } = readTeamMember(projectRoot, agentId);
  const registryModelId =
    overrides?.registryModelId?.trim() ||
    readRegistryModelId(projectRoot, agentId) ||
    teamModelId;
  const send = resolveRuntimeSendWire(provider, registryModelId, env);
  const lastObserved = readLastObservedModels(projectRoot, agentId);
  const mismatchNote = buildMismatchNote(
    provider,
    teamModelId,
    registryModelId,
    send,
  );

  return {
    provider,
    providerLabel: PROVIDER_LABELS[provider],
    agentId,
    role,
    teamModelId,
    send,
    lastObserved,
    mismatchNote,
  };
}

/** Markdown block injected into ADMIN↔PM 快速聊天 prompt. */
export function formatPanelRuntimeIdentityBlock(
  projectRoot: string | undefined,
  agentId: string,
  overrides?: RuntimeIdentityOverrides,
): string {
  if (!projectRoot) return "";

  const id = buildPanelRuntimeIdentity(projectRoot, agentId, overrides);
  const lines = [
    "## 运行身份 · **思考流即真相**（禁止编造）",
    `- 角色：**${id.agentId}**${id.role ? `（${id.role}）` : ""} · 通道：**${id.providerLabel}**`,
    "",
    "**当 ADMIN 问「你是什么模型 / 你是谁 / 真实对接的模型」时：**",
    "1. **唯一真相源** = 你本轮 **sdk.thinking（LIVE 思考流）** 里关于模型/身份的自我认知原文（Cursor 下通常为**英文**，保持原样即可）；",
    "2. **正式聊天回复** = 把该段 thinking **忠实翻译成简体中文**，不得改写含义、不得另起炉灶；",
    "3. **禁止**用 team.json、send wire、`default`、registry、modelUsage、设置页等配置/账单字段替代或覆盖思考流作答。",
    "",
    "（下列仅供 ADMIN **明确**问对接参数/账单/wire 时引用，**不得**用于身份/模型问答）",
    `- send wire：${id.send.resolvedWire}`,
    `- team.model.id：${id.teamModelId}`,
  ];

  if (id.lastObserved.models.length > 0) {
    const when = id.lastObserved.observedAt
      ? `（${id.lastObserved.observedAt}）`
      : "";
    lines.push(
      `- 最近 modelUsage${when}：${id.lastObserved.models.join("、")}`,
    );
  }

  if (id.mismatchNote) {
    lines.push(`- ⚠️ 配置风险：${id.mismatchNote}`);
  }

  return lines.join("\n");
}
