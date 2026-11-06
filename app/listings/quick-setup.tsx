"use client";
import { useEffect, useId, useRef, useState } from "react";
import { PHOTO_LIMITS } from "../../src/domain/listing-photos";
import { MAX_QUICK_NOTES } from "../../src/domain/quick-setup-limits";
import type { QuickSetup } from "../../src/domain/quick-setup";
import { useSearchPersona } from "./persona-context";
import { JSON_HEADERS } from "./ui";

export type QuickFiles = { photos: File[]; plan: File | null };
type Ready = Extract<QuickSetup, { state: "ready" }>;

const TYPES = ["image/jpeg", "image/png", "image/webp"];
const MB = PHOTO_LIMITS.maxBytes / 1_000_000;
const STEPS = ["Photos", "Site plan", "Describe"] as const;

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
 * Elena's quick setup, one small step at a time so nothing needs scrolling: photos, site plan, then a few written lines.
 * She reads the writing and fills in the form; the owner reviews and changes it there. Photos and the plan are attached as they are
 * (Elena reads text only) and uploaded when the draft is saved.
 */
export function QuickSetupPanel({ transactionType, onDone, onManual }: { transactionType?: "sale" | "rent"; onDone: (r: Ready, files: QuickFiles) => void; onManual: () => void }) {
  const persona = useSearchPersona();
  const [step, setStep] = useState(0);
  const [photos, setPhotos] = useState<File[]>([]);
  const [plan, setPlan] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  const [tx, setTx] = useState<"sale" | "rent" | "">(transactionType ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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

  async function build() {
    if (notes.trim().length < 20) { setError("Write a few lines about the property first, so Elena has something to work from."); return; }
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/listings/assistant/quick-setup", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ notes, ...(tx ? { transactionType: tx } : {}) }) });
      const d = await r.json();
      if (!r.ok) setError(r.status === 401 ? "Sign in to use quick setup." : d.error ?? "Elena can't help right now. You can use manual setup instead.");
      else if (d.state !== "ready") setError(d.message ?? "Elena can't help right now.");
      else onDone(d as Ready, { photos, plan });
    } catch { setError("Elena can't help right now. You can use manual setup instead."); } finally { setBusy(false); }
  }

  return (
    <section className="ela-assist qs" aria-label={`Quick setup with ${persona.name}`}>
      <header className="qs-head">
        <img src={persona.icon} alt="" width={44} height={44} className="ela-avatar" />
        <div><strong>Quick setup with {persona.name}</strong> <span className="badge">AI assistant</span>
          <p className="muted ela-sub">Add photos and a plan if you have them, tell {persona.name} about the property, and she fills in the whole form. You review it before anything is saved.</p></div>
      </header>

      <ol className="qs-steps" aria-label="Steps">
        {STEPS.map((s, i) => <li key={s} aria-current={i === step ? "step" : undefined} className={i === step ? "on" : i < step ? "past" : ""}><button type="button" className="secondary" onClick={() => setStep(i)}><span aria-hidden="true">{i + 1}</span> {s}</button></li>)}
      </ol>

      <div className="qs-body">
        {step === 0 && (
          <div>
            <h3>Add photos <span className="muted qs-opt">optional</span></h3>
            <p className="muted">JPEG, PNG or WebP, up to {MB} MB each. They are added to your draft when you save it. Put the best one first.</p>
            <input ref={photoInput} type="file" accept={TYPES.join(",")} multiple hidden onChange={e => { addPhotos(e.target.files); e.target.value = ""; }} />
            <button type="button" className="secondary" onClick={() => photoInput.current?.click()}>Choose photos</button>
            {photos.length > 0 && <>
              <p role="status" className="muted">{photos.length} {photos.length === 1 ? "photo" : "photos"} ready.</p>
              <ul className="qs-thumbs">{photos.map((f, i) => <Thumb key={`${f.name}-${f.size}-${i}`} file={f} onRemove={() => setPhotos(p => p.filter((_, j) => j !== i))} />)}</ul>
            </>}
          </div>
        )}
        {step === 1 && (
          <div>
            <h3>Add the site plan or floor plan <span className="muted qs-opt">optional</span></h3>
            <p className="muted">One image (JPEG, PNG or WebP). Buyers see it as the floor plan on your listing.</p>
            <input ref={planInput} type="file" accept={TYPES.join(",")} hidden onChange={e => { setPlanFile(e.target.files); e.target.value = ""; }} />
            <button type="button" className="secondary" onClick={() => planInput.current?.click()}>{plan ? "Choose a different plan" : "Choose a plan"}</button>
            {plan && <p role="status" className="muted">{plan.name} <button type="button" className="secondary" onClick={() => setPlan(null)}>Remove</button></p>}
          </div>
        )}
        {step === 2 && (
          <div className="stack">
            <h3>Tell {persona.name} about the property</h3>
            <label className="field" htmlFor={notesId}><span>Write it the way you would tell a friend. Include the address or suburb and state, bedrooms, bathrooms, parking, the price, and what you love about it.</span>
              <textarea id={notesId} rows={7} maxLength={MAX_QUICK_NOTES} value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="e.g. 3 bedroom house at 12 Smith Street, Paddington QLD 4064. 2 bathrooms, double garage, renovated kitchen with stone benchtops, saltwater pool and a north-facing deck. Walk to the train station. Asking $1.15m." />
            </label>
            <label className="field">This is for
              <select value={tx} onChange={e => setTx(e.target.value as "sale" | "rent" | "")}>
                <option value="">Work it out from my writing</option><option value="sale">Sale</option><option value="rent">Rent</option>
              </select>
            </label>
            <small className="muted">{notes.length} of {MAX_QUICK_NOTES}. Elena only uses what you write. Anything she cannot find stays blank for you to fill in.</small>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
      </div>

      <footer className="qs-foot">
        <button type="button" className="secondary" onClick={onManual}>Fill in manually instead</button>
        <span className="qs-nav">
          {step > 0 && <button type="button" className="secondary" disabled={busy} onClick={() => { setError(""); setStep(step - 1); }}>Back</button>}
          {step < 2
            ? <button type="button" onClick={() => { setError(""); setStep(step + 1); }}>{(step === 0 ? photos.length : plan) ? "Next" : "Skip"}</button>
            : <button type="button" disabled={busy} onClick={() => void build()}>{busy ? `${persona.name} is working…` : "Build my listing"}</button>}
        </span>
      </footer>
    </section>
  );
}
