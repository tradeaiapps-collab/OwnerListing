"use client";
import { useEffect, useState } from "react";
import { ProjectCard, type CardProject } from "../project-card";
import { aud, send, STATUS_LABEL, type Project } from "../ui";

type Mine = Project & CardProject & { terms: { model: "commission_on_contract" | "upfront_fee"; upfrontFeeCents: number; upfrontFeeStatus: string } };
type Fee = { id: string; projectId: string; amountCents: number; status: "due" | "paid" | "waived"; createdAt: string };

/** The owner's projects with review status, posting model, and any platform fee notices. */
export default function MyProjects() {
  const [items, setItems] = useState<Mine[] | null>(null);
  const [fees, setFees] = useState<Fee[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.all([fetch("/api/investments/projects/mine"), fetch("/api/investments/fees")]).then(async ([r, f]) => {
      if (!r.ok) { setError(r.status === 401 ? "Sign in to see your projects." : "Could not load."); return; }
      setItems((await r.json()).items ?? []);
      if (f.ok) setFees((await f.json()).items ?? []);
    }).catch(() => setError("Could not load."));
  }, []);

  async function pay(id: string) {
    setError("");
    const r = await send(`/api/investments/projects/${id}/upfront-fee`, "POST", {});
    if (r.ok) window.location.assign(String(r.data["redirectUrl"]));
    else setError(String(r.data["error"] ?? "Payment is not available."));
  }

  const title = (pid: string) => items?.find(p => p.id === pid)?.title ?? "Project";
  return (
    <main className="inv-browse">
      <header className="inv-page-head">
        <div>
          <h1>My posted projects</h1>
          <p className="muted">Review status, photos and fees for the projects you posted.</p>
        </div>
        <nav className="inv-page-links" aria-label="Investor pages">
          <a href="/investments">All projects</a>
          <a href="/investments/threads">Conversations</a>
          <a className="button" href="/investments/new">Post a project</a>
        </nav>
      </header>
      {error && <p role="alert">{error}</p>}
      {fees.length > 0 && (
        <section className="panel">
          <h2>Platform fee notices</h2>
          <p className="muted">Our fee is invoiced to you after a signed contract is returned through us. It is never taken from investor money. Pay us directly; staff record the payment.</p>
          <ul className="card-list">
            {fees.map(f => <li key={f.id}>{title(f.projectId)}: {aud(f.amountCents)} <span className={`inv-status ${f.status === "due" ? "rejected" : "approved"}`}>{f.status}</span></li>)}
          </ul>
        </section>
      )}
      {items === null && !error && <p className="muted" role="status">Loading…</p>}
      {items?.length === 0 && <p className="empty">You have not posted a project yet.</p>}
      <ul className="pcards">
        {items?.map(p => (
          <ProjectCard key={p.id} p={p}>
            <p className="pcard-status"><span className={`inv-status ${p.status}`}>{STATUS_LABEL[p.status]}</span> <span className="muted">Version {p.version}</span></p>
            <p className="muted inv-small">Posted under {p.terms.model === "commission_on_contract" ? "Model 1 (free posting, commission after a returned contract)" : "Model 2 (upfront fee)"}</p>
            {p.reviewReason && <p className="muted inv-small">Staff note: {p.reviewReason}</p>}
            <div className="pcard-actions">
              {p.status !== "rejected" && <a className="button secondary" href={`/investments/${p.id}/edit`}>Edit</a>}
              {p.status !== "rejected" && <a className="button secondary" href={`/investments/${p.id}/photos`}>Photos</a>}
              {p.terms.model === "upfront_fee" && p.terms.upfrontFeeStatus === "unpaid" && <button type="button" onClick={() => void pay(p.id)}>Pay upfront fee {aud(p.terms.upfrontFeeCents)}</button>}
            </div>
          </ProjectCard>
        ))}
      </ul>
    </main>
  );
}
