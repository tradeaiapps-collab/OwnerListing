"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { GUIDE_LIMITS, suggestedChips, type GuideChip, type GuideIntent, type GuideLink } from "../src/domain/guide-assistant";
import "./styles/assistant.css";

interface Msg { id: number; from: "guide" | "you"; text: string; links?: GuideLink[] }

/**
 * Floating guide assistant on every public page. Rule based; answers come from POST /api/assistant.
 * PRIVACY: the conversation lives only in this component's memory. It is not saved in the browser or on the server and is gone on reload.
 */
export default function GuideAssistant({ greeting, chips, disclaimer }: { greeting: string; chips: GuideChip[]; disclaimer: string }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([{ id: 0, from: "guide", text: greeting }]);
  const [quick, setQuick] = useState<GuideChip[]>(chips);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLOListElement>(null);
  const seq = useRef(1);
  const titleId = useId(), descId = useId();

  useEffect(() => { setQuick(suggestedChips({ chips }, window.location.pathname)); }, [chips]);

  const close = useCallback(() => { setOpen(false); launcher.current?.focus(); }, []);

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
      if (Array.isArray(d.chips) && d.chips.length > 0) setQuick(d.chips);
    } else {
      setMsgs(m => [...m, { id: seq.current++, from: "guide", text: d?.error ?? "Sorry, the guide is unavailable right now. Try again shortly." }]);
    }
    setBusy(false);
  }

  return (
    <>
      <button ref={launcher} type="button" className="ga-launcher" aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" /><path d="M9 10h.01M12 10h.01M15 10h.01" />
        </svg>
        <span>{open ? "Close help" : "Need help?"}</span>
      </button>
      {open && (
        <div ref={panel} className="ga-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId}>
          <div className="ga-head">
            <div>
              <h2 id={titleId}>Site guide</h2>
              <p id={descId}>Automatic answers, not a person. Nothing you type is saved.</p>
            </div>
            <button type="button" className="ga-x" onClick={close} aria-label="Close the guide">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          </div>
          <ol ref={log} className="ga-log" aria-live="polite" aria-relevant="additions">
            {msgs.map(m => (
              <li key={m.id} className={`ga-msg ga-${m.from}`}>
                <span className="ga-who">{m.from === "guide" ? "Guide" : "You"}</span>
                <p>{m.text}</p>
                {m.links && m.links.length > 0 && (
                  <ul className="ga-links">{m.links.map(l => <li key={l.href + l.label}><a href={l.href}>{l.label} <span aria-hidden="true">→</span></a></li>)}</ul>
                )}
              </li>
            ))}
            {busy && <li className="ga-msg ga-guide ga-typing" aria-label="The guide is answering">…</li>}
          </ol>
          <div className="ga-chips" role="group" aria-label="Suggested questions">
            {quick.map(c => <button key={c.intent} type="button" onClick={() => void ask({ intent: c.intent, label: c.label })} disabled={busy}>{c.label}</button>)}
          </div>
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
