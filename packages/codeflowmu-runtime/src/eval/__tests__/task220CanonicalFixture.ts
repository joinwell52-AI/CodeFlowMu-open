import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  taskMarkdown,
  writeTaskAt,
} from "../../lifecycle/__tests__/helpers.ts";
import { LedgerBuilder } from "../../ledger/LedgerBuilder.ts";
import { ensureLedgerLayout, resolveLedgerLayout } from "../../ledger/paths.ts";

export const TASK220_ROOT = "TASK-20260610-220-ADMIN-to-PM";
export const TASK220_THREAD = "panel-task-220";
export const TASK220_DEV = "TASK-20260610-040-PM-to-DEV";
export const TASK220_ACK = "REPORT-20260610-109-PM-to-ADMIN.md";
export const TASK220_AUTO = "REPORT-20260610-004-PM-to-ADMIN.md";
export const TASK220_MANUAL = "REPORT-20260610-111-PM-to-ADMIN.md";

export async function seedTask220CanonicalReports(
  rootDir: string,
  lifecycleRoot: string,
): Promise<void> {
  await ensureLedgerLayout(rootDir);
  const layout = resolveLedgerLayout(rootDir);
  const reportsDir = layout.reportsDir;
  await mkdir(reportsDir, { recursive: true });

  await writeTaskAt(lifecycleRoot, "review", `${TASK220_ROOT}.md`, {
    protocol: "fcop",
    version: 1,
    kind: "task",
    sender: "ADMIN",
    recipient: "PM",
    task_id: TASK220_ROOT,
    thread_key: TASK220_THREAD,
  }, "# ADMIN root TASK-220\n");

  await writeTaskAt(lifecycleRoot, "done", `${TASK220_DEV}.md`, {
    protocol: "fcop",
    version: 1,
    kind: "task",
    sender: "PM",
    recipient: "DEV",
    task_id: TASK220_DEV,
    parent: TASK220_ROOT,
    thread_key: TASK220_THREAD,
  }, "# DEV sub-task\n");

  await writeFile(
    join(reportsDir, TASK220_ACK),
    taskMarkdown(
      {
        protocol: "fcop",
        version: 1,
        sender: "PM",
        recipient: "ADMIN",
        status: "in_progress",
        references: [TASK220_ROOT],
        thread_key: TASK220_THREAD,
      },
      "## 执行状态\n\n**in_progress** — 已派单，等待下游回执。\n",
    ),
    "utf-8",
  );

  await writeFile(
    join(reportsDir, TASK220_AUTO),
    taskMarkdown(
      {
        protocol: "fcop",
        version: 1,
        sender: "PM",
        recipient: "ADMIN",
        status: "done",
        report_type: "final_summary",
        final: true,
        auto_final_summary: true,
        task_id: TASK220_ROOT,
        thread_key: TASK220_THREAD,
        references: [TASK220_ROOT, TASK220_DEV],
      },
      [
        "# 总结",
        "",
        "## 验收结果",
        "- 下游 REPORT 已落盘，PM 自动汇总关单",
        "",
        "## 失败与重试情况",
        "- 无自动 blocked 噪声（Runtime 总线自动汇总）",
      ].join("\n"),
    ),
    "utf-8",
  );

  await writeFile(
    join(reportsDir, TASK220_MANUAL),
    taskMarkdown(
      {
        protocol: "fcop",
        version: 1,
        sender: "PM",
        recipient: "ADMIN",
        status: "done",
        references: [TASK220_ROOT],
        thread_key: TASK220_THREAD,
      },
      "## 执行结果\n\n**done** — PM 手写完整最终报告，汇总子任务 TASK-20260610-040。\n",
    ),
    "utf-8",
  );

  const builder = new LedgerBuilder({ projectRoot: rootDir });
  await builder.rebuild();
}
