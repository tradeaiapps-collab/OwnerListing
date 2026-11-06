"use client";
import { useState } from "react";
import { BondPathwayField, ListingFields, type BondState, type ListingDefaults } from "../fields";
import { TemplatePicker } from "../template-picker";
import type { TemplateView } from "../../../src/domain/listing-template";
import { JSON_HEADERS, listingFormBody } from "../ui";
import { dollarsToCents } from "../../../src/domain/listing-details";
import { PhotoManager } from "../photo-manager";
import { QuickSetupPanel, type QuickFiles } from "../quick-setup";
import type { QuickSetup } from "../../../src/domain/quick-setup";
import { ElenaPublishCheck } from "../elena-publish-check";

type Ready = Extract<QuickSetup, { state: "ready" }>;
type Upload = { name: string; state: "waiting" | "uploading" | "done" | "error"; message?: string };

export default function NewListing() {
  const [error, setError] = useState("");
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
  const uploading = uploads.some(u => u.state === "waiting" || u.state === "uploading");

  /** Elena's quick setup fills the form. Whatever the person had already typed is kept where Elena found nothing. */
  function applyQuick(r: Ready, files: QuickFiles) {
    const form = document.getElementById("new-listing-form");
    const fd = form instanceof HTMLFormElement ? new FormData(form) : new FormData();
    const s = (k: string) => String(fd.get(k) ?? "");
    const n = (k: string) => (s(k).trim() === "" ? {} : { [k]: Number(s(k)) });
    const cents = dollarsToCents(s("price"));
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
    setFilled(r); setPending(files); setMode("manual");
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
    const cents = dollarsToCents(s("price"));
    const kept: ListingDefaults = {
      title: s("title"), address: s("address"), suburb: s("suburb"), postcode: s("postcode"), jurisdiction: s("jurisdiction"), transactionType: s("transactionType"),
      useClass: s("useClass"), propertyType: s("propertyType"), description: s("description"), amenities: fd.getAll("amenities").map(String),
      ...(cents !== undefined ? { priceCents: cents } : {})
    };
    const n = (k: string) => (s(k).trim() === "" ? {} : { [k]: Number(s(k)) });
    setDefaults({ ...kept, ...n("bedrooms"), ...n("bathrooms"), ...n("parking"), ...t.content });
    setFieldsKey(k => k + 1);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = listingFormBody(new FormData(e.currentTarget));
    if ("error" in parsed) { setError(parsed.error); return; }
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
    <main className="narrow">
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
            <h2>Elena filled in your listing</h2>
            <p className="muted">{filled.source === "ai" ? "Elena wrote the title and description from your notes. " : "Elena read your notes to fill in the details. "}Check everything below and change what is wrong. Nothing is saved until you press Save draft.</p>
            <ul className="plain-list">{filled.filled.map(x => <li key={x.key}><strong>{x.label}:</strong> {x.value}</li>)}</ul>
            {filled.missing.length > 0 && <p><strong>Still needed:</strong> {filled.missing.join(", ")}.</p>}
            {(pending.photos.length > 0 || pending.plan) && <p className="muted">{pending.photos.length} {pending.photos.length === 1 ? "photo" : "photos"}{pending.plan ? " and a site plan" : ""} will be added when you save the draft.</p>}
          </section>
        )}
        <TemplatePicker onApply={t => { const f = document.getElementById("new-listing-form"); if (f instanceof HTMLFormElement) applyTemplate(t, f); }} />
        <form id="new-listing-form" className="stack" onSubmit={onSubmit}>
          <ListingFields key={fieldsKey} defaults={defaults} />
          <div className="form-bar"><button type="submit" disabled={busy}>Save draft</button></div>
        </form>
      </div>
      {signedOut && <p role="alert"><a href="/login?as=owner&next=/listings/new">Sign in</a> to save a listing.</p>}
      {error && <p role="alert">{error}</p>}
      {draftId && (
        <section role="status" className="panel">
          <h2>Draft saved</h2>
          <p><a href={`/listings/${draftId}/edit`}>Edit this draft</a></p>
          {uploads.length > 0 && (
            <ul className="plain-list" role="status" aria-label="Uploads">{uploads.map((u, i) => <li key={i}>{u.name}: {u.state === "waiting" ? "waiting" : u.state === "uploading" ? "uploading..." : u.state === "done" ? "added" : u.message}</li>)}</ul>
          )}
          {!uploading && <PhotoManager key={uploads.length} listingId={draftId} />}
          {isRent && (
            <BondPathwayField value={bond} state={bondState} onChange={saveBond} />
          )}
          <ElenaPublishCheck listingId={draftId} />
        </section>
      )}
      <p><a className="button secondary" href="/listings/mine">Back to my listings</a></p>
    </main>
  );
}
