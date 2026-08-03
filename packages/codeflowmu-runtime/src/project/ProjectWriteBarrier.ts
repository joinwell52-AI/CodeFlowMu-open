import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";

const INIT_LOCK_REL = join(".codeflowmu", "fcop-init.lock");
const BARRIER_ROOT_REL = join(".codeflowmu", "project-write-barrier");
const LEASES_REL = join(BARRIER_ROOT_REL, "leases");
const WAITERS_REL = join(BARRIER_ROOT_REL, "waiters");
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_MS = 25;

export type ProjectWriteLease = {
  leaseId: string;
  path: string;
  release(): void;
};

export class ProjectWriteBarrierError extends Error {
  readonly code: "PROJECT_WRITE_BARRIER_TIMEOUT" | "PROJECT_WRITE_BARRIER_ACTIVE";

  constructor(
    message: string,
    code: "PROJECT_WRITE_BARRIER_TIMEOUT" | "PROJECT_WRITE_BARRIER_ACTIVE" = "PROJECT_WRITE_BARRIER_TIMEOUT",
  ) {
    super(message);
    this.name = "ProjectWriteBarrierError";
    this.code = code;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function sleepSync(ms: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function metadata(path: string): { pid?: number } | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
  } catch {
    return null;
  }
}

function removeStaleEntries(dir: string): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const pid = Number(metadata(path)?.pid ?? 0);
    if (!isProcessAlive(pid)) {
      try { unlinkSync(path); } catch { /* another process owns cleanup */ }
    }
  }
}

function cleanupEmptyBarrierDirs(projectRoot: string): void {
  for (const rel of [LEASES_REL, WAITERS_REL, BARRIER_ROOT_REL]) {
    const path = join(projectRoot, rel);
    try {
      if (existsSync(path) && readdirSync(path).length === 0) rmSync(path);
    } catch { /* best-effort cleanup only */ }
  }
}

function writeMarker(path: string, actor: string, kind: "lease" | "waiter"): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "wx");
  try {
    writeFileSync(fd, `${JSON.stringify({
      schema_version: 1,
      kind,
      actor,
      pid: process.pid,
      created_at: new Date().toISOString(),
    })}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
}

function paths(projectRoot: string, actor: string): {
  root: string;
  initLock: string;
  leasesDir: string;
  waitersDir: string;
  leaseId: string;
  leasePath: string;
  waiterPath: string;
} {
  const root = resolve(projectRoot);
  const leaseId = `${process.pid}-${Date.now()}-${randomBytes(5).toString("hex")}`;
  return {
    root,
    initLock: join(root, INIT_LOCK_REL),
    leasesDir: join(root, LEASES_REL),
    waitersDir: join(root, WAITERS_REL),
    leaseId,
    leasePath: join(root, LEASES_REL, `${leaseId}.json`),
    waiterPath: join(root, WAITERS_REL, `${leaseId}-${actor.replace(/[^a-z0-9_.-]+/gi, "_")}.json`),
  };
}

function releaseLease(root: string, leasePath: string, waiterPath: string): void {
  try { unlinkSync(leasePath); } catch { /* already released */ }
  try { unlinkSync(waiterPath); } catch { /* no waiter marker */ }
  cleanupEmptyBarrierDirs(root);
}

export function projectInitializationLockPath(projectRoot: string): string {
  return join(resolve(projectRoot), INIT_LOCK_REL);
}

export function isProjectInitializationActive(projectRoot: string): boolean {
  return existsSync(projectInitializationLockPath(projectRoot));
}

export async function acquireProjectWriteLease(
  projectRoot: string,
  actor: string,
  options: { timeoutMs?: number } = {},
): Promise<ProjectWriteLease> {
  const p = paths(projectRoot, actor);
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let waiterWritten = false;
  while (Date.now() <= deadline) {
    if (existsSync(p.initLock)) {
      if (!waiterWritten) {
        try { writeMarker(p.waiterPath, actor, "waiter"); waiterWritten = true; } catch { /* retry */ }
      }
      await sleep(POLL_MS);
      continue;
    }
    mkdirSync(p.leasesDir, { recursive: true });
    try {
      writeMarker(p.leasePath, actor, "lease");
    } catch {
      await sleep(POLL_MS);
      continue;
    }
    if (existsSync(p.initLock)) {
      releaseLease(p.root, p.leasePath, p.waiterPath);
      waiterWritten = false;
      await sleep(POLL_MS);
      continue;
    }
    try { unlinkSync(p.waiterPath); } catch { /* no waiter */ }
    return {
      leaseId: p.leaseId,
      path: p.leasePath,
      release: () => releaseLease(p.root, p.leasePath, p.waiterPath),
    };
  }
  releaseLease(p.root, p.leasePath, p.waiterPath);
  throw new ProjectWriteBarrierError(
    `project write delayed too long by FCoP initialization: ${p.root} actor=${actor}`,
  );
}

export function acquireProjectWriteLeaseSync(
  projectRoot: string,
  actor: string,
  options: { timeoutMs?: number } = {},
): ProjectWriteLease {
  const p = paths(projectRoot, actor);
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let waiterWritten = false;
  while (Date.now() <= deadline) {
    if (existsSync(p.initLock)) {
      // A synchronous wait would block this Node process from advancing its
      // own async initialization transaction. Fail fast so the caller can
      // return a retryable response; other processes may safely wait.
      let ownerPid = 0;
      try { ownerPid = Number(readFileSync(p.initLock, "utf8").trim()); } catch { continue; }
      if (ownerPid === process.pid) {
        throw new ProjectWriteBarrierError(
          `project write deferred by active FCoP initialization: ${p.root} actor=${actor}`,
          "PROJECT_WRITE_BARRIER_ACTIVE",
        );
      }
      if (!waiterWritten) {
        try { writeMarker(p.waiterPath, actor, "waiter"); waiterWritten = true; } catch { /* retry */ }
      }
      sleepSync(POLL_MS);
      continue;
    }
    mkdirSync(p.leasesDir, { recursive: true });
    try {
      writeMarker(p.leasePath, actor, "lease");
    } catch {
      sleepSync(POLL_MS);
      continue;
    }
    if (existsSync(p.initLock)) {
      releaseLease(p.root, p.leasePath, p.waiterPath);
      waiterWritten = false;
      sleepSync(POLL_MS);
      continue;
    }
    try { unlinkSync(p.waiterPath); } catch { /* no waiter */ }
    return {
      leaseId: p.leaseId,
      path: p.leasePath,
      release: () => releaseLease(p.root, p.leasePath, p.waiterPath),
    };
  }
  releaseLease(p.root, p.leasePath, p.waiterPath);
  throw new ProjectWriteBarrierError(
    `project write delayed too long by FCoP initialization: ${p.root} actor=${actor}`,
  );
}

export async function withProjectWriteLease<T>(
  projectRoot: string,
  actor: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  const lease = await acquireProjectWriteLease(projectRoot, actor);
  try {
    return await operation();
  } finally {
    lease.release();
  }
}

export function withProjectWriteLeaseSync<T>(
  projectRoot: string,
  actor: string,
  operation: () => T,
): T {
  const lease = acquireProjectWriteLeaseSync(projectRoot, actor);
  try {
    return operation();
  } finally {
    lease.release();
  }
}

export async function waitForProjectWriteLeasesToDrain(
  projectRoot: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const root = resolve(projectRoot);
  const leasesDir = join(root, LEASES_REL);
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  while (Date.now() <= deadline) {
    removeStaleEntries(leasesDir);
    const names = await fs.readdir(leasesDir).catch(() => [] as string[]);
    if (names.length === 0) return;
    await sleep(POLL_MS);
  }
  throw new ProjectWriteBarrierError(
    `active project writers did not drain for FCoP initialization: ${root}`,
  );
}

export function resetProjectWriteBarrierForTests(projectRoot: string): void {
  const root = resolve(projectRoot);
  const barrierRoot = join(root, BARRIER_ROOT_REL);
  if (existsSync(barrierRoot)) rmSync(barrierRoot, { recursive: true, force: true });
  const initLock = join(root, INIT_LOCK_REL);
  if (existsSync(initLock)) unlinkSync(initLock);
}
