"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { personaLabel, personaPose, type Persona } from "../src/domain/assistant-persona";
import { cleanTranscript, micErrorMessage } from "../src/domain/guide-voice";
import { GUIDE_LIMITS, type GuideChip, type GuideIntent, type GuideLink } from "../src/domain/guide-assistant";
import { PRESENTER_SPEAK_EVENT, PRESENTER_STATE_EVENT, PRESENTER_STOP_EVENT, type PresenterState } from "./presenter/presenter-core";
import { useElenaContext } from "./elena-context";
import { contextAnswer, contextFallback, isListingForm, isWhereQuestion, sectionHint, whereAnswer } from "../src/domain/elena-context";
import "./styles/assistant.css";

interface RecResult { 0?: { transcript?: string } }
interface Rec {
  lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void;
  onresult: ((e: { results: ArrayLike<RecResult> }) => void) | null; onerror: ((e: { error?: string }) => void) | null; onend: (() => void) | null;
}
type RecCtor = new () => Rec;
const recognitionCtor = (): RecCtor | undefined => {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};

interface Msg { id: number; from: "guide" | "you"; text: string; links?: GuideLink[] }

/**
 * Floating guide assistant on every public page. Rule based; answers come from POST /api/assistant.
 * PRIVACY: the conversation lives only in this component's memory. It is not saved in the browser or on the server and is gone on reload.
 * It shows the persona staff chose at /staff/assistant (Elena by default), always labelled as an AI assistant. Any element can open it
 * by dispatching OPEN_GUIDE_EVENT on window (the home page greeter does).
 */
export const OPEN_GUIDE_EVENT = "ol:open-guide";
/** Fired on window whenever the chat opens/closes or starts/stops answering; detail is { open, busy, typing }. The walking Elena listens to it. */
export const GUIDE_STATE_EVENT = "ol:guide-state";

export default function GuideAssistant({ greeting, disclaimer, persona }: {
  greeting: string; chips?: GuideChip[]; disclaimer: string; persona: Pick<Persona, "name" | "icon" | "portrait" | "poses">;
}) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([{ id: 0, from: "guide", text: greeting }]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLOListElement>(null);
  const seq = useRef(1);
  const titleId = useId(), descId = useId();
  const welcome = personaPose(persona, "wave");
  const listening = persona.poses.listening ?? persona.icon;

  // Listen: replay any of her answers aloud. Only one plays at a time; the presenter reports when she stops.
  const [playing, setPlaying] = useState<number | null>(null);
  useEffect(() => {
    const on = (e: Event) => { if (!(e as CustomEvent<PresenterState>).detail?.talking) setPlaying(null); };
    window.addEventListener(PRESENTER_STATE_EVENT, on);
    return () => window.removeEventListener(PRESENTER_STATE_EVENT, on);
  }, []);
  const listen = (m: Msg) => {
    if (playing === m.id) { window.dispatchEvent(new Event(PRESENTER_STOP_EVENT)); setPlaying(null); return; }
    setPlaying(m.id);
    window.dispatchEvent(new CustomEvent(PRESENTER_SPEAK_EVENT, { detail: { text: m.text } }));
  };

  // Talk to her: browser speech recognition fills the question box and sends it when you stop speaking. Nothing is recorded by us.
  const [canTalk, setCanTalk] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [micNote, setMicNote] = useState("");
  const rec = useRef<Rec | null>(null);
  useEffect(() => { setCanTalk(!!recognitionCtor()); return () => rec.current?.stop(); }, []);
  const toggleMic = () => {
    if (rec.current) { rec.current.stop(); return; }
    const Ctor = recognitionCtor();
    if (!Ctor || busy) return;
    window.dispatchEvent(new Event(PRESENTER_STOP_EVENT));
    const r = new Ctor();
    r.lang = navigator.language || "en-AU"; r.interimResults = true; r.continuous = false;
    let heard = "", failed = false;
    r.onresult = e => { heard = cleanTranscript(Array.from(e.results).map(x => x[0]?.transcript ?? ""), GUIDE_LIMITS.message); setText(heard); };
    r.onerror = e => { failed = true; setMicNote(micErrorMessage(e.error ?? "")); };
    r.onend = () => {
      rec.current = null; setMicOn(false);
      if (heard && !failed) { setText(""); void askRef.current({ text: heard }); }
    };
    setMicNote(""); rec.current = r; setMicOn(true);
    try { r.start(); } catch { rec.current = null; setMicOn(false); setMicNote(micErrorMessage("")); }
  };

  const close = useCallback(() => { setOpen(false); launcher.current?.focus(); }, []);

  // Context awareness: which page and section the person is in, so Elena can offer help for exactly that spot.
  const here = useElenaContext();
  const hint = isListingForm(here.path) && here.section ? sectionHint(here.section, { price: false, description: false, rooms: false }) : undefined;
  const nudged = useRef<Set<string>>(new Set());
  const [nudge, setNudge] = useState<{ key: string; section: string; text: string } | null>(null);
  useEffect(() => {
    if (open || !hint || nudged.current.has(here.section)) return;
    // One short offer per section, after a pause, so she is present without nagging.
    const t = setTimeout(() => { nudged.current.add(here.section); setNudge({ key: here.section, section: here.sectionLabel, text: hint.text }); }, 4000);
    return () => clearTimeout(t);
  }, [open, hint, here.section, here.sectionLabel]);
  useEffect(() => {
    if (!nudge) return;
    const t = setTimeout(() => setNudge(null), 14000);
    return () => clearTimeout(t);
  }, [nudge]);
  const openWithNudge = () => {
    if (nudge) setMsgs(m => [...m, { id: seq.current++, from: "guide", text: `You are in ${nudge.section} on ${here.pageLabel}. ${nudge.text}` }]);
    setNudge(null); setOpen(true);
  };

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_GUIDE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_GUIDE_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key !== "Tab" || !panel.current) return;
      const f = [...panel.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])")];
      if (f.length === 0) return;
      const first = f[0]!, last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("ga-open");
    return () => { document.removeEventListener("keydown", onKey); document.body.classList.remove("ga-open"); };
  }, [open, close]);

  useEffect(() => { window.dispatchEvent(new CustomEvent(GUIDE_STATE_EVENT, { detail: { open, busy, typing: text.trim() !== "" } })); }, [open, busy, text]);

  useEffect(() => { log.current?.lastElementChild?.scrollIntoView({ block: "nearest" }); }, [msgs]);

  async function ask(q: { intent: GuideIntent; label: string } | { text: string }) {
    if (busy) return;
    const said = "label" in q ? q.label : q.text.trim();
    if (!said) return;
    setBusy(true);
    setMsgs(m => [...m, { id: seq.current++, from: "you", text: said }]);
    if (!("intent" in q) && isWhereQuestion(said)) { setMsgs(m => [...m, { id: seq.current++, from: "guide", text: whereAnswer(here) }]); setBusy(false); return; }
    if (!("intent" in q)) {
      const local = contextAnswer(said, here);
      if (local) { window.dispatchEvent(new CustomEvent(PRESENTER_SPEAK_EVENT, { detail: { text: local } })); setMsgs(m => [...m, { id: seq.current++, from: "guide", text: local }]); setBusy(false); return; }
    }
    if (!("intent" in q)) {
      // Typed questions go to Elena's knowledge brain first (signed-in people only; a 401 or "I don't know" falls back to the fixed guide below).
      const br = await fetch("/api/elena/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: said.slice(0, 500), context: { page: window.location.pathname } }) }).catch(() => null);
      const bd = br?.ok ? await br.json().catch(() => null) : null;
      if (bd && typeof bd.text === "string" && bd.text.trim() && bd.intent !== "unknown") {
        window.dispatchEvent(new CustomEvent(PRESENTER_SPEAK_EVENT, { detail: { text: bd.text } }));
        setMsgs(m => [...m, { id: seq.current++, from: "guide", text: bd.text }]);
        setBusy(false);
        return;
      }
    }
    const body = "intent" in q ? { intent: q.intent, path: window.location.pathname } : { text: said, path: window.location.pathname };
    const r = await fetch("/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const d = r ? await r.json().catch(() => null) : null;
    if (r?.ok && d && typeof d.text === "string") {
      const reply = d.intent === "unknown" && !("intent" in q) ? contextFallback(here) : d.text;
      window.dispatchEvent(new CustomEvent(PRESENTER_SPEAK_EVENT, { detail: { text: reply } }));
      setMsgs(m => [...m, { id: seq.current++, from: "guide", text: reply, links: Array.isArray(d.links) ? d.links : [] }]);
    } else {
      setMsgs(m => [...m, { id: seq.current++, from: "guide", text: d?.error ?? "Sorry, the guide is unavailable right now. Try again shortly." }]);
    }
    setBusy(false);
  }

  const askRef = useRef(ask);
  askRef.current = ask;

  return (
    <>
      {nudge && !open && (
        <div className="ga-nudge" role="status">
          <p><strong>{nudge.section}</strong> {nudge.text}</p>
          <div className="ga-nudge-actions">
            <button type="button" onClick={openWithNudge}>Help me here</button>
            <button type="button" className="secondary" onClick={() => setNudge(null)} aria-label="Dismiss">Not now</button>
          </div>
        </div>
      )}
      <button ref={launcher} type="button" className="ga-launcher" aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        <img className="ga-avatar" src={persona.icon} alt="" width={40} height={40} />
        <span>{open ? "Close help" : `Ask ${persona.name}`}</span>
      </button>
      {open && (
        <div ref={panel} className="ga-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId}>
          <div className="ga-head">
            <div className="ga-head-who">
              <img className="ga-avatar" src={persona.icon} alt="" width={44} height={44} />
              <div>
                <h2 id={titleId}>{personaLabel(persona)}</h2>
                <p id={descId}>Automatic answers, not a person or a licensed agent. Nothing you type is saved.</p>
                {here.pageLabel && <p className="ga-ctx">I can see you are on <strong>{here.pageLabel}</strong>{here.sectionLabel ? <>, in <strong>{here.sectionLabel}</strong></> : null}.</p>}
              </div>
            </div>
            <button type="button" className="ga-x" onClick={close} aria-label={`Close the chat with ${persona.name}`}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          </div>
          <ol ref={log} className="ga-log" aria-live="polite" aria-relevant="additions">
            <li className="ga-welcome" aria-hidden="true">
              <span className={`ga-pose${welcome.full ? " is-full" : ""}`}><img src={welcome.src} alt="" width={408} height={414} decoding="async" /></span>
              <span className="ga-welcome-name">{personaLabel(persona)}</span>
            </li>
            {msgs.map(m => (
              <li key={m.id} className={`ga-msg ga-${m.from}`}>
                {m.from === "guide" && <img className="ga-mini" src={persona.icon} alt="" width={28} height={28} />}
                <span className="ga-who">{m.from === "guide" ? persona.name : "You"}</span>
                <p>{m.text}</p>
                {m.from === "guide" && (
                  <button type="button" className="ga-listen" aria-pressed={playing === m.id} onClick={() => listen(m)}>
                    <span aria-hidden="true">{playing === m.id ? "■" : "🔊"}</span> {playing === m.id ? "Stop" : "Listen"}<span className="ga-sr"> to {persona.name}&apos;s answer</span>
                  </button>
                )}
                {m.links && m.links.length > 0 && (
                  <ul className="ga-links">{m.links.map(l => <li key={l.href + l.label}><a href={l.href}>{l.label} <span aria-hidden="true">→</span></a></li>)}</ul>
                )}
              </li>
            ))}
            {busy && (
              <li className="ga-msg ga-guide ga-typing" aria-label={`${persona.name} is answering`}>
                <img className="ga-mini" src={listening} alt="" width={28} height={28} />
                <span className="ga-dots" aria-hidden="true"><span /><span /><span /></span>
              </li>
            )}
          </ol>
          <form className="ga-form" onSubmit={e => { e.preventDefault(); const t = text; setText(""); void ask({ text: t }); }}>
            <label className="ga-sr" htmlFor={`${titleId}-q`}>Ask a question</label>
            <input ref={input} id={`${titleId}-q`} value={text} maxLength={GUIDE_LIMITS.message} onChange={e => setText(e.target.value)} placeholder={here.pageLabel ? `Ask me anything about ${here.pageLabel}…` : "Ask about listing, offers, fees…"} autoComplete="off" />
            {canTalk && (
              <button type="button" className="ga-mic" aria-pressed={micOn} disabled={busy && !micOn} onClick={toggleMic} aria-label={micOn ? "Stop listening" : `Talk to ${persona.name}`}>
                <span aria-hidden="true">{micOn ? "■" : "🎤"}</span>
              </button>
            )}
            <button type="submit" disabled={busy || text.trim() === ""}>Send</button>
          </form>
          {(micOn || micNote) && <p className="ga-mic-note" role="status">{micOn ? "Listening… speak now." : micNote}</p>}
          <p className="ga-disclaimer">{disclaimer} Don&apos;t type personal details such as ID or bank numbers.</p>
        </div>
      )}
    </>
  );
}
