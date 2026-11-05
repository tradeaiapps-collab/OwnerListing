"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { classifyTour } from "../../src/domain/virtual-tour";
import { PHOTO_BASE, PHOTO_LIMITS, PROJECT_PHOTO_MAX, makeCover, moveEntry, photoUrl, type PhotoKind, type PhotoView } from "../../src/domain/listing-photos";
import { JSON_HEADERS } from "./ui";
import "../styles/gallery.css";

type Gallery = { photos: PhotoView[]; tourUrl: string | null; version: number; canManage: boolean; canUpload: boolean; everPublished: boolean; editable: boolean };
type Row = PhotoView;
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

async function errorOf(r: Response): Promise<string> {
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

  const change = (next: Row[]) => { setRows(next); setDirty(true); setStatus(""); };
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
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      if (items[i]!.state === "error") continue;
      set(i, { state: "uploading" });
      const fd = new FormData();
      fd.set("file", files[i]!);
      fd.set("kind", replacesId ? (rows.find(r => r.id === replacesId)?.kind ?? kind) : kind);
      if (replacesId) fd.set("replacesId", replacesId);
      try {
        const r = await fetch(listUrl, { method: "POST", body: fd });
        if (r.ok) { ok++; set(i, { state: "done" }); } else set(i, { state: "error", message: await errorOf(r) });
      } catch {
        set(i, { state: "error", message: "Network error." });
      }
    }
    setBusy(false);
    setStatus(ok ? `${ok} ${ok === 1 ? "image" : "images"} added.` : "");
    await load();
  }

  async function save() {
    if (!data) return;
    setBusy(true); setError(""); setStatus("");
    try {
      const entries = rows.map(r => ({ photoId: r.id, caption: r.caption, alt: r.alt, hidden: r.hidden }));
      const body = isProject ? { version: data.version, entries } : { version: data.version, tourUrl: tour.trim() || null, entries };
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
        {isProject ? `${counts.photo} of ${PROJECT_PHOTO_MAX} photos.` : `${counts.photo} of ${PHOTO_LIMITS.maxPhotos} photos, ${counts.floorplan} of ${PHOTO_LIMITS.maxFloorplans} floor plans, ${rows.filter(r => !r.hidden && r.kind === "photo360").length} of ${PHOTO_LIMITS.max360} 360 photos.`} JPEG, PNG or WebP, up to {MB} MB each.
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

      {rows.length === 0 ? <p className="muted">No photos yet.</p> : (
        <ol className="gl-list" aria-label="Gallery order">
          {rows.map((r, i) => {
            const label = `${r.kind === "floorplan" ? "Floor plan" : r.kind === "photo360" ? "360 photo" : "Photo"} ${i + 1}`;
            return (
              <li key={r.id} className={["gl-item", r.hidden && "is-hidden", drag === i && "is-dragging", target === i && drag !== i && "is-target"].filter(Boolean).join(" ")}
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
                    {r.hidden && <span className="gl-badge">Hidden</span>}
                  </span>
                </div>
                {manage && (
                  <>
                    <label>Caption (shown under the photo)
                      <input value={r.caption} maxLength={PHOTO_LIMITS.captionMax} onChange={e => patch(i, { caption: e.target.value })} placeholder="e.g. Kitchen with stone benchtop" />
                    </label>
                    <label>Description for screen readers
                      <input value={r.alt} maxLength={PHOTO_LIMITS.altMax} onChange={e => patch(i, { alt: e.target.value })} placeholder="What the photo shows" />
                    </label>
                    <div className="gl-tools">
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
