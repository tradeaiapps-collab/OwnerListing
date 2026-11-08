"use client";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CONDITION_CODES, CONDITIONS, type ConditionCode } from "../../../../../src/domain/prequalification";
import { loadError, postStaff } from "../../../staff-api";
import "../../../../styles/staff.css";
import "../../../../styles/prequal.css";

interface Detail {
  id: string; buyerName: string; listingTitle: string | null; listingPriceCents: number | null; highestOfferCents: number | null; status: string; label: string;
  approvedCents: number | null; ratePercent: number | null; termYears: number | null; conditions: ConditionCode[]; expiresAt: string | null; uploadedAt: string;
  shareWithSellers: boolean; note: string | null; verifiedAt: string | null;
  elena: { confidence: string; summary: string; flags: { code: string; text: string }[]; extracted: { lender?: string; approvedCents?: number; expiresOn?: string; issuedOn?: string } } | null;
}
const dollars = (c: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(c / 100);

/** Staff confirm what Elena read against the PDF, then verify or ask the buyer for a clearer letter. */
export default function ReviewPrequalification() {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<Detail | null>(null);
  const [message, setMessage] = useState("");
  const [amount, setAmount] = useState("");
  const [expires, setExpires] = useState("");
  const [rate, setRate] = useState("");
  const [term, setTerm] = useState("");
  const [conds, setConds] = useState<ConditionCode[]>([]);
  const [note, setNote] = useState("");
  const [ask, setAsk] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/staff/prequalifications/${id}`).catch(() => null);
    if (!r || !r.ok) { setMessage(loadError(r?.status ?? 0)); return; }
    const x: Detail = await r.json();
    setD(x);
    const e = x.elena?.extracted;
    setAmount(String((x.approvedCents ?? e?.approvedCents ?? 0) / 100 || ""));
    setExpires(x.expiresAt?.slice(0, 10) ?? e?.expiresOn ?? "");
    setRate(x.ratePercent === null ? "" : String(x.ratePercent)); setTerm(x.termYears === null ? "" : String(x.termYears));
    setConds(x.conditions); setNote(x.note ?? "");
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function decide(e: FormEvent, action: "verify" | "resubmit") {
    e.preventDefault(); setBusy(true); setMessage("");
    const body = action === "verify"
      ? { action, approvedCents: Math.round(Number(amount.replace(/[$,\s]/g, "")) * 100), expiresOn: expires, conditions: conds, ...(rate ? { ratePercent: Number(rate) } : {}), ...(term ? { termYears: Number(term) } : {}), ...(note.trim() ? { note: note.trim() } : {}) }
      : { action, note: ask.trim() };
    const res = await postStaff(`/api/staff/prequalifications/${id}`, body);
    setBusy(false);
    setMessage(res.ok ? (action === "verify" ? "Verified. Sellers can now see the summary." : "The buyer has been asked to send a clearer letter.") : String(res.data["error"] ?? "That did not work."));
    if (res.ok) await load();
  }

  if (!d) return <main><h1>Review pre-approval</h1><p><a href="/staff/prequalifications">Back to the list</a></p>{message ? <p role="alert">{message}</p> : <p className="muted" role="status">Loading…</p>}</main>;
  const pending = d.status === "pending_review";
  return (
    <main>
      <h1>Review pre-approval</h1>
      <p><a href="/staff/prequalifications">Back to the list</a></p>
      <dl className="pq-facts">
        <div><dt>Buyer</dt><dd>{d.buyerName}</dd></div>
        <div><dt>Listing</dt><dd>{d.listingTitle ?? "Any listing"}</dd></div>
        <div><dt>Listing price</dt><dd>{d.listingPriceCents ? dollars(d.listingPriceCents) : "Not set"}</dd></div>
        <div><dt>Highest offer</dt><dd>{d.highestOfferCents ? dollars(d.highestOfferCents) : "None yet"}</dd></div>
        <div><dt>Status</dt><dd><span className={`pq-pill ${d.status}`}>{d.label}</span></dd></div>
        <div><dt>Letter</dt><dd><a href={`/api/staff/prequalifications/${d.id}/document`}>Download the PDF</a></dd></div>
      </dl>
      {d.elena && (
        <section className="panel">
          <h2>What Elena read <span className={`pq-pill ${d.elena.confidence}`}>{d.elena.confidence} confidence</span></h2>
          <p>{d.elena.summary}</p>
          {d.elena.flags.length > 0 && <ul className="pq-flags">{d.elena.flags.map(f => <li key={f.code}>{f.text}</li>)}</ul>}
          <small className="muted">Check every figure against the PDF. Elena is a reading aid, not a decision.</small>
        </section>
      )}
      {message && <p role="alert">{message}</p>}
      {pending ? (
        <div className="pq-review">
          <form className="panel pq-form" onSubmit={e => void decide(e, "verify")}>
            <h2>Confirm and verify</h2>
            <label>Approved amount ($)<input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" required /></label>
            <label>Valid until<input type="date" value={expires} onChange={e => setExpires(e.target.value)} required /></label>
            <div className="pq-grid">
              <label>Rate (%)<input value={rate} onChange={e => setRate(e.target.value)} inputMode="decimal" /></label>
              <label>Term (years)<input value={term} onChange={e => setTerm(e.target.value)} inputMode="numeric" /></label>
            </div>
            <fieldset className="pq-conds">
              <legend>Conditions on the letter</legend>
              {CONDITION_CODES.map(c => <label key={c} className="pq-check"><input type="checkbox" checked={conds.includes(c)} onChange={e => setConds(e.target.checked ? [...conds, c] : conds.filter(x => x !== c))} />Subject to {CONDITIONS[c].label}</label>)}
            </fieldset>
            <label>Note (optional, concerns about conditions)<textarea value={note} onChange={e => setNote(e.target.value)} maxLength={1000} rows={3} /></label>
            <div className="actions"><button type="submit" disabled={busy}>Verify pre-approval</button></div>
          </form>
          <form className="panel pq-form" onSubmit={e => void decide(e, "resubmit")}>
            <h2>Ask for a clearer letter</h2>
            <p className="muted">The buyer sees this note. Tell them what to send again.</p>
            <label>Message to the buyer<textarea value={ask} onChange={e => setAsk(e.target.value)} maxLength={1000} rows={4} required /></label>
            <div className="actions"><button type="submit" className="secondary" disabled={busy || ask.trim() === ""}>Ask the buyer to resubmit</button></div>
          </form>
        </div>
      ) : (
        <p className="muted">This pre-approval has been decided{d.verifiedAt ? ` (verified ${new Date(d.verifiedAt).toLocaleDateString("en-AU")})` : ""}. {d.note ? `Note: ${d.note}` : ""}</p>
      )}
    </main>
  );
}
