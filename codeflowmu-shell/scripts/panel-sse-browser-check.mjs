/**
 * Headless browser check: panel SSE + connection status text.
 * Run: node scripts/panel-sse-browser-check.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.CODEFLOWMU_URL || 'http://127.0.0.1:18766';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const events = [];
  page.on('console', (msg) => events.push(`[console ${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => events.push(`[pageerror] ${err.message}`));

  let sseStatus = null;
  page.on('response', (res) => {
    if (res.url().includes('/api/v2/events')) {
      sseStatus = { url: res.url(), status: res.status(), ok: res.ok() };
    }
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 15000 });

  const initial = await page.evaluate(() => ({
    stxt: document.getElementById('stxt')?.textContent?.trim(),
    slClass: document.getElementById('sl')?.className,
    lang: localStorage.getItem('cf-lang'),
    origin: location.origin,
  }));

  await page.waitForTimeout(4000);

  const after = await page.evaluate(() => ({
    stxt: document.getElementById('stxt')?.textContent?.trim(),
    slClass: document.getElementById('sl')?.className,
    hasEventSource: typeof EventSource !== 'undefined',
  }));

  await browser.close();

  console.log(JSON.stringify({ base: BASE, sseStatus, initial, after, console: events.slice(0, 20) }, null, 2));
  const connected =
    after.slClass?.includes('ok') ||
    /已连接|Connected/i.test(after.stxt || '');
  process.exit(connected ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
