import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { ControlledExecutorName } from "./ControlledExecutorRegistry.ts";
import type {
  CapabilityRequest,
  OperationApprovalRecord,
  PrepareOperationInput,
} from "./OperationApprovalService.ts";

export type WorkspaceExecutorName = Extract<
  ControlledExecutorName,
  | "workspace.fs.write"
  | "workspace.fs.mkdir"
  | "workspace.fs.copy"
  | "workspace.fs.move"
  | "workspace.patch.apply"
>;

export type WorkspaceOperationApprovalInput = {
  projectRoot: string;
  subject: CapabilityRequest["subject"];
  executor: WorkspaceExecutorName;
  target?: string;
  targets?: string[];
  source?: string;
  content?: string;
  patch?: string;
  allowed_paths?: string[];
  encoding?: "utf8";
  overwrite?: boolean;
  policy_rule_ids?: string[];
};

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

function gitHead(projectRoot: string): string | null {
  try {
    return execFileSync("git", ["-C", projectRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

function normalizeInput(input: WorkspaceOperationApprovalInput) {
  const projectRoot = resolve(input.projectRoot);
  const rawTargets = input.targets?.length
    ? input.targets
    : input.target
      ? [input.target]
      : [];
  const targets = rawTargets.map((target) => canonicalForBoundary(projectRoot, target));
  const source = input.source ? canonicalForBoundary(projectRoot, input.source) : undefined;
  const allowedPaths = (input.allowed_paths ?? []).map((target) =>
    canonicalForBoundary(projectRoot, target));
  if (targets.length === 0 && input.executor !== "workspace.patch.apply") {
    throw new Error("OPERATION_BOUNDARY_DENIED:target_missing");
  }
  if (targets.length !== 1 && input.executor !== "workspace.patch.apply") {
    throw new Error("WORKSPACE_APPROVAL_REQUIRES_ONE_EXACT_TARGET");
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

export function buildWorkspaceOperationApprovalInput(
  input: WorkspaceOperationApprovalInput,
): PrepareOperationInput {
  const normalized = normalizeInput(input);
  const content = String(input.content ?? "");
  const patch = String(input.patch ?? "");
  const scope: Record<string, unknown> = {
    executor_version: 1,
    cwd: normalized.projectRoot,
    targets: normalized.targets,
    ...(normalized.source ? { source: normalized.source } : {}),
    ...(input.executor === "workspace.fs.write" ? {
      content,
      content_hash: sha256(content),
      content_bytes: Buffer.byteLength(content, "utf8"),
    } : {}),
    ...(patch ? { patch, patch_hash: sha256(patch) } : {}),
    ...(normalized.allowedPaths.length > 0 ? { allowed_paths: normalized.allowedPaths } : {}),
    encoding: input.encoding ?? "utf8",
    overwrite: input.overwrite !== false,
    ...(input.policy_rule_ids?.length ? { policy_rule_ids: input.policy_rule_ids } : {}),
  };
  const snapshotTargets = input.executor === "workspace.patch.apply"
    ? normalized.allowedPaths
    : normalized.targets;
  return {
    request: {
      subject: input.subject,
      action: {
        capability: input.executor,
        operation: input.executor.split(".").slice(-1)[0] ?? input.executor,
        executor: input.executor,
      },
      resource: {
        type: input.executor === "workspace.patch.apply" ? "workspace_patch" : "workspace_path",
        targets: normalized.targets.length > 0 ? normalized.targets : normalized.allowedPaths,
        scope,
      },
      context: {
        workspace: normalized.projectRoot,
        environment: "local",
        initiated_by: "agent",
        authorization_source: "none",
      },
      effect: {
        governance_change: true,
        destructive: input.executor === "workspace.fs.move",
      },
      snapshot: {
        git_head: gitHead(normalized.projectRoot),
        targets: snapshotTargets.map(fileSnapshot),
        ...(normalized.source ? { source: fileSnapshot(normalized.source) } : {}),
      },
    },
    reason: "bounded workspace operation requires one-time ADMIN approval",
    effects: [`execute ${input.executor} on exact bound targets`],
    non_effects: ["no raw shell replay", "no remote write", "no credential access"],
    recovery: "restore target snapshots or reverse the exact bound move",
  };
}

export function workspaceOperationInputFromRecord(
  record: OperationApprovalRecord,
): WorkspaceOperationApprovalInput {
  const scope = record.request.resource.scope ?? {};
  return {
    projectRoot: record.project_root,
    subject: record.request.subject,
    executor: record.request.action.executor as WorkspaceExecutorName,
    targets: Array.isArray(scope["targets"])
      ? scope["targets"].map(String)
      : record.request.resource.targets,
    source: typeof scope["source"] === "string" ? scope["source"] : undefined,
    content: typeof scope["content"] === "string" ? scope["content"] : undefined,
    patch: typeof scope["patch"] === "string" ? scope["patch"] : undefined,
    allowed_paths: Array.isArray(scope["allowed_paths"])
      ? scope["allowed_paths"].map(String)
      : undefined,
    encoding: "utf8",
    overwrite: scope["overwrite"] !== false,
    policy_rule_ids: Array.isArray(scope["policy_rule_ids"])
      ? scope["policy_rule_ids"].map(String)
      : undefined,
  };
}
