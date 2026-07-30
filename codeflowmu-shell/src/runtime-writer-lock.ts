import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";

export interface RuntimeWriterLockRecord {
  instance_id: string;
  pid: number;
  panel_port: number;
  project_root: string;
  data_root?: string;
  acquired_at: string;
}

export interface RuntimeWriterLockHandle {
  record: RuntimeWriterLockRecord;
  paths: string[];
  release(): void;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(path: string): RuntimeWriterLockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RuntimeWriterLockRecord;
    return parsed && typeof parsed.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

function acquireOne(path: string, record: RuntimeWriterLockRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      } finally {
        closeSync(fd);
      }
      return;
    } catch (error) {
      const current = readLock(path);
      if (current && processIsAlive(current.pid)) {
        throw new Error(
          `Runtime writer lock is already owned: ${path} ` +
            `(instance_id=${current.instance_id}, pid=${current.pid}, ` +
            `panel_port=${current.panel_port}, project_root=${current.project_root})`,
        );
      }
      if (attempt === 0) {
        rmSync(path, { force: true });
        continue;
      }
      throw error;
    }
  }
}

export function acquireRuntimeWriterLocks(input: {
  instanceId: string;
  panelPort: number;
  projectRoot: string;
  dataDir?: string;
  includeFcopLock: boolean;
}): RuntimeWriterLockHandle {
  const projectRoot = pathResolve(input.projectRoot);
  const dataRoot = input.dataDir ? pathResolve(input.dataDir) : undefined;
  const record: RuntimeWriterLockRecord = {
    instance_id: input.instanceId,
    pid: process.pid,
    panel_port: input.panelPort,
    project_root: projectRoot,
    ...(dataRoot ? { data_root: dataRoot } : {}),
    acquired_at: new Date().toISOString(),
  };
  const paths = [join(projectRoot, ".codeflowmu", "runtime.lock")];
  if (input.includeFcopLock) {
    paths.push(join(projectRoot, "fcop", ".runtime-writer.lock"));
  }
  if (dataRoot) {
    paths.push(join(dataRoot, ".runtime-writer.lock"));
  }
  const uniquePaths = [...new Set(paths.map((path) => pathResolve(path)))];
  const acquired: string[] = [];
  try {
    for (const path of uniquePaths) {
      acquireOne(path, record);
      acquired.push(path);
    }
  } catch (error) {
    for (const path of acquired.reverse()) rmSync(path, { force: true });
    throw error;
  }
  let released = false;
  return {
    record,
    paths: uniquePaths,
    release() {
      if (released) return;
      released = true;
      for (const path of uniquePaths) {
        const current = readLock(path);
        if (current?.pid === process.pid && current.instance_id === input.instanceId) {
          rmSync(path, { force: true });
        }
      }
    },
  };
}
