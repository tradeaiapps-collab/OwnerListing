"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { PRESENTER_CONTROL_EVENT, PRESENTER_SPEAK_EVENT, PRESENTER_STATE_EVENT, PRESENTER_STOP_EVENT, type PresenterState, clipSources, pickVoice, planSpeech, type ScriptId, type SpeakRequest } from "./presenter-core";
import "../styles/presenter.css";

const MUTE_KEY = "ol:presenter-muted";
const readMuted = () => { try { return window.localStorage.getItem(MUTE_KEY) === "1"; } catch { return false; } };
const saveMuted = (m: boolean) => { try { window.localStorage.setItem(MUTE_KEY, m ? "1" : "0"); } catch { /* storage unavailable: the choice lasts for this page only */ } };

const VIDEO_PROPS = { playsInline: true, disablePictureInPicture: true, disableRemotePlayback: true, controls: false, tabIndex: -1, "aria-hidden": true } as const;

/**
 * The presenter's picture: a looping walk-toward-the-viewer clip (transparent WebM, so no frame or backdrop) that never stops.
 * A scripted line swaps in a clip of her walking and speaking with real audio and lip-sync; the two clips start and end on the same pose so the swap is seamless.
 * Other text is read by the browser voice while she keeps walking. Pause and mute live in PresenterControls (a sibling of the walker's button), which talk to this component through window events.
 */
export default function PresenterStage({ dark, brand }: { dark: boolean; brand: string }) {
  const walk = useRef<HTMLVideoElement>(null);
  const talk = useRef<HTMLVideoElement>(null);
  const [script, setScript] = useState<ScriptId | null>(null);
  const [live, setLive] = useState(false); // the scripted clip's first frame is up, so the walk loop can step aside
  const [talking, setTalking] = useState<"clip" | "tts" | null>(null);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const [blocked, setBlocked] = useState(false); // the browser refused sound until the viewer taps
  const mutedRef = useRef(false);
  const generation = useRef(0); // ignores events from a clip or utterance that has been replaced

  useEffect(() => { const m = readMuted(); mutedRef.current = m; setMuted(m); }, []);

  const finish = useCallback(() => { setScript(null); setLive(false); setTalking(null); setPaused(false); setBlocked(false); }, []);

  const stop = useCallback(() => {
    generation.current++;
    talk.current?.pause();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    finish();
  }, [finish]);

  const speak = useCallback((req: SpeakRequest) => {
    const tts = "speechSynthesis" in window;
    const plan = planSpeech(req, { clips: true, tts, muted: mutedRef.current, brand });
    stop();
    const gen = generation.current;
    if (plan.kind === "clip") {
      setScript(plan.script.id); setTalking("clip");
    } else if (plan.kind === "tts") {
      const u = new SpeechSynthesisUtterance(plan.text);
      const v = pickVoice(window.speechSynthesis.getVoices());
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = "en-AU";
      u.rate = 1; u.pitch = 1.05;
      u.onend = u.onerror = () => { if (gen === generation.current) finish(); };
      setTalking("tts");
      window.speechSynthesis.speak(u);
    }
  }, [stop, finish, brand]);

  useEffect(() => {
    const onSpeak = (e: Event) => speak((e as CustomEvent<SpeakRequest>).detail ?? {});
    window.addEventListener(PRESENTER_SPEAK_EVENT, onSpeak);
    window.addEventListener(PRESENTER_STOP_EVENT, stop);
    return () => { window.removeEventListener(PRESENTER_SPEAK_EVENT, onSpeak); window.removeEventListener(PRESENTER_STOP_EVENT, stop); stop(); };
  }, [speak, stop]);

  // Start the scripted clip once its element exists. The walk loop is hidden only when the clip's first frame is up, so there is never an empty frame.
  useEffect(() => {
    const v = talk.current;
    if (!script || !v) return;
    const gen = generation.current;
    v.muted = mutedRef.current; v.currentTime = 0;
    v.play().catch(() => {
      if (gen !== generation.current) return;
      // Autoplay with sound refused: play silently so the lip movement still shows, and offer the sound.
      v.muted = true; setBlocked(true); v.play().catch(() => { if (gen === generation.current) finish(); });
    });
  }, [script, finish]);

  const toggleMute = () => {
    const m = !mutedRef.current; mutedRef.current = m; setMuted(m); saveMuted(m); setBlocked(false);
    if (talk.current) talk.current.muted = m;
    if (m && talking === "tts") stop();
  };
  const togglePause = () => {
    const v = talk.current;
    if (talking === "clip" && v) { if (v.paused) { v.play().catch(() => {}); setPaused(false); } else { v.pause(); setPaused(true); } }
    else if (talking === "tts") { const s = window.speechSynthesis; if (s.paused) { s.resume(); setPaused(false); } else { s.pause(); setPaused(true); } }
  };
  const unblock = () => { const v = talk.current; if (v && !mutedRef.current) { v.muted = false; setBlocked(false); } };

  useEffect(() => {
    const detail: PresenterState = { talking, paused, muted, blocked };
    window.dispatchEvent(new CustomEvent(PRESENTER_STATE_EVENT, { detail }));
  }, [talking, paused, muted, blocked]);

  useEffect(() => {
    const onControl = (e: Event) => {
      const a = (e as CustomEvent<{ action: "pause" | "mute" }>).detail?.action;
      if (a === "pause") togglePause(); else if (a === "mute") { if (blocked) unblock(); else toggleMute(); }
    };
    window.addEventListener(PRESENTER_CONTROL_EVENT, onControl);
    return () => window.removeEventListener(PRESENTER_CONTROL_EVENT, onControl);
  });

  return (
    <>
      <video className={`ew-media pr-walk${live ? " is-hidden" : ""}`} ref={walk} autoPlay loop muted {...VIDEO_PROPS} preload="auto" key={dark ? "d" : "l"}>
        {clipSources("walk", dark).map((s) => <source key={s.src} src={s.src} type={s.type} />)}
      </video>
      {script && (
        <video className="ew-media pr-talk" ref={talk} key={`${script}${dark ? "d" : "l"}`} {...VIDEO_PROPS} preload="auto" onEnded={finish} onPlaying={() => setLive(true)}>
          {clipSources(script, dark).map((s) => <source key={s.src} src={s.src} type={s.type} />)}
        </video>
      )}
    </>
  );
}
