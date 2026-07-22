#!/usr/bin/env node
/**
 * fcop-mcp-filter.ts — MCP 协议层工具过滤代理
 *
 * 作用：以 stdio MCP 服务器的形式运行，将 fcop-mcp 封装为一个代理，
 * 根据 FCOP_ALLOWED_TOOLS 环境变量过滤 tools/list 响应中的工具定义。
 *
 * 工作原理（JSON-RPC 2.0 / MCP 协议）：
 *   Cursor SDK → fcop-mcp-filter (此文件) → python -m fcop_mcp
 *
 *   1. Cursor SDK 发起 tools/list 请求
 *   2. 代理转发给 fcop_mcp 子进程
 *   3. fcop_mcp 返回全部 45 个工具
 *   4. 代理过滤，只保留 FCOP_ALLOWED_TOOLS 白名单中的工具
 *   5. 过滤后的响应返回给 Cursor SDK
 *
 * 对 tools/call：生命周期工具（submit_review / approve_review / …）由
 * CodeFlowMu Runtime StateMachine 本地执行；其余工具转发 fcop-mcp。
 *
 * 环境变量：
 *   FCOP_ALLOWED_TOOLS  逗号分隔的工具名白名单，空字符串=透明（不过滤）
 *   FCOP_PYTHON_BIN     Python 解释器路径（默认 python）
 *   FCOP_PROJECT_DIR    fcop-mcp 项目目录（转发给子进程）
 *   PYTHONPATH          继承给子进程
 *
 * 启动方式（在 sdk-factory.ts 的 mcpServers 配置中）：
 *   command: tsxBin,
 *   args: [filterScriptPath],
 *   env: { FCOP_ALLOWED_TOOLS: 'write_report,write_issue,...', ... }
 *   注意：CodeFlowMu 执行层热路径不注入 claim_task（治理动作，仅可选异步）。
 *
 * Token 节省示例（4-agent 团队）：
 *   无过滤: 4 × 19,320 = 77,280 tokens
 *   有过滤: 12,000 (PM) + 3 × 3,000 (DEV/QA/OPS) = 21,000 tokens
 *   节省: ≈ 73%
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  injectLifecycleToolAliases,
  isLifecycleToolAllowed,
  resolveLifecycleToolCall,
} from "./fcop-lifecycle-tool-aliases.js";
import { executeLifecycleRuntimeAction } from "./lifecycle-runtime-bridge.js";
import {
  PM_RUNTIME_CONTROL_TOOL_DEFINITIONS,
  invokePmRuntimeControlTool,
  isPmRuntimeControlTool,
} from "@codeflowmu/runtime";

// ─── 配置读取 ─────────────────────────────────────────────────────────────────

const rawAllowed = (process.env["FCOP_ALLOWED_TOOLS"] ?? "").trim();
const allowedTools = new Set<string>(
  rawAllowed
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean),
);
const hasFilter = allowedTools.size > 0;
const runtimeAgentId = (process.env["CODEFLOWMU_AGENT_ID"] ?? "").trim();
const runtimeSessionId = (process.env["CODEFLOWMU_SESSION_ID"] ?? "").trim();
const runtimeCurrentTaskId = (
  process.env["CODEFLOWMU_CURRENT_TASK_ID"] ?? ""
).trim();
const isPmRuntimeAgent = /^PM(?:[-.]|$)/i.test(runtimeAgentId);

const pythonBin =
  process.env["FCOP_PYTHON_BIN"] ??
  process.env["PYTHON_BIN"] ??
  "python";

const projectRoot = process.env["FCOP_PROJECT_DIR"]?.trim() || process.cwd();
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const oneShotScript = path.resolve(
  thisDir,
  "../../packages/codeflowmu-runtime/scripts/fcop_invoke_once.py",
);

const ONE_SHOT_FCOP_TOOLS = new Set([
  "create_task",
  "write_task",
  "read_task",
  "inspect_task",
  "list_tasks",
  "write_report",
  "read_report",
  "list_reports",
  "write_issue",
  "list_issues",
  "fcop_report",
  "fcop_check",
  "get_team_status",
]);

function patchSubmitReviewSchema<T extends Record<string, unknown>>(tool: T): T {
  const name = typeof tool["name"] === "string" ? tool["name"] : "";
  if (name !== "submit_task" && name !== "submit_review") return tool;

  const inputSchema = tool["inputSchema"];
  if (!inputSchema || typeof inputSchema !== "object") return tool;

  const schema = { ...(inputSchema as Record<string, unknown>) };
  const properties =
    schema["properties"] && typeof schema["properties"] === "object"
      ? { ...(schema["properties"] as Record<string, unknown>) }
      : {};

  properties["report_id"] ??= {
    type: "string",
    description: "REPORT id just written for this task. Required for CodeFlowMu submit_review.",
  };
  properties["report"] ??= {
    type: "string",
    description: "Alias for report_id.",
  };

  schema["properties"] = properties;
  return { ...tool, inputSchema: schema };
}

function normalizeOneShotToolDefinition<T extends Record<string, unknown>>(tool: T): T {
  const name = typeof tool["name"] === "string" ? tool["name"] : "";
  const resolved = name ? resolveLifecycleToolCall(name) : null;
  const canonical = resolved && resolved.kind === "forward" ? resolved.name : name;
  const lifecyclePatched = patchSubmitReviewSchema(tool);
  if (!canonical || !ONE_SHOT_FCOP_TOOLS.has(canonical)) return lifecyclePatched;

  const clone = { ...lifecyclePatched };
  delete clone["outputSchema"];
  delete clone["output_schema"];
  delete clone["structuredContent"];
  delete clone["structured_content"];
  return clone as T;
}

function normalizeToolDefinitions(
  tools: Array<{ name: string; description?: string }>,
): Array<{ name: string; description?: string }> {
  return tools.map((tool) => normalizeOneShotToolDefinition(tool));
}

function injectPmRuntimeControlTools(
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
): Array<{ name: string; description?: string; inputSchema?: unknown }> {
  if (!isPmRuntimeAgent) return tools;
  const out = [...tools];
  const names = new Set(out.map((tool) => tool.name));
  for (const tool of PM_RUNTIME_CONTROL_TOOL_DEFINITIONS) {
    if (!allowedTools.has(tool.name) || names.has(tool.name)) continue;
    out.push({ ...tool });
    names.add(tool.name);
  }
  return out;
}

// ─── 启动 fcop-mcp 子进程 ────────────────────────────────────────────────────

// 🚨 完美开启 Python 无缓冲运行：当命令是 python 时，args 加入 -u，并设置 PYTHONUNBUFFERED 环境变量
// 这彻底解决了 Python 在重定向 stdout 时因为全缓冲导致多层管道卡死和 MCP Tool call timeout (initialize) 的核心 Bug！
const spawnArgs = ["-m", "fcop_mcp"];
const isPython = pythonBin.toLowerCase().includes("python");
if (isPython) {
  spawnArgs.unshift("-u");
}

const env = { ...process.env };
if (isPython) {
  env.PYTHONUNBUFFERED = "1";
}

const child = spawn(pythonBin, spawnArgs, {
  env, // 完整继承（含 FCOP_PROJECT_DIR、PYTHONPATH 等）
  cwd: projectRoot,
  stdio: ["pipe", "pipe", "inherit"], // stderr 直接透传，方便调试
});

child.on("error", (err) => {
  process.stderr.write(
    `[fcop-mcp-filter] 无法启动 fcop_mcp 子进程: ${err.message}\n`,
  );
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});

// ─── stdin: Cursor SDK → fcop-mcp（透明转发 - 逐行非阻塞写入，摧毁 Windows pipe 4KB 缓冲死锁）────────────────────────────────

const parentRl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false,
});

function writeJsonRpcLine(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function handleRuntimeToolCall(
  id: unknown,
  action: Parameters<typeof executeLifecycleRuntimeAction>[0],
  args: Record<string, unknown>,
): void {
  void executeLifecycleRuntimeAction(action, args)
    .then((result) => {
      writeJsonRpcLine({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: !result.ok,
        },
      });
    })
    .catch((err) => {
      writeJsonRpcLine({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              }),
            },
          ],
          isError: true,
        },
      });
    });
}

function handleOneShotFcopToolCall(
  id: unknown,
  tool: string,
  args: Record<string, unknown>,
): void {
  if (!existsSync(oneShotScript)) {
    writeJsonRpcLine({
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: `fcop one-shot bridge missing: ${oneShotScript}`,
            }),
          },
        ],
        isError: true,
      },
    });
    return;
  }

  execFile(
    pythonBin,
    [oneShotScript, projectRoot, JSON.stringify({ tool, arguments: args })],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        FCOP_PROJECT_DIR: projectRoot,
        PYTHONIOENCODING: "utf-8",
      },
      timeout: 120_000,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
    (err, stdout, stderr) => {
      const text = [stdout?.trim(), stderr?.trim()].filter(Boolean).join("\n");
      writeJsonRpcLine({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text:
                text ||
                (err instanceof Error
                  ? err.message
                  : JSON.stringify({ ok: true })),
            },
          ],
          isError: !!err,
        },
      });
    },
  );
}

parentRl.on("line", (line) => {
  if (!line.startsWith("{")) {
    if (child.stdin.writable) {
      child.stdin.write(line + "\n");
    }
    return;
  }

  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    if (child.stdin.writable) {
      child.stdin.write(line + "\n");
    }
    return;
  }

  if (msg["method"] === "tools/call") {
    const params = msg["params"] as Record<string, unknown> | undefined;
    const rawName =
      typeof params?.["name"] === "string" ? (params["name"] as string) : "";
    if (rawName) {
      if (isPmRuntimeControlTool(rawName)) {
        const args =
          params?.["arguments"] && typeof params["arguments"] === "object"
            ? (params["arguments"] as Record<string, unknown>)
            : {};
        void invokePmRuntimeControlTool({
          toolName: rawName,
          args,
          agentId: runtimeAgentId,
          sessionId: runtimeSessionId,
          currentTaskId: runtimeCurrentTaskId,
        })
          .then((result) => {
            writeJsonRpcLine({
              jsonrpc: "2.0",
              id: msg["id"],
              result: {
                content: [{ type: "text", text: JSON.stringify(result) }],
                isError: result["ok"] !== true,
              },
            });
          })
          .catch((error) => {
            writeJsonRpcLine({
              jsonrpc: "2.0",
              id: msg["id"],
              result: {
                content: [{ type: "text", text: JSON.stringify({
                  ok: false,
                  outcome: "error",
                  error: error instanceof Error ? error.message : String(error),
                }) }],
                isError: true,
              },
            });
          });
        return;
      }
      const resolved = resolveLifecycleToolCall(rawName);
      if (resolved.kind === "unimplemented") {
        writeJsonRpcLine({
          jsonrpc: "2.0",
          id: msg["id"],
          error: {
            code: -32601,
            message: resolved.message,
          },
        });
        return;
      }
      if (resolved.kind === "runtime") {
        const args =
          params?.["arguments"] && typeof params["arguments"] === "object"
            ? (params["arguments"] as Record<string, unknown>)
            : {};
        if (process.env["FCOP_FILTER_DEBUG"] === "1") {
          process.stderr.write(
            `[fcop-mcp-filter] tools/call Runtime: ${rawName} → ${resolved.action}\n`,
          );
        }
        handleRuntimeToolCall(msg["id"], resolved.action, args);
        return;
      }
      if (ONE_SHOT_FCOP_TOOLS.has(resolved.name)) {
        const args =
          params?.["arguments"] && typeof params["arguments"] === "object"
            ? (params["arguments"] as Record<string, unknown>)
            : {};
        if (process.env["FCOP_FILTER_DEBUG"] === "1") {
          process.stderr.write(
            `[fcop-mcp-filter] tools/call one-shot: ${rawName} -> ${resolved.name}\n`,
          );
        }
        handleOneShotFcopToolCall(msg["id"], resolved.name, args);
        return;
      }
      if (resolved.name !== rawName && params) {
        params["name"] = resolved.name;
        line = JSON.stringify(msg);
        if (process.env["FCOP_FILTER_DEBUG"] === "1") {
          process.stderr.write(
            `[fcop-mcp-filter] tools/call 别名: ${rawName} → ${resolved.name}\n`,
          );
        }
      }
    }
  }

  if (child.stdin.writable) {
    child.stdin.write(line + "\n");
  }
});

// ─── stdout: fcop-mcp → 过滤 → Cursor SDK ────────────────────────────────────

const rl = readline.createInterface({
  input: child.stdout!,
  crlfDelay: Infinity,
  terminal: false,
});

rl.on("line", (line: string) => {
  if (!hasFilter) {
    if (line.startsWith("{")) {
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        const result = msg["result"] as Record<string, unknown> | undefined;
        if (result && Array.isArray(result["tools"])) {
          result["tools"] = normalizeToolDefinitions(
            injectLifecycleToolAliases(
              result["tools"] as Array<{ name: string; description?: string }>,
            ),
          );
          process.stdout.write(JSON.stringify(msg) + "\n");
          return;
        }
      } catch {
        // fall through
      }
    }
    process.stdout.write(line + "\n");
    return;
  }

  if (!line.startsWith("{")) {
    // 非 JSON 行（空行、调试输出等），直接透传
    process.stdout.write(line + "\n");
    return;
  }

  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    // JSON 解析失败，安全透传
    process.stdout.write(line + "\n");
    return;
  }

  // 只拦截 tools/list 响应进行过滤，其余（tools/call、initialize 等）直接透传
  const result = msg["result"] as Record<string, unknown> | undefined;
  if (result && Array.isArray(result["tools"])) {
    const before = (result["tools"] as Array<{ name: string }>).length;
    result["tools"] = (
      result["tools"] as Array<{ name: string }>
    ).filter((t) => isLifecycleToolAllowed(t.name, allowedTools));
    result["tools"] = injectPmRuntimeControlTools(normalizeToolDefinitions(
      injectLifecycleToolAliases(
        result["tools"] as Array<{ name: string; description?: string }>,
      ),
    ));
    const after = (result["tools"] as Array<{ name: string }>).length;

    if (process.env["FCOP_FILTER_DEBUG"] === "1") {
      process.stderr.write(
        `[fcop-mcp-filter] tools/list 过滤: ${before} → ${after} 工具\n`,
      );
    }
  }

  process.stdout.write(JSON.stringify(msg) + "\n");
});

// ─── 进程卫生 ─────────────────────────────────────────────────────────────────

process.on("SIGTERM", () => {
  child.kill("SIGTERM");
});

process.on("SIGINT", () => {
  child.kill("SIGINT");
});
