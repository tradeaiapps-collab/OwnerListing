"use client";
import { useEffect, useRef, useState } from "react";
import "../styles/listing-video.css";

type VideoView = { id: string; status: "queued" | "processing" | "ready" | "failed"; playbackUrl: string | null };
type Info = { video: VideoView | null; priceCents: number | null; canBuy: boolean };

const aud = (c: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(c / 100);

/**
 * Tour video on a listing page. Shows the published video (or the one this visitor paid for) above the photos; with no video the photos
 * stay as they are. Signed-in visitors can buy a video: confirm the price, pay on Stripe's hosted page, come back to watch it.
 */
export function VideoTour({ listingId, signedIn, returned }: { listingId: string; signedIn: boolean; returned: "paid" | "cancelled" | null }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const opener = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);

  async function load() {
    try {
      const r = await fetch(`/api/videos?listingId=${encodeURIComponent(listingId)}`);
      if (r.ok) setInfo(await r.json());
    } catch { /* no video shown, photos remain */ }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [listingId]);
  const waiting = info?.video && (info.video.status === "queued" || info.video.status === "processing");
  useEffect(() => {
    if (!waiting && returned !== "paid") return;
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, returned]);
  useEffect(() => {
    if (!open) return;
    dialog.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  function close() { setOpen(false); opener.current?.focus(); }

  async function pay() {
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/videos/purchase", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ listingId }) });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) setError(b.error ?? "Could not start the payment. Nothing was charged.");
      else if (b.checkoutUrl) window.location.assign(b.checkoutUrl);
      else { setOpen(false); await load(); }
    } catch { setError("Could not start the payment. Nothing was charged."); } finally { setBusy(false); }
  }

  const v = info?.video;
  if (!info) return null;
  return (
    <section className="lv-section" aria-labelledby="lv-tour-h">
      {(v || info.canBuy) && <h2 id="lv-tour-h" style={{ margin: 0 }}>Video tour</h2>}
      {returned === "paid" && !v?.playbackUrl && <p className="lv-ok" role="status">Thanks, your payment went through. Your video is being made and usually takes 5 to 10 minutes. This page updates by itself.</p>}
      {returned === "cancelled" && !v && <p className="lv-meta" role="status">Payment cancelled. You were not charged.</p>}
      {v?.playbackUrl && <video className="lv-player" src={v.playbackUrl} controls playsInline preload="metadata" aria-label="Video tour of this property" />}
      {v?.playbackUrl && <span className="lv-badge">AI-generated tour video</span>}
      {waiting && returned !== "paid" && <p className="lv-meta" role="status">Your tour video is being made. This page updates by itself.</p>}
      {v?.status === "failed" && <p className="lv-error">The video could not be made. Press the button again; you will not be charged twice.</p>}
      {info.canBuy && !v?.playbackUrl && !waiting && (
        <div className="lv-actions">
          {signedIn
            ? <button ref={opener} type="button" className="primary" onClick={() => { setError(""); setOpen(true); }}>Generate tour video</button>
            : <a className="primary" href={`/login?next=${encodeURIComponent(`/listings/${listingId}`)}`}>Sign in to generate a tour video</a>}
        </div>
      )}
      {open && (
        <div className="lv-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) close(); }}>
          <div ref={dialog} className="lv-modal" role="dialog" aria-modal="true" aria-labelledby="lv-modal-h">
            <h2 id="lv-modal-h">Generate a tour video</h2>
            <p className="lv-price">{aud(info.priceCents ?? 0)}</p>
            <ul>
              <li>A short AI-made video built from this listing&apos;s photos.</li>
              <li>Ready in about 5 to 10 minutes after you pay. Only you can watch it.</li>
              <li>One payment on Stripe&apos;s secure page. We never see your card.</li>
              <li>AI-generated: it shows the photos in motion and is not an inspection.</li>
            </ul>
            {error && <p className="lv-error" role="alert">{error}</p>}
            <div className="lv-actions">
              <button type="button" className="primary" disabled={busy} onClick={pay}>{busy ? "Starting…" : `Pay ${aud(info.priceCents ?? 0)}`}</button>
              <button type="button" onClick={close}>Not now</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
