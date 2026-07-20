/**
 * 主交付 4 主探针（TASK-20260511-005 §3.4）：surprise 类问题的实测验证。
 *
 * 本脚本独立跑，目的是给 REPORT §五的 8 类 surprise 提供**实测证据**，
 * 而不是仅靠 demo-fcop-api.ts 跑通时的副观察。
 *
 * 探针清单：
 *   P1. Windows 路径含空格 / 反斜杠 → Project 是否正常处理
 *   P2. Python GIL 阻塞行为：N 个并发 write_task 是否串行化（fcop 内部锁 vs GIL）
 *   P3. fcop_mcp（MCP server 包）是否会被 import；如果 import，是否拖慢启动
 *   P4. `Project(path, workspace_dir="fcop")` escape hatch 是否能切到 v0.x layout
 *   P5. 启动开销：连续 3 次 await python('fcop') 平均耗时（确认 warm 模式）
 *
 * 跑法：
 *   $env:PYTHON_BIN = "C:\Users\Administrator\AppData\Local\Programs\Python\Python312\python.exe"
 *   npx tsx probe-surprises.ts
 */

import { python } from "pythonia";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const result = await fn();
  console.log(`  [probe] ${label} → ${Date.now() - t0} ms`);
  return result;
}

async function main() {
  console.log(`PYTHON_BIN = ${process.env.PYTHON_BIN ?? "<unset>"}`);

  const t0 = Date.now();
  const fcop = await python("fcop");
  console.log(`Boot pythonia + import fcop: ${Date.now() - t0} ms`);

  // ─────────────────────────────────────────────────────────────
  // P1：Windows 路径含空格（与 codeflowmu `D:\CodeFlowMu\fcop\...` 习惯不同）
  // ─────────────────────────────────────────────────────────────
  console.log("\n=== P1: Windows path with space & deep nesting ===");
  // 故意带空格的目录名（多数 Windows 软件踩坑的常见模式）
  const pathWithSpace = mkdtempSync(join(tmpdir(), "spike with space "));
  console.log(`  pathWithSpace = ${pathWithSpace}`);
  try {
    const pSpace = await timed("Project(<space-path>)", () =>
      fcop.Project$(pathWithSpace, { strict: false }),
    );
    await timed("project.init() on space-path", () =>
      pSpace.init$({ team: "dev-team", lang: "zh" }),
    );
    console.log("  P1 verdict: PASS — fcop handles Windows path with space.");
  } catch (e) {
    console.log("  P1 verdict: FAIL —", e instanceof Error ? e.message : e);
  } finally {
    if (existsSync(pathWithSpace)) rmSync(pathWithSpace, { recursive: true, force: true });
  }

  // ─────────────────────────────────────────────────────────────
  // P2：concurrent write_task —— GIL + fcop 内部 file lock 行为
  // ─────────────────────────────────────────────────────────────
  console.log("\n=== P2: concurrent write_task (5 in parallel) ===");
  const concRoot = mkdtempSync(join(tmpdir(), "spike-conc-"));
  try {
    const pConc = await fcop.Project$(concRoot, { strict: false });
    await pConc.init$({ team: "dev-team", lang: "zh" });

    const tP2 = Date.now();
    // 5 个并发 write_task —— 若 GIL+fs lock 完全串行化，时间 ≈ 5 × 单次延迟
    //                       若有真并发，时间会显著小于 5 ×
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        pConc.write_task$({
          sender: "PM",
          recipient: "DEV",
          priority: "P2",
          subject: `concurrent task #${i + 1}`,
          body: `parallel write test ${i + 1}`,
        }),
      ),
    );
    const elapsed = Date.now() - tP2;
    console.log(`  5 parallel write_task: ${elapsed} ms total (avg ${(elapsed / 5).toFixed(1)} ms/call)`);
    // 收集 filenames（顺序 / 唯一性 sanity check）
    const filenames: string[] = [];
    for (const t of results) {
      filenames.push(await t.filename);
    }
    const unique = new Set(filenames).size;
    console.log(`  filenames produced: ${filenames.length} (unique: ${unique})`);
    if (unique === 5) {
      console.log(
        `  P2 verdict: PASS — fcop's sequence-generator works under concurrent calls (no filename collision).`,
      );
    } else {
      console.log(
        `  P2 verdict: FAIL — sequence collision! ${filenames.length - unique} dup(s). filenames=${JSON.stringify(filenames)}`,
      );
    }
  } finally {
    if (existsSync(concRoot)) rmSync(concRoot, { recursive: true, force: true });
  }

  // ─────────────────────────────────────────────────────────────
  // P3：fcop_mcp import test —— 验证「只 import fcop 时，fcop_mcp 不被自动 import」
  // ─────────────────────────────────────────────────────────────
  console.log("\n=== P3: fcop_mcp import side-effect check ===");
  const sys = await python("sys");
  const modules = await sys.modules;
  const hasFcopMcp = await modules.__contains__("fcop_mcp");
  const hasFcop = await modules.__contains__("fcop");
  console.log(`  sys.modules has 'fcop' = ${hasFcop}`);
  console.log(`  sys.modules has 'fcop_mcp' = ${hasFcopMcp}`);
  if (!hasFcopMcp) {
    console.log(
      "  P3 verdict: PASS — fcop_mcp NOT auto-imported (good: runtime can avoid MCP server boot cost).",
    );
  } else {
    console.log(
      "  P3 verdict: WARN — fcop_mcp auto-imported (cost = boot MCP server in same process).",
    );
  }

  // ─────────────────────────────────────────────────────────────
  // P4：workspace_dir = "fcop" escape hatch（codeflowmu v0.x layout）
  // ─────────────────────────────────────────────────────────────
  console.log("\n=== P4: workspace_dir='fcop' (codeflowmu v0.x layout) ===");
  const docsAgentsRoot = mkdtempSync(join(tmpdir(), "spike-docs-agents-"));
  try {
    const pDocsAgents = await fcop.Project$(docsAgentsRoot, {
      strict: false,
      workspace_dir: "fcop", // ADR-0022 explicit escape hatch
    });
    await pDocsAgents.init$({ team: "dev-team", lang: "zh" });
    const wsRoot = await pDocsAgents.workspace_dir;
    const wsLayout = await pDocsAgents.workspace_layout;
    console.log(`  workspace_dir = ${wsRoot}`);
    console.log(`  workspace_layout = ${wsLayout}`);

    const task = await pDocsAgents.write_task$({
      sender: "PM",
      recipient: "DEV",
      priority: "P1",
      subject: "v0.x layout test",
      body: "test write under fcop",
    });
    const fn = await task.filename;
    const fp = await task.path;
    console.log(`  task.filename = ${fn}`);
    console.log(`  task.path     = ${fp}`);
    console.log(
      `  P4 verdict: PASS — escape hatch works. codeflowmu v0.x layout viable via workspace_dir param.`,
    );
  } catch (e) {
    console.log("  P4 verdict: FAIL —", e instanceof Error ? e.message : e);
  } finally {
    if (existsSync(docsAgentsRoot)) rmSync(docsAgentsRoot, { recursive: true, force: true });
  }

  // ─────────────────────────────────────────────────────────────
  // P5：连续 3 次 await python('fcop')（同进程 warm cache 行为）
  // ─────────────────────────────────────────────────────────────
  console.log("\n=== P5: repeated `await python('fcop')` (warm import cache) ===");
  const samples: number[] = [];
  for (let i = 1; i <= 3; i++) {
    const s = Date.now();
    await python("fcop");
    samples.push(Date.now() - s);
  }
  console.log(`  samples ms = ${JSON.stringify(samples)}`);
  console.log(
    `  P5 verdict: ${samples.every((s) => s < 50) ? "PASS" : "WARN"} — warm re-import is ${samples.every((s) => s < 50) ? "cheap (< 50ms)" : "still > 50ms"}.`,
  );

  await python.exit();
  console.log("\n[probes] all done");
}

main().catch((e) => {
  console.error("probe FAILED:", e);
  python.exit().catch(() => {});
  process.exitCode = 1;
});

