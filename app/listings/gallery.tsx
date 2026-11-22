"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { altFor, categoriesIn, PHOTO_BASE, photoUrl, srcSetFor, type PhotoView } from "../../src/domain/listing-photos";
import { PRESENTER_SPEAK_EVENT } from "../presenter/presenter-core";
import { classifyTour, tourSummary } from "../../src/domain/virtual-tour";
import "../styles/gallery.css";

type Tab = "photo" | "floorplan" | "photo360" | "tour" | "video";
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

/** Route the images come from: listing photos by default, investor project photos set their own. */
const PhotoBase = createContext(PHOTO_BASE);

function Img({ v, sizes, alt, eager, className }: { v: PhotoView; sizes: string; alt: string; eager?: boolean; className?: string | undefined }) {
  const base = useContext(PhotoBase);
  return (
    <img className={className} src={photoUrl(v.id, "full", base)} srcSet={srcSetFor(v, base) || undefined} sizes={sizes} width={v.width} height={v.height}
      alt={alt} loading={eager ? "eager" : "lazy"} decoding="async" draggable={false} />
  );
}

/**
 * Full-screen viewer: arrow keys, Esc, swipe, thumbnail strip, counter, focus kept inside, focus returned on close.
 * Photos slide in from the side they come from. With `info`, a details panel slides in beside the photo (wide screens).
 * Uses the native modal dialog, so the page behind is inert for keyboard and screen readers.
 */
function Lightbox({ items, index, title, onIndex, onClose, info }: {
  items: PhotoView[]; index: number; title: string; onIndex: (i: number) => void; onClose: () => void; info?: string | undefined;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const dir = useRef<"next" | "prev" | "">("");
  const [panel, setPanel] = useState(true);
  const base = useContext(PhotoBase);
  const total = items.length;
  const show = useCallback((i: number) => { dir.current = i === index ? "" : i > index ? "next" : "prev"; onIndex(i); }, [index, onIndex]);
  const go = useCallback((d: number) => { dir.current = d > 0 ? "next" : "prev"; onIndex((index + d + total) % total); }, [index, total, onIndex]);

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
    else if (e.key === "Home") { e.preventDefault(); show(0); }
    else if (e.key === "End") { e.preventDefault(); show(total - 1); }
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
    <dialog ref={ref} className={info && panel ? "gl-box has-panel" : "gl-box"} aria-label={`Photo viewer: ${title}`} onKeyDown={onKey}
      onCancel={e => { e.preventDefault(); onClose(); }}>
      <div className="gl-top">
        <p className="gl-counter" aria-live="polite">{index + 1} of {total}</p>
        <div className="gl-top-tools">
          {info && <button type="button" className="gl-close gl-info-btn" aria-expanded={panel} onClick={() => setPanel(!panel)}>{panel ? "Hide details" : "Details"}</button>}
        </div>
      </div>
      <div className="gl-stage"
        onClick={e => { const t = e.target as HTMLElement; if (t === e.currentTarget || t.classList.contains("gl-figure")) onClose(); }}
        onPointerDown={e => { if (e.pointerType !== "mouse") start.current = { x: e.clientX, y: e.clientY }; }}
        onPointerUp={e => {
          const s = start.current;
          start.current = null;
          if (!s) return;
          const dx = e.clientX - s.x, dy = e.clientY - s.y;
          if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
        }}>
        {total > 1 && <button type="button" className="gl-nav gl-prev" onClick={() => go(-1)} aria-label="Previous photo">‹</button>}
        <figure key={v.id} className={dir.current ? `gl-figure gl-from-${dir.current}` : "gl-figure"}>
          <Img key={v.id} v={v} sizes="100vw" alt={alt} eager className={v.kind === "floorplan" ? "gl-img gl-plan" : "gl-img"} />
          {v.caption && <figcaption>{v.caption}</figcaption>}
          {v.features.length > 0 && <ul className="gl-feats" aria-label="Features">{v.features.map(f => <li key={f} className="gl-feat">{f}</li>)}</ul>}
        </figure>
        {total > 1 && <button type="button" className="gl-nav gl-next" onClick={() => go(1)} aria-label="Next photo">›</button>}
        {/* Preload the neighbours so arrows feel instant. */}
        {total > 1 && [items[(index + 1) % total]!, items[(index - 1 + total) % total]!].map(n => (
          <link key={n.id} rel="preload" as="image" href={photoUrl(n.id, "full", base)} imageSrcSet={srcSetFor(n, base) || undefined} imageSizes="100vw" />
        ))}
      </div>
      {info && (
        <aside className="gl-panel" aria-label="Photo details" hidden={!panel}>
          <h2>{title}</h2>
          <p className="gl-panel-sub">{info}</p>
          <p className="gl-panel-n">Photo {index + 1} of {total}</p>
          {v.caption ? <p>{v.caption}</p> : <p className="gl-panel-sub">No caption.</p>}
        </aside>
      )}
      {total > 1 && (
        <div className="gl-strip" ref={strip} role="group" aria-label="All photos">
          {items.map((p, i) => (
            <button key={p.id} type="button" data-i={i} className="gl-thumb" aria-current={i === index ? "true" : undefined}
              aria-label={`Show ${p.kind === "floorplan" ? "floor plan" : "photo"} ${i + 1} of ${total}`} onClick={() => show(i)}>
              <Img v={p} sizes="88px" alt="" />
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
 * Pannable 360 photo. The 2:1 panorama fills the viewer's height and wraps around sideways: drag or swipe, use the arrow
 * keys or the buttons. It drifts slowly until touched (not at all when the visitor prefers reduced motion).
 */
function PanoViewer({ pano, title }: { pano: PhotoView; title: string }) {
  const base = useContext(PhotoBase);
  const box = useRef<HTMLDivElement>(null);
  const [x, setX] = useState(0);
  const [drift, setDrift] = useState(true);
  const drag = useRef<{ x: number; from: number } | null>(null);
  const span = () => (box.current?.clientHeight ?? 400) * (pano.width / pano.height);
  const pan = (dx: number) => setX(v => v + dx);
  useEffect(() => {
    if (!drift || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setX(v => v - 0.6), 30);
    return () => clearInterval(t);
  }, [drift]);
  return (
    <div className="gl-pano">
      <div ref={box} className="gl-pano-view" role="img" tabIndex={0} aria-label={`360 photo: ${pano.alt || pano.caption || title}. Drag or use the arrow keys to look around.`}
        style={{ backgroundImage: `url(${photoUrl(pano.id, pano.sizes.includes("medium") ? "medium" : "full", base)})`, backgroundPosition: `${x % span()}px 50%` }}
        onPointerDown={e => { drag.current = { x: e.clientX, from: x }; setDrift(false); e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={e => { const d = drag.current; if (d) setX(d.from + (e.clientX - d.x)); }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
        onKeyDown={e => { if (e.key === "ArrowLeft") { e.preventDefault(); setDrift(false); pan(60); } else if (e.key === "ArrowRight") { e.preventDefault(); setDrift(false); pan(-60); } }} />
      <div className="gl-pano-bar">
        <button type="button" className="gl-tab" onClick={() => { setDrift(false); pan(160); }} aria-label="Look left">‹ Left</button>
        <button type="button" className="gl-tab" onClick={() => setDrift(d => !d)} aria-pressed={drift}>{drift ? "Pause" : "Auto turn"}</button>
        <button type="button" className="gl-tab" onClick={() => { setDrift(false); pan(-160); }} aria-label="Look right">Right ›</button>
        {pano.caption && <span className="gl-pano-cap">{pano.caption}</span>}
      </div>
    </div>
  );
}

/** Hosted 3D / 360 / video tour. Nothing loads from the tour host until the visitor presses the button. */
function TourFrame({ src, label, title, poster }: { src: string; label: string; title: string; poster?: PhotoView | undefined }) {
  const base = useContext(PhotoBase);
  const [on, setOn] = useState(false);
  return (
    <div className="gl-tourbox">
      {on
        ? <iframe className="gl-tourframe" src={src} title={`${label}: ${title}`} loading="lazy" referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-popups allow-presentation" allow="fullscreen; xr-spatial-tracking; gyroscope; accelerometer; autoplay" allowFullScreen />
        : (
          <button type="button" className="gl-tourstart" onClick={() => setOn(true)}
            style={poster ? { backgroundImage: `linear-gradient(rgba(0,0,0,.35), rgba(0,0,0,.35)), url(${photoUrl(poster.id, poster.sizes.includes("medium") ? "medium" : "full", base)})` } : undefined}>
            <span>Start {label.replace(/^(Video|Virtual)/, m => m.toLowerCase())}</span>
            <span className="gl-tourhint">Loads from the tour provider</span>
          </button>
        )}
    </div>
  );
}

/**
 * Public gallery of a listing: Photos, Floor plan and Video tabs, and a virtual tour link when the owner added one.
 * Public video files from the listing's documents play in the Video tab.
 */
export function ListingGallery({ listingId, title, highlights }: { listingId: string; title: string; highlights?: string }) {
  const [photos, setPhotos] = useState<PhotoView[] | null>(null);
  const [tourUrl, setTourUrl] = useState<string | null>(null);
  const [videos, setVideos] = useState<Media[]>([]);
  const [planPdfs, setPlanPdfs] = useState<{ id: string }[]>([]);
  const [tab, setTab] = useState<Tab>("photo");
  const [open, setOpen] = useState<number | null>(null);
  const [panoIdx, setPanoIdx] = useState(0);
  const [room, setRoom] = useState<string>("");
  const narrow = useNarrow();

  useEffect(() => {
    setPhotos(null);
    fetch(`/api/listings/${listingId}/photos`)
      .then(async r => (r.ok ? r.json() : { photos: [], tourUrl: null }))
      .then(d => { setPhotos(d.photos ?? []); setTourUrl(d.tourUrl ?? null); })
      .catch(() => setPhotos([]));
    fetch(`/api/listings/${listingId}/documents`)
      .then(async r => (r.ok ? (await r.json()).documents as { id: string; kind: string; visibility: string; status: string }[] : []))
      .then(all => {
        // Public floor plans that were uploaded as a PDF. They download only (the file route never renders them in our origin).
        setPlanPdfs(all.filter(d => d.visibility === "public" && d.status === "active" && d.kind === "floorplan").map(d => ({ id: d.id })));
        return all;
      })
      .then(all => setVideos(all.filter(d => d.visibility === "public" && d.status === "active" && (d.kind === "video" || d.kind === "video_360"))
        .map(d => ({ id: d.id, label: d.kind === "video" ? "Video" : "360 video" }))))
      .catch(() => { setVideos([]); setPlanPdfs([]); });
  }, [listingId]);

  if (photos === null) return <div className="gl-empty gl-loading" aria-hidden="true" />;
  const byKind = { photo: photos.filter(p => p.kind === "photo"), floorplan: photos.filter(p => p.kind === "floorplan"), photo360: photos.filter(p => p.kind === "photo360") };
  const tour = classifyTour(tourUrl);
  const framed = tour?.embedUrl !== undefined;
  const wantsVideo = tab === "video" && videos.length > 0, wantsTour = tab === "tour" && framed, wants360 = tab === "photo360" && byKind.photo360.length > 0;
  const all = byKind[tab === "floorplan" ? "floorplan" : "photo"].length ? byKind[tab === "floorplan" ? "floorplan" : "photo"] : byKind.photo.length ? byKind.photo : byKind.floorplan;
  const current: Tab = wantsVideo ? "video" : wantsTour ? "tour" : wants360 ? "photo360" : all === byKind.floorplan && byKind.floorplan.length ? "floorplan" : "photo";
  const rooms = current === "photo" ? categoriesIn(all) : [];
  const activeRoom = rooms.some(r => r.key === room) ? room : "";
  const items = activeRoom ? all.filter(p => p.category === activeRoom) : all;
  const tabs = ([["photo", "Photos"], ["floorplan", "Floor plan"], ["photo360", "360 photos"]] as const).filter(([k]) => byKind[k].length > 0);
  const allTabs: (readonly [Tab, string, number?])[] = [...tabs.map(([k, n]) => [k, n, byKind[k].length] as const), ...(framed ? [["tour", tour!.label] as const] : []), ...(videos.length ? [["video", "Video", videos.length] as const] : [])];
  const pano = byKind.photo360[Math.min(panoIdx, byKind.photo360.length - 1)];
  const label = current === "floorplan" ? (items.length === 1 ? "floor plan" : "floor plans") : items.length === 1 ? "photo" : "photos";

  return (
    <section className="gl" aria-label="Photos and plans">
      {current === "video" && videos[0]
        ? (
          <div className="gl-videobox">
            {videos.map(m => <video key={m.id} className="gl-video" controls preload="metadata" playsInline src={`/api/documents/${m.id}/file`} aria-label={`${m.label}: ${title}`} />)}
          </div>
        )
        : current === "tour" && tour?.embedUrl
        ? <TourFrame src={tour.embedUrl} label={tour.label} title={title} poster={byKind.photo[0]} />
        : current === "photo360" && pano
        ? (
          <>
            <PanoViewer key={pano.id} pano={pano} title={title} />
            {byKind.photo360.length > 1 && (
              <div className="gl-tabs" role="group" aria-label="Choose a room">
                {byKind.photo360.map((p, i) => <button key={p.id} type="button" className="gl-tab" aria-pressed={panoIdx === i} onClick={() => setPanoIdx(i)}>{p.caption || `Room ${i + 1}`}</button>)}
              </div>
            )}
          </>
        )
        : items.length === 0
        ? <div className="gl-empty" role="img" aria-label="No photos added yet"><span>No photos yet</span></div>
        : narrow
          ? <Carousel key={current + activeRoom} items={items} title={title} onOpen={setOpen} />
          : <HeroGrid key={current + activeRoom} items={items} title={title} onOpen={setOpen} label={label} />}
      {(allTabs.length > 1 || tourUrl) && (
        <div className="gl-tabs">
          {allTabs.length > 1 && (
            <div role="group" aria-label="Show">
              {allTabs.map(([k, name, n]) => (
                <button key={k} type="button" aria-pressed={current === k} className="gl-tab" onClick={() => setTab(k)}>
                  {name}{n !== undefined && <> <span className="gl-tab-n">{n}</span></>}
                </button>
              ))}
            </div>
          )}
          {tourUrl && !framed && <a className="gl-tab gl-link" href={tourUrl} target="_blank" rel="noopener noreferrer nofollow">{tour?.label ?? "Virtual tour"}<span className="sr-only"> (opens a new tab)</span></a>}
        </div>
      )}
      {(tour || byKind.photo360.length > 0) && (
        <p className="gl-elena">
          <button type="button" className="gl-tab" onClick={() => window.dispatchEvent(new CustomEvent(PRESENTER_SPEAK_EVENT, {
            detail: { text: tourSummary({ title, tour, rooms: byKind.photo360.map(p => p.caption).filter(Boolean), panoramas: byKind.photo360.length, highlights }) } }))}>
            Hear Elena describe this tour
          </button>
        </p>
      )}
      {rooms.length > 1 && (
        <div className="gl-tabs" role="group" aria-label="Filter photos by room">
          <button type="button" className="gl-tab" aria-pressed={activeRoom === ""} onClick={() => setRoom("")}>All <span className="gl-tab-n">{all.length}</span></button>
          {rooms.map(r => (
            <button key={r.key} type="button" className="gl-tab" aria-pressed={activeRoom === r.key} onClick={() => setRoom(r.key)}>{r.label} <span className="gl-tab-n">{r.count}</span></button>
          ))}
        </div>
      )}
      {planPdfs.length > 0 && (
        <ul className="gl-plandocs">
          {planPdfs.map((d, i) => (
            <li key={d.id} className="gl-plandoc">
              <span className="gl-plandoc-icon" aria-hidden="true">PDF</span>
              <span className="gl-plandoc-text"><strong>Floor plan{planPdfs.length > 1 ? ` ${i + 1}` : ""}</strong><span className="muted">PDF document</span></span>
              <a className="gl-tab gl-link" href={`/api/documents/${d.id}/file`}>Open<span className="sr-only"> floor plan PDF{planPdfs.length > 1 ? ` ${i + 1}` : ""} (downloads the file)</span></a>
            </li>
          ))}
        </ul>
      )}
      {open !== null && items[open] && <Lightbox items={items} index={open} title={title} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** Full-screen viewer alone, for pages that have their own carousel (investor project page). */
export function PhotoViewer({ photos, title, base, start, onClose }: { photos: PhotoView[]; title: string; base: string; start: number; onClose: () => void }) {
  const [at, setAt] = useState(start);
  if (!photos[at]) return null;
  return (
    <PhotoBase.Provider value={base}>
      <div className="gl"><Lightbox items={photos} index={at} title={title} onIndex={setAt} onClose={onClose} /></div>
    </PhotoBase.Provider>
  );
}

/**
 * Gallery for photos the caller already has (investor projects): hero grid on wide screens, swipe carousel on phones,
 * and the sliding full-screen viewer with a details panel. `base` is the route the images are served from.
 */
export function PhotoGallery({ photos, title, base, info, compact }: { photos: PhotoView[]; title: string; base: string; info?: string; compact?: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  const narrow = useNarrow();
  if (photos.length === 0) return null;
  return (
    <PhotoBase.Provider value={base}>
      <section className={compact ? "gl gl-compact" : "gl"} aria-label="Photos">
        {compact ? (
          <ul className="gl-mini">
            {photos.map((v, i) => (
              <li key={v.id}>
                <button type="button" className="gl-mini-btn" onClick={() => setOpen(i)} aria-label={`Open ${altFor(v, i, photos.length, title)} full screen`}>
                  <Img v={v} sizes="160px" alt="" />
                  {v.hidden && <span className="gl-badge">Hidden</span>}
                  {i === photos.findIndex(x => !x.hidden) && <span className="gl-badge is-cover">Cover</span>}
                </button>
              </li>
            ))}
          </ul>
        ) : narrow
          ? <Carousel items={photos} title={title} onOpen={setOpen} />
          : <HeroGrid items={photos} title={title} onOpen={setOpen} label={photos.length === 1 ? "photo" : "photos"} />}
        {open !== null && photos[open] && <Lightbox items={photos} index={open} title={title} onIndex={setOpen} onClose={() => setOpen(null)} info={info} />}
      </section>
    </PhotoBase.Provider>
  );
}
