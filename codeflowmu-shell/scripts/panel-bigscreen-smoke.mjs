/**
 * Playwright smoke: CodeFlowMu panel big-screen mode v1.
 *
 * Usage (panel must be up on 18766):
 *   node codeflowmu-shell/scripts/panel-bigscreen-smoke.mjs
 *   CODEFLOWMU_URL=http://127.0.0.1:18766 node ...
 */
import { chromium } from "playwright";

const BASE = process.env.CODEFLOWMU_URL || "http://127.0.0.1:18766";
const ST_KEY = "cf_settings_v1";

function check(name, pass, detail, checks) {
  checks.push({ name, pass, detail });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  const reactorRequests = [];

  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("request", (req) => {
    const u = req.url();
    if (/home-reactor\.(js|css)/i.test(u)) reactorRequests.push(u);
  });

  const checks = [];

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(2500);

  const htmlProbe = await page.content();
  check(
    "index references big-screen.js",
    /big-screen\.js/.test(htmlProbe),
    !!htmlProbe.match(/big-screen\.js/),
    checks,
  );
  check(
    "index does not preload home-reactor.js",
    !/<script[^>]+home-reactor\.js/i.test(htmlProbe),
    null,
    checks,
  );

  const defaultState = await page.evaluate(() => ({
    navDisplay: document.getElementById("nav-bigscreen")?.style.display ?? "",
    hasReactorScript: !!document.querySelector('script[src*="home-reactor.js"]'),
    enabled:
      typeof isBigScreenEnabled === "function" ? isBigScreenEnabled() : null,
  }));
  check("default nav hidden", defaultState.navDisplay === "none", defaultState.navDisplay, checks);
  check(
    "default no reactor script tag",
    !defaultState.hasReactorScript,
    defaultState.hasReactorScript,
    checks,
  );
  check(
    "default pref off",
    defaultState.enabled === false,
    defaultState.enabled,
    checks,
  );

  reactorRequests.length = 0;
  await page.evaluate(() => {
    if (typeof navTo === "function") navTo("bigscreen");
  });
  await page.waitForTimeout(1200);

  const blocked = await page.evaluate(() => ({
    curPage: window.curPage,
    reactorScript: !!document.querySelector('script[src*="home-reactor.js"]'),
  }));
  check(
    "disabled navTo stays dashboard",
    blocked.curPage === "dashboard",
    blocked.curPage,
    checks,
  );
  check(
    "disabled navTo does not load reactor",
    !blocked.reactorScript && reactorRequests.length === 0,
    { script: blocked.reactorScript, requests: reactorRequests.length },
    checks,
  );

  await page.evaluate(
    (key) => {
      const s = JSON.parse(localStorage.getItem(key) || "{}");
      s.bigScreenEnabled = true;
      localStorage.setItem(key, JSON.stringify(s));
    },
    ST_KEY,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  const enabledState = await page.evaluate(() => ({
    navDisplay: document.getElementById("nav-bigscreen")?.style.display ?? "",
    enabled: isBigScreenEnabled(),
    chk: document.getElementById("st-bigscreen-chk")?.checked,
  }));
  check("enabled nav visible", enabledState.navDisplay !== "none", enabledState.navDisplay, checks);
  check("enabled pref on", enabledState.enabled === true, enabledState.enabled, checks);

  reactorRequests.length = 0;
  await page.evaluate(() => navTo("bigscreen"));
  await page.waitForTimeout(4000);

  const bigscreenState = await page.evaluate(() => ({
    curPage: window.curPage,
    hash: location.hash,
    hasReactorScript: !!document.querySelector('script[src*="home-reactor.js"]'),
    hasReactorCss: !!document.querySelector("link[data-cf-bigscreen-css]"),
    pageHomeShown:
      document.getElementById("page-home")?.style.display !== "none",
    renderHomePage: typeof renderHomePage,
    fullscreenBtn: !!document.getElementById("homeFullscreenBtn"),
    reactorRoot: !!document.querySelector("#page-home .home-reactor-scaler, #page-home .reactor-wrap"),
  }));

  check("enter bigscreen curPage", bigscreenState.curPage === "bigscreen", bigscreenState.curPage, checks);
  check("hash bigscreen", bigscreenState.hash === "#/bigscreen", bigscreenState.hash, checks);
  check(
    "reactor script loaded",
    bigscreenState.hasReactorScript,
    bigscreenState.hasReactorScript,
    checks,
  );
  check("reactor css loaded", bigscreenState.hasReactorCss, bigscreenState.hasReactorCss, checks);
  check(
    "renderHomePage available",
    bigscreenState.renderHomePage === "function",
    bigscreenState.renderHomePage,
    checks,
  );
  check(
    "reactor DOM present",
    bigscreenState.reactorRoot || bigscreenState.pageHomeShown,
    bigscreenState,
    checks,
  );

  const vesselLayout = await page.evaluate(() => {
    const stage = document.getElementById("homeStage");
    const toolbar = stage?.querySelector(".home-toolbar");
    const inbox = stage?.querySelector(".home-vessel.inbox");
    if (!stage || !toolbar || !inbox) {
      return { ok: false, reason: "missing elements" };
    }
    const stageRect = stage.getBoundingClientRect();
    const toolbarRect = toolbar.getBoundingClientRect();
    const inboxRect = inbox.getBoundingClientRect();
    const gap = 4;
    const toolbarClear = inboxRect.top >= toolbarRect.bottom - gap;
    const vessels = [...stage.querySelectorAll(".home-vessel")];
    const allInStage = vessels.every((v) => {
      const r = v.getBoundingClientRect();
      return (
        r.top >= stageRect.top - 2 &&
        r.bottom <= stageRect.bottom + 2 &&
        r.left >= stageRect.left - 2 &&
        r.right <= stageRect.right + 2
      );
    });
    const reserves = {
      toolbar: getComputedStyle(stage).getPropertyValue("--home-toolbar-reserve").trim(),
      footer: getComputedStyle(stage).getPropertyValue("--home-footer-reserve").trim(),
    };
    return {
      ok: toolbarClear && allInStage,
      toolbarClear,
      allInStage,
      reserves,
      inboxTop: inboxRect.top,
      toolbarBottom: toolbarRect.bottom,
    };
  });
  check(
    "vessels not covered by toolbar",
    vesselLayout.ok === true,
    vesselLayout,
    checks,
  );

  let fsOn = false;
  let fsOff = true;
  if (bigscreenState.fullscreenBtn) {
    await page.evaluate(() => {
      if (typeof enterBigScreenFullscreen === "function") enterBigScreenFullscreen();
    });
    await page.waitForTimeout(400);
    fsOn = await page.evaluate(() =>
      document.documentElement.classList.contains("cf-bigscreen-fs"),
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    fsOff = await page.evaluate(() =>
      document.documentElement.classList.contains("cf-bigscreen-fs"),
    );
  } else {
    check("fullscreen btn present", false, "missing #homeFullscreenBtn", checks);
  }
  if (bigscreenState.fullscreenBtn) {
    check("fullscreen class on", fsOn === true, fsOn, checks);
    check("fullscreen class off after Esc", fsOff === false, fsOff, checks);
  }

  await page.evaluate(() => navTo("dashboard"));
  await page.waitForTimeout(1500);
  const afterLeave = await page.evaluate(() => ({
    curPage: window.curPage,
    fsClass: document.documentElement.classList.contains("cf-bigscreen-fs"),
  }));
  check("leave to dashboard", afterLeave.curPage === "dashboard", afterLeave.curPage, checks);
  check("teardown clears fs class", afterLeave.fsClass === false, afterLeave.fsClass, checks);

  await page.evaluate(
    (key) => {
      const s = JSON.parse(localStorage.getItem(key) || "{}");
      s.bigScreenEnabled = false;
      localStorage.setItem(key, JSON.stringify(s));
      if (typeof syncBigScreenNav === "function") syncBigScreenNav();
    },
    ST_KEY,
  );
  const disabledAgain = await page.evaluate(() => ({
    navDisplay: document.getElementById("nav-bigscreen")?.style.display ?? "",
  }));
  check(
    "nav hidden after pref off",
    disabledAgain.navDisplay === "none",
    disabledAgain.navDisplay,
    checks,
  );

  await browser.close();

  const failed = checks.filter((c) => !c.pass);
  const out = {
    base: BASE,
    checks,
    reactorRequestCount: reactorRequests.length,
    pageErrors,
    ok: failed.length === 0 && pageErrors.length === 0,
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(failed.length || pageErrors.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
