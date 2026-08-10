import fs from 'node:fs/promises';
import path from 'node:path';

export const OPEN_PWA_IDENTITY = Object.freeze({
  schema_version: 1,
  pwa_app_id: 'codeflowmu-1-2-21',
  pwa_name: '码流 CodeFlowMu 开源兼容版',
  source_repo: 'joinwell52-AI/codeflowmu1.2.21',
  api_contract: 'codeflowmu-mobile-v2',
});

export function pwaCacheName(resourceVersion) {
  return `${OPEN_PWA_IDENTITY.pwa_app_id}-pwa-v${String(resourceVersion).trim()}`;
}

export function pwaStorageKey(name) {
  return `${OPEN_PWA_IDENTITY.pwa_app_id}:${String(name).trim()}`;
}

export async function writePwaReleaseMetadata({
  mobileDir,
  sourceGitCommit,
  sourceDirty = false,
  publishedAt = new Date().toISOString(),
}) {
  const version = JSON.parse(await fs.readFile(path.join(mobileDir, 'version.json'), 'utf8'));
  const metadata = {
    ...OPEN_PWA_IDENTITY,
    version: String(version.app_version ?? '').trim(),
    resource_version: String(version.resource_version ?? '').trim(),
    source_git_commit: String(sourceGitCommit ?? '').trim(),
    source_dirty: sourceDirty === true,
    published_at: publishedAt,
  };
  await fs.writeFile(
    path.join(mobileDir, '.codeflowmu-pwa.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf8',
  );
  return metadata;
}
