/**
 * Test helpers for the Review-layer tests (Sprint S4).
 *
 * Mirrors `scheduler/__tests__/helpers.ts` (which mirrors registry/session
 * helpers) so cleanup semantics, EBUSY-retry behavior, and waitFor support
 * are uniform across phases.
 */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

export interface ReviewTestCtx {
  /** Root tempdir for the test (auto-cleaned). */
  rootDir: string;
  /** Inbox dir (`<rootDir>/inbox/`). */
  inboxDir: string;
  /** State dir (sessions/, transcripts/, agents.json). */
  stateDir: string;
  /** Reviews dir (`<rootDir>/reviews/`). */
  reviewsDir: string;
}

export async function withTempReview<T>(
  fn: (ctx: ReviewTestCtx) => Promise<T>,
): Promise<T> {
  const rootDir = await mkdtemp(join(tmpdir(), "codeflowmu-review-test-"));
  const inboxDir = join(rootDir, "inbox");
  const stateDir = join(rootDir, "state");
  const reviewsDir = join(rootDir, "reviews");
  await mkdir(inboxDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(reviewsDir, { recursive: true });
  try {
    return await fn({ rootDir, inboxDir, stateDir, reviewsDir });
  } finally {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(rootDir, { recursive: true, force: true });
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 30 * (attempt + 1)));
      }
    }
    if (lastErr) {
      // eslint-disable-next-line no-console -- best-effort
      console.warn(
        `[withTempReview] failed to rm ${rootDir}: ${
          (lastErr as Error).message
        }`,
      );
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor<T>(
  predicate: () =>
    | T
    | undefined
    | null
    | false
    | Promise<T | undefined | null | false>,
  opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<NonNullable<T>> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const v = await predicate();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) {
      throw new Error(
        `waitFor timed out after ${timeoutMs}ms${
          opts.what ? ` (waiting for: ${opts.what})` : ""
        }`,
      );
    }
    await sleep(intervalMs);
  }
}

export function quietLogger(): {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  logs: string[];
  warns: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    info: (...args) => logs.push(args.map(String).join(" ")),
    warn: (...args) => warns.push(args.map(String).join(" ")),
    error: (...args) => errors.push(args.map(String).join(" ")),
    logs,
    warns,
    errors,
  };
}

/**
 * Read a written REVIEW-*.md file and return its YAML frontmatter parsed
 * as an object. Body returned for caller assertions.
 */
export async function readReviewFile(filepath: string): Promise<{
  frontmatter: Record<string, unknown>;
  body: string;
}> {
  const text = await readFile(filepath, "utf-8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    throw new Error(`readReviewFile: no front-matter in ${filepath}`);
  }
  const yaml = match[1] ?? "";
  const body = match[2] ?? "";
  return {
    frontmatter: parseYaml(yaml) as Record<string, unknown>,
    body,
  };
}

