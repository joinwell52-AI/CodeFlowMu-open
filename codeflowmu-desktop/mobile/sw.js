/* Minimal PWA service worker — cache shell assets */
const CACHE_NAME = "codeflowmu-pwa-v1.0.53";
const LEGACY_CACHE_NAMES = [
    "codeflowmu-pwa-v1.0.52",
    "codeflowmu-pwa-v1.0.51",
    "codeflowmu-pwa-v1.0.50",
    "codeflowmu-pwa-v1.0.49",
    "codeflowmu-pwa-v1.0.48",
    "codeflowmu-pwa-v1.0.47",
    "codeflowmu-pwa-v1.0.44",
    "codeflowmu-pwa-v1.0.38",
    "codeflowmu-pwa-v1.0.37",
    "codeflowmu-pwa-v1.0.36",
    "codeflowmu-pwa-v1.0.30",
    "codeflowmu-pwa-v1.0.29",
    "codeflowmu-pwa-v1.0.28",
    "codeflowmu-pwa-v1.0.27",
    "codeflowmu-pwa-v1.0.26",
    "codeflowmu-pwa-v1.0.25",
    "codeflowmu-pwa-v1.0.24",
    "codeflowmu-pwa-v1.0.19",
  "codeflowmu-pwa-v1.0.18",
  "codeflowmu-pwa-v1.0.17",
  "codeflowmu-pwa-v1.0.16",
  "codeflowmu-pwa-v1.0.15",
  "codeflowmu-pwa-v1.0.14",
  "codeflowmu-pwa-v1.0.13",
  "codeflowmu-pwa-v1.0.12",
  "codeflowmu-pwa-v1.0.9",
  "codeflowmu-pwa-v1.0.8",
  "cfm-mobile-v26",
];
const ASSETS = [
  "./",
  "./index.html",
  "./mobile.js?v=1.0.53",
  "./mobile.css?v=1.0.53",
  "./i18n.js?v=1.0.53",
  "./jsqr.min.js?v=1.0.53",
  "./manifest.json?v=1.0.53",
  "./logo-64.png?v=1.0.53",
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
        const stale = new Set(keys.filter((k) => k !== CACHE_NAME));
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
  if (
    path.endsWith("/mobile") ||
    path.endsWith("/mobile/") ||
    path.endsWith("/mobile/index.html") ||
    path.endsWith("/mobile/mobile.js") ||
    path.endsWith("/mobile/mobile.css") ||
    path.endsWith("/mobile/i18n.js") ||
    path.endsWith("/mobile/sw.js")
  ) {
    return true;
  }
  if (path.endsWith("/version.json") || path.endsWith("version.json")) return true;
  return false;
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== "GET") return;

  if (isNetworkOnlyRequest(url, event.request)) {
    event.respondWith(fetch(event.request));
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
