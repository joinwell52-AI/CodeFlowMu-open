/**
 * Debounced ledger rebuild — coalesce burst writes (lifecycle, dispatch, panel).
 * Always runs full `rebuild()` (not conditional `ensureFresh`).
 */
import { resolve } from "node:path";

import { LedgerBuilder } from "./LedgerBuilder.ts";

const DEBOUNCE_MS = 400;

type RebuildGate = {
  timer: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
  dirty: boolean;
};

const gates = new Map<string, RebuildGate>();

function gateFor(projectRoot: string): RebuildGate {
  const key = resolve(projectRoot);
  let gate = gates.get(key);
  if (!gate) {
    gate = { timer: null, running: null, dirty: false };
    gates.set(key, gate);
  }
  return gate;
}

/** Test hook — clear pending debounced rebuilds. */
export function resetScheduleLedgerRebuildForTests(): void {
  for (const gate of gates.values()) {
    if (gate.timer) clearTimeout(gate.timer);
  }
  gates.clear();
}

function enqueue(projectRoot: string): void {
  const gate = gateFor(projectRoot);
  gate.dirty = true;
  if (gate.running) return;
  if (gate.timer) clearTimeout(gate.timer);
  gate.timer = setTimeout(() => {
    gate.timer = null;
    void runScheduledRebuild(projectRoot);
  }, DEBOUNCE_MS);
}

async function runScheduledRebuild(projectRoot: string): Promise<void> {
  const gate = gateFor(projectRoot);
  if (!gate.dirty && !gate.running) return;
  if (gate.running) {
    gate.dirty = true;
    return;
  }
  gate.dirty = false;
  gate.running = (async () => {
    const builder = new LedgerBuilder({ projectRoot: resolve(projectRoot) });
    await builder.rebuild();
  })();
  try {
    await gate.running;
  } finally {
    gate.running = null;
    if (gate.dirty) await runScheduledRebuild(projectRoot);
  }
}

/** Schedule a debounced full ledger rebuild (views + tasks.jsonl). */
export function scheduleLedgerRebuild(projectRoot: string): void {
  enqueue(projectRoot);
}

/** Await any pending debounced rebuild — for tests and sync CLI paths. */
export async function flushScheduledLedgerRebuild(
  projectRoot: string,
): Promise<void> {
  const gate = gateFor(projectRoot);
  if (gate.timer) {
    clearTimeout(gate.timer);
    gate.timer = null;
  }
  gate.dirty = true;
  while (gate.dirty || gate.running) {
    await runScheduledRebuild(projectRoot);
  }
}
