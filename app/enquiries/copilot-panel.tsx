"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Analysis, DraftResult, Insight } from "../../src/domain/chat-copilot";
import { JSON_HEADERS } from "../listings/ui";

type Persona = { name: string; portrait: string } | null;
const TONE_LABEL: Record<Insight["tone"], string> = { risk: "Watch out", watch: "Heads up", good: "Good sign", tip: "Tip" };

/**
 * Elena's side of the conversation. She listens (typed or spoken in the browser, no outside service), drafts three versions, reads
 * the whole thread after every new message, and gives verdicts with ready drafts. She never sends on her own: every draft is
 * added to the message box for editing, or sent only after a second, explicit confirm. Her coaching is private to this person.
 */
export function CopilotPanel({ enquiryId, persona, refreshKey, onUse, onSend, busy }: {
  /** Absent on the contact page, where no conversation exists yet: she can only draft, not read a thread. */
  enquiryId?: string | undefined; persona: Persona; refreshKey: number; onUse: (text: string) => void; onSend: (text: string) => Promise<void>; busy: boolean;
}) {
  const name = persona?.name ?? "Elena";
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [words, setWords] = useState("");
  const [drafts, setDrafts] = useState<DraftResult | null>(null);
  const [working, setWorking] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState("");
  const recRef = useRef<{ stop: () => void } | null>(null);

  const loadAnalysis = useCallback(async () => {
    if (!enquiryId) return;
    try {
      const r = await fetch(`/api/enquiries/${enquiryId}/copilot`);
      if (r.ok) setAnalysis(((await r.json()) as { analysis: Analysis }).analysis);
    } catch { /* the chat works without her notes */ }
  }, [enquiryId]);
  useEffect(() => { void loadAnalysis(); }, [loadAnalysis, refreshKey]);
  useEffect(() => () => recRef.current?.stop(), []);

  async function draft() {
    setWorking(true); setError(""); setConfirm("");
    try {
      const r = await fetch(enquiryId ? `/api/enquiries/${enquiryId}/copilot` : "/api/copilot/draft", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ words }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError((d as { error?: string }).error ?? `${name} could not draft that.`); return; }
      setDrafts(d as DraftResult);
    } catch { setError(`${name} could not draft that.`); } finally { setWorking(false); }
  }

  function listen() {
    type Rec = { lang: string; interimResults: boolean; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null; start: () => void; stop: () => void };
    const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) { setError("Speaking isn't supported in this browser. You can type instead."); return; }
    const rec = new Ctor();
    rec.lang = navigator.language || "en-AU";
    rec.interimResults = true;
    setError(""); setListening(true);
    rec.onresult = e => setWords(Array.from(e.results as ArrayLike<ArrayLike<{ transcript: string }>>).map(r => r[0]?.transcript ?? "").join(" ").slice(0, 1500));
    rec.onend = () => { setListening(false); recRef.current = null; };
    rec.onerror = () => { setListening(false); setError("I couldn't hear that. Check the microphone is allowed, or type instead."); };
    recRef.current = rec;
    rec.start();
  }

  /** Two steps for sending, because messages are a permanent record: the first press arms it, the second sends. */
  const sendButton = (text: string) => (
    confirm === text
      ? <button type="button" className="cx-btn is-confirm" disabled={busy} onClick={() => { setConfirm(""); void onSend(text); }}>Confirm: send as written</button>
      : <button type="button" className="cx-btn secondary" disabled={busy} onClick={() => setConfirm(text)}>Send</button>
  );

  return (
    <aside className="cx-elena" aria-label={`${name}, AI assistant`}>
      <header className="cx-elena-head">
        {persona && <img src={persona.portrait} alt="" width={44} height={44} />}
        <div>
          <h2>{name} <span className="cx-tag">AI assistant</span></h2>
          <p className="muted">{enquiryId ? (analysis?.summary ?? "Reading the conversation…") : "Tell me what you want to say and I'll draft it."}</p>
        </div>
      </header>

      <section className="cx-block" aria-label={`Tell ${name} what you want to say`}>
        <label htmlFor="cx-words">Tell {name} what you want to say</label>
        <textarea id="cx-words" value={words} rows={3} maxLength={1500} placeholder="e.g. tell them I can do 850k with a 60 day settlement" onChange={e => setWords(e.target.value)} />
        <div className="cx-row">
          <button type="button" className={`cx-btn secondary${listening ? " is-live" : ""}`} aria-pressed={listening} onClick={() => (listening ? recRef.current?.stop() : listen())}>{listening ? "Listening… tap to stop" : "Speak"}</button>
          <button type="button" className="cx-btn" disabled={working || !words.trim()} onClick={() => void draft()}>{working ? "Drafting…" : "Draft it"}</button>
        </div>
        {error && <p role="alert" className="cx-error">{error}</p>}
        {drafts && !drafts.ok && <p role="alert" className="cx-error">{drafts.reason}</p>}
        {drafts?.ok && (
          <div className="cx-drafts">
            <p className="muted">I heard: &ldquo;{drafts.heard}&rdquo;</p>
            {drafts.variants.map(v => (
              <article key={v.tone} className="cx-card">
                <h3>{v.label}</h3>
                <p className="cx-pre">{v.text}</p>
                <div className="cx-row">
                  <button type="button" className="cx-btn" onClick={() => onUse(v.text)}>Add to message box</button>
                  {sendButton(v.text)}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {enquiryId && <section className="cx-block" aria-label="Analysis">
        <h3>{name}&apos;s read of this conversation</h3>
        {analysis && analysis.insights.length === 0 && <p className="muted">Nothing to flag yet. I&apos;ll read each new message as it arrives.</p>}
        {analysis?.insights.map(i => (
          <article key={i.id} className={`cx-insight tone-${i.tone}`}>
            <span className="cx-insight-tone">{TONE_LABEL[i.tone]}</span>
            <h4>{i.headline}</h4>
            <p>{i.detail}</p>
            {i.action && <button type="button" className="cx-btn secondary" onClick={() => onUse(i.action!.text)}>{i.action.label}</button>}
          </article>
        ))}
        {analysis && <p className="cx-fine">{analysis.disclaimer} Only you see this panel.</p>}
      </section>}
      {analysis && analysis.replies.length > 0 && (
        <section className="cx-block" aria-label="Suggested replies">
          <h3>Suggested replies</h3>
          {analysis.replies.map(r => (
            <article key={r.label} className="cx-card">
              <h4>{r.label}</h4>
              <p className="cx-pre">{r.text}</p>
              <div className="cx-row">
                <button type="button" className="cx-btn" onClick={() => onUse(r.text)}>Add to message box</button>
                {sendButton(r.text)}
              </div>
            </article>
          ))}
        </section>
      )}

    </aside>
  );
}
