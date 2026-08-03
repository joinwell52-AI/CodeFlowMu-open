import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type ProjectRootResolution = {
  projectRoot: string;
  fcopRoot: string;
  normalizedFromFcopRoot: boolean;
};

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve a business project root from either that root or its fcop directory. */
export function resolveProjectRoot(input: string): ProjectRootResolution {
  const candidate = resolve(input);
  const looksLikeFcopRoot =
    basename(candidate).toLowerCase() === "fcop" &&
    (existsSync(join(candidate, "fcop.json")) ||
      isDirectory(join(candidate, "_lifecycle")) ||
      isDirectory(join(candidate, "tasks")));
  const projectRoot = looksLikeFcopRoot ? dirname(candidate) : candidate;
  return {
    projectRoot,
    fcopRoot: join(projectRoot, "fcop"),
    normalizedFromFcopRoot: looksLikeFcopRoot,
  };
}

export function sameProjectRoot(left: string, right: string): boolean {
  const a = resolveProjectRoot(left).projectRoot;
  const b = resolveProjectRoot(right).projectRoot;
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}
