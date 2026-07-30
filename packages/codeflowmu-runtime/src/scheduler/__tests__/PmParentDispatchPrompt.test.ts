import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dispatcher = readFileSync(resolve(here, "../TaskDispatcher.ts"), "utf8");

test("PM cold-path dispatch requires a strong parent for every worker task", () => {
  assert.match(dispatcher, /\*\*Parent rule\*\*/);
  assert.match(dispatcher, /parent="\$\{taskId\}"/);
  assert.match(dispatcher, /inherits \\`thread_key\\` from that open parent/);
  assert.match(dispatcher, /Never replace \\`parent\\` with a sibling task or with \\`references\\`/);
});

test("PM planning keeps DEV, QA, and OPS work packages on the current long-task tree", () => {
  assert.match(dispatcher, /pick DEV \/ OPS \/ QA based on task content/);
  assert.match(dispatcher, /each dispatch creates a \*\*new\*\* worker TASK/);
  assert.match(dispatcher, /The first \\`references\\` item must be the current TASK/);
});
