/*
 * Project Command service worker.
 * - Web push (brief §9).
 * - Opening the iPhone app with no connection (brief §12): the app's page
 *   shells (fetched without their data) and its script and style files are saved as they're used, and a
 *   saved page is shown only when the network fails (never instead of a live
 *   answer). The data itself is kept by the app per person (see
 *   src/lib/offline-cache.ts), not here.
 * - Saved pages belong to the person signed in: they're deleted on sign-out,
 *   when a different person signs in, and when the session has ended.
 */

const STATIC = "pc-static-v2";
const PAGES = "pc-pages-v3";
const META = "pc-meta";
const PRIVATE = [PAGES];
const OFFLINE_PAGE = "/offline.html";
/** A page opened inside the app is saved again as a whole page at most this often. */
const PAGE_RESAVE_MS = 30 * 60 * 1000;
const MAX_PAGES = 60;
const MAX_STATIC = 500;
/** Never touched: APIs (the app keeps its own data), sign-in pages, dev tooling. */
const NEVER = [/^\/api\//, /^\/_next\/webpack-hmr/, /^\/__nextjs/, /^\/sw\.js$/, /^\/login/, /^\/setup/, /^\/invite/, /^\/reset-password/, /^\/forgot-password/];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const c = await caches.open(STATIC);
      await c.add(new Request(OFFLINE_PAGE, { cache: "reload" })).catch(() => undefined);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([STATIC, PAGES, META]);
      for (const k of await caches.keys()) if (k.startsWith("pc-") && !keep.has(k)) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

async function clearPrivate() {
  for (const k of PRIVATE) await caches.delete(k);
}

/**
 * The page tells us who is signed in. A different person than last time:
 * everything saved for the previous one goes. `null` (the sign-in page, a
 * sign-out) clears too.
 */
async function setViewer(id, home) {
  const meta = await caches.open(META);
  const prev = await meta.match("/__viewer");
  const prevId = prev ? await prev.text() : null;
  if (id === null || prevId !== id) await clearPrivate();
  if (id === null) {
    await meta.delete("/__viewer");
    await meta.delete("/__home");
  } else {
    await meta.put("/__viewer", new Response(id));
    // Their start page (Portfolio, My Tasks…): where the Home Screen icon's "/" leads.
    if (typeof home === "string" && /^\/[a-z]+$/.test(home)) await meta.put("/__home", new Response(home));
  }
}

self.addEventListener("message", (event) => {
  const d = event.data || {};
  if (d.type === "clear-offline") event.waitUntil(setViewer(null));
  if (d.type === "viewer" && typeof d.id === "string") event.waitUntil(setViewer(d.id, d.home));
});

/** Keep a cache to its newest `max` entries (keys come back oldest first). */
async function trim(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

/** Pages are saved by path: every `?tab=` of a project opens from one copy. */
function pageKey(url) {
  return url.origin + url.pathname;
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
  await trim(cache, MAX_STATIC);
}

/** A page response to keep: a real, complete HTML page for a signed-in person. */
function keepable(res) {
  return res.ok && res.type === "basic" && !res.redirected && (res.headers.get("content-type") || "").includes("text/html");
}

async function storePage(key, res) {
  const html = await res.clone().text();
  const cache = await caches.open(PAGES);
  await cache.put(key, res);
  await trim(cache, MAX_PAGES);
  await saveAssetsOf(html);
}

/**
 * The session ended: nothing saved may be shown any more. (A redirect to sign
 * in can't be read here, since page loads don't follow redirects in the worker;
 * the sign-in page itself tells us to clear instead.)
 */
function sessionEnded(res) {
  return res.status === 401 || (res.redirected && new URL(res.url).pathname.startsWith("/login"));
}

/** A page: the live answer whenever there is one (streamed straight through); a saved copy only when the network fails. */
async function page(event, url) {
  try {
    const res = await fetch(event.request);
    if (sessionEnded(res)) event.waitUntil(clearPrivate());
    // The live page carries its data; the copy kept on the phone is fetched separately, without it.
    else if (keepable(res)) event.waitUntil(savePageFor(url).catch(() => undefined));
    return res;
  } catch {
    const pages = await caches.open(PAGES);
    const saved = await pages.match(pageKey(url));
    if (saved) return saved;
    // The Home Screen icon opens "/", which the server turns into the person's start page: do the same offline.
    if (url.pathname === "/") {
      const home = await caches.open(META).then((c) => c.match("/__home"));
      const path = home ? await home.text() : null;
      if (path && (await pages.match(self.location.origin + path))) return Response.redirect(self.location.origin + path, 302);
    }
    const offline = await caches.match(OFFLINE_PAGE);
    return offline || Response.error();
  }
}

/**
 * A page opened by tapping inside the app loads as data (RSC), not as a whole
 * page. Save the whole page too, in the background, so it opens offline from
 * the Home Screen later (at most once per page every half hour).
 */
async function savePageFor(url) {
  const key = pageKey(url);
  const saved = await caches.open(PAGES).then((c) => c.match(key));
  const at = saved ? Date.parse(saved.headers.get("date") || "") : NaN;
  if (saved && Number.isFinite(at) && Date.now() - at < PAGE_RESAVE_MS) return;
  // "Shell only": the server leaves out the data it would otherwise send with the page (see
  // src/server/trpc/prefetch.tsx), so nothing a screen shows (money on a report, the team list)
  // is kept inside a saved page. The app keeps its own data, by its own rules.
  const res = await fetch(url.href, { credentials: "same-origin", headers: { Accept: "text/html", "X-PC-Shell": "1" }, redirect: "manual" });
  if (sessionEnded(res)) return clearPrivate();
  if (keepable(res)) await storePage(key, res);
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.type === "basic") {
    await cache.put(request, res.clone());
    await trim(cache, MAX_STATIC);
  }
  return res;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER.some((r) => r.test(url.pathname))) return;
  // Build files never change (their names carry a hash): saved copies are always right.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request));
    return;
  }
  const rsc = request.headers.get("RSC") === "1" || url.searchParams.has("_rsc");
  if (rsc) {
    // Leave in-app navigation to the network; offline, Next falls back to a whole-page load (served below).
    if (!request.headers.get("Next-Router-Prefetch") && navigator.onLine) {
      const pageUrl = new URL(url.href);
      pageUrl.searchParams.delete("_rsc");
      event.waitUntil(savePageFor(pageUrl).catch(() => undefined));
    }
    return;
  }
  if (request.mode === "navigate") event.respondWith(page(event, url));
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
