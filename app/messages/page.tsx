"use client";
import { useEffect, useState } from "react";
import "../styles/offers.css";
import "../styles/messages.css";

interface Row { id: string; kind: "transaction" | "channel"; title: string; role: string; unread: number; muted: boolean; archived: boolean; lastBody: string | null; lastAt: string | null; lastSender: string | null }
const ROLE: Record<string, string> = { buyer: "You are the buyer", seller: "You are the owner", agent: "You are the agent", staff: "Team channel" };
const when = (iso: string) => new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** One inbox: the sales you are part of and, for staff, the team channels. Unread counts ignore muted and archived threads. */
export default function Inbox() {
  const [d, setD] = useState<{ threads: Row[]; unread: number } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/messages").then(async r => {
      const j = await r.json().catch(() => ({}));
      if (r.ok) setD(j); else setError(r.status === 401 ? "Sign in to see your messages." : j.error ?? "Could not load your messages.");
    }).catch(() => setError("Could not load your messages."));
  }, []);
  if (error) return <main><h1>Messages</h1><p role="alert">{error}</p></main>;
  if (!d) return <main><h1>Messages</h1><p className="muted" role="status">Loading…</p></main>;
  return (
    <main>
      <h1>Messages</h1>
      <p className="muted">{d.unread ? `${d.unread} unread` : "You are all caught up."}</p>
      {d.threads.length === 0 ? <p className="muted">No conversations yet. One opens for each sale once the settlement is started.</p> : (
        <ul className="msg-list">
          {d.threads.map(t => (
            <li key={t.id}>
              <a href={`/messages/${t.id}`}>
                <span className="msg-head">
                  <strong>{t.title}</strong>
                  {t.unread && !t.muted && !t.archived ? <span className="msg-count" aria-label={`${t.unread} unread`}>{t.unread}</span> : null}
                  {t.muted ? <span className="badge">Muted</span> : null}
                  {t.archived ? <span className="badge">Archived</span> : null}
                  {t.lastAt ? <time dateTime={t.lastAt}>{when(t.lastAt)}</time> : null}
                </span>
                <small className="muted">{ROLE[t.role]}</small>
                <span className="msg-last">{t.lastBody ? `${t.lastSender ? `${t.lastSender}: ` : ""}${t.lastBody}` : "No messages yet."}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
