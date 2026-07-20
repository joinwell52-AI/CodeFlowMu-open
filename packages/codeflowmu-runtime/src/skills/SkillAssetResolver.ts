import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Project-local Playbook packages override the mother application's packages. */
export function skillAssetCandidatePaths(projectRoot: string, relPath: string): string[] {
  const clean = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean || isAbsolute(relPath)) return [];

  const roots = [resolve(projectRoot)];
  const hostRoot = process.env["CODEFLOWMU_HOST_ROOT"]?.trim();
  if (hostRoot) {
    const resolvedHost = resolve(hostRoot);
    if (!roots.some((root) => root.toLowerCase() === resolvedHost.toLowerCase())) {
      roots.push(resolvedHost);
    }
  }

  return roots
    .map((root) => ({ root, candidate: resolve(root, clean) }))
    .filter(({ root, candidate }) => isWithin(root, candidate))
    .map(({ candidate }) => candidate);
}

export function resolveSkillAssetPathSync(projectRoot: string, relPath: string): string | null {
  return skillAssetCandidatePaths(projectRoot, relPath).find((path) => existsSync(path)) ?? null;
}

export async function resolveSkillAssetPath(
  projectRoot: string,
  relPath: string,
): Promise<string | null> {
  for (const path of skillAssetCandidatePaths(projectRoot, relPath)) {
    try {
      await access(path);
      return path;
    } catch {
      // Try the mother application after a missing project-local override.
    }
  }
  return null;
}
