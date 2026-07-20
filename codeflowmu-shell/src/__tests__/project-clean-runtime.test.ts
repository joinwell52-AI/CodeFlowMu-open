import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyPostCleanRuntime } from "../project-clean-runtime.ts";

test("verifyPostCleanRuntime ok on empty project root", () => {
  const root = mkdtempSync(join(tmpdir(), "clean-verify-"));
  try {
    const v = verifyPostCleanRuntime(root);
    assert.equal(v.ok, true, v.summary);
    assert.ok(v.items.every((i) => i.status === "ok"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyPostCleanRuntime fails when fcop/ still exists", () => {
  const root = mkdtempSync(join(tmpdir(), "clean-verify-"));
  try {
    mkdirSync(join(root, "fcop"), { recursive: true });
    writeFileSync(join(root, "fcop", "fcop.json"), "{}");
    const v = verifyPostCleanRuntime(root);
    assert.equal(v.ok, false);
    assert.ok(v.items.some((i) => i.id === "absent_fcop" && i.status === "fail"));
    assert.ok(v.items.some((i) => i.id === "no_fcop_json" && i.status === "fail"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
