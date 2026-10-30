"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { OPEN_GUIDE_EVENT, GUIDE_STATE_EVENT } from "./guide-assistant";
import "./styles/elena-walker.css";

type Phase = "perched" | "down" | "stopped" | "up";
type Pt = { x: number; y: number; animate: boolean };

const SIZE_WIDE = 112, SIZE_NARROW = 88;
const PANEL_W = 380, GUTTER = 16, WALK_MS = 1800, RETURN_DELAY_MS = 5000;

const size = () => (window.innerWidth < 600 ? SIZE_NARROW : SIZE_WIDE);
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Where she stops: the middle of the page, or the middle of the free space beside the chat panel. On phones the panel becomes a bottom sheet, so she stops in the middle of the area above it. */
function target(): { x: number; y: number } {
  const s = size(), vw = window.innerWidth, vh = window.innerHeight;
  if (vw < 600) return { x: (vw - s) / 2, y: Math.max(8, (vh * 0.42 - s) / 2) };
  const panelLeft = vw - PANEL_W - GUTTER;
  const cx = vw / 2 + s / 2 + GUTTER < panelLeft ? vw / 2 : panelLeft / 2;
  return { x: cx - s / 2, y: vh * 0.45 - s / 2 };
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
  const phaseRef = useRef<Phase>("perched");
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
    setPos({ ...from, animate: false });
    go(via);
    requestAnimationFrame(() => requestAnimationFrame(() => setPos({ ...to, animate: true })));
    guard.current = window.setTimeout(() => arrive(end), WALK_MS + 400);
  }, [arrive]);

  useEffect(() => {
    const onState = (e: Event) => {
      const d = (e as CustomEvent<{ open: boolean; busy: boolean }>).detail;
      setBusy(d.busy);
      window.clearTimeout(timer.current);
      const p = phaseRef.current;
      if (d.open) {
        document.body.classList.add("ew-active");
        if (p === "perched") walk(slotPt(), target(), "down", "stopped");
        else if (p === "up") walk(posRef.current, target(), "down", "stopped");
      } else {
        timer.current = window.setTimeout(() => {
          const q = phaseRef.current;
          if (q === "perched") return;
          walk(q === "stopped" ? target() : posRef.current, slotPt(), "up", "perched");
          document.body.classList.remove("ew-active");
        }, RETURN_DELAY_MS);
      }
    };
    window.addEventListener(GUIDE_STATE_EVENT, onState);
    return () => { window.removeEventListener(GUIDE_STATE_EVENT, onState); window.clearTimeout(timer.current); window.clearTimeout(guard.current); document.body.classList.remove("ew-active"); };
  }, [walk, slotPt]);

  const posRef = useRef(pos);
  posRef.current = pos;

  // Keep her in the middle if the window is resized while she is out.
  useEffect(() => {
    const onResize = () => { if (phaseRef.current === "stopped") setPos({ ...target(), animate: false }); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const out = phase !== "perched";
  const clip = !video || reduced() || !out ? null : busy ? "talking" : "presenting";
  const style = out ? { transform: `translate(${pos.x}px, ${pos.y}px)`, transition: pos.animate ? `transform ${WALK_MS}ms cubic-bezier(0.45, 0, 0.25, 1)` : "none" } : undefined;

  return (
    <span ref={slot} className="ew-slot">
      <button
        type="button" className={`ew ew-${phase}${busy ? " is-talking" : ""}`} style={style} data-ew-phase={phase}
        onClick={() => window.dispatchEvent(new Event(OPEN_GUIDE_EVENT))}
        onTransitionEnd={e => { if (e.target === e.currentTarget && e.propertyName === "transform") arrive(phaseRef.current === "down" ? "stopped" : phaseRef.current === "up" ? "perched" : phaseRef.current); }}
        aria-label={`Ask ${name} a question`}
      >
        <span className="ew-body">
          {clip ? (
            <video key={clip} className="ew-media" autoPlay loop muted playsInline disablePictureInPicture disableRemotePlayback controls={false} controlsList="nodownload nofullscreen noremoteplayback" tabIndex={-1} preload="auto" poster={`/assistant/elena-video-${clip}.jpg`} aria-hidden="true">
              <source src={`/assistant/elena-video-${clip}.webm`} type="video/webm" />
              <source src={`/assistant/elena-video-${clip}.mp4`} type="video/mp4" />
            </video>
          ) : (
            <img className="ew-media" src={still} alt="" width={408} height={414} decoding="async" />
          )}
        </span>
      </button>
    </span>
  );
}
