#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPEN_PWA_IDENTITY, pwaCacheName } from './pwa-product-identity.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const mobileDir = path.join(repoRoot, 'codeflowmu-desktop', 'mobile');
const files = {
  rootVersion: path.join(repoRoot, '.codeflowmu-version.json'),
  index: path.join(mobileDir, 'index.html'),
  manifest: path.join(mobileDir, 'manifest.json'),
  mobile: path.join(mobileDir, 'mobile.js'),
  i18n: path.join(mobileDir, 'i18n.js'),
  sw: path.join(mobileDir, 'sw.js'),
  version: path.join(mobileDir, 'version.json'),
  releases: path.join(mobileDir, 'RELEASES.json'),
  build: path.join(mobileDir, 'mobile-build.json'),
  publisher: path.join(repoRoot, 'scripts', 'publish-mobile-gateway.ps1'),
  runtimeIdentity: path.join(repoRoot, 'codeflowmu-shell', 'src', 'mobile', 'mobilePwaIdentity.ts'),
  gatewaySync: path.join(repoRoot, 'codeflowmu-shell', 'src', 'mobile', 'mobilePwaGatewaySync.ts'),
  gatewayPublish: path.join(repoRoot, 'codeflowmu-shell', 'src', 'mobile', 'mobilePwaGatewayPublish.ts'),
  panelRoutes: path.join(repoRoot, 'codeflowmu-shell', 'src', 'mobile', 'mobilePanelRoutes.ts'),
  panel: path.join(repoRoot, 'codeflowmu-desktop', 'panel', 'index.html'),
  webPanel: path.join(repoRoot, 'codeflowmu-shell', 'src', 'web-panel.ts'),
  maintenanceEdition: path.join(repoRoot, '.codeflowmu', 'edition-ui.json'),
};
const versionedAssets = ['mobile.js', 'mobile.css', 'i18n.js', 'jsqr.min.js', 'manifest.json', 'logo-64.png'];
const errors = [];

function read(file) {
  if (!fs.existsSync(file)) {
    errors.push(`${path.relative(repoRoot, file)}: missing`);
    return '';
  }
  return fs.readFileSync(file, 'utf8');
}

function json(file) {
  try {
    return JSON.parse(read(file));
  } catch (error) {
    errors.push(`${path.relative(repoRoot, file)}: invalid JSON (${error.message})`);
    return {};
  }
}

function equal(label, actual, expected) {
  if (actual !== expected) errors.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function includes(label, content, token) {
  if (!content.includes(token)) errors.push(`${label}: missing ${JSON.stringify(token)}`);
}

function main() {
  const version = json(files.version);
  const appVersion = String(version.app_version ?? '').trim();
  const resourceVersion = String(version.resource_version ?? '').trim();
  const cacheName = pwaCacheName(resourceVersion);
  equal('version.app_version', appVersion, `V${resourceVersion}`);
  equal('version.cache_name', version.cache_name, cacheName);
  equal('version.pwa_app_id', version.pwa_app_id, OPEN_PWA_IDENTITY.pwa_app_id);
  equal('version.api_contract', version.api_contract, OPEN_PWA_IDENTITY.api_contract);
  if (String(version.release_name ?? '').trim().length < 4) errors.push('version.release_name: concrete name required');
  if (
    !Array.isArray(version.changes)
    || version.changes.length === 0
    || version.changes.some((item) => String(item).trim().length < 8)
  ) {
    errors.push('version.changes: concrete changes of 8+ characters required');
  }

  const manifest = json(files.manifest);
  equal('manifest.id', manifest.id, OPEN_PWA_IDENTITY.pwa_app_id);
  equal('manifest.name', manifest.name, OPEN_PWA_IDENTITY.pwa_name);
  if (!String(manifest.short_name ?? '').includes('兼容版')) errors.push('manifest.short_name: must identify compatibility edition');

  const build = json(files.build);
  equal('mobile-build.ui_version', String(build.ui_version ?? '').replace(/^[vV]/, ''), resourceVersion);
  equal('mobile-build.pwa_app_id', build.pwa_app_id, OPEN_PWA_IDENTITY.pwa_app_id);
  equal('mobile-build.api_contract', build.api_contract, OPEN_PWA_IDENTITY.api_contract);
  equal('mobile-build.source_repo', build.source_repo, OPEN_PWA_IDENTITY.source_repo);

  const releases = json(files.releases);
  equal('RELEASES.releases[0].version', releases.releases?.[0]?.version, appVersion);
  equal('RELEASES.releases[0].resource_version', releases.releases?.[0]?.resource_version, resourceVersion);

  if (fs.existsSync(files.rootVersion)) {
    const rootVersion = json(files.rootVersion);
    equal('.codeflowmu-version.mobile_pwa', rootVersion.mobile_pwa, appVersion);
    equal('.codeflowmu-version.sw_cache', rootVersion.sw_cache, appVersion);
  }

  const index = read(files.index);
  includes('index', index, `name="cfm-pwa-app-id" content="${OPEN_PWA_IDENTITY.pwa_app_id}"`);
  includes('index', index, `name="cfm-pwa-api-contract" content="${OPEN_PWA_IDENTITY.api_contract}"`);
  includes('index', index, `name="cfm-pwa-bundle-version" content="${appVersion}"`);
  includes('index', index, `id="openVersionBadge" class="open-version-badge">${appVersion}-open</span>`);
  includes('index', index, `id="versionInfo" class="detail-value mono">${appVersion}-open</div>`);
  includes('index', index, `${OPEN_PWA_IDENTITY.pwa_app_id}:mobile_session_token`);
  for (const asset of versionedAssets) includes('index', index, `${asset}?v=${resourceVersion}`);

  const mobile = read(files.mobile);
  includes('mobile.js', mobile, `var PWA_APP_ID = "${OPEN_PWA_IDENTITY.pwa_app_id}"`);
  includes('mobile.js', mobile, `var PWA_API_CONTRACT = "${OPEN_PWA_IDENTITY.api_contract}"`);
  includes('mobile.js', mobile, `var BUNDLE_VERSION = "${appVersion}"`);
  includes('mobile.js', mobile, `var PWA_CACHE_BUST = "${resourceVersion}"`);
  includes('mobile.js', mobile, 'var PWA_STORAGE_PREFIX = PWA_APP_ID + ":"');
  includes('mobile.js', mobile, 'var targetCacheName = PWA_CACHE_PREFIX + PWA_CACHE_BUST');
  includes('mobile.js', mobile, 'name.indexOf(PWA_CACHE_PREFIX) === 0');
  includes('mobile.js', mobile, 'assertPwaBootstrapIdentity(raw)');
  includes('mobile.js', mobile, 'var displayVersion = BUNDLE_VERSION + "-open"');
  if (mobile.includes('name.indexOf("codeflowmu-pwa-v")')) errors.push('mobile.js: generic cross-product cache deletion is forbidden');

  const i18n = read(files.i18n);
  includes('i18n.js', i18n, `const STORAGE_KEY = "${OPEN_PWA_IDENTITY.pwa_app_id}:lang"`);

  const sw = read(files.sw);
  includes('sw.js', sw, `const PWA_APP_ID = "${OPEN_PWA_IDENTITY.pwa_app_id}"`);
  includes('sw.js', sw, `const CACHE_NAME = "${cacheName}"`);
  includes('sw.js', sw, 'key.startsWith(CACHE_PREFIX)');
  for (const asset of versionedAssets) includes('sw.js', sw, `./${asset}?v=${resourceVersion}`);
  if (sw.includes('keys.filter((k) => k !== CACHE_NAME)')) errors.push('sw.js: deleting every same-origin cache is forbidden');

  if (fs.existsSync(files.publisher)) {
    const publisher = read(files.publisher);
    includes('publish-mobile-gateway.ps1', publisher, '$targetCache = [string]$versionJson.cache_name');
    includes('publish-mobile-gateway.ps1', publisher, '$targetPwaAppId = [string]$versionJson.pwa_app_id');
    includes('publish-mobile-gateway.ps1', publisher, '$targetApiContract = [string]$versionJson.api_contract');
  }

  const runtimeIdentity = read(files.runtimeIdentity);
  includes('mobilePwaIdentity.ts', runtimeIdentity, 'gateway_publish_authority: false');
  const gatewaySync = read(files.gatewaySync);
  includes('mobilePwaGatewaySync.ts', gatewaySync, 'gateway_online_pwa_app_id');
  includes('mobilePwaGatewaySync.ts', gatewaySync, 'PWA_METADATA_MISMATCH');
  includes('mobilePwaGatewaySync.ts', gatewaySync, 'PWA_API_CONTRACT_MISMATCH');
  const gatewayPublish = read(files.gatewayPublish);
  includes('mobilePwaGatewayPublish.ts', gatewayPublish, 'PWA_GATEWAY_PUBLISH_AUTHORITY_EXTERNAL');
  includes('mobilePwaGatewayPublish.ts', gatewayPublish, 'isPwaGatewayPublishReadOnly');
  const panelRoutes = read(files.panelRoutes);
  includes('mobilePanelRoutes.ts', panelRoutes, 'isPwaGatewayPublishReadOnly()');
  const panel = read(files.panel);
  includes('panel/index.html', panel, 'st.proj.pwaSyncWrongProduct');
  includes('panel/index.html', panel, 'st.proj.pwaSyncLocalAppId');
  includes('panel/index.html', panel, "raw+'-open'");
  includes('panel/index.html', panel, 'PANEL_VERSION_ROWS_MOBILE_OPEN');
  const webPanel = read(files.webPanel);
  includes('web-panel.ts', webPanel, 'hostConfigPath && existsSync(hostConfigPath)');

  const maintenanceEdition = json(files.maintenanceEdition);
  if (!['open-maintenance', 'open-dev-team'].includes(maintenanceEdition.edition)) {
    errors.push(`maintenance edition identity: unexpected ${JSON.stringify(maintenanceEdition.edition)}`);
  }
  equal('maintenance Gateway publish boundary', maintenanceEdition.features?.privateGatewayPublish, false);

  if (errors.length) {
    console.error('FAIL PWA product identity/version contract:');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(`PASS ${OPEN_PWA_IDENTITY.pwa_app_id} ${appVersion} (${OPEN_PWA_IDENTITY.api_contract})`);
}

main();
