"use client";
import { useCallback, useEffect, useState } from "react";
import { JSON_HEADERS } from "../listings/ui";

type Slot = { startsAt: string; label: string };
type Entry = { id: string; kind: string; body?: string; status: string; reason?: string; needsOwner: boolean; at: string };
type View = { buyer: { enabled: boolean; slots: Slot[] }; log: Entry[] };

/**
 * What Elena adds to a conversation. The buyer sees inspection times they can book in one tap. The owner sees replies waiting for approval,
 * with Approve and Don't send, and what Elena did. Everything is read from the server each time; hiding it here is only a convenience.
 */
export function ElenaCard({ enquiryId, refreshKey, onChanged }: { enquiryId: string; refreshKey: number; onChanged: () => void }) {
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [booked, setBooked] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/enquiries/${enquiryId}/elena`);
      if (r.ok) setView(await r.json());
    } catch { /* the conversation still works without the card */ }
  }, [enquiryId]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  async function book(s: Slot) {
    setBusy(s.startsAt); setError("");
    try {
      const r = await fetch(`/api/enquiries/${enquiryId}/elena`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ startsAt: s.startsAt }) });
      if (r.ok) { setBooked(s.label); onChanged(); } else setError((await r.json().catch(() => ({}))).error ?? "That time could not be booked. Pick another.");
    } catch { setError("That time could not be booked. Try again."); } finally { setBusy(""); await load(); }
  }
  async function decide(id: string, decision: "approve" | "discard") {
    setBusy(id); setError("");
    try {
      const r = await fetch(`/api/elena-enquiries/${id}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ decision }) });
      if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? "That did not work.");
      else onChanged();
    } catch { setError("That did not work."); } finally { setBusy(""); await load(); }
  }

  if (!view) return null;
  const pending = view.log.filter(e => e.status === "pending_approval");
  const done = view.log.filter(e => e.status !== "pending_approval");
  const slots = view.buyer.enabled ? view.buyer.slots : [];
  if (pending.length === 0 && done.length === 0 && slots.length === 0 && !booked) return null;
  return (
    <section className="et" aria-label="Elena">
      {slots.length > 0 && (
        <div className="et-block">
          <h2>Book an inspection</h2>
          <p className="muted">Pick a time. You&apos;ll get a confirmation with the address and a reminder before you go.</p>
          <ul className="et-slots">{slots.map(s => (
            <li key={s.startsAt}><button type="button" className="secondary" disabled={busy !== ""} onClick={() => void book(s)}>{busy === s.startsAt ? "Booking…" : s.label}</button></li>
          ))}</ul>
        </div>
      )}
      {booked && <p role="status" className="et-ok">Booked for {booked}.</p>}
      {pending.map(e => (
        <div key={e.id} className="et-block et-pending">
          <h2>Elena&apos;s reply is waiting for you</h2>
          <p className="et-body">{e.body}</p>
          <div className="et-actions">
            <button type="button" disabled={busy !== ""} onClick={() => void decide(e.id, "approve")}>{busy === e.id ? "Sending…" : "Approve and send"}</button>
            <button type="button" className="secondary" disabled={busy !== ""} onClick={() => void decide(e.id, "discard")}>Don&apos;t send</button>
          </div>
        </div>
      ))}
      {done.length > 0 && (
        <details className="et-log">
          <summary>What Elena did here ({done.length})</summary>
          <ul>{done.map(e => <li key={e.id}><span className="muted">{new Date(e.at).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} · {e.kind === "booking" ? "Inspection booked" : e.kind === "summary" ? "Note to you" : e.status === "sent" ? "Reply sent" : e.status === "handed_to_owner" ? "Passed to you" : e.status === "blocked" ? "Blocked by the safety checks" : e.status === "rate_limited" ? "Held back (reply limit)" : "Not sent"}{e.needsOwner ? " · needs you" : ""}</span>{e.reason && <span className="muted">{e.reason}</span>}</li>)}</ul>
        </details>
      )}
      {error && <p role="alert" className="cx-error">{error}</p>}
    </section>
  );
}
