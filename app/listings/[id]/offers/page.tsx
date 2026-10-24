"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

type Offer = { id: string; priceCents: number; conditions: string[]; settlementDays: number; depositCents: number; status: string; submittedAt: string };

const dollars = (cents: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);

/** Owner view of formal offers on one listing. Only the owner decides (the AI never accepts); no buyer identity is shown here. */
export default function Offers() {
  const { id } = useParams<{ id: string }>();
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [buyerId, setBuyerId] = useState("");
  const [link, setLink] = useState("");

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

  const decide = async (offerId: string, decision: "accept" | "reject" | "counter_request") => {
    setNotice("");
    if (decision === "accept" && !window.confirm("Accept this offer? This records your decision only. No money moves on this site.")) return;
    const r = await fetch(`/api/listings/${id}/offers/${offerId}/decision`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision })
    }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setNotice(r?.ok ? "Decision recorded." : d.error ?? "Could not record that decision.");
    load();
  };

  const issueLink = async () => {
    setNotice("");
    setLink("");
    const r = await fetch(`/api/listings/${id}/offer-links`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ buyerUserId: buyerId.trim() })
    }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (r?.ok) setLink(String(d.token));
    else setNotice(d.error ?? "Could not create the link.");
  };

  const open = (s: string) => s === "submitted" || s === "under_review" || s === "countered";

  return (
    <main>
      <h1>Offers</h1>
      <p>Formal offers submitted through the offer form. The AI never accepts an offer: you decide.</p>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <section className="panel">
        <h2>Invite a verified buyer to make an offer</h2>
        <div className="actions">
          <input className="grow" aria-label="Buyer ID" placeholder="Buyer ID" value={buyerId} onChange={e => setBuyerId(e.target.value)} />
          <button type="button" onClick={issueLink} disabled={buyerId.trim() === ""}>Create single-use link</button>
        </div>
        {link ? <p>Copy this offer token now. It is shown once, works once and expires in 24 hours:<br /><code>{link}</code></p> : null}
      </section>
      {!error && offers === null ? <p className="muted" role="status">Loading offers…</p> : null}
      {offers && offers.length === 0 ? <p className="empty">No offers yet.</p> : null}
      <ul className="card-list">
        {offers?.map(o => (
          <li key={o.id}>
            <strong>{dollars(o.priceCents)}</strong> · {o.status.replace("_", " ")}
            <div>Deposit {dollars(o.depositCents)} · Settlement {o.settlementDays} days</div>
            <div>{o.conditions.length > 0 ? `Conditions: ${o.conditions.join("; ")}` : "No conditions"}</div>
            <small className="muted">Submitted {new Date(o.submittedAt).toLocaleString("en-AU")}</small>
            {open(o.status) ? (
              <div className="actions">
                <button type="button" onClick={() => decide(o.id, "accept")}>Accept</button>
                <button type="button" className="secondary" onClick={() => decide(o.id, "reject")}>Reject</button>
                {o.status !== "countered" ? <button type="button" className="secondary" onClick={() => decide(o.id, "counter_request")}>Ask for a counter</button> : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </main>
  );
}
