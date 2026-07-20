import type { LifecycleStage } from "./types.ts";

/** Fields compared for duplicate transition detection (time ignored). */
export interface TransitionCompareFields {
  from: LifecycleStage | null;
  to: LifecycleStage;
  by: string;
  tool?: string;
  note?: string;
}

function normStr(v: unknown): string {
  return String(v ?? "").trim();
}

function normFrom(v: unknown): LifecycleStage | null {
  const s = normStr(v);
  if (!s || s === "null") return null;
  return s as LifecycleStage;
}

/** Extract comparable fields from an existing transition record. */
export function transitionCompareFromRecord(
  rec: Record<string, unknown>,
): TransitionCompareFields {
  return {
    from: normFrom(rec.from),
    to: normStr(rec.to) as LifecycleStage,
    by: normStr(rec.by),
    tool: normStr(rec.tool || rec.action),
    note: normStr(rec.note || rec.reason),
  };
}

/** Map TransitionInput + optional extras to comparable fields. */
export function transitionCompareFromInput(input: {
  from: LifecycleStage | null;
  to: LifecycleStage;
  by: string;
  action: string;
  reason?: string;
}): TransitionCompareFields {
  return {
    from: input.from,
    to: input.to,
    by: input.by,
    tool: normStr(input.action),
    note: normStr(input.reason),
  };
}

export function isDuplicateTransition(
  last: Record<string, unknown> | undefined,
  next: TransitionCompareFields,
): boolean {
  if (!last) return false;
  const prev = transitionCompareFromRecord(last);
  return (
    prev.from === next.from &&
    prev.to === next.to &&
    prev.by === next.by &&
    prev.tool === next.tool &&
    prev.note === next.note
  );
}
