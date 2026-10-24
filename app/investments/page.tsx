"use client";
import { useEffect, useState } from "react";
import { aud, label, STEP_LINK, type Project } from "./ui";

/** Approved projects this investor may see. Not an offer; interest is non-binding. */
export default function BrowseProjects() {
  const [items, setItems] = useState<Project[] | null>(null);
  const [error, setError] = useState("");
  const [step, setStep] = useState("");

  useEffect(() => {
    void fetch("/api/investments/projects").then(async r => {
      const d = await r.json().catch(() => ({}));
      if (r.ok) setItems(d.items ?? []);
      else { setError(r.status === 401 ? "Sign in to see investor projects." : d.error ?? "Could not load."); setStep(d.step ?? ""); }
    }).catch(() => setError("Could not load."));
  }, []);

  const link = STEP_LINK[step];
  return (
    <main>
      <h1>Investor projects</h1>
      <div className="actions">
        <a href="/investments/threads">My conversations</a>
        <a href="/investments/mine">My posted projects</a>
        <a href="/investments/new">Post a project</a>
      </div>
      {error && <p role="alert">{error} {link && <a href={link[0]}>{link[1]}</a>}</p>}
      {items === null && !error && <p className="muted" role="status">Loading…</p>}
      {items?.length === 0 && <p className="empty">No projects are open to you right now.</p>}
      <ul className="card-list">
        {items?.map(p => (
          <li key={p.id}>
            <h2><a href={`/investments/${p.id}`}>{p.title}</a></h2>
            <ul className="inv-meta">
              <li>{p.location}, {p.jurisdiction}</li><li>{label(p.projectType)}</li><li>Stage: {label(p.stage)}</li>
            </ul>
            <p className="inv-section">{p.summary.length > 240 ? `${p.summary.slice(0, 240)}…` : p.summary}</p>
            <p className="muted">Indicative target {aud(p.fundingTargetCents)} · indicative minimum {aud(p.minimumTicketCents)}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
