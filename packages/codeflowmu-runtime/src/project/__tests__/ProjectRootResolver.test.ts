import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";

import { resolveProjectRoot, sameProjectRoot } from "../ProjectRootResolver.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

it("normalizes an fcop data root without creating fcop/fcop", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-root-"));
  roots.push(root);
  const fcop = join(root, "fcop");
  await mkdir(join(fcop, "_lifecycle"), { recursive: true });
  await writeFile(join(fcop, "fcop.json"), "{}", "utf8");
  const resolved = resolveProjectRoot(fcop);
  assert.equal(resolved.projectRoot, root);
  assert.equal(resolved.fcopRoot, fcop);
  assert.equal(resolved.normalizedFromFcopRoot, true);
  assert.equal(sameProjectRoot(root, fcop), true);
});
