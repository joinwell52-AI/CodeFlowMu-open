/**
 * 主交付 2（TASK-20260511-005 §3.2）：5 个核心 fcop 调用 demo。
 *
 * 目标：
 *   端到端演示 pythonia 跨 JS/Python 边界调用 fcop@1.1.0 的 5 个核心 API，
 *   并测量每次调用延迟（同进程应 < 50ms / 调用）。
 *
 * 五调用清单（PM TASK §3.2 + 实际 fcop@1.1.0 签名核实）：
 *   1. fcop.Project(path, strict=False)       → 构造 Project 对象（不创建目录）
 *   1.5. project.init(team='dev-team')        → 创建 fcop/{tasks,reports,issues,shared,log}/ 目录树
 *      （这步 PM TASK §3.2 省略了，但实际 write_task 之前必须 init —— surprise 候选）
 *   2. project.write_task(...)                → 写一张 PM→DEV 任务，返回 Task 对象
 *   3. project.list_tasks(status='open')      → 列开放任务，返回 list[Task]
 *   4. project.write_review(...)              → 写一张 QA 评审，返回 Review 对象（v1.1 ADR-0025 第 5 值 needs_human）
 *   5. project.mark_human_approved(review_id) → 人类批准，返回更新的 Review 对象
 *
 * PM TASK §3.2 的代码与实际 API 的差异（记录入 surprise §4）：
 *   - PM 把 write_task 写成位置参数；实际 signature 是 `(*, sender, recipient, ...)` 全 kwarg-only
 *   - PM 把返回值当 filename 字符串；实际返回 Task / Review 对象，需要 `.filename` / `.review_id`
 *   - PM 省略了 `project.init()` 步骤；实际 strict=False 也不会自动创建目录树
 *   - PM 用 `'D:/temp/codeflowmu-spike-project'`；本 demo 用 OS temp + 时间戳避免冲突 + 自动 cleanup
 *
 * pythonia kwarg 语法（v1.2.6 README 第 59 行）：
 *   **函数名**后加 `$` 触发 kwarg 模式，**最后一个参数**整体被当作 kwarg dict。
 *   例：`Project$(path, { strict: false })` ↔ `Project(path, strict=False)`
 *
 *   ⚠️ PM TASK §3.2 写的 `Project(path, { strict$: false })` 把 `$` 加在 key 上 —— 错。
 *      实际报错：`Project.__init__() takes 2 positional arguments but 3 were given`
 *      （pythonia 把 `{strict$: false}` 当成第 3 个位置参数，因为函数名没有 `$`）
 *      记入 surprise §4 第 6 类「pythonia kwarg 语法易错」。
 *
 * 跑法：
 *   ```powershell
 *   $env:PYTHON_BIN = "C:\Users\Administrator\AppData\Local\Programs\Python\Python312\python.exe"
 *   npm run demo
 *   ```
 *
 * 期望 stdout 末尾：
 *   ```
 *   open tasks: 1
 *   all 5 calls passed
 *   ```
 */

import { python } from "pythonia";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const result = await fn();
  const dt = Date.now() - t0;
  console.log(`[demo] ${label} → ${dt} ms`);
  return result;
}

async function main() {
  // ① 工作目录：OS temp 下唯一目录，避免与 PM 给的 `D:/temp/codeflowmu-spike-project` 硬编码冲突，
  //    且方便 demo 结束 cleanup（surprise §4 部署依赖 / 跨平台路径相关）。
  const projectRoot = mkdtempSync(join(tmpdir(), "codeflowmu-spike-"));
  console.log(`[demo] projectRoot = ${projectRoot}`);

  let demoSucceeded = false;
  let allCallsPassed = 0;

  try {
    console.log(`[demo] PYTHON_BIN env = ${process.env.PYTHON_BIN ?? "<unset>"}`);

    const tBoot = Date.now();
    const fcop = await python("fcop");
    console.log(`[demo] pythonia boot + import fcop took ${Date.now() - tBoot} ms`);

    // builtins —— pythonia v1.2.6 没有 `python.builtins` shortcut（surprise §4：pythonia API surface 比 README 暗示的窄），
    // 要显式 `await python('builtins')`。我们后面用 builtins.len 取 Python list 长度。
    const builtins = await python("builtins");

    // (1) Project 构造（strict=false 避免对未初始化目录做严校验）
    //     pythonia kwarg：`Project$(path, { strict: false })` ↔ Python `Project(path, strict=False)`
    const project = await timed("(1) fcop.Project(path, strict=False)", () =>
      fcop.Project$(projectRoot, { strict: false }),
    );
    allCallsPassed++;

    // (1.5) init —— PM TASK §3.2 省略，但实际 write_task 之前 fcop/ 树必须存在
    //   surprise §4：fcop Project() 与 init() 是分离的两步，未 init 时 write_task 会报
    //   `ProjectNotInitializedError`（或类似），需要先调 init。
    const initStatus = await timed("(1.5) project.init(team='dev-team')", () =>
      project.init$({
        team: "dev-team",
        lang: "zh",
        force: false,
        // deploy_role_templates 默认 True，会写 agents 配置；本 demo 保留默认
      }),
    );
    // ProjectStatus 是 dataclass；正确字段名 `is_initialized`（不是 `initialized`）
    const initInitialized = await initStatus.is_initialized;
    const initTeamName = await (await initStatus.config).team;
    console.log(`[demo]     is_initialized = ${initInitialized} | team = ${initTeamName}`);

    // (2) write_task —— 全 kwarg-only，返回 Task 对象（不是 filename！）
    //     `write_task$({...})` ↔ Python `write_task(**{...})`
    const task = await timed("(2) project.write_task(...)", () =>
      project.write_task$({
        sender: "PM",
        recipient: "DEV",
        priority: "P0",
        subject: "spike test",
        body: "just a test",
        risk_level: "low", // v1.1 ADR-0024 新参数
      }),
    );
    const taskFilename = await task.filename;
    const taskId = await task.task_id;
    console.log(`[demo]     task.filename = ${taskFilename}`);
    console.log(`[demo]     task.task_id  = ${taskId}`);
    allCallsPassed++;

    // (3) list_tasks —— 全 kwarg-only，返回 list[Task]
    const tasks = await timed("(3) project.list_tasks(status='open')", () =>
      project.list_tasks$({ status: "open" }),
    );
    // pythonia 对 Python list 长度：`python.builtins` 不是公开属性，要 `await python('builtins')`
    // 显式导入。pythonia README 第 59 行的简写是 misleading（surprise §4）。
    const tasksLen = await builtins.len(tasks);
    console.log(`open tasks: ${tasksLen}`); // PM TASK §3.2 期望输出之一
    allCallsPassed++;

    // (4) write_review —— v1.1 ADR-0025 第 5 值 needs_human
    //     subject_ref 应该是 task.filename 不含扩展名？看 fcop 源码：subject_ref 是 task_id 或 filename。
    //     用 task_id 更稳（task_id 是协议级稳定 id，与文件位置无关）。
    const review = await timed("(4) project.write_review(...)", () =>
      project.write_review$({
        reviewer_role: "QA",
        subject_type: "task",
        subject_ref: taskId, // 用 task_id 作 ref（fcop schema 接受 task_id 或 filename）
        decision: "needs_human", // v1.1 ADR-0025 第 5 值
        rationale: "just spiking",
        // required_changes 默认 ()，rationale 已给
      }),
    );
    const reviewFilename = await review.filename;
    const reviewId = await review.review_id;
    const reviewDecision = await review.decision;
    console.log(`[demo]     review.filename  = ${reviewFilename}`);
    console.log(`[demo]     review.review_id = ${reviewId}`);
    console.log(`[demo]     review.decision  = ${reviewDecision}`);
    allCallsPassed++;

    // (5) mark_human_approved —— review_id 是 positional 第一参，其余 kwarg-only
    //     PM TASK §3.2 写 `reviewFilename.replace('.md', '')` —— 那是 PM 假设返回的是 filename。
    //     实际 fcop 给我们一个独立的 review_id 字段（更稳）。直接用它。
    const approval = await timed("(5) project.mark_human_approved(...)", () =>
      project.mark_human_approved$(reviewId, {
        approver: "ADMIN",
        decision: "approve",
        channel: "cli",
        comment: "spike approval",
      }),
    );
    // approval 是更新的 Review 对象（带 human_approval 字段）
    const humanApproval = await approval.human_approval;
    if (humanApproval) {
      const approvalDecision = await humanApproval.decision;
      const approvalApprover = await humanApproval.approver;
      const approvalChannel = await humanApproval.channel;
      console.log(`[demo]     human_approval = approver=${approvalApprover} decision=${approvalDecision} channel=${approvalChannel}`);
    } else {
      console.log(`[demo]     human_approval = null (unexpected — surprise)`);
    }
    allCallsPassed++;

    console.log(`all 5 calls passed`); // PM TASK §3.2 期望输出之二

    // 文件落盘验证（surprise §4「fcop 写文件路径」）
    console.log("");
    console.log("[demo] === actual files written ===");
    walkPrint(projectRoot, projectRoot);

    demoSucceeded = true;

    await python.exit();
  } catch (err) {
    console.error("[demo] FAILED at call #", allCallsPassed + 1, ":", err);
    try {
      await python.exit();
    } catch {
      // ignore
    }
    process.exitCode = 1;
  } finally {
    // Cleanup OS temp dir 不留垃圾（spike 不是产品改动，不应在用户磁盘留 1.5 MB 的 fcop 初始化模板）。
    if (existsSync(projectRoot)) {
      try {
        rmSync(projectRoot, { recursive: true, force: true });
        console.log(`[demo] cleanup: removed ${projectRoot}`);
      } catch (e) {
        console.warn(`[demo] cleanup failed (non-fatal):`, e);
      }
    }
    console.log(
      `[demo] summary: succeeded=${demoSucceeded} callsPassed=${allCallsPassed}/5`,
    );
  }
}

/** 简易递归列文件 —— 演示用，不打深度树。 */
function walkPrint(rootForLabel: string, dir: string, depth = 0): void {
  if (depth > 4) return; // 防递归过深
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    const rel = full.slice(rootForLabel.length + 1).replace(/\\/g, "/");
    if (ent.isDirectory()) {
      console.log(`[demo]   ${"  ".repeat(depth)}📁 ${rel}/`);
      walkPrint(rootForLabel, full, depth + 1);
    } else {
      console.log(`[demo]   ${"  ".repeat(depth)}📄 ${rel}`);
    }
  }
}

main().catch((e) => {
  console.error("[demo] top-level catch:", e);
  process.exitCode = 1;
});

