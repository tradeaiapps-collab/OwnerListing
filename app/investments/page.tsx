"use client";
import { useEffect, useMemo, useState } from "react";
import { AU_JURISDICTIONS } from "../../src/domain/jurisdiction";
import { filterProjects, PROJECT_STAGES, PROJECT_TYPES, type ProjectFilter } from "../../src/domain/investor-projects";
import { aud, label, STEP_LINK, type Project } from "./ui";

const MIN_TICKET_CAPS = [10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000];

type Card = Pick<Project, "id" | "title" | "location" | "jurisdiction" | "projectType" | "summary" | "stage" | "fundingTargetCents" | "minimumTicketCents" | "issuerName">;

/** Approved projects. Ready investors get their own list; everyone else gets the public cards and a pointer to the next step. Not an offer; interest is non-binding. */
export default function BrowseProjects() {
  const [items, setItems] = useState<Card[] | null>(null);
  const [error, setError] = useState("");
  const [step, setStep] = useState("");
  const [visitor, setVisitor] = useState("");
  const [filter, setFilter] = useState<ProjectFilter>({});

  useEffect(() => {
    void (async () => {
      const r = await fetch("/api/investments/projects");
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setItems(d.items ?? []); return; }
      if (r.status !== 401 && r.status !== 403) { setError(d.error ?? "Could not load."); return; }
      setVisitor(r.status === 401 ? "Sign in as an investor to see full details, risks and contract terms." : d.error ?? "");
      setStep(r.status === 401 ? "investor_account" : d.step ?? "");
      const pub = await fetch("/api/investments/public");
      const pd = await pub.json().catch(() => ({}));
      if (pub.ok) setItems(pd.items ?? []); else setError(pd.error ?? "Could not load.");
    })().catch(() => setError("Could not load."));
  }, []);

  const shown = useMemo(() => (items ? filterProjects(items, filter) : null), [items, filter]);
  const set = (k: keyof ProjectFilter, v: string) => setFilter(f => ({ ...f, [k]: k === "maxMinimumCents" ? (v ? Number(v) : undefined) : v || undefined }));
  const filtered = Object.values(filter).some(v => v !== undefined && v !== "");

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
      {visitor && !error && <p className="inv-visitor">{visitor} {link && <a href={link[0]}>{link[1]}</a>}</p>}
      {items !== null && items.length > 0 && (
        <form className="inv-filters" role="search" aria-label="Filter projects" onSubmit={e => e.preventDefault()}>
          <label className="inv-filter-q">Search<input type="search" value={filter.q ?? ""} placeholder="Title, suburb, issuer…" onChange={e => set("q", e.target.value)} /></label>
          <label>State<select value={filter.jurisdiction ?? ""} onChange={e => set("jurisdiction", e.target.value)}>
            <option value="">All</option>{AU_JURISDICTIONS.map(j => <option key={j}>{j}</option>)}
          </select></label>
          <label>Type<select value={filter.projectType ?? ""} onChange={e => set("projectType", e.target.value)}>
            <option value="">All</option>{PROJECT_TYPES.map(t => <option key={t} value={t}>{label(t)}</option>)}
          </select></label>
          <label>Stage<select value={filter.stage ?? ""} onChange={e => set("stage", e.target.value)}>
            <option value="">All</option>{PROJECT_STAGES.map(s => <option key={s} value={s}>{label(s)}</option>)}
          </select></label>
          <label>Minimum up to<select value={filter.maxMinimumCents ?? ""} onChange={e => set("maxMinimumCents", e.target.value)}>
            <option value="">Any</option>{MIN_TICKET_CAPS.map(d => <option key={d} value={d * 100}>{aud(d * 100)}</option>)}
          </select></label>
          {filtered && <button type="button" onClick={() => setFilter({})}>Clear</button>}
        </form>
      )}
      {items === null && !error && <p className="muted" role="status">Loading…</p>}
      {items?.length === 0 && <p className="empty">{visitor ? "No projects are listed right now." : "No projects are open to you right now."}</p>}
      {items !== null && items.length > 0 && <p className="muted" role="status">{shown?.length} of {items.length} projects</p>}
      {items !== null && items.length > 0 && shown?.length === 0 && <p className="empty">No projects match these filters.</p>}
      <ul className="card-list">
        {shown?.map(p => (
          <li key={p.id}>
            <h2><a href={`/investments/${p.id}`}>{p.title}</a></h2>
            <ul className="inv-meta">
              <li>{p.location}, {p.jurisdiction}</li><li>{label(p.projectType)}</li><li>Stage: {label(p.stage)}</li>
            </ul>
            <p className="muted">Issuer: {p.issuerName}</p>
            <p className="inv-section">{p.summary.length > 240 ? `${p.summary.slice(0, 240)}…` : p.summary}</p>
            <p className="muted">Indicative target {aud(p.fundingTargetCents)} · indicative minimum {aud(p.minimumTicketCents)}</p>
            <a href={`/investments/${p.id}`}>View project and contract terms</a>
          </li>
        ))}
      </ul>
    </main>
  );
}
