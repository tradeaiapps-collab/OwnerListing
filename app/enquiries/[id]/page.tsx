"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import type { ChatLang } from "../../../src/domain/language-detect";
import { JSON_HEADERS } from "../../listings/ui";
import { CopilotPanel } from "../copilot-panel";
import { ElenaCard } from "../elena-card";
import { ModerationPanel } from "../moderation-panel";
import { MessageWarning, SafetySummary, useSafety } from "../safety-panel";
import "../../styles/enquiries.css";
import "../../styles/chat-copilot.css";

type Message = { id: string; senderUserId: string | null; automated: boolean; elena?: boolean; body: string; sentAt: string };
type ThreadData = { enquiry: { listingId: string; buyerUserId: string }; messages: Message[]; readByOthersAt?: string; listingNumber?: number };
type OfferLinkState = {
  role: "buyer" | "owner";
  request?: { status: "requested" | "issued" | "declined" };
  link?: { token: string; listingId: string; expiresAt: string };
};
type Facts = { listing: { title: string; address: string; askingCents?: number }; offer?: { priceCents: number; status: string } };
type AssistantView = { persona: { name: string; portrait: string }; viewerId: string; role: "buyer" | "owner" | "agent"; facts: Facts };

const OFFER_STATUS: Record<string, string> = {
  submitted: "With the owner", under_review: "With the owner", countered: "Owner countered", buyer_countered: "Buyer countered",
  accepted: "Accepted", rejected: "Declined", withdrawn: "Withdrawn", expired: "Expired"
};
const aud = (c: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(c / 100);
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
const dayKey = (iso: string) => new Date(iso).toDateString();
const dayLabel = (iso: string) => {
  const d = new Date(iso), t = new Date();
  const diff = Math.round((new Date(t.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
};

/** Sent (one tick) and read (two ticks). Read means the other side opened the thread after the message was sent. */
function Ticks({ read }: { read: boolean }) {
  return <span className={`cx-ticks${read ? " is-read" : ""}`} role="img" aria-label={read ? "Read" : "Sent"}>{read ? "✓✓" : "✓"}</span>;
}

/** One enquiry thread for its buyer and the listing's owner (or agent): the conversation on the left, Elena on the right. */
export default function Thread() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<ThreadData | null>(null);
  const [ai, setAi] = useState<AssistantView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<"chat" | "elena">("chat");
  const { safety, reload: reloadSafety } = useSafety(id);
  const endRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const count = useRef(0);
  const [msgTr, setMsgTr] = useState<Record<string, { state: "loading" } | { state: "error"; message: string } | { state: "done"; text: string; to: ChatLang; note: string; rtl: boolean }>>({});

  async function translateMessage(messageId: string) {
    setMsgTr(m => ({ ...m, [messageId]: { state: "loading" } }));
    try {
      const r = await fetch(`/api/enquiries/${id}/messages/${messageId}/translate`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({}) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsgTr(m => ({ ...m, [messageId]: { state: "error", message: (d as { error?: string }).error ?? "Couldn't translate that message." } })); return; }
      const t = (d as { translation: { text: string; to: ChatLang; note: string; rtl: boolean } }).translation;
      setMsgTr(m => ({ ...m, [messageId]: { state: "done", ...t } }));
    } catch {
      setMsgTr(m => ({ ...m, [messageId]: { state: "error", message: "Couldn't translate that message." } }));
    }
  }

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/enquiries/${id}/messages`);
      const d = await r.json();
      if (r.ok) { setData(d); setLoadError(""); }
      else setLoadError(r.status === 401 ? "Sign in to read this conversation." : r.status === 404 ? "Conversation not found." : d.error ?? "Could not load the conversation.");
    } catch {
      setLoadError("Could not load the conversation.");
    }
  }, [id]);

  const [olr, setOlr] = useState<OfferLinkState | null>(null);
  const loadOlr = useCallback(async () => {
    try {
      const r = await fetch(`/api/enquiries/${id}/offer-link`);
      if (r.ok) setOlr(await r.json());
    } catch { /* the thread still works without this panel */ }
  }, [id]);

  useEffect(() => {
    void load(); void loadOlr();
    fetch(`/api/enquiries/${id}/assistant`).then(r => (r.ok ? r.json() : null)).then(d => { if (d) setAi(d as AssistantView); }).catch(() => { /* Elena still works without her portrait */ });
  }, [id, load, loadOlr]);
  // New messages and read ticks arrive by polling while the page is visible.
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 8000);
    return () => clearInterval(t);
  }, [load]);
  // Elena is on this page, so the floating guide steps aside.
  useEffect(() => { document.body.classList.add("el-chat-page"); return () => document.body.classList.remove("el-chat-page"); }, []);
  useEffect(() => {
    const n = data?.messages.length ?? 0;
    if (n !== count.current) { count.current = n; endRef.current?.scrollIntoView({ block: "end" }); }
  }, [data]);

  async function olrAction(action: "request" | "issue" | "decline") {
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/enquiries/${id}/offer-link`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action }) });
      if (!r.ok) setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "That did not work.");
      await Promise.all([load(), loadOlr()]);
    } catch { setError("That did not work."); } finally { setBusy(false); }
  }

  /** The one place a message is sent. Elena's drafts also come through here, only after the person pressed send. */
  async function send(text: string, fromBox: boolean) {
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/enquiries/${id}/messages`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ body: text }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { if (fromBox) setDraft(""); await Promise.all([load(), reloadSafety()]); }
      else setError((d as { error?: string }).error ?? "Could not send the message.");
    } catch { setError("Could not send the message."); } finally { setBusy(false); }
  }

  const useDraft = (text: string) => { setDraft(text); setTab("chat"); requestAnimationFrame(() => composerRef.current?.focus()); };
  const viewerId = ai?.viewerId;
  const role = ai?.role ?? olr?.role ?? "buyer";
  const readAt = data?.readByOthersAt;
  const lastIncoming = useMemo(() => [...(data?.messages ?? [])].reverse().find(m => !m.automated && m.senderUserId !== viewerId)?.id, [data, viewerId]);
  const facts = ai?.facts;
  const num = data?.listingNumber;
  const mine = (m: Message) => m.senderUserId !== null && m.senderUserId === viewerId;
  const sideOf = (m: Message) => (m.elena ? "Elena (AI assistant)" : m.automated ? "Notice" : m.senderUserId === data?.enquiry.buyerUserId ? "Buyer" : role === "agent" ? "Agent" : "Owner");
  const refreshKey = data?.messages.length ?? 0;

  return (
    <main className="cx-page">
      <p className="cx-back"><a href="/enquiries">Back to messages</a></p>
      {loadError && <p role="alert">{loadError}</p>}
      {!loadError && !data && <p className="muted" role="status">Loading…</p>}
      {data && (
        <>
          <header className="cx-head">
            <div>
              <p className="cx-number">{num ? `Listing #${num}` : "Listing"}</p>
              <h1>{facts?.listing.title ?? "Conversation"}</h1>
              {facts && <p className="muted">{facts.listing.address}</p>}
            </div>
            <ul className="cx-facts" aria-label="Price">
              {facts?.listing.askingCents !== undefined && <li><span>Asking</span><strong>{aud(facts.listing.askingCents)}</strong></li>}
              {facts?.offer && <li><span>Formal offer</span><strong>{aud(facts.offer.priceCents)}</strong><small>{OFFER_STATUS[facts.offer.status] ?? facts.offer.status}</small></li>}
            </ul>
          </header>

          <div className="cx-tabs" role="tablist" aria-label="Conversation or Elena">
            <button type="button" role="tab" aria-selected={tab === "chat"} onClick={() => setTab("chat")}>Chat</button>
            <button type="button" role="tab" aria-selected={tab === "elena"} onClick={() => setTab("elena")}>{ai?.persona.name ?? "Elena"}</button>
          </div>

          <div className="cx-grid" data-tab={tab}>
            <section className="cx-chat" aria-label="Conversation">
              {safety && olr?.role === "owner" && <SafetySummary enquiryId={id} safety={safety} onChange={reloadSafety} />}
              <ol className="cx-thread" aria-live="polite">
                {data.messages.length === 0 && <li className="empty">No messages yet. Say hello below, or ask {ai?.persona.name ?? "Elena"} to help you word it.</li>}
                {data.messages.map((m, i) => {
                  const prev = data.messages[i - 1];
                  const flag = safety?.flags.find(f => f.messageId === m.id);
                  const tr = msgTr[m.id];
                  const read = !!readAt && readAt >= m.sentAt;
                  return (
                    <li key={m.id}>
                      {(!prev || dayKey(prev.sentAt) !== dayKey(m.sentAt)) && <p className="cx-day"><span>{dayLabel(m.sentAt)}</span></p>}
                      <div className={`cx-msg${mine(m) ? " mine" : ""}${m.automated && !m.elena ? " system" : ""}${m.id === lastIncoming ? " latest-in" : ""}`}>
                        {!mine(m) && <span className="cx-who">{sideOf(m)}</span>}
                        <p className="cx-body">{m.body}</p>
                        <span className="cx-meta">
                          {clock(m.sentAt)}
                          {mine(m) && <Ticks read={read} />}
                        </span>
                      </div>
                      {!m.automated && !mine(m) && (
                        <div className="cx-translate">
                          {tr?.state === "done" ? (
                            <div className="cx-tr-box" lang={tr.to} dir={tr.rtl ? "rtl" : "ltr"}><p>{tr.text}</p><small>{tr.note}</small></div>
                          ) : (
                            <button type="button" className="cx-link" disabled={tr?.state === "loading"} onClick={() => void translateMessage(m.id)}>{tr?.state === "loading" ? "Translating…" : "Translate"}</button>
                          )}
                          {tr?.state === "error" && <p role="alert" className="cx-error">{tr.message}</p>}
                        </div>
                      )}
                      {flag && <MessageWarning flag={flag} />}
                    </li>
                  );
                })}
                <li ref={el => { endRef.current = el as unknown as HTMLDivElement; }} aria-hidden="true" />
              </ol>

              <ElenaCard enquiryId={id} refreshKey={refreshKey} onChanged={() => void load()} />

              <form className="cx-composer" onSubmit={e => { e.preventDefault(); void send(draft, true); }}>
                <label htmlFor="cx-reply" className="cx-sr">Message</label>
                <textarea ref={composerRef} id="cx-reply" value={draft} rows={3} maxLength={4000} required placeholder="Write your message" onChange={e => setDraft(e.target.value)} />
                <div className="cx-row">
                  <small className="muted">Messages are a permanent record and can&apos;t be edited or deleted. Offers here are not formal offers.</small>
                  <button type="submit" className="cx-btn" disabled={busy || !draft.trim()}>{busy ? "Sending…" : "Send"}</button>
                </div>
                {error && <p role="alert" className="cx-error">{error}</p>}
              </form>

              {olr?.role === "owner" && <ModerationPanel enquiryId={id} draft={draft} onUse={setDraft} name={ai?.persona.name} />}

              {olr && (
                <section id="el-offer-link" aria-label="Formal offer link" className="cx-offer-link">
                  <h2>Formal offer link</h2>
                  {olr.role === "buyer" && olr.link && (
                    <p><a href={`/offers/new?listing=${encodeURIComponent(olr.link.listingId)}#token=${encodeURIComponent(olr.link.token)}`}>Make a formal offer</a> (single use, expires {new Date(olr.link.expiresAt).toLocaleString("en-AU")}).</p>
                  )}
                  {olr.role === "buyer" && olr.request?.status === "requested" && <p className="muted">Waiting for the owner to answer your request.</p>}
                  {olr.role === "buyer" && olr.request?.status !== "requested" && !olr.link && (
                    <button type="button" className="cx-btn secondary" disabled={busy} onClick={() => void olrAction("request")}>Request an offer link</button>
                  )}
                  {olr.role === "owner" && olr.request?.status === "requested" && (
                    <p>
                      <button type="button" className="cx-btn" disabled={busy} onClick={() => void olrAction("issue")}>Approve and issue link</button>{" "}
                      <button type="button" className="cx-btn secondary" disabled={busy} onClick={() => void olrAction("decline")}>Decline</button>
                    </p>
                  )}
                  {olr.role === "owner" && olr.request?.status !== "requested" && <p className="muted">No open request. You decide every offer yourself; nothing is accepted automatically.</p>}
                </section>
              )}
            </section>

            <CopilotPanel enquiryId={id} persona={ai?.persona ?? null} refreshKey={refreshKey} onUse={useDraft} onSend={t => send(t, false)} busy={busy} />
          </div>
        </>
      )}
    </main>
  );
}
