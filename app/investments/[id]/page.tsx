"use client";
import { use, useEffect, useState } from "react";
import { dollarsToCents } from "../../../src/domain/listing-details";
import { aud, label, send, STATUS_LABEL, type Project } from "../ui";

export default function ProjectDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [p, setP] = useState<Project | null>(null);
  const [mine, setMine] = useState(false);
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
  return (
    <main>
      <h1>{p.title}</h1>
      <ul className="inv-meta">
        <li>{p.location}, {p.jurisdiction}</li><li>{label(p.projectType)}</li><li>Stage: {label(p.stage)}</li>
        <li>{p.visibleTo === "wholesale_only" ? "Wholesale and sophisticated investors only" : "All verified investors"}</li>
      </ul>
      {mine && <p><span className={`inv-status ${p.status}`}>{STATUS_LABEL[p.status]}</span> {p.reviewReason && <span className="muted">Staff note: {p.reviewReason}</span>}</p>}
      <section className="panel"><h2>Summary</h2><p className="inv-section">{p.summary}</p></section>
      <section className="panel">
        <h2>Indicative figures</h2>
        <p>Funding target {aud(p.fundingTargetCents)} · minimum {aud(p.minimumTicketCents)}</p>
        <p className="muted">Indicative only. Nothing is collected on this platform.</p>
      </section>
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
      {mine ? (
        <div className="actions">{p.status !== "rejected" && <a className="button" href={`/investments/${p.id}/edit`}>Edit (goes back to review)</a>}</div>
      ) : (
        <section className="panel">
          <h2>Express interest</h2>
          <p className="muted">Non-binding. This only opens a conversation with the project owner. It is not an application, commitment or payment.</p>
          <form className="inv-form" onSubmit={interest}>
            <label>Message to the owner<textarea name="message" rows={4} maxLength={4000} required /></label>
            <label>Indicative amount from (AUD)<input name="min" inputMode="decimal" required /></label>
            <label>Indicative amount to (AUD)<input name="max" inputMode="decimal" required /></label>
            <button type="submit" disabled={busy}>{busy ? "Sending…" : "Send non-binding interest"}</button>
          </form>
        </section>
      )}
      {note && <p role="status">{note}</p>}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
