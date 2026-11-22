"use client";
import { useRef, useState } from "react";
import { PHOTO_LIMITS } from "../../../src/domain/listing-photos";
import { Thumb, problem, type QuickFiles } from "../quick-setup";

const TYPES = ["image/jpeg", "image/png", "image/webp"];
const MB = PHOTO_LIMITS.maxBytes / 1_000_000;

/** Photos and the plan are held here and sent to the draft when it is saved on the last step. */
export function PhotosStep({ files, onChange }: { files: QuickFiles; onChange: (f: QuickFiles) => void }) {
  const [error, setError] = useState("");
  const photoInput = useRef<HTMLInputElement>(null);
  const planInput = useRef<HTMLInputElement>(null);

  function addPhotos(list: FileList | null) {
    const errs: string[] = [], ok: File[] = [];
    for (const f of Array.from(list ?? [])) { const p = problem(f); if (p) errs.push(p); else ok.push(f); }
    const room = PHOTO_LIMITS.maxPhotos - files.photos.length;
    if (ok.length > room) errs.push(`Only ${PHOTO_LIMITS.maxPhotos} photos fit on a listing; the extra ${ok.length - room} were left out.`);
    onChange({ ...files, photos: [...files.photos, ...ok.slice(0, Math.max(0, room))] });
    setError(errs.join(" "));
  }
  function setPlan(list: FileList | null) {
    const f = list?.[0];
    if (!f) return;
    const p = problem(f);
    if (p) { setError(p); return; }
    setError(""); onChange({ ...files, plan: f });
  }

  return (
    <fieldset className="form-section">
      <legend>Photos</legend>
      <p className="muted">JPEG, PNG or WebP, up to {MB} MB each (animated WebP is saved as one still frame). Photos are optional now and are added to your draft when you save it on the last step. The first photo is the cover.</p>
      <input ref={photoInput} type="file" accept={TYPES.join(",")} multiple hidden onChange={e => { addPhotos(e.target.files); e.target.value = ""; }} aria-label="Choose photos" />
      <div className="form-bar">
        <button type="button" className="secondary" onClick={() => photoInput.current?.click()}>Choose photos</button>
        <button type="button" className="secondary" onClick={() => planInput.current?.click()}>{files.plan ? "Change site plan" : "Add site plan"}</button>
      </div>
      <input ref={planInput} type="file" accept={TYPES.join(",")} hidden onChange={e => { setPlan(e.target.files); e.target.value = ""; }} aria-label="Choose site plan" />
      {error && <p role="alert">{error}</p>}
      {files.photos.length > 0
        ? <>
            <p role="status" className="muted">{files.photos.length} {files.photos.length === 1 ? "photo" : "photos"} ready.</p>
            <ul className="qs-thumbs">{files.photos.map((f, i) => <Thumb key={`${f.name}-${f.size}-${i}`} file={f} onRemove={() => onChange({ ...files, photos: files.photos.filter((_, j) => j !== i) })} />)}</ul>
          </>
        : <p className="wiz-empty muted">No photos yet. Listings with photos get far more enquiries, but you can skip this step.</p>}
      {files.plan && <p role="status" className="muted">Site plan: {files.plan.name} <button type="button" className="secondary" onClick={() => onChange({ ...files, plan: null })}>Remove</button></p>}
    </fieldset>
  );
}
