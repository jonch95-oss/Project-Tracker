/*
 * Project Command service worker.
 * - Web push (brief §9).
 * - Offline reading for the iPhone app (brief §12): pages and data are
 *   fetched from the network first; a saved copy is shown only when there's
 *   no connection. Saved copies are private to this device and are deleted
 *   on sign-out (and when the session has ended).
 */

const STATIC = "pc-static-v1";
const PAGES = "pc-pages-v1";
const RSC = "pc-rsc-v1";
const DATA = "pc-data-v1";
const PRIVATE = [PAGES, RSC, DATA];
const OFFLINE_PAGE = "/offline.html";
/** Wait this long for the network before showing a saved copy (it keeps loading in the background). */
const NETWORK_WAIT_MS = 4000;
/** Never saved: sign-in, files, exports, uploads and anything that isn't a plain read. */
const NEVER = [
  /^\/api\/(?!trpc\/)/,
  /^\/_next\/webpack-hmr/,
  /^\/__nextjs/,
  /^\/sw\.js$/,
  /^\/login/,
  /^\/setup/,
  /^\/invite/,
  /^\/reset-password/,
  /^\/forgot-password/,
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const c = await caches.open(STATIC);
      await c
        .add(new Request(OFFLINE_PAGE, { cache: "reload" }))
        .catch(() => undefined);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([STATIC, ...PRIVATE]);
      for (const k of await caches.keys())
        if (k.startsWith("pc-") && !keep.has(k)) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

async function clearPrivate() {
  for (const k of PRIVATE) await caches.delete(k);
}

/** The page asks: forget everything saved (sign-out). */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "clear-offline")
    event.waitUntil(clearPrivate());
});

function isRsc(request, url) {
  return request.headers.get("RSC") === "1" || url.searchParams.has("_rsc");
}

/** RSC requests carry a cache-busting `_rsc` parameter; save them by page. */
function rscKey(url) {
  const u = new URL(url.href);
  u.searchParams.delete("_rsc");
  return u.href;
}

/** Network first; on no connection (or a very slow one) a saved copy; save good answers for next time. */
async function networkFirst(event, cacheName, key, fallback) {
  const cache = await caches.open(cacheName);
  const network = fetch(event.request).then(async (res) => {
    // The session ended: nothing saved may be shown any more.
    if (
      res.status === 401 ||
      (res.redirected && new URL(res.url).pathname.startsWith("/login"))
    ) {
      await clearPrivate();
      return res;
    }
    if (res.ok && res.type === "basic") {
      await cache.put(key, res.clone());
      if (cacheName === PAGES)
        await saveAssetsOf(await res.clone().text()).catch(() => undefined);
    }
    return res;
  });
  event.waitUntil(network.catch(() => undefined));
  let timer;
  const slow = new Promise((resolve) => {
    timer = setTimeout(resolve, NETWORK_WAIT_MS);
  });
  try {
    const first = await Promise.race([network, slow.then(() => null)]);
    if (first) return first;
    const saved = await cache.match(key, { ignoreVary: true });
    return saved || (await network);
  } catch {
    const saved = await cache.match(key, { ignoreVary: true });
    if (saved) return saved;
    if (fallback) {
      const page = await caches.match(fallback);
      if (page) return page;
    }
    return Response.error();
  } finally {
    clearTimeout(timer);
  }
}

/** How often a page opened inside the app is saved again as a whole page (for opening it cold, offline). */
const PAGE_RESAVE_MS = 10 * 60 * 1000;

/**
 * A page opened by tapping inside the app loads as data (RSC), not as a whole
 * page. Save the whole page too, in the background, so it opens offline from
 * the Home Screen later. At most once per page every ten minutes.
 */
async function savePageFor(pageUrl) {
  const cache = await caches.open(PAGES);
  const saved = await cache.match(pageUrl, { ignoreVary: true });
  const at = saved ? Date.parse(saved.headers.get("date") || "") : NaN;
  if (saved && Number.isFinite(at) && Date.now() - at < PAGE_RESAVE_MS) return;
  const res = await fetch(pageUrl, {
    credentials: "same-origin",
    headers: { Accept: "text/html" },
  });
  if (
    res.status === 401 ||
    (res.redirected && new URL(res.url).pathname.startsWith("/login"))
  ) {
    await clearPrivate();
    return;
  }
  if (
    res.ok &&
    res.type === "basic" &&
    (res.headers.get("content-type") || "").includes("text/html")
  ) {
    const html = await res.clone().text();
    await cache.put(pageUrl, res);
    await saveAssetsOf(html);
  }
}

/** Save the scripts and styles a whole page needs, so it can start offline (in-app visits load a different set). */
async function saveAssetsOf(html) {
  const urls = new Set();
  for (const m of html.matchAll(/\/_next\/static\/[^"'\s)\\]+/g)) {
    if (urls.size >= 150) break;
    urls.add(new URL(m[0], self.location.origin).href);
  }
  const cache = await caches.open(STATIC);
  for (const u of urls) {
    if (await cache.match(u)) continue;
    const r = await fetch(u).catch(() => null);
    if (r && r.ok && r.type === "basic") await cache.put(u, r);
  }
}

async function cacheFirst(event) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(event.request);
  if (hit) return hit;
  const res = await fetch(event.request);
  if (res.ok && res.type === "basic")
    await cache.put(event.request, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER.some((r) => r.test(url.pathname))) return;
  if (
    url.pathname.startsWith("/_next/static/") ||
    /^\/(icon|apple-icon)[^/]*\.png$/.test(url.pathname) ||
    url.pathname === "/manifest.webmanifest"
  ) {
    event.respondWith(cacheFirst(event));
    return;
  }
  if (url.pathname.startsWith("/api/trpc/")) {
    event.respondWith(networkFirst(event, DATA, request.url, null));
    return;
  }
  if (url.pathname.startsWith("/api/")) return;
  if (isRsc(request, url)) {
    // Link prefetches can be partial pages: never save them in place of a real visit.
    if (request.headers.get("Next-Router-Prefetch")) return;
    event.respondWith(networkFirst(event, RSC, rscKey(url), null));
    // Keep a whole-page copy for opening it offline later.
    if (navigator.onLine)
      event.waitUntil(savePageFor(rscKey(url)).catch(() => undefined));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(event, PAGES, url.href, OFFLINE_PAGE));
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {
      title: "Project Command",
      body: event.data ? event.data.text() : "",
    };
  }
  const title = data.title || "Project Command";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: data.tag || undefined,
      data: { url: data.url || "/notifications" },
    }),
  );
});

/** Open the link in the push: reuse an open window of the app when there is one. */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let target;
  try {
    target = new URL(
      (event.notification.data && event.notification.data.url) ||
        "/notifications",
      self.location.origin,
    );
  } catch {
    target = new URL("/notifications", self.location.origin);
  }
  // Only ever open this app's own pages.
  if (target.origin !== self.location.origin)
    target = new URL("/notifications", self.location.origin);
  event.waitUntil(
    (async () => {
      // Reuse an app window this worker controls (others can't be navigated); otherwise open one.
      const windows = await self.clients.matchAll({ type: "window" });
      for (const w of windows) {
        if (new URL(w.url).origin !== self.location.origin) continue;
        try {
          // Focus first, while the tap still counts as the person's action.
          await w.focus();
          await w.navigate(target.href);
          return;
        } catch {
          // Fall through to a new window.
        }
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});

/** The browser rotated this device's push address: register the new one (best effort; the app re-checks on open). */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription;
      const options = old && old.options ? old.options : null;
      if (!options) return;
      const sub = await self.registration.pushManager.subscribe(options);
      const json = sub.toJSON();
      await fetch("/api/trpc/push.subscribe", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: { endpoint: json.endpoint, keys: json.keys },
        }),
      });
    })(),
  );
});
