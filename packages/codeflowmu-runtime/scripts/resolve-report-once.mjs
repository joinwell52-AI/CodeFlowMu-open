/**
 * One-shot: run ReportActionResolver (REVIEW-GATE + settlement) on an existing REPORT.
 * Usage: npx tsx scripts/resolve-report-once.mjs [projectRoot] [reportRelPath]
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { LedgerBuilder } from "../src/ledger/LedgerBuilder.ts";
import { parseMarkdownFrontmatter } from "../src/ledger/frontmatter.ts";
import { resolveLedgerLayout } from "../src/ledger/paths.ts";
import { LifecycleGovernor } from "../src/scheduler/LifecycleGovernor.ts";
import { ReportActionResolver } from "../src/scheduler/ReportActionResolver.ts";

const root = process.argv[2] ?? "d:/codeflowmu";
const reportRel =
  process.argv[3] ?? "fcop/reports/REPORT-20260608-005-OPS-to-PM.md";
const reportPath = join(root, reportRel.replace(/\//g, "\\"));

const layout = resolveLedgerLayout(root);
const governor = new LifecycleGovernor({
  lifecycleRoot: layout.lifecycleRoot,
  projectRoot: root,
  logger: console,
});
const resolver = new ReportActionResolver({
  projectRoot: root,
  lifecycleGovernor: governor,
  logger: console,
});

const outcome = await resolver.resolve(reportPath);
console.log("ReportActionResolver outcome:", outcome);

const taskPath = join(
  root,
  "fcop/_lifecycle/active/TASK-20260608-003-PM-to-OPS.md",
);
const taskRaw = await readFile(taskPath, "utf-8");
const fm = parseMarkdownFrontmatter(taskRaw);
console.log("TASK-003 display_status:", fm.display_status ?? "(none)");
console.log("TASK-003 pm_attention_reason:", fm.pm_attention_reason ?? "(none)");

let reviewGate = null;
try {
  const names = await readdir(layout.reviewsDir);
  reviewGate = names
    .filter((n) => n.includes("REVIEW-GATE-on-TASK-20260608-003"))
    .sort()
    .at(-1);
} catch {
  /* no reviews dir */
}
if (reviewGate) {
  const reviewRaw = await readFile(join(layout.reviewsDir, reviewGate), "utf-8");
  const rfm = parseMarkdownFrontmatter(reviewRaw);
  console.log("REVIEW-GATE file:", reviewGate);
  console.log("REVIEW-GATE decision:", rfm.decision ?? "(none)");
  const body = reviewRaw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const judgment = body.match(/## 判定说明[\s\S]*?(?=\n## |\n# |$)/);
  if (judgment) {
    console.log(judgment[0].slice(0, 500));
  }
} else {
  console.log("REVIEW-GATE file: (none for TASK-20260608-003)");
}

await new LedgerBuilder({ projectRoot: root }).rebuild();
const threads = await readFile(join(layout.ledgerDir, "threads.jsonl"), "utf-8");
const line = threads
  .split(/\r?\n/)
  .find((l) => l.includes("panel-task-005") && l.includes("pending_pm_review"));
if (line) {
  const rec = JSON.parse(line);
  console.log(
    "panel-task-005 pending_pm_review:",
    JSON.stringify(rec.pending_pm_review ?? []),
  );
}
console.log("ledger rebuilt");
