#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { OPEN_PWA_IDENTITY, writePwaReleaseMetadata } from './pwa-product-identity.mjs';

const root = process.cwd();
const sourceDir = path.join(root, 'codeflowmu-desktop', 'mobile');
const outputDir = path.join(root, 'release', 'mobile-pwa', OPEN_PWA_IDENTITY.pwa_app_id);
const allowDirty = process.argv.includes('--allow-dirty');
const staticFiles = [
  'index.html',
  'manifest.json',
  'mobile.js',
  'mobile.css',
  'i18n.js',
  'jsqr.min.js',
  'logo-64.png',
  'sw.js',
  'version.json',
  'RELEASES.json',
  'mobile-build.json',
];

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
}

async function main() {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'pwa-version-check.mjs')], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  let inheritedMetadata = null;
  try {
    inheritedMetadata = JSON.parse(
      await fs.readFile(path.join(sourceDir, '.codeflowmu-pwa.json'), 'utf8'),
    );
  } catch {
    inheritedMetadata = null;
  }
  const sourceGitCommit = String(inheritedMetadata?.source_git_commit ?? '').trim() || git(['rev-parse', 'HEAD']);
  const localDirty = Boolean(
    git(['status', '--porcelain=v1', '--', 'codeflowmu-desktop/mobile', 'scripts/pwa-product-identity.mjs']),
  );
  const dirty = inheritedMetadata ? inheritedMetadata.source_dirty === true || localDirty : localDirty;
  if (dirty && !allowDirty) {
    throw new Error('PWA source is dirty; commit the PWA files first or use --allow-dirty for a local verification package.');
  }

  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });
  for (const relative of staticFiles) {
    await fs.copyFile(path.join(sourceDir, relative), path.join(outputDir, relative));
  }

  const publishedAt = new Date().toISOString();
  const buildPath = path.join(outputDir, 'mobile-build.json');
  const build = JSON.parse(await fs.readFile(buildPath, 'utf8'));
  build.commit = sourceGitCommit;
  build.build_time = publishedAt;
  build.pwa_app_id = OPEN_PWA_IDENTITY.pwa_app_id;
  build.api_contract = OPEN_PWA_IDENTITY.api_contract;
  build.source_repo = OPEN_PWA_IDENTITY.source_repo;
  await fs.writeFile(buildPath, `${JSON.stringify(build, null, 2)}\n`, 'utf8');
  await writePwaReleaseMetadata({ mobileDir: outputDir, sourceGitCommit, sourceDirty: dirty, publishedAt });

  console.log(`Built ${OPEN_PWA_IDENTITY.pwa_name}`);
  console.log(`Output: ${outputDir}`);
  console.log(`Source commit: ${sourceGitCommit}${dirty ? ' (dirty local verification)' : ''}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
