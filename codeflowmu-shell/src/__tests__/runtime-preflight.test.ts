import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

const shellRoot = join(import.meta.dirname, "..", "..");
const repoRoot = join(shellRoot, "..");
const preflightPath = join(shellRoot, "scripts", "runtime-preflight.cjs");

describe("runtime dependency preflight", () => {
  it("checks the complete production import closure before launching", async () => {
    const preflight = await readFile(preflightPath, "utf-8");

    assert.match(preflight, /"yaml"/);
    assert.match(preflight, /findMissingModules/);
    assert.match(preflight, /npmCommand/);
    assert.match(preflight, /Refreshing release dependencies/);

    const result = spawnSync(process.execPath, [preflightPath, "--check-only"], {
      cwd: shellRoot,
      encoding: "utf-8",
      env: process.env,
      windowsHide: true,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production dependencies ready/);
    assert.match(result.stdout, /yaml/);
  });

  it("keeps Open start behind the preflight instead of importing TS directly", async () => {
    const builder = await readFile(
      join(repoRoot, "scripts", "build-open-dev-team.mjs"),
      "utf-8",
    );
    const verifier = await readFile(
      join(repoRoot, "scripts", "verify-open-dev-team.mjs"),
      "utf-8",
    );

    assert.match(
      builder,
      /pkg\.scripts\.start = 'node scripts\/runtime-preflight\.cjs --open'/,
    );
    assert.match(builder, /writeOpenRuntimePreflight\(releaseManifest\)/);
    assert.match(verifier, /Open Shell start must run dependency preflight/);
    assert.match(verifier, /Open Shell runtime dependencies must declare yaml/);
  });
});
