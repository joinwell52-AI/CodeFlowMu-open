/**
 * 主交付 1（TASK-20260511-005 §3.1）：pythonia + fcop@1.1.0 最小可执行验证。
 *
 * 目标：
 *   1. 证明 pythonia 能在 Windows 下成功 spawn 出带 fcop 的 Python 3.12，并 import fcop。
 *   2. 打印 `fcop version: 1.1.0`（PM TASK §3.1 期望值）+ Python 实际版本。
 *   3. 测量 `await python('fcop')` 启动延迟（PM TASK §3.1 要求记录）。
 *
 * Windows 特殊处理：
 *   本机 PATH 上 `python` = 3.9.5（无 fcop）。fcop@1.1.0 editable 装在 Python 3.12.9。
 *   pythonia/src/StdioCom.js:16-18：spawn 顺序是 `process.env.PYTHON_BIN || 'python3'`，
 *   再 fallback `python`。所以必须**显式**设 `PYTHON_BIN` 指向带 fcop 的 3.12 解释器。
 *   见 README.md「Windows 关键」节。
 *
 * 跑法：
 *   ```powershell
 *   $env:PYTHON_BIN = "C:\Users\Administrator\AppData\Local\Programs\Python\Python312\python.exe"
 *   npm run hello
 *   ```
 *
 * 期望 stdout（与 PM TASK §3.1 期望值对齐）：
 *   ```
 *   fcop version: 1.1.0
 *   ```
 */

// Per pythonia v1.2.6 README and index.d.ts: `import { python } from 'pythonia'`.
import { python } from "pythonia";

async function main() {
  // Step 1: pythonia env diagnostic — PM TASK §3.4 surprise「pythonia + Windows path」要求
  // 我们也要回答「是否要 set env var」，这里记录入手时的状态。
  console.log("[hello-fcop] start");
  console.log("[hello-fcop] PYTHON_BIN env =", process.env.PYTHON_BIN ?? "<unset>");
  console.log("[hello-fcop] node version    =", process.version);
  console.log("[hello-fcop] platform        =", process.platform);

  // Step 2: 启动延迟测量（PM TASK §3.1 第 3 条要求）
  const t0 = Date.now();
  // `await python('fcop')` 触发：spawn python 解释器 → Bridge.py boot → import fcop → 返回 proxy。
  // pythonia README: "every operation on the returned object is async".
  const fcop = await python("fcop");
  const t1 = Date.now();
  console.log(`[hello-fcop] await python('fcop') took ${t1 - t0} ms (cold start)`);

  // Step 3: 取 fcop 版本 — PM TASK §3.1 期望输出
  //   `fcop.__version__` 是 Python 端属性，pythonia 把属性访问也包成 Promise。
  //   .toString() 不一定走 Promise，但保险起见 await 它。
  const version = await fcop.__version__;
  console.log(`fcop version: ${version}`);

  // Step 4: 顺便取 Python 真实版本（surprise 揭示用）
  const sys = await python("sys");
  const pyVersion = await sys.version;
  const pyExecutable = await sys.executable;
  console.log(`[hello-fcop] Python version =`, pyVersion);
  console.log(`[hello-fcop] Python exe     =`, pyExecutable);

  // Step 5: 测一次属性访问延迟（与 demo 调用延迟对照用）
  const t2 = Date.now();
  await fcop.__version__;
  const t3 = Date.now();
  console.log(`[hello-fcop] second __version__ access took ${t3 - t2} ms (warm)`);

  // Step 6: 干净关停 — pythonia README 强调 `python.exit()` 否则 node 不退出。
  await python.exit();
  console.log("[hello-fcop] python.exit() returned; done");
}

main().catch((err) => {
  console.error("[hello-fcop] FAILED:", err);
  // 即使失败也试着 exit，不然 node 进程挂着。
  python.exit().catch(() => {});
  process.exitCode = 1;
});
