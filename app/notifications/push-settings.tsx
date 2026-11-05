"use client";
import { useCallback, useEffect, useState } from "react";
import { CATEGORIES, type Category } from "../../src/domain/notifications";
import type { Platform, PushPreferences } from "../../src/domain/push";
import { JSON_HEADERS } from "../listings/ui";

interface Device { id: string; platform: Platform; label: string | null; lastSeenAt: string }
interface Topic { category: Category; label: string; text: string; locked: boolean }
interface DeviceInfo { devices: Device[]; platforms: Record<Platform, boolean>; webPublicKey: string | null }
const PLATFORM_LABEL: Record<Platform, string> = { web: "Browser", android: "Android phone", ios: "iPhone" };
const KEY = "ol_push_device";
const api = (url: string, method: string, body?: unknown) => fetch(url, { method, headers: JSON_HEADERS, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).catch(() => null);
const store = {
  get: () => { try { return window.localStorage.getItem(KEY); } catch { return null; } },
  set: (v: string | null) => { try { if (v) window.localStorage.setItem(KEY, v); else window.localStorage.removeItem(KEY); } catch { /* private mode */ } }
};
const keyBytes = (b64: string) => { const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(s, c => c.charCodeAt(0)); };
const supported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const label = () => `${/Mobi|Android|iPhone/i.test(navigator.userAgent) ? "Phone" : "Computer"} browser`;

/** Push settings: turn push on for this browser, see and remove devices, choose topics. Phones register themselves from the mobile app. */
export default function PushSettings({ onMessage }: { onMessage: (m: string) => void }) {
  const [info, setInfo] = useState<DeviceInfo | null>(null);
  const [topics, setTopics] = useState<PushPreferences | null>(null);
  const [cats, setCats] = useState<Topic[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">("unsupported");

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([fetch("/api/push/devices").catch(() => null), fetch("/api/push/preferences").catch(() => null)]);
    if (!a?.ok || !b?.ok) return setErr(true);
    setInfo((await a.json()) as DeviceInfo);
    const p = (await b.json()) as { topics: PushPreferences; catalogue: Topic[] };
    setTopics(p.topics); setCats(p.catalogue);
  }, []);
  useEffect(() => { void load(); setPerm(supported() ? Notification.permission : "unsupported"); }, [load]);

  if (err) return <p role="alert">Could not load your push settings.</p>;
  if (!info || !topics) return <p className="muted" role="status">Loading…</p>;

  const mine = info.devices.find(d => d.id === store.get());
  const enable = async () => {
    if (!info.webPublicKey) return;
    setBusy(true); onMessage("");
    try {
      const result = await Notification.requestPermission();
      setPerm(result);
      if (result !== "granted") { onMessage("Notifications are blocked for this site. Allow them in your browser settings, then try again."); return; }
      const reg = await navigator.serviceWorker.register("/push-sw.js");
      await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(info.webPublicKey) }));
      const r = await api("/api/push/devices", "POST", { platform: "web", subscription: sub.toJSON(), label: label() });
      if (!r?.ok) { onMessage("Could not turn on push for this device. Try again."); return; }
      store.set(((await r.json()) as { id: string }).id);
      onMessage("Push is on for this device.");
      await load();
    } catch {
      onMessage("This browser could not turn on push.");
    } finally { setBusy(false); }
  };
  const remove = async (d: Device) => {
    setBusy(true); onMessage("");
    const r = await api("/api/push/devices", "DELETE", { id: d.id });
    if (r?.ok && d.id === store.get()) {
      store.set(null);
      try { const reg = await navigator.serviceWorker.getRegistration("/push-sw.js"); await (await reg?.pushManager.getSubscription())?.unsubscribe(); } catch { /* already gone */ }
    }
    setBusy(false);
    onMessage(r?.ok ? "Device removed." : "Could not remove that device.");
    if (r?.ok) await load();
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); onMessage("");
    const r = await api("/api/push/preferences", "PUT", { topics });
    setBusy(false);
    const d = r ? ((await r.json().catch(() => ({}))) as { error?: string; topics?: PushPreferences }) : {};
    if (r?.ok && d.topics) setTopics(d.topics);
    onMessage(r?.ok ? "Push topics saved." : d.error ?? "Could not save. Check your connection and try again.");
  };

  return (
    <section className="nt-push" aria-labelledby="nt-push-h">
      <h2 id="nt-push-h">Push notifications</h2>
      <p className="muted">Short alerts on your phone or browser, even when this site is closed. We hold them back between 9pm and 7am Sydney time; they will still be in your inbox in the morning.</p>

      {!supported() ? <p className="muted">This browser cannot receive push. On iPhone, add this site to your Home Screen first.</p>
        : !info.webPublicKey ? <p className="muted">Browser push is not switched on for this site yet.</p>
        : mine ? <p role="status">Push is on for this browser.</p>
        : <>
            <p><button type="button" className="button" disabled={busy || perm === "denied"} onClick={() => void enable()}>Turn on push for this browser</button></p>
            {perm === "denied" ? <p className="muted">Notifications are blocked in your browser settings for this site. Allow them there, then reload this page.</p> : null}
          </>}

      <h3>Your devices</h3>
      {info.devices.length === 0 ? <p className="nt-empty">No devices yet. Phones appear here after you sign in on the mobile app.</p> : (
        <ul className="nt-devices">
          {info.devices.map(d => (
            <li key={d.id}>
              <span><strong>{d.label ?? PLATFORM_LABEL[d.platform]}</strong> <span className="muted">{PLATFORM_LABEL[d.platform]}{d.id === store.get() ? " · this device" : ""}</span></span>
              <button type="button" className="button" disabled={busy} onClick={() => void remove(d)} aria-label={`Remove ${d.label ?? PLATFORM_LABEL[d.platform]}`}>Remove</button>
            </li>
          ))}
        </ul>
      )}

      <form className="nt-prefs" onSubmit={save}>
        <table>
          <caption className="sr-only">Push topics</caption>
          <thead><tr><th scope="col">Topic</th><th scope="col">Push</th></tr></thead>
          <tbody>
            {CATEGORIES.map(c => {
              const t = cats.find(x => x.category === c);
              return t ? (
                <tr key={c}>
                  <th scope="row">{t.label}<span>{t.text}</span></th>
                  <td><input type="checkbox" aria-label={`${t.label}: push`} checked={topics[c]} disabled={t.locked} onChange={e => setTopics({ ...topics, [c]: e.target.checked })} /></td>
                </tr>
              ) : null;
            })}
          </tbody>
        </table>
        <div><button type="submit" disabled={busy}>{busy ? "Saving…" : "Save push topics"}</button></div>
      </form>
    </section>
  );
}
