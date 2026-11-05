/* Service worker for web push. Shows the notification and reports back when it is opened or dismissed. Plain JavaScript (no build step). */
"use strict";

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
