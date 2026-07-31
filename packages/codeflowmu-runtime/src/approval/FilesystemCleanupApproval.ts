import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

import type {
  CapabilityRequest,
  OperationApprovalRecord,
  PrepareOperationInput,
} from "./OperationApprovalService.ts";

export type FilesystemCleanupMode = "quarantine" | "permanent_delete";

export type FilesystemCleanupManifestEntry = {
  path: string;
  kind: "file" | "directory" | "symlink";
  size: number;
  modified_at: string;
};

export type FilesystemCleanupPreflight = {
  project_root: string;
  resolved_targets: string[];
  file_count: number;
  directory_count: number;
  total_size: number;
  file_types: Record<string, number>;
  earliest_modified_at: string | null;
  latest_modified_at: string | null;
  manifest: FilesystemCleanupManifestEntry[];
  protected_exclusions: string[];
  recommended_mode: "quarantine";
  requested_mode: FilesystemCleanupMode;
  retention_days: number;
  recovery: string;
};

export class FilesystemCleanupPreflightError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FilesystemCleanupPreflightError";
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function containsUnresolvedTarget(raw: string): boolean {
  return /[*?[\]{}]|(?:^|[\\/])\.\.(?:[\\/]|$)|%[^%]+%|\$\{?[\w]+\}?/.test(raw);
}

function normalizedRelative(projectRoot: string, target: string): string {
  return relative(resolve(projectRoot), resolve(target)).replace(/\\/g, "/");
}

function protectedByPath(projectRoot: string, target: string): boolean {
  const rel = normalizedRelative(projectRoot, target).toLowerCase();
  const disposableRoot =
    /(?:^|\/)(?:node_modules|dist|build|coverage|\.cache|cache|tmp|temp|logs?)(?:\/|$)/.test(
      rel,
    );
  return (
    rel === "" ||
    rel === ".git" ||
    rel.startsWith(".git/") ||
    /(?:^|\/)fcop\/(?:_lifecycle|tasks|reports|issues|reviews|history|internal\/eval)(?:\/|$)/.test(rel) ||
    /(?:^|\/)(?:task|report|issue|review)-[^/]+\.md$/i.test(rel) ||
    (!disposableRoot &&
      /\.(?:ts|tsx|js|jsx|mjs|cjs|py|java|go|rs|cs|cpp|c|h|hpp|vue|svelte|html|css|scss)$/i.test(
        rel,
      ))
  );
}

function trackedPaths(projectRoot: string, targets: string[]): Set<string> {
  try {
    const args = [
      "ls-files",
      "-z",
      "--",
      ...targets.map((target) => normalizedRelative(projectRoot, target)),
    ];
    const output = execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(
      String(output)
        .split("\0")
        .map((item) => item.trim().replace(/\\/g, "/"))
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

function walk(target: string, manifest: FilesystemCleanupManifestEntry[]): void {
  const stat = lstatSync(target);
  const kind = stat.isSymbolicLink()
    ? "symlink"
    : stat.isDirectory()
      ? "directory"
      : "file";
  manifest.push({
    path: resolve(target),
    kind,
    size: stat.isFile() ? stat.size : 0,
    modified_at: stat.mtime.toISOString(),
  });
  if (kind !== "directory") return;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    walk(join(target, entry.name), manifest);
  }
}

export function inspectFilesystemCleanup(input: {
  projectRoot: string;
  targets: string[];
  mode?: FilesystemCleanupMode;
  retentionDays?: number;
}): FilesystemCleanupPreflight {
  const projectRoot = resolve(input.projectRoot);
  if (!Array.isArray(input.targets) || input.targets.length === 0) {
    throw new FilesystemCleanupPreflightError(
      "CLEANUP_TARGETS_REQUIRED",
      "at least one exact cleanup target is required",
    );
  }
  const resolvedTargets = [...new Set(input.targets.map((raw) => {
    const value = String(raw ?? "").trim();
    if (!value || containsUnresolvedTarget(value)) {
      throw new FilesystemCleanupPreflightError(
        "CLEANUP_TARGET_UNRESOLVED",
        `cleanup target is not exact: ${value || "(empty)"}`,
      );
    }
    const target = isAbsolute(value) ? resolve(value) : resolve(projectRoot, value);
    if (!isInside(projectRoot, target) || target === projectRoot) {
      throw new FilesystemCleanupPreflightError(
        "CLEANUP_TARGET_OUT_OF_SCOPE",
        `cleanup target is outside the active project or is the project root: ${target}`,
      );
    }
    if (!existsSync(target)) {
      throw new FilesystemCleanupPreflightError(
        "CLEANUP_TARGET_MISSING",
        `cleanup target does not exist: ${target}`,
      );
    }
    return target;
  }))];

  const manifest: FilesystemCleanupManifestEntry[] = [];
  for (const target of resolvedTargets) walk(target, manifest);
  manifest.sort((left, right) => left.path.localeCompare(right.path));

  const tracked = trackedPaths(projectRoot, resolvedTargets);
  const protectedExclusions = manifest
    .filter((entry) => {
      const rel = normalizedRelative(projectRoot, entry.path);
      return protectedByPath(projectRoot, entry.path) || tracked.has(rel);
    })
    .map((entry) => normalizedRelative(projectRoot, entry.path));
  if (protectedExclusions.length > 0) {
    throw new FilesystemCleanupPreflightError(
      "CLEANUP_PROTECTED_CONTENT",
      `cleanup contains protected or Git-tracked content: ${protectedExclusions.slice(0, 20).join(", ")}`,
    );
  }

  const fileTypes: Record<string, number> = {};
  const files = manifest.filter((entry) => entry.kind === "file");
  for (const entry of files) {
    const extension = extname(entry.path).toLowerCase() || "(no extension)";
    fileTypes[extension] = (fileTypes[extension] ?? 0) + 1;
  }
  const times = manifest
    .map((entry) => Date.parse(entry.modified_at))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const retentionDays = Math.max(1, Math.min(90, Number(input.retentionDays ?? 14)));
  const requestedMode = input.mode ?? "quarantine";
  return {
    project_root: projectRoot,
    resolved_targets: resolvedTargets,
    file_count: files.length,
    directory_count: manifest.filter((entry) => entry.kind === "directory").length,
    total_size: files.reduce((sum, entry) => sum + entry.size, 0),
    file_types: Object.fromEntries(Object.entries(fileTypes).sort(([a], [b]) => a.localeCompare(b))),
    earliest_modified_at: times[0] != null ? new Date(times[0]).toISOString() : null,
    latest_modified_at:
      times.length > 0 ? new Date(times[times.length - 1]!).toISOString() : null,
    manifest,
    protected_exclusions: [],
    recommended_mode: "quarantine",
    requested_mode: requestedMode,
    retention_days: retentionDays,
    recovery:
      requestedMode === "quarantine"
        ? `restore from .codeflowmu/quarantine within ${retentionDays} days`
        : "permanent deletion has no automatic recovery",
  };
}

export function buildFilesystemCleanupApprovalInput(input: {
  projectRoot: string;
  targets: string[];
  subject: CapabilityRequest["subject"];
  mode?: FilesystemCleanupMode;
  retentionDays?: number;
  reason?: string;
}): PrepareOperationInput {
  const preflight = inspectFilesystemCleanup(input);
  const request: CapabilityRequest = {
    subject: input.subject,
    action: {
      capability: "filesystem.cleanup",
      operation: preflight.requested_mode,
      executor: "filesystem.cleanup",
    },
    resource: {
      type: "filesystem_manifest",
      targets: preflight.resolved_targets,
      scope: {
        mode: preflight.requested_mode,
        retention_days: preflight.retention_days,
      },
    },
    context: {
      workspace: preflight.project_root,
      environment: "local",
      initiated_by: "agent",
      authorization_source: "none",
      human_confirmation_id: null,
    },
    effect: {
      destructive: true,
    },
    snapshot: {
      file_count: preflight.file_count,
      directory_count: preflight.directory_count,
      total_size: preflight.total_size,
      file_types: preflight.file_types,
      earliest_modified_at: preflight.earliest_modified_at,
      latest_modified_at: preflight.latest_modified_at,
      manifest: preflight.manifest,
      protected_exclusions: preflight.protected_exclusions,
      recommended_mode: preflight.recommended_mode,
      requested_mode: preflight.requested_mode,
      retention_days: preflight.retention_days,
      recovery: preflight.recovery,
    },
  };
  return {
    request,
    reason:
      input.reason ??
      `cleanup ${preflight.file_count} files and ${preflight.directory_count} directories`,
    effects: [
      `${preflight.file_count} files / ${preflight.directory_count} directories / ${preflight.total_size} bytes`,
      `mode=${preflight.requested_mode}`,
    ],
    non_effects: [
      "project root, .git, FCoP formal records and Git-tracked files are excluded",
    ],
    recovery: preflight.recovery,
    expires_in_seconds: 900,
  };
}

export async function executeFilesystemCleanupApproval(
  record: OperationApprovalRecord,
): Promise<{
  status: "succeeded";
  evidence: Array<Record<string, unknown>>;
}> {
  if (record.request.action.executor !== "filesystem.cleanup") {
    throw new FilesystemCleanupPreflightError(
      "CLEANUP_EXECUTOR_MISMATCH",
      "approval is not bound to filesystem.cleanup",
    );
  }
  const mode = String(record.request.resource.scope?.["mode"] ?? "quarantine");
  if (mode !== "quarantine") {
    throw new FilesystemCleanupPreflightError(
      "PERMANENT_DELETE_EXECUTOR_DISABLED",
      "permanent deletion is not registered; use quarantine",
    );
  }
  const quarantineRoot = join(
    record.project_root,
    ".codeflowmu",
    "quarantine",
    record.approval_id,
  );
  const moved: Array<Record<string, unknown>> = [];
  const targets = [...record.request.resource.targets].sort(
    (a, b) => a.length - b.length,
  );
  for (const target of targets) {
    if (!existsSync(target)) continue;
    const rel = normalizedRelative(record.project_root, target);
    const destination = join(quarantineRoot, rel);
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(target, destination);
    moved.push({ from: target, to: destination });
  }
  return {
    status: "succeeded",
    evidence: [
      {
        executor: "filesystem.cleanup",
        mode: "quarantine",
        quarantine_root: quarantineRoot,
        moved,
      },
    ],
  };
}
