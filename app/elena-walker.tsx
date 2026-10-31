"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { OPEN_GUIDE_EVENT, GUIDE_STATE_EVENT } from "./guide-assistant";
import "./styles/elena-walker.css";

type Phase = "perched" | "down" | "stopped" | "up";
type Pt = { x: number; y: number; animate: boolean; dur?: number; delay?: number };

const SIZE_WIDE = 180, SIZE_NARROW = 132;
const PANEL_W = 380, GUTTER = 16, CLIP_MS = 6000, RETURN_DELAY_MS = 5000;

const size = () => (window.innerWidth < 600 ? SIZE_NARROW : SIZE_WIDE);
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Where she stops. On wide screens she walks sideways along the heading row to just right of the heading (kept clear of the chat panel). On phones the panel becomes a bottom sheet, so she stops in the middle of the area above it. */
function target(home: { x: number; y: number }, spot = 0): { x: number; y: number } {
  const s = size(), vw = window.innerWidth, vh = window.innerHeight;
  if (vw < 600) return { x: (vw - s) / 2, y: Math.max(8, (vh * 0.42 - s) / 2) };
  const h1 = document.querySelector<HTMLElement>(".ew-anchor h1");
  const headEnd = h1 ? (() => { const r = document.createRange(); r.selectNodeContents(h1); return r.getBoundingClientRect().right; })() : home.x + s;
  const maxX = vw - PANEL_W - GUTTER * 2 - s;
  const near = Math.max(home.x, Math.min(headEnd + GUTTER * 2, maxX));
  // `spot` (0 to 1) picks a place between just beside the heading and as far along the row as the chat panel allows.
  return { x: near + (Math.max(near, maxX) - near) * spot, y: home.y };
}

/**
 * Elena sits on top of the page heading. When the chat opens she walks down to the middle of the page and stays there while it is open
 * (talking clip while she answers), and a few seconds after it closes she walks back up to the heading. The body wrapper (.ew-body) is
 * left free for stepping and weight-shifting animations; the walk itself only moves the outer element.
 * Elena has short clips; other personas get their still pose. Motion is skipped under prefers-reduced-motion.
 */
export default function ElenaWalker({ name, still, video }: { name: string; still: string; video: boolean }) {
  const slot = useRef<HTMLSpanElement>(null);
  const [phase, setPhase] = useState<Phase>("perched");
  const [pos, setPos] = useState<Pt>({ x: 0, y: 0, animate: false });
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(false);
  const [reply, setReply] = useState<"" | "agree" | "talking">("");
  const wasBusy = useRef(false);
  const replyTimer = useRef<number | undefined>(undefined);
  const [calm, setCalm] = useState(true);
  const [dark, setDark] = useState(false);
  const phaseRef = useRef<Phase>("perched");
  const spot = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const guard = useRef<number | undefined>(undefined);
  const go = (p: Phase) => { phaseRef.current = p; setPhase(p); };

  const slotPt = useCallback(() => {
    const r = slot.current?.getBoundingClientRect();
    return r ? { x: r.left, y: r.top } : { x: 0, y: 0 };
  }, []);

  const arrive = useCallback((p: Phase) => { window.clearTimeout(guard.current); go(p); }, []);
  const walk = useCallback((from: { x: number; y: number }, to: { x: number; y: number }, via: Phase, end: Phase) => {
    window.clearTimeout(guard.current);
    if (reduced()) { setPos({ ...to, animate: false }); arrive(end); return; }
    // The walk is one continuous clip (6s): walking out she walks for the first half then turns to face the user; walking back she turns first, then walks off.
    const out = via === "down";
    setPos({ ...from, animate: false });
    go(via);
    requestAnimationFrame(() => requestAnimationFrame(() => setPos({ ...to, animate: true, dur: out ? 3000 : 3300, delay: out ? 0 : 2500 })));
    guard.current = window.setTimeout(() => arrive(end), CLIP_MS + 100);
  }, [arrive]);

  useEffect(() => {
    const onState = (e: Event) => {
      const d = (e as CustomEvent<{ open: boolean; busy: boolean; typing?: boolean }>).detail;
      setBusy(d.busy);
      setTyping(!!d.typing);
      // When an answer lands she nods first, then talks for a few seconds.
      if (wasBusy.current && !d.busy) {
        window.clearTimeout(replyTimer.current);
        setReply("agree");
        replyTimer.current = window.setTimeout(() => { setReply("talking"); replyTimer.current = window.setTimeout(() => setReply(""), 6000); }, 1800);
      }
      if (d.busy) { window.clearTimeout(replyTimer.current); setReply(""); }
      wasBusy.current = d.busy;
      window.clearTimeout(timer.current);
      const p = phaseRef.current;
      if (d.open) {
        document.body.classList.add("ew-active");
        if (p !== "stopped" && p !== "down") spot.current = Math.random();
        if (p === "perched") walk(slotPt(), target(slotPt(), spot.current), "down", "stopped");
        else if (p === "up") walk(posRef.current, target(slotPt(), spot.current), "down", "stopped");
      } else {
        timer.current = window.setTimeout(() => {
          const q = phaseRef.current;
          if (q === "perched") return;
          walk(q === "stopped" ? target(slotPt(), spot.current) : posRef.current, slotPt(), "up", "perched");
          document.body.classList.remove("ew-active");
        }, RETURN_DELAY_MS);
      }
    };
    window.addEventListener(GUIDE_STATE_EVENT, onState);
    return () => { window.removeEventListener(GUIDE_STATE_EVENT, onState); window.clearTimeout(timer.current); window.clearTimeout(guard.current); window.clearTimeout(replyTimer.current); document.body.classList.remove("ew-active"); };
  }, [walk, slotPt]);

  const posRef = useRef(pos);
  posRef.current = pos;

  // Keep her in the middle if the window is resized while she is out.
  useEffect(() => {
    const onResize = () => { if (phaseRef.current === "stopped") setPos({ ...target(slotPt(), spot.current), animate: false }); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const q = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setCalm(q.matches);
    sync();
    q.addEventListener("change", sync);
    return () => q.removeEventListener("change", sync);
  }, []);

  // Dark pages get the clips with a dark or transparent backdrop instead of the white one.
  useEffect(() => {
    const q = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => { const m = document.documentElement.getAttribute("data-theme-mode"); setDark(m === "dark" || (m !== "light" && q.matches)); };
    sync();
    q.addEventListener("change", sync);
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme-mode"] });
    return () => { q.removeEventListener("change", sync); mo.disconnect(); };
  }, []);

  const out = phase !== "perched";
  // Always an animated clip for Elena: idle on the heading, listening while someone types or she thinks, nodding then talking on an answer.
  const clip = !video || calm ? null : phase === "down" ? "walk-to-camera" : phase === "up" ? "turn-away-left" : phase === "stopped" && reply ? "front-talk" : "idle-tall";
  const style = out ? { transform: `translate(${pos.x}px, ${pos.y}px)`, transition: pos.animate ? `transform ${pos.dur ?? 3000}ms cubic-bezier(0.3, 0, 0.7, 1) ${pos.delay ?? 0}ms` : "none" } : undefined;

  return (
    <span ref={slot} className="ew-slot">
      <button
        type="button" className={`ew ew-${phase}${busy ? " is-talking" : ""}${clip ? " is-walk-clip" : ""}${clip && dark ? " is-dark" : ""}`} style={style} data-ew-phase={phase}
        onClick={() => window.dispatchEvent(new Event(OPEN_GUIDE_EVENT))}
        aria-label={`Ask ${name} a question`}
      >
        <span className="ew-body">
          {clip ? (
            <video key={clip} className="ew-media" autoPlay loop={phase !== "down" && phase !== "up"} muted playsInline disablePictureInPicture disableRemotePlayback controls={false} controlsList="nodownload nofullscreen noremoteplayback" tabIndex={-1} preload="auto" aria-hidden="true">
              <source src={`/assistant/elena-video-${clip}-alpha.webm`} type="video/webm; codecs=vp9" />
              <source src={dark ? `/assistant/elena-video-${clip}-dark.mp4` : `/assistant/elena-video-${clip}.mp4`} type="video/mp4" />
            </video>
          ) : (
            <img className="ew-media" src={still} alt="" width={408} height={414} decoding="async" />
          )}
        </span>
      </button>
    </span>
  );
}
