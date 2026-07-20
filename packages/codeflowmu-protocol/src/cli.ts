import { readFile } from "node:fs/promises";
import path from "node:path";

import matter from "gray-matter";

import { isSchemaName, validate, type SchemaName } from "./validator.ts";

interface CliArgs {
  type: SchemaName;
  filePath: string;
  expectFail: boolean;
}

function parseArgs(argv: string[]): CliArgs | { error: string } {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const flags = new Set(argv.filter((a) => a.startsWith("--")));

  if (positional.length < 2) {
    return { error: "Usage: codeflowmu-validate <type> <path> [--expect-fail]" };
  }
  const [type, filePath] = positional;
  if (!isSchemaName(type ?? "")) {
    return {
      error:
        `Unknown type "${type}". Must be one of: agent | task | review | session | skill`,
    };
  }
  return {
    type: type as SchemaName,
    filePath: filePath ?? "",
    expectFail: flags.has("--expect-fail"),
  };
}

async function loadDataFromFile(
  type: SchemaName,
  filePath: string,
): Promise<unknown> {
  const raw = await readFile(filePath, "utf-8");
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".md" || ext === ".markdown") {
    const { data } = matter(raw);
    return data;
  }
  if (ext === ".json") {
    return JSON.parse(raw);
  }
  if (type === "task" || type === "review") {
    const { data } = matter(raw);
    return data;
  }
  return JSON.parse(raw);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error("[codeflowmu-validate]", parsed.error);
    process.exit(2);
  }

  const { type, filePath, expectFail } = parsed;
  const absPath = path.resolve(filePath);

  let data: unknown;
  try {
    data = await loadDataFromFile(type, absPath);
  } catch (err) {
    console.error(`[codeflowmu-validate] failed to read/parse ${absPath}:`, err);
    process.exit(2);
  }

  const result = await validate(type, data);

  if (result.valid) {
    if (expectFail) {
      console.error(
        `[codeflowmu-validate] FAIL — file ${absPath} validates as ${type}, but --expect-fail was set.`,
      );
      process.exit(1);
    }
    console.log(`[codeflowmu-validate] OK — ${absPath} is a valid ${type}.`);
    process.exit(0);
  }

  if (expectFail) {
    console.log(
      `[codeflowmu-validate] OK (expected fail) — ${absPath} is INVALID as ${type}, as expected.`,
    );
    if (result.errors) {
      console.log("  reasons:");
      for (const err of result.errors) {
        console.log(`    - ${err.instancePath || "(root)"} ${err.message}`);
      }
    }
    process.exit(0);
  }

  console.error(`[codeflowmu-validate] FAIL — ${absPath} is INVALID as ${type}:`);
  if (result.errors) {
    for (const err of result.errors) {
      console.error(`  - ${err.instancePath || "(root)"} ${err.message}`);
      if (err.params) {
        console.error(`    params: ${JSON.stringify(err.params)}`);
      }
    }
  }
  process.exit(1);
}

void main();

