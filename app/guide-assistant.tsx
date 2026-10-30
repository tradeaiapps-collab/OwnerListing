"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { personaLabel, personaPose, type Persona } from "../src/domain/assistant-persona";
import { GUIDE_LIMITS, type GuideChip, type GuideIntent, type GuideLink } from "../src/domain/guide-assistant";
import "./styles/assistant.css";

interface Msg { id: number; from: "guide" | "you"; text: string; links?: GuideLink[] }

/**
 * Floating guide assistant on every public page. Rule based; answers come from POST /api/assistant.
 * PRIVACY: the conversation lives only in this component's memory. It is not saved in the browser or on the server and is gone on reload.
 * It shows the persona staff chose at /staff/assistant (Elena by default), always labelled as an AI assistant. Any element can open it
 * by dispatching OPEN_GUIDE_EVENT on window (the home page greeter does).
 */
export const OPEN_GUIDE_EVENT = "ol:open-guide";
/** Fired on window whenever the chat opens/closes or starts/stops answering; detail is { open, busy }. The walking Elena listens to it. */
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

  const close = useCallback(() => { setOpen(false); launcher.current?.focus(); }, []);

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

  useEffect(() => { window.dispatchEvent(new CustomEvent(GUIDE_STATE_EVENT, { detail: { open, busy } })); }, [open, busy]);

  useEffect(() => { log.current?.lastElementChild?.scrollIntoView({ block: "nearest" }); }, [msgs]);

  async function ask(q: { intent: GuideIntent; label: string } | { text: string }) {
    if (busy) return;
    const said = "label" in q ? q.label : q.text.trim();
    if (!said) return;
    setBusy(true);
    setMsgs(m => [...m, { id: seq.current++, from: "you", text: said }]);
    const body = "intent" in q ? { intent: q.intent, path: window.location.pathname } : { text: said, path: window.location.pathname };
    const r = await fetch("/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const d = r ? await r.json().catch(() => null) : null;
    if (r?.ok && d && typeof d.text === "string") {
      setMsgs(m => [...m, { id: seq.current++, from: "guide", text: d.text, links: Array.isArray(d.links) ? d.links : [] }]);
    } else {
      setMsgs(m => [...m, { id: seq.current++, from: "guide", text: d?.error ?? "Sorry, the guide is unavailable right now. Try again shortly." }]);
    }
    setBusy(false);
  }

  return (
    <>
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
            <input ref={input} id={`${titleId}-q`} value={text} maxLength={GUIDE_LIMITS.message} onChange={e => setText(e.target.value)} placeholder="Ask about listing, offers, fees…" autoComplete="off" />
            <button type="submit" disabled={busy || text.trim() === ""}>Send</button>
          </form>
          <p className="ga-disclaimer">{disclaimer} Don&apos;t type personal details such as ID or bank numbers.</p>
        </div>
      )}
    </>
  );
}
