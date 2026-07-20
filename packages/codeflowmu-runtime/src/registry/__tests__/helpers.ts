/**
 * Test helpers for AgentRegistry / RuntimeBootstrap unit tests.
 *
 * Exports:
 *   - `withTempStore(fn)`: spin up a fresh JsonFileStore in os.tmpdir,
 *     run `fn` against it, then clean up.
 *   - `validAgentSpec(overrides?)`: produce an agent spec that passes
 *     `@codeflowmu/protocol` `agent` schema validation.
 *   - `captureLogger()`: a `console`-shaped object that records calls,
 *     so tests can assert on the bootstrap summary line without leaking
 *     output into `node:test` reports.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Agent } from "@codeflowmu/protocol";

import { JsonFileStore } from "../PersistentStore.ts";

export async function withTempStore<T>(
  fn: (ctx: { store: JsonFileStore; agentsPath: string; dir: string }) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "codeflowmu-runtime-test-"));
  const agentsPath = join(dir, "agents.json");
  const store = new JsonFileStore({ path: agentsPath });
  try {
    return await fn({ store, agentsPath, dir });
  } finally {
    // Windows can EBUSY here when a concurrent test (scenario 11) leaves
    // file handles transiently busy. Retry up to 3 times with a small
    // delay before giving up; we never want a tempdir cleanup to fail
    // a passing test.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true });
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
      }
    }
    if (lastErr) {
      // Best-effort: log but don't throw — process exit cleans tmp on most OSes.
      // eslint-disable-next-line no-console
      console.warn(
        `[withTempStore] failed to rm ${dir} after retries: ${
          (lastErr as Error).message
        }`,
      );
    }
  }
}

export function validAgentSpec(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: "DEV-01",
    role: "developer",
    layer: "worker",
    node: "local",
    runtime: "local",
    workspace: "D:\\CodeFlowMu",
    skills: ["fcop", "git"],
    status: "idle",
    ...overrides,
  };
}

export interface CapturedLogger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  logs: string[];
  warns: string[];
}

export function captureLogger(): CapturedLogger {
  const logs: string[] = [];
  const warns: string[] = [];
  return {
    log: (...args) => logs.push(args.map(String).join(" ")),
    warn: (...args) => warns.push(args.map(String).join(" ")),
    logs,
    warns,
  };
}

