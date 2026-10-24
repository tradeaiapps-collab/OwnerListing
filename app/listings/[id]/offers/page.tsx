"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

type Offer = { id: string; priceCents: number; conditions: string[]; settlementDays: number; depositCents: number; status: string; submittedAt: string };

const dollars = (cents: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);

/** Owner view of formal offers on one listing. Read only: the owner decides outside the AI, and no buyer identity is shown here. */
export default function Offers() {
  const { id } = useParams<{ id: string }>();
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setOffers(null);
    setError("");
    fetch(`/api/listings/${id}/offers`)
      .then(async r => {
        const d = await r.json();
        if (r.ok) setOffers(d.offers);
        else if (r.status === 401) setError("Sign in to see offers on your listing.");
        else if (r.status === 404) setError("Listing not found.");
        else setError(d.error ?? "Could not load offers.");
      })
      .catch(() => setError("Could not load offers."));
  }, [id]);

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 16 }}>
      <h1>Offers</h1>
      <p>Formal offers submitted through the offer form. The AI never accepts an offer: you decide.</p>
      {error ? <p role="alert">{error}</p> : null}
      {!error && offers === null ? <p>Loading offers…</p> : null}
      {offers && offers.length === 0 ? <p>No offers yet.</p> : null}
      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 12 }}>
        {offers?.map(o => (
          <li key={o.id} style={{ border: "1px solid #8884", borderRadius: 8, padding: 12 }}>
            <strong>{dollars(o.priceCents)}</strong> · {o.status.replace("_", " ")}
            <div>Deposit {dollars(o.depositCents)} · Settlement {o.settlementDays} days</div>
            <div>{o.conditions.length > 0 ? `Conditions: ${o.conditions.join("; ")}` : "No conditions"}</div>
            <small>Submitted {new Date(o.submittedAt).toLocaleString("en-AU")}</small>
          </li>
        ))}
      </ul>
    </main>
  );
}
