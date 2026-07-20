#!/usr/bin/env node
/**
 * Extract legacy codeflow-pwa HTML shell + CSS into CodeFlowMu mobile/.
 * Source: D:/Bridgeflow/web/pwa/index.html (or CODEFLOW_PWA_SRC env)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mobileDir = path.resolve(__dirname, "..");
const srcPath =
  process.env.CODEFLOW_PWA_SRC ||
  "D:/Bridgeflow/web/pwa/index.html";

if (!fs.existsSync(srcPath)) {
  console.error("Missing source:", srcPath);
  process.exit(1);
}

const raw = fs.readFileSync(srcPath, "utf8");
const styleMatch = raw.match(/<style>([\s\S]*?)<\/style>/i);
if (!styleMatch) {
  console.error("No <style> block found");
  process.exit(1);
}

let css = styleMatch[1].trim();
css += `

/* CodeFlowMu mobile bind overlay (shared with legacy QR modal) */
.bind-gate {
  position: fixed; inset: 0; z-index: 2000;
  background: var(--bg);
  display: flex; flex-direction: column;
  padding: 16px; overflow-y: auto;
}
.bind-gate.hidden { display: none !important; }
.bind-gate .card { margin-bottom: 12px; }
.bind-gate input, .bind-gate textarea, .bind-gate select {
  width: 100%; margin-top: 8px;
  padding: 10px; border-radius: 8px;
  border: 1px solid var(--card-border);
  background: rgba(0,0,0,.25); color: var(--text);
  font-size: 14px;
}
.bind-gate .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
.bind-gate .btn-primary {
  padding: 10px 16px; border-radius: 8px; border: none;
  background: var(--blue); color: #fff; font-weight: 600; cursor: pointer;
}
.bind-gate .btn-secondary {
  padding: 10px 16px; border-radius: 8px;
  border: 1px solid var(--card-border);
  background: rgba(255,255,255,.06); color: var(--text); cursor: pointer;
}
#cfm-qr-scan-modal.hidden { display: none !important; }
#cfm-qr-scan-modal {
  position: fixed; inset: 0; z-index: 3000;
  background: rgba(0,0,0,.88);
  display: flex; align-items: center; justify-content: center;
}
#cfm-qr-scan-modal .qr-panel {
  background: var(--bg2); border: 1px solid var(--card-border);
  border-radius: 16px; padding: 20px; width: 92%; max-width: 380px; text-align: center;
}
#cfm-qr-scan-modal video { width: 100%; border-radius: 10px; background: #000; max-height: 260px; }
`;

const bodyMatch = raw.match(/<body[^>]*>([\s\S]*?)<script\s+src="\.\/config\.js"/i);
if (!bodyMatch) {
  console.error("No body before config.js script");
  process.exit(1);
}

let body = bodyMatch[1];
// Drop legacy config.js dependency; keep DOM through QR modal
body = body.replace(/<script\s+src="\.\/config\.js"[\s\S]*$/i, "");

// Bind gate (shown before session token)
const bindGate = `
<div id="bindGate" class="bind-gate hidden">
  <div class="card">
    <div class="card-head"><h3 class="card-title" data-i18n="bindTitle">绑定此设备</h3></div>
    <p class="muted" data-i18n="bindHint">扫码或粘贴 PC 面板绑定链接。</p>
    <button type="button" class="btn-primary" id="bindScanBtn" data-i18n="scanQr">扫一扫绑定</button>
    <input id="bindPasteInput" type="text" data-i18n-placeholder="pasteBindPlaceholder" placeholder="粘贴绑定链接" />
    <button type="button" class="btn-secondary" id="bindPasteBtn" data-i18n="pasteBindConfirm">确认粘贴并绑定</button>
  </div>
</div>
<div id="cfm-qr-scan-modal" class="hidden" aria-hidden="true">
  <div class="qr-panel">
    <div id="cfm-qr-title" style="font-weight:700;font-size:16px;margin-bottom:12px;" data-i18n="scanQrTitle">扫一扫绑定</div>
    <video id="cfm-qr-video" autoplay playsinline muted></video>
    <canvas id="cfm-qr-canvas" style="display:none;"></canvas>
    <div id="cfm-qr-status" style="color:var(--text3);font-size:13px;margin:10px 0;" data-i18n="qrStartingCamera">正在启动摄像头…</div>
    <button type="button" id="cfm-qr-photo" class="btn-secondary hidden" data-i18n="scanPhotoCapture">拍照识别二维码</button>
    <button type="button" id="cfm-qr-close" class="btn-secondary" data-i18n="qrScanClose">取消</button>
    <input type="file" id="cfm-qr-file" accept="image/*" capture="environment" style="display:none;" />
  </div>
</div>
`;

const headHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#1e3a5f" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate" />
  <title>CodeFlowMu Mobile</title>
  <link rel="manifest" href="manifest.json?v=19" />
  <link rel="apple-touch-icon" href="./logo-192.png" />
  <link rel="stylesheet" href="mobile.css?v=19" />
</head>
<body>
${bindGate}
`;

const footHtml = `
  <script src="i18n.js?v=19"></script>
  <script src="mobile-pwa.js?v=19"></script>
</body>
</html>
`;

// Update brand text in header (keep 码流 style)
body = body.replace(
  /<span id="headerBrand"[^>]*>[^<]*<\/span>/,
  '<span id="headerBrand" class="header-brand">码流 CodeFlowMu</span>',
);

// Hide agent monitor / WS-only controls in my page — patrol UI kept, wired in JS
body = body.replace(
  /id="relayStatusLabel"[^>]*>中继服务器<\/span>/,
  'id="relayStatusLabel" class="slot-label" style="margin:0;">Gateway</span>',
);

const indexHtml = headHtml + body.trim() + footHtml;

fs.writeFileSync(path.join(mobileDir, "mobile.css"), css, "utf8");
fs.writeFileSync(path.join(mobileDir, "index.html"), indexHtml, "utf8");
console.log("Wrote mobile.css + index.html from", srcPath);
