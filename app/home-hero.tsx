"use client";
import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import { HERO_SLIDE_SECONDS, type HeroSlide } from "../src/domain/home-hero";

/**
 * Full-screen photo slideshow with soft-focus crossfades. A timer advances the slide every HERO_SLIDE_SECONDS, so it
 * keeps cycling even when the OS turns animations off; the progress lines only show the timing. Under reduced motion
 * the photos swap with a plain fade (no blur or zoom) and the pause button stays. The tagline is the heading for
 * assistive tech; the rotating lines are visual only.
 */
export function HeroSlides({ slides, lines, headingId }: { slides: HeroSlide[]; lines: string[]; headingId: string }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = Math.max(lines.length, slides.length);
  // Time left on the current slide, kept across pause so play resumes where the progress line stopped.
  const left = useRef(HERO_SLIDE_SECONDS * 1000);
  useEffect(() => {
    if (paused || count < 2) return;
    const started = Date.now();
    let fired = false;
    const t = window.setTimeout(() => { fired = true; left.current = HERO_SLIDE_SECONDS * 1000; setI(k => (k + 1) % count); }, left.current);
    return () => { window.clearTimeout(t); if (!fired) left.current = Math.max(0, left.current - (Date.now() - started)); };
  }, [i, paused, count]);
  const on = i % slides.length;
  const line = lines[i % lines.length]!;
  return (
    <>
      <div className="hl-slides" aria-hidden="true">
        {slides.map((s, k) => (
          <img key={k} className="hx-img" src={s.src} alt="" decoding="async" {...(k === 0 ? { fetchPriority: "high" as const } : { loading: "lazy" as const })}
            {...(k === on ? { "data-on": "" } : {})} style={{ objectPosition: s.focus, transformOrigin: s.focus, "--z": s.zoom } as CSSProperties} />
        ))}
      </div>
      <div className="hx-shade" aria-hidden="true" />
      <h1 id={headingId} className="hl-title">
        <span className="sr-only">{lines[0]}</span>
        <span className="hl-line" key={i} aria-hidden="true">
          {line.split(" ").map((w, k) => <Fragment key={k}>{k > 0 && " "}<span style={{ animationDelay: `${k * 80}ms` }}>{w}</span></Fragment>)}
        </span>
      </h1>
      {count > 1 && (
        <div className={`hl-prog${paused ? " is-paused" : ""}`} style={{ "--hl-dur": `${HERO_SLIDE_SECONDS}s` } as CSSProperties}>
          <div className="hl-bars" aria-hidden="true">
            {Array.from({ length: count }, (_, k) => <i key={k} className={k < i ? "done" : k === i ? "on" : undefined} />)}
          </div>
          <button type="button" className="hl-pause" aria-label={paused ? "Play slideshow" : "Pause slideshow"} onClick={() => setPaused(p => !p)}>
            <span className={paused ? "is-play" : "is-pause"} aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  );
}

/**
 * Thin Buy · Sell · Rent bar under the site header. On the home page the header sits transparent over the photo;
 * once the hero scrolls away (or the phone menu opens) both turn solid. Without JavaScript they stay as styled in CSS.
 */
export function HairlineBar() {
  useEffect(() => {
    const header = document.querySelector<HTMLElement>(".site-header");
    const hero = document.querySelector<HTMLElement>(".hx-hairline");
    if (!header || !hero) return;
    const root = document.documentElement;
    const bar = document.querySelector<HTMLElement>(".hl-modes");
    const sync = () => header.toggleAttribute("data-solid", window.scrollY > hero.offsetHeight - header.offsetHeight - (bar?.offsetHeight ?? 0) - 24);
    const ro = new ResizeObserver(() => { root.style.setProperty("--hl-top", `${header.offsetHeight}px`); sync(); });
    ro.observe(header);
    sync();
    window.addEventListener("scroll", sync, { passive: true });
    return () => { ro.disconnect(); window.removeEventListener("scroll", sync); header.removeAttribute("data-solid"); root.style.removeProperty("--hl-top"); };
  }, []);
  // Which Buy / Sell / Rent area the visitor is reading: the last section (marked data-mode) that has scrolled past the bar.
  const [spy, setSpy] = useState<{ mode: string; crumb: string } | null>(null);
  useEffect(() => {
    const secs = Array.from(document.querySelectorAll<HTMLElement>("[data-mode]"));
    const update = () => {
      const header = document.querySelector<HTMLElement>(".site-header");
      const line = (header?.offsetHeight ?? 72) + 44 + 24;
      let cur: HTMLElement | null = null;
      for (const el of secs) { const r = el.getBoundingClientRect(); if (r.top <= line && r.bottom > line) cur = el; }
      const next = cur ? { mode: cur.dataset.mode ?? "", crumb: cur.dataset.crumb ?? "" } : null;
      setSpy(p => (p?.mode === next?.mode && p?.crumb === next?.crumb ? p : next));
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => { window.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, []);
  const modes = [["buy", "Buy", "/listings?type=sale"], ["sell", "Sell", "/listings/new"], ["rent", "Rent", "/listings?type=rent"]] as const;
  const mode = modes.find(m => m[0] === spy?.mode);
  return (
    <>
      <nav className="hl-modes" aria-label="Buy, sell or rent">
        {modes.map(([id, label, href]) => <a key={id} href={href} {...(spy?.mode === id ? { "aria-current": "true" as const } : {})}>{label}</a>)}
      </nav>
      {mode && spy && (
        <nav className="hl-crumbs" aria-label="Breadcrumb">
          <ol>
            <li><a href="/">Home</a></li>
            <li><a href={mode[2]}>{mode[1]}</a></li>
            <li><span aria-current="location">{spy.crumb}</span></li>
          </ol>
        </nav>
      )}
    </>
  );
}
