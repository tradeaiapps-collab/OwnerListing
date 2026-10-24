"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import "../../../styles/billing.css";
import { JSON_HEADERS } from "../../ui";
import { FEATURE_LABELS, money, type PlanView } from "../../../plans/view";

export default function Checkout() {
  const { id } = useParams<{ id: string }>();
  const [plans, setPlans] = useState<PlanView[] | null>(null);
  const [planId, setPlanId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    fetch("/api/plans")
      .then(async r => { if (!r.ok) throw new Error(); setPlans((await r.json()).plans); })
      .catch(() => setError("Could not load the plans."));
  }, []);

  async function onPay(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await fetch(`/api/listings/${id}/checkout`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ planId }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.alreadyPaid) setNotice("This listing is already paid for. You can publish it.");
      else if (r.ok && typeof d.redirectUrl === "string" && d.redirectUrl.startsWith("https://")) window.location.assign(d.redirectUrl);
      else if (r.status === 503) setNotice(`Online payment is not available yet. Your invoice${d.invoice ? ` for ${money(d.invoice.totalCents)} (including GST)` : ""} is saved and unpaid. The listing cannot be published until it is paid.`);
      else setError(r.status === 401 ? "Sign in to pay for a listing." : r.status === 404 ? "Listing not found." : d.error ?? "Could not start payment.");
    } catch {
      setError("Could not start payment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Pay and publish</h1>
      <p className="muted">Choose a plan for this listing. You pay on the bank's secure page; we never see your card number.</p>
      {!plans && !error && <p className="muted" role="status">Loading...</p>}
      {plans && (
        <form className="stack" onSubmit={onPay}>
          <fieldset className="stack">
            <legend>Plan</legend>
            {plans.map(p => (
              <label key={p.id} className="plan-choice" aria-disabled={!p.price}>
                <input type="radio" name="plan" value={p.id} disabled={!p.price} checked={planId === p.id} onChange={() => setPlanId(p.id)} />
                <span>
                  <strong>{p.name}</strong>{" "}
                  {p.price ? `${money(p.price.exGstCents)} + GST ${money(p.price.gstCents)} = ${money(p.price.totalCents)}` : "Price not set (cannot be bought yet)"}
                  <br /><small className="muted">Up to {p.maxPhotos} photos, {p.storageGb} GB{p.features.length ? `, ${p.features.map(f => FEATURE_LABELS[f] ?? f).join(", ")}` : ""}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <button type="submit" disabled={busy || !planId}>{busy ? "Starting..." : "Continue to payment"}</button>
        </form>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
