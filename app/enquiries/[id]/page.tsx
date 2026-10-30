"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { showMeFor, type AssistantThread, type AssistantTurn, type ChatAnswer, type ChatFacts, type ChatPose, type ChatTopic } from "../../../src/domain/chat-assistant";
import { personaPose } from "../../../src/domain/assistant-persona";
import { formatAud } from "../../../src/domain/listing-details";
import { JSON_HEADERS } from "../../listings/ui";
import { AiReplyPanel } from "../ai-reply-panel";
import { ElenaStage, speak, type StageState } from "../elena-stage";
import { showMe } from "../show-me";
import { MessageWarning, SafetySummary, useSafety } from "../safety-panel";
import "../../styles/enquiries.css";

type Message = { id: string; senderUserId: string | null; automated: boolean; body: string; sentAt: string };

type OfferLinkState = {
  role: "buyer" | "owner";
  request?: { status: "requested" | "issued" | "declined" };
  link?: { token: string; listingId: string; expiresAt: string };
};

/** Where she points for each kind of answer: a row of the offer summary, the listing, her suggestions, or the question itself. */
type Target = "price" | "settlement" | "deposit" | "conditions" | "listing" | "status" | "chips" | `q-${string}`;
const TARGETS: Record<ChatTopic, (turnId: string) => Target[]> = {
  welcome: () => ["chips"], offer: () => ["price", "status"], compromise: () => ["price", "chips"], settlement: () => ["settlement"],
  deposit: () => ["deposit"], conditions: () => ["conditions"], listing: () => ["listing"], next_steps: () => ["status"],
  privacy: id => [`q-${id}`], advice: id => [`q-${id}`], chitchat: id => [`q-${id}`], unknown: id => [`q-${id}`]
};
const STATUS_FOR: Record<ChatPose, StageState["status"]> = { wave: "welcome", tablet: "presenting", front: "explaining", "three-quarter": "careful" };
const POINT_MS = 4500;

const OFFER_STATUS: Record<string, string> = {
  submitted: "With the owner", under_review: "With the owner", countered: "Owner countered", buyer_countered: "Buyer countered",
  accepted: "Accepted", rejected: "Declined", withdrawn: "Withdrawn", expired: "Expired"
};
const roleName = (r: string) => (r === "buyer" ? "Buyer" : r === "agent" ? "Agent" : "Owner");
const time = (iso: string) => new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** Small fact pills under her newest answer, so what she refers to is right beside it (and lights up with the summary row). */
function pillsFor(topic: ChatTopic, f: ChatFacts): { target: Target; text: string }[] {
  const o = f.offer, l = f.listing, tx = l.transactionType;
  const m = (c: number) => (tx === "rent" ? `${formatAud(c)}/wk` : formatAud(c));
  switch (topic) {
    case "offer": case "compromise": {
      const out: { target: Target; text: string }[] = [];
      if (o) out.push({ target: "price", text: `Offer ${m(o.priceCents)}` });
      if (o?.counter?.status === "open") out.push({ target: "price", text: `${o.counter.fromParty === "owner" ? "Owner" : "Buyer"} counter ${m(o.counter.priceCents)}` });
      else if (l.askingCents) out.push({ target: "price", text: `Asking ${m(l.askingCents)}` });
      return out;
    }
    case "settlement": return o ? [{ target: "settlement", text: `Settlement ${o.settlementDays} days` }] : [];
    case "deposit": return o ? [{ target: "deposit", text: `Deposit ${formatAud(o.depositCents)}` }] : [];
    case "conditions": return o ? o.conditions.map(c => ({ target: "conditions" as Target, text: c })) : [];
    case "listing": return [{ target: "listing", text: [l.bedrooms !== undefined && `${l.bedrooms} bed`, l.bathrooms !== undefined && `${l.bathrooms} bath`, l.parking !== undefined && `${l.parking} car`].filter(Boolean).join(" · ") || l.title }];
    default: return [];
  }
}

/** One enquiry thread, for its buyer and the listing's owner, with the assistant on stage. Messages cannot be edited or deleted. */
export default function Thread() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<{ enquiry: { listingId: string; buyerUserId: string }; messages: Message[] } | null>(null);
  const [ai, setAi] = useState<AssistantThread | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [draft, setDraft] = useState("");
  const [typing, setTyping] = useState(false);
  const [pointed, setPointed] = useState<Target[]>([]);
  const [voice, setVoice] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const { safety, reload: reloadSafety } = useSafety(id);
  const pointTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const endRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const [walking, setWalking] = useState(false);

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

  const loadAi = useCallback(async () => {
    try {
      const r = await fetch(`/api/enquiries/${id}/assistant`);
      if (r.ok) setAi(await r.json());
    } catch { /* the thread still works without the assistant */ }
  }, [id]);

  const [olr, setOlr] = useState<OfferLinkState | null>(null);
  const loadOlr = useCallback(async () => {
    try {
      const r = await fetch(`/api/enquiries/${id}/offer-link`);
      if (r.ok) setOlr(await r.json());
    } catch { /* the thread still works without this panel */ }
  }, [id]);

  useEffect(() => { void load(); void loadOlr(); void loadAi(); }, [load, loadOlr, loadAi]);
  // The floating guide is the same character; on this page she is already on stage, so the launcher steps aside.
  useEffect(() => { document.body.classList.add("el-chat-page"); return () => document.body.classList.remove("el-chat-page"); }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => () => { clearTimeout(pointTimer.current); if (typeof window !== "undefined") window.speechSynthesis?.cancel(); }, []);

  const point = useCallback((targets: Target[]) => {
    clearTimeout(pointTimer.current);
    setPointed(targets);
    pointTimer.current = setTimeout(() => setPointed([]), POINT_MS);
  }, []);

  async function olrAction(action: "request" | "issue" | "decline") {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/enquiries/${id}/offer-link`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action }) });
      if (!r.ok) setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "That did not work.");
      await Promise.all([load(), loadOlr()]);
    } catch {
      setError("That did not work.");
    } finally {
      setBusy(false);
    }
  }

  async function onSend(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/enquiries/${id}/messages`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ body: draft }) });
      const d = await r.json();
      if (r.ok) {
        setDraft("");
        await Promise.all([load(), reloadSafety()]);
      } else setError(d.error ?? "Could not send the message.");
    } catch {
      setError("Could not send the message.");
    } finally {
      setBusy(false);
    }
  }

  async function walkTo(places: Parameters<typeof showMe>[0]["places"]) {
    const figure = document.querySelector<HTMLElement>(".el-stage-figure");
    if (!figure || !ai) return;
    const pose = personaPose(ai.persona, "tablet");
    setWalking(true);
    try {
      const found = await showMe({ from: figure, places, src: pose.src, flip: true, cancelled: () => !alive.current });
      if (!found) setError("I can't see that on this screen. Open the menu and try again.");
    } finally {
      if (alive.current) setWalking(false);
    }
  }

  /** Speak a question instead of typing it, using the browser's own speech recognition (no outside service). Her answer is then read aloud. */
  function listen() {
    type Rec = { lang: string; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null; start: () => void };
    const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) { setError("Speaking to her isn't supported in this browser. You can type instead."); return; }
    const rec = new Ctor();
    rec.lang = "en-AU";
    setError("");
    setListening(true);
    rec.onresult = e => {
      const said = e.results[0]?.[0]?.transcript?.trim();
      if (said) { setVoice(true); void ask(said.slice(0, 500), false); }
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => { setListening(false); setError("I couldn't hear that. Check the microphone is allowed, or type instead."); };
    rec.start();
  }

  async function ask(question: string, fromComposer: boolean) {
    const q = question.trim();
    if (!q) return;
    setAsking(true);
    setError("");
    try {
      const r = await fetch(`/api/enquiries/${id}/assistant`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ question: q }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError((d as { error?: string }).error ?? "The assistant could not answer just now."); return; }
      const turn = (d as { turn: AssistantTurn }).turn;
      if (fromComposer) setDraft("");
      setAi(a => (a ? { ...a, turns: [...a.turns, turn] } : a));
      point(TARGETS[turn.topic](turn.id));
      if (voice && speak(turn.answer, () => setSpeaking(false))) setSpeaking(true);
      requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    } catch {
      setError("The assistant could not answer just now.");
    } finally {
      setAsking(false);
    }
  }

  const latest: (ChatAnswer & { id: string }) | undefined = useMemo(() => {
    if (!ai) return undefined;
    const t = ai.turns[ai.turns.length - 1];
    return t ? { id: t.id, topic: t.topic, pose: t.pose, text: t.answer, suggestions: ai.welcome.suggestions } : { id: "welcome", ...ai.welcome };
  }, [ai]);

  const stage: StageState = asking
    ? { pose: "listening", status: "thinking", pointing: false }
    : typing && draft.trim()
      ? { pose: "listening", status: "listening", pointing: false }
      : { pose: latest?.pose ?? "wave", status: STATUS_FOR[latest?.pose ?? "wave"], pointing: pointed.length > 0 };

  const timeline = useMemo(() => {
    const items: ({ kind: "msg"; at: string; m: Message } | { kind: "turn"; at: string; t: AssistantTurn })[] = [
      ...(data?.messages ?? []).map(m => ({ kind: "msg" as const, at: m.sentAt, m })),
      ...(ai?.turns ?? []).map(t => ({ kind: "turn" as const, at: t.createdAt, t }))
    ];
    return items.sort((a, b) => a.at.localeCompare(b.at));
  }, [data, ai]);

  const isPointed = (t: Target) => pointed.includes(t);
  const pc = (t: Target) => (isPointed(t) ? " is-pointed" : "");
  const facts = ai?.facts;
  const offer = facts?.offer;
  const mine = (sender: string | null) => sender !== null && sender === ai?.viewerId;
  const latestTurn = ai?.turns[ai.turns.length - 1];
  const latestTurnId = latestTurn?.id;
  const showMeNow = ai && latestTurn ? showMeFor(latestTurn.topic, ai.role, ai.facts) : undefined;

  const suggestions = (sug: string[]) => (
    <div className={`el-chips${pc("chips")}`} role="group" aria-label={`Ask ${ai?.persona.name ?? "the assistant"}`}>
      {sug.map(s => <button key={s} type="button" className="el-chip" disabled={asking} onClick={() => void ask(s, false)}>{s}</button>)}
    </div>
  );

  return (
    <main className="el-page">
      <p><a href="/enquiries">Back to messages</a></p>
      <h1>Conversation</h1>
      <p className="muted">Messages are a permanent record and cannot be edited or deleted. Offers made here are not formal offers.</p>
      {loadError && <p role="alert">{loadError}</p>}
      {!loadError && !data && <p className="muted" role="status">Loading…</p>}
      {data && (
        <div className={`el-layout${ai ? " has-stage" : ""}`}>
          {ai && <ElenaStage persona={ai.persona} state={stage} speaking={speaking} voice={voice} onVoice={setVoice} />}
          <div className="el-chat">
            {safety && olr?.role === "owner" && <SafetySummary enquiryId={id} safety={safety} onChange={reloadSafety} />}
            {facts && (
              <section className="el-facts" aria-label="Listing and offer">
                <div className={`el-fact el-fact-listing${pc("listing")}`}>
                  <span className="el-fact-title">{facts.listing.title}</span>
                  <span className="el-fact-sub">{facts.listing.address}</span>
                </div>
                <dl className="el-fact-grid">
                  <div className={`el-fact${pc("price")}`}><dt>{offer ? "Offer" : "Asking"}</dt><dd>{offer ? formatAud(offer.priceCents) : facts.listing.askingCents ? formatAud(facts.listing.askingCents) : "Not shown"}</dd></div>
                  {offer && <div className={`el-fact${pc("settlement")}`}><dt>Settlement</dt><dd>{offer.settlementDays} days</dd></div>}
                  {offer && <div className={`el-fact${pc("deposit")}`}><dt>Deposit</dt><dd>{formatAud(offer.depositCents)}</dd></div>}
                  {offer && <div className={`el-fact${pc("conditions")}`}><dt>Conditions</dt><dd>{offer.conditions.length ? offer.conditions.map(c => c.replace(/^subject to /i, "")).join(", ") : "None"}</dd></div>}
                  {offer && <div className={`el-fact${pc("status")}`}><dt>Status</dt><dd>{OFFER_STATUS[offer.status] ?? offer.status}</dd></div>}
                </dl>
              </section>
            )}
            <ol className="enq-thread el-thread">
              {ai && (
                <li className="el-turn">
                  <div className="el-answer">
                    <span className="el-answer-who">{ai.persona.name} · AI assistant</span>
                    <p>{ai.welcome.text}</p>
                  </div>
                  {latestTurnId === undefined && suggestions(ai.welcome.suggestions)}
                </li>
              )}
              {timeline.map(item => {
                if (item.kind === "msg") {
                  const m = item.m;
                  const flag = safety?.flags.find(f => f.messageId === m.id);
                  const who = m.automated ? "Automated notice" : mine(m.senderUserId) ? "You" : m.senderUserId === data.enquiry.buyerUserId ? "Buyer" : "Owner";
                  return (
                    <li key={m.id}>
                      <div className={`enq-msg${m.automated ? " system" : mine(m.senderUserId) ? " mine" : ""}`}>
                        {m.body}
                        <small>{who}, {time(m.sentAt)}</small>
                      </div>
                      {flag && <MessageWarning flag={flag} />}
                    </li>
                  );
                }
                const t = item.t;
                const isLatest = t.id === latestTurnId;
                const pills = isLatest && facts ? pillsFor(t.topic, facts) : [];
                return (
                  <li key={t.id} className="el-turn">
                    <div className={`enq-msg el-question${mine(t.askedByUserId) ? " mine" : ""}${pc(`q-${t.id}`)}`}>
                      {t.question}
                      <small>{mine(t.askedByUserId) ? "You" : roleName(t.askedByRole)} asked {ai?.persona.name}, {time(t.createdAt)}</small>
                    </div>
                    <div className="el-answer">
                      <span className="el-answer-who">{ai?.persona.name} · AI assistant</span>
                      <p>{t.answer}</p>
                      {pills.length > 0 && (
                        <ul className="el-pills" aria-label="What this refers to">
                          {pills.map((p, i) => <li key={i} className={`el-pill${pc(p.target)}`}>{p.text}</li>)}
                        </ul>
                      )}
                    </div>
                    {isLatest && showMeNow && (
                      <button type="button" className="el-showme" disabled={walking} onClick={() => void walkTo(showMeNow.places)}>
                        {walking ? `${ai?.persona.name} is showing you…` : showMeNow.label}
                      </button>
                    )}
                    {isLatest && suggestions(ai?.welcome.suggestions ?? [])}
                  </li>
                );
              })}
              {asking && <li className="el-thinking" role="status">{ai?.persona.name ?? "The assistant"} is thinking…</li>}
            </ol>
            <div ref={endRef} />
            {olr?.role === "owner" && <AiReplyPanel enquiryId={id} onSent={async () => { await Promise.all([load(), reloadSafety()]); }} />}
            <form className="el-composer" onSubmit={onSend}>
              <label htmlFor="enq-reply" className="el-sr">Message</label>
              <textarea
                id="enq-reply" value={draft} rows={3} maxLength={4000} required
                placeholder={ai ? `Write a message, or ask ${ai.persona.name} a question` : "Write a message"}
                onChange={e => setDraft(e.target.value)} onFocus={() => setTyping(true)} onBlur={() => setTyping(false)}
              />
              <div className="el-composer-actions">
                {ai && (
                  <button type="button" className="el-ask" aria-pressed={listening} disabled={asking || listening} onClick={listen}>
                    {listening ? "Listening…" : `Speak to ${ai.persona.name}`}
                  </button>
                )}
                {ai && (
                  <button type="button" className="el-ask" disabled={asking || !draft.trim() || draft.trim().length > 500} onClick={() => void ask(draft, true)}>
                    {asking ? "Asking…" : `Ask ${ai.persona.name}`}
                  </button>
                )}
                <button type="submit" disabled={busy || !draft.trim()}>{busy ? "Sending…" : "Send"}</button>
              </div>
              {ai && <p className="el-note">{ai.persona.name} sees this listing and the offer terms you both see, never private notes or the owner&apos;s lowest price. Questions to her are shown to both of you.</p>}
              {error && <p role="alert">{error}</p>}
            </form>
            {olr && (
              <section id="el-offer-link" aria-label="Formal offer link" className="el-offer-link">
                <h2>Formal offer link</h2>
                {olr.role === "buyer" && olr.link && (
                  <p><a href={`/offers/new?listing=${encodeURIComponent(olr.link.listingId)}#token=${encodeURIComponent(olr.link.token)}`}>Make a formal offer</a> (single use, expires {new Date(olr.link.expiresAt).toLocaleString("en-AU")}).</p>
                )}
                {olr.role === "buyer" && olr.request?.status === "requested" && <p className="muted">Waiting for the owner to answer your request.</p>}
                {olr.role === "buyer" && olr.request?.status !== "requested" && !olr.link && (
                  <button type="button" disabled={busy} onClick={() => void olrAction("request")}>Request an offer link</button>
                )}
                {olr.role === "owner" && olr.request?.status === "requested" && (
                  <p>
                    <button type="button" disabled={busy} onClick={() => void olrAction("issue")}>Approve and issue link</button>{" "}
                    <button type="button" disabled={busy} onClick={() => void olrAction("decline")}>Decline</button>
                  </p>
                )}
                {olr.role === "owner" && olr.request?.status !== "requested" && <p className="muted">No open request. You decide every offer yourself; nothing is accepted automatically.</p>}
              </section>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
