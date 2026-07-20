#!/usr/bin/env node
/**
 * trim-task-transitions TASK-20260611-102 --keep 30
 */
import { trimTaskTransitions } from "../src/lifecycle/trimTaskTransitions.ts";
import { join, resolve } from "node:path";

function parseArgs(argv: string[]): { taskId: string; keep: number; projectRoot: string } {
  let taskId = "";
  let keep = 30;
  let projectRoot = process.cwd();
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--keep" && argv[i + 1]) {
      keep = Math.max(1, Number(argv[++i]));
    } else if (a === "--project-root" && argv[i + 1]) {
      projectRoot = resolve(argv[++i]!);
    } else if (!a.startsWith("-") && !taskId) {
      taskId = a.replace(/\.md$/i, "");
    }
  }
  if (!taskId) {
    console.error("Usage: trim-task-transitions TASK-xxx [--keep N] [--project-root PATH]");
    process.exit(1);
  }
  return { taskId, keep, projectRoot };
}

const { taskId, keep, projectRoot } = parseArgs(process.argv);
const lifecycleRoot = join(projectRoot, "fcop", "_lifecycle");

const result = await trimTaskTransitions({ lifecycleRoot, taskId, keep });
console.log(JSON.stringify(result, null, 2));
