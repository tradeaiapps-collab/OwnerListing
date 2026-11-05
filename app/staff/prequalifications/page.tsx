"use client";
import { useCallback, useEffect, useState } from "react";
import { loadError, postStaff } from "../staff-api";
import "../../styles/staff.css";
import "../../styles/prequal.css";

interface Row {
  id: string; buyerName: string; listingTitle: string | null; approvedCents: number | null; status: string; label: string; confidence: string | null;
  summary: string | null; uploadedAt: string; expiresAt: string | null; percentOfPrice: number | null; unqualified: boolean;
}
interface NoPrequal { offerId: string; listingTitle: string; priceCents: number; buyerName: string; submittedAt: string }
const FILTERS = [["", "All"], ["pending_review", "Pending review"], ["verified", "Verified"], ["expired", "Expired"], ["resubmit_requested", "More info asked"]] as const;
const dollars = (c: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(c / 100);
const day = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });

/** Queue of buyer pre-approvals: who is qualified, who is not, and what is waiting for a person. Names are masked. */
export default function StaffPrequalifications() {
  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [none, setNone] = useState<NoPrequal[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const r = await fetch(`/api/staff/prequalifications${status ? `?status=${status}` : ""}`).catch(() => null);
    if (!r || !r.ok) { setMessage(loadError(r?.status ?? 0)); return; }
    const d = await r.json();
    setRows(d.rows); setNone(d.noPrequal); setPicked([]); setMessage("");
  }, [status]);
  useEffect(() => { void load(); }, [load]);

  async function bulk() {
    const res = await postStaff("/api/staff/prequalifications", { action: "verify", ids: picked });
    setMessage(res.ok ? `${res.data["verified"]} verified. ${res.data["skipped"]} left for a person to check (low confidence, or amount or expiry not found).` : String(res.data["error"] ?? "Could not verify."));
    if (res.ok) await load();
  }
  const pending = rows?.filter(r => r.status === "pending_review") ?? [];

  return (
    <main>
      <h1>Buyer pre-approvals</h1>
      <p><a href="/staff">Back to staff</a></p>
      <p className="muted pq-lede">Elena reads each letter; a person confirms it. Rows shaded red are unqualified: expired, more information needed, or an approval under 90% of the listing price.</p>
      <div className="actions" role="group" aria-label="Filter by status">
        {FILTERS.map(([v, l]) => <button key={v} type="button" className={status === v ? undefined : "secondary"} aria-pressed={status === v} onClick={() => setStatus(v)}>{l}</button>)}
      </div>
      {message && <p role="alert">{message}</p>}
      {rows === null && !message && <p className="muted" role="status">Loading…</p>}
      {rows?.length === 0 && <p className="empty">No pre-approvals {status ? "with this status" : "yet"}.</p>}
      {rows && rows.length > 0 && (
        <>
          <div className="actions">
            <button type="button" disabled={picked.length === 0} onClick={() => void bulk()}>Verify {picked.length || ""} selected Elena-read letters</button>
            <button type="button" className="secondary" onClick={() => setPicked(picked.length === pending.length ? [] : pending.map(p => p.id))} disabled={pending.length === 0}>{picked.length === pending.length && pending.length > 0 ? "Clear selection" : "Select all pending"}</button>
          </div>
          <div className="table-wrap"><table className="pq-table">
            <thead><tr><th><span className="sr-only">Select</span></th><th>Buyer</th><th>Listing</th><th className="pq-num">Approved</th><th>Status</th><th>Elena</th><th>Added</th><th><span className="sr-only">Review</span></th></tr></thead>
            <tbody>{rows.map(r => (
              <tr key={r.id} className={r.unqualified ? "pq-low" : undefined}>
                <td>{r.status === "pending_review" ? <input type="checkbox" aria-label={`Select ${r.buyerName}`} checked={picked.includes(r.id)} onChange={e => setPicked(e.target.checked ? [...picked, r.id] : picked.filter(x => x !== r.id))} /> : null}</td>
                <th scope="row">{r.buyerName}</th>
                <td>{r.listingTitle ?? "Any listing"}</td>
                <td className="pq-num">{r.approvedCents ? dollars(r.approvedCents) : "Not read"}{r.percentOfPrice !== null ? <small className="muted"><br />{r.percentOfPrice}% of price</small> : null}</td>
                <td><span className={`pq-pill ${r.status}`}>{r.label}</span>{r.expiresAt ? <small className="muted"><br />to {day(r.expiresAt)}</small> : null}</td>
                <td className="pq-sum">{r.confidence ? <span className={`pq-pill ${r.confidence}`}>{r.confidence}</span> : null}{r.summary ? <small className="muted"><br />{r.summary}</small> : null}</td>
                <td>{day(r.uploadedAt)}</td>
                <td><a href={`/staff/prequalifications/${r.id}/review`}>{r.status === "pending_review" ? "Review" : "Open"}</a></td>
              </tr>
            ))}</tbody>
          </table></div>
        </>
      )}
      {none.length > 0 && (
        <section className="panel">
          <h2>Offers from buyers with no pre-approval</h2>
          <div className="table-wrap"><table className="pq-table">
            <thead><tr><th>Buyer</th><th>Listing</th><th className="pq-num">Offer</th><th>Submitted</th></tr></thead>
            <tbody>{none.map(n => <tr key={n.offerId} className="pq-low"><th scope="row">{n.buyerName}</th><td>{n.listingTitle}</td><td className="pq-num">{dollars(n.priceCents)}</td><td>{day(n.submittedAt)}</td></tr>)}</tbody>
          </table></div>
        </section>
      )}
    </main>
  );
}
