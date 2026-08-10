import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

test("PWA force update warms the target cache and preserves it until reload", () => {
  const source = readFileSync(
    join(repoRoot, "codeflowmu-desktop", "mobile", "mobile.js"),
    "utf8",
  );
  assert.match(source, /var targetCacheName = PWA_CACHE_PREFIX \+ PWA_CACHE_BUST/);
  assert.match(source, /warmCriticalAssets/);
  assert.match(source, /controllerchange/);
  assert.match(source, /name !== targetCacheName/);
  assert.match(source, /name\.indexOf\(PWA_CACHE_PREFIX\) === 0/);
  assert.doesNotMatch(source, /name\.indexOf\("codeflowmu-pwa-v"\)/);
  assert.doesNotMatch(source, /var names = keys\.slice\(\)/);
});

test("PWA shell assets use network-first with cache fallback", () => {
  const source = readFileSync(
    join(repoRoot, "codeflowmu-desktop", "mobile", "sw.js"),
    "utf8",
  );
  assert.match(source, /function isShellAssetRequest/);
  assert.match(source, /fetch\(event\.request\)[\s\S]*caches\.match\(event\.request\)/);
  assert.match(source, /key\.startsWith\(CACHE_PREFIX\)/);
  assert.doesNotMatch(source, /keys\.filter\(\(k\) => k !== CACHE_NAME\)/);
  assert.doesNotMatch(source, /path\.endsWith\("\/mobile\/mobile\.css"\)/);
});
