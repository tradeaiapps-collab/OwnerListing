"use client";
import { useEffect, useState } from "react";
import { offerStatusLabel } from "../../src/domain/offer-display";
import { TermsLine, when, type Terms } from "./negotiation";
import "../styles/offers.css";

type Offer = Terms & { id: string; listingId: string; listingTitle: string; status: string; submittedAt: string; awaiting: "owner" | "buyer" | null };

/** The signed-in buyer's own offers, with whose move it is. */
export default function MyOffers() {
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/offers")
      .then(async r => {
        const d = await r.json();
        if (r.ok) setOffers(d.offers);
        else setError(r.status === 401 ? "Sign in as a buyer to see your offers." : r.status === 404 ? "Only buyers have offers here." : d.error ?? "Could not load your offers.");
      })
      .catch(() => setError("Could not load your offers."));
  }, []);

  return (
    <main>
      <h1>My offers</h1>
      <p>Your formal offers and any counter-offers. Only the owner can accept an offer; an accepted offer is not a contract until both sides sign with their solicitors.</p>
      {error ? <p role="alert">{error}</p> : null}
      {!error && offers === null ? <p className="muted" role="status">Loading…</p> : null}
      {offers && offers.length === 0 ? <p className="empty">You have not made any offers yet.</p> : null}
      <ul className="card-list">
        {offers?.map(o => (
          <li key={o.id}>
            <strong>{o.listingTitle}</strong> <span className={`badge badge-${o.status}`}>{offerStatusLabel(o.status, "buyer")}</span>
            <small className="muted">Your original offer · {when(o.submittedAt)}</small>
            <TermsLine t={o} />
            {o.awaiting === "buyer" ? <p><strong>The owner is waiting for your reply.</strong></p> : null}
            <div><a href={`/offers/${o.id}`}>{o.awaiting === "buyer" ? "Reply" : "View"}</a></div>
          </li>
        ))}
      </ul>
    </main>
  );
}
