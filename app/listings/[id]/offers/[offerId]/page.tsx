"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { MAX_COUNTER_ROUNDS } from "../../../../../src/domain/offer-counter";
import { offerStatusLabel } from "../../../../../src/domain/offer-display";
import type { TimelineEvent } from "../../../../../src/domain/offer-timeline";
import { CounterForm, dollars, OfferTimeline, TermsLine, when, type Counter, type Terms } from "../../../../offers/negotiation";
import { JSON_HEADERS } from "../../../ui";
import "../../../../styles/offers.css";

type Offer = Terms & { id: string; status: string; submittedAt: string; round: number; awaiting: "owner" | "buyer" | null; openCounter?: Terms & { id: string; expiresAt: string } };
type Detail = { offer: Offer; counters: Counter[]; timeline: TimelineEvent[]; canDecide: boolean };
type Pending = "accept" | "reject" | "counter" | null;

/**
 * Owner view of one offer and its negotiation. The owner accepts, rejects or counters; the AI never does. An appointed agent
 * can read this page but gets no actions. No buyer identity is shown.
 */
export default function OfferDetail() {
  const { id, offerId } = useParams<{ id: string; offerId: string }>();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    fetch(`/api/listings/${id}/offers/${offerId}`)
      .then(async r => {
        const d = await r.json();
        if (r.ok) setData(d as Detail);
        else setError(r.status === 401 ? "Sign in to see this offer." : r.status === 404 ? "Offer not found." : d.error ?? "Could not load the offer.");
      })
      .catch(() => setError("Could not load the offer."));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [id, offerId]);

  const send = async (url: string, body: unknown, ok: string) => {
    setBusy(true);
    setNotice("");
    const r = await fetch(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    setPending(null);
    setNotice(r?.ok ? ok : d.error ?? "Could not save that.");
    load();
  };
  const decide = (decision: "accept" | "reject") =>
    send(`/api/listings/${id}/offers/${offerId}/decision`, { decision }, decision === "accept" ? "Offer accepted. Your solicitor prepares the contract." : "Offer rejected.");

  if (error) return <main><h1>Offer</h1><p role="alert">{error}</p></main>;
  if (!data) return <main><p className="muted" role="status">Loading offer…</p></main>;
  const { offer, counters, timeline, canDecide } = data;
  const latest = counters.at(-1);
  const ownersTurn = offer.awaiting === "owner";
  // After a plain "request a counter" the owner may still accept or reject the buyer's terms while waiting.
  const canAct = ownersTurn || (offer.status === "countered" && !offer.openCounter);
  const canCounter = ownersTurn && offer.round < MAX_COUNTER_ROUNDS;
  const agreed = offer.status === "buyer_countered" && latest?.status === "agreed";

  return (
    <main>
      <p><a href={`/listings/${id}/offers`}>← All offers</a></p>
      <h1>Offer {offer.round > 0 ? `· round ${offer.round}` : ""}</h1>
      <p><span className={`badge badge-${offer.status}`}>{offerStatusLabel(offer.status, "owner", latest)}</span></p>
      {notice ? <p role="status">{notice}</p> : null}
      <section className="panel">
        <h2>{agreed ? "Terms the buyer agreed to" : "Buyer's terms on the table"}</h2>
        <TermsLine t={offer} />
        {offer.openCounter ? (
          <p className="muted">Your counter of {dollars(offer.openCounter.priceCents)} is waiting for the buyer until {when(offer.openCounter.expiresAt)}.</p>
        ) : null}
      </section>

      {canDecide && canAct ? (
        <section className="panel">
          <h2>Your decision</h2>
          <p className="muted">Only you can accept. Accepting records your decision only: no money moves on this site, and deposits go to the solicitor's trust account.</p>
          {pending === "accept" || pending === "reject" ? (
            <div className="confirm-box" role="alertdialog" aria-label={pending === "accept" ? "Accept these terms?" : "Reject this offer?"}>
              <strong>{pending === "accept" ? "Accept these terms?" : "Reject this offer?"}</strong>
              {pending === "accept" ? <TermsLine t={offer} /> : <p>The negotiation ends and the buyer is told.</p>}
              <div className="actions">
                <button type="button" onClick={() => decide(pending)} disabled={busy}>{busy ? "Saving…" : pending === "accept" ? "Yes, accept" : "Yes, reject"}</button>
                <button type="button" className="secondary" onClick={() => setPending(null)} disabled={busy}>Cancel</button>
              </div>
            </div>
          ) : pending === "counter" ? (
            <>
              <CounterForm start={offer} busy={busy} submitLabel="Send counter-offer"
                onSubmit={body => send(`/api/listings/${id}/offers/${offerId}/counter`, body, "Counter-offer sent to the buyer.")} />
              <div className="actions"><button type="button" className="secondary" onClick={() => setPending(null)}>Cancel</button></div>
            </>
          ) : (
            <div className="actions">
              <button type="button" onClick={() => setPending("accept")}>Accept</button>
              {canCounter ? <button type="button" className="secondary" onClick={() => setPending("counter")}>Counter</button> : null}
              <button type="button" className="secondary" onClick={() => setPending("reject")}>Reject</button>
            </div>
          )}
        </section>
      ) : null}
      {!canDecide ? <p className="muted">You can view this negotiation. Only the owner can accept, reject or counter.</p> : null}

      <h2>Timeline</h2>
      <OfferTimeline events={timeline} viewer="owner" />
    </main>
  );
}
