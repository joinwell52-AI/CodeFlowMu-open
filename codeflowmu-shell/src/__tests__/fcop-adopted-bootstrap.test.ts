import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildAdoptedBootstrapHealthCheck,
  ensureAdoptedFromSource,
  isAdoptedDirEmpty,
} from "../fcop-adopted-bootstrap.ts";

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), "adopted-bootstrap-"));
}

test("ensureAdoptedFromSource — copies adoptedSource when fcop/adopted empty", async () => {
  const root = makeTempRoot();
  try {
    const srcPending = join(root, "adoptedSource", "pending");
    mkdirSync(srcPending, { recursive: true });
    writeFileSync(join(srcPending, "0001-test.md"), "# test\n", "utf-8");
    writeFileSync(join(srcPending, "README.md"), "# readme\n", "utf-8");

    const result = await ensureAdoptedFromSource(root);
    assert.equal(result.bootstrapped, true);
    assert.equal(result.adoptedWasEmpty, true);
    assert.equal(result.adoptedSourceMissing, false);
    assert.equal(result.copied, 2);
    assert.equal(result.skipped, 0);

    const destFile = join(root, "fcop", "adopted", "pending", "0001-test.md");
    assert.ok(existsSync(destFile));
    assert.equal(readFileSync(destFile, "utf-8"), "# test\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureAdoptedFromSource — copy-if-missing does not overwrite existing files", async () => {
  const root = makeTempRoot();
  try {
    const srcPending = join(root, "adoptedSource", "pending");
    mkdirSync(srcPending, { recursive: true });
    writeFileSync(join(srcPending, "0001-test.md"), "# from source\n", "utf-8");

    const destPending = join(root, "fcop", "adopted", "pending");
    mkdirSync(destPending, { recursive: true });
    writeFileSync(join(destPending, "0001-test.md"), "# user copy\n", "utf-8");

    assert.equal(isAdoptedDirEmpty(root), false);

    const result = await ensureAdoptedFromSource(root);
    assert.equal(result.bootstrapped, false);
    assert.equal(result.copied, 0);

    assert.equal(
      readFileSync(join(destPending, "0001-test.md"), "utf-8"),
      "# user copy\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureAdoptedFromSource — missing adoptedSource does not create empty fcop/adopted", async () => {
  const root = makeTempRoot();
  try {
    const result = await ensureAdoptedFromSource(root);
    assert.equal(result.adoptedSourceMissing, true);
    assert.equal(result.bootstrapped, false);
    assert.equal(existsSync(join(root, "fcop", "adopted")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildAdoptedBootstrapHealthCheck — fail when empty adopted and no source", () => {
  const root = makeTempRoot();
  try {
    const check = buildAdoptedBootstrapHealthCheck(root);
    assert.equal(check.status, "fail");
    assert.match(check.value, /adoptedSource/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildAdoptedBootstrapHealthCheck — ok when fcop/adopted has files", async () => {
  const root = makeTempRoot();
  try {
    mkdirSync(join(root, "adoptedSource", "pending"), { recursive: true });
    writeFileSync(join(root, "adoptedSource", "pending", "x.md"), "x", "utf-8");
    await ensureAdoptedFromSource(root);

    const check = buildAdoptedBootstrapHealthCheck(root);
    assert.equal(check.status, "ok");
    assert.match(check.value, /已就绪/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
