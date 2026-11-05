"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import "../../../styles/agent-crm-leads.css";
import { FOLLOWUP_DAYS, LOST_LABEL, LOST_REASONS, STATUS_LABEL, formatResponseTime, responseMinutes, type LeadNote, type LeadStatus, type LeadTone, type LostReason } from "../../../../src/domain/agent-leads";
import { JSON_HEADERS } from "../../../listings/ui";

type Detail = {
  id: string; listingId: string; listingTitle: string; buyerName: string; enquiryId: string | null; status: LeadStatus; tone: LeadTone; lostReason: LostReason | null; lostNote: string;
  createdAt: string; lastInteractionAt: string; nextFollowupAt: string | null; followupNote: string; followupDue: boolean; firstResponseAt: string | null; notes: LeadNote[];
  interactions: { id: string; type: string; actor: string; description: string; createdAt: string }[];
};
const when = (s: string) => new Date(s).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short", timeZone: "Australia/Brisbane" });
const TYPE: Record<string, string> = { inquiry: "Enquiry", viewing: "Viewing", inspection: "Inspection", offer: "Offer", message: "Message" };

/** One buyer lead: the full history, private notes, a follow-up reminder, and lost/active status. Converted comes only from an accepted offer. */
export default function AgentLeadDetail() {
  const { id } = useParams<{ id: string }>();
  const [lead, setLead] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [days, setDays] = useState("3");
  const [followNote, setFollowNote] = useState("");
  const [lostOpen, setLostOpen] = useState(false);
  const [reason, setReason] = useState<LostReason>("budget");
  const [lostNote, setLostNote] = useState("");

  const load = useCallback(async () => {
    const r = await fetch(`/api/agent/crm-leads/${id}`).catch(() => null);
    if (!r) return setError("Could not load this lead.");
    if (r.status === 404) return setError("This lead was not found.");
    if (!r.ok) return setError("Could not load this lead.");
    setLead((await r.json()).lead); setError("");
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function send(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    const r = await fetch(`/api/agent/crm-leads/${id}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }).catch(() => null);
    setBusy(false);
    if (!r?.ok) { setError(((await r?.json().catch(() => null)) as { error?: string } | null)?.error ?? "That did not save. Try again."); return false; }
    setError(""); await load(); return true;
  }

  if (!lead) return <main className="stack"><h1>Lead</h1><p><a href="/agent/leads">Back to buyer leads</a></p>{error ? <p role="alert">{error}</p> : <p className="muted">Loading…</p>}</main>;
  const open = lead.status !== "lost" && lead.status !== "converted";

  return (
    <main className="stack">
      <h1>{lead.buyerName}</h1>
      <p className="muted">{lead.listingTitle}</p>
      <p><a href="/agent/leads">Back to buyer leads</a>{lead.enquiryId && <> · <a href={`/enquiries/${lead.enquiryId}`}>Open the conversation</a></>}</p>
      <div className="crm-meta">
        <span className={`crm-tag ${lead.tone}`}>{STATUS_LABEL[lead.status]}</span>
        <span className="crm-tag">First reply: {formatResponseTime(responseMinutes(lead.createdAt, lead.firstResponseAt))}</span>
        {lead.status === "lost" && lead.lostReason && <span className="crm-tag">Lost: {LOST_LABEL[lead.lostReason]}</span>}
      </div>
      {lead.followupDue && <p className="crm-msg crm-due" role="status">Follow-up due{lead.followupNote ? `: ${lead.followupNote}` : ""}.</p>}
      {error && <p role="alert">{error}</p>}

      <div className="crm-detail">
        <section className="crm-panel" aria-label="History">
          <h2>History</h2>
          {lead.interactions.length === 0 ? <p className="empty">Nothing recorded yet.</p> : (
            <ul className="crm-timeline">{lead.interactions.map(i => (
              <li key={i.id}><strong>{TYPE[i.type] ?? i.type}</strong> · {i.description}<small>{when(i.createdAt)}</small></li>
            ))}</ul>
          )}
        </section>

        <div className="stack">
          <section className="crm-panel" aria-label="Notes">
            <h2>Notes</h2>
            <form onSubmit={async e => { e.preventDefault(); if (await send({ action: "note", text: note })) setNote(""); }}>
              <label>Add a note <textarea value={note} onChange={e => setNote(e.target.value)} rows={3} maxLength={1000} required /></label>
              <div><button type="submit" disabled={busy || !note.trim()}>Save note</button></div>
            </form>
            {lead.notes.length === 0 ? <p className="muted">No notes yet. Only you can see them.</p> : (
              <ul className="crm-notes">{[...lead.notes].reverse().map(n => <li key={n.id}><p>{n.text}</p><small>{when(n.at)}</small></li>)}</ul>
            )}
          </section>

          {open && (
            <section className="crm-panel" aria-label="Follow-up">
              <h2>Follow-up</h2>
              {lead.nextFollowupAt && <p>Reminder set for {when(lead.nextFollowupAt)}{lead.followupNote ? `: ${lead.followupNote}` : ""}.</p>}
              <form onSubmit={e => { e.preventDefault(); void send({ action: "followup", days: Number(days), note: followNote }); }}>
                <label>Remind me in <select value={days} onChange={e => setDays(e.target.value)}>{FOLLOWUP_DAYS.map(d => <option key={d} value={d}>{d} day{d === 1 ? "" : "s"}</option>)}</select></label>
                <label>About <input value={followNote} onChange={e => setFollowNote(e.target.value)} maxLength={300} placeholder="Optional" /></label>
                <div className="crm-row"><button type="submit" disabled={busy}>Set reminder</button>
                  {lead.nextFollowupAt && <button type="button" className="secondary" disabled={busy} onClick={() => void send({ action: "followup", days: null })}>Clear</button>}</div>
              </form>
            </section>
          )}

          <section className="crm-panel" aria-label="Status">
            <h2>Status</h2>
            {lead.status === "converted" ? <p>Converted: the owner accepted this buyer&apos;s offer.</p> : open ? (
              lostOpen ? (
                <form onSubmit={async e => { e.preventDefault(); if (await send({ action: "status", status: "lost", reason, note: lostNote })) setLostOpen(false); }}>
                  <label>Why was it lost? <select value={reason} onChange={e => setReason(e.target.value as LostReason)}>{LOST_REASONS.map(r => <option key={r} value={r}>{LOST_LABEL[r]}</option>)}</select></label>
                  <label>Details {reason === "other" ? "" : "(optional)"} <input value={lostNote} onChange={e => setLostNote(e.target.value)} maxLength={500} required={reason === "other"} /></label>
                  <div className="crm-row"><button type="submit" disabled={busy}>Mark lost</button><button type="button" className="secondary" onClick={() => setLostOpen(false)}>Cancel</button></div>
                </form>
              ) : <div><button type="button" className="secondary" onClick={() => setLostOpen(true)}>Mark as lost</button></div>
            ) : (
              <div><p>{lead.lostNote || "Marked lost."}</p><button type="button" disabled={busy} onClick={() => void send({ action: "status", status: "new_inquiry" })}>Reopen lead</button></div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
