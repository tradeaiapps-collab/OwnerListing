"use client";
import { Fragment, useEffect, useState, type CSSProperties } from "react";
import type { HeroSlide } from "../src/domain/home-hero";

/**
 * Full-screen photo slideshow with soft-focus crossfades. The active progress line's CSS animation drives the timing
 * (its animationend advances the slide), so pausing is just animation-play-state and reduced motion never advances.
 * The tagline is the heading for assistive tech; the rotating lines are visual only.
 */
export function HeroSlides({ slides, lines, headingId }: { slides: HeroSlide[]; lines: string[]; headingId: string }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const n = lines.length;
  const on = i % slides.length;
  return (
    <>
      <div className="hl-slides" aria-hidden="true">
        {slides.map((s, k) => (
          <img key={k} className="hx-img" src={s.src} alt="" decoding="async" {...(k === 0 ? { fetchPriority: "high" as const } : {})}
            {...(k === on ? { "data-on": "" } : {})} style={{ objectPosition: s.focus, transformOrigin: s.focus, "--z": s.zoom } as CSSProperties} />
        ))}
      </div>
      <div className="hx-shade" aria-hidden="true" />
      <h1 id={headingId} className="hl-title">
        <span className="sr-only">{lines[0]}</span>
        <span className="hl-line" key={i} aria-hidden="true">
          {lines[i]!.split(" ").map((w, k) => <Fragment key={k}>{k > 0 && " "}<span style={{ animationDelay: `${k * 80}ms` }}>{w}</span></Fragment>)}
        </span>
      </h1>
      {n > 1 && (
        <div className={`hl-prog${paused ? " is-paused" : ""}`}>
          <div className="hl-bars" aria-hidden="true">
            {lines.map((_, k) => (
              <i key={k} className={k < i ? "done" : k === i ? "on" : undefined} onAnimationEnd={k === i ? () => setI((i + 1) % n) : undefined} />
            ))}
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
  return (
    <nav className="hl-modes" aria-label="Buy, sell or rent">
      <a href="/listings?type=sale">Buy</a>
      <a href="/listings/new">Sell</a>
      <a href="/listings?type=rent">Rent</a>
    </nav>
  );
}
