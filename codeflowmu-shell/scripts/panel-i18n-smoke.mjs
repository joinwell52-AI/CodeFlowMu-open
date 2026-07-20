import { chromium } from "playwright";

const BASE = process.env.CODEFLOWMU_URL || "http://127.0.0.1:18766";
const PAGES = ["dashboard", "tasks", "reports", "settings", "eval"];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const events = [];
  const badResponses = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && !msg.text().startsWith("Failed to load resource:")) {
      events.push(`[console ${msg.type()}] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => events.push(`[pageerror] ${err.message}`));
  page.on("response", (res) => {
    if (res.status() < 400) return;
    const url = res.url();
    if (url.includes("/api/v2/files/read?path=fcop/internal/emergence-log.md")) return;
    badResponses.push({ status: res.status(), url });
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForTimeout(1500);

  const connected = await page.evaluate(() => ({
    text: document.getElementById("stxt")?.textContent?.trim() || "",
    cls: document.getElementById("sl")?.className || "",
  }));

  for (const lang of ["zh", "en"]) {
    await page.evaluate((nextLang) => {
      localStorage.setItem("cf-lang", nextLang);
      if (typeof lang !== "undefined") lang = nextLang;
      if (typeof applyLang === "function") applyLang();
      if (typeof applyLangPageEffects === "function") applyLangPageEffects();
    }, lang);
    await page.waitForTimeout(300);

    for (const target of PAGES) {
      await page.evaluate((pageName) => {
        if (typeof navTo === "function") navTo(pageName);
      }, target);
      await page.waitForTimeout(500);
    }
  }

  await browser.close();

  const ok =
    connected.cls.includes("ok") ||
    /已连接|Connected/i.test(connected.text);

  const result = { base: BASE, connected, pages: PAGES, events, badResponses };
  console.log(JSON.stringify(result, null, 2));
  process.exit(ok && events.length === 0 && badResponses.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
