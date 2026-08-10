/* Minimal PWA service worker — cache shell assets */
const PWA_APP_ID = "codeflowmu-1-2-21";
const CACHE_PREFIX = `${PWA_APP_ID}-pwa-v`;
const CACHE_NAME = "codeflowmu-1-2-21-pwa-v1.0.64";
const LEGACY_CACHE_NAMES = [
  "codeflowmu-1-2-21-pwa-v1.0.63",
];
const ASSETS = [
  "./",
  "./index.html",
  "./mobile.js?v=1.0.64",
  "./mobile.css?v=1.0.64",
  "./i18n.js?v=1.0.64",
  "./jsqr.min.js?v=1.0.64",
  "./manifest.json?v=1.0.64",
  "./logo-64.png?v=1.0.64",
  "./RELEASES.json?v=1.0.64",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(async (cache) => {
        for (const asset of ASSETS) {
          const response = await fetch(asset, { cache: "reload" });
          if (response.ok) await cache.put(asset, response);
        }
      }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        const stale = new Set(
          keys.filter((key) => key !== CACHE_NAME && key.startsWith(CACHE_PREFIX)),
        );
        for (const legacy of LEGACY_CACHE_NAMES) stale.add(legacy);
        return Promise.all([...stale].map((k) => caches.delete(k)));
      })
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: "window", includeUncontrolled: true }))
      .then((clients) => {
        for (const client of clients) {
          client.postMessage({ type: "SW_ACTIVATED", cache: CACHE_NAME });
        }
      }),
  );
});

/** Dynamic endpoints must never be served from SW cache (chat poll, bootstrap, etc.). */
function isNetworkOnlyRequest(url, request) {
  if (request.method !== "GET") return true;
  const path = url.pathname || "";
  if (path.includes("/api/")) return true;
  if (request.mode === "navigate") return true;
  if (
    path.endsWith("/mobile") ||
    path.endsWith("/mobile/") ||
    path.endsWith("/mobile/index.html") ||
    path.endsWith("/mobile/sw.js")
  ) {
    return true;
  }
  if (path.endsWith("/version.json") || path.endsWith("version.json")) return true;
  return false;
}

function isShellAssetRequest(url) {
  const path = url.pathname || "";
  return [
    "/mobile.js",
    "/mobile.css",
    "/i18n.js",
    "/jsqr.min.js",
    "/manifest.json",
    "/logo-64.png",
  ].some((suffix) => path.endsWith(suffix));
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== "GET") return;

  if (isNetworkOnlyRequest(url, event.request)) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (isShellAssetRequest(url)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            return caches
              .open(CACHE_NAME)
              .then((cache) => cache.put(event.request, clone))
              .then(() => response);
          }
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type !== "basic") {
          return response;
        }
        const cc = (response.headers.get("cache-control") || "").toLowerCase();
        if (cc.includes("no-store") || cc.includes("no-cache")) {
          return response;
        }
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      });
    }),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
