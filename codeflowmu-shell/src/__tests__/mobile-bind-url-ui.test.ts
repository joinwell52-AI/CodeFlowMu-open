import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

describe("mobile bind URL UI", () => {
  it("uses short bind_id/token query for LAN links and QR links", async () => {
    const panelHtml = await readFile(
      join(repoRoot, "codeflowmu-desktop", "panel", "index.html"),
      "utf-8",
    );

    const compactFn = panelHtml.match(
      /function mobileCompactBindQuery[\s\S]*?\n}/,
    )?.[0] ?? "";
    const lanQrFn = panelHtml.match(/function buildMobileLanQrUrl[\s\S]*?\n}/)?.[0] ?? "";
    const gatewayQrFn =
      panelHtml.match(/function buildMobileGatewayQrUrl[\s\S]*?\n}/)?.[0] ?? "";
    const lanCopyFn =
      panelHtml.match(/function buildMobileLanBindUrl[\s\S]*?\n}/)?.[0] ?? "";

    assert.match(compactFn, /bind_id=\$\{encodeURIComponent\(bindId\)\}&token=/);
    assert.match(lanQrFn, /mobileCompactBindQuery\(bindId, token\)/);
    assert.doesNotMatch(lanQrFn, /api_base|#\/bind|mobileBindQuery/);
    assert.match(gatewayQrFn, /mobileCompactBindQuery\(bindId, token\)/);
    assert.doesNotMatch(gatewayQrFn, /api_base|#\/bind|mobileBindQuery/);

    assert.match(lanCopyFn, /mobileCompactBindQuery\(bindId, token\)/);
    assert.doesNotMatch(lanCopyFn, /api_base|mobileBindQuery\(bindId, token, root\)/);
    assert.doesNotMatch(lanCopyFn, /#\/bind/);
  });

  it("mobile app accepts short id/t parameters", async () => {
    const mobileIndex = await readFile(
      join(repoRoot, "codeflowmu-desktop", "mobile", "index.html"),
      "utf-8",
    );
    const mobileJs = await readFile(
      join(repoRoot, "codeflowmu-desktop", "mobile", "mobile.js"),
      "utf-8",
    );

    assert.match(mobileIndex, /params\.get\("id"\)/);
    assert.match(mobileIndex, /params\.get\("t"\)/);
    assert.match(mobileJs, /search\.get\("id"\)/);
    assert.match(mobileJs, /search\.get\("t"\)/);
  });

  it("mobile shell bumps cache version and keeps shell files network-only", async () => {
    const mobileIndex = await readFile(
      join(repoRoot, "codeflowmu-desktop", "mobile", "index.html"),
      "utf-8",
    );
    const mobileJs = await readFile(
      join(repoRoot, "codeflowmu-desktop", "mobile", "mobile.js"),
      "utf-8",
    );
    const sw = await readFile(join(repoRoot, "codeflowmu-desktop", "mobile", "sw.js"), "utf-8");
    const version = JSON.parse(
      await readFile(join(repoRoot, "codeflowmu-desktop", "mobile", "version.json"), "utf-8"),
    );

    assert.match(mobileIndex, /mobile\.js\?v=1\.0\.53/);
    assert.match(mobileJs, /BUNDLE_VERSION = "V1\.0\.53"/);
    assert.equal(version.app_version, "V1.0.53");
    assert.match(sw, /CACHE_NAME = "codeflowmu-pwa-v1\.0\.53"/);
    assert.match(sw, /path\.endsWith\("\/mobile\/"\)/);
    assert.match(sw, /path\.endsWith\("\/mobile\/mobile\.js"\)/);
    assert.match(sw, /self\.skipWaiting\(\)/);
  });
});
