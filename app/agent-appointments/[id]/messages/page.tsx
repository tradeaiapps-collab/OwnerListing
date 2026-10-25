"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { JSON_HEADERS } from "../../../listings/ui";

type Message = { id: string; body: string; sentAt: string; mine: boolean };
type Conversation = { listingId: string; listingTitle: string; counterpartName: string; open: boolean; messages: Message[] };

/** Owner and appointed agent conversation for one listing. Permanent record; read-only once the appointment ends. */
export default function AgentMessages() {
  const { id } = useParams<{ id: string }>();
  const [conv, setConv] = useState<Conversation | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const r = await fetch(`/api/agent-appointments/${id}/messages`);
      const d = await r.json();
      if (r.ok) setConv(d);
      else setLoadError(r.status === 401 ? "Sign in to read these messages." : r.status === 404 ? "Conversation not found." : d.error ?? "Could not load the messages.");
    } catch {
      setLoadError("Could not load the messages.");
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  async function onSend(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/agent-appointments/${id}/messages`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ body: draft }) });
      const d = await r.json();
      if (r.ok) {
        setDraft("");
        setConv(prev => (prev ? { ...prev, messages: [...prev.messages, d.message] } : prev));
      } else setError(r.status === 401 ? "Sign in to send messages." : d.error ?? "Could not send the message.");
    } catch {
      setError("Could not send the message.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>{conv ? `Messages with ${conv.counterpartName}` : "Messages"}</h1>
      {conv && <p className="muted"><a href={`/listings/${conv.listingId}`}>{conv.listingTitle}</a>. Messages are a permanent record and cannot be edited or deleted.</p>}
      {loadError && <p role="alert">{loadError}</p>}
      {!loadError && conv === null && <p className="muted" role="status">Loading…</p>}
      {conv && conv.messages.length === 0 && <p className="empty">No messages yet.</p>}
      <ul className="card-list">
        {conv?.messages.map(m => (
          <li key={m.id}>
            <small className="muted">{m.mine ? "You" : conv.counterpartName} · {new Date(m.sentAt).toLocaleString("en-AU")}</small>
            <div className="pre">{m.body}</div>
          </li>
        ))}
      </ul>
      {conv && !conv.open && <p className="muted">This appointment has ended, so no new messages can be sent.</p>}
      {conv?.open && (
        <form className="stack" onSubmit={onSend}>
          <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={3} maxLength={5000} required aria-label="Message" />
          <button type="submit" disabled={busy}>{busy ? "Sending…" : "Send"}</button>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
    </main>
  );
}
