"use client";
import { use, useCallback, useEffect, useState } from "react";
import { aud, send } from "../../ui";
import "../../../styles/enquiries.css";

type Msg = { id: string; from: string; mine: boolean; body: string; sentAt: string };
type Thread = {
  id: string; projectId: string; projectTitle: string; role: "investor" | "owner"; amountMinCents: number; amountMaxCents: number;
  contractStatus: "none" | "submitted" | "returned" | "rejected"; contactsHidden: boolean; counterpart?: { name: string; email: string }; messages: Msg[];
};
const CONTRACT_TEXT: Record<Thread["contractStatus"], string> = {
  none: "No signed agreement yet.", submitted: "Signed agreement received. Staff are checking it.",
  returned: "Signed agreement confirmed by staff (contract returned).", rejected: "Staff could not accept the signed agreement. Upload a corrected copy."
};

export default function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [t, setT] = useState<Thread | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/investments/threads/${id}`).catch(() => null);
    if (!r?.ok) { setError(r?.status === 404 ? "Conversation not found." : "Could not load."); return; }
    setT(await r.json());
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function post(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setNote("");
    const r = await send(`/api/investments/threads/${id}`, "POST", { body: text });
    if (!r.ok) { setError(String(r.data["error"] ?? "Could not send.")); return; }
    const m = r.data["message"] as { notice?: string };
    if (m?.notice) setNote(m.notice);
    setText("");
    await load();
  }

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setError(""); setNote(""); setBusy(true);
    const r = await fetch(`/api/investments/threads/${id}/contract`, { method: "POST", headers: { "content-type": "application/pdf" }, body: f }).catch(() => null);
    setBusy(false);
    const d = await r?.json().catch(() => ({}));
    if (r?.ok) { setNote("Signed agreement sent to staff."); await load(); } else setError(d?.error ?? "Could not upload.");
  }

  if (!t) return <main><h1>Conversation</h1>{error ? <p role="alert">{error}</p> : <p className="muted" role="status">Loading…</p>}</main>;
  return (
    <main>
      <h1>{t.projectTitle}</h1>
      <p className="muted">Indicative interest {aud(t.amountMinCents)} to {aud(t.amountMaxCents)}. Non-binding. You are the {t.role === "owner" ? "project owner" : "investor"}.</p>
      {t.contactsHidden
        ? <p className="staff-notice">Contact details stay hidden. Talk here; emails, phone numbers and links in messages are hidden.</p>
        : t.counterpart && <p className="staff-notice">Contact: {t.counterpart.name}, {t.counterpart.email}</p>}
      <ul className="enq-thread">
        {t.messages.map(m => (
          <li key={m.id} className={`enq-msg${m.mine ? " mine" : ""}`}>{m.body}<small>{m.from} · {new Date(m.sentAt).toLocaleString("en-AU")}</small></li>
        ))}
      </ul>
      <form className="inv-form" onSubmit={post}>
        <label>Message<textarea value={text} onChange={e => setText(e.target.value)} rows={3} maxLength={4000} /></label>
        <button type="submit" disabled={!text.trim()}>Send</button>
      </form>
      <section className="panel">
        <h2>Investor introduction and fee agreement</h2>
        <p>{CONTRACT_TEXT[t.contractStatus]}</p>
        <p className="muted">When both of you are happy: download the agreement, fill it in and sign it, then the investor uploads the signed PDF here. Uploaded files are kept permanently.</p>
        <div className="actions">
          <a className="button secondary" href="/api/investments/contract-template">Download the agreement (DRAFT)</a>
          {t.role === "investor" && (t.contractStatus === "none" || t.contractStatus === "rejected") && (
            <label className="button">{busy ? "Uploading…" : "Upload signed PDF"}<input type="file" accept="application/pdf" hidden onChange={upload} disabled={busy} /></label>
          )}
        </div>
      </section>
      {note && <p role="status">{note}</p>}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
