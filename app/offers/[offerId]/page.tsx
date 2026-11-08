"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { MAX_COUNTER_ROUNDS } from "../../../src/domain/offer-counter";
import { offerStatusLabel } from "../../../src/domain/offer-display";
import type { TimelineEvent } from "../../../src/domain/offer-timeline";
import { CounterForm, OfferTimeline, TermsLine, when, type Counter, type Terms } from "../negotiation";
import { JSON_HEADERS } from "../../listings/ui";
import FallThroughPanel from "../fall-through-panel";
import "../../styles/offers.css";

type Offer = Terms & { id: string; listingId: string; listingTitle: string; status: string; submittedAt: string; awaiting: "owner" | "buyer" | null };
type Pending = "agree" | "counter" | "withdraw" | null;

const OPEN = ["submitted", "under_review", "countered", "buyer_countered"];

/**
 * The buyer's own offer. On the buyer's turn they can agree to the owner's counter (the owner then decides), counter with
 * new terms, or withdraw. The buyer never accepts: only the owner does.
 */
export default function MyOffer() {
  const { offerId } = useParams<{ offerId: string }>();
  const [data, setData] = useState<{ offer: Offer; counters: Counter[]; timeline: TimelineEvent[] } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    fetch(`/api/offers/${offerId}`)
      .then(async r => {
        const d = await r.json();
        if (r.ok) setData(d);
        else setError(r.status === 401 ? "Sign in to see your offer." : r.status === 404 ? "Offer not found." : d.error ?? "Could not load your offer.");
      })
      .catch(() => setError("Could not load your offer."));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [offerId]);

  const send = async (path: string, body: unknown, ok: string) => {
    setBusy(true);
    setNotice("");
    const r = await fetch(`/api/offers/${offerId}/${path}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    setPending(null);
    setNotice(r?.ok ? ok : r?.status === 403 ? d.error ?? "Check your verification and the current terms." : d.error ?? "Could not save that.");
    load();
  };

  if (error) return <main><h1>My offer</h1><p role="alert">{error}</p></main>;
  if (!data) return <main><p className="muted" role="status">Loading…</p></main>;
  const { offer, counters, timeline } = data;
  const latest = counters.at(-1);
  const ownerCounter = latest && latest.fromParty === "owner" && latest.status === "open" ? latest : undefined;
  const myTurn = offer.awaiting === "buyer";
  const canCounter = myTurn && counters.length < MAX_COUNTER_ROUNDS;

  return (
    <main>
      <p><a href="/offers">← My offers</a></p>
      <h1>{offer.listingTitle}</h1>
      <p><span className={`badge badge-${offer.status}`}>{offerStatusLabel(offer.status, "buyer", latest)}</span></p>
      {notice ? <p role="status">{notice}</p> : null}

      {ownerCounter ? (
        <section className="panel">
          <h2>The owner's counter-offer</h2>
          <TermsLine t={ownerCounter} />
          <p className="muted">Reply by {when(ownerCounter.expiresAt)}. After that it lapses and your offer expires.</p>
        </section>
      ) : myTurn ? (
        <section className="panel"><h2>The owner asked you to improve your offer</h2><p>Send a counter-offer with new terms, or withdraw.</p></section>
      ) : null}

      {myTurn ? (
        <section className="panel">
          {pending === "agree" && ownerCounter ? (
            <div className="confirm-box" role="alertdialog" aria-label="Agree to the owner's terms?">
              <strong>Agree to the owner's terms?</strong>
              <p>The owner then decides whether to accept. Nothing is binding until contracts are signed. Do not send money until your solicitor advises you.</p>
              <div className="actions">
                <button type="button" onClick={() => send("agree", { counterId: ownerCounter.id }, "You agreed. The owner will now decide.")} disabled={busy}>{busy ? "Saving…" : "Yes, agree"}</button>
                <button type="button" className="secondary" onClick={() => setPending(null)} disabled={busy}>Cancel</button>
              </div>
            </div>
          ) : pending === "counter" ? (
            <>
              <CounterForm start={ownerCounter ?? latestBuyerTerms(offer, counters)} busy={busy} submitLabel="Send counter-offer"
                onSubmit={body => send("counter", body, "Counter-offer sent to the owner.")} />
              <div className="actions"><button type="button" className="secondary" onClick={() => setPending(null)}>Cancel</button></div>
            </>
          ) : (
            <div className="actions">
              {ownerCounter ? <button type="button" onClick={() => setPending("agree")}>Agree to these terms</button> : null}
              {canCounter ? <button type="button" className="secondary" onClick={() => setPending("counter")}>Counter</button> : null}
              <button type="button" className="secondary" onClick={() => setPending("withdraw")}>Withdraw offer</button>
            </div>
          )}
        </section>
      ) : null}

      {pending === "withdraw" ? (
        <div className="confirm-box" role="alertdialog" aria-label="Withdraw your offer?">
          <strong>Withdraw your offer?</strong>
          <p>This ends the negotiation. To make another offer later you need a new offer link.</p>
          <div className="actions">
            <button type="button" onClick={() => send("withdraw", {}, "Your offer was withdrawn.")} disabled={busy}>{busy ? "Saving…" : "Yes, withdraw"}</button>
            <button type="button" className="secondary" onClick={() => setPending(null)} disabled={busy}>Cancel</button>
          </div>
        </div>
      ) : !myTurn && OPEN.includes(offer.status) ? (
        <div className="actions"><button type="button" className="secondary" onClick={() => setPending("withdraw")}>Withdraw offer</button></div>
      ) : null}

      {offer.status === "accepted" || offer.status === "fallen_through" ? (
        <FallThroughPanel url={`/api/offers/${offerId}/fall-through`} viewer="buyer" offerStatus={offer.status} onChange={load} />
      ) : null}

      <h2>Timeline</h2>
      <OfferTimeline events={timeline} viewer="buyer" />
    </main>
  );
}

/** The buyer's latest terms: their last counter, or their original offer. */
function latestBuyerTerms(offer: Terms, counters: Counter[]): Terms {
  return [...counters].reverse().find(c => c.fromParty === "buyer") ?? offer;
}
