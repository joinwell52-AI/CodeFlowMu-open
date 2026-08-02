import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const MAX_SCRATCH_FILE_BYTES = 1024 * 1024;
const MAX_SCRATCH_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_SCRATCH_FILES = 256;
const MAX_LIST_ENTRIES = 1000;
const SCRATCH_METADATA = ".codeflowmu-scratch.json";

export type WorkspaceScratchOperation = "create" | "write" | "read" | "list" | "cleanup";

function requireTaskId(value: unknown): string {
  const taskId = String(value ?? "").trim();
  if (!/^TASK-[A-Za-z0-9._-]+$/i.test(taskId)) {
    throw new Error("SCRATCH_TASK_BINDING_REQUIRED");
  }
  return taskId;
}

function scratchRoot(projectRoot: string, taskId: string): string {
  return join(resolve(projectRoot), ".codeflowmu", "scratch", taskId);
}

function boundedPath(root: string, value: unknown): string {
  const raw = String(value ?? ".").trim() || ".";
  if (isAbsolute(raw)) throw new Error("SCRATCH_PATH_OUT_OF_SCOPE");
  if (raw.replace(/\\/g, "/").split("/").includes(SCRATCH_METADATA)) {
    throw new Error("SCRATCH_RESERVED_PATH");
  }
  const target = resolve(root, raw);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("SCRATCH_PATH_OUT_OF_SCOPE");
  }
  let probe = target;
  while (probe !== root && !existsSync(probe)) probe = dirname(probe);
  if (existsSync(probe) && lstatSync(probe).isSymbolicLink()) {
    throw new Error("SCRATCH_SYMLINK_NOT_ALLOWED");
  }
  let component = root;
  for (const part of rel.split(/[\\/]+/).filter(Boolean)) {
    component = join(component, part);
    if (existsSync(component) && lstatSync(component).isSymbolicLink()) {
      throw new Error("SCRATCH_SYMLINK_NOT_ALLOWED");
    }
  }
  return target;
}

function listTree(root: string, at: string): Array<Record<string, unknown>> {
  if (!existsSync(at)) return [];
  const rows: Array<Record<string, unknown>> = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (rows.length >= MAX_LIST_ENTRIES) return;
      if (entry.name === SCRATCH_METADATA) continue;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      rows.push({
        path: relative(root, full).replace(/\\/g, "/"),
        type: entry.isDirectory() ? "directory" : "file",
        ...(entry.isFile() ? { size: statSync(full).size } : {}),
      });
      if (entry.isDirectory()) visit(full);
    }
  };
  if (statSync(at).isDirectory()) visit(at);
  else rows.push({ path: relative(root, at).replace(/\\/g, "/"), type: "file", size: statSync(at).size });
  return rows;
}

function scratchUsage(root: string): { files: number; bytes: number } {
  if (!existsSync(root)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === SCRATCH_METADATA || entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        files += 1;
        bytes += statSync(full).size;
      }
    }
  };
  visit(root);
  return { files, bytes };
}

function atomicWrite(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function recordScratchLifecycle(
  root: string,
  taskId: string,
  actor: string,
  sessionId: string,
): void {
  const path = join(root, SCRATCH_METADATA);
  const now = new Date().toISOString();
  let createdAt = now;
  if (existsSync(path)) {
    try {
      const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      createdAt = String(current["created_at"] ?? now);
    } catch { /* replace corrupt scratch-only metadata */ }
  }
  atomicWrite(path, `${JSON.stringify({
    schema_version: 1,
    task_id: taskId,
    created_by: actor,
    session_id: sessionId,
    created_at: createdAt,
    updated_at: now,
    limits: { max_files: MAX_SCRATCH_FILES, max_total_bytes: MAX_SCRATCH_TOTAL_BYTES },
  }, null, 2)}\n`);
}

export function executeWorkspaceScratch(input: {
  projectRoot: string;
  operation: WorkspaceScratchOperation;
  taskId: unknown;
  currentTaskId?: unknown;
  path?: unknown;
  content?: unknown;
  actor?: unknown;
  sessionId?: unknown;
}): Record<string, unknown> {
  const taskId = requireTaskId(input.taskId);
  const currentTaskId = String(input.currentTaskId ?? "").trim();
  if (currentTaskId && currentTaskId.toUpperCase() !== taskId.toUpperCase()) {
    throw new Error("SCRATCH_TASK_SCOPE_MISMATCH");
  }
  const root = scratchRoot(input.projectRoot, taskId);
  const target = boundedPath(root, input.path);
  const actor = String(input.actor ?? "PM").trim() || "PM";
  const sessionId = String(input.sessionId ?? "").trim();
  switch (input.operation) {
    case "create":
      mkdirSync(target, { recursive: true });
      recordScratchLifecycle(root, taskId, actor, sessionId);
      return { ok: true, operation: input.operation, task_id: taskId, path: relative(root, target).replace(/\\/g, "/") || "." };
    case "write": {
      const content = String(input.content ?? "");
      if (Buffer.byteLength(content, "utf8") > MAX_SCRATCH_FILE_BYTES) {
        throw new Error("SCRATCH_FILE_TOO_LARGE");
      }
      const usage = scratchUsage(root);
      const previousBytes = existsSync(target) && statSync(target).isFile() ? statSync(target).size : 0;
      const nextFiles = usage.files + (existsSync(target) ? 0 : 1);
      const nextBytes = usage.bytes - previousBytes + Buffer.byteLength(content, "utf8");
      if (nextFiles > MAX_SCRATCH_FILES) throw new Error("SCRATCH_FILE_COUNT_LIMIT");
      if (nextBytes > MAX_SCRATCH_TOTAL_BYTES) throw new Error("SCRATCH_TOTAL_SIZE_LIMIT");
      if (existsSync(target) && !statSync(target).isFile()) {
        throw new Error("SCRATCH_TARGET_NOT_FILE");
      }
      atomicWrite(target, content);
      recordScratchLifecycle(root, taskId, actor, sessionId);
      return { ok: true, operation: input.operation, task_id: taskId, path: relative(root, target).replace(/\\/g, "/"), bytes: Buffer.byteLength(content, "utf8") };
    }
    case "read": {
      if (!existsSync(target) || !statSync(target).isFile()) throw new Error("SCRATCH_FILE_NOT_FOUND");
      if (statSync(target).size > MAX_SCRATCH_FILE_BYTES) throw new Error("SCRATCH_FILE_TOO_LARGE");
      return { ok: true, operation: input.operation, task_id: taskId, path: relative(root, target).replace(/\\/g, "/"), content: readFileSync(target, "utf8") };
    }
    case "list":
      return { ok: true, operation: input.operation, task_id: taskId, path: relative(root, target).replace(/\\/g, "/") || ".", entries: listTree(root, target) };
    case "cleanup":
      rmSync(root, { recursive: true, force: true });
      return { ok: true, operation: input.operation, task_id: taskId, removed: true };
  }
}
