import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  taskMarkdown,
  writeTaskAt,
} from "../../lifecycle/__tests__/helpers.ts";
import { LedgerBuilder } from "../../ledger/LedgerBuilder.ts";
import { parseMarkdownFrontmatter } from "../../ledger/frontmatter.ts";
import { ensureLedgerLayout, resolveLedgerLayout } from "../../ledger/paths.ts";
import { maybeWriteEvalObservation } from "../EvalObservationGenerator.ts";

export const EVAL_THREAD = "eval-thread-v1";
export const EVAL_ROOT = "TASK-20260610-101-ADMIN-to-PM";
export const EVAL_OPS = "TASK-20260610-102-PM-to-OPS";
export const EVAL_OPS_REPORT = "REPORT-20260610-003-OPS-to-PM.md";
export const EVAL_PM_FINAL = "REPORT-20260610-004-PM-to-ADMIN.md";

const FIXED_NOW = () => new Date("2026-06-10T12:00:00Z");

export type EvalThreadSeedOptions = {
  /** PM 正文不提及子任务 / worker report */
  omitPmChildMention?: boolean;
  /** ack-only PM-to-ADMIN（不触发 EVAL） */
  ackOnlyPm?: boolean;
  /** 只落盘，不调用 maybeWriteEvalObservation */
  skipObservation?: boolean;
  /** PM final summary 的 status（默认 done；in_progress / dispatching 不触发 EVAL） */
  pmFinalStatus?: "done" | "blocked" | "needs_admin" | "failed" | "in_progress" | "dispatching";
  /** 不写 report_type / final 标记（测 backward compat） */
  omitFinalMarkers?: boolean;
};

export type EvalThreadSeedResult = {
  pmFinalPath: string;
  pmFinalContent: string;
  pmFinalFm: Record<string, unknown>;
  observationPath: string | null;
};

export async function seedEvalCloseoutThread(
  rootDir: string,
  lifecycleRoot: string,
  options: EvalThreadSeedOptions = {},
): Promise<EvalThreadSeedResult> {
  await ensureLedgerLayout(rootDir);
  const layout = resolveLedgerLayout(rootDir);
  const reportsDir = layout.reportsDir;
  await mkdir(reportsDir, { recursive: true });

  await writeTaskAt(lifecycleRoot, "active", `${EVAL_ROOT}.md`, {
    protocol: "fcop",
    version: 1,
    kind: "task",
    sender: "ADMIN",
    recipient: "PM",
    task_id: EVAL_ROOT,
    thread_key: EVAL_THREAD,
  }, "# ADMIN root\n");

  await writeTaskAt(lifecycleRoot, "done", `${EVAL_OPS}.md`, {
    protocol: "fcop",
    version: 1,
    kind: "task",
    sender: "PM",
    recipient: "OPS",
    task_id: EVAL_OPS,
    parent: EVAL_ROOT,
    thread_key: EVAL_THREAD,
  }, "# OPS sub-task\n");

  await writeFile(
    join(reportsDir, EVAL_OPS_REPORT),
    taskMarkdown(
      {
        protocol: "fcop",
        version: 1,
        kind: "report",
        sender: "OPS",
        recipient: "PM",
        task_id: EVAL_OPS,
        thread_key: EVAL_THREAD,
        status: "done",
        references: [EVAL_OPS],
      },
      "## 结论\nOPS 完成\n",
    ),
    "utf-8",
  );

  let pmBody: string;
  if (options.ackOnlyPm) {
    pmBody = "已收到任务，正在分析并派发。";
  } else if (options.omitPmChildMention) {
    pmBody = "## 结论\nPM 总报告完成\n\n## 证据\n- 笼统描述\n";
  } else {
    pmBody = `## 结论\nPM 总报告\n\n## 证据\n- ${EVAL_OPS} done\n- ${EVAL_OPS_REPORT} referenced\n`;
  }

  const pmFinalStatus = options.ackOnlyPm
    ? undefined
    : (options.pmFinalStatus ?? "done");
  const pmFm: Record<string, unknown> = {
    protocol: "fcop",
    version: 1,
    kind: "report",
    sender: "PM",
    recipient: "ADMIN",
    task_id: EVAL_ROOT,
    thread_key: EVAL_THREAD,
    references: [EVAL_OPS, EVAL_ROOT],
  };
  if (pmFinalStatus) {
    pmFm.status = pmFinalStatus;
  }
  if (
    !options.ackOnlyPm &&
    !options.omitFinalMarkers &&
    pmFinalStatus !== "in_progress" &&
    pmFinalStatus !== "dispatching"
  ) {
    pmFm.report_type = "final_summary";
    pmFm.final = true;
  }

  const pmFinalContent = taskMarkdown(pmFm, pmBody);

  const pmFinalPath = join(reportsDir, EVAL_PM_FINAL);
  await writeFile(pmFinalPath, pmFinalContent, "utf-8");

  const builder = new LedgerBuilder({ projectRoot: rootDir });
  await builder.rebuild();

  const pmFinalFm = parseMarkdownFrontmatter(pmFinalContent) as Record<
    string,
    unknown
  >;

  let observationPath: string | null = null;
  const nonFinalStatus =
    options.pmFinalStatus === "in_progress" ||
    options.pmFinalStatus === "dispatching";
  if (!options.skipObservation && !options.ackOnlyPm && !nonFinalStatus) {
    observationPath = await maybeWriteEvalObservation({
      projectRoot: rootDir,
      pmReportPath: pmFinalPath,
      pmReportFilename: EVAL_PM_FINAL,
      pmReportContent: pmFinalContent,
      pmReportFm: pmFinalFm,
      now: FIXED_NOW,
    });
  }

  return { pmFinalPath, pmFinalContent, pmFinalFm, observationPath };
}
