"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ADVISOR_NOTE, ADVISOR_START, advance, openingMessage, widenBudget, type AdvisorState } from "../../src/domain/buyer-advisor";
import { useSearchPersona } from "./persona-context";
import { SaveSearch } from "./save-search";

type Msg = { from: "elena" | "you"; text: string };
type Rec = { lang: string; interimResults: boolean; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null; start: () => void; stop: () => void };
type RecCtor = new () => Rec;
const recognition = (): RecCtor | undefined => {
  const w = window as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};

/**
 * Elena as a buyer advisor on the search page. She opens the conversation like an agent on a call (buy or rent, budget, type, bedrooms,
 * where, must-haves), fills the search form as the buyer answers, and can speak and listen. Everything runs in the browser from
 * src/domain/buyer-advisor.ts, so nothing the buyer says is sent anywhere or stored.
 */
export function BuyerAdvisor({ query, total, startOpen, onApply }: {
  /** Applied filters as URL parameters (for saving the search). */
  query: string; total: number | null; startOpen: boolean;
  /** Filters in API parameter names; the page merges them into the form and runs the search. */
  onApply: (params: Record<string, string>) => void;
}) {
  const persona = useSearchPersona();
  const [open, setOpen] = useState(startOpen);
  const [msgs, setMsgs] = useState<Msg[]>(() => [{ from: "elena", text: openingMessage(persona.name) }]);
  const [state, setState] = useState<AdvisorState>(ADVISOR_START);
  const [text, setText] = useState("");
  const [voice, setVoice] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [note, setNote] = useState("");
  const [dark, setDark] = useState(false);
  const [calm, setCalm] = useState(false);
  const [canTalk, setCanTalk] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const rec = useRef<Rec | null>(null);
  const live = useRef({ voice, state });
  live.current = { voice, state };
  const sendRef = useRef<(t: string) => void>(() => undefined);

  useEffect(() => {
    setCanTalk(Boolean(recognition()) && "speechSynthesis" in window);
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)"), scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      setCalm(motion.matches);
      const m = document.documentElement.getAttribute("data-theme-mode");
      setDark(m === "dark" || (m !== "light" && scheme.matches));
    };
    sync();
    motion.addEventListener("change", sync); scheme.addEventListener("change", sync);
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme-mode"] });
    return () => { motion.removeEventListener("change", sync); scheme.removeEventListener("change", sync); mo.disconnect(); rec.current?.stop(); window.speechSynthesis?.cancel(); };
  }, []);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [msgs]);

  const listen = useCallback(() => {
    const Ctor = recognition();
    if (!Ctor) { setNote("Speaking isn't supported in this browser. You can type instead."); return; }
    rec.current?.stop();
    const r = new Ctor();
    r.lang = navigator.language || "en-AU";
    r.interimResults = true;
    let heard = "";
    setNote(""); setListening(true);
    r.onresult = e => { heard = Array.from(e.results).map(x => x[0]?.transcript ?? "").join(" ").slice(0, 300); setText(heard); };
    r.onend = () => { setListening(false); rec.current = null; if (heard.trim()) { setText(""); sendRef.current(heard); } };
    r.onerror = () => { setListening(false); setNote("I couldn't hear that. Check the microphone is allowed, or type instead."); };
    rec.current = r;
    r.start();
  }, []);

  function speak(line: string) {
    if (!live.current.voice || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(line);
    u.lang = "en-AU";
    u.onstart = () => setSpeaking(true);
    // Like a call: when she finishes a question, she listens for the answer.
    u.onend = () => { setSpeaking(false); if (live.current.voice && live.current.state.step !== "done") listen(); };
    u.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(u);
  }

  function send(raw: string) {
    const said = raw.trim();
    if (!said) return;
    const turn = advance(live.current.state, said);
    setMsgs(m => [...m, { from: "you", text: said }, { from: "elena", text: turn.reply }]);
    setState(turn.state);
    live.current.state = turn.state;
    if (Object.keys(turn.state.params).length > 0) onApply(turn.state.params);
    speak(turn.reply);
  }

  sendRef.current = send;

  function toggleVoice() {
    if (voice) { setVoice(false); live.current.voice = false; window.speechSynthesis?.cancel(); rec.current?.stop(); setSpeaking(false); return; }
    setVoice(true); live.current.voice = true;
    // Starting voice is the tap the browser needs before she is allowed to speak: she reads out the current question.
    const last = [...msgs].reverse().find(m => m.from === "elena");
    if (last) speak(last.text);
  }

  const widened = widenBudget(state.params);
  const figure = (
    <div className={`adv-figure${speaking ? " is-speaking" : ""}${listening ? " is-listening" : ""}`} aria-hidden="true">
      <video key={dark ? "d" : "l"} className="adv-video" autoPlay={!calm} loop muted playsInline disablePictureInPicture disableRemotePlayback controls={false} tabIndex={-1} preload="auto" poster="">
        <source src="/assistant/elena-video-idle-tall-alpha.webm" type="video/webm; codecs=vp9" />
        <source src={dark ? "/assistant/elena-video-idle-tall-dark.mp4" : "/assistant/elena-video-idle-tall.mp4"} type="video/mp4" />
      </video>
    </div>
  );

  if (!open) {
    return (
      <section className="adv adv-closed" aria-label={`${persona.name}, buyer advisor`}>
        <img src={persona.icon} alt="" width={44} height={44} className="es-avatar" />
        <p>Not sure where to start? {persona.name} can ask you a few questions and set up the search.</p>
        <button type="button" onClick={() => setOpen(true)}>Chat with {persona.name}</button>
      </section>
    );
  }

  return (
    <section className="adv" aria-label={`${persona.name}, buyer advisor`}>
      {figure}
      <div className="adv-chat">
        <header className="adv-head">
          <h2>{persona.name} <span className="adv-tag">AI assistant</span></h2>
          <div className="adv-tools">
            {canTalk && <button type="button" className="secondary" aria-pressed={voice} onClick={toggleVoice}>{voice ? "Voice on" : "Talk to " + persona.name}</button>}
            <button type="button" className="secondary" onClick={() => { setOpen(false); window.speechSynthesis?.cancel(); rec.current?.stop(); }}>Hide</button>
          </div>
        </header>
        <div className="adv-log" ref={log} role="log" aria-live="polite" aria-label={`Conversation with ${persona.name}`}>
          {msgs.map((m, i) => <p key={i} className={`adv-msg ${m.from === "elena" ? "adv-her" : "adv-you"}`}>{m.text}</p>)}
          {listening && <p className="adv-msg adv-you adv-live">Listening...{text ? ` ${text}` : ""}</p>}
        </div>
        {state.step === "done" && (
          <div className="adv-done" role="status">
            <p>{total === null ? "Looking for matches..." : total === 0 ? "Nothing matches yet." : `I found ${total} ${total === 1 ? "listing" : "listings"} that fit.`}</p>
            <div className="adv-actions">
              {total === 0 && widened && <button type="button" className="secondary" onClick={() => { const p = widened; const turn = { ...state, params: p }; setState(turn); live.current.state = turn; setMsgs(m => [...m, { from: "elena", text: "I've raised the top of your budget by about 15%." }]); onApply(p); }}>Raise budget 15%</button>}
              {total !== null && total > 0 && <a className="button secondary" href="#listing-results">Show the results</a>}
              <SaveSearch query={query} />
            </div>
          </div>
        )}
        <form className="adv-form" onSubmit={e => { e.preventDefault(); const t = text; setText(""); send(t); }}>
          <input aria-label={`Answer ${persona.name}`} placeholder="Type your answer" maxLength={300} value={listening ? "" : text} onChange={e => setText(e.target.value)} autoComplete="off" />
          {canTalk && <button type="button" className={`secondary adv-mic${listening ? " is-on" : ""}`} aria-pressed={listening} aria-label={listening ? "Stop listening" : "Speak your answer"} onClick={() => (listening ? rec.current?.stop() : listen())}>{listening ? "Stop" : "Speak"}</button>}
          <button type="submit" disabled={!text.trim()}>Send</button>
        </form>
        {note && <p role="alert" className="adv-note">{note}</p>}
        <small className="muted">{ADVISOR_NOTE}</small>
      </div>
    </section>
  );
}
