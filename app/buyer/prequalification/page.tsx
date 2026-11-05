"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CONDITION_CODES, CONDITIONS, PREQUAL_DISCLAIMER, type ConditionCode } from "../../../src/domain/prequalification";
import "../../styles/prequal.css";

interface Item {
  id: string; status: string; label: string; listingTitle: string | null; approvedCents: number | null; expiresAt: string | null; createdAt: string;
  confidence: string | null; summary: string | null; flags: string[]; note: string | null; sharedWithSellers: boolean;
}
const dollars = (c: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(c / 100);
const day = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });

/** Buyer adds a bank pre-approval letter (PDF). Elena reads it; staff verify it; sellers then see a short summary beside the offer. */
export default function BuyerPrequalification() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [conds, setConds] = useState<ConditionCode[]>([]);
  const [share, setShare] = useState(true);
  const [listingId] = useState(() => (typeof window === "undefined" ? "" : (new URLSearchParams(window.location.search).get("listing") ?? "")));

  const load = useCallback(async () => {
    const r = await fetch("/api/buyer/prequalifications").catch(() => null);
    if (!r) { setError("Could not load your pre-approvals."); return; }
    const d = await r.json().catch(() => ({}));
    if (r.ok) { setItems(d.items); setError(""); }
    else setError(r.status === 401 ? "Sign in as a buyer to add a pre-approval." : String(d.error ?? "Could not load your pre-approvals."));
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    fd.set("conditions", conds.join(","));
    fd.set("share", String(share));
    if (listingId) fd.set("listingId", listingId);
    for (const k of ["amount", "rate", "term"]) if (String(fd.get(k) ?? "").trim() === "") fd.delete(k);
    setBusy(true); setNotice(""); setError("");
    const r = await fetch("/api/buyer/prequalifications", { method: "POST", body: fd }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (r?.ok) { setNotice("Thanks. Elena has read your letter and our team will check it."); form.reset(); setConds([]); await load(); }
    else setError(String((d as Record<string, unknown>)["error"] ?? "Could not add the letter."));
  }

  return (
    <main>
      <h1>Mortgage pre-approval</h1>
      <p className="muted pq-lede">
        Add the pre-approval letter from your bank. Sellers who receive your offer see whether it is verified, the amount and any conditions. They never see your letter,
        your name on it or your account details. {PREQUAL_DISCLAIMER}
      </p>
      <form className="panel pq-form" onSubmit={e => void submit(e)}>
        <h2>Add a letter</h2>
        <label>Pre-approval letter (PDF, up to 10 MB)<input name="file" type="file" accept="application/pdf" required /></label>
        {listingId ? <p className="muted">This letter is for the listing you came from. Leave it as is to use it for any listing.</p> : null}
        <p className="muted">Everything below is optional. Elena reads what she can from the letter.</p>
        <div className="pq-grid">
          <label>Approved amount ($)<input name="amount" inputMode="decimal" placeholder="450000" /></label>
          <label>Interest rate (%)<input name="rate" inputMode="decimal" placeholder="6.19" /></label>
          <label>Loan term (years)<input name="term" inputMode="numeric" placeholder="30" /></label>
        </div>
        <fieldset className="pq-conds">
          <legend>Conditions on the approval</legend>
          {CONDITION_CODES.map(c => (
            <label key={c} className="pq-check"><input type="checkbox" checked={conds.includes(c)} onChange={e => setConds(e.target.checked ? [...conds, c] : conds.filter(x => x !== c))} />Subject to {CONDITIONS[c].label}</label>
          ))}
        </fieldset>
        <label className="pq-check"><input type="checkbox" checked={share} onChange={e => setShare(e.target.checked)} />Show the verified summary to sellers of listings I make offers on</label>
        <div className="actions"><button type="submit" disabled={busy}>{busy ? "Uploading…" : "Add pre-approval"}</button></div>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <h2>Your pre-approvals</h2>
      {items === null && !error ? <p className="muted" role="status">Loading…</p> : null}
      {items?.length === 0 ? <p className="empty">You have not added a pre-approval yet.</p> : null}
      <ul className="card-list">
        {items?.map(i => (
          <li key={i.id} className="pq-item">
            <div><span className={`pq-pill ${i.status}`}>{i.label}</span>{i.confidence ? <> <span className={`pq-pill ${i.confidence}`}>Elena: {i.confidence} confidence</span></> : null}</div>
            {i.summary ? <p>{i.summary}</p> : null}
            {i.flags.length ? <ul className="pq-flags">{i.flags.map(f => <li key={f}>{f}</li>)}</ul> : null}
            {i.status === "resubmit_requested" && i.note ? <p role="status"><strong>Our team asks:</strong> {i.note}</p> : null}
            <small className="muted">
              Added {day(i.createdAt)}{i.listingTitle ? ` · for ${i.listingTitle}` : " · any listing"}{i.approvedCents ? ` · ${dollars(i.approvedCents)}` : ""}
              {i.expiresAt ? ` · expires ${day(i.expiresAt)}` : ""}{i.sharedWithSellers ? "" : " · not shared with sellers"}
            </small>
          </li>
        ))}
      </ul>
    </main>
  );
}
