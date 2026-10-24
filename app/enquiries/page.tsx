"use client";
import { useCallback, useEffect, useState } from "react";
import { JSON_HEADERS } from "../listings/ui";
import "../styles/enquiries.css";

type Item = { enquiry: { id: string }; listingTitle: string; role: "buyer" | "owner"; unread: number };
type Draft = { id: string; enquiryId: string; body: string; reviewUntil: string };
type Settings = { enabled: boolean; paused: boolean; reviewWindowMinutes: number };

/** Owner inbox and the buyer's own threads, with unread counts. Owners also see the auto-reply preview (drafts only, nothing sent). */
export default function Enquiries() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [template, setTemplate] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/enquiries");
      if (r.status === 401) return setError("Sign in to see your messages.");
      setItems((await r.json()).items ?? []);
      const [d, s] = await Promise.all([fetch("/api/enquiries/drafts"), fetch("/api/enquiries/auto-reply")]);
      if (d.ok) setDrafts((await d.json()).drafts);
      if (s.ok) setSettings((await s.json()).settings);
    } catch {
      setError("Could not load messages.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function post(url: string, body: unknown) {
    setError("");
    const r = await fetch(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }).catch(() => null);
    if (!r?.ok) setError(((await r?.json().catch(() => ({}))) as { error?: string })?.error ?? "That did not work.");
    await load();
  }

  return (
    <main>
      <h1>Messages</h1>
      {error && <p role="alert">{error}</p>}
      {items === null && !error && <p className="muted" role="status">Loading…</p>}
      {items && items.length === 0 && <p className="empty">No conversations yet.</p>}
      <ul className="card-list">
        {items?.map(i => (
          <li key={i.enquiry.id} className="enq-row">
            <a href={`/enquiries/${i.enquiry.id}`}>{i.listingTitle || "Listing"} <small className="muted">({i.role === "owner" ? "on your listing" : "you asked"})</small></a>
            {i.unread > 0 && <span className="enq-badge" aria-label={`${i.unread} unread`}>{i.unread}</span>}
          </li>
        ))}
      </ul>

      {settings && (
        <section className="panel">
          <h2>Auto-reply preview</h2>
          <p className="muted">Preview only. Nothing is sent automatically: routine replies from your approved template wait here for you to send or discard. Offers are never answered from a template.</p>
          <div className="actions">
            <button type="button" className="secondary" onClick={() => post("/api/enquiries/auto-reply", { enabled: !settings.enabled })}>{settings.enabled ? "Turn off" : "Turn on"}</button>
            <button type="button" className="secondary" onClick={() => post("/api/enquiries/auto-reply", { paused: !settings.paused })}>{settings.paused ? "Resume drafts" : "Pause drafts"}</button>
          </div>
          <p className="muted">Currently {settings.enabled ? "on" : "off"}{settings.paused ? " and paused" : ""}. Drafts are held {settings.reviewWindowMinutes} minutes for your review.</p>
          <form className="stack" onSubmit={e => { e.preventDefault(); void post("/api/enquiries/auto-reply", { templateBody: template }).then(() => setTemplate("")); }}>
            <label>Approved reply template
              <textarea value={template} onChange={e => setTemplate(e.target.value)} rows={3} maxLength={4000} />
            </label>
            <button type="submit" disabled={!template.trim()}>Approve template</button>
          </form>
          {drafts.map(d => (
            <div key={d.id} className="enq-draft">
              <div className="pre">{d.body}</div>
              <small className="muted">Review until {new Date(d.reviewUntil).toLocaleString("en-AU")}</small>
              <div className="actions">
                <button type="button" onClick={() => post(`/api/enquiries/drafts/${d.id}`, { action: "send" })}>Send as me</button>
                <button type="button" className="secondary" onClick={() => post(`/api/enquiries/drafts/${d.id}`, { action: "discard" })}>Discard</button>
                <a href={`/enquiries/${d.enquiryId}`}>Open conversation</a>
              </div>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
