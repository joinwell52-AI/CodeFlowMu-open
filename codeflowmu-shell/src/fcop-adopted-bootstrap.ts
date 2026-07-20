/**
 * Bootstrap fcop/adopted/ from project-root adoptedSource/ (copy-if-missing).
 *
 * adoptedSource/ is the canonical init source; runtime reads fcop/adopted/ only.
 * Do not embed adopted clause markdown in code templates.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";

export const ADOPTED_SOURCE_DIR_REL = "adoptedSource";
export const ADOPTED_TARGET_DIR_REL = "fcop/adopted";

export interface AdoptedBootstrapResult {
  bootstrapped: boolean;
  adoptedWasEmpty: boolean;
  adoptedSourceMissing: boolean;
  copied: number;
  skipped: number;
}

export interface AdoptedBootstrapHealthCheck {
  status: "ok" | "fail" | "warn";
  value: string;
}

export function adoptedSourcePath(projectRoot: string): string {
  return join(projectRoot, ADOPTED_SOURCE_DIR_REL);
}

export function adoptedTargetPath(projectRoot: string): string {
  return join(projectRoot, "fcop", "adopted");
}

/** True when fcop/adopted/ is missing or contains no files (dirs alone do not count). */
export function isAdoptedDirEmpty(projectRoot: string): boolean {
  const target = adoptedTargetPath(projectRoot);
  if (!existsSync(target)) return true;
  return countFilesRecursiveSync(target) === 0;
}

function countFilesRecursiveSync(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        count += countFilesRecursiveSync(p);
      } else if (st.isFile()) {
        count++;
      }
    }
  } catch {
    return 0;
  }
  return count;
}

async function copyTreeIfMissing(
  srcDir: string,
  destDir: string,
): Promise<{ copied: number; skipped: number }> {
  let copied = 0;
  let skipped = 0;
  await mkdir(destDir, { recursive: true });

  const entries = readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      const sub = await copyTreeIfMissing(srcPath, destPath);
      copied += sub.copied;
      skipped += sub.skipped;
    } else if (entry.isFile()) {
      try {
        await access(destPath);
        skipped++;
      } catch {
        await mkdir(dirname(destPath), { recursive: true });
        await copyFile(srcPath, destPath);
        copied++;
      }
    }
  }
  return { copied, skipped };
}

/**
 * When fcop/adopted/ is empty/missing, recursively copy adoptedSource/ → fcop/adopted/
 * (copy-if-missing only). If adoptedSource/ is missing, do not create an empty adopted tree.
 */
export async function ensureAdoptedFromSource(
  projectRoot: string,
): Promise<AdoptedBootstrapResult> {
  const adoptedWasEmpty = isAdoptedDirEmpty(projectRoot);
  if (!adoptedWasEmpty) {
    return {
      bootstrapped: false,
      adoptedWasEmpty: false,
      adoptedSourceMissing: false,
      copied: 0,
      skipped: 0,
    };
  }

  const src = adoptedSourcePath(projectRoot);
  if (!existsSync(src)) {
    return {
      bootstrapped: false,
      adoptedWasEmpty: true,
      adoptedSourceMissing: true,
      copied: 0,
      skipped: 0,
    };
  }

  const dest = adoptedTargetPath(projectRoot);
  const { copied, skipped } = await copyTreeIfMissing(src, dest);
  return {
    bootstrapped: copied > 0 || skipped > 0,
    adoptedWasEmpty: true,
    adoptedSourceMissing: false,
    copied,
    skipped,
  };
}

/** Health check for /api/v2/env/check — fail when adopted empty and source missing. */
export function buildAdoptedBootstrapHealthCheck(
  projectRoot: string,
): AdoptedBootstrapHealthCheck {
  const empty = isAdoptedDirEmpty(projectRoot);
  const srcExists = existsSync(adoptedSourcePath(projectRoot));

  if (!empty) {
    const fileCount = countFilesRecursiveSync(adoptedTargetPath(projectRoot));
    return {
      status: "ok",
      value: `fcop/adopted/ 已就绪（${fileCount} 个文件）`,
    };
  }

  if (!srcExists) {
    return {
      status: "fail",
      value:
        "fcop/adopted/ 为空且 adoptedSource/ 不存在 — 请恢复项目根 adoptedSource/ 或手动填充 fcop/adopted/",
    };
  }

  return {
    status: "warn",
    value:
      "fcop/adopted/ 为空 — 启动时应从 adoptedSource/ 复制；请重启 shell 或运行一键初始化",
  };
}
