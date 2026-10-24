"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { JSON_HEADERS } from "../../listings/ui";
import "../../styles/enquiries.css";

type Message = { id: string; senderUserId: string | null; automated: boolean; body: string; sentAt: string };

/** One enquiry thread, for its buyer and the listing's owner. Messages cannot be edited or deleted. */
export default function Thread() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<{ enquiry: { listingId: string; buyerUserId: string }; messages: Message[] } | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const r = await fetch(`/api/enquiries/${id}/messages`);
      const d = await r.json();
      if (r.ok) setData(d);
      else setLoadError(r.status === 401 ? "Sign in to read this conversation." : r.status === 404 ? "Conversation not found." : d.error ?? "Could not load the conversation.");
    } catch {
      setLoadError("Could not load the conversation.");
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  async function onSend(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/enquiries/${id}/messages`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ body: draft }) });
      const d = await r.json();
      if (r.ok) {
        setDraft("");
        await load();
      } else setError(d.error ?? "Could not send the message.");
    } catch {
      setError("Could not send the message.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <p><a href="/enquiries">Back to messages</a></p>
      <h1>Conversation</h1>
      <p className="muted">Messages are a permanent record and cannot be edited or deleted. Offers made here are not formal offers.</p>
      {loadError && <p role="alert">{loadError}</p>}
      {!loadError && !data && <p className="muted" role="status">Loading…</p>}
      {data && (
        <>
          <ul className="enq-thread">
            {data.messages.map(m => (
              <li key={m.id} className={`enq-msg${m.automated ? " system" : ""}`}>
                {m.body}
                <small>{m.automated ? "Automated notice, " : ""}{new Date(m.sentAt).toLocaleString("en-AU")}</small>
              </li>
            ))}
          </ul>
          <form className="stack" onSubmit={onSend}>
            <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={3} maxLength={4000} required aria-label="Reply" />
            <button type="submit" disabled={busy || !draft.trim()}>{busy ? "Sending…" : "Send"}</button>
            {error && <p role="alert">{error}</p>}
          </form>
          <p className="muted">Owners can issue a secure formal offer link from <a href={`/listings/${data.enquiry.listingId}/offers`}>the offers page</a>. Buyers: ask the owner to send you one.</p>
        </>
      )}
    </main>
  );
}
