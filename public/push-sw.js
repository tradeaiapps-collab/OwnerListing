/*
 * Service worker for the installed app and web push. Plain JavaScript (no build step).
 * - Push: shows the notification and reports back when it is opened or dismissed.
 * - Offline: a page that cannot load answers with /offline. Built files (/_next/static, /icons) are cached after first use.
 *   Pages, API answers and anything signed-in are never stored: they always come from the network.
 */
"use strict";

const CACHE = "ol-shell-v1";
const OFFLINE = "/offline";

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(c => c.add(new Request(OFFLINE, { cache: "reload" }))).then(() => self.skipWaiting()).catch(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE).then(r => r || new Response("You are offline.", { status: 503, headers: { "content-type": "text/plain" } }))));
    return;
  }
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
  }
});

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = typeof data.title === "string" && data.title ? data.title : "Notification";
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof data.body === "string" ? data.body : "",
    tag: typeof data.tag === "string" ? data.tag : undefined,
    icon: "/assistant/elena-icon.png",
    data: { id: typeof data.id === "string" ? data.id : null, link: typeof data.link === "string" && /^\/(?!\/)/.test(data.link) ? data.link : "/notifications" }
  }));
});

function report(id, kind) {
  if (!id) return Promise.resolve();
  return fetch("/api/push/event", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: id, event: kind }), keepalive: true }).catch(function () {});
}

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const d = event.notification.data || {};
  event.waitUntil(Promise.all([report(d.id, "clicked"), (async () => {
    const url = new URL(d.link || "/notifications", self.location.origin).href;
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) if (c.url === url && "focus" in c) return c.focus();
    return self.clients.openWindow(url);
  })()]));
});

self.addEventListener("notificationclose", event => {
  const d = event.notification.data || {};
  event.waitUntil(report(d.id, "dismissed"));
});
