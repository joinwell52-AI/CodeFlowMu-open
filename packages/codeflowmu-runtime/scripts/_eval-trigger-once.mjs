import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  maybeWriteEvalObservation,
  getAdminTaskCloseout,
  findEvalObservationBySourceReport,
} from "../src/eval/EvalObservationGenerator.ts";
import { parseMarkdownFrontmatter } from "../src/ledger/frontmatter.ts";

const root = process.argv[2] ?? process.cwd();
const reportRel =
  process.argv[3] ?? "fcop/reports/REPORT-20260610-096-PM-to-ADMIN.md";
const reportFilename = reportRel.split(/[/\\]/).pop();
const reportId = reportFilename.replace(/\.md$/i, "");
const taskId = process.argv[4] ?? "TASK-20260610-215";
const forceRegenerate = !process.argv.includes("--no-force");
const path = join(root, reportRel);
const content = readFileSync(path, "utf-8");
const fm = parseMarkdownFrontmatter(content);

const written = await maybeWriteEvalObservation(
  {
    projectRoot: root,
    pmReportPath: path,
    pmReportFilename: reportFilename,
    pmReportContent: content,
    pmReportFm: fm,
  },
  { forceRegenerate },
);
console.log("written:", written);

const obs = await findEvalObservationBySourceReport(root, reportId);
console.log("obs:", obs?.filename ?? null);

const closeout = await getAdminTaskCloseout(root, taskId);
console.log(
  "closeout:",
  JSON.stringify(
    {
      pm: closeout?.pm_final_report?.report_id,
      eval: closeout?.eval_observation?.observation_id,
      risk: closeout?.eval_observation?.risk_level,
      findingCount: closeout?.eval_observation?.findings?.length,
    },
    null,
    2,
  ),
);
