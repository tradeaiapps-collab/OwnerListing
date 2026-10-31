"use client";
import { useEffect, useState } from "react";
import { PRESENTER_CONTROL_EVENT, PRESENTER_STATE_EVENT, type PresenterState } from "./presenter-core";
import "../styles/presenter.css";

const IDLE: PresenterState = { talking: null, paused: false, muted: false, blocked: false };

/** Pause and mute, shown only while the presenter is speaking. Kept outside her button (buttons cannot nest). */
export default function PresenterControls() {
  const [s, setS] = useState<PresenterState>(IDLE);
  useEffect(() => {
    const on = (e: Event) => setS((e as CustomEvent<PresenterState>).detail);
    window.addEventListener(PRESENTER_STATE_EVENT, on);
    return () => window.removeEventListener(PRESENTER_STATE_EVENT, on);
  }, []);
  if (!s.talking) return null;
  const send = (action: "pause" | "mute") => window.dispatchEvent(new CustomEvent(PRESENTER_CONTROL_EVENT, { detail: { action } }));
  const off = s.muted || s.blocked;
  return (
    <span className="pr-controls" role="group" aria-label="Presenter controls">
      <button type="button" className="pr-btn" onClick={() => send("pause")} aria-label={s.paused ? "Resume" : "Pause"}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">{s.paused ? <path d="M8 5v14l11-7z" /> : <path d="M6 5h4v14H6zM14 5h4v14h-4z" />}</svg>
      </button>
      <button type="button" className="pr-btn" onClick={() => send("mute")} aria-pressed={s.muted} aria-label={s.muted ? "Unmute" : s.blocked ? "Turn sound on" : "Mute"}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M4 9v6h4l5 4V5L8 9z" />{off ? <path d="M16 9l5 6m0-6l-5 6" stroke="currentColor" strokeWidth="2" fill="none" /> : <path d="M16 8a5 5 0 010 8" stroke="currentColor" strokeWidth="2" fill="none" />}</svg>
      </button>
    </span>
  );
}
