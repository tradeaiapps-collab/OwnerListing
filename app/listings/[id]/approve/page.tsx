"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { AMENITY_LABELS, formatPrice, isAmenity } from "../../../../src/domain/listing-details";
import { photoUrl, type PhotoView } from "../../../../src/domain/listing-photos";
import type { ElenaFinding } from "../../../../src/domain/listing-validation";
import { ElenaPriceSuggestion } from "../../elena-price-suggestion";
import { JSON_HEADERS } from "../../ui";

type Listing = { id: string; title: string; address: string; suburb?: string; state?: string; transactionType: "sale" | "rent"; status: string; priceCents?: number; bedrooms?: number; bathrooms?: number; parking?: number; amenities?: string[]; description?: string };
type Check = { reasons: string[]; findings: ElenaFinding[] };
type Summary = { state: "none" | "ok" | "no_text" | "unavailable"; findings: { text: string }[]; paragraph: string };
type Phase = "loading" | "ready" | "publishing" | "published";

/**
 * The last step: the finished ad exactly as buyers will see it, what still blocks publishing (and where to fix it), and one Approve button.
 * The server runs the same gate again on Approve (state papers approved by Compliance, verified trust account, Elena's review), so this
 * screen cannot publish past it. Editing happens in place; nothing goes public until the owner taps Approve.
 */
export default function ApproveListing() {
  const { id } = useParams<{ id: string }>();
  const [listing, setListing] = useState<Listing | null>(null);
  const [photos, setPhotos] = useState<PhotoView[]>([]);
  const [check, setCheck] = useState<Check | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: "", description: "" });
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);

  const runCheck = useCallback(async () => {
    try {
      const res = await fetch(`/api/listings/${id}/publish?dryRun=1`, { method: "POST", headers: JSON_HEADERS });
      const d = await res.json();
      if (!res.ok) { setError(d.error ?? "Could not check the listing."); return; }
      setCheck({ reasons: d.decision?.allowed ? [] : d.decision?.reasons ?? [], findings: d.elena?.findings ?? [] });
    } catch { setError("Could not check the listing."); }
  }, [id]);

  const load = useCallback(async () => {
    setError("");
    try {
      const r = await fetch(`/api/listings/${id}`);
      const d = await r.json();
      if (r.status === 401) { setError("Sign in to review your listing."); setPhase("ready"); return; }
      if (!r.ok || !d.isOwner) { setError(r.ok ? "Only the owner can approve this listing." : d.error ?? "Listing not found."); setPhase("ready"); return; }
      setListing(d.listing); setDraft({ title: d.listing.title, description: d.listing.description ?? "" });
      setPhase(d.listing.status === "published" ? "published" : "ready");
    } catch { setError("Could not load your listing."); setPhase("ready"); return; }
    try { const r = await fetch(`/api/listings/${id}/photos`); if (r.ok) setPhotos((await r.json()).photos ?? []); } catch { /* photos are shown if available */ }
    void runCheck();
    try { const r = await fetch(`/api/listings/${id}/inspection-summary`); if (r.ok) setSummary(await r.json()); } catch { /* optional */ }
  }, [id, runCheck]);
  useEffect(() => { void load(); }, [load]);

  async function save(patch: { title?: string; description?: string }) {
    setError(""); setNote("");
    const r = await fetch(`/api/listings/${id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(patch) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setError(d.error ?? "Could not save your changes."); return false; }
    setListing(d.listing); setDraft({ title: d.listing.title, description: d.listing.description ?? "" });
    setNote("Saved."); void runCheck();
    return true;
  }
  const addFindings = () => summary?.paragraph && void save({ description: `${listing?.description ?? ""}${listing?.description ? "\n\n" : ""}${summary.paragraph}`.slice(0, 5000) });

  async function approve() {
    setPhase("publishing"); setError("");
    try {
      const res = await fetch(`/api/listings/${id}/publish`, { method: "POST", headers: JSON_HEADERS });
      const d = await res.json();
      if (d.code === "mfa_required") { window.location.assign(`/mfa?next=${encodeURIComponent(`/listings/${id}/approve`)}`); return; }
      if (!res.ok) { setError(d.error ?? "Could not publish."); setPhase("ready"); return; }
      if (!d.decision.allowed) { setCheck({ reasons: d.decision.reasons, findings: d.elena?.findings ?? [] }); setPhase("ready"); return; }
      setPhase("published"); setTimeout(() => headingRef.current?.focus(), 0);
    } catch { setError("Could not publish."); setPhase("ready"); }
  }

  const blockers = check?.findings.filter(f => f.severity === "block") ?? [];
  const extra = (check?.reasons ?? []).filter(r => !check?.findings.some(f => f.message === r));
  const tips = check?.findings.filter(f => f.severity === "advice") ?? [];
  const blocked = blockers.length + extra.length;
  const facts = listing ? [listing.bedrooms !== undefined && `${listing.bedrooms} bed`, listing.bathrooms !== undefined && `${listing.bathrooms} bath`, listing.parking !== undefined && `${listing.parking} car`].filter(Boolean).join(" · ") : "";

  return (
    <main className="approve">
      <h1 ref={headingRef} tabIndex={-1}>{phase === "published" ? "Your listing is live" : "Approve and publish"}</h1>
      {phase === "loading" && <p role="status" className="muted">Loading your listing…</p>}
      {error && <p role="alert">{error}</p>}
      {phase === "published" && listing && <p role="status">Buyers can now find it. Our team will also review it. <a className="button" href={`/listings/${id}`}>View your listing</a></p>}
      {listing && phase !== "published" && (
        <>
          <p className="muted">This is your finished ad. Read it, change anything you like, then approve. Nothing is public until you tap Approve.</p>
          <section className="panel" aria-labelledby="ad-h">
            <h2 id="ad-h">Your ad</h2>
            {photos.length > 0 && <ul className="plain-list approve-photos" aria-label="Photos">{photos.slice(0, 6).map((p, i) => <li key={p.id}><img src={photoUrl(p.id, "medium")} alt={p.alt || `Photo ${i + 1}`} loading="lazy" /></li>)}</ul>}
            {editing ? (
              <form onSubmit={async e => { e.preventDefault(); if (await save(draft)) setEditing(false); }}>
                <label className="field"><span>Title</span><input value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} maxLength={200} required /></label>
                <label className="field"><span>Description</span><textarea value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} rows={10} maxLength={5000} /></label>
                <span className="qs-nav"><button type="submit">Save changes</button><button type="button" className="secondary" onClick={() => { setEditing(false); setDraft({ title: listing.title, description: listing.description ?? "" }); }}>Cancel</button></span>
              </form>
            ) : (
              <>
                <h3>{listing.title}</h3>
                <p className="muted">{[listing.address, listing.suburb, listing.state].filter(Boolean).join(", ")}</p>
                <p><strong>{listing.priceCents !== undefined ? formatPrice(listing.priceCents, listing.transactionType) : "No price set"}</strong>{facts && ` · ${facts}`}</p>
                {(listing.amenities ?? []).length > 0 && <p>{(listing.amenities ?? []).map(a => (isAmenity(a) ? AMENITY_LABELS[a] : a)).join(", ")}</p>}
                <p className="approve-desc">{listing.description || "No description yet."}</p>
                <span className="qs-nav"><button type="button" className="secondary" onClick={() => setEditing(true)}>Edit title and description</button><a className="button secondary" href={`/listings/${id}/edit`}>Edit all details</a></span>
              </>
            )}
            {note && <p role="status">{note}</p>}
          </section>

          {summary?.state === "ok" && summary.findings.length > 0 && (
            <section className="panel" aria-labelledby="insp-h">
              <h2 id="insp-h">From your building inspection report</h2>
              <p className="muted">Elena read the report and listed what it says. She added nothing of her own. Check these against the report before adding them.</p>
              <ul>{summary.findings.map(f => <li key={f.text}>{f.text}</li>)}</ul>
              {!(listing.description ?? "").includes(summary.paragraph) && <button type="button" className="secondary" onClick={addFindings}>Add these to my description</button>}
            </section>
          )}
          {summary && (summary.state === "no_text" || summary.state === "unavailable") && (
            <p className="muted">Elena could not read your inspection report{summary.state === "unavailable" ? " (the AI reader is off)" : " (it looks like a scan)"}. Read it yourself before you approve.</p>
          )}

          <ElenaPriceSuggestion listingId={id} rent={listing.transactionType === "rent"} editHref={`/listings/${id}/edit`} />

          <section className="panel" aria-labelledby="gate-h">
            <h2 id="gate-h">{check === null ? "Checking…" : blocked === 0 ? "Ready to publish" : `${blocked} ${blocked === 1 ? "thing" : "things"} stopping you from publishing`}</h2>
            {blocked > 0 && (
              <ul className="elena-findings" aria-label="Blocking publishing">
                {blockers.map(f => <li key={f.id}><span className="badge badge-rejected">Fix</span><span className="elena-msg">{f.message}</span><a className="elena-fix" href={f.fixHref}>Fix this</a></li>)}
                {extra.map(r => <li key={r}><span className="badge badge-rejected">Fix</span><span className="elena-msg">{r}</span><a className="elena-fix" href={`/listings/${id}/disclosures`}>State papers and payment</a></li>)}
              </ul>
            )}
            {tips.length > 0 && <ul className="elena-findings" aria-label="Suggestions">{tips.map(f => <li key={f.id}><span className="badge sensitive">Tip</span><span className="elena-msg">{f.message}</span><a className="elena-fix" href={f.fixHref}>Review</a></li>)}</ul>}
            <div className="form-bar">
              <button type="button" onClick={approve} disabled={check === null || blocked > 0 || editing || phase === "publishing"}>{phase === "publishing" ? "Publishing…" : "Approve and publish"}</button>
              <button type="button" className="secondary" onClick={() => void runCheck()}>Check again</button>
            </div>
            <p className="muted">Publishing needs your state's papers approved by our Compliance team and a verified trust account. Elena never publishes for you.</p>
          </section>
        </>
      )}
    </main>
  );
}
