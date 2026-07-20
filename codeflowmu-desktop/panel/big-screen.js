/**
 * CodeFlowMu · 大屏模式 v1
 * 设置开关、导航可见性、home-reactor 懒加载、离开页 teardown。
 */
(function (global) {
  'use strict';

  const ST_KEY = 'cf_settings_v1';
  const PREF = 'bigScreenEnabled';

  function readSettings() {
    try {
      return JSON.parse(global.localStorage.getItem(ST_KEY) || '{}');
    } catch {
      return {};
    }
  }

  function isBigScreenEnabled() {
    return !!readSettings()[PREF];
  }

  function setBigScreenEnabled(on) {
    const val = !!on;
    if (typeof global.stSavePref === 'function') {
      try {
        global.stSavePref(PREF, val);
      } catch (_) {}
    } else {
      const s = readSettings();
      s[PREF] = val;
      try {
        global.localStorage.setItem(ST_KEY, JSON.stringify(s));
      } catch (_) {}
    }
    syncBigScreenNav();
    if (!on) {
      const p = global.curPage || global.window?.curPage;
      if (p === 'bigscreen' || p === 'home') {
        teardownBigScreen();
        if (typeof global.navTo === 'function') global.navTo('dashboard');
      }
    }
  }

  function syncBigScreenNav() {
    const nav = document.getElementById('nav-bigscreen');
    if (!nav) return;
    nav.style.display = isBigScreenEnabled() ? '' : 'none';
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const hit = document.querySelector('script[src="' + src + '"]');
      if (hit) {
        resolve();
        return;
      }
      const s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.body.appendChild(s);
    });
  }

  function ensureBigScreenCss() {
    if (document.querySelector('link[data-cf-bigscreen-css]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'home-reactor.css';
    link.dataset.cfBigscreenCss = '1';
    document.head.appendChild(link);
  }

  let _assetsPromise = null;

  function loadBigScreenAssets() {
    if (!isBigScreenEnabled()) {
      return Promise.reject(new Error('bigscreen disabled'));
    }
    if (_assetsPromise) return _assetsPromise;
    _assetsPromise = (async () => {
      ensureBigScreenCss();
      await loadScript('home-reactor-i18n.js');
      await loadScript('home-reactor.js');
    })();
    return _assetsPromise;
  }

  function teardownBigScreen() {
    if (typeof global.exitBigScreenFullscreen === 'function') {
      try {
        global.exitBigScreenFullscreen();
      } catch (_) {}
    }
    if (typeof global.homeTeardown === 'function') {
      try {
        global.homeTeardown();
      } catch (_) {}
    }
  }

  function onBigScreenPrefChange(checked) {
    setBigScreenEnabled(!!checked);
  }

  function normalizeNavPage(page) {
    if (page === 'home') return 'bigscreen';
    return page;
  }

  global.isBigScreenEnabled = isBigScreenEnabled;
  global.setBigScreenEnabled = setBigScreenEnabled;
  global.syncBigScreenNav = syncBigScreenNav;
  global.loadBigScreenAssets = loadBigScreenAssets;
  global.teardownBigScreen = teardownBigScreen;
  global.onBigScreenPrefChange = onBigScreenPrefChange;
  global.normalizeNavPage = normalizeNavPage;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncBigScreenNav);
  } else {
    syncBigScreenNav();
  }
})(typeof window !== 'undefined' ? window : globalThis);
