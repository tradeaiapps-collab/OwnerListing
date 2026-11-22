"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { BondPathwayField, ListingFields, type BondState, type FieldStep, type ListingDefaults } from "../../fields";
import { FIELD_ERROR_STEP, JSON_HEADERS, firstErrorField, focusFirstError, listingFormBody, type FieldErrors } from "../../ui";
import { PhotoManager } from "../../photo-manager";
import { ElenaPriceSuggestion } from "../../elena-price-suggestion";
import { WordingFlagList, type WordingFlagView } from "../../wording-hint";
import { LocationPicker } from "../../location-picker";
import { ElenaPublishCheck } from "../../elena-publish-check";
import { ElenaEnquiriesPanel } from "../../elena-enquiries-panel";

const STEPS = ["Basics", "Details", "Description", "Photos", "Location", "Review"] as const;
const SUBS = ["Title, price and type", "Rooms and extras", "Tell the story", "Show it off", "Address and map", "Check and save"] as const;
const TITLES = ["What are you listing?", "Rooms and extras", "Describe the property", "Photos", "Where is it?", "Review your listing"] as const;
const INTROS = ["Start with the essentials buyers look at first.", "These power the filters buyers use to find your home.", "Plain, specific wording works best.", "Good photos are the biggest driver of enquiries.", "The map pin is placed from the address; drag it if it is off.", "Check the summary, run Elena's publish check, then save."] as const;
const FIELD_STEPS: (FieldStep | "none")[] = ["basics", "details", "description", "none", "location", "none"];
const LAST = STEPS.length - 1;

type Loaded = ListingDefaults & { id: string; status: string; latitude?: number; longitude?: number };
type FieldFlags = { field: string; flags: WordingFlagView[] };
type Suggestion = { state: "ready"; text: string; label: string } | { state: "unavailable"; message: string; reason?: string };

/** Owner asks the self-hosted AI for a draft description. Shown as text to copy and edit; never saved or published from here. */
function SuggestDescription({ id }: { id: string }) {
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Suggestion | null>(null);
  const [error, setError] = useState("");
  async function ask() {
    setBusy(true); setError(""); setResult(null);
    try {
      const res = await fetch(`/api/listings/${id}/description-suggestion`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ notes }) });
      const d = await res.json();
      if (res.ok) setResult(d); else setError(d.error ?? "Could not get a suggestion.");
    } catch { setError("Could not get a suggestion."); } finally { setBusy(false); }
  }
  return (
    <section className="panel">
      <h3>Suggest description</h3>
      <label>Notes for the AI (optional, for example what you love about the home)
        <textarea value={notes} maxLength={1000} rows={3} onChange={e => setNotes(e.target.value)} />
      </label>
      <button type="button" className="secondary" disabled={busy} onClick={ask}>{busy ? "Working..." : "Suggest description"}</button>
      {result?.state === "ready" && (
        <div>
          <p className="muted"><strong>{result.label}.</strong> Check every fact and change anything that is not right.</p>
          <textarea readOnly value={result.text} rows={8} />
        </div>
      )}
      {result?.state === "unavailable" && <p className="muted" role="status">{result.message}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

export default function EditListing() {
  const { id } = useParams<{ id: string }>();
  const [listing, setListing] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bond, setBond] = useState("");
  const [bondState, setBondState] = useState<BondState>("idle");
  const [savedFlags, setSavedFlags] = useState<FieldFlags[]>([]);
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  const [review, setReview] = useState<[string, string][]>([]);

  useEffect(() => {
    setListing(null);
    setLoadError("");
    fetch(`/api/listings/${id}`)
      .then(async r => {
        const d = await r.json();
        if (r.ok) {
          setListing(d.listing);
          setBond(typeof d.rentalBondPathway === "string" ? d.rentalBondPathway : "");
        }
        else setLoadError(r.status === 404 ? "Listing not found. If it is your draft, sign in first." : d.error ?? "Could not load the listing.");
      })
      .catch(() => setLoadError("Could not load the listing."));
  }, [id]);

  /** Marks every invalid field, shows the step that holds the first one and focuses it. */
  function showErrors(form: HTMLFormElement, message: string, errors: FieldErrors) {
    setError(message);
    setFieldErrors(errors);
    const first = firstErrorField(form, errors);
    const at = first ? FIELD_STEPS.indexOf(FIELD_ERROR_STEP[(first as HTMLInputElement).name] ?? "none") : -1;
    if (at >= 0 && at !== step) { setStep(at); setReached(r => Math.max(r, at)); setTimeout(() => focusFirstError(form, errors), 0); }
    else focusFirstError(form, errors);
  }

  /** Saves every field on the form. Returns true when the draft was saved. */
  async function save(form: HTMLFormElement): Promise<boolean> {
    const parsed = listingFormBody(new FormData(form));
    if ("error" in parsed) { showErrors(form, parsed.error, parsed.errors); return false; }
    setFieldErrors({});
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const res = await fetch(`/api/listings/${id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(parsed.body) });
      const d = await res.json();
      if (res.status === 401) { setError("Sign in to edit this draft."); return false; }
      if (!res.ok) { setError(d.error ?? "Could not save the draft."); return false; }
      setListing(d.listing);
      setSaved(true);
      setSavedFlags(Array.isArray(d.wordingFlags) ? d.wordingFlags : []);
      return true;
    } catch {
      setError("Could not save the draft.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function reviewRows(form: HTMLFormElement): [string, string][] {
    const fd = new FormData(form), g = (k: string) => String(fd.get(k) ?? "").trim();
    const rooms = ["bedrooms", "bathrooms", "parking"].map((k, i) => (g(k) === "" ? "" : `${g(k)} ${["bed", "bath", "car"][i]}`)).filter(Boolean).join(" · ");
    const place = [g("address"), [g("suburb"), g("jurisdiction"), g("postcode")].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    const rent = g("transactionType") === "rent";
    return [
      ["Basics", `${g("title") || "No title"} · ${rent ? "Rental" : "Sale"}, ${g("propertyType")} · ${g("price") ? `$${g("price")}${rent ? " pw" : ""}` : "no price"}`],
      ["Details", rooms || "Not set"], ["Description", g("description").slice(0, 90) || "Not set"],
      ["Location", place || "Not set"]
    ];
  }

  /** Moves to a step. Going forward checks this step's fields and saves the draft first. */
  async function goTo(next: number) {
    const form = document.getElementById("edit-listing-form");
    if (!(form instanceof HTMLFormElement)) return;
    if (next > step) {
      const fields = Array.from(form.querySelectorAll<HTMLInputElement>(".wiz-step:not([hidden]) :is(input, select, textarea)"));
      const bad = fields.find(el => !el.checkValidity());
      if (bad) { bad.reportValidity(); return; }
      if (FIELD_STEPS[step] !== "none" && !(await save(form))) return;
    }
    setError("");
    if (next === LAST) setReview(reviewRows(form));
    setStep(next); setReached(r => Math.max(r, next));
    document.getElementById("wiz-top")?.scrollIntoView({ block: "start" });
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (step < LAST) { await goTo(step + 1); return; }
    await save(e.currentTarget);
  }

  async function saveBond(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    setBond(value);
    setBondState("saving");
    try {
      const res = await fetch(`/api/listings/${id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ rentalBondPathway: value }) });
      setBondState(res.ok ? "saved" : "error");
    } catch {
      setBondState("error");
    }
  }

  return (
    <main className="narrow wiz-main">
      <h1>Edit draft</h1>
      {loadError && <p role="alert">{loadError}</p>}
      {!loadError && !listing && <p className="muted" role="status">Loading...</p>}
      {listing && listing.status !== "draft" && <p role="alert">Only a draft can be edited.</p>}
      {listing && listing.status === "draft" && (
        <div className="wiz-layout">
          <aside className="wiz-rail" aria-label="Listing progress">
            <ol className="wiz-steps">
              {STEPS.map((name, i) => (
                <li key={name} className={i < step ? "done" : i === step ? "cur" : ""}>
                  <button type="button" disabled={busy || i > reached} aria-current={i === step ? "step" : undefined} aria-label={`Step ${i + 1}, ${name}`} onClick={() => void goTo(i)}>
                    <span className="wiz-dot" aria-hidden="true">{i < step ? "✓" : i + 1}</span>
                    <span className="wiz-st"><b>{name}</b><span>{SUBS[i]}</span></span>
                  </button>
                </li>
              ))}
            </ol>
          </aside>
          <section className="wiz-card">
            <header id="wiz-top" className="wiz-header">
              <div className="wiz-eyebrow"><span aria-live="polite">Step {step + 1} of {STEPS.length}</span><span className="wiz-eb2">{STEPS[step]}</span></div>
              <div className="wiz-seg" role="progressbar" aria-label="Listing progress" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={step + 1}>
                {STEPS.map((n, i) => <i key={n} className={i < step ? "ok" : i === step ? "on" : ""} />)}
              </div>
              <h2>{TITLES[step]}</h2>
              <p className="muted">{INTROS[step]}</p>
            </header>
            <form id="edit-listing-form" onSubmit={onSubmit} onInput={e => { const n = (e.target as HTMLInputElement).name; if (n && fieldErrors[n] !== undefined) { const { [n]: _gone, ...rest } = fieldErrors; setFieldErrors(rest); if (Object.keys(rest).length === 0) setError(""); } }} noValidate>
              <div className="wiz-body">
                <ListingFields defaults={listing} step={FIELD_STEPS[step] ?? "none"} errors={fieldErrors} />
                {step === 3 && <PhotoManager listingId={listing.id} />}
                {step === 4 && (
                  <>
                    <LocationPicker listingId={listing.id} address={listing.address} latitude={listing.latitude} longitude={listing.longitude} />
                    <section className="panel">
                      {listing.transactionType === "rent" && <BondPathwayField value={bond} state={bondState} onChange={saveBond} />}
                      <p><a href={`/listings/${listing.id}/disclosures`}>Required disclosures for your state</a></p>
                    </section>
                  </>
                )}
                {step === LAST && (
                  <div className="wiz-review">
                    {review.map(([k, v], i) => (
                      <div key={k} className="wiz-rv"><h3>{k}</h3><p>{v}</p><button type="button" className="link-button" onClick={() => void goTo(i < 3 ? i : 4)}>Edit</button></div>
                    ))}
                    <ElenaPublishCheck listingId={listing.id} />
                    <ElenaEnquiriesPanel listingId={listing.id} />
                    <ElenaPriceSuggestion listingId={listing.id} rent={listing.transactionType === "rent"} />
                    <SuggestDescription id={id} />
                  </div>
                )}
              </div>
              {saved && <p role="status">Changes saved.</p>}
              {saved && savedFlags.map(f => <WordingFlagList key={f.field} field={f.field} flags={f.flags} />)}
              {error && <p role="alert">{error}</p>}
              <div className="wiz-nav">
                <button type="button" className="secondary" disabled={busy || step === 0} onClick={() => void goTo(step - 1)}>Previous</button>
                {step < LAST
                  ? <button type="submit" disabled={busy}>{busy ? "Saving..." : `Next: ${STEPS[step + 1]}`}</button>
                  : <button type="submit" disabled={busy}>{busy ? "Saving..." : "Save changes"}</button>}
              </div>
            </form>
          </section>
        </div>
      )}
      <p><a className="button secondary" href="/listings/mine">Back to my listings</a></p>
    </main>
  );
}
