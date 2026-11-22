"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ADVISOR_NOTE, ADVISOR_START, advance, openingMessage, widenBudget, type AdvisorState } from "../../src/domain/buyer-advisor";
import { useSearchPersona } from "./persona-context";
import { pickVoice, speechChunks } from "../../src/domain/advisor-speech";
import { SaveSearch } from "./save-search";

type Msg = { from: "elena" | "you"; text: string };
type Rec = { lang: string; interimResults: boolean; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }> }) => void) | null; onend: (() => void) | null; onerror: ((e?: { error?: string }) => void) | null; start: () => void; stop: () => void };
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
  const voiceRef = useRef<SpeechSynthesisVoice | undefined>(undefined);
  const silent = useRef(0);

  useEffect(() => {
    setCanTalk(Boolean(recognition()) && "speechSynthesis" in window);
    // Voices load late in most browsers; pick the most natural English one (Australian first) when they arrive.
    const pickNow = () => { voiceRef.current = pickVoice(window.speechSynthesis?.getVoices() ?? [], navigator.language || "en-AU"); };
    pickNow();
    window.speechSynthesis?.addEventListener?.("voiceschanged", pickNow);
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
    return () => { motion.removeEventListener("change", sync); scheme.removeEventListener("change", sync); mo.disconnect(); window.speechSynthesis?.removeEventListener?.("voiceschanged", pickNow); rec.current?.stop(); window.speechSynthesis?.cancel(); };
  }, []);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [msgs]);

  const listen = useCallback(() => {
    const Ctor = recognition();
    if (!Ctor) { setNote("Speaking isn't supported in this browser. You can type instead."); return; }
    rec.current?.stop();
    window.speechSynthesis?.cancel(); setSpeaking(false); // talking over her stops her, like a call
    const r = new Ctor();
    r.lang = navigator.language || "en-AU";
    r.interimResults = true;
    let heard = "";
    setNote(""); setListening(true);
    r.onresult = e => { heard = Array.from(e.results).map(x => x[0]?.transcript ?? "").join(" ").slice(0, 300); setText(heard); };
    r.onend = () => {
      setListening(false); rec.current = null;
      if (heard.trim()) { silent.current = 0; setText(""); sendRef.current(heard); return; }
      // In a voice call, one quiet moment is fine: she gently asks again once, then waits for a tap.
      if (live.current.voice && silent.current++ < 1) speak("Take your time. I'm listening.");
    };
    r.onerror = (e?: { error?: string }) => {
      setListening(false);
      if (e?.error === "no-speech" || e?.error === "aborted") return;
      setNote(e?.error === "not-allowed" || e?.error === "service-not-allowed" ? "The microphone is blocked. Allow it in your browser settings, or type instead." : "I couldn't hear that. Check the microphone, or type instead.");
    };
    rec.current = r;
    r.start();
  }, []);

  /** Speak sentence by sentence with a short breath between them and a rising tone on questions. `thenListen` turns the mic on after, like a call. */
  function speak(line: string, thenListen = true) {
    if (!live.current.voice || !("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    synth.cancel();
    const chunks = speechChunks(line);
    if (chunks.length === 0) return;
    setSpeaking(true);
    const finish = () => { setSpeaking(false); if (thenListen && live.current.voice && live.current.state.step !== "done") listen(); };
    const next = (i: number) => {
      const c = chunks[i];
      if (!c) { finish(); return; }
      const u = new SpeechSynthesisUtterance(c.text);
      u.lang = voiceRef.current?.lang ?? "en-AU";
      if (voiceRef.current) u.voice = voiceRef.current;
      u.rate = 1.0; u.pitch = c.question ? 1.15 : i === 0 ? 1.05 : 1.0; u.volume = 1;
      u.onend = () => { if (!live.current.voice) { setSpeaking(false); return; } window.setTimeout(() => next(i + 1), c.pause); };
      u.onerror = () => setSpeaking(false);
      synth.speak(u);
    };
    next(0);
  }

  function send(raw: string) {
    const said = raw.trim();
    if (!said) return;
    const turn = advance(live.current.state, said, persona.name);
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
            {speaking && <button type="button" className="secondary" onClick={() => { window.speechSynthesis?.cancel(); setSpeaking(false); }}>Stop talking</button>}
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
          <input aria-label={`Answer ${persona.name}`} placeholder="Type or say anything" maxLength={300} value={listening ? "" : text} onChange={e => setText(e.target.value)} autoComplete="off" />
          {canTalk && <button type="button" className={`secondary adv-mic${listening ? " is-on" : ""}`} aria-pressed={listening} aria-label={listening ? "Stop listening" : "Speak your answer"} onClick={() => (listening ? rec.current?.stop() : listen())}>{listening ? "Stop" : "Speak"}</button>}
          <button type="submit" disabled={!text.trim()}>Send</button>
        </form>
        {note && <p role="alert" className="adv-note">{note}</p>}
        <small className="muted">{ADVISOR_NOTE}</small>
      </div>
    </section>
  );
}
