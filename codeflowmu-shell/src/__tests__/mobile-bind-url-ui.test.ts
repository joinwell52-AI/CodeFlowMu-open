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

  it("mobile shell bumps cache version and recovers shell assets from the current cache", async () => {
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
    const bundleVersion = String(version.app_version);
    const resourceVersion = bundleVersion.replace(/^V/i, "");
    const escapedBundle = bundleVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedResource = resourceVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    assert.match(mobileIndex, new RegExp(`mobile\\.js\\?v=${escapedResource}`));
    assert.match(mobileJs, new RegExp(`BUNDLE_VERSION = "${escapedBundle}"`));
    assert.match(bundleVersion, /^V\d+\.\d+\.\d+$/);
    assert.match(
      sw,
      new RegExp(`CACHE_NAME = "codeflowmu-1-2-21-pwa-v${escapedResource}"`),
    );
    assert.match(sw, /path\.endsWith\("\/mobile\/"\)/);
    assert.match(sw, /function isShellAssetRequest\(url\)/);
    assert.match(sw, /"\/mobile\.js"/);
    assert.match(sw, /fetch\(event\.request\)[\s\S]*?caches\.match\(event\.request\)/);
    assert.match(sw, /self\.skipWaiting\(\)/);
  });

  it("keeps the current PWA release notes visible after updating", async () => {
    const mobileIndex = await readFile(
      join(repoRoot, "codeflowmu-desktop", "mobile", "index.html"),
      "utf-8",
    );
    const mobileJs = await readFile(
      join(repoRoot, "codeflowmu-desktop", "mobile", "mobile.js"),
      "utf-8",
    );

    assert.match(mobileIndex, /id="releaseNotes"/);
    assert.match(mobileIndex, /id="releaseNotesName"/);
    assert.match(mobileIndex, /id="releaseNotesChanges"/);
    assert.match(mobileJs, /function renderReleaseNotes\(version, releaseName, changes\)/);
    assert.match(
      mobileJs,
      /renderReleaseNotes\(remoteVersion, releaseName, releaseChanges\)/,
    );
    assert.match(mobileJs, /li\.textContent = item/);
  });
});
