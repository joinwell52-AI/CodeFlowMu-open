import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const TASK_SEQUENCE = /TASK-(\d{8})-(\d{3,})/gi;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function sequenceStatePath(projectRoot: string): string {
  return join(resolve(projectRoot), ".codeflowmu", "runtime", "task-sequence.json");
}
function readState(path: string): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([key, value]) => /^\d{8}$/.test(key) && Number.isFinite(Number(value)))
        .map(([key, value]) => [key, Math.max(0, Math.floor(Number(value)))]),
    );
  } catch {
    return {};
  }
}

function scanTaskNames(root: string, date: string): number {
  if (!existsSync(root)) return 0;
  let max = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const path = join(dir, name);
      try {
        if (statSync(path).isDirectory()) {
          stack.push(path);
          continue;
        }
      } catch { continue; }
      TASK_SEQUENCE.lastIndex = 0;
      for (const match of name.matchAll(TASK_SEQUENCE)) {
        if (match[1] === date) max = Math.max(max, Number(match[2]));
      }
    }
  }
  return max;
}

function acquireLock(path: string): number {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return openSync(path, "wx");
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > 30_000) unlinkSync(path);
      } catch { /* another writer released it */ }
      Atomics.wait(WAIT_BUFFER, 0, 0, 5);
    }
  }
  throw new Error(`TASK_IDENTITY_ALLOCATOR_BUSY:${path}`);
}

/** Reserve the next canonical project-wide TASK sequence. */
export function allocateTaskSequence(projectRoot: string, date: string): string {
  if (!/^\d{8}$/.test(date)) throw new Error(`INVALID_TASK_SEQUENCE_DATE:${date}`);
  const statePath = sequenceStatePath(projectRoot);
  const lockPath = `${statePath}.lock`;
  const lock = acquireLock(lockPath);
  try {
    const state = readState(statePath);
    const diskMax = scanTaskNames(join(resolve(projectRoot), "fcop"), date);
    const next = Math.max(state[date] ?? 0, diskMax) + 1;
    state[date] = next;
    mkdirSync(dirname(statePath), { recursive: true });
    const tmp = `${statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tmp, statePath);
    return String(next).padStart(3, "0");
  } finally {
    closeSync(lock);
    try { unlinkSync(lockPath); } catch { /* already released */ }
  }
}
