"use client";
import { useEffect, useRef, useState } from "react";
import { personaLabel, personaPose, type PoseId } from "../../src/domain/assistant-persona";
import type { ChatPersona } from "../../src/domain/chat-assistant";

type ClipId = "idle" | "listen" | "talking" | "explain" | "agree" | "presenting";

/** What the stage shows: a pose from an answer, "listening" while someone types or waits, "thinking" while she answers. */
export type StageState = { pose: PoseId; status: "welcome" | "listening" | "thinking" | "presenting" | "explaining" | "careful"; pointing: boolean;
  /** How she moves while answering aloud: "agree" nods and smiles, otherwise she explains. Unset = explain. */
  mood?: "agree" | "explain" };

const STATUS_TEXT: Record<StageState["status"], (name: string) => string> = {
  welcome: n => `${n} is here to help`,
  listening: n => `${n} is listening`,
  thinking: n => `${n} is thinking`,
  presenting: n => `${n} is showing you`,
  explaining: n => `${n} is explaining`,
  careful: n => `${n} is keeping things private`
};

const VOICE_KEY = "ol:assistant-voice";
// Voice is on unless the person has switched it off, so she answers aloud without anyone hunting for a toggle.
const readVoice = () => { try { return window.localStorage.getItem(VOICE_KEY) !== "off"; } catch { return true; } };
const saveVoice = (on: boolean) => { try { window.localStorage.setItem(VOICE_KEY, on ? "on" : "off"); } catch { /* the toggle still works for this visit */ } };

/** Reads text aloud with the device's own voice (no outside service). Returns false when the browser has no speech. */
export function speak(text: string, onEnd: () => void): boolean {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return false;
  const s = window.speechSynthesis;
  s.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-AU";
  const v = s.getVoices().find(x => /en-AU/i.test(x.lang) && /female|karen|catherine|natasha/i.test(x.name)) ?? s.getVoices().find(x => /en-AU/i.test(x.lang));
  if (v) u.voice = v;
  u.rate = 1;
  // Some browsers never fire onend for long text, which would leave her "speaking" forever; stop her after a generous cap.
  const cap = setTimeout(onEnd, Math.min(60000, 4000 + text.length * 90));
  const done = () => { clearTimeout(cap); onEnd(); };
  u.onend = done;
  u.onerror = done;
  s.resume();
  s.speak(u);
  return true;
}

/**
 * Body language by moment. Speaking: presenting while she shows something, a careful still-faced talk for privacy, nodding and smiling
 * for agreement, otherwise expressive explaining. Silent: leaning in to listen while someone types or she thinks, else standing at
 * ease with her hands down (never frozen mid-gesture).
 */
export function clipFor(state: Pick<StageState, "pose" | "status" | "mood">, speaking: boolean): ClipId {
  if (speaking) {
    if (state.pose === "tablet") return "presenting";
    if (state.status === "careful") return "talking";
    return state.mood === "agree" ? "agree" : "explain";
  }
  return state.status === "listening" || state.status === "thinking" ? "listen" : "idle";
}

/**
 * The assistant "on stage" beside the chat (above it on phones). Her pose follows the conversation; she breathes gently between
 * poses, sways while speaking, and when she refers to something in the chat a pointer on her side lights up with it.
 * Motion is off under prefers-reduced-motion (CSS). Always labelled as an AI assistant.
 */
export function ElenaStage({ persona, state, speaking, voice, onVoice }: {
  persona: ChatPersona; state: StageState; speaking: boolean; voice: boolean; onVoice: (on: boolean) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const pose = personaPose(persona, state.pose);
  const flip = state.pose === "tablet";
  const status = speaking ? `${persona.name} is speaking` : STATUS_TEXT[state.status](persona.name);
  const live = useRef<HTMLParagraphElement>(null);
  const [still, setStill] = useState(true);

  useEffect(() => { onVoice(readVoice()); }, [onVoice]);
  // Keep the pinned stage below the site header, whatever height it wraps to at this width.
  useEffect(() => {
    const header = document.querySelector<HTMLElement>(".site-header");
    if (!header) return;
    const sync = () => document.documentElement.style.setProperty("--el-top", `${Math.round(header.getBoundingClientRect().height)}px`);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(header);
    return () => { ro.disconnect(); document.documentElement.style.removeProperty("--el-top"); };
  }, []);
  // Short looping clips exist for Elena only; she is always moving (idle by default). They stay still for people who ask for reduced motion.
  useEffect(() => {
    const q = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setStill(q.matches);
    sync();
    q.addEventListener("change", sync);
    return () => q.removeEventListener("change", sync);
  }, []);
  const clip = persona.id !== "elena" || still ? undefined : clipFor(state, speaking);

  return (
    <aside className={`el-stage${collapsed ? " is-collapsed" : ""}${speaking ? " is-speaking" : ""}${state.pointing ? " is-pointing" : ""}`} aria-label={personaLabel(persona)}>
      <div className="el-stage-figure">
        {clip ? (
          <video
            key={clip} className={`el-stage-img is-video${clip === "presenting" ? " is-flip" : ""}`} autoPlay loop muted playsInline preload="auto"
            poster={`/assistant/elena-video-${clip}.jpg`} aria-hidden="true"
          >
            <source src={`/assistant/elena-video-${clip}.webm`} type="video/webm" />
            <source src={`/assistant/elena-video-${clip}.mp4`} type="video/mp4" />
          </video>
        ) : (
        <img
          key={pose.src}
          src={pose.src}
          alt=""
          className={`el-stage-img${pose.full ? " is-full" : " is-portrait"}${flip ? " is-flip" : ""}`}
          width={408}
          height={414}
        />
        )}
        <span className="el-pointer" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
        </span>
      </div>
      <div className="el-stage-card">
        <div className="el-stage-who">
          <span className="el-stage-name">{persona.name}</span>
          <span className="el-stage-tag">AI assistant · not a licensed agent</span>
        </div>
        <p className="el-stage-status" ref={live} role="status">
          <span className={`el-dot el-dot-${speaking ? "speaking" : state.status}`} aria-hidden="true" />
          {status}
        </p>
        <div className="el-stage-actions">
          <button
            type="button" className="el-stage-btn" aria-pressed={voice}
            onClick={() => { const on = !voice; saveVoice(on); onVoice(on); if (!on && typeof window !== "undefined") window.speechSynthesis?.cancel(); }}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M11 5 6 9H3v6h3l5 4V5z" />
              {voice ? <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /> : <path d="m22 9-6 6M16 9l6 6" />}
            </svg>
            {voice ? "Voice on" : "Voice off"}
          </button>
          <button type="button" className="el-stage-btn el-stage-collapse" aria-expanded={!collapsed} onClick={() => setCollapsed(c => !c)}>
            {collapsed ? `Show ${persona.name}` : "Make smaller"}
          </button>
        </div>
      </div>
    </aside>
  );
}
