import { promises as fs } from "node:fs";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { normalizePath } from "./taskPathUtils.ts";
import type { LifecycleWriteOpts, TaskDoc, TaskFm } from "./types.ts";

const FRONTMATTER_OPEN = /^---\r?\n/;

function findClosingDelimiter(
  source: string,
  startIndex: number,
): { yamlBody: string; bodyStart: number } | null {
  let i = startIndex;
  let lineStart = startIndex;
  while (i < source.length) {
    const nl = source.indexOf("\n", i);
    const lineEnd = nl === -1 ? source.length : nl;
    const line = source.slice(lineStart, lineEnd).replace(/\r$/, "");
    if (line === "---") {
      return {
        yamlBody: source.slice(startIndex, lineStart),
        bodyStart: nl === -1 ? source.length : nl + 1,
      };
    }
    if (nl === -1) break;
    i = nl + 1;
    lineStart = i;
  }
  return null;
}

function assertWritable(taskPath: string, fm: TaskFm, opts?: LifecycleWriteOpts): void {
  if (opts?.allowFrozenWrite) return;
  if (fm.frozen === true) {
    throw new Error("task is frozen; modification denied");
  }
  if (normalizePath(taskPath).includes("/_lifecycle/archive/")) {
    throw new Error("task is frozen/archive; modification denied");
  }
}

export class TaskFrontmatterStore {
  async read(taskPath: string): Promise<TaskDoc> {
    const raw = await fs.readFile(taskPath, "utf-8");
    if (!FRONTMATTER_OPEN.test(raw)) {
      throw new Error(`TASK file missing YAML frontmatter: ${taskPath}`);
    }
    const openMatch = raw.match(FRONTMATTER_OPEN);
    const startIndex = openMatch![0]!.length;
    const closed = findClosingDelimiter(raw, startIndex);
    if (!closed) {
      throw new Error(`TASK file has unclosed frontmatter: ${taskPath}`);
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(closed.yamlBody);
    } catch (err) {
      throw new Error(
        `TASK frontmatter YAML parse failed: ${taskPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const fm = (parsed && typeof parsed === "object" ? parsed : {}) as TaskFm;
    const body = raw.slice(closed.bodyStart);
    return { fm, body, raw };
  }

  async write(
    taskPath: string,
    fm: TaskFm,
    body: string,
    opts?: LifecycleWriteOpts,
  ): Promise<void> {
    assertWritable(taskPath, fm, opts);
    const yamlBlock = stringifyYaml(fm, { lineWidth: 0 }).trimEnd();
    const content = `---\n${yamlBlock}\n---\n${body}`;
    await fs.writeFile(taskPath, content, "utf-8");
  }

  async patch(
    taskPath: string,
    patch: Partial<TaskFm>,
    opts?: LifecycleWriteOpts,
  ): Promise<void> {
    const { fm, body } = await this.read(taskPath);
    assertWritable(taskPath, fm, opts);
    await this.write(taskPath, { ...fm, ...patch }, body, opts);
  }
}
