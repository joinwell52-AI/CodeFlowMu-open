#!/usr/bin/env node
/**
 * Bump PWA version across all mobile static assets, then run pwa-version-check.
 * Usage: node scripts/pwa-bump-version.mjs 1.0.58 --name "发布名称" --change "具体更新项"
 *
 * After bump: commit + push, then Gateway publish (publish-mobile-gateway.ps1).
 * Do not treat bump/push alone as a release. See docs/PWA_RELEASE.md.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OPEN_PWA_IDENTITY, pwaCacheName } from "./pwa-product-identity.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const MOBILE_DIR = path.join(REPO_ROOT, "codeflowmu-desktop", "mobile");

const FILES = {
  rootVersionManifest: path.join(REPO_ROOT, ".codeflowmu-version.json"),
  indexHtml: path.join(MOBILE_DIR, "index.html"),
  mobileJs: path.join(MOBILE_DIR, "mobile.js"),
  swJs: path.join(MOBILE_DIR, "sw.js"),
  versionJson: path.join(MOBILE_DIR, "version.json"),
  releaseHistoryJson: path.join(MOBILE_DIR, "RELEASES.json"),
  mobileBuildJson: path.join(MOBILE_DIR, "mobile-build.json"),
};

const INDEX_QUERY_ASSETS = [
  "mobile.js",
  "mobile.css",
  "i18n.js",
  "jsqr.min.js",
  "manifest.json",
  "logo-64.png",
];

function usage() {
  console.error('Usage: node scripts/pwa-bump-version.mjs <x.y.z> --name "release name" --change "concrete change" [--change "..."]');
  console.error('Example: node scripts/pwa-bump-version.mjs 1.0.58 --name "Gateway 与更新恢复修复" --change "放行项目图谱和任务书审查接口"');
  process.exit(1);
}

function parseReleaseMetadata(args) {
  let name = "";
  const changes = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || "");
    if (arg === "--name") name = String(args[++i] || "").trim();
    else if (arg.startsWith("--name=")) name = arg.slice(7).trim();
    else if (arg === "--change") changes.push(String(args[++i] || "").trim());
    else if (arg.startsWith("--change=")) changes.push(arg.slice(9).trim());
    else usage();
  }
  const concrete = changes.filter((item) => item.length >= 8 && !/^PWA release\b/i.test(item));
  if (name.length < 4 || concrete.length === 0) {
    console.error("PWA version bump requires a release name and at least one concrete change (8+ characters).");
    usage();
  }
  return { name, changes: concrete };
}

function parseTargetVersion(raw) {
  const bust = String(raw || "").trim().replace(/^v/i, "");
  if (!/^\d+(?:\.\d+)*$/.test(bust)) {
    console.error(`Invalid version: ${raw}`);
    usage();
  }
  return { appVersion: `V${bust}`, resourceVersion: bust, cacheName: pwaCacheName(bust) };
}

function readCurrentResourceVersion() {
  try {
    const data = JSON.parse(fs.readFileSync(FILES.versionJson, "utf8"));
    const rv = String(data.resource_version || "").trim();
    if (rv) return rv;
  } catch {
    /* fall through */
  }
  try {
    const js = fs.readFileSync(FILES.mobileJs, "utf8");
    const m = js.match(/var PWA_CACHE_BUST\s*=\s*"([^"]+)"/);
    if (m) return m[1];
  } catch {
    /* ignore */
  }
  return null;
}

function replaceAllQueryVersions(text, oldBust, newBust) {
  if (!oldBust || oldBust === newBust) return text;
  return text.split(`?v=${oldBust}`).join(`?v=${newBust}`);
}

function insertLegacyEntry(content, arrayName, legacyCacheName) {
  if (!legacyCacheName || content.includes(`"${legacyCacheName}"`)) {
    return content;
  }
  const re = new RegExp(`(${arrayName}\\s*=\\s*\\[\\s*\\n)`);
  if (!re.test(content)) {
    const reInline = new RegExp(`(${arrayName}\\s*=\\s*\\[)`);
    return content.replace(reInline, `$1\n    "${legacyCacheName}",`);
  }
  return content.replace(re, `$1    "${legacyCacheName}",\n`);
}

function bumpIndexHtml(target, oldBust) {
  let html = fs.readFileSync(FILES.indexHtml, "utf8");
  html = html.replace(
    /name="cfm-pwa-bundle-version"\s+content="[^"]*"/,
    `name="cfm-pwa-bundle-version" content="${target.appVersion}"`,
  );
  html = html.replace(
    /(<span id="openVersionBadge"[^>]*>)[^<]*(<\/span>)/,
    `$1${target.appVersion}-open$2`,
  );
  html = html.replace(
    /(<div id="versionInfo"[^>]*>)[^<]*(<\/div>)/,
    `$1${target.appVersion}-open$2`,
  );
  html = replaceAllQueryVersions(html, oldBust, target.resourceVersion);
  for (const asset of INDEX_QUERY_ASSETS) {
    if (!html.includes(`${asset}?v=${target.resourceVersion}`)) {
      console.warn(`warn: ${asset}?v= may be missing in index.html after bump`);
    }
  }
  fs.writeFileSync(FILES.indexHtml, html, "utf8");
}

function bumpMobileJs(target, previousCacheName) {
  let js = fs.readFileSync(FILES.mobileJs, "utf8");
  js = js.replace(/var BUNDLE_VERSION\s*=\s*"[^"]*"/, `var BUNDLE_VERSION = "${target.appVersion}"`);
  js = js.replace(/var PWA_CACHE_BUST\s*=\s*"[^"]*"/, `var PWA_CACHE_BUST = "${target.resourceVersion}"`);
  js = insertLegacyEntry(js, "var PWA_LEGACY_CACHE_NAMES", previousCacheName);
  fs.writeFileSync(FILES.mobileJs, js, "utf8");
}

function bumpSwJs(target, oldBust, previousCacheName) {
  let sw = fs.readFileSync(FILES.swJs, "utf8");
  sw = sw.replace(/const CACHE_NAME\s*=\s*"[^"]*"/, `const CACHE_NAME = "${target.cacheName}"`);
  sw = replaceAllQueryVersions(sw, oldBust, target.resourceVersion);
  sw = insertLegacyEntry(sw, "const LEGACY_CACHE_NAMES", previousCacheName);
  fs.writeFileSync(FILES.swJs, sw, "utf8");
}

function bumpVersionJson(target, release) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const payload = {
    app_version: target.appVersion,
    resource_version: target.resourceVersion,
    cache_name: target.cacheName,
    pwa_app_id: OPEN_PWA_IDENTITY.pwa_app_id,
    api_contract: OPEN_PWA_IDENTITY.api_contract,
    updated_at: now,
    release_name: release.name,
    changes: release.changes,
  };
  fs.writeFileSync(FILES.versionJson, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return now;
}

function bumpReleaseHistory(target, release, updatedAt) {
  let history = { schema_version: 1, releases: [] };
  if (fs.existsSync(FILES.releaseHistoryJson)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(FILES.releaseHistoryJson, "utf8"));
      if (parsed && Array.isArray(parsed.releases)) history = parsed;
    } catch {
      /* recreate a valid history below */
    }
  }
  history.schema_version = 1;
  history.releases = history.releases.filter((entry) => entry && entry.version !== target.appVersion);
  history.releases.unshift({
    version: target.appVersion,
    resource_version: target.resourceVersion,
    released_at: updatedAt,
    name: release.name,
    changes: release.changes,
  });
  fs.writeFileSync(FILES.releaseHistoryJson, `${JSON.stringify(history, null, 2)}\n`, "utf8");
}

function bumpMobileBuildJson(target) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  let data = {};
  if (fs.existsSync(FILES.mobileBuildJson)) {
    try {
      data = JSON.parse(fs.readFileSync(FILES.mobileBuildJson, "utf8"));
    } catch {
      data = {};
    }
  }
  data.ui_version = `v${target.resourceVersion}`;
  data.build_time = now;
  if (!data.source) data.source = "codeflowmu-desktop/mobile";
  data.pwa_app_id = OPEN_PWA_IDENTITY.pwa_app_id;
  data.api_contract = OPEN_PWA_IDENTITY.api_contract;
  data.source_repo = OPEN_PWA_IDENTITY.source_repo;
  fs.writeFileSync(FILES.mobileBuildJson, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function bumpRootVersionManifest(target) {
  if (!fs.existsSync(FILES.rootVersionManifest)) return;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(FILES.rootVersionManifest, "utf8"));
  } catch (e) {
    console.error(`Invalid root version manifest: ${FILES.rootVersionManifest}`);
    console.error(String(e.message || e));
    process.exit(1);
  }

  data.mobile_pwa = target.appVersion;
  data.sw_cache = target.appVersion;
  fs.writeFileSync(FILES.rootVersionManifest, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function main() {
  const arg = process.argv[2];
  if (!arg) usage();

  const target = parseTargetVersion(arg);
  const release = parseReleaseMetadata(process.argv.slice(3));
  const oldBust = readCurrentResourceVersion();
  const previousCacheName = oldBust && oldBust !== target.resourceVersion
    ? pwaCacheName(oldBust)
    : null;

  if (!fs.existsSync(MOBILE_DIR)) {
    console.error(`Mobile dir not found: ${MOBILE_DIR}`);
    process.exit(1);
  }

  console.log(`Bumping PWA to ${target.appVersion} (resource ${target.resourceVersion})`);
  if (previousCacheName) {
    console.log(`Adding legacy cache: ${previousCacheName}`);
  }

  bumpIndexHtml(target, oldBust);
  bumpMobileJs(target, previousCacheName);
  bumpSwJs(target, oldBust, previousCacheName);
  const updatedAt = bumpVersionJson(target, release);
  bumpReleaseHistory(target, release, updatedAt);
  bumpMobileBuildJson(target);
  bumpRootVersionManifest(target);

  console.log("Running pwa-version-check...");
  const check = spawnSync(process.execPath, [path.join(__dirname, "pwa-version-check.mjs")], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  process.exit(check.status ?? 1);
}

main();
