"use client";
import { useRef, type ReactNode } from "react";

/** Horizontal, swipeable card row with previous/next buttons. The cards themselves are server-rendered children (plain links). */
export default function HomeCarousel({ label, children }: { label: string; children: ReactNode }) {
  const track = useRef<HTMLUListElement>(null);
  const move = (dir: 1 | -1) => {
    const el = track.current;
    if (el) el.scrollBy({ left: dir * Math.max(el.clientWidth * 0.85, 260), behavior: "smooth" });
  };
  return (
    <div className="hc">
      <ul ref={track} className="hc-track" aria-label={label}>{children}</ul>
      <div className="hc-nav">
        <button type="button" className="secondary" onClick={() => move(-1)} aria-label="Previous listings"><span aria-hidden="true">←</span></button>
        <button type="button" className="secondary" onClick={() => move(1)} aria-label="Next listings"><span aria-hidden="true">→</span></button>
      </div>
    </div>
  );
}
