/**
 * CodeFlowMu 生命周期工具语义名 ↔ Runtime / fcop-mcp 映射。
 *
 * P1 Runtime 硬拦截：submit/approve/reject/reopen/archive/finish 走
 * CodeFlowMu LifecycleStateMachine，不再转发 fcop-mcp 子进程。
 *
 * injectLifecycleToolAliases 仍为 tools/list 注入语义别名（submit_review 等）。
 */

import type { LifecycleRuntimeAction } from "./lifecycle-runtime-bridge.js";

/** 语义名 → fcop-mcp canonical（仅 tools/list 展示；tools/call 已走 runtime） */
export const LIFECYCLE_TOOL_ALIASES: Readonly<Record<string, string>> = {
  submit_review: "submit_task",
  approve_review: "approve_task",
  reject_review: "reject_task",
};

/** tools/call 由 CodeFlowMu Runtime 拦截的工具名 → StateMachine 动作 */
export const LIFECYCLE_RUNTIME_TOOLS: Readonly<
  Record<string, LifecycleRuntimeAction>
> = {
  submit_review: "submit_review",
  submit_task: "submit_review",
  approve_review: "approve_review",
  approve_task: "approve_review",
  reject_review: "reject_review",
  reject_task: "reject_review",
  reopen_task: "reopen_task",
  archive_task: "archive_task",
  finish_task: "finish_task",
};

const CANONICAL_TO_ALIASES: Readonly<Record<string, readonly string[]>> =
  (() => {
    const m: Record<string, string[]> = {};
    for (const [alias, canonical] of Object.entries(LIFECYCLE_TOOL_ALIASES)) {
      (m[canonical] ??= []).push(alias);
    }
    return m;
  })();

export type LifecycleToolCallResolution =
  | { kind: "runtime"; action: LifecycleRuntimeAction; name: string }
  | { kind: "forward"; name: string }
  | { kind: "unimplemented"; name: string; message: string };

export function resolveLifecycleToolCall(
  name: string,
): LifecycleToolCallResolution {
  const runtimeAction = LIFECYCLE_RUNTIME_TOOLS[name];
  if (runtimeAction) {
    return { kind: "runtime", action: runtimeAction, name };
  }
  const canonical = LIFECYCLE_TOOL_ALIASES[name];
  if (canonical) {
    return { kind: "forward", name: canonical };
  }
  return { kind: "forward", name };
}

function lifecyclePeerNames(toolName: string): readonly string[] {
  const peers = new Set<string>([toolName]);
  const runtimeAction = LIFECYCLE_RUNTIME_TOOLS[toolName];
  if (runtimeAction) {
    for (const [n, a] of Object.entries(LIFECYCLE_RUNTIME_TOOLS)) {
      if (a === runtimeAction) peers.add(n);
    }
  }
  const canonical = LIFECYCLE_TOOL_ALIASES[toolName];
  if (canonical) {
    peers.add(canonical);
    for (const alias of CANONICAL_TO_ALIASES[canonical] ?? []) {
      peers.add(alias);
    }
  }
  for (const alias of CANONICAL_TO_ALIASES[toolName] ?? []) {
    peers.add(alias);
  }
  return [...peers];
}

/** tools/list 白名单：语义名与 canonical / runtime 对等名互为等效 */
export function isLifecycleToolAllowed(
  toolName: string,
  allowed: ReadonlySet<string>,
): boolean {
  for (const peer of lifecyclePeerNames(toolName)) {
    if (allowed.has(peer)) return true;
  }
  return false;
}

export type McpToolDescriptor = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  [key: string]: unknown;
};

/** 为已暴露的 canonical 工具复制语义别名条目（便于 Agent 按 SKILL 名调用） */
export function injectLifecycleToolAliases(
  tools: McpToolDescriptor[],
): McpToolDescriptor[] {
  const names = new Set(tools.map((t) => t.name));
  const out: McpToolDescriptor[] = [...tools];

  for (const [alias, canonical] of Object.entries(LIFECYCLE_TOOL_ALIASES)) {
    if (names.has(canonical) && !names.has(alias)) {
      const src = tools.find((t) => t.name === canonical);
      if (!src) continue;
      const suffix = `（CodeFlowMu 语义名，Runtime 拦截，等同 ${canonical}）`;
      const desc = src.description ?? "";
      out.push({
        ...src,
        name: alias,
        description: desc.includes(canonical) ? desc : `${desc} ${suffix}`.trim(),
      });
      names.add(alias);
    }
  }
  return out;
}
