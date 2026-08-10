import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..", "..", "..");
const mobileDir = join(root, "codeflowmu-desktop", "mobile");
const appId = "codeflowmu-1-2-21";
const apiContract = "codeflowmu-mobile-v2";

test("Open compatibility PWA has a stable product identity", () => {
  const manifest = JSON.parse(readFileSync(join(mobileDir, "manifest.json"), "utf8"));
  const version = JSON.parse(readFileSync(join(mobileDir, "version.json"), "utf8"));
  const build = JSON.parse(readFileSync(join(mobileDir, "mobile-build.json"), "utf8"));
  assert.equal(manifest.id, appId);
  assert.match(manifest.name, /开源兼容版/);
  assert.equal(version.pwa_app_id, appId);
  assert.equal(version.api_contract, apiContract);
  assert.equal(build.pwa_app_id, appId);
  assert.equal(build.api_contract, apiContract);
  assert.equal(build.source_repo, "joinwell52-AI/codeflowmu1.2.21");
});

test("PWA visibly identifies the Open release beside its version", () => {
  const index = readFileSync(join(mobileDir, "index.html"), "utf8");
  const mobile = readFileSync(join(mobileDir, "mobile.js"), "utf8");
  assert.match(index, /id="openVersionBadge"[^>]*>V1\.0\.64-open<\/span>/);
  assert.match(index, /id="versionInfo"[^>]*>V1\.0\.64-open<\/div>/);
  assert.match(mobile, /BUNDLE_VERSION \+ "-open"/);
});

test("Open maintenance Panel visibly keeps the Open product identity", () => {
  const edition = JSON.parse(
    readFileSync(join(root, ".codeflowmu", "edition-ui.json"), "utf8"),
  );
  const panel = readFileSync(join(root, "codeflowmu-desktop", "panel", "index.html"), "utf8");
  const webPanel = readFileSync(join(root, "codeflowmu-shell", "src", "web-panel.ts"), "utf8");
  assert.equal(edition.edition, "open-maintenance");
  assert.equal(edition.features.privateGatewayPublish, false);
  assert.match(panel, /function isOpenProductLineEdition\(\)/);
  assert.match(panel, /raw\+'-open'/);
  assert.match(panel, /pwaSyncWrongProduct/);
  assert.match(panel, /Versions cannot be compared/);
  assert.match(panel, /pwaSyncLocalAppId/);
  assert.match(panel, /pwaSyncOnlineAppId/);
  assert.match(panel, /PANEL_VERSION_ROWS_MOBILE_OPEN/);
  assert.match(
    panel,
    /isOpenProductLineEdition\(\) \? PANEL_VERSION_ROWS_MOBILE_OPEN : PANEL_VERSION_ROWS_MOBILE/,
  );
  assert.doesNotMatch(panel, /本地 PWA 版本较新/);
  assert.match(
    webPanel,
    /const candidate = hostConfigPath && existsSync\(hostConfigPath\)[\s\S]*?: existsSync\(configPath\)/,
  );
});

test("PWA cache and browser storage are isolated from sibling applications", () => {
  const mobile = readFileSync(join(mobileDir, "mobile.js"), "utf8");
  const i18n = readFileSync(join(mobileDir, "i18n.js"), "utf8");
  const sw = readFileSync(join(mobileDir, "sw.js"), "utf8");
  assert.match(mobile, /PWA_CACHE_PREFIX = PWA_APP_ID \+ "-pwa-v"/);
  assert.match(mobile, /PWA_STORAGE_PREFIX = PWA_APP_ID \+ ":"/);
  assert.match(mobile, /name\.indexOf\(PWA_CACHE_PREFIX\) === 0/);
  assert.doesNotMatch(mobile, /name\.indexOf\("codeflowmu-pwa-v"\)/);
  assert.match(i18n, /codeflowmu-1-2-21:lang/);
  assert.match(sw, /key\.startsWith\(CACHE_PREFIX\)/);
  assert.doesNotMatch(sw, /keys\.filter\(\(k\) => k !== CACHE_NAME\)/);
});

test("PWA rejects a runtime with a different product identity or API contract", () => {
  const mobile = readFileSync(join(mobileDir, "mobile.js"), "utf8");
  const runtimeIdentity = readFileSync(
    join(root, "codeflowmu-shell", "src", "mobile", "mobilePwaIdentity.ts"),
    "utf8",
  );
  const mobileRoutes = readFileSync(
    join(root, "codeflowmu-shell", "src", "mobile", "mobileRoutes.ts"),
    "utf8",
  );
  assert.match(mobile, /PWA_METADATA_MISMATCH/);
  assert.match(mobile, /PWA_API_CONTRACT_MISMATCH/);
  assert.match(mobile, /assertPwaBootstrapIdentity\(raw\)/);
  assert.match(runtimeIdentity, /app_id: "codeflowmu-1-2-21"/);
  assert.match(runtimeIdentity, /api_contract: "codeflowmu-mobile-v2"/);
  assert.match(runtimeIdentity, /gateway_publish_authority: false/);
  assert.match(mobileRoutes, /pwa: MOBILE_PWA_IDENTITY/);
});
