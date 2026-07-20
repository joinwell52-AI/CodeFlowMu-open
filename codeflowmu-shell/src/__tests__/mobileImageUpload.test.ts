import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const MOBILE_DIR = join(process.cwd(), "..", "codeflowmu-desktop", "mobile");

/** Mirrors mobile.js formatFileSize — keep in sync with mobile.js */
function formatFileSize(bytes: number): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  let mb = (n / (1024 * 1024)).toFixed(1);
  if (mb.endsWith(".0")) mb = mb.slice(0, -2);
  return `${mb}MB`;
}

/** Mirrors mobile.js jpegFilenameFromOriginal — keep in sync with mobile.js */
function jpegFilenameFromOriginal(name: string): string {
  const base = String(name || "image").split(/[/\\]/).pop() || "image";
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `${stem}.jpg`;
}

test("formatFileSize formats bytes for attach preview", () => {
  assert.equal(formatFileSize(512), "512B");
  assert.equal(formatFileSize(680 * 1024), "680KB");
  assert.equal(formatFileSize(Math.round(3.8 * 1024 * 1024)), "3.8MB");
  assert.equal(formatFileSize(-1), "—");
});

test("jpegFilenameFromOriginal strips extension and uses .jpg", () => {
  assert.equal(jpegFilenameFromOriginal("IMG_1234.HEIC"), "IMG_1234.jpg");
  assert.equal(jpegFilenameFromOriginal("photos/shot.PNG"), "shot.jpg");
  assert.equal(jpegFilenameFromOriginal("noext"), "noext.jpg");
});

test("mobile.js defines shared image compression for chat and task upload", () => {
  const src = readFileSync(join(MOBILE_DIR, "mobile.js"), "utf-8");
  assert.match(src, /function compressImageForMobileUpload\(/);
  assert.match(src, /function syncMobileAttachFilesFromInput\(/);
  assert.match(src, /MOBILE_UPLOAD_MAX_IMAGES = 3/);
  assert.match(src, /MOBILE_UPLOAD_MAX_COMPRESSED_BYTES = 2 \* 1024 \* 1024/);
  assert.match(src, /MOBILE_UPLOAD_TARGET_BYTES = 1024 \* 1024/);
  assert.match(src, /MOBILE_IMAGE_MAX_EDGE = 1600/);
  assert.match(src, /MOBILE_IMAGE_JPEG_QUALITY = 0\.75/);
  assert.match(src, /buildPendingAttachItemHtml/);
  assert.match(src, /imageAttachOriginal/);
  assert.match(src, /BUNDLE_VERSION = "V1\.0\.53"/);
  assert.match(src, /PWA_CACHE_BUST = "1\.0\.53"/);
  assert.match(src, /PWA_LEGACY_CACHE_NAMES = \[[\s\S]*codeflowmu-pwa-v1\.0\.52/);
});

test("mobile i18n includes image upload error and preview strings", () => {
  const src = readFileSync(join(MOBILE_DIR, "i18n.js"), "utf-8");
  for (const key of [
    "imageAttachOriginal",
    "imageAttachCompressed",
    "errorImageMaxCount",
    "errorImageStillTooLarge",
    "errorImageProcessFailed",
  ]) {
    assert.match(src, new RegExp(`${key}:`));
  }
  assert.match(src, /最多上传 3 张图片/);
  assert.match(src, /You can upload up to 3 images/);
});

test("mobile index accepts all image types for chat attach", () => {
  const html = readFileSync(join(MOBILE_DIR, "index.html"), "utf-8");
  assert.match(html, /id="chatAttachFile"[^>]*accept="image\/\*"/);
  assert.match(html, /id="taskAttachFile"[^>]*accept="image\/\*"/);
  assert.match(html, /cfm-pwa-bundle-version" content="V1\.0\.53"/);
});
