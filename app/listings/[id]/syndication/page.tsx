"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import "../../../styles/syndication.css";

type Portal = "airbnb" | "vrbo" | "booking_com";
interface Custom { houseRules?: string; cancellationPolicy?: string; minNights?: number; maxGuests?: number; nightlyRateCents?: number }
interface PortalView { portal: Portal; label: string; mode: "api" | "manual" | "channex"; eligibleReason: string | null; enabled: boolean; custom: Custom; manualUrl: string | null; state: string | null; externalUrl: string | null; lastError: string | null; lastSyncedAt: string | null; connected: boolean | null; needsUpgrade: boolean }
interface CalendarView { portal: Portal; label: string; lastStatus: "ok" | "failed" | null; lastError: string | null; lastSyncedAt: string | null; blockedCount: number }
const IMPORT_PORTALS: { portal: Portal; label: string }[] = [{ portal: "airbnb", label: "Airbnb" }, { portal: "vrbo", label: "VRBO" }, { portal: "booking_com", label: "Booking.com" }];
interface Booking { id: string; portal: Portal; source: "webhook" | "ical"; guestName: string; guests: number | null; checkIn: string; checkOut: string; totalCents: number | null; status: string }

const STATE_TEXT: Record<string, [string, string]> = {
  live: ["Live", "is-live"], manual: ["Linked", "is-live"], pending: ["Waiting to send", ""], failed: ["Needs attention", "is-bad"],
  removed: ["Removed", ""], manual_removal: ["Remove it on the portal", "is-warn"]
};
const money = (c: number | null) => (c === null ? "" : (c / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD" }));
const date = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });

function PortalCard({ id, v, onChanged, onConnect }: { id: string; v: PortalView; onChanged: (portals: PortalView[]) => void; onConnect: () => void }) {
  const [enabled, setEnabled] = useState(v.enabled);
  const [rules, setRules] = useState(v.custom.houseRules ?? "");
  const [policy, setPolicy] = useState(v.custom.cancellationPolicy ?? "");
  const [minNights, setMinNights] = useState(v.custom.minNights ? String(v.custom.minNights) : "");
  const [maxGuests, setMaxGuests] = useState(v.custom.maxGuests ? String(v.custom.maxGuests) : "");
  const [nightly, setNightly] = useState(v.custom.nightlyRateCents ? String(v.custom.nightlyRateCents / 100) : "");
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
    if (nightly) custom.nightlyRateCents = Math.round(Number(nightly) * 100);
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
      {v.needsUpgrade && !v.enabled && (
        <div className="syn-connect">
          <p className="syn-note">Sharing on {v.label} comes with the Premium package or an Owner Plus plan.</p>
          <div className="syn-actions"><a className="button" href={`/listings/${id}/checkout`}>See packages</a></div>
        </div>
      )}
      {v.state === "manual_removal" && <p role="alert">This listing is no longer live here. Please remove your {v.label} listing yourself.</p>}
      {v.lastError && v.state === "failed" && <p role="alert">Last problem: {v.lastError}</p>}
      {v.mode === "channex" && v.state === "live" && (
        <div className="syn-connect">
          <p className="syn-note">{v.connected ? `Your ${v.label} account is connected. Prices, dates and bookings stay in step.` : `Ready. Connect your ${v.label} account to start taking bookings there.`}</p>
          <div className="syn-actions"><button type="button" onClick={onConnect}>{v.connected ? "Manage connection" : `Connect ${v.label}`}</button></div>
        </div>
      )}
      {v.externalUrl && <p><a href={v.externalUrl} rel="noopener noreferrer" target="_blank">View on {v.label}</a></p>}
      <form className="syn-form" onSubmit={save}>
        <label className="syn-check"><input type="checkbox" checked={enabled} disabled={v.needsUpgrade && !v.enabled} onChange={e => setEnabled(e.target.checked)} />Share this listing on {v.label}</label>
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
          {v.mode === "channex" && (
            <label>Price per night (AUD)
              <input inputMode="decimal" value={nightly} onChange={e => setNightly(e.target.value)} placeholder="Weekly rent ÷ 7" />
            </label>
          )}
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


function CalendarImportCard({ id, portal, label, view, onChanged }: { id: string; portal: Portal; label: string; view: CalendarView | undefined; onChanged: (c: CalendarView[]) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  async function send(method: "PUT" | "POST" | "DELETE", body: Record<string, unknown>, done: string) {
    setBusy(true); setError(""); setMsg("");
    try {
      const r = await fetch(`/api/listings/${id}/syndication/calendar`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ portal, ...body }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) setError(d.error ?? "Something went wrong.");
      else { onChanged(d.calendars); setUrl(""); if (d.outcome === "failed") setError("Saved, but the import failed. See the problem below."); else setMsg(done); }
    } catch { setError("Something went wrong."); } finally { setBusy(false); }
  }

  return (
    <section className="syn-panel" aria-labelledby={`syn-cal-${portal}`}>
      <div className="syn-head">
        <h3 id={`syn-cal-${portal}`}>{label}</h3>
        {view && <span className={`syn-pill ${view.lastStatus === "ok" ? "is-live" : view.lastStatus === "failed" ? "is-bad" : ""}`}>{view.lastStatus === "ok" ? `${view.blockedCount} blocked` : view.lastStatus === "failed" ? "Needs attention" : "Waiting"}</span>}
      </div>
      {view?.lastSyncedAt && <p className="syn-note">Last imported {new Date(view.lastSyncedAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}.</p>}
      {view?.lastError && <p role="alert">Last problem: {view.lastError}</p>}
      <form className="syn-form" onSubmit={e => { e.preventDefault(); void send("PUT", { url }, "Saved and imported."); }}>
        <label>{view ? `New ${label} calendar link` : `${label} calendar link`}
          <input type="url" required value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" autoComplete="off" />
        </label>
        <div className="syn-actions">
          <button type="submit" disabled={busy || url.trim() === ""}>{busy ? "Working…" : view ? "Replace link" : "Save and import"}</button>
          {view && <button type="button" disabled={busy} onClick={() => void send("POST", {}, "Imported.")}>Import now</button>}
          {view && <button type="button" disabled={busy} onClick={() => void send("DELETE", {}, "Stopped. Those dates are free again.")}>Stop importing</button>}
        </div>
        <div aria-live="polite">{msg && <p role="status">{msg}</p>}{error && <p role="alert">{error}</p>}</div>
      </form>
    </section>
  );
}

export default function ListingSyndication() {
  const { id } = useParams<{ id: string }>();
  const [portals, setPortals] = useState<PortalView[] | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [calendars, setCalendars] = useState<CalendarView[]>([]);
  const [loadError, setLoadError] = useState("");
  const [feed, setFeed] = useState("");
  const [feedError, setFeedError] = useState("");
  const [connectUrl, setConnectUrl] = useState("");
  const [connectError, setConnectError] = useState("");
  const [connecting, setConnecting] = useState(false);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const r = await fetch(`/api/listings/${id}/syndication`);
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setPortals(d.portals); setBookings(d.bookings); setCalendars(d.calendars ?? []); }
      else setLoadError(r.status === 401 ? "Sign in to manage this listing." : r.status === 404 ? "Listing not found." : d.error ?? "Could not load.");
    } catch { setLoadError("Could not load."); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function openConnect() {
    setConnectError(""); setConnecting(true);
    try {
      const r = await fetch(`/api/listings/${id}/syndication/connect`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const d = await r.json().catch(() => ({}));
      if (r.ok && typeof d.url === "string") setConnectUrl(d.url); else setConnectError(d.error ?? "Could not open the connection screen.");
    } catch { setConnectError("Could not open the connection screen."); } finally { setConnecting(false); }
  }
  function closeConnect() { setConnectUrl(""); void load(); }

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
      <div className="syn-grid">{portals?.map(p => <PortalCard key={p.portal} id={id} v={p} onChanged={setPortals} onConnect={() => void openConnect()} />)}</div>
      {(connecting || connectError || connectUrl) && (
        <section className="syn-panel" aria-labelledby="syn-connect-h">
          <div className="syn-head">
            <h2 id="syn-connect-h">Connect your portal accounts</h2>
            {connectUrl && <button type="button" onClick={closeConnect}>Done</button>}
          </div>
          {connecting && <p className="syn-note" role="status">Opening…</p>}
          {connectError && <p role="alert">{connectError}</p>}
          {connectUrl && (
            <>
              <p className="syn-note">Sign in to Airbnb, Booking.com or VRBO below and pick this listing. Our partner Channex keeps your prices, dates and bookings in step. Press Done when you have finished.</p>
              <iframe className="syn-frame" src={connectUrl} title="Connect portal accounts" referrerPolicy="no-referrer" />
            </>
          )}
        </section>
      )}
      {portals && (
        <section className="syn-panel" aria-labelledby="syn-import-h">
          <h2 id="syn-import-h">Import booked dates</h2>
          <p className="syn-note">Dates booked on Airbnb, VRBO or Booking.com are copied here every hour and blocked on this listing. In the portal, find the calendar export (iCal) link and paste it below. If a portal booking overlaps a stay from another portal, it is marked as a clash and you are told.</p>
          <div className="syn-grid">{IMPORT_PORTALS.map(p => <CalendarImportCard key={p.portal} id={id} portal={p.portal} label={p.label} view={calendars.find(c => c.portal === p.portal)} onChanged={setCalendars} />)}</div>
        </section>
      )}
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
                        <td>{b.guestName}{b.source === "ical" ? " (imported)" : ""}</td><td>{b.portal === "booking_com" ? "Booking.com" : b.portal === "vrbo" ? "VRBO" : "Airbnb"}</td><td>{date(b.checkIn)}</td><td>{date(b.checkOut)}</td>
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
