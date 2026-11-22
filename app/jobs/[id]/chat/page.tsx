"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { JSON_HEADERS } from "../../../listings/ui";

type Message = { id: string; senderId: string; body: string; sentAt: string };

export default function JobChat() {
  const { id } = useParams<{ id: string }>();
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const r = await fetch(`/api/jobs/${id}/messages`);
      const d = await r.json();
      if (r.ok) setMessages(d.messages);
      else setLoadError(r.status === 401 ? "Sign in to read this chat." : r.status === 404 ? "Chat not found." : d.error ?? "Could not load the chat.");
    } catch {
      setLoadError("Could not load the chat.");
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  async function onSend(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/jobs/${id}/messages`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ body: draft }) });
      const d = await r.json();
      if (r.ok) {
        setDraft("");
        setMessages(prev => [...(prev ?? []), d.message]);
      } else setError(r.status === 401 ? "Sign in to send messages." : d.error ?? "Could not send the message.");
    } catch {
      setError("Could not send the message.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Job chat</h1>
      <p><a href={`/jobs/${id}/details`}>Job details, quotes and reviews</a></p>
      <p className="muted">Messages are a permanent record and cannot be edited or deleted.</p>
      {loadError && <p role="alert">{loadError}</p>}
      {!loadError && messages === null && <p className="muted" role="status">Loading…</p>}
      {messages && messages.length === 0 && <p className="empty">No messages yet.</p>}
      <ul className="card-list">
        {messages?.map(m => (
          <li key={m.id}>
            <small className="muted">{new Date(m.sentAt).toLocaleString("en-AU")}</small>
            <div className="pre">{m.body}</div>
          </li>
        ))}
      </ul>
      {messages && (
        <form className="stack" onSubmit={onSend}>
          <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={3} maxLength={5000} required aria-label="Message" />
          <button type="submit" disabled={busy}>{busy ? "Sending…" : "Send"}</button>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
    </main>
  );
}
