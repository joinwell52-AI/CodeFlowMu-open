/**
 * Test helpers for the Skill subsystem (Sprint S5 Phase E).
 *
 * Mirrors `src/review/__tests__/helpers.ts` — `withTempDir` for an
 * isolated `os.tmpdir()`-rooted sandbox + `quietLogger` capturing
 * the 3 logger surfaces. Plant fixtures via `plantSkill`.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Run `fn` against a fresh temp dir; the dir is removed when `fn`
 * resolves (or rejects). Robust against Windows EBUSY (a lingering
 * antivirus open) — retries cleanup once.
 */
export async function withTempSkill<T>(
  fn: (paths: {
    rootDir: string;
    skillsDir: string;
    stateDir: string;
  }) => Promise<T>,
): Promise<T> {
  const rootDir = await mkdtemp(join(tmpdir(), "codeflowmu-skill-test-"));
  const skillsDir = join(rootDir, "skills");
  const stateDir = join(rootDir, "state");
  await mkdir(skillsDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  try {
    return await fn({ rootDir, skillsDir, stateDir });
  } finally {
    try {
      await rm(rootDir, { recursive: true, force: true });
    } catch {
      await new Promise((r) => setTimeout(r, 50));
      try {
        await rm(rootDir, { recursive: true, force: true });
      } catch {
        // intentional: leave the temp dir for diagnostics if Windows
        // still has it locked; CI cleans /tmp out of band.
      }
    }
  }
}

/** Captured logger — same shape as `review/__tests__/helpers.ts`. */
export interface CapturedLogger {
  logs: string[];
  warns: string[];
  errors: string[];
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export function quietLogger(): CapturedLogger {
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    warns,
    errors,
    info: (msg: string) => {
      logs.push(msg);
    },
    warn: (msg: string) => {
      warns.push(msg);
    },
    error: (msg: string) => {
      errors.push(msg);
    },
  };
}

/**
 * Plant a `<skill_id>.json` file. Pass a partial; sane defaults fill
 * in the schema-required fields (so a TS-7.5 test only needs
 * `{ skill_id: "fcop" }` to get a fully valid fcop skill).
 */
export async function plantSkill(
  skillsDir: string,
  partial: Record<string, unknown> & { skill_id: string },
): Promise<string> {
  const filename = `${partial["skill_id"]}.json`;
  const path = join(skillsDir, filename);
  const body = JSON.stringify(buildSkill(partial), null, 2);
  await writeFile(path, body, "utf-8");
  return path;
}

function buildSkill(
  partial: Record<string, unknown> & { skill_id: string },
): Record<string, unknown> {
  return {
    skill_id: partial["skill_id"],
    version: partial["version"] ?? "1.0.0",
    provided_by: partial["provided_by"] ?? {
      type: "mcp_server",
      transport: "stdio",
      command: "node fcop-mcp",
    },
    tools: partial["tools"] ?? [{ name: "drop_task" }],
    available_to_roles: partial["available_to_roles"] ?? ["DEV", "REVIEW"],
    required_kernel: partial["required_kernel"] ?? ["fcop@>=1.0"],
    ...(partial["compatible_runtimes"] !== undefined
      ? { compatible_runtimes: partial["compatible_runtimes"] }
      : {}),
    ...(partial["displayName"] !== undefined
      ? { displayName: partial["displayName"] }
      : {}),
    ...(partial["homepage"] !== undefined
      ? { homepage: partial["homepage"] }
      : {}),
    ...(partial["license"] !== undefined ? { license: partial["license"] } : {}),
  };
}

/** Plant an arbitrary file (non-.json, .tmp, or invalid JSON). */
export async function plantRaw(
  skillsDir: string,
  filename: string,
  body: string,
): Promise<string> {
  const path = join(skillsDir, filename);
  await writeFile(path, body, "utf-8");
  return path;
}

