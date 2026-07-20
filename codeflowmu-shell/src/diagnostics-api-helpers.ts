/**
 * Shell API helpers for fcop/ledger/diagnostics.jsonl — list, rescan, clear-orphan.
 * Active diagnostics = diagnostics.jsonl minus cleared ids in diagnostic_resolutions.jsonl.
 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  isDiagnosticVisible,
  resolveLedgerLayout,
  taskSequenceKey,
} from "@codeflowmu/runtime";

import { countInboxTasks, fcopV3Paths } from "./fcop-v3-paths.ts";
import {
  ensureLedgerFresh,
  invalidateLedgerFreshCache,
  readLedgerDiagnostics,
} from "./ledger-api-helpers.ts";

export type DiagnosticKind =
  | "ledger_orphan"
  | "file_without_ledger"
  | "bucket_mismatch"
  | "path_mismatch";

export type DiagnosticResolutionRecord = {
  diagnostic_id: string;
  action: "clear_orphan";
  task_id?: string;
  type: DiagnosticKind;
  cleared_at: string;
};

export type DiagnosticsSummary = {
  diagnostics_count: number;
  ledger_orphan_count: number;
  file_without_ledger_count: number;
  bucket_mismatch_count: number;
  path_mismatch_count: number;
};

export type DiagnosticApiItem = {
  id: string;
  type: DiagnosticKind;
  task_id?: string;
  title: string;
  message: string;
  expectedPath?: string;
  actualPath?: string;
  ledgerPath?: string;
  bucketFromFile?: string;
  bucketFromLedger?: string;
  source?: string;
  createdAt: string;
  actions: string[];
};

type RawDiagnostic = Record<string, unknown>;

function diagnosticResolutionsPath(projectRoot: string): string {
  const layout = resolveLedgerLayout(projectRoot);
  return join(layout.ledgerDir, "diagnostic_resolutions.jsonl");
}

function readJsonl<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, "utf-8");
    const out: T[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as T);
      } catch {
        /* skip bad line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function readDiagnosticResolutions(
  projectRoot: string,
): DiagnosticResolutionRecord[] {
  return readJsonl<DiagnosticResolutionRecord>(
    diagnosticResolutionsPath(projectRoot),
  );
}

export function clearedDiagnosticIds(projectRoot: string): Set<string> {
  const ids = new Set<string>();
  for (const row of readDiagnosticResolutions(projectRoot)) {
    const id = String(row.diagnostic_id ?? "").trim();
    if (id) ids.add(id);
  }
  return ids;
}

function diagnosticActions(type: string): string[] {
  const base = ["view_source", "rescan"];
  if (type === "ledger_orphan") return [...base, "clear_orphan"];
  return base;
}

function asDiagnosticKind(type: string): DiagnosticKind {
  switch (type) {
    case "ledger_orphan":
    case "file_without_ledger":
    case "bucket_mismatch":
    case "path_mismatch":
      return type;
    default:
      return "ledger_orphan";
  }
}

export function mapDiagnosticToApiItem(raw: RawDiagnostic): DiagnosticApiItem {
  const type = asDiagnosticKind(String(raw.type ?? ""));
  return {
    id: String(raw.id ?? ""),
    type,
    task_id: raw.task_id != null ? String(raw.task_id) : undefined,
    title: String(raw.title ?? ""),
    message: String(raw.message ?? ""),
    expectedPath:
      raw.expected_path != null ? String(raw.expected_path) : undefined,
    actualPath: raw.actual_path != null ? String(raw.actual_path) : undefined,
    ledgerPath: raw.ledger_path != null ? String(raw.ledger_path) : undefined,
    bucketFromFile:
      raw.bucket_from_file != null ? String(raw.bucket_from_file) : undefined,
    bucketFromLedger:
      raw.bucket_from_ledger != null
        ? String(raw.bucket_from_ledger)
        : undefined,
    source: raw.source != null ? String(raw.source) : undefined,
    createdAt: String(raw.detected_at ?? raw.created_at ?? ""),
    actions: diagnosticActions(type),
  };
}

export function filterActiveDiagnostics(
  rows: RawDiagnostic[],
  cleared: Set<string>,
): RawDiagnostic[] {
  return rows.filter((row) => {
    const id = String(row.id ?? "").trim();
    if (!id || cleared.has(id)) return false;
    return isDiagnosticVisible(row as { visible?: boolean });
  });
}

export function buildDiagnosticsSummary(
  active: RawDiagnostic[],
): DiagnosticsSummary {
  let ledger_orphan_count = 0;
  let file_without_ledger_count = 0;
  let bucket_mismatch_count = 0;
  let path_mismatch_count = 0;
  for (const row of active) {
    switch (String(row.type ?? "")) {
      case "ledger_orphan":
        ledger_orphan_count++;
        break;
      case "file_without_ledger":
        file_without_ledger_count++;
        break;
      case "bucket_mismatch":
        bucket_mismatch_count++;
        break;
      case "path_mismatch":
        path_mismatch_count++;
        break;
      default:
        break;
    }
  }
  return {
    diagnostics_count: active.length,
    ledger_orphan_count,
    file_without_ledger_count,
    bucket_mismatch_count,
    path_mismatch_count,
  };
}

export function listActiveDiagnostics(projectRoot: string): RawDiagnostic[] {
  const cleared = clearedDiagnosticIds(projectRoot);
  return filterActiveDiagnostics(readLedgerDiagnostics(projectRoot), cleared);
}

function mapActiveToListResponse(active: RawDiagnostic[]): {
  diagnostics: DiagnosticApiItem[];
  summary: DiagnosticsSummary;
} {
  return {
    diagnostics: active.map(mapDiagnosticToApiItem),
    summary: buildDiagnosticsSummary(active),
  };
}

export function getDiagnosticsListResponse(projectRoot: string): {
  diagnostics: DiagnosticApiItem[];
  summary: DiagnosticsSummary;
} {
  return mapActiveToListResponse(listActiveDiagnostics(projectRoot));
}

export type DiagnosticsListConfirmOptions = {
  /** Test hook — default sleeps random 3000–6000ms */
  sleep?: (ms: number) => Promise<void>;
  /** Test hook — default 3000 + Math.random() * 3000 */
  randomDelayMs?: () => number;
  /** Test hook — default ensureLedgerFresh from ledger-api-helpers */
  ensureLedgerFresh?: typeof ensureLedgerFresh;
  /** Test hook — default invalidateLedgerFreshCache from ledger-api-helpers */
  invalidateLedgerFreshCache?: typeof invalidateLedgerFreshCache;
};

function hasFileWithoutLedger(active: RawDiagnostic[]): boolean {
  return active.some(
    (row) => String(row.type ?? "") === "file_without_ledger",
  );
}

/** Delayed confirm path for transient file_without_ledger on cold start. */
export async function getDiagnosticsListResponseConfirmed(
  projectRoot: string,
  options: DiagnosticsListConfirmOptions = {},
): Promise<{
  diagnostics: DiagnosticApiItem[];
  summary: DiagnosticsSummary;
}> {
  const ensureFreshFn = options.ensureLedgerFresh ?? ensureLedgerFresh;
  const invalidateCacheFn =
    options.invalidateLedgerFreshCache ?? invalidateLedgerFreshCache;

  const firstActive = listActiveDiagnostics(projectRoot);
  if (!hasFileWithoutLedger(firstActive)) {
    return mapActiveToListResponse(firstActive);
  }

  const firstResponse = mapActiveToListResponse(firstActive);

  try {
    invalidateCacheFn(projectRoot);
    await ensureFreshFn(projectRoot, { rebuild: true, force: true });
    const secondActive = listActiveDiagnostics(projectRoot);
    return mapActiveToListResponse(secondActive);
  } catch {
    return firstResponse;
  }
}

export function getDiagnosticById(
  projectRoot: string,
  diagnosticId: string,
): DiagnosticApiItem | null {
  const id = diagnosticId.trim();
  if (!id) return null;
  if (clearedDiagnosticIds(projectRoot).has(id)) return null;
  const row = readLedgerDiagnostics(projectRoot).find(
    (d) => String(d.id ?? "") === id,
  );
  if (!row || !isDiagnosticVisible(row as { visible?: boolean })) return null;
  return mapDiagnosticToApiItem(row);
}

export async function rescanDiagnostics(
  projectRoot: string,
): Promise<DiagnosticsSummary> {
  invalidateLedgerFreshCache(projectRoot);
  await ensureLedgerFresh(projectRoot, { rebuild: true, force: true });
  const active = listActiveDiagnostics(projectRoot);
  return buildDiagnosticsSummary(active);
}

export function clearOrphanDiagnostic(
  projectRoot: string,
  diagnosticId: string,
): { ok: true; diagnostic_id: string; resolution: DiagnosticResolutionRecord } {
  const id = diagnosticId.trim();
  if (!id) {
    throw new Error("MISSING_DIAGNOSTIC_ID");
  }
  if (clearedDiagnosticIds(projectRoot).has(id)) {
    throw new Error("ALREADY_CLEARED");
  }
  const row = readLedgerDiagnostics(projectRoot).find(
    (d) => String(d.id ?? "") === id,
  );
  if (!row) {
    throw new Error("DIAGNOSTIC_NOT_FOUND");
  }
  const type = String(row.type ?? "");
  if (type !== "ledger_orphan") {
    throw new Error("NOT_LEDGER_ORPHAN");
  }
  const resolution: DiagnosticResolutionRecord = {
    diagnostic_id: id,
    action: "clear_orphan",
    task_id: row.task_id != null ? String(row.task_id) : undefined,
    type: "ledger_orphan",
    cleared_at: new Date().toISOString(),
  };
  const path = diagnosticResolutionsPath(projectRoot);
  appendFileSync(path, `${JSON.stringify(resolution)}\n`, "utf-8");
  return { ok: true, diagnostic_id: id, resolution };
}

/** Lifecycle TASK counts from disk; diagnostics_count is separate (active diagnostics). */
export function buildTaskStats(projectRoot: string): {
  inbox: number;
  active: number;
  review: number;
  done: number;
  archive: number;
  diagnostics_count: number;
} {
  const paths = fcopV3Paths(projectRoot);
  const activeDiagnostics = listActiveDiagnostics(projectRoot);
  return {
    inbox: countInboxTasks(paths.inbox),
    active: countInboxTasks(paths.active),
    review: countInboxTasks(paths.review),
    done: countInboxTasks(paths.done),
    archive: countInboxTasks(paths.archive),
    diagnostics_count: activeDiagnostics.length,
  };
}

/** Test helper — reset resolution ledger. */
export function resetDiagnosticResolutionsForTests(projectRoot: string): void {
  const path = diagnosticResolutionsPath(projectRoot);
  if (existsSync(path)) writeFileSync(path, "", "utf-8");
}
