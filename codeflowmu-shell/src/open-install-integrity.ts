import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { promises as fs } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const DEFAULT_AUDIT_INTERVAL_MS = 1_500;
const PROTECTED_DIRS = [
  "adoptedSource",
  "codeflowmu-desktop",
  "codeflowmu-shell",
  "docs",
  "fcop/adopted",
  "packages",
  "skills",
  "templates",
] as const;
const PROTECTED_ROOT_FILE = /^(?:AGENTS\.md|CLAUDE\.md|CODE_OF_CONDUCT\.md|CONTRIBUTING\.md|INSTALL\.md|LICENSE|OPEN-BOUNDARY\.md|README(?:\.zh)?\.md|RELEASES\.md|RELEASE_MANIFEST\.json|SECURITY\.md|SHA256SUMS|START-CODEFLOWMU-OPEN\.bat|UPDATE\.md|VERSION(?:_HISTORY)?\.json|codeflowmu\.team\.json|package(?:-lock)?\.json)$/i;
const PROTECTED_NEW_FILE = /\.(?:bat|cjs|css|html|js|json|md|mjs|py|sh|ts|tsx|yaml|yml)$/i;
const SKIP_DIR_NAMES = new Set([".git", ".venv", "node_modules", "venv"]);

type BaselineEntry = {
  bytes: Buffer;
  sha256: string;
};

export type OpenInstallIntegrityEvent = {
  action: "removed_untrusted" | "restored";
  path: string;
};

export type OpenInstallIntegrityGuard = {
  auditNow(): Promise<OpenInstallIntegrityEvent[]>;
  baselineFileCount: number;
  stop(): void;
};

export type OpenInstallIntegrityOptions = {
  auditIntervalMs?: number;
  onEvent?: (event: OpenInstallIntegrityEvent) => void;
};

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(root: string, dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (!isInside(root, full)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await collectFiles(root, full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

async function ensureSafeParent(hostRoot: string, filePath: string): Promise<void> {
  const parent = dirname(filePath);
  if (!isInside(hostRoot, parent)) throw new Error(`restore escaped host root: ${filePath}`);
  const rel = relative(hostRoot, parent);
  let cursor = hostRoot;
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        await fs.rm(cursor, { recursive: true, force: true });
        await fs.mkdir(cursor);
      }
    } catch {
      await fs.mkdir(cursor);
    }
  }
}

export async function startOpenInstallIntegrityGuard(
  rawHostRoot: string,
  options: OpenInstallIntegrityOptions = {},
): Promise<OpenInstallIntegrityGuard> {
  const hostRoot = resolve(rawHostRoot);
  const protectedRoots = (
    await Promise.all(
      PROTECTED_DIRS.map(async (name) => {
        const path = join(hostRoot, name);
        return (await exists(path)) ? path : null;
      }),
    )
  ).filter((value): value is string => Boolean(value));

  const baselinePaths: string[] = [];
  for (const root of protectedRoots) await collectFiles(hostRoot, root, baselinePaths);
  const rootEntries = await fs.readdir(hostRoot, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (entry.isFile() && PROTECTED_ROOT_FILE.test(entry.name)) {
      baselinePaths.push(join(hostRoot, entry.name));
    }
  }

  const baseline = new Map<string, BaselineEntry>();
  for (const filePath of baselinePaths) {
    const bytes = await fs.readFile(filePath);
    baseline.set(resolve(filePath), { bytes, sha256: sha256(bytes) });
  }

  let auditTail: Promise<unknown> = Promise.resolve();
  let stopped = false;
  const emit = (event: OpenInstallIntegrityEvent) => {
    options.onEvent?.(event);
    process.stderr.write(
      `[open-integrity] ${event.action}: ${relative(hostRoot, event.path)}\n`,
    );
  };

  const runAudit = async (): Promise<OpenInstallIntegrityEvent[]> => {
    if (stopped) return [];
    const events: OpenInstallIntegrityEvent[] = [];
    try {
      for (const root of protectedRoots) {
        const current: string[] = [];
        await collectFiles(hostRoot, root, current);
        for (const filePath of current) {
          const absolute = resolve(filePath);
          if (baseline.has(absolute) || !PROTECTED_NEW_FILE.test(basename(absolute))) continue;
          await fs.rm(absolute, { force: true });
          const event: OpenInstallIntegrityEvent = {
            action: "removed_untrusted",
            path: absolute,
          };
          events.push(event);
          emit(event);
        }
      }

      for (const [filePath, expected] of baseline) {
        let intact = false;
        try {
          const stat = await fs.lstat(filePath);
          if (stat.isFile() && !stat.isSymbolicLink()) {
            intact = sha256(await fs.readFile(filePath)) === expected.sha256;
          }
        } catch {
          intact = false;
        }
        if (intact) continue;
        await ensureSafeParent(hostRoot, filePath);
        await fs.writeFile(filePath, expected.bytes);
        const event: OpenInstallIntegrityEvent = { action: "restored", path: filePath };
        events.push(event);
        emit(event);
      }
      return events;
    } finally {
      // Serialized by auditNow; no shared running flag is needed here.
    }
  };

  const auditNow = (): Promise<OpenInstallIntegrityEvent[]> => {
    if (stopped) return Promise.resolve([]);
    const next = auditTail.then(runAudit, runAudit);
    auditTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const watchers: FSWatcher[] = [];
  for (const root of protectedRoots) {
    try {
      const watcher = watch(root, { recursive: true }, () => {
        void auditNow();
      });
      watcher.on("error", () => undefined);
      watchers.push(watcher);
    } catch {
      // The periodic audit below remains the authoritative fallback.
    }
  }
  const interval = setInterval(
    () => void auditNow(),
    Math.max(50, options.auditIntervalMs ?? DEFAULT_AUDIT_INTERVAL_MS),
  );
  interval.unref();

  return {
    auditNow,
    baselineFileCount: baseline.size,
    stop() {
      stopped = true;
      clearInterval(interval);
      for (const watcher of watchers) watcher.close();
    },
  };
}
