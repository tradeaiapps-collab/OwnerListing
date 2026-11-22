"use client";
import { useCallback, useEffect, useState } from "react";
import { JSON_HEADERS } from "./ui";

type Settings = { enabled: boolean; offerInspections: boolean; autoSend: boolean };
type Entry = { id: string; enquiryId: string; kind: string; topics: string[]; body?: string; status: string; reason?: string; needsOwner: boolean; at: string };

const STATUS: Record<string, string> = {
  pending_approval: "Waiting for your approval", sent: "Sent", discarded: "You chose not to send it", blocked: "Blocked by the safety checks",
  rate_limited: "Held back (reply limit)", handed_to_owner: "Passed to you", failed: "Not delivered"
};
const KIND: Record<string, string> = { reply: "Reply", booking: "Inspection booked", summary: "Note to you" };
const when = (iso: string) => new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

/**
 * "Elena answers buyers": the owner switches Elena on per listing. She answers common questions from the listing facts and published documents only,
 * offers inspection times from the owner's availability, and hands anything else to the owner. By default every reply waits for the owner's approval.
 */
export function ElenaEnquiriesPanel({ listingId }: { listingId: string }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [log, setLog] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/listings/${listingId}/elena-enquiries`);
      if (!r.ok) { setError(r.status === 401 ? "Sign in to use Elena for buyer enquiries." : "Could not load Elena's enquiry settings."); return; }
      const d = await r.json();
      setSettings(d.settings); setLog(d.log); setError("");
    } catch { setError("Could not load Elena's enquiry settings."); }
  }, [listingId]);
  useEffect(() => { void load(); }, [load]);

  async function save(next: Settings) {
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/listings/${listingId}/elena-enquiries`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(next) });
      if (r.ok) { setSettings((await r.json()).settings); await load(); } else setError((await r.json().catch(() => ({}))).error ?? "Could not save.");
    } catch { setError("Could not save."); } finally { setBusy(false); }
  }

  return (
    <section className="panel ee" aria-labelledby="ee-h">
      <h2 id="ee-h">Let Elena answer buyers</h2>
      <p className="muted">Elena answers common questions from your listing details and the documents you have published, and offers inspection times from your availability. She never gives the street address early, never states a price or agrees terms, and passes anything she is unsure about to you.</p>
      {settings === null ? <p className="muted" role="status">{error || "Loading…"}</p> : (
        <div className="ej-switches">
          <label className="ej-switch"><input type="checkbox" checked={settings.enabled} disabled={busy} onChange={e => void save({ ...settings, enabled: e.target.checked })} />
            <span><strong>Elena answers enquiries on this listing</strong><span className="muted">Turn off at any time. She stops straight away.</span></span></label>
          <label className="ej-switch"><input type="checkbox" checked={settings.offerInspections} disabled={busy || !settings.enabled} onChange={e => void save({ ...settings, offerInspections: e.target.checked })} />
            <span><strong>Offer and book inspection times</strong><span className="muted">Buyers pick from your open-inspection times. <a href="/open-inspections">Set your availability</a>.</span></span></label>
          <label className="ej-switch"><input type="checkbox" checked={settings.autoSend} disabled={busy || !settings.enabled} onChange={e => void save({ ...settings, autoSend: e.target.checked })} />
            <span><strong>Send replies without my approval</strong><span className="muted">Off by default: you approve each reply first. Even when on, offers, prices and anything unclear still come to you.</span></span></label>
        </div>
      )}
      {error && settings !== null && <p role="alert">{error}</p>}
      {settings?.enabled && log.length === 0 && <p className="muted">Elena will list what she answered here as soon as a buyer writes.</p>}
      {log.length > 0 && (
        <details className="ej-log" open>
          <summary>What Elena did ({log.length})</summary>
          <ul>{log.map(a => (
            <li key={a.id}>
              <span className="muted">{when(a.at)} · {KIND[a.kind] ?? a.kind} · {STATUS[a.status] ?? a.status}{a.needsOwner && a.status !== "pending_approval" ? " · needs you" : ""}</span>
              {a.body && <span className="ee-body">{a.body}</span>}
              {a.reason && <span className="muted">{a.reason}</span>}
              <a href={`/enquiries/${a.enquiryId}`}>Open the conversation</a>
            </li>
          ))}</ul>
        </details>
      )}
    </section>
  );
}
