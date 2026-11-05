"use client";
import { useCallback, useEffect, useState } from "react";
import "../styles/billing.css";
import { JSON_HEADERS } from "../listings/ui";
import { FEATURE_LABELS } from "../plans/view";
import ElenaBilling from "./elena-billing";
import { KIND_LABEL, dateAu, invoiceState, money } from "./view";

interface Inv { id: string; invoiceNumber?: string; kind?: string; description?: string; totalCents: number; status: "pending" | "paid" | "failed" | "void" | "refunded"; dueAt?: string; createdAt?: string; paidAt?: string }
interface Price { exGstCents: number; gstCents: number; totalCents: number }
interface Plan { id: string; name: string; maxPhotos: number; storageGb: number; maxActiveListings: number | null; features: string[]; monthly: Price | null; yearly: Price | null }
interface Sub { id: string; planId: string; interval: "monthly" | "yearly"; status: string; endsAt: string; cancelAtPeriodEnd: boolean }
interface Data { invoices: Inv[]; subscription?: Sub; plans: Plan[]; gstPercent: number; yearlyMonthsCharged: number; cardAvailable: boolean; bankTransferAvailable: boolean; disputes: { invoiceId: string; status: string }[] }

export default function Billing() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [interval, setInterval] = useState<"monthly" | "yearly">("monthly");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    const r = await fetch("/api/billing").catch(() => null);
    if (!r) { setError("Could not load your billing."); return; }
    if (r.status === 401) { setError("Sign in to see your billing."); return; }
    if (!r.ok) { setError("Could not load your billing."); return; }
    setError(""); setData(await r.json());
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function post(url: string, body: unknown, key: string): Promise<{ ok: boolean; d: Record<string, unknown> }> {
    setBusy(key); setNotice(""); setError("");
    try {
      const r = await fetch(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) setError(typeof d.error === "string" ? d.error : "Something went wrong. Try again.");
      return { ok: r.ok, d };
    } catch {
      setError("Something went wrong. Try again.");
      return { ok: false, d: {} };
    } finally {
      setBusy("");
    }
  }

  async function subscribe(planId: string) {
    const r = await post("/api/billing/subscribe", { planId, interval }, planId);
    if (r.ok) { setNotice("Your plan is saved and starts as soon as the first invoice is paid. Open the invoice below to pay."); await load(); }
  }
  async function cancel(on: boolean) {
    const r = await post("/api/billing/subscription", { cancel: on }, "cancel");
    if (r.ok) { setNotice(on ? "Your plan will end when the period you've paid for ends." : "Your plan will keep renewing."); await load(); }
  }

  if (!data) return <main><h1>Billing</h1>{error ? <p role="alert">{error}</p> : <p className="muted" role="status">Loading...</p>}</main>;
  const sub = data.subscription;
  const planOf = (id: string) => data.plans.find(p => p.id === id)?.name ?? id;
  const unpaid = data.invoices.filter(i => i.status === "pending");
  const owing = unpaid.reduce((a, i) => a + i.totalCents, 0);

  return (
    <main>
      <h1>Billing</h1>
      <p className="muted">Your invoices, plan and payments. Prices show GST ({data.gstPercent}%). Card payments happen on the bank's secure page; we never see your card number.</p>
      {error && <p className="notice error" role="alert">{error}</p>}
      {notice && <p className="notice ok" role="status">{notice}</p>}
      <div className="billing-grid">
        <div className="billing-main">
          <section className="panel" aria-labelledby="inv-h">
            <h2 id="inv-h">Invoices</h2>
            {unpaid.length > 0 && <p className="notice" role="status">{unpaid.length} unpaid invoice{unpaid.length === 1 ? "" : "s"}, {money(owing)} in total.</p>}
            {data.invoices.length === 0 ? <p className="empty">No invoices yet. They appear here when you pay for a listing or start a plan.</p> : (
              <div className="table-wrap">
                <table className="inv-table">
                  <thead><tr><th scope="col">Invoice</th><th scope="col">Date</th><th scope="col">For</th><th scope="col" className="num">Total</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Open</span></th></tr></thead>
                  <tbody>
                    {data.invoices.map(i => {
                      const s = invoiceState(i);
                      return (
                        <tr key={i.id}>
                          <td>{i.invoiceNumber ?? i.id.slice(0, 8)}</td>
                          <td>{i.createdAt ? dateAu(i.createdAt) : ""}</td>
                          <td>{KIND_LABEL[i.kind ?? "other"]}</td>
                          <td className="num">{money(i.totalCents)}</td>
                          <td><span className={`status-pill ${s.tone}`}>{s.label}</span></td>
                          <td><a href={`/billing/${i.id}`}>{i.status === "pending" ? "Pay or view" : "View"}<span className="sr-only"> invoice {i.invoiceNumber}</span></a></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="panel" aria-labelledby="plan-h">
            <h2 id="plan-h">Your plan</h2>
            {sub ? (
              <div className="sub-card">
                <p className="big">{planOf(sub.planId)} <span className={`status-pill ${sub.status === "active" ? "good" : sub.status === "pending" ? "warn" : "bad"}`}>{sub.status === "pending" ? "Waiting for first payment" : sub.status === "past_due" ? "Past due" : "Active"}</span></p>
                {sub.status !== "pending" && <p>{sub.cancelAtPeriodEnd ? `Ends on ${dateAu(sub.endsAt)}. It will not renew.` : `Paid until ${dateAu(sub.endsAt)}, billed ${sub.interval}. A renewal invoice is sent about a week before.`}</p>}
                {sub.status === "pending" && <p>Pay the first invoice above to start your plan.</p>}
                <div className="row-actions">
                  {sub.cancelAtPeriodEnd
                    ? <button type="button" disabled={busy === "cancel"} onClick={() => void cancel(false)}>Keep my plan</button>
                    : <button type="button" className="secondary" disabled={busy === "cancel"} onClick={() => void cancel(true)}>{sub.status === "pending" ? "Cancel this plan" : "Cancel at end of period"}</button>}
                </div>
              </div>
            ) : data.plans.length === 0 ? <p className="empty">No plans are available for your account type.</p> : (
              <>
                <p className="muted">Instead of paying per listing, choose a plan with more photos, storage and tools. Yearly is {data.yearlyMonthsCharged} months for the price of 12.</p>
                <div className="interval-toggle" role="group" aria-label="Billing period">
                  <button type="button" aria-pressed={interval === "monthly"} onClick={() => setInterval("monthly")}>Monthly</button>
                  <button type="button" aria-pressed={interval === "yearly"} onClick={() => setInterval("yearly")}>Yearly</button>
                </div>
                <div className="sub-plans">
                  {data.plans.map(p => {
                    const price = interval === "monthly" ? p.monthly : p.yearly;
                    return (
                      <article className="sub-plan" key={p.id} aria-labelledby={`sp-${p.id}`}>
                        <h3 id={`sp-${p.id}`}>{p.name}</h3>
                        {price ? (
                          <>
                            <p className="plan-price">{money(price.exGstCents)} <small>/{interval === "monthly" ? "month" : "year"} excl. GST</small></p>
                            <p className="plan-price-note">Plus GST {money(price.gstCents)}. Total {money(price.totalCents)}.</p>
                          </>
                        ) : <p className="plan-unpriced">Price not set yet. This plan cannot be bought.</p>}
                        <ul>
                          <li>{p.maxActiveListings === null ? "Unlimited" : `Up to ${p.maxActiveListings}`} live listings</li>
                          <li>Up to {p.maxPhotos} photos each, {p.storageGb} GB</li>
                          {p.features.map(f => <li key={f}>{FEATURE_LABELS[f] ?? f}</li>)}
                        </ul>
                        <button type="button" disabled={!price || busy === p.id} onClick={() => void subscribe(p.id)}>{busy === p.id ? "Saving..." : "Choose " + p.name}</button>
                      </article>
                    );
                  })}
                </div>
              </>
            )}
          </section>
        </div>
        <div className="billing-side">
          <ElenaBilling onChanged={() => void 0} />
          <section className="panel" aria-labelledby="pay-h">
            <h2 id="pay-h">How you can pay</h2>
            <div className="pay-methods">
              <p><strong>Card.</strong> {data.cardAvailable ? "Available on every unpaid invoice." : "Not switched on yet."}</p>
              <p><strong>Bank transfer.</strong> {data.bankTransferAvailable ? "Details are on each unpaid invoice. Staff confirm it, usually within a business day." : "Not set up yet."}</p>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
