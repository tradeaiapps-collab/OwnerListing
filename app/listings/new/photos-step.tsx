"use client";
import { useEffect, useRef, useState } from "react";
import { PHOTO_LIMITS } from "../../../src/domain/listing-photos";
import { skippedNote, splitDuplicates } from "../../../src/domain/file-dedupe";
import { PLAN_MIMES, PLAN_PDF_MAX_BYTES, planProblem } from "../../../src/domain/plan-file";
import { Thumb, problem, type QuickFiles } from "../quick-setup";

const TYPES = ["image/jpeg", "image/png", "image/webp"];
const MB = PHOTO_LIMITS.maxBytes / 1_000_000;

const digests = new WeakMap<File, string>();
/** SHA-256 of the file's bytes, cached per file. Falls back to the name and date where the browser has no crypto.subtle. */
async function digestOf(f: File): Promise<string> {
  const known = digests.get(f); if (known) return known;
  let d: string;
  try { d = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await f.arrayBuffer()))).map(b => b.toString(16).padStart(2, "0")).join(""); }
  catch { d = `${f.name}:${f.lastModified}`; }
  digests.set(f, d); return d;
}
const identify = async (f: File) => ({ file: f, name: f.name, size: f.size, digest: await digestOf(f) });

/** Preview of the site plan: a thumbnail for an image; for a PDF a card with a PDF mark and a link that opens the local file in a new tab. */
function PlanPreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState("");
  const isImage = file.type.startsWith("image/");
  useEffect(() => { const u = URL.createObjectURL(file); setUrl(u); return () => URL.revokeObjectURL(u); }, [file, isImage]);
  return (
    <div className="qs-plan" role="status">
      <div className="qs-plan-pic">{isImage ? (url && <img src={url} alt={`Site plan: ${file.name}`} />) : <span aria-hidden="true">PDF</span>}</div>
      <div className="qs-plan-info"><strong>{isImage ? "Site plan" : "Site plan (PDF)"}</strong><span className="muted">{file.name}</span>
        {!isImage && url && <a href={url} target="_blank" rel="noopener noreferrer">Open PDF<span className="sr-only"> (opens a new tab)</span></a>}</div>
      <button type="button" className="secondary" onClick={onRemove}>Remove</button>
    </div>
  );
}

/** Photos and the plan are held here and sent to the draft when it is saved on the last step. */
export function PhotosStep({ files, onChange }: { files: QuickFiles; onChange: (f: QuickFiles) => void }) {
  const [error, setError] = useState("");
  const photoInput = useRef<HTMLInputElement>(null);
  const planInput = useRef<HTMLInputElement>(null);

  async function addPhotos(list: FileList | null) {
    const errs: string[] = [], ok: File[] = [];
    for (const f of Array.from(list ?? [])) { const p = problem(f); if (p) errs.push(p); else ok.push(f); }
    const held = await Promise.all(files.photos.map(identify));
    const { fresh, skipped } = splitDuplicates(held, await Promise.all(ok.map(identify)));
    const room = PHOTO_LIMITS.maxPhotos - files.photos.length;
    if (fresh.length > room) errs.push(`Only ${PHOTO_LIMITS.maxPhotos} photos fit on a listing; the extra ${fresh.length - room} were left out.`);
    const note = skippedNote(skipped);
    if (note) errs.push(note);
    onChange({ ...files, photos: [...files.photos, ...fresh.slice(0, Math.max(0, room)).map(x => x.file)] });
    setError(errs.join(" "));
  }
  async function setPlan(list: FileList | null) {
    const f = list?.[0];
    if (!f) return;
    const p = planProblem(f, new Uint8Array(await f.slice(0, 12).arrayBuffer()));
    if (p) { setError(p); return; }
    setError(""); onChange({ ...files, plan: f });
  }

  return (
    <fieldset className="form-section">
      <legend>Photos</legend>
      <p className="muted">JPEG, PNG or WebP, up to {MB} MB each (animated WebP is saved as one still frame). The site or floor plan can also be a PDF, up to {PLAN_PDF_MAX_BYTES / 1_000_000} MB. Photos are optional now and are added to your draft when you save it on the last step. The first photo is the cover.</p>
      <input ref={photoInput} type="file" accept={TYPES.join(",")} multiple hidden onChange={e => { void addPhotos(e.target.files); e.target.value = ""; }} aria-label="Choose photos" />
      <div className="form-bar">
        <button type="button" className="secondary" onClick={() => photoInput.current?.click()}>Choose photos</button>
        <button type="button" className="secondary" onClick={() => planInput.current?.click()}>{files.plan ? "Change site plan" : "Add site plan"}</button>
      </div>
      <input ref={planInput} type="file" accept={PLAN_MIMES.join(",")} hidden onChange={e => { void setPlan(e.target.files); e.target.value = ""; }} aria-label="Choose site plan" />
      {error && <p role="alert">{error}</p>}
      {files.photos.length > 0
        ? <>
            <p role="status" className="muted">{files.photos.length} {files.photos.length === 1 ? "photo" : "photos"} ready.</p>
            <ul className="qs-thumbs">{files.photos.map((f, i) => <Thumb key={`${f.name}-${f.size}-${i}`} file={f} onRemove={() => onChange({ ...files, photos: files.photos.filter((_, j) => j !== i) })} />)}</ul>
          </>
        : <p className="wiz-empty muted">No photos yet. Listings with photos get far more enquiries, but you can skip this step.</p>}
      {files.plan && <PlanPreview file={files.plan} onRemove={() => onChange({ ...files, plan: null })} />}
    </fieldset>
  );
}
