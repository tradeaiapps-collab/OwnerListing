"use client";
import { useEffect, useState } from "react";
import { installMode, type InstallMode } from "../src/domain/pwa";

const KEY = "ol-install-dismissed";
interface InstallEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }

/**
 * Registers the service worker (offline page and static-file cache, plus web push) and offers "install this app":
 * the browser's own prompt on Android and desktop, or the Add to Home Screen steps on iPhone Safari. Hidden once installed.
 */
export default function PwaRegister() {
  const [mode, setMode] = useState<InstallMode>("hidden");
  const [event, setEvent] = useState<InstallEvent | null>(null);

  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/push-sw.js").catch(() => { /* unsupported or blocked: the site works without it */ });
    const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
    let dismissedAt: number | null = null;
    try { const v = Number(localStorage.getItem(KEY)); dismissedAt = v > 0 ? v : null; } catch { /* private mode */ }
    const evaluate = (e: InstallEvent | null) => setMode(installMode({ standalone, hasPromptEvent: e !== null, userAgent: navigator.userAgent, dismissedAt, now: Date.now() }));
    evaluate(null);
    const onPrompt = (e: Event) => { e.preventDefault(); setEvent(e as InstallEvent); evaluate(e as InstallEvent); };
    const onInstalled = () => { setEvent(null); setMode("hidden"); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => { window.removeEventListener("beforeinstallprompt", onPrompt); window.removeEventListener("appinstalled", onInstalled); };
  }, []);

  const dismiss = () => {
    try { localStorage.setItem(KEY, String(Date.now())); } catch { /* private mode */ }
    setMode("hidden");
  };
  const install = async () => {
    if (!event) return;
    await event.prompt();
    await event.userChoice.catch(() => undefined);
    setEvent(null);
    setMode("hidden");
  };

  if (mode === "hidden") return null;
  return (
    <aside className="install-banner" role="region" aria-label="Install the app">
      <img src="/icons/icon-192.png" alt="" width={40} height={40} className="install-banner-icon" />
      <div className="install-banner-text">
        <strong>Add the app to your phone</strong>
        {mode === "ios" ? (
          <span>Tap the Share button, then <b>Add to Home Screen</b>.</span>
        ) : (
          <span>Open listings faster, straight from your home screen.</span>
        )}
      </div>
      {mode === "prompt" && <button type="button" className="btn install-banner-go" onClick={install}>Install</button>}
      <button type="button" className="install-banner-close" onClick={dismiss} aria-label="Dismiss">×</button>
    </aside>
  );
}
