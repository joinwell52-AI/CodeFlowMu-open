import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";

import type {
  ControlledExecutionResult,
  OperationApprovalRecord,
  WorkspaceExecutorName,
  WorkspaceOperationApprovalInput,
} from "@codeflowmu/runtime";
import {
  buildWorkspaceOperationApprovalInput,
  workspaceOperationInputFromRecord,
} from "@codeflowmu/runtime";

export type WorkspaceOperationInput = WorkspaceOperationApprovalInput;
export type { WorkspaceExecutorName };
export { buildWorkspaceOperationApprovalInput };

function sha256(value: Buffer | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalForBoundary(projectRoot: string, raw: string): string {
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(projectRoot, raw);
  let probe = absolute;
  const missing: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    missing.unshift(probe.slice(parent.length).replace(/^[\\/]+/, ""));
    probe = parent;
  }
  const resolved = (() => {
    try { return resolve(realpathSync.native(probe), ...missing); }
    catch { return absolute; }
  })();
  const rel = relative(resolve(projectRoot), resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`OPERATION_BOUNDARY_DENIED:${raw}`);
  }
  const normalized = resolved.replace(/\\/g, "/").toLowerCase();
  if (/(?:^|\/)fcop\/(?:_lifecycle|tasks|reports|issues|reviews?|logs|approvals)(?:\/|$)/.test(normalized)) {
    throw new Error(`ABSOLUTELY_PROHIBITED:${raw}`);
  }
  return resolved;
}

function fileSnapshot(path: string): Record<string, unknown> {
  if (!existsSync(path)) return { path, exists: false };
  const stat = statSync(path);
  if (!stat.isFile()) return { path, exists: true, type: "directory" };
  return {
    path,
    exists: true,
    type: "file",
    size: stat.size,
    sha256: sha256(readFileSync(path)),
  };
}

function normalizedInput(input: WorkspaceOperationInput) {
  const projectRoot = resolve(input.projectRoot);
  const rawTargets = input.targets?.length
    ? input.targets
    : input.target
      ? [input.target]
      : [];
  const targets = rawTargets.map((target) => canonicalForBoundary(projectRoot, target));
  const source = input.source
    ? canonicalForBoundary(projectRoot, input.source)
    : undefined;
  const allowedPaths = (input.allowed_paths ?? []).map((target) =>
    canonicalForBoundary(projectRoot, target));
  if (targets.length === 0 && input.executor !== "workspace.patch.apply") {
    throw new Error("OPERATION_BOUNDARY_DENIED:target_missing");
  }
  if (input.executor === "workspace.patch.apply" && (!input.patch || allowedPaths.length === 0)) {
    throw new Error("OPERATION_BOUNDARY_DENIED:patch_or_allowed_paths_missing");
  }
  if (input.executor === "workspace.patch.apply") {
    const patchPaths = [...String(input.patch).matchAll(/^(?:---|\+\+\+)\s+(?:[ab]\/)?(.+)$/gm)]
      .map((match) => String(match[1] ?? "").trim())
      .filter((path) => path && path !== "/dev/null")
      .map((path) => canonicalForBoundary(projectRoot, path));
    if (patchPaths.length === 0) {
      throw new Error("OPERATION_BOUNDARY_DENIED:patch_targets_missing");
    }
    const allowed = new Set(allowedPaths.map((path) => path.toLowerCase()));
    if (patchPaths.some((path) => !allowed.has(path.toLowerCase()))) {
      throw new Error("APPROVAL_SCOPE_MISMATCH:patch_target_not_allowed");
    }
  }
  return { projectRoot, targets, source, allowedPaths };
}

export function workspaceInputFromRecord(record: OperationApprovalRecord): WorkspaceOperationInput {
  return workspaceOperationInputFromRecord(record);
}

function atomicWrite(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

export async function executeWorkspaceOperation(
  record: OperationApprovalRecord,
): Promise<ControlledExecutionResult> {
  const input = workspaceInputFromRecord(record);
  const normalized = normalizedInput(input);
  const evidence: Array<Record<string, unknown>> = [];
  switch (input.executor) {
    case "workspace.fs.write": {
      const target = normalized.targets[0]!;
      if (existsSync(target) && input.overwrite === false) throw new Error("target_exists_and_overwrite_is_false");
      atomicWrite(target, String(input.content ?? ""));
      evidence.push({ executor: input.executor, target, after: fileSnapshot(target) });
      break;
    }
    case "workspace.fs.mkdir": {
      const target = normalized.targets[0]!;
      mkdirSync(target, { recursive: false });
      evidence.push({ executor: input.executor, target, created: true });
      break;
    }
    case "workspace.fs.copy": {
      if (!normalized.source) throw new Error("source_missing");
      const target = normalized.targets[0]!;
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(normalized.source, target);
      evidence.push({ executor: input.executor, source: normalized.source, target, after: fileSnapshot(target) });
      break;
    }
    case "workspace.fs.move": {
      if (!normalized.source) throw new Error("source_missing");
      const target = normalized.targets[0]!;
      mkdirSync(dirname(target), { recursive: true });
      renameSync(normalized.source, target);
      evidence.push({ executor: input.executor, source: normalized.source, target, moved: true });
      break;
    }
    case "workspace.patch.apply": {
      const patchPath = join(normalized.projectRoot, `.codeflowmu-patch-${randomBytes(8).toString("hex")}.diff`);
      try {
        writeFileSync(patchPath, String(input.patch ?? ""), "utf8");
        execFileSync("git", ["-C", normalized.projectRoot, "apply", "--check", patchPath], { windowsHide: true });
        execFileSync("git", ["-C", normalized.projectRoot, "apply", patchPath], { windowsHide: true });
      } finally {
        rmSync(patchPath, { force: true });
      }
      evidence.push({ executor: input.executor, patch_hash: sha256(String(input.patch ?? "")), allowed_paths: normalized.allowedPaths });
      break;
    }
  }
  return { evidence };
}
