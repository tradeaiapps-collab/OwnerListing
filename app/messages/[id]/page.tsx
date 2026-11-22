"use client";
import { use, useCallback, useEffect, useRef, useState } from "react";
import "../../styles/offers.css";
import "../../styles/messages.css";

interface Msg { id: string; type: "text" | "mention" | "system"; body: string; mentions: string[]; createdAt: string; mine: boolean; unread: boolean; sender: { name: string; role: string | null } | null; replyTo: { id: string; snippet: string; senderName: string | null } | null }
interface View { id: string; kind: "transaction" | "channel"; title: string; role: string; archived: boolean; muted: boolean; people: { role: string; name: string }[]; messages: Msg[]; unread: number }
const when = (iso: string) => new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const MENTION = /(^|[^\w@])(@(?:buyer|seller|agent))\b/gi;

/** Highlights @buyer, @seller and @agent without rendering any HTML from the message. */
function Body({ text }: { text: string }) {
  const parts: (string | { m: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    const at = (m.index ?? 0) + m[1]!.length;
    parts.push(text.slice(last, at), { m: m[2]! });
    last = at + m[2]!.length;
  }
  parts.push(text.slice(last));
  return <p className="msg-body">{parts.map((p, i) => (typeof p === "string" ? p : <span key={i} className="msg-mention">{p.m}</span>))}</p>;
}

/** One conversation: a sale thread (buyer, owner, agent) or a staff channel. Opening it marks it read. */
export default function Thread({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [v, setV] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [reply, setReply] = useState<Msg | null>(null);
  const [busy, setBusy] = useState(false);
  const marked = useRef(false);
  const composer = useRef<HTMLTextAreaElement>(null);

  const post = useCallback(async (body: Record<string, unknown>) => {
    const r = await fetch(`/api/messages/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    if (!r) return "Network error.";
    return r.ok ? "" : ((await r.json().catch(() => ({}))) as { error?: string }).error ?? "That did not work.";
  }, [id]);

  const load = useCallback(async () => {
    const r = await fetch(`/api/messages/${id}`).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (r?.ok) { setV(d as View); setError(""); } else setError(r?.status === 401 ? "Sign in to see this conversation." : r?.status === 404 ? "Conversation not found." : "Could not load this conversation.");
  }, [id]);

  useEffect(() => { void load(); const t = setInterval(() => { if (!document.hidden) void load(); }, 20000); return () => clearInterval(t); }, [load]);
  // Mark read once what you can see is on screen; the unread highlight stays until the next refresh.
  useEffect(() => { if (v && !marked.current) { marked.current = true; void post({ action: "read" }); } }, [v, post]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    const err = await post({ body: text, replyToId: reply?.id ?? null });
    setBusy(false);
    setError(err);
    if (!err) { setText(""); setReply(null); marked.current = false; await load(); }
  }
  /** Choose which message to answer: highlight it, show it above the box and put the cursor in the box. */
  function startReply(m: Msg) {
    setReply(m);
    composer.current?.focus({ preventScroll: true });
    composer.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  async function manage(body: Record<string, unknown>) { setError(await post(body)); await load(); }

  if (error && !v) return <main><p role="alert">{error}</p><p><a href="/messages">Back to messages</a></p></main>;
  if (!v) return <main><p className="muted" role="status">Loading…</p></main>;
  const closed = v.archived;
  return (
    <main>
      <p><a href="/messages">Back to messages</a></p>
      <h1>{v.title}</h1>
      <p className="muted">{v.kind === "channel" ? "Team channel. Everyone with access can read and write here." : `In this conversation: ${v.people.map(p => p.name + " (" + p.role + ")").join(", ")}. Use @buyer, @seller or @agent to get someone's attention.`}</p>
      <p className="muted msg-help">Messages are marked as read when you open this conversation. To answer a particular message, press Reply under it.</p>
      <div className="msg-tools">
        <button type="button" onClick={() => manage({ action: "mute", muted: !v.muted })}>{v.muted ? "Unmute alerts" : "Mute alerts"}</button>
        {v.kind === "transaction" ? <button type="button" onClick={() => manage({ action: "archive", archived: !v.archived })}>{v.archived ? "Reopen conversation" : "Archive conversation"}</button> : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {v.messages.length === 0 ? <p className="muted">No messages yet. Say hello.</p> : (
        <ol className="msg-thread" aria-live="polite">
          {v.messages.map(m => (
            <li key={m.id} className={`msg ${m.type === "system" ? "is-system" : m.mine ? "is-mine" : ""} ${m.unread ? "is-unread" : ""} ${reply?.id === m.id ? "is-replying" : ""}`}>
              {m.type === "system" ? null : <span className="msg-meta"><strong>{m.mine ? "You" : m.sender?.name}</strong>{m.sender?.role ? <span>{m.sender.role}</span> : null}<time dateTime={m.createdAt}>{when(m.createdAt)}</time>{m.unread ? <span className="badge">New</span> : null}</span>}
              {m.replyTo ? <blockquote className="msg-quote">{m.replyTo.senderName ? `${m.replyTo.senderName}: ` : ""}{m.replyTo.snippet}</blockquote> : null}
              <Body text={m.body} />
              {m.type === "system" ? <span className="msg-meta"><time dateTime={m.createdAt}>{when(m.createdAt)}</time></span> : closed ? null : <button type="button" className="msg-reply-btn" aria-pressed={reply?.id === m.id} aria-label={`Reply to ${m.mine ? "your message" : m.sender?.name ?? "this message"}`} onClick={() => (reply?.id === m.id ? setReply(null) : startReply(m))}>{reply?.id === m.id ? "Replying…" : "Reply"}</button>}
            </li>
          ))}
        </ol>
      )}
      {closed ? <p className="ai-note">This conversation is archived. Reopen it to write.</p> : (
        <form className="msg-composer" onSubmit={send}>
          {reply ? (
            <div className="msg-replying" role="status">
              <p className="msg-replying-text" title={reply.body}><strong>Replying to {reply.mine ? "your message" : reply.sender?.name ?? "the platform"}</strong><span>{reply.body}</span></p>
              <button type="button" className="secondary msg-cancel" onClick={() => setReply(null)}>Cancel</button>
            </div>
          ) : null}
          <label htmlFor="msg-text" className="muted">Message</label>
          <textarea id="msg-text" ref={composer} onKeyDown={e => { if (e.key === "Escape" && reply) setReply(null); }} value={text} maxLength={5000} onChange={e => setText(e.target.value)} placeholder="Write a message" />
          <div className="msg-row"><span className="grow">{text.length}/5000</span><button type="submit" disabled={busy || !text.trim()}>{busy ? "Sending…" : "Send"}</button></div>
        </form>
      )}
    </main>
  );
}
