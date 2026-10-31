"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { OPEN_GUIDE_EVENT, GUIDE_STATE_EVENT } from "./guide-assistant";
import { PRESENTER_SPEAK_EVENT } from "./presenter/presenter-core";
import PresenterStage from "./presenter/presenter-stage";
import "./styles/elena-walker.css";

type Phase = "perched" | "down" | "stopped" | "up";
type Point = { x: number; y: number };
type MotionPoint = Point & { animate: boolean; dur?: number; delay?: number };
type IdleAction = "settle" | "weight" | "step" | "gesture";

const FIGURE_H = 300;
const FIGURE_W = 170;
const SMALL_H = 220;
const SMALL_W = 125;
const RETURN_DELAY = 15000;
const WALK_MS = 3000;

const dimensions = (): { w: number; h: number } => window.innerWidth < 600
  ? { w: SMALL_W, h: SMALL_H }
  : { w: FIGURE_W, h: FIGURE_H };
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function homePoint(): Point {
  const h1 = document.querySelector<HTMLElement>(".ew-anchor h1") ?? document.querySelector<HTMLElement>("main h1");
  const r = h1?.getBoundingClientRect();
  const { w, h } = dimensions();
  if (!r) return { x: 18, y: Math.max(90, window.innerHeight - h - 24) };
  // Place her just over the first letter, as if resting one shoulder against the heading.
  const x = Math.max(8, Math.min(window.innerWidth - w - 8, r.left - 18));
  const y = Math.max(90, Math.min(window.innerHeight - h - 12, r.top - 22));
  return { x, y };
}

function centrePoint(): Point {
  const { w, h } = dimensions();
  const panelClearance = window.innerWidth >= 900 ? 0 : 0;
  return {
    x: Math.max(8, Math.min(window.innerWidth - w - 8, (window.innerWidth - w) * 0.48 - panelClearance)),
    y: Math.max(90, Math.min(window.innerHeight - h - 12, (window.innerHeight - h) * 0.48)),
  };
}

/**
 * One shared page companion. She starts beside the page heading, walks into a clear
 * central position, responds only to guide answers, then returns to her resting pose
 * after a period of inactivity. The movement wrapper and body-language layer are separate.
 */
export default function ElenaWalker({ name, still, video, brand }: { name: string; still: string; video: boolean; brand: string }) {
  const [phase, setPhase] = useState<Phase>("perched");
  const [home, setHome] = useState<Point>({ x: 18, y: 120 });
  const [pos, setPos] = useState<MotionPoint>({ x: 18, y: 120, animate: false });
  const [busy, setBusy] = useState(false);
  const [idleAction, setIdleAction] = useState<IdleAction>("settle");
  const [dark, setDark] = useState(false);
  const phaseRef = useRef<Phase>("perched");
  const posRef = useRef<Point>({ x: 18, y: 120 });
  const idleTimer = useRef<number | undefined>(undefined);
  const walkTimer = useRef<number | undefined>(undefined);
  const actionTimer = useRef<number | undefined>(undefined);
  const actionRef = useRef<number | undefined>(undefined);
  const replyTimer = useRef<number | undefined>(undefined);
  const rate = useRef(1);

  const changePhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const randomIdle = useCallback(() => {
    const actions: IdleAction[] = ["settle", "weight", "step", "gesture"];
    const next = actions[Math.floor(Math.random() * actions.length)] ?? "settle";
    setIdleAction(next);
    actionTimer.current = window.setTimeout(() => setIdleAction("settle"), 2600 + Math.random() * 1800);
    actionRef.current = window.setTimeout(() => {
      if (phaseRef.current === "stopped") randomIdle();
    }, 5200 + Math.random() * 5000);
  }, []);

  const walk = useCallback((from: Point, to: Point, next: Phase, done: Phase) => {
    window.clearTimeout(walkTimer.current);
    if (reduced()) {
      posRef.current = to;
      setPos({ ...to, animate: false });
      changePhase(done);
      return;
    }
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    rate.current = distance < 1 ? 1 : Math.min(1.45, Math.max(0.65, distance / 260));
    posRef.current = from;
    setPos({ ...from, animate: false });
    changePhase(next);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      posRef.current = to;
      setPos({ ...to, animate: true, dur: WALK_MS / rate.current });
    }));
    walkTimer.current = window.setTimeout(() => changePhase(done), WALK_MS / rate.current + 120);
  }, [changePhase]);

  const goHome = useCallback(() => {
    window.clearTimeout(idleTimer.current);
    window.clearTimeout(actionRef.current);
    window.clearTimeout(actionTimer.current);
    setIdleAction("settle");
    if (phaseRef.current === "perched" || phaseRef.current === "up") return;
    const to = homePoint();
    setHome(to);
    walk(posRef.current, to, "up", "perched");
  }, [walk]);

  const goCentre = useCallback(() => {
    window.clearTimeout(idleTimer.current);
    if (phaseRef.current === "stopped" || phaseRef.current === "down") return;
    const to = centrePoint();
    walk(phaseRef.current === "perched" || phaseRef.current === "up" ? homePoint() : posRef.current, to, "down", "stopped");
  }, [walk]);

  // First-load arrival: lean against the heading, then walk to a clear central waiting position.
  useEffect(() => {
    const start = () => {
      const h = homePoint();
      const c = centrePoint();
      setHome(h);
      setPos({ ...h, animate: false });
      posRef.current = h;
      changePhase("perched");
      window.setTimeout(() => walk(h, c, "down", "stopped"), 450);
    };
    const raf = requestAnimationFrame(start);
    return () => cancelAnimationFrame(raf);
  }, [changePhase, walk]);

  useEffect(() => {
    const onGuideState = (e: Event) => {
      const d = (e as CustomEvent<{ open: boolean; busy: boolean; typing?: boolean }>).detail;
      setBusy(d.busy);
      if (d.open || d.busy || d.typing) {
        goCentre();
        window.clearTimeout(idleTimer.current);
      } else {
        idleTimer.current = window.setTimeout(goHome, RETURN_DELAY);
      }
    };
    const onSpeak = () => {
      goCentre();
      window.clearTimeout(replyTimer.current);
      setIdleAction("gesture");
      replyTimer.current = window.setTimeout(() => {
        if (phaseRef.current === "stopped") randomIdle();
      }, 7000);
    };
    window.addEventListener(GUIDE_STATE_EVENT, onGuideState);
    window.addEventListener(PRESENTER_SPEAK_EVENT, onSpeak);
    return () => {
      window.removeEventListener(GUIDE_STATE_EVENT, onGuideState);
      window.removeEventListener(PRESENTER_SPEAK_EVENT, onSpeak);
      window.clearTimeout(idleTimer.current);
      window.clearTimeout(walkTimer.current);
      window.clearTimeout(actionTimer.current);
      window.clearTimeout(actionRef.current);
      window.clearTimeout(replyTimer.current);
    };
  }, [goCentre, goHome, randomIdle]);

  useEffect(() => {
    const onResize = () => {
      const h = homePoint();
      const c = centrePoint();
      setHome(h);
      if (phaseRef.current === "perched") { posRef.current = h; setPos({ ...h, animate: false }); }
      else if (phaseRef.current === "stopped") { posRef.current = c; setPos({ ...c, animate: false }); }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      const mode = document.documentElement.getAttribute("data-theme-mode");
      setDark(mode === "dark" || (mode !== "light" && media.matches));
    };
    sync();
    media.addEventListener("change", sync);
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme-mode"] });
    return () => { media.removeEventListener("change", sync); observer.disconnect(); };
  }, []);

  const isMoving = phase === "down" || phase === "up";
  const showPresenter = phase === "stopped" && busy;
  const style = {
    transform: `translate(${pos.x}px, ${pos.y}px)`,
    transition: pos.animate ? `transform ${pos.dur ?? WALK_MS}ms cubic-bezier(.25,.72,.32,1)` : "none",
  };

  return (
    <span className="ew-slot" aria-hidden="false">
      <button
        type="button"
        className={`ew ew-${phase} ew-action-${idleAction}${busy ? " is-talking" : ""}${isMoving ? " is-walk-clip" : ""}${dark ? " is-dark" : ""}`}
        style={style}
        onClick={() => window.dispatchEvent(new Event(OPEN_GUIDE_EVENT))}
        aria-label={`Ask ${name} a question`}
      >
        <span className="ew-body">
          {isMoving && video ? (
            <video className="ew-media" autoPlay muted playsInline loop={false} controls={false} controlsList="nodownload nofullscreen noremoteplayback" disablePictureInPicture disableRemotePlayback tabIndex={-1} ref={v => { if (v) v.playbackRate = rate.current; }} aria-hidden="true">
              <source src={`/assistant/elena-video-${phase === "down" ? "walk-to-camera" : "turn-away-left"}-alpha.webm`} type="video/webm; codecs=vp9" />
              <source src={`/assistant/elena-video-${phase === "down" ? "walk-to-camera" : "turn-away-left"}${dark ? "-dark" : ""}.mp4`} type="video/mp4" />
            </video>
          ) : showPresenter && video ? (
            <PresenterStage dark={dark} brand={brand} />
          ) : (
            <img className="ew-media ew-still" src={still} alt="" width={408} height={414} decoding="async" />
          )}
        </span>
      </button>
    </span>
  );
}
