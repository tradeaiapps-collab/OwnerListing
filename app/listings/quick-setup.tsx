"use client";
import { checkElenaInput } from "../../src/domain/text-quality";

import { useEffect, useId, useRef, useState } from "react";
import { PHOTO_LIMITS } from "../../src/domain/listing-photos";
import { MAX_QUICK_NOTES } from "../../src/domain/quick-setup-limits";
import type { QuickSetup } from "../../src/domain/quick-setup";
import type { QuickDraft } from "../../src/domain/quick-draft";
import { AddressField } from "./address-field";
import { useSearchPersona } from "./persona-context";
import { JSON_HEADERS } from "./ui";

export type QuickFiles = { photos: File[]; plan: File | null };
type Ready = Extract<QuickSetup, { state: "ready" }>;
/** What the server sends back: the draft fields plus what Elena saw in the photos and the area facts she used. */
export type Drafted = Ready & Partial<Pick<QuickDraft, "seen" | "photoState" | "photosRead" | "area">>;

const TYPES = ["image/jpeg", "image/png", "image/webp"];
const MB = PHOTO_LIMITS.maxBytes / 1_000_000;
const STEPS = ["Address", "Photos", "Details"] as const;
const MAX_SEND = 6;

/** Shrinks a photo in the browser before it is sent for reading, so six photos stay small. Falls back to the original. */
async function shrink(f: File): Promise<File> {
  try {
    const bmp = await createImageBitmap(f);
    const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d")?.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>(r => c.toBlob(r, "image/jpeg", 0.8));
    return blob ? new File([blob], "photo.jpg", { type: "image/jpeg" }) : f;
  } catch { return f; }
}

export function problem(f: File): string | null {
  if (!TYPES.includes(f.type)) return `${f.name}: only JPEG, PNG or WebP images.`;
  if (f.size === 0) return `${f.name}: the file is empty.`;
  if (f.size > PHOTO_LIMITS.maxBytes) return `${f.name}: larger than ${MB} MB.`;
  return null;
}

/** Thumbnail that frees its object URL when it goes away. */
export function Thumb({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState("");
  useEffect(() => { const u = URL.createObjectURL(file); setUrl(u); return () => URL.revokeObjectURL(u); }, [file]);
  return (
    <li className="qs-thumb">
      {url && <img src={url} alt={file.name} />}
      <button type="button" className="secondary" aria-label={`Remove ${file.name}`} onClick={onRemove}>×</button>
    </li>
  );
}

/**
 * Elena's quick setup. The owner gives the address, adds photos (and a plan if they have one) and optional notes, then presses one button.
 * Elena looks at the photos, uses what the site already holds for the address, and writes the whole draft. The owner reviews it on the form;
 * nothing is saved until they save the draft. Photos and the plan are uploaded to the draft when it is saved.
 */
export function QuickSetupPanel({ transactionType, onDone, onManual }: { transactionType?: "sale" | "rent"; onDone: (r: Drafted, files: QuickFiles) => void; onManual: () => void }) {
  const persona = useSearchPersona();
  const [step, setStep] = useState(0);
  const [photos, setPhotos] = useState<File[]>([]);
  const [plan, setPlan] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  const [tx, setTx] = useState<"sale" | "rent" | "">(transactionType ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const planInput = useRef<HTMLInputElement>(null);
  const notesId = useId();

  function addPhotos(list: FileList | null) {
    const incoming = Array.from(list ?? []);
    const errs: string[] = [];
    const ok: File[] = [];
    for (const f of incoming) { const p = problem(f); if (p) errs.push(p); else ok.push(f); }
    const room = PHOTO_LIMITS.maxPhotos - photos.length;
    if (ok.length > room) errs.push(`Only ${PHOTO_LIMITS.maxPhotos} photos fit on a listing; the extra ${ok.length - room} were left out.`);
    setPhotos(p => [...p, ...ok.slice(0, Math.max(0, room))]);
    setError(errs.join(" "));
  }
  function setPlanFile(list: FileList | null) {
    const f = list?.[0];
    if (!f) return;
    const p = problem(f);
    setError(p ?? "");
    if (!p) setPlan(f);
  }
  const field = (name: string) => String(new FormData(formRef.current ?? undefined).get(name) ?? "").trim();
  const addressOk = () => field("address").length >= 5;

  async function build() {
    if (!addressOk()) { setStep(0); setError("Enter the property's address first. Elena starts from it."); return; }
    const badNotes = checkElenaInput(notes);
    if (badNotes) { setError(badNotes); return; }
    setBusy(true); setError("");
    try {
      const fd = new FormData();
      for (const k of ["address", "suburb", "postcode", "bedrooms", "bathrooms", "parking", "price"]) { const v = field(k); if (v) fd.append(k, v); }
      const st = field("jurisdiction"); if (st) fd.append("state", st);
      if (notes.trim()) fd.append("notes", notes);
      if (tx) fd.append("transactionType", tx);
      for (const f of await Promise.all(photos.slice(0, MAX_SEND).map(shrink))) fd.append("photos", f);
      const r = await fetch("/api/listings/assistant/quick-draft", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) setError(r.status === 401 ? "Sign in to use quick setup." : d.error ?? "Elena can't help right now. You can use manual setup instead.");
      else if (d.state !== "ready") setError(d.message ?? "Elena can't help right now.");
      else onDone(d as Drafted, { photos, plan });
    } catch { setError("Elena can't help right now. You can use manual setup instead."); } finally { setBusy(false); }
  }

  return (
    <section className="ela-assist qs" aria-label={`Quick setup with ${persona.name}`}>
      <header className="qs-head">
        <img src={persona.icon} alt="" width={44} height={44} className="ela-avatar" />
        <div><strong>{persona.name} writes it for you</strong> <span className="badge">AI assistant</span>
          <p className="muted ela-sub">Give {persona.name} the address and your photos. She looks at the photos, uses what we know about the area, and writes the full listing. You check and change everything before it is saved.</p></div>
      </header>

      <ol className="qs-steps" aria-label="Steps">
        {STEPS.map((s, i) => <li key={s} aria-current={i === step ? "step" : undefined} className={i === step ? "on" : i < step ? "past" : ""}><button type="button" className="secondary" onClick={() => setStep(i)}><span aria-hidden="true">{i + 1}</span> {s}</button></li>)}
      </ol>

      <form ref={formRef} className="qs-body" onSubmit={e => { e.preventDefault(); void build(); }} noValidate>
        <div className="stack" hidden={step !== 0}>
          <h3>Where is the property?</h3>
          <label className="field"><span>Street address</span><AddressField /></label>
          <div className="form-grid">
            <label className="field"><span>Suburb</span><input name="suburb" maxLength={80} autoComplete="off" /></label>
            <label className="field"><span>State</span>
              <select name="jurisdiction" defaultValue=""><option value="">Choose</option>{["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"].map(x => <option key={x}>{x}</option>)}</select></label>
            <label className="field"><span>Postcode</span><input name="postcode" inputMode="numeric" maxLength={4} autoComplete="off" /></label>
          </div>
        </div>

        <div hidden={step !== 1}>
          <h3>Add photos <span className="muted qs-opt">optional, but they help Elena a lot</span></h3>
          <p className="muted">JPEG, PNG or WebP, up to {MB} MB each. Elena looks at the first {MAX_SEND}. All of them are added to your draft when you save it.</p>
          <input ref={photoInput} type="file" accept={TYPES.join(",")} multiple hidden onChange={e => { addPhotos(e.target.files); e.target.value = ""; }} />
          <button type="button" className="secondary" onClick={() => photoInput.current?.click()}>Choose photos</button>
          {photos.length > 0 && <>
            <p role="status" className="muted">{photos.length} {photos.length === 1 ? "photo" : "photos"} ready.</p>
            <ul className="qs-thumbs">{photos.map((f, i) => <Thumb key={`${f.name}-${f.size}-${i}`} file={f} onRemove={() => setPhotos(p => p.filter((_, j) => j !== i))} />)}</ul>
          </>}
          <h3 className="qs-sub">Site plan or floor plan <span className="muted qs-opt">optional</span></h3>
          <input ref={planInput} type="file" accept={TYPES.join(",")} hidden onChange={e => { setPlanFile(e.target.files); e.target.value = ""; }} />
          <button type="button" className="secondary" onClick={() => planInput.current?.click()}>{plan ? "Choose a different plan" : "Choose a plan"}</button>
          {plan && <p role="status" className="muted">{plan.name} <button type="button" className="secondary" onClick={() => setPlan(null)}>Remove</button></p>}
        </div>

        <div className="stack" hidden={step !== 2}>
          <h3>Anything you already know <span className="muted qs-opt">optional</span></h3>
          <p className="muted">Elena never guesses the price or the number of rooms. Fill in what you know; leave the rest blank.</p>
          <div className="form-grid">
            <label className="field"><span>Bedrooms</span><input name="bedrooms" type="number" inputMode="numeric" min={0} max={30} /></label>
            <label className="field"><span>Bathrooms</span><input name="bathrooms" type="number" inputMode="numeric" min={0} max={30} /></label>
            <label className="field"><span>Parking spaces</span><input name="parking" type="number" inputMode="numeric" min={0} max={30} /></label>
            <label className="field"><span>{tx === "rent" ? "Rent per week ($)" : "Asking price ($)"}</span><input name="price" type="number" inputMode="numeric" min={0} /></label>
          </div>
          <label className="field">This is for
            <select value={tx} onChange={e => setTx(e.target.value as "sale" | "rent" | "")}>
              <option value="">Work it out for me</option><option value="sale">Sale</option><option value="rent">Rent</option>
            </select>
          </label>
          <label className="field" htmlFor={notesId}><span>Extra notes for Elena</span>
            <textarea id={notesId} rows={4} maxLength={MAX_QUICK_NOTES} value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. Renovated in 2022, walk to the train station, quiet street." />
          </label>
          <small className="muted">{notes.length} of {MAX_QUICK_NOTES}</small>
        </div>
        {error && <p role="alert">{error}</p>}
      </form>

      <footer className="qs-foot">
        <button type="button" className="secondary" onClick={onManual}>Fill in manually instead</button>
        <span className="qs-nav">
          {step > 0 && <button type="button" className="secondary" disabled={busy} onClick={() => { setError(""); setStep(step - 1); }}>Back</button>}
          {step < 2 && <button type="button" className="secondary" onClick={() => { if (step === 0 && !addressOk()) { setError("Enter the property's address first."); return; } setError(""); setStep(step + 1); }}>{step === 1 && photos.length === 0 && !plan ? "Skip" : "Next"}</button>}
          <button type="button" disabled={busy} onClick={() => void build()}>{busy ? `${persona.name} is working…` : `Let ${persona.name} write it`}</button>
        </span>
      </footer>
    </section>
  );
}
