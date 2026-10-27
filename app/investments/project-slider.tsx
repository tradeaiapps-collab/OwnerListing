"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { altFor, photoUrl, srcSetFor, type PhotoView } from "../../src/domain/listing-photos";

const BASE = "/api/investments/photos";
const INTERVAL_MS = 5000;

/**
 * Project photo slideshow sized to the content column: slides advance on their own every 5 seconds, with arrows, dots,
 * swipe, keyboard and a thumbnail row. Auto-play pauses on hover, on keyboard focus, while the tab is hidden, with the
 * Pause button, and never starts for people who ask for reduced motion.
 */
export function ProjectSlider({ photos, title }: { photos: PhotoView[]; title: string }) {
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [hold, setHold] = useState(false);
  const [calm, setCalm] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const thumbs = useRef<HTMLDivElement>(null);
  const total = photos.length;
  const go = useCallback((i: number) => setAt((i + total) % total), [total]);

  useEffect(() => {
    const q = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setCalm(q.matches);
    on();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);

  const auto = playing && !hold && !calm && total > 1;
  useEffect(() => {
    if (!auto) return;
    const t = window.setInterval(() => { if (!document.hidden) setAt(i => (i + 1) % total); }, INTERVAL_MS);
    return () => window.clearInterval(t);
  }, [auto, total, at]);

  useEffect(() => {
    const box = thumbs.current, el = box?.querySelector<HTMLElement>(`[data-i="${at}"]`);
    if (box && el) box.scrollTo({ left: el.offsetLeft - (box.clientWidth - el.clientWidth) / 2, behavior: calm ? "auto" : "smooth" });
  }, [at, calm]);

  if (total === 0) return null;
  const v = photos[at]!;
  return (
    <section className="ps" aria-roledescription="carousel" aria-label={`Photos of ${title}`}
      onMouseEnter={() => setHold(true)} onMouseLeave={() => setHold(false)}
      onFocus={() => setHold(true)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHold(false); }}
      onKeyDown={e => {
        if (e.key === "ArrowRight") { e.preventDefault(); go(at + 1); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); go(at - 1); }
      }}>
      <div className="ps-stage"
        onPointerDown={e => { if (e.pointerType !== "mouse") start.current = { x: e.clientX, y: e.clientY }; }}
        onPointerUp={e => {
          const s = start.current;
          start.current = null;
          if (!s) return;
          const dx = e.clientX - s.x, dy = e.clientY - s.y;
          if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) go(at + (dx < 0 ? 1 : -1));
        }}>
        <ul className="ps-track" style={{ transform: `translateX(-${at * 100}%)` }} aria-live={auto ? "off" : "polite"}>
          {photos.map((p, i) => (
            <li key={p.id} className="ps-slide" aria-roledescription="slide" aria-label={`${i + 1} of ${total}`} aria-hidden={i !== at}>
              <img src={photoUrl(p.id, "full", BASE)} srcSet={srcSetFor(p, BASE) || undefined} sizes="(min-width: 960px) 820px, 100vw"
                width={p.width} height={p.height} alt={altFor(p, i, total, title)} loading={i === 0 ? "eager" : "lazy"} decoding="async" draggable={false} />
            </li>
          ))}
        </ul>
        {v.caption && <p className="ps-caption">{v.caption}</p>}
        {total > 1 && (
          <>
            <button type="button" className="ps-nav ps-prev" onClick={() => go(at - 1)} aria-label="Previous photo">‹</button>
            <button type="button" className="ps-nav ps-next" onClick={() => go(at + 1)} aria-label="Next photo">›</button>
            <div className="ps-bar">
              <span className="ps-count">{at + 1} / {total}</span>
              {!calm && (
                <button type="button" className="ps-play" onClick={() => setPlaying(!playing)} aria-pressed={!playing}>
                  {playing ? "Pause" : "Play"}<span className="sr-only"> slideshow</span>
                </button>
              )}
            </div>
          </>
        )}
      </div>
      {total > 1 && (
        <div className="ps-thumbs" ref={thumbs} role="group" aria-label="Choose a photo">
          {photos.map((p, i) => (
            <button key={p.id} type="button" data-i={i} className="ps-thumb" aria-current={i === at ? "true" : undefined}
              aria-label={`Show photo ${i + 1} of ${total}`} onClick={() => go(i)}>
              <img src={photoUrl(p.id, p.sizes.includes("thumb") ? "thumb" : "full", BASE)} alt="" width={p.width} height={p.height} loading="lazy" decoding="async" draggable={false} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
