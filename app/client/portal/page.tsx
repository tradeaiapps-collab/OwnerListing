"use client";
import { useCallback, useEffect, useState } from "react";
import { JSON_HEADERS } from "../../listings/ui";

type Doc = { kind: "offer" | "inspection" | "signed"; id: string; title: string; listingTitle: string; at: string; status: string; downloadUrl: string };
type Booking = { id: string; listingId: string; listingTitle: string; kind: "viewing" | "consultation"; startsAt: string; note: string; status: string; role: "requester" | "manager"; otherPartyName: string };
type Thread = { id: string; listingTitle: string; role: "buyer" | "owner"; unread: number; startedAt: string };
type Data = { documents: Doc[]; bookings: Booking[]; threads: Thread[]; role: string };

const TABS = ["documents", "viewings", "messages"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = { documents: "Documents", viewings: "Viewings", messages: "Messages" };
const KIND_LABEL: Record<Doc["kind"], string> = { offer: "Offer", inspection: "Inspection report", signed: "Signed document" };
const when = (iso: string) => new Date(iso).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });
const day = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { dateStyle: "medium" });
const label = (s: string) => s.replace(/_/g, " ");

/** Local date-time input value, one hour ahead, rounded up to the next quarter hour. */
function defaultSlot(): string {
  const d = new Date(Date.now() + 2 * 3600_000);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export default function ClientPortal() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("documents");

  const load = useCallback(async () => {
    const r = await fetch("/api/client/portal", { cache: "no-store" }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (r?.ok) { setData(d); setError(""); }
    else setError(!r ? "Could not load your portal." : r.status === 401 ? "Sign in to see your portal." : d.error ?? "Could not load your portal.");
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <main className="cp-page">
      <h1>My portal</h1>
      <p className="muted">Your documents, viewings and messages in one place. You only ever see your own.</p>
      {error && <p role="alert">{error}</p>}
      {!error && !data && <p className="muted" role="status">Loading…</p>}
      {data && (
        <>
          <div className="cp-tabs" role="tablist" aria-label="Portal sections">
            {TABS.map(t => {
              const n = t === "messages" ? data.threads.reduce((s, x) => s + x.unread, 0) : 0;
              return (
                <button key={t} type="button" role="tab" id={`cp-tab-${t}`} aria-selected={tab === t} aria-controls={`cp-panel-${t}`} className={tab === t ? "" : "secondary"} onClick={() => setTab(t)}>
                  {TAB_LABEL[t]}{n > 0 ? <span className="cp-count" aria-label={`${n} unread`}>{n}</span> : null}
                </button>
              );
            })}
          </div>
          <section role="tabpanel" id={`cp-panel-${tab}`} aria-labelledby={`cp-tab-${tab}`}>
            {tab === "documents" && <Documents docs={data.documents} />}
            {tab === "viewings" && <Viewings bookings={data.bookings} onChange={load} />}
            {tab === "messages" && <Messages threads={data.threads} />}
          </section>
        </>
      )}
    </main>
  );
}

function Documents({ docs }: { docs: Doc[] }) {
  if (docs.length === 0) return <p className="empty">No documents yet. Offers you make, inspection reports shared with you and signed documents appear here.</p>;
  return (
    <ul className="card-list cp-list">
      {docs.map(d => (
        <li key={`${d.kind}-${d.id}`}>
          <div className="top"><strong>{d.listingTitle}</strong><span className="badge">{label(d.status)}</span></div>
          <span>{KIND_LABEL[d.kind]} · {day(d.at)}</span>
          <div className="actions"><a className="button" href={d.downloadUrl} download>Download PDF</a></div>
        </li>
      ))}
    </ul>
  );
}

function Viewings({ bookings, onChange }: { bookings: Booking[]; onChange: () => Promise<void> }) {
  const [listingId, setListingId] = useState("");
  const [kind, setKind] = useState<"viewing" | "consultation">("viewing");
  const [startsAt, setStartsAt] = useState(defaultSlot);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { setListingId(new URLSearchParams(window.location.search).get("listing") ?? ""); }, []);

  async function post(url: string, body: unknown) {
    setBusy(true); setMsg("");
    const r = await fetch(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (r?.ok) { await onChange(); return true; }
    setMsg(d.error ?? "Something went wrong. Try again.");
    return false;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await post("/api/client/portal/bookings", { listingId, kind, startsAt: new Date(startsAt).toISOString(), note });
    if (ok) { setNote(""); setMsg("Request sent. The owner will confirm or suggest another time."); }
  }

  return (
    <>
      <form className="cp-form" onSubmit={submit} aria-label="Ask for a viewing or consultation">
        <h2>Ask for a time</h2>
        {!listingId && <p className="muted">Open a listing and choose Book a viewing to start a request.</p>}
        <label>Type
          <select value={kind} onChange={e => setKind(e.target.value as typeof kind)}>
            <option value="viewing">Viewing</option>
            <option value="consultation">Consultation</option>
          </select>
        </label>
        <label>Date and time
          <input type="datetime-local" required value={startsAt} onChange={e => setStartsAt(e.target.value)} />
        </label>
        <label>Note <span className="hint">(optional)</span>
          <textarea rows={3} maxLength={500} value={note} onChange={e => setNote(e.target.value)} />
        </label>
        <button type="submit" disabled={busy || !listingId}>{busy ? "Sending…" : "Send request"}</button>
        {msg && <p role="status">{msg}</p>}
      </form>
      <h2>Your viewings</h2>
      {bookings.length === 0 ? <p className="empty">No viewings or consultations yet.</p> : (
        <ul className="card-list cp-list">
          {bookings.map(b => {
            const open = b.status === "requested" || b.status === "confirmed";
            return (
              <li key={b.id}>
                <div className="top"><strong>{b.listingTitle}</strong><span className="badge">{b.status}</span></div>
                <span>{b.kind === "viewing" ? "Viewing" : "Consultation"} · {when(b.startsAt)}</span>
                <span className="muted">{b.role === "requester" ? `Owner: ${b.otherPartyName}` : `Requested by ${b.otherPartyName}`}{b.note ? ` · “${b.note}”` : ""}</span>
                {open && (
                  <div className="actions">
                    {b.role === "manager" && b.status === "requested" && (
                      <>
                        <button type="button" disabled={busy} onClick={() => post(`/api/client/portal/bookings/${b.id}`, { action: "confirm" })}>Confirm</button>
                        <button type="button" className="secondary" disabled={busy} onClick={() => post(`/api/client/portal/bookings/${b.id}`, { action: "decline" })}>Decline</button>
                      </>
                    )}
                    {b.role === "requester" && <button type="button" className="secondary" disabled={busy} onClick={() => post(`/api/client/portal/bookings/${b.id}`, { action: "cancel" })}>Cancel request</button>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function Messages({ threads }: { threads: Thread[] }) {
  if (threads.length === 0) return <p className="empty">No conversations yet. Enquire on a listing to message the owner.</p>;
  return (
    <ul className="card-list cp-list">
      {threads.map(t => (
        <li key={t.id}>
          <div className="top"><strong>{t.listingTitle}</strong>{t.unread > 0 && <span className="badge">{t.unread} new</span>}</div>
          <span className="muted">{t.role === "owner" ? "A buyer enquired" : "Your enquiry"} · {day(t.startedAt)}</span>
          <div className="actions"><a className="button" href={`/enquiries/${t.id}`}>Open conversation</a></div>
        </li>
      ))}
    </ul>
  );
}
