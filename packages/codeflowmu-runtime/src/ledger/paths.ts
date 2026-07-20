import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { LedgerLayout } from "./types.ts";

const LIFECYCLE_STAGES = [
  "inbox",
  "active",
  "review",
  "done",
  "archive",
] as const;

const LEDGER_FILES = [
  "tasks.jsonl",
  "reports.jsonl",
  "threads.jsonl",
  "diagnostics.jsonl",
] as const;

export function diagnosticsJsonlPath(layout: Pick<LedgerLayout, "ledgerDir">): string {
  return join(layout.ledgerDir, "diagnostics.jsonl");
}

const VIEW_FILES = [
  "ADMIN.inbox.md",
  "ADMIN.review.md",
  "PM.todo.md",
  "OPS.todo.md",
  "DEV.todo.md",
  "QA.todo.md",
] as const;

export function resolveLedgerLayout(projectRoot: string): LedgerLayout {
  const fcopRoot = join(projectRoot, "fcop");
  return {
    fcopRoot,
    tasksDir: join(fcopRoot, "tasks"),
    reportsDir: join(fcopRoot, "reports"),
    reviewsDir: join(fcopRoot, "reviews"),
    issuesDir: join(fcopRoot, "issues"),
    ledgerDir: join(fcopRoot, "ledger"),
    diagnosticsDir: join(fcopRoot, "ledger", "diagnostics"),
    lifecycleRoot: join(fcopRoot, "_lifecycle"),
  };
}

/** ADR-0002: idempotent init of fixed work folders + ledger skeleton. */
export async function ensureLedgerLayout(projectRoot: string): Promise<LedgerLayout> {
  const layout = resolveLedgerLayout(projectRoot);

  const dirs = [
    layout.tasksDir,
    layout.reportsDir,
    layout.reviewsDir,
    layout.issuesDir,
    join(layout.fcopRoot, "attachments"),
    layout.ledgerDir,
    layout.diagnosticsDir,
    join(layout.ledgerDir, "views"),
    ...LIFECYCLE_STAGES.map((s) => join(layout.lifecycleRoot, s)),
  ];

  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }

  for (const name of LEDGER_FILES) {
    const p = join(layout.ledgerDir, name);
    try {
      await fs.access(p);
    } catch {
      await fs.writeFile(p, "", "utf-8");
    }
  }

  const orphansPath = join(layout.diagnosticsDir, "orphans.jsonl");
  try {
    await fs.access(orphansPath);
  } catch {
    await fs.writeFile(orphansPath, "", "utf-8");
  }

  for (const name of VIEW_FILES) {
    const p = join(layout.ledgerDir, "views", name);
    try {
      await fs.access(p);
    } catch {
      await fs.writeFile(
        p,
        `# ${name.replace(".md", "")}\n\n_ledger view — run LedgerBuilder.rebuild() to refresh_\n`,
        "utf-8",
      );
    }
  }

  return layout;
}
