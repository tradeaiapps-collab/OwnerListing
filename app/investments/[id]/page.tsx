"use client";
import { use, useEffect, useState } from "react";
import { dollarsToCents } from "../../../src/domain/listing-details";
import type { PhotoView } from "../../../src/domain/listing-photos";
import { STAGE_TAG } from "../project-card";
import { ProjectSlider } from "../project-slider";
import { aud, label, send, STATUS_LABEL, type Project } from "../ui";

export default function ProjectDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [p, setP] = useState<Project | null>(null);
  const [mine, setMine] = useState(false);
  const [photos, setPhotos] = useState<PhotoView[]>([]);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch(`/api/investments/projects/${id}`).then(async r => {
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setP(d.project); setMine(d.mine === true); }
      else setError(r.status === 401 ? "Sign in as an investor to see the full project, risks and contract terms."
        : r.status === 404 ? "Project not found, or it is open only to verified investors who have made the investor declaration." : d.error ?? "Could not load.");
    }).catch(() => setError("Could not load."));
    // Photos are optional: a failure just leaves the gallery out.
    void fetch(`/api/investments/projects/${id}/photos`).then(async r => (r.ok ? r.json() : { photos: [] }))
      .then(d => setPhotos(((d.photos ?? []) as PhotoView[]).filter(x => !x.hidden))).catch(() => setPhotos([]));
  }, [id]);

  async function interest(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(""); setNote("");
    const fd = new FormData(e.currentTarget);
    const lo = dollarsToCents(String(fd.get("min") ?? "")), hi = dollarsToCents(String(fd.get("max") ?? ""));
    if (lo === undefined || hi === undefined) { setError("Enter the indicative range in dollars."); return; }
    setBusy(true);
    const r = await send(`/api/investments/projects/${id}/interest`, "POST", { message: fd.get("message"), amountMinCents: lo, amountMaxCents: hi });
    setBusy(false);
    if (r.ok) window.location.assign(`/investments/threads/${(r.data["interest"] as { id: string }).id}`);
    else setError(String(r.data["error"] ?? "Could not send."));
  }

  if (!p) return (
    <main><h1>Project</h1>
      {error ? <p role="alert">{error} <a href="/investments/investor">Check your investor status</a></p> : <p className="muted" role="status">Loading…</p>}
      {error && <p><a href="/investments">Back to all projects</a></p>}
    </main>
  );
  const where = `${p.location}, ${p.jurisdiction}`;
  return (
    <main className="inv-detail">
      <p className="inv-back"><a href={mine ? "/investments/mine" : "/investments"}>{mine ? "Back to my posted projects" : "Back to all projects"}</a></p>
      <header className="inv-head">
        <div>
          <p className="inv-eyebrow">{label(p.projectType)} · {STAGE_TAG[p.stage] ?? label(p.stage)}</p>
          <h1>{p.title}</h1>
          <p className="inv-where">{where}</p>
        </div>
        {mine && <span className={`inv-status ${p.status}`}>{STATUS_LABEL[p.status]}</span>}
      </header>
      {mine && p.reviewReason && <p className="inv-visitor">Staff note: {p.reviewReason}</p>}

      <div className="inv-layout">
        {photos.length > 0 ? (
          <div className="inv-media"><ProjectSlider photos={photos} title={p.title} /></div>
        ) : mine && p.status !== "rejected" && (
          <div className="inv-media inv-photo-cta"><span>No photos yet. <a href={`/investments/${p.id}/photos`}>Add project photos</a></span></div>
        )}
        <aside className="inv-aside" aria-label="Key figures">
          <div className="panel inv-facts">
            <dl>
              <div><dt>Indicative target</dt><dd className="inv-big">{aud(p.fundingTargetCents)}</dd></div>
              <div><dt>Indicative minimum</dt><dd>{aud(p.minimumTicketCents)}</dd></div>
              <div><dt>Stage</dt><dd>{STAGE_TAG[p.stage] ?? label(p.stage)}</dd></div>
              <div><dt>Open to</dt><dd>{p.visibleTo === "wholesale_only" ? "Wholesale and sophisticated investors" : "All verified investors"}</dd></div>
              <div><dt>Issuer</dt><dd>{p.issuerName}</dd></div>
            </dl>
            <p className="muted inv-small">Indicative only. Nothing is collected on this platform.</p>
            {mine ? (
              <div className="inv-aside-actions">
                {p.status !== "rejected" && <a className="button" href={`/investments/${p.id}/edit`}>Edit (goes back to review)</a>}
                {p.status !== "rejected" && <a className="button secondary" href={`/investments/${p.id}/photos`}>Manage photos</a>}
              </div>
            ) : (
              <div className="inv-aside-actions"><a className="button" href="#interest">Express interest</a></div>
            )}
          </div>
        </aside>

        <div className="inv-main">
          <section className="panel"><h2>Summary</h2><p className="inv-section">{p.summary}</p></section>
          <section className="panel"><h2>Timeline</h2><p className="inv-section">{p.timeline}</p></section>
          <section className="panel"><h2>Risks</h2><p className="inv-section">{p.risks}</p></section>
          <section className="panel"><h2>Structure</h2><p className="inv-section">{p.structureDescription}</p></section>
          <section className="panel">
            <h2>Issuer declaration</h2>
            <p><strong>Offered by:</strong> {p.issuerName}</p>
            <p><strong>Licence or exemption relied on:</strong> <span className="inv-section">{p.issuerLicenceBasis}</span></p>
            {p.issuerStatement && <p className="inv-section">{p.issuerStatement}</p>}
            <p className="muted">Stated by the issuer, not checked or endorsed by the platform.</p>
          </section>
          {!mine && (
            <section className="panel" id="interest">
              <h2>Express interest</h2>
              <p className="muted">Non-binding. This only opens a conversation with the project owner. It is not an application, commitment or payment.</p>
              <form className="inv-form" onSubmit={interest}>
                <label>Message to the owner<textarea name="message" rows={4} maxLength={4000} required /></label>
                <div className="inv-pair">
                  <label>Indicative amount from (AUD)<input name="min" inputMode="decimal" required /></label>
                  <label>Indicative amount to (AUD)<input name="max" inputMode="decimal" required /></label>
                </div>
                <button type="submit" disabled={busy}>{busy ? "Sending…" : "Send non-binding interest"}</button>
              </form>
            </section>
          )}
          {note && <p role="status">{note}</p>}
          {error && <p role="alert">{error}</p>}
        </div>

      </div>
    </main>
  );
}
