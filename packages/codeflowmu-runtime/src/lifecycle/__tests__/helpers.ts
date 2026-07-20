import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import type { TaskFm } from "../types.ts";

export interface LifecycleTestCtx {
  rootDir: string;
  lifecycleRoot: string;
}

export async function withTempLifecycle<T>(
  fn: (ctx: LifecycleTestCtx) => Promise<T>,
): Promise<T> {
  const rootDir = await mkdtemp(join(tmpdir(), "codeflowmu-lifecycle-test-"));
  const lifecycleRoot = join(rootDir, "fcop", "_lifecycle");
  for (const stage of ["inbox", "active", "review", "done", "archive"]) {
    await mkdir(join(lifecycleRoot, stage), { recursive: true });
  }
  try {
    return await fn({ rootDir, lifecycleRoot });
  } finally {
    await rm(rootDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function taskMarkdown(fm: TaskFm, body = "# Task\n"): string {
  const yamlBlock = stringifyYaml(fm, { lineWidth: 0 }).trimEnd();
  return `---\n${yamlBlock}\n---\n${body}`;
}

export async function writeTaskAt(
  lifecycleRoot: string,
  stage: string,
  filename: string,
  fm: TaskFm,
  body?: string,
): Promise<string> {
  const path = join(lifecycleRoot, stage, filename);
  await writeFile(path, taskMarkdown(fm, body), "utf-8");
  return path;
}
