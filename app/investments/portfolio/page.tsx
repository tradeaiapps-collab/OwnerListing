"use client";
import { useEffect, useState } from "react";
import type { Portfolio, PortfolioProject } from "../../../src/domain/investor-portfolio";
import { aud, label, STEP_LINK } from "../ui";

const STAGE: Record<string, string> = { concept: "Concept", planning: "In planning", approved: "Plans approved", construction: "Under construction", completed: "Completed" };
const CONTRACT: Record<string, string> = { none: "No contract yet", submitted: "Contract submitted, with staff", returned: "Contract returned to you", rejected: "Contract rejected" };
const when = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
const n = (x: number, one: string, many = `${one}s`) => `${x} ${x === 1 ? one : many}`;

function Tile({ value, name, hint }: { value: string; name: string; hint?: string }) {
  return <div className="pf-tile"><dt>{name}</dt><dd>{value}</dd>{hint && <small>{hint}</small>}</div>;
}

function Card({ p }: { p: PortfolioProject }) {
  const q = p.questions;
  return (
    <li className="pf-card">
      <header className="pf-card-head">
        <div>
          <p className="pcard-eyebrow">{label(p.projectType)} · {STAGE[p.stage] ?? label(p.stage)}</p>
          <h2><a href={`/investments/${p.id}`}>{p.title}</a></h2>
          <p className="muted">{p.location}, {p.jurisdiction}</p>
        </div>
        <ul className="inv-meta" aria-label="Your status">
          {p.following && <li>Following</li>}
          {p.interest && <li>Interest registered</li>}
        </ul>
      </header>

      {p.attention.length > 0 && (
        <ul className="pf-attention" aria-label="Needs a look">{p.attention.map(a => <li key={a}>{a}</li>)}</ul>
      )}

      <dl className="pf-facts">
        <div>
          <dt>Your interest</dt>
          <dd>{p.interest ? <>{aud(p.interest.amountMinCents)} to {aud(p.interest.amountMaxCents)}<small>Non-binding. {CONTRACT[p.interest.contractStatus]}. <a href={`/investments/threads/${p.interest.threadId}`}>Open conversation</a></small></> : <>Not registered<small><a href={`/investments/${p.id}`}>Register interest on the project page</a></small></>}</dd>
        </div>
        <div>
          <dt>Documents</dt>
          <dd>{n(p.documents.available, "document")} to read<small>{p.documents.waitingForMasking > 0 ? `${p.documents.waitingForMasking} waiting for address masking. ` : ""}{p.documents.lastAddedAt ? `Latest added ${when(p.documents.lastAddedAt)}.` : ""}</small></dd>
        </div>
        <div>
          <dt>Elena Q&amp;A</dt>
          <dd>{q.asked === 0 ? "No questions yet" : n(q.asked, "question")}<small>{q.asked > 0 ? `${q.answered} answered from documents, ${q.passedToOwner} passed to the owner, ${n(q.ownerReplies, "owner reply", "owner replies")}. ` : ""}<a href={`/investments/${p.id}/elena`}>Ask Elena</a></small></dd>
        </div>
        <div>
          <dt>Target and minimum</dt>
          <dd>{aud(p.fundingTargetCents)}<small>Minimum {aud(p.minimumTicketCents)}</small></dd>
        </div>
      </dl>

      <section aria-label="Project updates">
        <h3>Owner-approved updates</h3>
        {p.updates.items.length === 0
          ? <p className="muted">No updates published yet.</p>
          : <ul className="pf-updates">{p.updates.items.map(u => <li key={u.id}><span>{u.title}{u.isNew && <b className="pf-new">New</b>}</span><time dateTime={u.publishedAt}>{when(u.publishedAt)}</time></li>)}</ul>}
      </section>
    </li>
  );
}

/** Investor portfolio: followed projects and registered interest in one place. Read only; interest is non-binding and Elena never commits money. */
export default function Portfolio() {
  const [data, setData] = useState<Portfolio | null>(null);
  const [error, setError] = useState("");
  const [step, setStep] = useState("");

  const load = () => {
    setError(""); setStep(""); setData(null);
    void fetch("/api/investments/portfolio").then(async r => {
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setData(d); return; }
      if (r.status === 404) setError("Investor projects are not open yet. Please check back soon.");
      else if (r.status === 401) { setError("Sign in with an investor (buyer) account to see your portfolio."); setStep("investor_account"); }
      else { setError(d.error ?? "Could not load your portfolio."); setStep(d.step ?? ""); }
    }).catch(() => setError("Could not load your portfolio."));
  };
  useEffect(load, []);

  const link = STEP_LINK[step];
  const s = data?.summary;
  return (
    <main className="pf-page">
      <header className="inv-page-head">
        <div>
          <h1>My portfolio</h1>
          <p className="muted">Projects you follow or have registered interest in. Interest is non-binding and nothing here is a commitment of money.</p>
        </div>
        <nav className="inv-page-links" aria-label="Investor pages">
          <a href="/investments">Browse projects</a>
          <a href="/investments/threads">My conversations</a>
        </nav>
      </header>

      {error && <p role="alert" className="inv-visitor">{error} {link && <a href={link[0]}>{link[1]}</a>} {!link && <button type="button" onClick={load}>Try again</button>}</p>}
      {!data && !error && (
        <>
          <p className="sr-only" role="status">Loading…</p>
          <div className="pf-tiles is-skeleton" aria-hidden="true">{[0, 1, 2, 3].map(i => <span key={i} className="pf-tile" />)}</div>
          <ul className="pf-cards" aria-hidden="true">{[0, 1].map(i => <li key={i} className="pf-card is-skeleton" />)}</ul>
        </>
      )}

      {data && s && (
        <>
          <dl className="pf-tiles" aria-label="Portfolio summary">
            <Tile name="Projects" value={String(s.projects)} hint={`${s.following} followed, ${s.interests} with interest`} />
            <Tile name="Indicative interest" value={s.interests === 0 ? "None yet" : s.indicativeMinCents === s.indicativeMaxCents ? aud(s.indicativeMinCents) : `${aud(s.indicativeMinCents)} to ${aud(s.indicativeMaxCents)}`} hint="Non-binding range you entered" />
            <Tile name="Documents to read" value={String(s.documentsAvailable)} hint={s.documentsWaiting ? `${s.documentsWaiting} waiting for masking` : "Address-masked by staff"} />
            <Tile name="New updates" value={String(s.newUpdates)} hint="Last 30 days" />
          </dl>
          {data.truncated && <p className="muted" role="status">Showing your {s.projects} most recently active projects.</p>}
          {data.projects.length === 0
            ? <div className="empty"><p>You are not following any projects yet.</p><p><a className="button" href="/investments">Browse projects</a></p></div>
            : <ul className="pf-cards">{data.projects.map(p => <Card key={p.id} p={p} />)}</ul>}
        </>
      )}
    </main>
  );
}
