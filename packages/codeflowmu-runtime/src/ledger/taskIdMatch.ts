/**
 * Cross-match TASK ids when ledger uses routing-complete ids
 * (TASK-YYYYMMDD-NNN-SENDER-to-RECIPIENT) and disk scan uses short prefix only.
 */

export function taskSequenceKey(id: string): string {
  const normalized = id.replace(/\.md$/i, "").trim();
  const m = /^TASK-\d{8}-\d{3,}/i.exec(normalized);
  return m ? m[0].toUpperCase() : normalized;
}

/** Prefer routing-complete id (contains -to-) over short TASK-YYYYMMDD-NNN. */
export function preferTaskId(a: string, b: string): string {
  const na = a.replace(/\.md$/i, "").trim();
  const nb = b.replace(/\.md$/i, "").trim();
  const aFull = /-to-/i.test(na);
  const bFull = /-to-/i.test(nb);
  if (aFull && !bFull) return na;
  if (bFull && !aFull) return nb;
  return na.length >= nb.length ? na : nb;
}

export function indexLedgerTasksBySequenceKey<T extends { task_id: string }>(
  rows: T[],
): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    const key = taskSequenceKey(row.task_id);
    const existing = map.get(key);
    if (
      !existing ||
      row.task_id.replace(/\.md$/i, "").length >
        existing.task_id.replace(/\.md$/i, "").length
    ) {
      map.set(key, row);
    }
  }
  return map;
}
