/* Project Command service worker: web push (brief §9). Offline caching arrives with the iPhone app milestone. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Project Command", body: event.data ? event.data.text() : "" };
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
    target = new URL((event.notification.data && event.notification.data.url) || "/notifications", self.location.origin);
  } catch {
    target = new URL("/notifications", self.location.origin);
  }
  // Only ever open this app's own pages.
  if (target.origin !== self.location.origin) target = new URL("/notifications", self.location.origin);
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
        body: JSON.stringify({ json: { endpoint: json.endpoint, keys: json.keys } }),
      });
    })(),
  );
});
