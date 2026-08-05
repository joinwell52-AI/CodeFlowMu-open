import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { allocateTaskSequence } from "../TaskIdentityAllocator.ts";

test("all task writers share one durable collision-free sequence", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-task-id-"));
  try {
    const inbox = join(root, "fcop", "_lifecycle", "inbox");
    await mkdir(inbox, { recursive: true });
    await writeFile(join(inbox, "TASK-20260805-007-PM-to-DEV.md"), "existing");

    const reserved = Array.from({ length: 12 }, () =>
      allocateTaskSequence(root, "20260805"));
    assert.deepEqual(reserved, [
      "008", "009", "010", "011", "012", "013",
      "014", "015", "016", "017", "018", "019",
    ]);
    assert.equal(new Set(reserved).size, reserved.length);
    assert.equal(allocateTaskSequence(root, "20260805"), "020");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
