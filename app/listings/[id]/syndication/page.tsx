"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import "../../../styles/syndication.css";

type Portal = "airbnb" | "vrbo" | "booking_com";
interface Custom { houseRules?: string; cancellationPolicy?: string; minNights?: number; maxGuests?: number }
interface PortalView { portal: Portal; label: string; mode: "api" | "manual"; eligibleReason: string | null; enabled: boolean; custom: Custom; manualUrl: string | null; state: string | null; externalUrl: string | null; lastError: string | null; lastSyncedAt: string | null }
interface Booking { id: string; portal: Portal; guestName: string; guests: number | null; checkIn: string; checkOut: string; totalCents: number | null; status: string }

const STATE_TEXT: Record<string, [string, string]> = {
  live: ["Live", "is-live"], manual: ["Linked", "is-live"], pending: ["Waiting to send", ""], failed: ["Needs attention", "is-bad"],
  removed: ["Removed", ""], manual_removal: ["Remove it on the portal", "is-warn"]
};
const money = (c: number | null) => (c === null ? "" : (c / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD" }));
const date = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });

function PortalCard({ id, v, onChanged }: { id: string; v: PortalView; onChanged: (portals: PortalView[]) => void }) {
  const [enabled, setEnabled] = useState(v.enabled);
  const [rules, setRules] = useState(v.custom.houseRules ?? "");
  const [policy, setPolicy] = useState(v.custom.cancellationPolicy ?? "");
  const [minNights, setMinNights] = useState(v.custom.minNights ? String(v.custom.minNights) : "");
  const [maxGuests, setMaxGuests] = useState(v.custom.maxGuests ? String(v.custom.maxGuests) : "");
  const [manualUrl, setManualUrl] = useState(v.manualUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [text, tone] = v.state ? STATE_TEXT[v.state] ?? [v.state, ""] : ["Not shared", ""];

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(""); setMsg("");
    const custom: Custom & Record<string, unknown> = {};
    if (rules.trim()) custom.houseRules = rules.trim();
    if (policy) custom.cancellationPolicy = policy;
    if (minNights) custom.minNights = Number(minNights);
    if (maxGuests) custom.maxGuests = Number(maxGuests);
    try {
      const r = await fetch(`/api/listings/${id}/syndication`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ portal: v.portal, enabled, custom, ...(v.mode === "manual" ? { manualUrl } : {}) })
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { onChanged(d.portals); setMsg("Saved."); } else setError(d.error ?? "Could not save.");
    } catch { setError("Could not save."); } finally { setBusy(false); }
  }

  return (
    <section className="syn-panel" aria-labelledby={`syn-${v.portal}`}>
      <div className="syn-head">
        <h2 id={`syn-${v.portal}`}>{v.label}</h2>
        <span className={`syn-pill ${tone}`}>{text}</span>
      </div>
      {v.eligibleReason && <p className="syn-note">{v.eligibleReason}</p>}
      {v.state === "manual_removal" && <p role="alert">This listing is no longer live here. Please remove your {v.label} listing yourself.</p>}
      {v.lastError && v.state === "failed" && <p role="alert">Last problem: {v.lastError}</p>}
      {v.externalUrl && <p><a href={v.externalUrl} rel="noopener noreferrer" target="_blank">View on {v.label}</a></p>}
      <form className="syn-form" onSubmit={save}>
        <label className="syn-check"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />Share this listing on {v.label}</label>
        <div className="syn-fields">
          <label className="is-wide">House rules
            <textarea maxLength={2000} value={rules} onChange={e => setRules(e.target.value)} placeholder="No parties, quiet after 10pm…" />
          </label>
          <label>Cancellation policy
            <select value={policy} onChange={e => setPolicy(e.target.value)}>
              <option value="">Portal default</option><option value="flexible">Flexible</option><option value="moderate">Moderate</option><option value="strict">Strict</option>
            </select>
          </label>
          <label>Minimum nights
            <input inputMode="numeric" value={minNights} onChange={e => setMinNights(e.target.value)} />
          </label>
          <label>Maximum guests
            <input inputMode="numeric" value={maxGuests} onChange={e => setMaxGuests(e.target.value)} />
          </label>
          {v.mode === "manual" && (
            <label className="is-wide">Link to your listing on {v.label}
              <input type="url" value={manualUrl} onChange={e => setManualUrl(e.target.value)} placeholder="https://…" />
              <span className="syn-note">{v.label} listings are made on their site. Paste the link here so renters can find it from yours.</span>
            </label>
          )}
        </div>
        <div className="syn-actions"><button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button></div>
        <div aria-live="polite">{msg && <p role="status">{msg}</p>}{error && <p role="alert">{error}</p>}</div>
      </form>
    </section>
  );
}

export default function ListingSyndication() {
  const { id } = useParams<{ id: string }>();
  const [portals, setPortals] = useState<PortalView[] | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loadError, setLoadError] = useState("");
  const [feed, setFeed] = useState("");
  const [feedError, setFeedError] = useState("");

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const r = await fetch(`/api/listings/${id}/syndication`);
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setPortals(d.portals); setBookings(d.bookings); }
      else setLoadError(r.status === 401 ? "Sign in to manage this listing." : r.status === 404 ? "Listing not found." : d.error ?? "Could not load.");
    } catch { setLoadError("Could not load."); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function makeFeed() {
    setFeedError(""); setFeed("");
    const r = await fetch(`/api/listings/${id}/syndication/feed`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
    const d = await r?.json().catch(() => ({}));
    if (r?.ok) setFeed(d.url); else setFeedError(d?.error ?? "Could not make the link.");
  }

  return (
    <main className="syn-page">
      <p><a href="/listings/mine">Your listings</a></p>
      <header>
        <h1>Share on other portals</h1>
        <p className="syn-note">Reach more renters by sharing this listing on Airbnb, VRBO and Booking.com. Bookings from those sites come back here and block the dates. Only published listings are shared; if you withdraw this one, it is taken down from the portals.</p>
      </header>
      {loadError && <p role="alert">{loadError}</p>}
      {!loadError && portals === null && <p className="syn-note" role="status">Loading…</p>}
      {portals && portals.length === 0 && <p className="empty">No portals are switched on yet. We will list them here as soon as they are.</p>}
      <div className="syn-grid">{portals?.map(p => <PortalCard key={p.portal} id={id} v={p} onChanged={setPortals} />)}</div>
      {portals && portals.length > 0 && (
        <>
          <section className="syn-panel" aria-labelledby="syn-bookings-h">
            <h2 id="syn-bookings-h">Bookings from portals</h2>
            {bookings.length === 0 ? <p className="syn-note">No bookings yet.</p> : (
              <div className="syn-table-wrap">
                <table className="syn-table">
                  <thead><tr><th>Guest</th><th>Portal</th><th>Check in</th><th>Check out</th><th className="num">Guests</th><th className="num">Total</th><th>Status</th></tr></thead>
                  <tbody>
                    {bookings.map(b => (
                      <tr key={b.id}>
                        <td>{b.guestName}</td><td>{b.portal === "booking_com" ? "Booking.com" : b.portal === "vrbo" ? "VRBO" : "Airbnb"}</td><td>{date(b.checkIn)}</td><td>{date(b.checkOut)}</td>
                        <td className="num">{b.guests ?? ""}</td><td className="num">{money(b.totalCents)}</td>
                        <td><span className={`syn-pill ${b.status === "confirmed" ? "is-live" : b.status === "conflict" ? "is-bad" : ""}`}>{b.status === "conflict" ? "Clash" : b.status === "cancelled" ? "Cancelled" : "Booked"}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section className="syn-panel" aria-labelledby="syn-cal-h">
            <h2 id="syn-cal-h">Calendar link</h2>
            <p className="syn-note">Give this link to a portal so it can block the dates already booked here. It shows dates only, no guest details. Making a new link stops the old one working.</p>
            <div className="syn-actions"><button type="button" onClick={() => void makeFeed()}>Make calendar link</button></div>
            {feed && <p className="syn-secret" role="status">{feed}</p>}
            {feedError && <p role="alert">{feedError}</p>}
          </section>
        </>
      )}
    </main>
  );
}
