"use client";
import { useEffect, useState } from "react";
import { JSON_HEADERS, fieldStyle } from "../listings/ui";

interface Item { enquiry: { id: string }; listingTitle: string; role: "buyer" | "owner"; unread: boolean }
interface Msg { id: string; senderUserId: string | null; automated: boolean; body: string; sentAt: string }

// The system's offer prompt contains our own single-use link; show it as a link and everything else as plain text.
const LINK = /(https?:\/\/\S*\/offers\/new\?token=[\w-]+)/;
function MessageBody({ m }: { m: Msg }) {
  if (!m.automated) return <>{m.body}</>;
  return <>{m.body.split(LINK).map((part, i) => (i % 2 === 1 ? <a key={i} href={part}>Open the offer form</a> : part))}</>;
}

export default function Enquiries() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [open, setOpen] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/enquiries").then(async r => {
      if (r.status === 401) return setSignedOut(true);
      setItems((await r.json()).items ?? []);
    }).catch(() => setError("Could not load messages."));
  }, []);

  async function load(id: string) {
    setOpen(id);
    setError("");
    const r = await fetch(`/api/enquiries/${id}/messages`);
    if (r.ok) setMsgs((await r.json()).messages);
    else setError("Could not load this conversation.");
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch(`/api/enquiries/${open}/messages`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ body: text }) });
    if (!r.ok) return setError((await r.json()).error ?? "Could not send.");
    setText("");
    await load(open);
  }

  if (signedOut) return <main><p role="alert"><a href="/api/auth/google/start">Sign in with Google</a> to see your messages.</p></main>;
  return (
    <main style={{ overflowWrap: "anywhere" }}>
      <h1>Messages</h1>
      {error && <p role="alert">{error}</p>}
      {items === null && !error && <p>Loading...</p>}
      {items && items.length === 0 && <p>No conversations yet.</p>}
      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
        {items?.map(i => (
          <li key={i.enquiry.id}>
            <button type="button" onClick={() => load(i.enquiry.id)} style={{ ...fieldStyle, textAlign: "left" }} aria-pressed={open === i.enquiry.id}>
              {i.unread && <strong>New: </strong>}{i.listingTitle || "Listing"} <small>({i.role === "owner" ? "on your listing" : "you asked"})</small>
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <section>
          <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
            {msgs.map(m => (
              <li key={m.id} style={{ border: "1px solid #8884", borderRadius: 8, padding: 8, whiteSpace: "pre-wrap" }}>
                <MessageBody m={m} /><br /><small>{new Date(m.sentAt).toLocaleString("en-AU")}</small>
              </li>
            ))}
          </ul>
          <form onSubmit={send} style={{ display: "grid", gap: 8, marginTop: 12 }}>
            <textarea value={text} onChange={e => setText(e.target.value)} maxLength={4000} rows={3} required style={fieldStyle} aria-label="Reply" />
            <button type="submit" disabled={!text.trim()} style={fieldStyle}>Send</button>
          </form>
        </section>
      )}
    </main>
  );
}
