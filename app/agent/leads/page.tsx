"use client";
import { useCallback, useEffect, useState } from "react";
import "../../styles/agent-crm-leads.css";
import { STATUS_LABEL, type LeadStatus, type LeadTone } from "../../../src/domain/agent-leads";

type Lead = {
  id: string; listingId: string; listingTitle: string; buyerName: string; status: LeadStatus; tone: LeadTone; lastInteractionAt: string; lastInteraction: string;
  nextFollowupAt: string | null; followupDue: boolean; awaitingReply: boolean; firstResponseAt: string | null;
};
const TONE_TEXT: Record<LeadTone, string> = { red: "Needs a reply", yellow: "Buyer waiting", green: "In conversation", closed: "Closed" };
const when = (s: string) => new Date(s).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short", timeZone: "Australia/Brisbane" });

/** The agent's buyer leads, grouped by listing, most urgent first. Colour: red no reply or follow-up due, yellow buyer waiting, green agent has the last word. */
export default function AgentCrmLeads() {
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const r = await fetch(`/api/agent/crm-leads${status ? `?status=${status}` : ""}`).catch(() => null);
    if (!r) return setError("Could not load your leads.");
    if (r.status === 401) return setError("Sign in to see your leads.");
    if (r.status === 403) return setError("Buyer leads are for agent accounts.");
    if (!r.ok) return setError("Could not load your leads.");
    setLeads((await r.json()).leads); setError("");
  }, [status]);
  useEffect(() => { void load(); }, [load]);

  const byListing = new Map<string, { title: string; leads: Lead[] }>();
  for (const l of leads ?? []) {
    const g = byListing.get(l.listingId) ?? { title: l.listingTitle, leads: [] };
    g.leads.push(l); byListing.set(l.listingId, g);
  }
  const due = (leads ?? []).filter(l => l.followupDue).length;

  return (
    <main className="stack">
      <h1>Buyer leads</h1>
      <p className="muted">Everyone who asked about, booked a viewing of, or requested an inspection of a listing you manage. Reply quickly; red ones are waiting longest.</p>
      <p><a href="/agent/listings">Back to my listings</a> · <a href="/agent/ad-leads">Ad leads</a></p>
      {error && <p role="alert">{error}</p>}
      {due > 0 && <p className="crm-msg crm-due" role="status">{due} follow-up{due === 1 ? "" : "s"} due today.</p>}
      <div className="crm-filters">
        <label>Show <select value={status} onChange={e => { setLeads(null); setStatus(e.target.value); }}>
          <option value="">Active leads</option>
          {(["lost", "converted"] as const).map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select></label>
      </div>
      {leads === null && !error ? <p className="muted">Loading…</p> : leads && leads.length === 0 ? (
        <p className="empty">{status ? `No ${STATUS_LABEL[status as LeadStatus].toLowerCase()} leads.` : "No active leads yet. They appear here as soon as a buyer enquires, books a viewing or requests an inspection."}</p>
      ) : [...byListing.entries()].map(([id, g]) => (
        <section key={id}>
          <h2 className="crm-group">{g.title}</h2>
          <ul className="crm-list">{g.leads.map(l => (
            <li key={l.id} className={`crm-card ${l.tone}`}>
              <h3><a className="crm-open" href={`/agent/leads/${l.id}`}>{l.buyerName}</a></h3>
              <div className="crm-meta">
                <span className={`crm-tag ${l.tone}`}>{TONE_TEXT[l.tone]}</span>
                <span className="crm-tag">{STATUS_LABEL[l.status]}</span>
              </div>
              <p>{l.lastInteraction || "No activity recorded"}</p>
              <small className="muted">Last interaction {when(l.lastInteractionAt)}</small>
              {l.followupDue ? <small className="crm-due">Follow-up due today</small>
                : l.nextFollowupAt && l.status !== "lost" && l.status !== "converted" ? <small className="muted">Follow up {when(l.nextFollowupAt)}</small> : null}
            </li>
          ))}</ul>
        </section>
      ))}
    </main>
  );
}
