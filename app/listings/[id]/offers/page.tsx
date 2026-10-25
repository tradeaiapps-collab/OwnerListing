"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { isUuid, type OwnerDecision } from "../../../../src/domain/offer-decision";
import { offerStatusLabel } from "../../../../src/domain/offer-display";
import { buildOfferUrl } from "../../../../src/domain/offer-form";
import { JSON_HEADERS } from "../../ui";
import { AiSuggestions } from "./ai-suggestions";
import "../../../styles/offers.css";

/** aiAnalysis is shown read-only if the API ever returns one. It never carries a decision. */
type Offer = { id: string; priceCents: number; conditions: string[]; settlementDays: number; depositCents: number; status: string; submittedAt: string; round?: number; openCounter?: { priceCents: number }; aiAnalysis?: string };

const dollars = (cents: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);

const CONFIRM: Record<OwnerDecision, { title: string; text: string; button: string }> = {
  accept: { title: "Accept this offer?", text: "This records your decision only. No money moves on this site; deposits go to the solicitor's trust account.", button: "Yes, accept" },
  reject: { title: "Reject this offer?", text: "The buyer will be told it was not accepted.", button: "Yes, reject" },
  counter_request: { title: "Ask the buyer for a counter?", text: "This asks the buyer to improve their offer. Nothing is accepted.", button: "Yes, ask for a counter" }
};

/** Owner view of formal offers on one listing. Only the owner decides (the AI never accepts); no buyer identity is shown here. */
export default function Offers() {
  const { id } = useParams<{ id: string }>();
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [buyerId, setBuyerId] = useState("");
  const [link, setLink] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState<{ offerId: string; decision: OwnerDecision } | null>(null);
  const [deciding, setDeciding] = useState(false);

  const load = () => {
    fetch(`/api/listings/${id}/offers`)
      .then(async r => {
        const d = await r.json();
        if (r.ok) setOffers(d.offers);
        else if (r.status === 401) setError("Sign in to see offers on your listing.");
        else if (r.status === 404) setError("Listing not found.");
        else setError(d.error ?? "Could not load offers.");
      })
      .catch(() => setError("Could not load offers."));
  };

  useEffect(() => {
    setOffers(null);
    setError("");
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const decide = async () => {
    if (!pending) return;
    setNotice("");
    setDeciding(true);
    const r = await fetch(`/api/listings/${id}/offers/${pending.offerId}/decision`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ decision: pending.decision })
    }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setDeciding(false);
    setPending(null);
    setNotice(r?.ok ? "Decision recorded." : d.error ?? "Could not record that decision.");
    load();
  };

  const issueLink = async () => {
    setNotice("");
    setLink("");
    setCopied(false);
    setIssuing(true);
    const r = await fetch(`/api/listings/${id}/offer-links`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ buyerUserId: buyerId.trim() })
    }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setIssuing(false);
    if (r?.ok) setLink(buildOfferUrl(window.location.origin, id, String(d.token)));
    else setNotice(d.error ?? "Could not create the link.");
  };

  const copy = () => navigator.clipboard.writeText(link).then(() => setCopied(true), () => setNotice("Copy failed. Select the link and copy it."));

  const open = (s: string) => s === "submitted" || s === "under_review" || s === "countered" || s === "buyer_countered";
  const idOk = isUuid(buyerId.trim());

  return (
    <main>
      <h1>Offers</h1>
      <p>Formal offers submitted through the offer form. The AI never accepts an offer: you decide. Open an offer to send a counter-offer with your own terms.</p>
      <p><a href={`/listings/${id}/offer-analysis`}>Compare offers</a> · <a href={`/listings/${id}/mandate`}>Negotiation mandate</a> · <a href={`/listings/${id}/contract-draft`}>Preview a contract draft</a></p>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <section className="panel">
        <h2>Invite a verified buyer to make an offer</h2>
        <div className="actions">
          <input className="grow" aria-label="Buyer ID" placeholder="Buyer ID (from the chat)" value={buyerId} onChange={e => setBuyerId(e.target.value)} />
          <button type="button" onClick={issueLink} disabled={!idOk || issuing}>{issuing ? "Creating…" : "Create single-use link"}</button>
        </div>
        {buyerId.trim() !== "" && !idOk ? <small className="muted">A buyer ID looks like 123e4567-e89b-12d3-a456-426614174000.</small> : null}
        {link ? (
          <div>
            <p>Send this link to the buyer in the chat. It is shown once, works once, for this buyer only, and expires in 24 hours.</p>
            <div className="copy-row">
              <code>{link}</code>
              <button type="button" className="secondary" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
            </div>
          </div>
        ) : null}
      </section>
      {!error && offers === null ? <p className="muted" role="status">Loading offers…</p> : null}
      {offers && offers.length === 0 ? <p className="empty">No offers yet.</p> : null}
      <ul className="card-list">
        {offers?.map(o => (
          <li key={o.id}>
            <strong><a href={`/listings/${id}/offers/${o.id}`}>{dollars(o.priceCents)}</a></strong> <span className={`badge badge-${o.status}`}>{offerStatusLabel(o.status, "owner", o.openCounter ? { fromParty: "owner", status: "open" } : undefined)}</span>
            <div>Deposit {dollars(o.depositCents)} · Settlement {o.settlementDays} days</div>
            <div>{o.conditions.length > 0 ? `Conditions: ${o.conditions.join("; ")}` : "No conditions"}</div>
            <small className="muted">Submitted {new Date(o.submittedAt).toLocaleString("en-AU")}{o.round ? ` · ${o.round} counter-offer${o.round === 1 ? "" : "s"}` : ""} · <a href={`/listings/${id}/offers/${o.id}`}>{open(o.status) ? "Open, negotiate and see the timeline" : "View offer, timeline and messages"}</a></small>
            {o.openCounter ? <div className="muted">Your counter of {dollars(o.openCounter.priceCents)} is waiting for the buyer.</div> : null}
            {open(o.status) ? <AiSuggestions listingId={id} offerId={o.id} /> : null}
            {o.aiAnalysis ? <div className="ai-note"><strong>AI analysis</strong> (a note only; you decide)<br />{o.aiAnalysis}</div> : null}
            {open(o.status) && pending?.offerId === o.id ? (
              <div className="confirm-box" role="alertdialog" aria-label={CONFIRM[pending.decision].title}>
                <strong>{CONFIRM[pending.decision].title}</strong>
                <p>{CONFIRM[pending.decision].text}</p>
                <div className="actions">
                  <button type="button" onClick={decide} disabled={deciding}>{deciding ? "Saving…" : CONFIRM[pending.decision].button}</button>
                  <button type="button" className="secondary" onClick={() => setPending(null)} disabled={deciding}>Cancel</button>
                </div>
              </div>
            ) : open(o.status) && !o.openCounter ? (
              <div className="actions">
                <button type="button" onClick={() => setPending({ offerId: o.id, decision: "accept" })}>Accept</button>
                <button type="button" className="secondary" onClick={() => setPending({ offerId: o.id, decision: "reject" })}>Reject</button>
                {o.status === "submitted" || o.status === "under_review" ? <button type="button" className="secondary" onClick={() => setPending({ offerId: o.id, decision: "counter_request" })}>Request counter</button> : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </main>
  );
}
