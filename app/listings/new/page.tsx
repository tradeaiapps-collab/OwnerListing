"use client";
import { useBackspaceGuard } from "../use-backspace-guard";
import { useEffect, useRef, useState } from "react";
import { stepFromHash, stepHash } from "../../../src/domain/wizard-history";
import { BondPathwayField, ListingFields, type BondState, type ListingDefaults } from "../fields";
import { TemplatePicker } from "../template-picker";
import type { TemplateView } from "../../../src/domain/listing-template";
import { FIELD_ERROR_STEP, JSON_HEADERS, firstErrorField, focusFirstError, listingFormBody, type FieldErrors } from "../ui";
import { priceInputToCents } from "../../../src/domain/listing-details";
import { PhotoManager } from "../photo-manager";
import { QuickSetupPanel, type Drafted, type QuickFiles } from "../quick-setup";
import { ElenaPublishCheck } from "../elena-publish-check";
import { PhotosStep } from "./photos-step";
import { ContractorSection } from "../contractor-section";
import { ElenaEnquiriesPanel } from "../elena-enquiries-panel";
import { ElenaJobsPanel } from "../elena-jobs-panel";
import type { FieldStep } from "../fields";

const FORM_KEY = "ol-new-listing-form";
const STEPS = ["Basics", "Details", "Description", "Photos", "Location", "Publish"] as const;
const SUBS = ["Title, price and type", "Rooms and extras", "Tell the story", "Show it off", "Address and map", "Review and save"] as const;
const TITLES = ["What are you listing?", "Rooms and extras", "Describe the property", "Add photos", "Where is it?", "Review your listing"] as const;
const INTROS = ["Start with the essentials buyers look at first.", "These power the filters buyers use to find your home.", "Plain, specific wording works best.", "Good photos are the biggest driver of enquiries.", "The map pin is placed from your address when you save. Nothing to confirm.", "Check the details, then save your draft."] as const;
const FIELD_STEPS: (FieldStep | "none")[] = ["basics", "details", "description", "none", "location", "none"];
const LAST = STEPS.length - 1;

type Ready = Drafted;
type Upload = { name: string; state: "waiting" | "uploading" | "done" | "error"; message?: string };

export default function NewListing() {
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [draftId, setDraftId] = useState("");
  const [busy, setBusy] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [isRent, setIsRent] = useState(false);
  const [bond, setBond] = useState("");
  const [bondState, setBondState] = useState<BondState>("idle");
  const [defaults, setDefaults] = useState<ListingDefaults>({});
  const [fieldsKey, setFieldsKey] = useState(0);
  const [mode, setMode] = useState<"quick" | "manual">("quick");
  const [filled, setFilled] = useState<Ready | null>(null);
  const [pending, setPending] = useState<QuickFiles>({ photos: [], plan: null });
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [photosOff, setPhotosOff] = useState(false);
  useBackspaceGuard();
  // The form is kept in this tab as the owner types, so a refresh, Back or a crash never loses what was entered.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(FORM_KEY);
      if (!raw) return;
      const v = JSON.parse(raw) as Record<string, string | string[]>;
      const s = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : "");
      const cents = priceInputToCents(s("price"));
      const n = (k: string) => (s(k).trim() === "" || !/^\d+$/.test(s(k)) ? {} : { [k]: Number(s(k)) });
      if (!s("title") && !s("address") && !s("description")) return;
      setDefaults({
        title: s("title"), address: s("address"), suburb: s("suburb"), postcode: s("postcode"), jurisdiction: s("jurisdiction") || "QLD", transactionType: s("transactionType") || "sale",
        useClass: s("useClass") || "residential", propertyType: s("propertyType") || "house", description: s("description"), amenities: Array.isArray(v["amenities"]) ? (v["amenities"] as string[]) : [],
        ...(cents !== undefined ? { priceCents: cents } : {}), ...n("bedrooms"), ...n("bathrooms"), ...n("parking")
      });
      setFieldsKey(k => k + 1); setMode("manual");
    } catch { /* storage blocked: nothing to restore */ }
  }, []);
  useEffect(() => {
    fetch("/api/listings/upload-status", { headers: { accept: "application/json" } })
      .then(r => (r.ok ? r.json() : null)).then(d => { if (d && d.photos === false) setPhotosOff(true); }).catch(() => undefined);
  }, []);
  const reachedRef = useRef(0);
  reachedRef.current = reached;
  // Back and Forward move between steps (entered data stays: every step stays mounted). The first entry is step 1.
  useEffect(() => {
    if (!window.location.hash.startsWith("#step-")) window.history.replaceState({ wizStep: 0 }, "", stepHash(0));
    const onPop = () => setStep(stepFromHash(window.location.hash, reachedRef.current, STEPS.length - 1));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  // Warn before leaving with changes that are not saved as a draft.
  useEffect(() => {
    if (!dirty || draftId) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, draftId]);
  const [review, setReview] = useState<[string, string][]>([]);
  const [live, setLive] = useState({ price: "Price not set", title: "Untitled listing", addr: "Address not set", rooms: "" });
  const uploading = uploads.some(u => u.state === "waiting" || u.state === "uploading");

  /** Elena's quick setup fills the form. Whatever the person had already typed is kept where Elena found nothing. */
  function applyQuick(r: Ready, files: QuickFiles) {
    const form = document.getElementById("new-listing-form");
    const fd = form instanceof HTMLFormElement ? new FormData(form) : new FormData();
    const s = (k: string) => String(fd.get(k) ?? "");
    const n = (k: string) => (s(k).trim() === "" ? {} : { [k]: Number(s(k)) });
    const cents = priceInputToCents(s("price"));
    const f = r.fields;
    setDefaults({
      address: s("address"), suburb: s("suburb"), postcode: s("postcode"), jurisdiction: s("jurisdiction"), useClass: s("useClass"),
      ...n("bedrooms"), ...n("bathrooms"), ...n("parking"), ...(cents !== undefined ? { priceCents: cents } : {}),
      title: f.title, description: f.description, transactionType: f.transactionType, propertyType: f.propertyType, amenities: f.amenities,
      ...(f.suburb ? { suburb: f.suburb } : {}), ...(f.postcode ? { postcode: f.postcode } : {}), ...(f.jurisdiction ? { jurisdiction: f.jurisdiction } : {}),
      ...(f.address ? { address: f.address } : {}), ...(f.bedrooms !== undefined ? { bedrooms: f.bedrooms } : {}),
      ...(f.bathrooms !== undefined ? { bathrooms: f.bathrooms } : {}), ...(f.parking !== undefined ? { parking: f.parking } : {}),
      ...(f.priceCents !== undefined ? { priceCents: f.priceCents } : {})
    });
    setFieldsKey(k => k + 1);
    setFilled(r); setPending(files); setMode("manual"); setStep(0);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /** Sends the photos and plan chosen in quick setup to the new draft, one at a time. */
  async function uploadPending(id: string) {
    const items: { file: File; kind: "photo" | "floorplan" }[] = [...pending.photos.map(file => ({ file, kind: "photo" as const })), ...(pending.plan ? [{ file: pending.plan, kind: "floorplan" as const }] : [])];
    if (items.length === 0) return;
    setPending({ photos: [], plan: null });
    setUploads(items.map(i => ({ name: i.file.name, state: "waiting" })));
    const set = (i: number, u: Partial<Upload>) => setUploads(prev => prev.map((x, j) => (j === i ? { ...x, ...u } : x)));
    for (let i = 0; i < items.length; i++) {
      set(i, { state: "uploading" });
      const fd = new FormData();
      fd.set("file", items[i]!.file); fd.set("kind", items[i]!.kind);
      try {
        const r = await fetch(`/api/listings/${id}/photos`, { method: "POST", body: fd });
        if (r.ok) set(i, { state: "done" });
        else set(i, { state: "error", message: r.status === 503 ? "Photo upload is not available yet." : (await r.json().catch(() => ({}))).error ?? "Upload failed." });
      } catch { set(i, { state: "error", message: "Network error." }); }
    }
  }

  /** Template fields go over the form; what was already typed (title, address, suburb, postcode, price) is kept. */
  function applyTemplate(t: TemplateView, form: HTMLFormElement) {
    const fd = new FormData(form), s = (k: string) => String(fd.get(k) ?? "");
    const cents = priceInputToCents(s("price"));
    const kept: ListingDefaults = {
      title: s("title"), address: s("address"), suburb: s("suburb"), postcode: s("postcode"), jurisdiction: s("jurisdiction"), transactionType: s("transactionType"),
      useClass: s("useClass"), propertyType: s("propertyType"), description: s("description"), amenities: fd.getAll("amenities").map(String),
      ...(cents !== undefined ? { priceCents: cents } : {})
    };
    const n = (k: string) => (s(k).trim() === "" ? {} : { [k]: Number(s(k)) });
    setDefaults({ ...kept, ...n("bedrooms"), ...n("bathrooms"), ...n("parking"), ...t.content });
    setFieldsKey(k => k + 1);
  }

  /** What the preview card in the rail shows, read straight from the form. */
  function readPreview(form: HTMLFormElement) {
    const fd = new FormData(form), g = (k: string) => String(fd.get(k) ?? "").trim();
    const rent = g("transactionType") === "rent";
    const cents = priceInputToCents(g("price"));
    const price = cents === undefined || g("price") === "" ? "Price not set" : `$${(cents / 100).toLocaleString("en-AU")}${rent ? " pw" : ""}`;
    const rooms = ["bedrooms", "bathrooms", "parking"].map((k, i) => (g(k) === "" ? "" : `${g(k)} ${["bed", "bath", "car"][i]}`)).filter(Boolean).join(" · ");
    const addr = [g("address"), [g("suburb"), g("jurisdiction"), g("postcode")].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    return { price, title: g("title") || "Untitled listing", addr: addr || "Address not set", rooms };
  }

  function reviewRows(form: HTMLFormElement): [string, string][] {
    const fd = new FormData(form), g = (k: string) => String(fd.get(k) ?? "").trim();
    const rooms = ["bedrooms", "bathrooms", "parking"].map((k, i) => (g(k) === "" ? "" : `${g(k)} ${["bed", "bath", "car"][i]}`)).filter(Boolean).join(" · ");
    const place = [g("address"), [g("suburb"), g("jurisdiction"), g("postcode")].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    const rent = g("transactionType") === "rent";
    return [
      ["Basics", `${g("title") || "No title"} · ${rent ? "Rental" : "Sale"}, ${g("propertyType")} · ${g("price") ? `$${g("price")}${rent ? " pw" : ""}` : "no price"}`],
      ["Details", rooms || "Not set"], ["Description", g("description").slice(0, 90) || "Not set"],
      ["Photos", `${pending.photos.length} ${pending.photos.length === 1 ? "photo" : "photos"}${pending.plan ? " and a site plan" : ""}`],
      ["Location", place || "Not set"]
    ];
  }

  /** Marks every invalid field, shows the step that holds the first one and focuses it. */
  function showErrors(form: HTMLFormElement, message: string, errors: FieldErrors) {
    setError(message);
    setFieldErrors(errors);
    const first = firstErrorField(form, errors);
    const at = first ? FIELD_STEPS.indexOf(FIELD_ERROR_STEP[(first as HTMLInputElement).name] ?? "none") : -1;
    if (at >= 0 && at !== step) { setStep(at); setReached(r => Math.max(r, at)); setTimeout(() => focusFirstError(form, errors), 0); }
    else focusFirstError(form, errors);
  }

  /** Moves to a step. Going forward checks the fields on the current step first. */
  function goTo(next: number) {
    const form = document.getElementById("new-listing-form");
    if (!(form instanceof HTMLFormElement)) return;
    if (next > step) {
      const parsed = listingFormBody(new FormData(form));
      if ("errors" in parsed) {
        const here = Object.fromEntries(Object.entries(parsed.errors).filter(([k]) => FIELD_STEPS[step] === FIELD_ERROR_STEP[k]));
        if (Object.keys(here).length > 0) { showErrors(form, Object.keys(here).length === 1 ? "Fix the highlighted field to continue." : `Fix the ${Object.keys(here).length} highlighted fields to continue.`, here); return; }
      }
      const fields = Array.from(form.querySelectorAll<HTMLInputElement>(".wiz-step:not([hidden]) :is(input, select, textarea)"));
      const bad = fields.find(el => !el.checkValidity());
      if (bad) { bad.reportValidity(); return; }
    }
    setError("");
    setFieldErrors({});
    if (next === LAST) setReview(reviewRows(form));
    if (next !== step) window.history.pushState({ wizStep: next }, "", stepHash(next));
    setStep(next); setReached(r => Math.max(r, next));
    document.getElementById("wiz-top")?.scrollIntoView({ block: "start" });
  }

  /** Places the map pin from the address as soon as the draft exists, so the owner never has to confirm it. Best effort; the pin can be adjusted on the edit page. */
  async function saveLocation(id: string, b: Record<string, unknown>) {
    const q = [b["address"], [b["suburb"], b["jurisdiction"], b["postcode"]].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    try {
      const g = await fetch(`/api/address/geocode?${new URLSearchParams({ q })}`, { headers: { accept: "application/json" } });
      const p = await g.json().catch(() => ({}));
      if (!g.ok || typeof p.lat !== "number" || typeof p.lng !== "number") return;
      await fetch(`/api/listings/${id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ latitude: Math.round(p.lat * 1e6) / 1e6, longitude: Math.round(p.lng * 1e6) / 1e6 }) });
    } catch { /* no pin yet: the edit page places it again */ }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>, force = false) {
    e.preventDefault();
    if (step < LAST && !force) { goTo(step + 1); return; }
    if (draftId) return;
    const parsed = listingFormBody(new FormData(e.currentTarget));
    if ("error" in parsed) { showErrors(e.currentTarget, parsed.error, parsed.errors); return; }
    setFieldErrors({});
    const body = parsed.body;
    setBusy(true);
    setError("");
    setBond("");
    setBondState("idle");
    try {
      const res = await fetch("/api/listings", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
      const d = await res.json();
      if (res.status === 401) setSignedOut(true);
      else if (!res.ok) setError(d.error ?? "Could not save the draft.");
      else {
        setDraftId(d.listing.id);
        try { sessionStorage.removeItem(FORM_KEY); } catch { /* ignore */ }
        void saveLocation(d.listing.id, body);
        setIsRent(d.listing.transactionType === "rent");
        void uploadPending(d.listing.id);
      }
    } catch {
      setError("Could not save the draft.");
    } finally {
      setBusy(false);
    }
  }

  async function saveBond(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    setBond(value);
    setBondState("saving");
    try {
      const res = await fetch(`/api/listings/${draftId}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ rentalBondPathway: value }) });
      setBondState(res.ok ? "saved" : "error");
    } catch {
      setBondState("error");
    }
  }

  return (
    <main className="narrow wiz-main">
      <h1>Create a listing</h1>
      <p className="muted">Start with the basics. You can save a draft and finish later. Nothing is public until you publish.</p>
      <div className="qs-tabs" role="tablist" aria-label="How do you want to set up the listing?">
        <button type="button" role="tab" id="tab-quick" aria-selected={mode === "quick"} aria-controls="panel-quick" className={mode === "quick" ? "" : "secondary"} onClick={() => setMode("quick")}>Quick setup with Elena</button>
        <button type="button" role="tab" id="tab-manual" aria-selected={mode === "manual"} aria-controls="panel-manual" className={mode === "manual" ? "" : "secondary"} onClick={() => setMode("manual")}>Manual setup</button>
      </div>
      <div id="panel-quick" role="tabpanel" aria-labelledby="tab-quick" hidden={mode !== "quick"}>
        <QuickSetupPanel onDone={applyQuick} onManual={() => setMode("manual")} />
      </div>
      <div id="panel-manual" role="tabpanel" aria-labelledby="tab-manual" hidden={mode !== "manual"}>
        {filled && (
          <section role="status" className="panel qs-result">
            <h2>Elena wrote your listing. Check it below.</h2>
            <p className="muted">{filled.source === "ai" ? "Elena wrote the title and description from your notes. " : "Elena read your notes to fill in the details. "}Check everything below and change what is wrong. Nothing is saved until you press Save draft.</p>
            <ul className="plain-list">{filled.filled.map(x => <li key={x.key}><strong>{x.label}:</strong> {x.value}</li>)}</ul>
            {filled.photoState === "read" && filled.seen && filled.seen.length > 0 && <p><strong>Elena saw in your photos:</strong> {filled.seen.join(", ")}.</p>}
            {filled.photoState === "off" && <p className="muted">Elena can&apos;t look at photos on this server yet (no vision model installed), so she wrote from your address and notes. {photosOff ? "" : "Your photos are still added when you save."}</p>}
            {filled.photoState === "failed" && <p className="muted">Elena couldn&apos;t read the photos this time. {photosOff ? "" : "Your photos are still added when you save."}</p>}
            {filled.area && filled.area.suburbFacts.length > 0 && <>
              <p><strong>What we know about the area</strong> <span className="muted">({filled.area.suburbSource})</span></p>
              <ul className="plain-list">{filled.area.suburbFacts.map(x => <li key={x.label}>{x.label}: {x.value}</li>)}</ul>
            </>}
            {filled.area && filled.area.checklist.length > 0 && <p className="muted"><strong>Papers a seller usually needs in {filled.fields.jurisdiction}:</strong> {filled.area.checklist.join("; ")}. Draft list, not legal advice.</p>}
            {filled.missing.length > 0 && <p><strong>Still needed:</strong> {filled.missing.join(", ")}.</p>}
            {!photosOff && (pending.photos.length > 0 || pending.plan) && <p className="muted">{pending.photos.length} {pending.photos.length === 1 ? "photo" : "photos"}{pending.plan ? " and a site plan" : ""} will be added when you save the draft.</p>}
          </section>
        )}
        <TemplatePicker onApply={t => { const f = document.getElementById("new-listing-form"); if (f instanceof HTMLFormElement) applyTemplate(t, f); }} />
        <div className="wiz-layout">
          <aside className="wiz-rail" aria-label="Listing progress">
            <ol className="wiz-steps">
              {STEPS.map((name, i) => (
                <li key={name} className={i < step ? "done" : i === step ? "cur" : ""}>
                  <button type="button" disabled={i > reached} aria-current={i === step ? "step" : undefined} aria-label={`Step ${i + 1}, ${name}`} onClick={() => goTo(i)}>
                    <span className="wiz-dot" aria-hidden="true">{i < step ? "✓" : i + 1}</span>
                    <span className="wiz-st"><b>{name}</b><span>{SUBS[i]}</span></span>
                  </button>
                </li>
              ))}
            </ol>
            <div className="wiz-preview" aria-label="Listing preview">
              <div className="wiz-ph"><em>Preview</em></div>
              <div className="wiz-pb"><strong className="wiz-pp">{live.price}</strong><span className="wiz-pt">{live.title}</span><span className="muted">{live.addr}</span>{live.rooms && <span className="muted">{live.rooms}</span>}</div>
            </div>
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
            <form id="new-listing-form" onSubmit={onSubmit} onInput={e => { setDirty(true); try { const fd = new FormData(e.currentTarget), o: Record<string, string | string[]> = {}; for (const k of new Set(Array.from(fd.keys()))) o[k] = k === "amenities" ? fd.getAll(k).map(String) : String(fd.get(k) ?? ""); sessionStorage.setItem(FORM_KEY, JSON.stringify(o)); } catch { /* storage blocked */ } setLive(readPreview(e.currentTarget)); const n = (e.target as HTMLInputElement).name; if (n && fieldErrors[n] !== undefined) { const { [n]: _gone, ...rest } = fieldErrors; setFieldErrors(rest); if (Object.keys(rest).length === 0) setError(""); } }} noValidate>
              <div className="wiz-body">
                <ListingFields key={fieldsKey} defaults={defaults} step={FIELD_STEPS[step] ?? "none"} errors={fieldErrors} />
                <div hidden={step !== 3}><PhotosStep files={pending} onChange={setPending} unavailable={photosOff} /></div>
                <div hidden={step !== LAST} className="wiz-review">
                  {review.map(([k, v], i) => (
                    <div key={k} className="wiz-rv"><h3>{k}</h3><p>{v}</p><button type="button" className="link-button" onClick={() => goTo(i)}>Edit</button></div>
                  ))}
                  {draftId
                    ? <p className="muted">Draft saved, next: invite or publish. Nothing is public until you publish.</p>
                    : <p className="muted">Saving creates a draft. Then you can invite your photographer and building inspector. Nothing is public until you publish.</p>}
                </div>
              </div>
              <div className="wiz-nav">
                <button type="button" className="secondary" disabled={step === 0} onClick={() => goTo(step - 1)}>Previous</button>
                {step < LAST && <button type="button" className="link-button wiz-exit" disabled={busy || !!draftId} onClick={() => { const f = document.getElementById("new-listing-form"); if (f instanceof HTMLFormElement) void onSubmit({ preventDefault() {}, currentTarget: f } as unknown as React.FormEvent<HTMLFormElement>, true); }}>Save draft and exit</button>}
                {step < LAST
                  ? <button type="button" onClick={() => goTo(step + 1)}>Next: {STEPS[step + 1]}</button>
                  : <button type="submit" disabled={busy || !!draftId}>{draftId ? "Draft saved" : busy ? "Saving..." : "Save draft"}</button>}
              </div>
            </form>
          </section>
        </div>
      </div>
      {signedOut && <p role="alert"><a href="/login?as=owner&next=/listings/new">Sign in</a> to save a listing.</p>}
      {error && <p role="alert">{error}</p>}
      {draftId && (
        <section role="status" className="panel">
          <h2>Draft saved</h2>
          <div className="post-save">
            <section className="post-save-group" aria-labelledby="ps-publish">
              <h3 id="ps-publish">Publish</h3>
              <p className="muted">You do not need a photographer, inspector or any contractor to publish. Elena lists exactly what must be done first (for example disclosures, ID check or trust account), with a link to fix each one.</p>
              <ElenaPublishCheck listingId={draftId} />
              <p><a href={`/listings/${draftId}/approve`}>Preview your ad as buyers see it</a> · <a href={`/listings/${draftId}/edit`}>Edit this draft</a></p>
            </section>
            <details className="post-save-group">
              <summary>Photos and plan already added ({uploads.filter(u => u.state === "done").length || "see"}): change or reorder</summary>
              {uploads.length > 0 && (
                <ul className="plain-list" role="status" aria-label="Uploads">{uploads.map((u, i) => <li key={i}>{u.name}: {u.state === "waiting" ? "waiting" : u.state === "uploading" ? "uploading..." : u.state === "done" ? "added" : u.message}</li>)}</ul>
              )}
              {!uploading && <PhotoManager key={uploads.length} listingId={draftId} />}
            </details>
            {isRent && (
              <section className="post-save-group" aria-label="Rental bond">
                <BondPathwayField value={bond} state={bondState} onChange={saveBond} />
              </section>
            )}
            <details className="post-save-group">
              <summary>Optional: invite a photographer or inspector (skip if you do not need them)</summary>
              <ContractorSection listingId={draftId} />
              <ElenaJobsPanel listingId={draftId} />
              <ElenaEnquiriesPanel listingId={draftId} />
            </details>
          </div>
        </section>
      )}
      <p className="page-back"><a className="button secondary" href="/listings/mine">Back to my listings</a></p>
    </main>
  );
}
