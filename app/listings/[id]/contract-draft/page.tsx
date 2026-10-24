"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { canDraftFrom, DRAFT_LABEL, type ContractDraft } from "../../../../src/domain/contract-draft";
import { JSON_HEADERS } from "../../ui";
import "../../../styles/offers.css";

type Offer = { id: string; priceCents: number; status: string };
const dollars = (cents: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);

/** Owner-only preview of a contract or lease draft from a template. Preview only: nothing is saved, sent or signed. */
export default function ContractDraftPage() {
  const { id } = useParams<{ id: string }>();
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [draft, setDraft] = useState<ContractDraft | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/listings/${id}/offers`).then(async r => {
      const d = await r.json().catch(() => ({}));
      if (r.ok) setOffers(d.offers);
      else setError(r.status === 401 ? "Sign in to preview a draft." : r.status === 404 ? "Listing not found." : d.error ?? "Could not load offers.");
    }).catch(() => setError("Could not load offers."));
  }, [id]);

  const preview = async (offerId: string) => {
    setBusy(true);
    setError("");
    const r = await fetch(`/api/listings/${id}/contract-draft`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ offerId }) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (r?.ok) setDraft(d.draft); else { setDraft(null); setError(d.error ?? "Could not make the draft."); }
  };

  return (
    <main>
      <h1>Contract draft preview</h1>
      <div className="notice"><strong>{DRAFT_LABEL}</strong>Preview only. It is not saved, sent or signed, and it does not accept any offer.</div>
      {error ? <p role="alert">{error}</p> : null}
      {!error && offers === null ? <p className="muted" role="status">Loading offers…</p> : null}
      {offers && offers.filter(o => canDraftFrom(o.status)).length === 0 ? <p className="empty">No offer available to draft from.</p> : null}
      <ul className="card-list">
        {offers?.filter(o => canDraftFrom(o.status)).map(o => (
          <li key={o.id}>
            <strong>{dollars(o.priceCents)}</strong> <span className="muted">{o.status.replace(/_/g, " ")}</span>
            <div className="actions"><button type="button" className="secondary" onClick={() => preview(o.id)} disabled={busy}>Preview draft</button></div>
          </li>
        ))}
      </ul>
      {draft ? (
        <article className="panel" aria-label={draft.title}>
          <p><strong>{draft.label}</strong></p>
          <h2>{draft.title}</h2>
          {draft.sections.map(s => (
            <section key={s.heading}>
              <h3>{s.heading}</h3>
              {s.lines.map((l, i) => <p key={i}>{l}</p>)}
            </section>
          ))}
          <p><strong>{draft.label}</strong> <small className="muted">Template {draft.templateVersion}</small></p>
        </article>
      ) : null}
      <p><a href={`/listings/${id}/offer-analysis`}>Back to comparison</a> · <a href={`/listings/${id}/offers`}>Offers</a></p>
    </main>
  );
}
