import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type CodeflowmuVersionManifest = {
  codeflowmu: string;
  shell: string;
  runtime: string;
  protocol: string;
  mobile_pwa: string;
  mobile_api: string;
  gateway: string;
  sw_cache: string;
};

const VERSION_FILENAME = ".codeflowmu-version.json";
const VERSION_HISTORY_FILENAME = ".codeflowmu-version-history.json";
const OPEN_VERSION_FILENAME = "VERSION.json";
const OPEN_VERSION_HISTORY_FILENAME = "VERSION_HISTORY.json";

export type CodeflowmuVersionHistoryEntry = {
  version: string;
  date: string;
  tasks: string[];
  title: string;
  changes: string[];
  affected?: string[];
};

function resolveMonorepoRoot(): string | null {
  const shellPkgRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
  if (basename(shellPkgRoot) !== "codeflowmu-shell") return null;
  const parent = dirname(shellPkgRoot);
  if (
    !existsSync(join(parent, VERSION_FILENAME)) &&
    !existsSync(join(parent, OPEN_VERSION_FILENAME))
  ) return null;
  return parent;
}

export function readCodeflowmuVersionManifest(): CodeflowmuVersionManifest | null {
  const repoRoot = resolveMonorepoRoot();
  if (!repoRoot) return null;
  const privatePath = join(repoRoot, VERSION_FILENAME);
  const path = existsSync(privatePath) ? privatePath : join(repoRoot, OPEN_VERSION_FILENAME);
  if (!existsSync(path)) return null;
  try {
    const source = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const openVersion = typeof source["version"] === "string" ? source["version"] : null;
    const raw = openVersion
      ? {
          codeflowmu: openVersion,
          shell: openVersion,
          runtime: openVersion,
          protocol: "v3",
          mobile_pwa: openVersion,
          mobile_api: openVersion,
          gateway: "official-demo",
          sw_cache: openVersion,
        }
      : source as Partial<CodeflowmuVersionManifest>;
    const required: (keyof CodeflowmuVersionManifest)[] = [
      "codeflowmu",
      "shell",
      "runtime",
      "protocol",
      "mobile_pwa",
      "mobile_api",
      "gateway",
      "sw_cache",
    ];
    for (const key of required) {
      if (typeof raw[key] !== "string" || !raw[key]?.trim()) return null;
    }
    return raw as CodeflowmuVersionManifest;
  } catch {
    return null;
  }
}

function isValidHistoryEntry(raw: unknown): raw is CodeflowmuVersionHistoryEntry {
  if (!raw || typeof raw !== "object") return false;
  const e = raw as Partial<CodeflowmuVersionHistoryEntry>;
  if (typeof e.version !== "string" || !e.version.trim()) return false;
  if (typeof e.date !== "string" || !e.date.trim()) return false;
  if (typeof e.title !== "string" || !e.title.trim()) return false;
  if (!Array.isArray(e.tasks) || !e.tasks.every((t) => typeof t === "string")) return false;
  if (!Array.isArray(e.changes) || !e.changes.every((c) => typeof c === "string")) return false;
  if (
    e.affected !== undefined &&
    (!Array.isArray(e.affected) || !e.affected.every((a) => typeof a === "string"))
  ) {
    return false;
  }
  return true;
}

export function readCodeflowmuVersionHistory(): CodeflowmuVersionHistoryEntry[] | null {
  const repoRoot = resolveMonorepoRoot();
  if (!repoRoot) return null;
  const privatePath = join(repoRoot, VERSION_HISTORY_FILENAME);
  const path = existsSync(privatePath)
    ? privatePath
    : join(repoRoot, OPEN_VERSION_HISTORY_FILENAME);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    if (!parsed.every(isValidHistoryEntry)) return null;
    return parsed as CodeflowmuVersionHistoryEntry[];
  } catch {
    return null;
  }
}
