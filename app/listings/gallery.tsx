"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { altFor, photoUrl, srcSetFor, type PhotoView } from "../../src/domain/listing-photos";
import "../styles/gallery.css";

type Tab = "photo" | "floorplan";
type Media = { id: string; label: string };

/** True while the viewport is phone-sized (carousel instead of the hero grid). */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const q = window.matchMedia("(max-width: 719px)");
    const on = () => setNarrow(q.matches);
    on();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return narrow;
}

function Img({ v, sizes, alt, eager, className }: { v: PhotoView; sizes: string; alt: string; eager?: boolean; className?: string | undefined }) {
  return (
    <img className={className} src={photoUrl(v.id)} srcSet={srcSetFor(v) || undefined} sizes={sizes} width={v.width} height={v.height}
      alt={alt} loading={eager ? "eager" : "lazy"} decoding="async" draggable={false} />
  );
}

/**
 * Full-screen viewer: arrow keys, Esc, swipe, thumbnail strip, counter, focus kept inside, focus returned on close.
 * Uses the native modal dialog, so the page behind is inert for keyboard and screen readers.
 */
function Lightbox({ items, index, title, onIndex, onClose }: {
  items: PhotoView[]; index: number; title: string; onIndex: (i: number) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const total = items.length;
  const go = useCallback((d: number) => onIndex((index + d + total) % total), [index, total, onIndex]);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    const opener = document.activeElement as HTMLElement | null;
    if (!dlg.open) dlg.showModal();
    document.documentElement.classList.add("gl-lock");
    return () => {
      document.documentElement.classList.remove("gl-lock");
      if (dlg.open) dlg.close();
      opener?.focus?.();
    };
  }, []);

  useEffect(() => {
    strip.current?.querySelector<HTMLElement>(`[data-i="${index}"]`)?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [index]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
    else if (e.key === "Home") { e.preventDefault(); onIndex(0); }
    else if (e.key === "End") { e.preventDefault(); onIndex(total - 1); }
    else if (e.key === "Tab") {
      // Keep Tab inside the viewer (the dialog is modal, this also stops focus reaching the browser bar between items).
      const f = Array.from(ref.current?.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]") ?? []);
      if (f.length === 0) return;
      const first = f[0]!, last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  const v = items[index]!;
  const alt = altFor(v, index, total, title);
  return (
    <dialog ref={ref} className="gl-box" aria-label={`Photo viewer: ${title}`} onKeyDown={onKey}
      onCancel={e => { e.preventDefault(); onClose(); }}>
      <div className="gl-top">
        <p className="gl-counter" aria-live="polite">{index + 1} of {total}</p>
        <button type="button" className="gl-close" onClick={onClose} aria-label="Close photo viewer">Close</button>
      </div>
      <div className="gl-stage"
        onPointerDown={e => { if (e.pointerType !== "mouse") start.current = { x: e.clientX, y: e.clientY }; }}
        onPointerUp={e => {
          const s = start.current;
          start.current = null;
          if (!s) return;
          const dx = e.clientX - s.x, dy = e.clientY - s.y;
          if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
        }}>
        {total > 1 && <button type="button" className="gl-nav gl-prev" onClick={() => go(-1)} aria-label="Previous photo">‹</button>}
        <figure className="gl-figure">
          <Img key={v.id} v={v} sizes="100vw" alt={alt} eager className={v.kind === "floorplan" ? "gl-img gl-plan" : "gl-img"} />
          {v.caption && <figcaption>{v.caption}</figcaption>}
        </figure>
        {total > 1 && <button type="button" className="gl-nav gl-next" onClick={() => go(1)} aria-label="Next photo">›</button>}
        {/* Preload the neighbours so arrows feel instant. */}
        {total > 1 && [items[(index + 1) % total]!, items[(index - 1 + total) % total]!].map(n => (
          <link key={n.id} rel="preload" as="image" href={photoUrl(n.id)} imageSrcSet={srcSetFor(n) || undefined} imageSizes="100vw" />
        ))}
      </div>
      {total > 1 && (
        <div className="gl-strip" ref={strip} role="group" aria-label="All photos">
          {items.map((p, i) => (
            <button key={p.id} type="button" data-i={i} className="gl-thumb" aria-current={i === index ? "true" : undefined}
              aria-label={`Show ${p.kind === "floorplan" ? "floor plan" : "photo"} ${i + 1} of ${total}`} onClick={() => onIndex(i)}>
              <Img v={p} sizes="96px" alt="" />
            </button>
          ))}
        </div>
      )}
    </dialog>
  );
}

/** Phone layout: swipeable, scroll-snapping strip with dots and a counter. Tapping a photo opens the viewer. */
function Carousel({ items, title, onOpen }: { items: PhotoView[]; title: string; onOpen: (i: number) => void }) {
  const track = useRef<HTMLUListElement>(null);
  const [at, setAt] = useState(0);
  const onScroll = () => {
    const t = track.current;
    if (t && t.clientWidth) setAt(Math.round(t.scrollLeft / t.clientWidth));
  };
  const to = (i: number) => {
    const t = track.current;
    if (t) t.scrollTo({ left: i * t.clientWidth, behavior: "smooth" });
  };
  return (
    <div className="gl-carousel" role="group" aria-roledescription="carousel" aria-label={`Photos of ${title}`}>
      <ul className="gl-track" ref={track} onScroll={onScroll}>
        {items.map((v, i) => (
          <li key={v.id} aria-roledescription="slide" aria-label={`${i + 1} of ${items.length}`}>
            <button type="button" className="gl-open" onClick={() => onOpen(i)} aria-label={`Open ${altFor(v, i, items.length, title)} full screen`}>
              <Img v={v} sizes="100vw" alt="" eager={i === 0} className={v.kind === "floorplan" ? "gl-plan" : undefined} />
            </button>
          </li>
        ))}
      </ul>
      <p className="gl-count-badge" aria-live="polite">{Math.min(at, items.length - 1) + 1} / {items.length}</p>
      {items.length > 1 && items.length <= 12 && (
        <div className="gl-dots">
          {items.map((v, i) => (
            <button key={v.id} type="button" className="gl-dot" aria-label={`Go to ${i + 1} of ${items.length}`} aria-current={i === at ? "true" : undefined} onClick={() => to(i)} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Desktop layout: large hero and a 2 by 2 grid, with a "View all" button. */
function HeroGrid({ items, title, onOpen, label }: { items: PhotoView[]; title: string; onOpen: (i: number) => void; label: string }) {
  const shown = items.slice(0, 5);
  return (
    <div className={`gl-grid gl-n${shown.length}`}>
      {shown.map((v, i) => (
        <button key={v.id} type="button" className={i === 0 ? "gl-cell gl-hero" : "gl-cell"} onClick={() => onOpen(i)}
          aria-label={`Open ${altFor(v, i, items.length, title)} full screen`}>
          <Img v={v} sizes={i === 0 ? "(min-width: 1120px) 520px, 60vw" : "(min-width: 1120px) 260px, 30vw"} alt="" eager={i === 0}
            className={v.kind === "floorplan" ? "gl-plan" : undefined} />
        </button>
      ))}
      <button type="button" className="gl-all" onClick={() => onOpen(0)}>{items.length > 1 ? `View all ${items.length} ${label}` : "View full screen"}</button>
    </div>
  );
}

/**
 * Public gallery of a listing: Photos and Floor plan tabs, and a Video / virtual tour link when the owner added one.
 * Public video files from the listing's documents are offered as downloads in the same place.
 */
export function ListingGallery({ listingId, title }: { listingId: string; title: string }) {
  const [photos, setPhotos] = useState<PhotoView[] | null>(null);
  const [tourUrl, setTourUrl] = useState<string | null>(null);
  const [videos, setVideos] = useState<Media[]>([]);
  const [tab, setTab] = useState<Tab>("photo");
  const [open, setOpen] = useState<number | null>(null);
  const narrow = useNarrow();

  useEffect(() => {
    setPhotos(null);
    fetch(`/api/listings/${listingId}/photos`)
      .then(async r => (r.ok ? r.json() : { photos: [], tourUrl: null }))
      .then(d => { setPhotos(d.photos ?? []); setTourUrl(d.tourUrl ?? null); })
      .catch(() => setPhotos([]));
    fetch(`/api/listings/${listingId}/documents`)
      .then(async r => (r.ok ? (await r.json()).documents as { id: string; kind: string; visibility: string; status: string }[] : []))
      .then(all => setVideos(all.filter(d => d.visibility === "public" && d.status === "active" && (d.kind === "video" || d.kind === "video_360"))
        .map(d => ({ id: d.id, label: d.kind === "video" ? "Video" : "360 video" }))))
      .catch(() => setVideos([]));
  }, [listingId]);

  if (photos === null) return <div className="gl-empty gl-loading" aria-hidden="true" />;
  const byKind = { photo: photos.filter(p => p.kind === "photo"), floorplan: photos.filter(p => p.kind === "floorplan") };
  const items = byKind[tab].length ? byKind[tab] : byKind.photo.length ? byKind.photo : byKind.floorplan;
  const current: Tab = items === byKind.floorplan && byKind.floorplan.length ? "floorplan" : "photo";
  const tabs = ([["photo", "Photos"], ["floorplan", "Floor plan"]] as const).filter(([k]) => byKind[k].length > 0);
  const label = current === "floorplan" ? (items.length === 1 ? "floor plan" : "floor plans") : items.length === 1 ? "photo" : "photos";

  return (
    <section className="gl" aria-label="Photos and plans">
      {items.length === 0
        ? <div className="gl-empty" role="img" aria-label="No photos added yet"><span>No photos yet</span></div>
        : narrow
          ? <Carousel key={current} items={items} title={title} onOpen={setOpen} />
          : <HeroGrid key={current} items={items} title={title} onOpen={setOpen} label={label} />}
      {(tabs.length > 1 || tourUrl || videos.length > 0) && (
        <div className="gl-tabs">
          {tabs.length > 1 && (
            <div role="group" aria-label="Show">
              {tabs.map(([k, name]) => (
                <button key={k} type="button" aria-pressed={current === k} className="gl-tab" onClick={() => setTab(k)}>
                  {name} <span className="gl-tab-n">{byKind[k].length}</span>
                </button>
              ))}
            </div>
          )}
          {tourUrl && <a className="gl-tab gl-link" href={tourUrl} target="_blank" rel="noopener noreferrer nofollow">Video / virtual tour<span className="sr-only"> (opens a new tab)</span></a>}
          {videos.map((m, i) => <a key={m.id} className="gl-tab gl-link" href={`/api/documents/${m.id}/file`}>{m.label} {videos.length > 1 ? i + 1 : ""} (download)</a>)}
        </div>
      )}
      {open !== null && items[open] && <Lightbox items={items} index={open} title={title} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </section>
  );
}
