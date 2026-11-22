"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { classifyTour } from "../../src/domain/virtual-tour";
import { FEATURE_LIMITS, PHOTO_BASE, PHOTO_CATEGORIES, PHOTO_LIMITS, PROFANITY_MESSAGE, PROJECT_PHOTO_MAX, findProfanity, isPhotoCategory, makeCover, moveEntry, photoUrl, type PhotoKind, type PhotoView } from "../../src/domain/listing-photos";
import { HASH_COLS, HASH_ROWS, dHash, findDuplicates } from "../../src/domain/photo-duplicates";
import { JSON_HEADERS } from "./ui";
import { shrinkImage } from "./shrink-image";
import "../styles/gallery.css";

type Gallery = { photos: PhotoView[]; tourUrl: string | null; version: number; canManage: boolean; canUpload: boolean; everPublished: boolean; editable: boolean };
type Row = PhotoView;
type Suggestion = { photoId: string; caption: string; features: string[] };
type QueueItem = { name: string; state: "waiting" | "uploading" | "done" | "error"; message?: string };

const TYPES = ["image/jpeg", "image/png", "image/webp"];
const MB = PHOTO_LIMITS.maxBytes / 1_000_000;

/** Checks a file in the browser before sending it (the server checks again from the bytes). */
function precheck(f: File): string | null {
  if (!TYPES.includes(f.type)) return "Only JPEG, PNG or WebP images.";
  if (f.size > PHOTO_LIMITS.maxBytes) return `Larger than ${MB} MB.`;
  if (f.size === 0) return "Empty file.";
  return null;
}

/** Loads an image from our own origin and returns its difference hash, or null if it cannot be read. */
function hashImage(url: string): Promise<string | null> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = HASH_COLS; c.height = HASH_ROWS;
        const g = c.getContext("2d", { willReadFrequently: true });
        if (!g) return resolve(null);
        g.drawImage(img, 0, 0, HASH_COLS, HASH_ROWS);
        const px = g.getImageData(0, 0, HASH_COLS, HASH_ROWS).data;
        const grey: number[] = [];
        for (let i = 0; i < px.length; i += 4) grey.push(px[i]! * 0.299 + px[i + 1]! * 0.587 + px[i + 2]! * 0.114);
        resolve(dHash(grey));
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function errorOf(r: Response): Promise<string> {
  if (r.status === 413) return "That photo is too large to upload.";
  if (r.status === 401) return "Sign in again to continue.";
  if (r.status === 503) return "Photo upload is not available yet.";
  try { return (await r.json()).error ?? "Upload failed."; } catch { return "Upload failed."; }
}

/**
 * Owner screen for a listing's photos and floor plans: drag-and-drop multi-file upload, reorder (drag, or the up/down
 * buttons), make cover, caption and description per photo, hide, replace, and remove (drafts only), then one Save.
 * With `projectId` it manages an investor project's photos instead: photos only, no tour link, never removable.
 */
export function PhotoManager({ listingId, projectId }: { listingId?: string; projectId?: string }) {
  const isProject = projectId !== undefined;
  const listUrl = isProject ? `/api/investments/projects/${projectId}/photos` : `/api/listings/${listingId}/photos`;
  const layoutUrl = isProject ? listUrl : `${listUrl}/layout`;
  const base = isProject ? "/api/investments/photos" : PHOTO_BASE;
  const noun = isProject ? "project" : "listing";
  const [data, setData] = useState<Gallery | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [tour, setTour] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<PhotoKind>("photo");
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [over, setOver] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const touchFrom = useRef<number | null>(null);

  /** Touch and pen reordering: press the Drag handle, slide over another photo, release. (Mouse uses native drag.) */
  const overIndex = (e: React.PointerEvent): number | null => {
    const li = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("li[data-i]");
    return li ? Number(li.dataset["i"]) : null;
  };
  /** Photos whose text the owner has checked (left a field) and photos where they chose to post flagged wording anyway. */
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [allowed, setAllowed] = useState<ReadonlySet<string>>(new Set());
  const [elena, setElena] = useState<{ busy: boolean; message: string; items: Suggestion[]; label: string }>({ busy: false, message: "", items: [], label: "" });

  const [hashes, setHashes] = useState<Record<string, string | null>>({});
  const [kept, setKept] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const r = await fetch(listUrl);
      if (!r.ok) { setLoadError(r.status === 404 ? `${isProject ? "Project" : "Listing"} not found. If it is yours, sign in first.` : await errorOf(r)); return; }
      const raw = await r.json();
      const d: Gallery = isProject ? { ...raw, tourUrl: null, canUpload: raw.canManage === true, everPublished: true, editable: raw.canManage === true } : raw;
      setData(d); setRows(d.photos); setTour(d.tourUrl ?? ""); setDirty(false);
    } catch {
      setLoadError("Could not load the photos.");
    }
  }, [listUrl, isProject]);
  useEffect(() => { void load(); }, [load]);

  // Fingerprint each photo in the browser so repeats are flagged as soon as they appear (before Elena writes captions).
  useEffect(() => {
    if (isProject) return;
    let live = true;
    const todo = rows.filter(r => r.kind === "photo" && !(r.id in hashes));
    if (todo.length === 0) return;
    void Promise.all(todo.map(async r => [r.id, await hashImage(photoUrl(r.id, r.sizes.includes("thumb") ? "thumb" : "full", base))] as const))
      .then(done => { if (live) setHashes(h => ({ ...h, ...Object.fromEntries(done) })); });
    return () => { live = false; };
  }, [rows, hashes, base, isProject]);
  const dupes = findDuplicates(rows.filter(r => r.kind === "photo" && !r.hidden).map(r => ({ id: r.id, hash: hashes[r.id] ?? null })))
    .filter(d => !kept.includes(d.second));
  const roomLabel = (r: Row) => PHOTO_CATEGORIES.find(c => c.key === r.category)?.label;

  const change = (next: Row[]) => { setRows(next); setDirty(true); setStatus(""); };
  const flagged = (r: Row): boolean => findProfanity([r.caption, r.alt, ...r.features].join(" . ")).length > 0;
  /** aria-invalid for one field: only the field that holds the flagged wording, once the owner has left the photo's fields. */
  const shown = (r: Row, text: string) => (checked.has(r.id) && !allowed.has(r.id) && findProfanity(text).length > 0 ? true : undefined);
  const markChecked = (id: string) => setChecked(prev => new Set(prev).add(id));
  const patch = (i: number, p: Partial<Row>) => change(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const move = (from: number, to: number) => {
    change(moveEntry(rows, from, to));
    setStatus(`Moved to position ${to + 1} of ${rows.length}.`);
  };

  async function upload(files: File[], replacesId?: string) {
    if (!data?.canUpload || files.length === 0) return;
    if (dirty) { setError("Save or undo your changes before adding photos."); return; }
    setError("");
    const showing = rows.filter(r => !r.hidden && r.kind === kind).length;
    const room = (isProject ? PROJECT_PHOTO_MAX : kind === "photo" ? PHOTO_LIMITS.maxPhotos : kind === "photo360" ? PHOTO_LIMITS.max360 : PHOTO_LIMITS.maxFloorplans) - showing;
    const items: QueueItem[] = files.map((f, i) => {
      const bad = precheck(f);
      if (bad) return { name: f.name, state: "error", message: bad };
      if (!replacesId && i >= room) return { name: f.name, state: "error", message: `Over the limit for this ${noun}.` };
      return { name: f.name, state: "waiting" };
    });
    setQueue(items);
    setBusy(true);
    const set = (i: number, q: Partial<QueueItem>) => setQueue(prev => prev.map((x, j) => (j === i ? { ...x, ...q } : x)));
    let ok = 0, off = false;
    for (let i = 0; i < files.length; i++) {
      if (items[i]!.state === "error") continue;
      if (off) { set(i, { state: "error", message: "Not added: uploads are not available yet." }); continue; }
      set(i, { state: "uploading" });
      const fd = new FormData();
      fd.set("file", await shrinkImage(files[i]!));
      fd.set("kind", replacesId ? (rows.find(r => r.id === replacesId)?.kind ?? kind) : kind);
      if (replacesId) fd.set("replacesId", replacesId);
      try {
        const r = await fetch(listUrl, { method: "POST", body: fd });
        if (r.ok) { ok++; set(i, { state: "done" }); } else { off = r.status === 503; set(i, { state: "error", message: await errorOf(r) }); }
      } catch {
        set(i, { state: "error", message: "Network error." });
      }
    }
    setBusy(false);
    setStatus(ok ? `${ok} ${ok === 1 ? "image" : "images"} added.` : "");
    await load();
  }

  /** Asks Elena for captions and feature tags. Suggestions are shown for review; nothing changes until the owner applies them. */
  async function askElena() {
    if (!listingId) return;
    if (dupes.length > 0) { setElena({ busy: false, message: "Fix or keep the repeated photos below first, then ask Elena again.", items: [], label: "" }); return; }
    const sendable = rows.filter(r => r.kind === "photo" && !r.hidden).slice(0, 12);
    setElena({ busy: true, message: "", items: [], label: "" });
    try {
      const r = await fetch(`${listUrl}/suggest`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ photos: sendable.map(p => ({ photoId: p.id, category: p.category || undefined, note: p.alt || undefined })) }) });
      if (!r.ok) { setElena({ busy: false, message: r.status === 429 ? "Too many requests. Try again later." : await errorOf(r), items: [], label: "" }); return; }
      const d = await r.json();
      if (d.state !== "ready") { setElena({ busy: false, message: d.message ?? "Elena is unavailable right now.", items: [], label: "" }); return; }
      const skipped = (d.skipped ?? []).length;
      setElena({ busy: false, items: d.suggestions, label: d.label, message: skipped ? `${skipped} ${skipped === 1 ? "photo was" : "photos were"} skipped: choose a room or add a description first.` : "" });
    } catch {
      setElena({ busy: false, message: "Could not reach Elena. Try again.", items: [], label: "" });
    }
  }
  const apply = (items: Suggestion[]) => {
    change(rows.map(r => { const s = items.find(x => x.photoId === r.id); return s ? { ...r, caption: s.caption, features: s.features, alt: r.alt || s.caption } : r; }));
    setElena(e => ({ ...e, items: e.items.filter(x => !items.includes(x)) }));
    setStatus(`${items.length} ${items.length === 1 ? "suggestion" : "suggestions"} applied. Check them, then save.`);
  };

  async function save() {
    if (!data) return;
    const blocked = rows.filter(r => flagged(r) && !allowed.has(r.id));
    if (blocked.length) {
      setChecked(prev => new Set([...prev, ...blocked.map(r => r.id)]));
      setError(`${PROFANITY_MESSAGE} (${blocked.map(r => `photo ${rows.indexOf(r) + 1}`).join(", ")})`);
      return;
    }
    setBusy(true); setError(""); setStatus("");
    try {
      const entries = rows.map(r => ({ photoId: r.id, caption: r.caption, alt: r.alt, hidden: r.hidden, ...(isProject ? {} : { category: r.category, features: r.features }) }));
      const override = rows.some(r => flagged(r)) ? { allowFlagged: true } : {};
      const body = isProject ? { version: data.version, entries, ...override } : { version: data.version, tourUrl: tour.trim() || null, entries, ...override };
      const r = await fetch(layoutUrl, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) });
      if (r.ok) {
        const review = isProject && (await r.json().catch(() => ({}))).backToReview === true;
        await load();
        setStatus(review ? "Gallery saved. The project is back with staff for review." : "Gallery saved.");
      } else setError(await errorOf(r));
    } catch {
      setError("Could not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <p role="alert">{loadError}</p>;
  if (!data) return <p className="muted" role="status">Loading photos...</p>;
  const manage = data.canManage;
  const coverId = rows.find(r => !r.hidden && r.kind === "photo")?.id;
  const counts = { photo: rows.filter(r => !r.hidden && r.kind === "photo").length, floorplan: rows.filter(r => !r.hidden && r.kind === "floorplan").length };

  return (
    <section className="gl-mgr" aria-labelledby="gl-mgr-h">
      <h2 id="gl-mgr-h">{isProject ? "Gallery" : "Photos and floor plans"}</h2>
      <p className="muted">
        {isProject ? `${counts.photo} of ${PROJECT_PHOTO_MAX} photos.` : `${counts.photo} of ${PHOTO_LIMITS.maxPhotos} photos, ${counts.floorplan} of ${PHOTO_LIMITS.maxFloorplans} floor plans, ${rows.filter(r => !r.hidden && r.kind === "photo360").length} of ${PHOTO_LIMITS.max360} 360 photos.`} JPEG, PNG or WebP, up to {MB} MB each. Animated WebP is saved as a single still frame.
        Location and camera details are removed from every image. The first photo is the cover.
      </p>
      {isProject && <p className="muted">Photos are shown only to investors who can see the full project. They are kept on record: you can hide, reorder or replace them, but not delete them. Any change except hiding sends an approved project back to staff review.</p>}
      {data.everPublished && !isProject && <p className="muted">This listing has been published, so its photos are kept on record: you can hide, reorder or replace them, but not delete them.</p>}
      {!data.editable && !isProject && <p role="status">This listing is withdrawn. Its photos can no longer be changed.</p>}

      {data.canUpload && (
        <div className={over ? "gl-drop is-over" : "gl-drop"}
          onDragOver={e => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } }}
          onDragLeave={() => setOver(false)}
          onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); setOver(false); void upload(Array.from(e.dataTransfer.files)); } }}>
          <p><strong>Drag images here</strong> or choose them from your device.</p>
          <div className="form-bar">
            {!isProject && (
              <>
                <label className="sr-only" htmlFor="gl-kind">Add as</label>
                <select id="gl-kind" value={kind} onChange={e => setKind(e.target.value as PhotoKind)} disabled={busy}>
                  <option value="photo">Photos</option>
                  <option value="floorplan">Floor plans</option>
                  <option value="photo360">360 photos (2:1 panorama)</option>
                </select>
              </>
            )}
            <input ref={input} id="gl-files" className="sr-only gl-file" type="file" multiple accept="image/jpeg,image/png,image/webp" disabled={busy}
              onChange={e => { const f = Array.from(e.target.files ?? []); e.target.value = ""; void upload(f); }} />
            <label className="button" htmlFor="gl-files">Choose images</label>
          </div>
          {queue.length > 0 && (
            <ul className="gl-queue" aria-live="polite">
              {queue.map((q, i) => (
                <li key={i} className={q.state === "error" ? "is-error" : q.state === "done" ? "is-done" : undefined}>
                  {q.name}: {q.state === "waiting" ? "waiting" : q.state === "uploading" ? "uploading..." : q.state === "done" ? "added" : q.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {manage && !isProject && counts.photo > 0 && (
        <div className="gl-elena">
          <div className="form-bar">
            <button type="button" className="secondary" onClick={() => void askElena()} disabled={busy || elena.busy}>{elena.busy ? "Elena is thinking..." : "Ask Elena for captions"}</button>
            <span className="muted">Elena can't see your photos. She writes from the room and description you give each one, so choose a room first.</span>
          </div>
          {dupes.length > 0 && (
            <div role="alert" className="gl-dupes">
              <p><strong>{dupes.length === 1 ? "A photo looks repeated." : `${dupes.length} photos look repeated.`}</strong> Using the same shot twice makes the gallery look padded.</p>
              <ul className="gl-sugg">
                {dupes.map(d => {
                  const a = rows.findIndex(r => r.id === d.first), b = rows.findIndex(r => r.id === d.second);
                  const room = rows[a] && roomLabel(rows[a]!);
                  return (
                    <li key={d.second}>
                      <span>Photo {b + 1} {d.exact ? "is the same as" : "looks like"} photo {a + 1}{room ? ` (${room})` : ""}. Use a different photo for this room.</span>
                      <button type="button" className="secondary" disabled={busy} onClick={() => { patch(b, { hidden: true }); setStatus(`Photo ${b + 1} hidden. Save to apply.`); }}>Hide photo {b + 1}</button>
                      {!data.everPublished && <button type="button" className="secondary" disabled={busy} onClick={() => { change(rows.filter(x => x.id !== d.second)); }}>Remove photo {b + 1}</button>}
                      <button type="button" className="secondary" onClick={() => setKept(k => [...k, d.second])}>Keep both</button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {elena.message && <p role="status">{elena.message}</p>}
          {elena.items.length > 0 && (
            <div aria-live="polite">
              <p className="muted">{elena.label}</p>
              <ul className="gl-sugg">
                {elena.items.map(sg => {
                  const n = rows.findIndex(r => r.id === sg.photoId) + 1;
                  return (
                    <li key={sg.photoId}>
                      <strong>Photo {n}:</strong> {sg.caption}
                      {sg.features.length > 0 && <span className="gl-feats">{sg.features.map(f => <span key={f} className="gl-feat">{f}</span>)}</span>}
                      <button type="button" className="secondary" onClick={() => apply([sg])} aria-label={`Use suggestion for photo ${n}`}>Use</button>
                    </li>
                  );
                })}
              </ul>
              <div className="form-bar">
                <button type="button" onClick={() => apply(elena.items)}>Use all</button>
                <button type="button" className="secondary" onClick={() => setElena(e => ({ ...e, items: [] }))}>Dismiss</button>
              </div>
            </div>
          )}
        </div>
      )}

      {rows.length === 0 ? <p className="muted">No photos yet.</p> : (
        <ol className="gl-list" aria-label="Gallery order">
          {rows.map((r, i) => {
            const label = `${r.kind === "floorplan" ? "Floor plan" : r.kind === "photo360" ? "360 photo" : "Photo"} ${i + 1}`;
            return (
              <li key={r.id} data-i={i} className={["gl-item", r.hidden && "is-hidden", drag === i && "is-dragging", target === i && drag !== i && "is-target"].filter(Boolean).join(" ")}
                draggable={manage} onDragStart={e => { setDrag(i); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", r.id); }}
                onDragOver={e => { if (drag !== null) { e.preventDefault(); setTarget(i); } }}
                onDrop={e => { if (drag !== null) { e.preventDefault(); move(drag, i); } setDrag(null); setTarget(null); }}
                onDragEnd={() => { setDrag(null); setTarget(null); }}>
                <div className="gl-thumbwrap">
                  <img src={photoUrl(r.id, r.sizes.includes("thumb") ? "thumb" : "full", base)} alt={r.alt || r.caption || label} loading="lazy" width={r.width} height={r.height}
                    className={r.kind === "floorplan" ? "gl-plan" : undefined} draggable={false} />
                  <span className="gl-badges">
                    <span className="gl-badge">{i + 1}</span>
                    {r.id === coverId && <span className="gl-badge is-cover">Cover</span>}
                    {r.kind === "floorplan" && <span className="gl-badge">Floor plan</span>}
                    {r.kind === "photo360" && <span className="gl-badge">360</span>}
                    {r.category && <span className="gl-badge">{PHOTO_CATEGORIES.find(c => c.key === r.category)?.label}</span>}
                    {r.hidden && <span className="gl-badge">Hidden</span>}
                  </span>
                </div>
                {manage && (
                  <>
                    {!isProject && r.kind === "photo" && (
                      <label>Room
                        <select value={r.category} onChange={e => patch(i, { category: isPhotoCategory(e.target.value) ? e.target.value : "" })}>
                          <option value="">Not sorted yet</option>
                          {PHOTO_CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                        </select>
                      </label>
                    )}
                    <label>Caption (shown under the photo)
                      <input value={r.caption} maxLength={PHOTO_LIMITS.captionMax} onChange={e => patch(i, { caption: e.target.value })} onBlur={() => markChecked(r.id)} aria-invalid={shown(r, r.caption)} placeholder="e.g. Kitchen with stone benchtop" />
                    </label>
                    <label>Description for screen readers
                      <input value={r.alt} maxLength={PHOTO_LIMITS.altMax} onChange={e => patch(i, { alt: e.target.value })} onBlur={() => markChecked(r.id)} aria-invalid={shown(r, r.alt)} placeholder="What the photo shows" />
                    </label>
                    {!isProject && r.kind === "photo" && (
                      <label>Features (comma separated, up to {FEATURE_LIMITS.maxPerPhoto})
                        <input defaultValue={r.features.join(", ")} key={`${r.id}:${r.features.join("|")}`} maxLength={FEATURE_LIMITS.maxPerPhoto * (FEATURE_LIMITS.maxChars + 2)} placeholder="e.g. stone benchtop, gas cooktop"
                          onChange={() => setDirty(true)} onBlur={e => { patch(i, { features: e.target.value.split(",").map(x => x.trim()).filter(Boolean).slice(0, FEATURE_LIMITS.maxPerPhoto) }); markChecked(r.id); }} />
                      </label>
                    )}
                    {checked.has(r.id) && flagged(r) && (
                      allowed.has(r.id)
                        ? <p className="muted" role="status">Posting this wording anyway. <button type="button" className="secondary" onClick={() => setAllowed(prev => { const n = new Set(prev); n.delete(r.id); return n; })}>Undo</button></p>
                        : (
                          <p className="gl-warn" role="alert">{PROFANITY_MESSAGE}{" "}
                            <button type="button" className="secondary" onClick={() => setAllowed(prev => new Set(prev).add(r.id))}>Post anyway (for example a product or street name)</button>
                          </p>
                        )
                    )}
                    <div className="gl-tools">
                      <button type="button" className="secondary gl-handle" disabled={busy} aria-label={`Drag ${label} to reorder (touch)`} aria-hidden="true" tabIndex={-1}
                        onPointerDown={e => { if (e.pointerType === "mouse") return; touchFrom.current = i; setDrag(i); e.currentTarget.setPointerCapture(e.pointerId); }}
                        onPointerMove={e => { if (touchFrom.current !== null) setTarget(overIndex(e)); }}
                        onPointerUp={e => { const from = touchFrom.current, to = overIndex(e); touchFrom.current = null; if (from !== null && to !== null && to !== from) move(from, to); setDrag(null); setTarget(null); }}
                        onPointerCancel={() => { touchFrom.current = null; setDrag(null); setTarget(null); }}>Drag</button>
                      <button type="button" className="secondary" disabled={busy || i === 0} onClick={() => move(i, i - 1)} aria-label={`Move ${label} up`}>Up</button>
                      <button type="button" className="secondary" disabled={busy || i === rows.length - 1} onClick={() => move(i, i + 1)} aria-label={`Move ${label} down`}>Down</button>
                      {r.kind === "photo" && !r.hidden && r.id !== coverId && (
                        <button type="button" className="secondary" disabled={busy} onClick={() => { change(makeCover(rows, x => x.id === r.id)); setStatus(`${label} is now the cover.`); }}>Make cover</button>
                      )}
                      <button type="button" className="secondary" disabled={busy} onClick={() => patch(i, { hidden: !r.hidden })} aria-label={`${r.hidden ? "Show" : "Hide"} ${label}`}>{r.hidden ? "Show" : "Hide"}</button>
                      {!r.hidden && data.canUpload && (
                        <label className="button secondary" aria-label={`Replace ${label}`}>Replace
                          <input type="file" className="sr-only" accept="image/jpeg,image/png,image/webp" disabled={busy || dirty}
                            onChange={e => { const f = Array.from(e.target.files ?? []).slice(0, 1); e.target.value = ""; void upload(f, r.id); }} />
                        </label>
                      )}
                      {!data.everPublished && (
                        <button type="button" className="secondary" disabled={busy} aria-label={`Remove ${label}`}
                          onClick={() => { if (window.confirm(`Remove ${label} from this draft?`)) change(rows.filter(x => x.id !== r.id)); }}>Remove</button>
                      )}
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {manage && !isProject && (
        <div className="stack gl-tour">
          <label>3D tour, video or virtual tour link (optional)
            <input type="url" inputMode="url" placeholder="https://my.matterport.com/show/?m=..." maxLength={PHOTO_LIMITS.tourUrlMax} value={tour} onChange={e => { setTour(e.target.value); setDirty(true); }} aria-describedby="gl-tour-hint" />
          </label>
          <p id="gl-tour-hint" className="muted">
            {(() => {
              const t = classifyTour(tour.trim());
              if (!tour.trim()) return "Matterport, Kuula, YouTube and Vimeo links play right on your listing. Any other https link opens in a new tab.";
              if (!t) return "Use a full https:// address.";
              return t.embedUrl ? `Recognised as a ${t.label}. It will play on your listing page.` : "This link will open in a new tab. It cannot play on the page.";
            })()}
          </p>
        </div>
      )}
      {manage && (
        <div className="gl-savebar">
          <button type="button" onClick={save} disabled={busy || !dirty}>Save gallery</button>
          <button type="button" className="secondary" onClick={() => void load()} disabled={busy || !dirty}>Undo changes</button>
          <p role="status" aria-live="polite">{status || (dirty ? "You have unsaved changes." : "")}</p>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
