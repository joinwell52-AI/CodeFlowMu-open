import { promises as fs } from "node:fs";
import { basename } from "node:path";

import type {
  DiagnosticRecord,
  LedgerTaskRecord,
  ReconcileResult,
  ReconcileSummary,
} from "./types.ts";
import { diagnosticsJsonlPath } from "./paths.ts";
import {
  indexLedgerTasksBySequenceKey,
  preferTaskId,
  taskSequenceKey,
} from "./taskIdMatch.ts";
import type { LedgerLayout } from "./types.ts";

export type {
  DiagnosticRecord,
  ReconcileResult,
  ReconcileSummary,
} from "./types.ts";

export interface ReconcileTaskDiagnosticsOpts {
  detectedAt: string;
  projectRoot?: string;
}

/** Metadata for stale-ledger bucket/path drift healed from disk during rebuild. */
const STALE_LEDGER_HEAL_META = {
  severity: "info" as const,
  auto_healed: true,
  visible: false,
};

/** Whether a diagnostic row should appear in ADMIN-visible lists and counts. */
export function isDiagnosticVisible(d: Pick<DiagnosticRecord, "visible">): boolean {
  return d.visible !== false;
}

function normalizeTaskId(id: string): string {
  return id.replace(/\.md$/i, "").trim();
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").trim();
}

function pathsEqual(a: string, b: string): boolean {
  return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase();
}

/**
 * Compare disk scan vs prior tasks.jsonl snapshot.
 * File truth wins for normalTasks; mismatches and orphans land in diagnostics.
 */
export function reconcileTaskDiagnostics(
  diskTasks: LedgerTaskRecord[],
  priorLedger: LedgerTaskRecord[],
  opts: ReconcileTaskDiagnosticsOpts,
): ReconcileResult {
  const detectedAt = opts.detectedAt;
  const diskBySeq = indexLedgerTasksBySequenceKey(diskTasks);
  const priorBySeq = indexLedgerTasksBySequenceKey(priorLedger);
  const diagnostics: DiagnosticRecord[] = [];
  const seenOrphanIds = new Set<string>();

  for (const row of priorLedger) {
    const tid = normalizeTaskId(row.task_id);
    const seq = taskSequenceKey(tid);
    if (diskBySeq.has(seq)) continue;
    if (seenOrphanIds.has(tid)) continue;
    seenOrphanIds.add(tid);
    diagnostics.push({
      id: `ledger_orphan:${tid}`,
      task_id: tid,
      type: "ledger_orphan",
      severity: "warn",
      title: "Ledger orphan",
      message: `Ledger row ${tid} has no matching TASK file on disk`,
      ledger_path: String(row.path ?? ""),
      bucket_from_ledger: String(row.bucket ?? "unknown"),
      source: "ledger",
      detected_at: detectedAt,
    });
  }

  const normalTasks: LedgerTaskRecord[] = [];

  for (const diskTask of diskTasks) {
    const diskTid = normalizeTaskId(diskTask.task_id);
    const seq = taskSequenceKey(diskTid);
    const prior = priorBySeq.get(seq);
    const sameFile =
      prior &&
      (String(prior.filename ?? "").toLowerCase() ===
        String(diskTask.filename ?? "").toLowerCase() ||
        basename(String(prior.path ?? "")).toLowerCase() ===
          basename(String(diskTask.path ?? "")).toLowerCase());
    const tid = prior && sameFile ? preferTaskId(prior.task_id, diskTid) : diskTid;
    let sync_status: "ok" | "file_without_ledger" = "ok";

    if (!prior) {
      sync_status = "file_without_ledger";
      diagnostics.push({
        id: `file_without_ledger:${tid}`,
        task_id: tid,
        type: "file_without_ledger",
        severity: "info",
        title: "File without ledger",
        message: `TASK file ${tid} exists on disk but was absent from prior ledger snapshot`,
        actual_path: diskTask.path,
        bucket_from_file: String(diskTask.bucket ?? "unknown"),
        source: "ledger",
        detected_at: detectedAt,
      });
    } else {
      const ledgerBucket = String(prior.bucket ?? "unknown").toLowerCase();
      const diskBucket = String(diskTask.bucket ?? "unknown").toLowerCase();
      if (
        ledgerBucket !== diskBucket &&
        ledgerBucket !== "unknown" &&
        diskBucket !== "unknown"
      ) {
        diagnostics.push({
          id: `bucket_mismatch:${tid}`,
          task_id: tid,
          type: "bucket_mismatch",
          title: "Bucket mismatch (auto-healed)",
          message: `Ledger bucket '${prior.bucket}' differs from file location '${diskTask.bucket}' — using file`,
          bucket_from_file: diskBucket,
          bucket_from_ledger: ledgerBucket,
          actual_path: diskTask.path,
          ledger_path: String(prior.path ?? ""),
          source: "ledger",
          detected_at: detectedAt,
          ...STALE_LEDGER_HEAL_META,
        });
      }

      const priorPath = String(prior.path ?? "").trim();
      const diskPath = String(diskTask.path ?? "").trim();
      if (priorPath && diskPath && !pathsEqual(priorPath, diskPath)) {
        diagnostics.push({
          id: `path_mismatch:${tid}`,
          task_id: tid,
          type: "path_mismatch",
          title: "Path mismatch (auto-healed)",
          message: "Ledger path differs from actual file path — using file path",
          ledger_path: priorPath,
          actual_path: diskPath,
          expected_path: priorPath,
          source: "ledger",
          detected_at: detectedAt,
          ...STALE_LEDGER_HEAL_META,
        });
      }
    }

    normalTasks.push({
      ...diskTask,
      task_id: tid,
      filename: diskTask.filename,
      sync_status,
    });
  }

  const ledgerOrphanCount = diagnostics.filter((d) => d.type === "ledger_orphan").length;
  const fileWithoutLedgerCount = diagnostics.filter(
    (d) => d.type === "file_without_ledger",
  ).length;
  const bucketMismatchCount = diagnostics.filter(
    (d) => d.type === "bucket_mismatch",
  ).length;
  const pathMismatchCount = diagnostics.filter((d) => d.type === "path_mismatch").length;
  const autoHealedCount = diagnostics.filter((d) => d.auto_healed === true).length;
  const visibleDiagnosticsCount = diagnostics.filter(isDiagnosticVisible).length;

  return {
    normalTasks,
    diagnostics,
    summary: {
      lifecycleFileCount: diskTasks.length,
      ledgerRecordCount: priorLedger.length,
      diagnosticsCount: diagnostics.length,
      visibleDiagnosticsCount,
      autoHealedCount,
      ledgerOrphanCount,
      fileWithoutLedgerCount,
      bucketMismatchCount,
      pathMismatchCount,
    },
  };
}

export function serializeDiagnosticsJsonl(diagnostics: DiagnosticRecord[]): string {
  if (!diagnostics.length) return "";
  return diagnostics.map((d) => JSON.stringify(d)).join("\n") + "\n";
}

export function parseDiagnosticsJsonl(raw: string): DiagnosticRecord[] {
  const out: DiagnosticRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as DiagnosticRecord);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

export async function readLedgerTasksJsonl(filePath: string): Promise<LedgerTaskRecord[]> {
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }
  const out: LedgerTaskRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LedgerTaskRecord);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

export async function readDiagnosticsJsonl(
  layout: Pick<LedgerLayout, "ledgerDir">,
): Promise<DiagnosticRecord[]> {
  try {
    const raw = await fs.readFile(diagnosticsJsonlPath(layout), "utf-8");
    return parseDiagnosticsJsonl(raw);
  } catch {
    return [];
  }
}

export async function writeDiagnosticsJsonl(
  layout: Pick<LedgerLayout, "ledgerDir">,
  diagnostics: DiagnosticRecord[],
): Promise<void> {
  await fs.writeFile(
    diagnosticsJsonlPath(layout),
    serializeDiagnosticsJsonl(diagnostics),
    "utf-8",
  );
}
