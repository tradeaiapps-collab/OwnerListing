"use client";
import { useState } from "react";
import { useParams } from "next/navigation";
import { JSON_HEADERS } from "../../ui";
import "../../../styles/enquiries.css";

/** Buyer screen: message the owner of a published listing. The server checks verification, limits and the listing. */
export default function Enquire() {
  const { id } = useParams<{ id: string }>();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [threadId, setThreadId] = useState("");

  async function onSend(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/listings/${id}/enquiries`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ body: text }) });
      const d = await r.json();
      if (r.ok) setThreadId(d.enquiry.id);
      else setError(r.status === 401 ? "Sign in to contact the owner." : d.error ?? "Could not send your message.");
    } catch {
      setError("Could not send your message.");
    } finally {
      setBusy(false);
    }
  }

  if (threadId) return <main><p role="status">Message sent. <a href={`/enquiries/${threadId}`}>Open the conversation</a>.</p></main>;
  return (
    <main>
      <p><a href={`/listings/${id}`}>Back to the listing</a></p>
      <h1>Contact the owner</h1>
      <p className="muted">You need a verified email, mobile and ID check. Messages are a permanent record and cannot be edited or deleted. Offers made in messages are not formal offers.</p>
      <form className="stack" onSubmit={onSend}>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={5} maxLength={4000} required aria-label="Message to the owner" />
        <button type="submit" disabled={busy || !text.trim()}>{busy ? "Sending…" : "Send message"}</button>
        {error && <p role="alert">{error}</p>}
      </form>
    </main>
  );
}
