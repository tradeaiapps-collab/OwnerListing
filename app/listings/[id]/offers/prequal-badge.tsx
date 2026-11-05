"use client";
import "../../../styles/prequal.css";

export interface OfferPrequal {
  offerId: string; priceCents: number;
  prequal: { state: "verified" | "pending" | "expired" | "none"; label: string; confidence?: string; summary?: string; approvedCents?: number; conditions?: string[]; expiresAt?: string; flags?: string[] };
}
const dollars = (c: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(c / 100);

/** The buyer's pre-approval beside an offer. Verified letters open to Elena's summary; nothing personal or bank-related is ever shown. */
export function PrequalBadge({ item }: { item: OfferPrequal | undefined }) {
  if (!item) return null;
  const p = item.prequal;
  const pill = <span className={`pq-pill ${p.state}`}>Pre-approval: {p.label}</span>;
  if (p.state !== "verified") {
    return (
      <div className="pq-seller">
        <div>{pill}</div>
        {p.state === "pending" ? <small className="muted">Our team has not finished checking this buyer&apos;s letter.</small> : null}
        {p.state === "none" ? <small className="muted">This buyer has not shared a pre-approval.</small> : null}
        {p.state === "expired" ? <small className="muted">The buyer&apos;s pre-approval has run out. Ask for a current one.</small> : null}
      </div>
    );
  }
  return (
    <details className="pq-seller">
      <summary>{pill}{p.confidence ? <span className={`pq-pill ${p.confidence}`}>{p.confidence} confidence</span> : null}</summary>
      <p>{p.summary}</p>
      <small className="muted">Approved {p.approvedCents ? dollars(p.approvedCents) : ""} against an offer of {dollars(item.priceCents)}{p.expiresAt ? ` · valid to ${new Date(p.expiresAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}` : ""}</small>
      {p.conditions?.length ? <small className="muted">Conditions: {p.conditions.join("; ")}</small> : <small className="muted">No conditions.</small>}
      {p.flags?.length ? <ul className="pq-flags">{p.flags.map(f => <li key={f}>{f}</li>)}</ul> : null}
      <small className="muted">Verified by our team. A pre-approval is not a guarantee of finance.</small>
    </details>
  );
}
